import { randomUUID } from 'node:crypto';
import { query, withTransaction, setAgentContext } from '../db.js';
import { createIntent, transitionIntent } from '../runtime/intent-manager.js';
import { publishEvent } from '../runtime/infrastructure.js';
import { writerOrgId } from '../../../lib/tenancy/owner-stamp.js';
import {
  validateAuthoredRequest,
  buildContract,
  isCompleteContract,
  criteriaReconciled,
  CRITERION_RESULTS,
} from '../../../lib/runtime/governance/authored-request.js';

/**
 * Agent Intents API routes — board review of agent-proposed actions.
 *
 * GET  /api/intents?status=pending  — list intents by status (default: pending)
 * GET  /api/intents/rates           — 90-day match rates from intent_match_rate view
 * POST /api/intents                 — author a human work request (Hub Wedge B): a
 *                                     non-dev submits outcome + acceptance criteria +
 *                                     out-of-scope; it lands as a pending intent. The
 *                                     Definition-of-Ready contract is enforced HERE (P2),
 *                                     so an underspecified request is non-submittable.
 * POST /api/intents/:id/approve     — atomic approve → create work_item → mark executed
 * POST /api/intents/:id/reject      — reject with optional board_feedback
 */
export function registerIntentRoutes(routes, { withViewer } = {}) {
  // Resolve the tenancy principal for write routes (STAQPRO-593 owner-stamp).
  // withViewer is injected by api.js; absent/throw → null → column DEFAULT applies.
  const resolvePrincipalFor = async (req) => {
    if (!withViewer) return null;
    try {
      return (await withViewer(req)).principal;
    } catch {
      return null;
    }
  };

  // GET /api/intents — list intents, filterable by status
  routes.set('GET /api/intents', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const status = url.searchParams.get('status') || 'pending';

    // history: last 20 non-pending intents ordered by reviewed_at desc
    if (status === 'history') {
      const result = await query(
        `SELECT id, agent_id, agent_tier, intent_type, decision_tier,
                title, reasoning, proposed_action, trigger_context,
                trigger_type, status, board_feedback, expires_at,
                created_at, reviewed_at
         FROM agent_graph.agent_intents
         WHERE status != 'pending'
         ORDER BY COALESCE(reviewed_at, created_at) DESC
         LIMIT 20`
      );
      return { intents: result.rows };
    }

    const allowed = ['pending', 'approved', 'rejected', 'executed', 'expired'];
    if (!allowed.includes(status)) {
      throw Object.assign(new Error(`status must be one of: pending, approved, rejected, executed, expired, history`), { statusCode: 400 });
    }

    const result = await query(
      `SELECT id, agent_id, agent_tier, intent_type, decision_tier,
              title, reasoning, proposed_action, trigger_context,
              trigger_type, status, board_feedback, expires_at, created_at
       FROM agent_graph.agent_intents
       WHERE status = $1
       ORDER BY
         CASE decision_tier
           WHEN 'existential' THEN 0
           WHEN 'strategic' THEN 1
           WHEN 'tactical' THEN 2
         END,
         created_at ASC
       LIMIT 100`,
      [status]
    );

    return { intents: result.rows };
  });

  // GET /api/intents/rates — 90-day rolling match rates per agent + type
  routes.set('GET /api/intents/rates', async () => {
    const result = await query(
      `SELECT * FROM agent_graph.intent_match_rate ORDER BY total DESC`
    );
    return { rates: result.rows };
  });

  // GET /api/intents/authored — render-back for Hub Wedge B. Every human-authored
  // request with its lifecycle: the pending/rejected intent, or (once approved) the
  // resulting work_item's status. acceptance_criteria is the author's contract — the
  // board renders raw statuses into human-legible stages (vocabulary = a render concern).
  // api.js already 401s unauthenticated callers (global P1 gate); restrict further to
  // the board role so an agent JWT cannot read governance requests (defense-in-depth).
  routes.set('GET /api/intents/authored', async (req) => {
    if (!req.auth || req.auth.role !== 'board') {
      throw Object.assign(new Error('board identity required'), { statusCode: 403 });
    }
    const result = await query(
      `SELECT i.id            AS intent_id,
              i.title,
              i.status        AS intent_status,
              i.reasoning     AS outcome,
              i.created_at,
              i.proposed_action -> 'payload' -> 'acceptance_criteria' AS contract,
              w.id            AS work_item_id,
              w.status        AS work_item_status,
              w.acceptance_criteria AS work_item_contract,
              w.updated_at    AS work_item_updated_at
         FROM agent_graph.agent_intents i
         -- tenancy:allow-unscoped — board-only governance render-back. The work_item is
         -- correlated to an already board-authored, board-approved intent (WHERE source =
         -- 'human-authored', joined on intent_id), so this reads only rows the board itself
         -- created. Not a tenant leak; mirrors the unscoped sibling intent reads on this surface.
         LEFT JOIN agent_graph.work_items w
                ON w.metadata ->> 'intent_id' = i.id::text
        WHERE i.trigger_context ->> 'source' = 'human-authored'
        ORDER BY i.created_at DESC
        LIMIT 100`
    );
    return { requests: result.rows };
  });

  // POST /api/intents/authored/criteria — board marks acceptance-criteria results at
  // review (Hub Wedge C: review-binding). Board-only. Persists pass/fail per criterion
  // onto the work_item's acceptance_criteria JSONB + provenance (verified_by/at).
  // "Reconciled" = every criterion marked pass. This is the LEGITIMATE review-binding
  // slice of Wedge C — it records a verdict against the author's contract; it does NOT
  // mutate the criteria text or steer the agent mid-execution (the audit-integrity trap).
  // Static route (workItemId in body) so no routeKeyFor param regex is needed.
  routes.set('POST /api/intents/authored/criteria', async (req, body) => {
    const auth = req.auth;
    if (!auth || auth.role !== 'board' || typeof auth.sub !== 'string') {
      throw Object.assign(new Error('board identity required'), { statusCode: 403 });
    }
    const workItemId = body?.workItemId;
    const results = body?.results;
    if (typeof workItemId !== 'string' || !workItemId) {
      throw Object.assign(new Error('workItemId is required'), { statusCode: 400 });
    }
    if (!Array.isArray(results) || results.length === 0) {
      throw Object.assign(new Error('results must be a non-empty array of { index, result }'), { statusCode: 400 });
    }
    const seenIndices = new Set();
    for (const r of results) {
      if (!r || !Number.isInteger(r.index) || !CRITERION_RESULTS.includes(r.result)) {
        throw Object.assign(
          new Error('each result must be { index: integer, result: "pass" | "fail" | null }'),
          { statusCode: 400 }
        );
      }
      if (seenIndices.has(r.index)) {
        throw Object.assign(
          new Error(`duplicate index ${r.index} in results — one verdict per criterion`),
          { statusCode: 400 }
        );
      }
      seenIndices.add(r.index);
    }

    const boardSub = String(auth.sub).toLowerCase();
    let stored;
    await withTransaction(async (client) => {
      // work_items is FORCE-RLS (migration 126) — set board context on the txn client
      // before the read/write, exactly as the approve route does.
      await setAgentContext(client, boardSub, 'board');
      // tenancy:allow-unscoped — board-only by-id work_item lookup for criteria review,
      // FOR UPDATE on a single id to serialize concurrent verdicts. Not a tenant scan.
      const wi = await client.query(
        `SELECT id, acceptance_criteria FROM agent_graph.work_items WHERE id = $1 FOR UPDATE`,
        [workItemId]
      );
      if (wi.rows.length === 0) {
        throw Object.assign(new Error('work item not found'), { statusCode: 404 });
      }
      const raw = wi.rows[0].acceptance_criteria;
      const contract = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!isCompleteContract(contract)) {
        throw Object.assign(
          new Error('work item has no human-authored acceptance-criteria contract to verify'),
          { statusCode: 422 }
        );
      }
      for (const { index, result } of results) {
        if (index < 0 || index >= contract.criteria.length) {
          throw Object.assign(new Error(`criterion index ${index} out of range`), { statusCode: 400 });
        }
        contract.criteria[index].result = result;
      }
      contract.verified_by = boardSub;
      contract.verified_at = new Date().toISOString();
      const upd = await client.query(
        `UPDATE agent_graph.work_items
            SET acceptance_criteria = $1, updated_at = now()
          WHERE id = $2
          RETURNING id, status, acceptance_criteria`,
        [JSON.stringify(contract), workItemId]
      );
      stored = upd.rows[0];
    });

    // Read back the round-tripped (committed) value — distinct from the in-txn contract.
    const verifiedContract = typeof stored.acceptance_criteria === 'string'
      ? JSON.parse(stored.acceptance_criteria)
      : stored.acceptance_criteria;
    const reconciled = criteriaReconciled(verifiedContract);

    await publishEvent(
      'criteria_verified',
      `Board verified acceptance criteria for work item ${workItemId}${reconciled ? ' (reconciled)' : ''}`,
      null,
      workItemId,
      { work_item_id: workItemId, verified_by: boardSub, reconciled },
    );

    return { ok: true, workItemId, contract: verifiedContract, reconciled };
  });

  // POST /api/intents — author a human work request (Hub Wedge B).
  // The ONLY intake path for human-authored work: no informal channel creates a
  // governed work_item. The acceptance-criteria contract is enforced at this route
  // (P2), so "I want a thing" is rejected before the DB ever sees it (firehose guard).
  routes.set('POST /api/intents', async (req, body) => {
    // Intentional: ANY authenticated identity may author a request (board members
    // today; non-dev teammates as the hub opens up) — authoring is not a board-only
    // act. The acceptance-criteria contract, not the caller's tier, is the gate. An
    // agent JWT with a string sub could technically call this; tighten to a human
    // role here if that ever becomes a concern.
    const auth = req.auth;
    if (!auth || typeof auth.sub !== 'string') {
      throw Object.assign(
        new Error('authoring a request requires an authenticated identity'),
        { statusCode: 401 }
      );
    }

    const validation = validateAuthoredRequest(body || {});
    if (!validation.ok) {
      throw Object.assign(
        new Error(`Request is not ready: ${validation.errors.join('; ')}`),
        { statusCode: 400, details: validation.errors }
      );
    }

    const authoredBy = String(auth.sub).toLowerCase();
    const contract = buildContract(validation.normalized, authoredBy);

    // Carry the contract on the intent's proposed_action so the approve route can
    // copy it onto the work_item verbatim. The author's words ARE the spec.
    const proposedAction = {
      type: 'create_work_item',
      payload: {
        type: 'task',
        title: validation.normalized.title,
        description: validation.normalized.outcome,
        acceptance_criteria: contract,
        metadata: { authored_by: authoredBy },
      },
    };

    const intent = await createIntent({
      agentId: authoredBy,
      intentType: 'task',
      decisionTier: 'tactical',
      title: validation.normalized.title,
      reasoning: validation.normalized.outcome,
      proposedAction,
      // Unique pattern per request: createIntent dedups on
      // (agent_id, trigger_context->>'pattern', contact_id, message_id). A UUID (not a
      // timestamp) guarantees uniqueness even for same-millisecond submissions by the
      // same author, which would otherwise silently dedup into a 409.
      triggerContext: {
        source: 'human-authored',
        authored_by: authoredBy,
        pattern: `authored:${randomUUID()}`,
      },
    });

    if (!intent) {
      throw Object.assign(
        new Error('Duplicate request (an identical pending request already exists)'),
        { statusCode: 409 }
      );
    }

    await publishEvent(
      'intent_authored',
      `${authoredBy} authored a work request: ${validation.normalized.title}`,
      null,
      intent.id,
      { intent_id: intent.id, authored_by: authoredBy },
    );

    return { ok: true, intent };
  });

  // POST /api/intents/:id/approve — atomic approve → create work_item → executed
  routes.set('POST /api/intents/:id/approve', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const id = url.pathname.split('/api/intents/')[1]?.split('/approve')[0];

    if (!id) {
      throw Object.assign(new Error('Missing intent ID'), { statusCode: 400 });
    }

    // STAQPRO-524 follow-up: agent_graph.work_items is FORCE'd by migration
    // 126. The INSERT below runs inside withTransaction's checked-out client,
    // so we cannot use withBoardScope (which returns a separate scoped pool
    // client). Instead, set agent context on the transaction client directly
    // via setAgentContext — same set_config calls, scoped to this txn.
    // Board JWT identity comes from req.auth (resolveAuth runs once per req).
    const auth = req.auth;
    if (!auth || auth.role !== 'board' || typeof auth.sub !== 'string') {
      throw Object.assign(
        new Error('approve requires authenticated board identity'),
        { statusCode: 401 }
      );
    }
    const boardSub = String(auth.sub).toLowerCase();
    // Owner-stamp from the caller's org (STAQPRO-593). Resolved before the txn so
    // the value can be spliced into the work_items INSERT. null → column DEFAULT.
    const ownerOrgId = writerOrgId(await resolvePrincipalFor(req));

    // Fetch intent to validate action type
    const intentResult = await query(
      `SELECT * FROM agent_graph.agent_intents WHERE id = $1 AND status = 'pending'`,
      [id]
    );

    if (intentResult.rows.length === 0) {
      throw Object.assign(new Error('Intent not found or no longer pending'), { statusCode: 404 });
    }

    const intent = intentResult.rows[0];
    const action = intent.proposed_action;

    // Only create_work_item is implemented (Fix 7 from CLI)
    const supportedActions = ['create_work_item'];
    if (!supportedActions.includes(action.type)) {
      throw Object.assign(
        new Error(`Action type "${action.type}" is not yet implemented. Cannot approve.`),
        { statusCode: 422 }
      );
    }

    // Human-authored work (Hub Wedge B) must carry a COMPLETE acceptance-criteria
    // contract before it becomes governed work — defense-in-depth on top of the
    // create-route validation (P2 enforced at both ends). Agent-originated intents
    // (no contract) are unaffected.
    const payload = action.payload || {};
    const contract = payload.acceptance_criteria || null;
    const humanAuthored =
      intent.trigger_context?.source === 'human-authored' || contract != null;
    if (humanAuthored && !isCompleteContract(contract)) {
      throw Object.assign(
        new Error(
          'human-authored work requires a complete acceptance-criteria contract ' +
          '(outcome + at least 3 checkable criteria + an out-of-scope item)'
        ),
        { statusCode: 422 }
      );
    }

    // Atomic transaction: approve → create work_item → mark executed
    let workItem;
    await withTransaction(async (client) => {
      // Establish board agent context on this txn before any RLS-gated write.
      // Mirrors withBoardScope() (which sets app.role='board' + app.agent_id),
      // but applied to the existing transaction client rather than a fresh
      // scoped pool checkout. Settings are local to the txn (set_config third
      // arg = true).
      await setAgentContext(client, boardSub, 'board');

      // Step 1: Approve (atomic guard — only succeeds if still pending)
      const approveResult = await client.query(
        `UPDATE agent_graph.agent_intents
         SET status = 'approved', reviewed_by = 'board', reviewed_at = now()
         WHERE id = $1 AND status = 'pending'
         RETURNING *`,
        [id]
      );

      if (approveResult.rows.length === 0) {
        throw new Error('Intent is no longer pending (race condition)');
      }

      // Step 2: Create work item from proposed action. acceptance_criteria carries
      // the human author's contract verbatim (null for agent-originated intents).
      const itemResult = await client.query(
        `INSERT INTO agent_graph.work_items
         (type, title, description, created_by, assigned_to, priority, metadata, owner_org_id, acceptance_criteria)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          payload.type || 'task',
          payload.title || intent.title,
          payload.description || intent.reasoning,
          'board',
          payload.assigned_to || null,
          payload.priority || 0,
          JSON.stringify({
            source: 'intent',
            intent_id: intent.id,
            original_agent: intent.agent_id,
            ...payload.metadata,
          }),
          ownerOrgId,
          contract ? JSON.stringify(contract) : null,
        ]
      );
      workItem = itemResult.rows[0];

      // Step 3: Mark as executed
      await client.query(
        `UPDATE agent_graph.agent_intents
         SET status = 'executed', executed_at = now()
         WHERE id = $1 AND status = 'approved'`,
        [id]
      );
    });

    await publishEvent(
      'intent_approved',
      `Board approved intent: ${intent.title}`,
      null,
      workItem.id,
      { intent_id: id, agent_id: intent.agent_id, work_item_id: workItem.id },
    );

    return { ok: true, workItem };
  });

  // POST /api/intents/:id/reject — reject with optional feedback
  routes.set('POST /api/intents/:id/reject', async (req, body) => {
    const url = new URL(req.url, 'http://localhost');
    const id = url.pathname.split('/api/intents/')[1]?.split('/reject')[0];

    if (!id) {
      throw Object.assign(new Error('Missing intent ID'), { statusCode: 400 });
    }

    const feedback = body?.feedback || null;
    if (feedback != null && typeof feedback !== 'string') {
      throw Object.assign(new Error('feedback must be a string'), { statusCode: 400 });
    }

    const result = await transitionIntent(id, 'rejected', 'board', feedback);

    if (!result.success) {
      throw Object.assign(new Error(result.error), { statusCode: 409 });
    }

    await publishEvent(
      'intent_rejected',
      `Board rejected intent: ${id.slice(0, 8)}...`,
      null,
      id,
      { intent_id: id, feedback },
    );

    return { ok: true };
  });
}
