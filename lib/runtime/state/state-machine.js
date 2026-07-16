import { createHash, createHmac } from 'crypto';
import { withTransaction, setAgentContext, withSystemScope } from '../../db.js';
import { guardCheck } from '../guard-check.js';
import { notify } from '../event-bus.js';
import { createLogger } from '../../logger.js';
const log = createLogger('runtime/state-machine');

/**
 * Compute SHA256 hash chain entry.
 * Format MUST match the SQL fallback in transition_state():
 *   sha256(prevHash|transitionId|workItemId|fromState|toState|agentId|configHash)
 */
function computeHashChain(transitionId, workItemId, fromState, toState, agentId, configHash, prevHash) {
  const payload = (prevHash || 'genesis') + '|' +
    transitionId + '|' + workItemId + '|' +
    fromState + '|' + toState + '|' +
    agentId + '|' + configHash;
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * HMAC-sign agent identity claim for non-repudiation (ADR-015).
 * Returns hex signature or null if signing key not configured.
 */
function signAgentClaim(agentId, workItemId, toState) {
  const key = process.env.AGENT_SIGNING_KEY;
  if (!key) return null;
  const timestamp = Date.now().toString();
  const payload = `${agentId}|${workItemId}|${toState}|${timestamp}`;
  const signature = createHmac('sha256', key).update(payload).digest('hex');
  return { signature, timestamp, payload };
}

/**
 * Transition a work item through the state machine.
 * Hash chain computed in JS (PGlite doesn't have pgcrypto).
 * guardCheck() and transition_state() in the SAME transaction (spec §5).
 *
 * OPT-166 P2b — `systemActor`: when set to a SYSTEM_ACTORS id (e.g. 'reaper'),
 * the transition runs under a system scope (withSystemScope) instead of an
 * agent-role transaction. This is the ONLY way a daemon can transition a work
 * item it does NOT own once the pool flips to the non-superuser autobot_agent
 * role: post-flip, agent_update_work_items (sql/200) requires
 * `assigned_to = current_agent_id() OR app.role='board' OR tenancy.is_system()`,
 * and the pre-transition `SELECT ... FOR UPDATE` is gated by the work_items read
 * policies — an agent-role reaper would see 0 rows for another agent's stuck
 * task and silently no-op (`fromState` undefined → return false). The system
 * scope's tenancy.is_system() branch (sql/199) grants the cross-agent read+write.
 * `agentId` is UNCHANGED by this flag — it is still recorded as the transition's
 * actor in state_transitions / the hash chain (e.g. 'reaper'); only the DB *role*
 * for RLS becomes 'system'. INERT until the flip (superuser bypasses RLS today).
 * Agent-scoped callers (agent-loop, orchestrator, campaign-loop) omit it → the
 * default path is byte-for-byte unchanged.
 */
export async function transitionState({
  workItemId,
  toState,
  agentId,
  configHash,
  reason = null,
  guardrailChecks = {},
  costUsd = 0,
  systemActor = null,
}) {
  // The transition body, parameterized over an `exec(text, params) => {rows}`
  // executor so it runs identically on an agent-role transaction client and on a
  // system-scoped query (both share the pg `(text, params) -> { rows }` shape).
  const runBody = async (exec) => {
    // Generate transition ID
    const tidResult = await exec(`SELECT gen_random_uuid()::text as tid`);
    const transitionId = tidResult.rows[0].tid;

    // Get current state + prev hash BEFORE the transition so we can pre-compute the hash chain.
    // FOR UPDATE serializes concurrent transitions on the same work item,
    // preventing hash chain forks from two transactions reading the same prev_hash.
    const currentResult = await exec(
      `SELECT status FROM agent_graph.work_items WHERE id = $1 FOR UPDATE`,
      [workItemId]
    );
    const fromState = currentResult.rows[0]?.status;
    if (!fromState) return false;

    // Order by chain_seq (monotonic), not created_at — under sub-second retry
    // storms created_at can be earlier than commit/chain order, causing the
    // writer to chain off the wrong row. See migration 091 + STAQPRO-273.
    const prevResult = await exec(
      `SELECT encode(hash_chain_current, 'hex') as prev_hash
       FROM agent_graph.state_transitions
       WHERE work_item_id = $1 ORDER BY chain_seq DESC LIMIT 1`,
      [workItemId]
    );
    const prevHash = prevResult.rows[0]?.prev_hash || '';

    // Pre-compute hash chain so INSERT has the final value (no UPDATE needed on append-only table)
    const hashHex = computeHashChain(
      transitionId, workItemId, fromState, toState, agentId, configHash, prevHash
    );

    // HMAC-sign agent identity (ADR-015: non-repudiable without full JWT)
    const hmacClaim = signAgentClaim(agentId, workItemId, toState);
    const finalChecks = hmacClaim
      ? { ...guardrailChecks, hmac_claim: hmacClaim }
      : guardrailChecks;

    // Call SQL function with the pre-computed hash
    const result = await exec(
      `SELECT * FROM agent_graph.transition_state($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [workItemId, toState, agentId, configHash, reason, JSON.stringify(finalChecks), costUsd, transitionId, hashHex]
    );

    const row = result.rows[0];
    return { success: !!row?.success, toState, workItemId };
  };

  let outcome;
  if (systemActor) {
    // System-scoped path: withSystemScope owns the txn AND sets app.role='system'
    // (writing the durable audit-on-open row), so no setAgentContext here.
    const sys = await withSystemScope(systemActor, { reason: `transition:${workItemId}->${toState}` });
    try {
      outcome = await runBody((text, params) => sys(text, params));
    } finally {
      await sys.release();
    }
  } else {
    // Default agent-role path — unchanged.
    outcome = await withTransaction(async (client) => {
      await setAgentContext(client, agentId);
      return runBody((text, params) => client.query(text, params));
    });
  }

  // `runBody` returns `false` (not an object) when the work item was not found.
  if (!outcome) return false;

  const { success, toState: st, workItemId: wid } = outcome;
  // Wake orchestrator AFTER the transaction commits so it can claim the state_changed event
  if (success && (st === 'completed' || st === 'failed')) {
    notify({ eventType: 'state_changed', workItemId: wid, targetAgentId: 'orchestrator' })
      .catch(() => {}); // Non-critical — falls back to 3s polling
  }
  return success;
}

/**
 * Claim the next available task for an agent.
 * Uses SKIP LOCKED to prevent contention.
 */
export async function claimNextTask(agentId, runnerId = null) {
  return withTransaction(async (client) => {
    await setAgentContext(client, agentId);

    const result = await client.query(
      `SELECT * FROM agent_graph.claim_next_task($1, $2)`,
      [agentId, runnerId]
    );

    return result.rows[0] || null;
  });
}

/**
 * Atomic claim + guard + transition to in_progress.
 * Fix 4: All three operations in a single transaction.
 * Returns { task, preCheck } on success, null if no work or guard fails.
 */
export async function claimAndStart({ agentId, configHash, estimatedCostUsd = 0, runnerId = null }) {
  return withTransaction(async (client) => {
    await setAgentContext(client, agentId);

    // 1. Claim task (SKIP LOCKED). Runner-aware (Phase 3): this runner pulls
    //    unrouted work + work routed specifically to it.
    const claimResult = await client.query(
      `SELECT * FROM agent_graph.claim_next_task($1, $2)`,
      [agentId, runnerId]
    );
    const task = claimResult.rows[0] || null;
    if (!task) return null;

    // 2. Guard check — within the same transaction
    const preCheck = await guardCheck({
      action: task.event_type,
      agentId,
      configHash,
      taskId: task.work_item_id,
      estimatedCostUsd,
      client, // Fix 5: pass transaction client for atomic budget read
    });

    if (!preCheck.allowed) {
      log.warn(`[${agentId}] Guard check failed for ${task.work_item_id}: ${preCheck.reason}`);

      // Release budget reservation if one was made during guard check
      // (budget OK but another check failed → reservation leaks without this)
      if (preCheck._budgetReserved > 0) {
        if (preCheck._campaignId) {
          // ADR-021: Release from campaign budget envelope
          await client.query(`SELECT agent_graph.release_campaign_budget($1, $2)`, [preCheck._campaignId, preCheck._budgetReserved]);
        } else {
          await client.query(`SELECT agent_graph.release_budget($1, $2)`, [preCheck._budgetReserved, preCheck._budgetAccountId || null]);
        }
      }

      // Transition to blocked within the same TX (only for owned work items, not events)
      if (task.event_type !== 'state_changed') {
        const blockedClaim = signAgentClaim(agentId, task.work_item_id, 'blocked');
        const blockedChecks = blockedClaim
          ? { pre: preCheck, hmac_claim: blockedClaim }
          : { pre: preCheck };
        await client.query(
          `SELECT * FROM agent_graph.transition_state($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [task.work_item_id, 'blocked', agentId, configHash,
           `Guard check failed: ${preCheck.reason}`, JSON.stringify(blockedChecks), 0, null, null]
        );
      }
      return null;
    }

    // 3. Transition to in_progress — same TX
    // Skip for state_changed events: work_item_id refers to the original task
    // (already completed), not a new work item for this agent. The event is
    // tracked via task_events.processed_at, not the work_items state machine.
    if (task.event_type !== 'state_changed') {
      const startClaim = signAgentClaim(agentId, task.work_item_id, 'in_progress');
      const startChecks = startClaim ? { hmac_claim: startClaim } : {};
      await client.query(
        `SELECT * FROM agent_graph.transition_state($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [task.work_item_id, 'in_progress', agentId, configHash,
         'Task claimed, starting execution', JSON.stringify(startChecks), 0, null, null]
      );
    }

    return { task, preCheck };
  });
}

/**
 * Create a work item in the task graph.
 *
 * When `client` is null (default), a self-managed transaction wraps the INSERT
 * and the post-commit task_assigned notification fires automatically. When the
 * caller passes its own pg client, the inserts run on that client (caller owns
 * the COMMIT) and the wake-up notification is the caller's responsibility — it
 * must fire only after the parent transaction commits, otherwise the receiving
 * agent may try to claim a row that hasn't been committed yet.
 */
export async function createWorkItem({
  type,
  title,
  description = null,
  createdBy,
  parentId = null,
  assignedTo = null,
  priority = 0,
  deadline = null,
  budgetUsd = null,
  routingClass = null,
  metadata = {},
  accountId = null,
  dataClassification = undefined,
  // OPT-162 Phase 2 (ADR-020): obligation provenance + tenancy columns added by
  // mig 178. All default to undefined → column omitted from the INSERT → the DB
  // DEFAULT applies (owner_org_id keeps mig 134's Staqs default; the rest stay
  // NULL). This preserves EXACT existing behavior for every caller that omits
  // them (intent-executor, etc.); only the signal-action-bridge passes them.
  // These columns are INERT — nothing reads them until OPT-162 Phase 3.
  ownerOrgId = undefined,
  obligationType = undefined,
  sourceMessageId = undefined,
  viewerEmails = undefined,
  client = null,
}) {
  const runInTx = client
    ? async (fn) => fn(client)
    : withTransaction;

  const item = await runInTx(async (c) => {
    await setAgentContext(c, createdBy, 'board');

    // data_classification must be committed in the SAME insert as assigned_to,
    // BEFORE the task_assigned notify fires — otherwise a fast executor can
    // claim a CONFIDENTIAL/RESTRICTED item before guard-check.js sees its
    // classification (bridge gated-item race). Default undefined → DB default,
    // preserving existing behavior for every caller that omits it.
    const useClassification = dataClassification !== undefined;

    // OPT-162 Phase 2: build the optional obligation columns dynamically so a
    // caller that omits any of them gets the DB DEFAULT (no behavior change).
    // Each is appended (column name + value) only when explicitly provided.
    const baseCols = [
      'type', 'title', 'description', 'created_by', 'parent_id', 'assigned_to',
      'priority', 'deadline', 'budget_usd', 'routing_class', 'metadata', 'account_id',
    ];
    const baseVals = [
      type, title, description, createdBy, parentId, assignedTo,
      priority, deadline, budgetUsd, routingClass, JSON.stringify(metadata), accountId,
    ];
    if (useClassification) {
      baseCols.push('data_classification');
      baseVals.push(dataClassification);
    }
    const optional = [
      ['owner_org_id', ownerOrgId],
      ['obligation_type', obligationType],
      ['source_message_id', sourceMessageId],
      ['viewer_emails', viewerEmails],
    ];
    for (const [col, val] of optional) {
      if (val !== undefined) {
        baseCols.push(col);
        baseVals.push(val);
      }
    }
    const placeholders = baseVals.map((_, i) => `$${i + 1}`).join(', ');
    const result = await c.query(
      `INSERT INTO agent_graph.work_items
       (${baseCols.join(', ')})
       VALUES (${placeholders})
       RETURNING *`,
      baseVals,
    );

    const row = result.rows[0];

    // Insert task_events row inside the transaction (atomic with work item creation)
    if (assignedTo) {
      await c.query(
        `INSERT INTO agent_graph.task_events (event_type, work_item_id, target_agent_id, priority, event_data)
         VALUES ('task_assigned', $1, $2, $3, $4)`,
        [row.id, assignedTo, priority, JSON.stringify({ title, type })]
      );
    }

    return row;
  });

  // Fire wake-up notification AFTER our transaction commits.
  // When the caller passed its own client, COMMIT hasn't happened yet — the
  // caller fires the notification post-COMMIT, so we skip here.
  if (!client && assignedTo && item) {
    notify({ eventType: 'task_assigned', workItemId: item.id, targetAgentId: assignedTo })
      .catch(() => {});
  }

  return item;
}

/**
 * Assign an already-existing, unassigned work item to an executor (A-prime,
 * ADR-008). This is the orchestrator's in-place assignment path: the bridge
 * creates the work_item with assigned_to=NULL (so the assignment trigger is
 * bypassed and no task_assigned event fires), then the orchestrator — the SOLE
 * assigner — calls this to route it to the target executor.
 *
 * The assignment trigger (agent_graph.enforce_assignment_rules) keys on
 * NEW.created_by. So we set created_by=assignerAgentId in the SAME UPDATE that
 * sets assigned_to: the trigger then checks the assigner's grant rows, not the
 * bridge's (the bridge has — and must have — ZERO assignment authority). Bridge
 * origin is preserved in metadata.source / metadata.source_signal_id.
 *
 * Mirrors createWorkItem's event semantics: inserts the task_assigned event
 * inside the transaction (atomic with the UPDATE) and fires the pg_notify
 * wake-up AFTER commit so claim_next_task surfaces the row to the executor.
 *
 * Idempotent: the WHERE clause requires assigned_to IS NULL, so a re-run (e.g. a
 * redelivered routing event) is a no-op rather than a double-assign.
 *
 * @param {Object} opts
 * @param {string} opts.workItemId - existing agent_graph.work_items.id
 * @param {string} opts.assignTo - target executor agent id
 * @param {string} opts.assignerAgentId - the assigning agent (e.g. 'orchestrator')
 * @param {number} [opts.priority=0] - wake-up event priority
 * @returns {Promise<Object|null>} the updated row, or null if already assigned/missing
 */
export async function assignWorkItem({ workItemId, assignTo, assignerAgentId, priority = 0 }) {
  if (!workItemId || !assignTo || !assignerAgentId) {
    throw new Error('assignWorkItem requires { workItemId, assignTo, assignerAgentId }');
  }

  const item = await withTransaction(async (client) => {
    await setAgentContext(client, assignerAgentId, 'board');

    // Set created_by to the assigner so enforce_assignment_rules checks the
    // assigner's grants (not the bridge's). Only claim an unassigned row.
    // Preserve the ORIGINAL created_by (e.g. 'signal-action-bridge') in metadata
    // in the SAME UPDATE before overwriting it, so bridge provenance survives the
    // assigner rewrite. END-STATE: a purpose-built assigned_by column keyed by
    // the assignment trigger is the proper home for the assigner identity.
    const result = await client.query(
      `UPDATE agent_graph.work_items
          SET metadata = COALESCE(metadata, '{}'::jsonb)
                         || jsonb_build_object('original_created_by', created_by),
              assigned_to = $2,
              created_by = $3
        WHERE id = $1
          AND assigned_to IS NULL
        RETURNING *`,
      [workItemId, assignTo, assignerAgentId]
    );
    const row = result.rows[0];
    if (!row) return null; // already assigned or not found — idempotent no-op

    // Atomic with the assignment: emit the wake-up event so claim_next_task
    // surfaces this work item to the target executor.
    await client.query(
      `INSERT INTO agent_graph.task_events (event_type, work_item_id, target_agent_id, priority, event_data)
       VALUES ('task_assigned', $1, $2, $3, $4)`,
      [row.id, assignTo, priority, JSON.stringify({ title: row.title, type: row.type })]
    );

    return row;
  });

  // Fire the wake-up notification AFTER commit (mirrors createWorkItem).
  if (item) {
    notify({ eventType: 'task_assigned', workItemId: item.id, targetAgentId: assignTo })
      .catch(() => {});
  }

  return item;
}

/**
 * Create an edge between two work items.
 * Cycle detection trigger will prevent cycles.
 */
export async function createEdge(fromId, toId, edgeType = 'depends_on') {
  return withTransaction(async (client) => {
    const result = await client.query(
      `INSERT INTO agent_graph.edges (from_id, to_id, edge_type) VALUES ($1, $2, $3) RETURNING *`,
      [fromId, toId, edgeType]
    );
    return result.rows[0];
  });
}
