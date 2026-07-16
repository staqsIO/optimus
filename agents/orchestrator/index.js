import { readFileSync } from 'fs';
import { AgentLoop } from '../../lib/runtime/agent-loop.js';
import { createWorkItem, transitionState, assignWorkItem } from '../../lib/runtime/state-machine.js';
import { emit } from '../../lib/runtime/event-bus.js';
import { query } from '../../lib/db.js';
import { pollForNewMessages, pollAllAccounts } from '../../autobot-inbox/src/gmail/poller.js';
import { reconcileAllAccounts } from '../../autobot-inbox/src/gmail/reconciler.js';
import { redactEmail, truncateSubject } from '../../lib/runtime/log-redactor.js';
import { publishEvent } from '../../lib/runtime/infrastructure.js';
import { fetchEmailBody } from '../../autobot-inbox/src/gmail/client.js';
import { ingestDocument } from '../../lib/rag/ingest.js';
import { emitAdapterSignal } from '../../lib/adapters/registry.js';
import { planVerificationRouting, isVerificationSpineEnabled } from '../../lib/runtime/verification/verification-gate.js';

const AUTO_INGEST_EMAIL = (() => {
  const v = String(process.env.AUTO_INGEST_INBOUND_EMAIL || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
})();
const EMAIL_INGEST_MAX_LENGTH = 120_000;

const agentsConfig = JSON.parse(readFileSync(new URL('../../autobot-inbox/config/agents.json', import.meta.url), 'utf-8'));
const emailRules = JSON.parse(readFileSync(new URL('../../autobot-inbox/config/email-rules.json', import.meta.url), 'utf-8'));

// Precompute noise patterns from email-rules.json for pre-triage priority scoring
const NOISE_FROM_PATTERNS = emailRules.triageRules?.noise?.patterns
  ?.find(p => p.field === 'from_address')?.values || [];
const NOISE_SUBJECT_PATTERNS = emailRules.triageRules?.noise?.patterns
  ?.find(p => p.field === 'subject')?.values || [];
const NOISE_LABEL_PATTERNS = emailRules.triageRules?.noise?.patterns
  ?.find(p => p.field === 'labels')?.values || [];
const FYI_FROM_PATTERNS = emailRules.triageRules?.fyi?.patterns
  ?.find(p => p.field === 'from_address')?.values || [];
const FYI_SUBJECT_PATTERNS = emailRules.triageRules?.fyi?.patterns
  ?.find(p => p.field === 'subject')?.values || [];

/**
 * Pre-triage priority scoring based on metadata signals.
 * Score 0-100. Higher = more important. claim_next_task orders by priority DESC.
 * Zero LLM cost — purely deterministic from email metadata + DB lookups.
 */
async function computePreTriagePriority(msg) {
  let score = 50; // Baseline: unknown importance

  const fromAddr = (msg.from_address || '').toLowerCase();
  const subject = (msg.subject || '').toLowerCase();
  const labels = msg.labels || [];

  // --- Negative signals (noise/low-priority) ---

  // Gmail's own noise classification
  if (labels.some(l => NOISE_LABEL_PATTERNS.includes(l))) {
    score -= 40;
  }

  // Known noise sender patterns (noreply@, notifications@, etc.)
  if (NOISE_FROM_PATTERNS.some(p => fromAddr.includes(p))) {
    score -= 30;
  }

  // Noise subject patterns
  if (NOISE_SUBJECT_PATTERNS.some(p => subject.includes(p))) {
    score -= 20;
  }

  // FYI sender patterns (calendar, CI/CD, etc.)
  if (FYI_FROM_PATTERNS.some(p => fromAddr.includes(p))) {
    score -= 20;
  }

  // FYI subject patterns (invitation:, deployed to, etc.)
  if (FYI_SUBJECT_PATTERNS.some(p => subject.includes(p.toLowerCase()))) {
    score -= 15;
  }

  // --- Positive signals (important) ---

  // Check if sender is a known contact with a meaningful tier.
  // Column is `tier` (not `contact_tier`); filter column is `email_address`
  // (not `email`). Earlier code had both wrong, silently scoring every known
  // contact at 0 bonus.
  try {
    const contactResult = await query(
      `SELECT tier FROM signal.contacts WHERE lower(email_address) = lower($1) LIMIT 1`,
      [fromAddr]
    );
    const tier = contactResult.rows[0]?.tier;
    if (tier === 'inner_circle') score += 30;
    else if (tier === 'active') score += 20;
    else if (tier === 'inbound_only') score += 5;
  } catch { /* signal schema may not exist yet */ }

  // Thread continuation on an existing action_required thread
  if (msg.thread_id) {
    try {
      const threadResult = await query(
        `SELECT triage_category FROM inbox.messages
         WHERE thread_id = $1 AND triage_category = 'action_required' LIMIT 1`,
        [msg.thread_id]
      );
      if (threadResult.rows.length > 0) score += 40;
    } catch { /* OK */ }
  }

  // Reply to a message we sent (in_reply_to present + thread exists in our DB)
  if (msg.in_reply_to) {
    try {
      const replyResult = await query(
        `SELECT 1 FROM inbox.messages WHERE message_id = $1 LIMIT 1`,
        [msg.in_reply_to]
      );
      if (replyResult.rows.length > 0) score += 25;
    } catch { /* OK */ }
  }

  // Attachments from known contact = likely substantive
  if (msg.has_attachments && score > 50) score += 10;

  // Clamp to 0-100
  return Math.max(0, Math.min(100, score));
}

/**
 * Receptionist Pattern: deterministic post-triage routing.
 * Short-circuits LLM call for predictable routing decisions.
 * Returns null if routing requires LLM judgment (fall-through).
 *
 * Audit: every deterministic route is logged with routing_method='deterministic'
 * in state_transitions (P3: transparency by structure).
 */
async function tryDeterministicRoute(completedItem, completingAgent, parent, email) {
  // Rule 8: executor-ticket completion — deterministically gate executor-coder dispatch.
  // Only bug/feature_request categories warrant a code fix. Routing this via LLM was
  // the bug: LLM incorrectly dispatched executor-coder for 'other'/'question' tickets
  // (e.g. client sales/design requests targeting external repos like Sodexis/Odoo-V19).
  if (completingAgent === 'executor-ticket') {
    const t = (completedItem.metadata || {}).ticket_result;
    if (!t) return null;

    const routes = [];
    if (['bug', 'feature_request'].includes(t.category)) {
      routes.push({ agent: 'executor-coder', reason: 'Deterministic: bug/feature_request → code fix PR', priority: 2 });
    }
    if (t.has_valid_reply_address) {
      routes.push({ agent: 'executor-responder', reason: 'Deterministic: feedback receipt reply', priority: 2 });
    }

    return {
      terminal: routes.length === 0,
      routes,
      reasoning: routes.length === 0
        ? `Deterministic: ticket category "${t.category}" — no code action needed, terminal`
        : `Deterministic: ticket category "${t.category}" → ${routes.map(r => r.agent).join(', ')}`,
      routing_method: 'deterministic',
    };
  }

  // Only applies after triage completion (executor-intake replaced executor-triage)
  if (!['executor-triage', 'executor-intake'].includes(completingAgent)) return null;

  const meta = completedItem.metadata || {};

  // executor-triage uses: triage_result { category, needs_strategist, pipeline, quick_score }
  // executor-intake uses: intake_classification { complexity, recommended_action, confidence }
  //   + routing { assigned_to, routing_class, needs_review }
  const triage = meta.triage_result;
  const intake = meta.intake_classification;
  const routing = meta.routing;

  if (!triage && !intake) return null;

  // Normalize to the triage_result schema that Rules 1-7 expect
  let category, needs_strategist, pipeline, quick_score;

  if (triage) {
    // executor-triage / deterministic intake path — already in correct format
    ({ category, needs_strategist = false, pipeline = null, quick_score = 0 } = triage);
  } else {
    // executor-intake LLM path — map complexity/recommended_action to category
    quick_score = intake.confidence ?? 0;
    needs_strategist = intake.complexity === 'COMPLEX' || intake.complexity === 'SPECIALIZED';
    pipeline = intake.pipeline || null;

    // Map recommended_action → category
    // RESOLVE_DIRECT = agent handles autonomously (could be fyi or needs_response, NOT noise)
    const INTAKE_CONFIDENCE_FYI_THRESHOLD = 0.8;
    if (intake.recommended_action === 'RESOLVE_DIRECT' && intake.complexity === 'TRIVIAL' && quick_score >= INTAKE_CONFIDENCE_FYI_THRESHOLD) {
      category = 'fyi';
    } else if (intake.recommended_action === 'RESOLVE_DIRECT' && (intake.complexity === 'COMPLEX' || intake.complexity === 'SPECIALIZED')) {
      category = 'action_required'; // complex + autonomous = needs board attention
    } else if (intake.recommended_action === 'RESOLVE_DIRECT') {
      category = 'needs_response'; // simple autonomous handling
    } else if (intake.complexity === 'TRIVIAL' && quick_score >= INTAKE_CONFIDENCE_FYI_THRESHOLD) {
      category = 'fyi';
    } else if (routing?.routing_class === 'LIGHTWEIGHT' || intake.complexity === 'MODERATE') {
      category = 'needs_response';
    } else {
      category = 'action_required';
    }
  }

  // Post-triage priority: compute meaningful priority for downstream work items
  // based on triage classification. claim_next_task orders by priority DESC.
  const postTriagePriority =
    category === 'action_required' ? 90 :
    category === 'needs_response' && needs_strategist ? 70 :
    category === 'needs_response' ? 60 :
    category === 'fyi' ? 10 : 0;

  // Guard: never auto-archive emails from known important contacts (Liotta review)
  // Neo review: query live contact tier instead of relying on metadata
  let isImportantSender = false;
  if (email?.from_address) {
    try {
      const tierResult = await query(
        `SELECT tier FROM signal.contacts WHERE lower(email_address) = lower($1)`,
        [email.from_address]
      );
      const tier = tierResult.rows[0]?.tier;
      isImportantSender = tier && ['inner_circle', 'active'].includes(tier);
    } catch { /* signal schema unavailable — allow archive */ }
  }

  // Rule 1: Noise → terminal (L1 autonomy — caller handles archive)
  if (category === 'noise') {
    if (isImportantSender) {
      // Important sender misclassified as noise — route to responder instead of archiving
      return { terminal: false, routes: [{ agent: 'executor-responder', reason: 'Noise override: important sender', priority: 60 }],
        reasoning: 'Important sender classified as noise — overriding to responder', routing_method: 'deterministic' };
    }
    return { terminal: true, archive: true, routes: [], reasoning: 'Autonomous: noise — auto-archived', routing_method: 'deterministic' };
  }

  // Rule 2: FYI with no strategist needed → terminal (L1 autonomy — caller handles archive)
  if (category === 'fyi' && !needs_strategist) {
    if (isImportantSender) {
      return { terminal: true, archive: false, routes: [], reasoning: 'FYI from important sender — logged but not archived', routing_method: 'deterministic' };
    }
    return { terminal: true, archive: true, routes: [], reasoning: 'Autonomous: FYI — auto-archived, logged for digest', routing_method: 'deterministic' };
  }

  // Rule 3: Feedback pipeline → executor-ticket
  if (pipeline === 'feedback') {
    return {
      terminal: false,
      routes: [{ agent: 'executor-ticket', reason: 'Deterministic: feedback pipeline → ticket', priority: postTriagePriority }],
      reasoning: 'Deterministic: feedback pipeline routed to executor-ticket',
      routing_method: 'deterministic',
    };
  }

  // Rule 4: Project change pipeline → executor-ticket
  if (pipeline === 'project_change') {
    return {
      terminal: false,
      routes: [{ agent: 'executor-ticket', reason: 'Deterministic: project change → ticket', priority: postTriagePriority }],
      reasoning: 'Deterministic: project change routed to executor-ticket',
      routing_method: 'deterministic',
    };
  }

  // Rule 5: action_required or needs_response + needs_strategist → strategist
  if ((category === 'action_required' || category === 'needs_response') && needs_strategist) {
    return {
      terminal: false,
      routes: [{ agent: 'strategist', reason: 'Deterministic: complex email → strategist', priority: postTriagePriority }],
      reasoning: 'Deterministic: needs strategist for priority/strategy',
      routing_method: 'deterministic',
    };
  }

  // Rule 6: needs_response + !needs_strategist → responder directly
  if (category === 'needs_response' && !needs_strategist) {
    return {
      terminal: false,
      routes: [{ agent: 'executor-responder', reason: 'Deterministic: simple response → responder', priority: postTriagePriority }],
      reasoning: 'Deterministic: simple response routed directly to responder',
      routing_method: 'deterministic',
    };
  }

  // Rule 7: action_required + !needs_strategist → responder
  if (category === 'action_required' && !needs_strategist) {
    return {
      terminal: false,
      routes: [{ agent: 'executor-responder', reason: 'Deterministic: action required → responder', priority: postTriagePriority }],
      reasoning: 'Deterministic: action required, simple — routed to responder',
      routing_method: 'deterministic',
    };
  }

  // No match → fall through to LLM routing
  return null;
}

/**
 * Orchestrator agent: Gmail poll → task creation → LLM-powered routing.
 * Haiku-tier. Runs on a 60s poll interval.
 * Does NOT triage, draft, or review. Only creates work items and routes them.
 * All routing decisions flow through a single LLM call per agent completion.
 */

async function handler(task, context, agent) {
  // Handle different event types
  switch (task.event_type) {
    case 'task_assigned':
    case 'task_created': {
      // Governance-sourced work items don't have email context — complete them
      // directly since the governance pipeline (audit + board decision) is already done.
      const metadata = context.workItem?.metadata || {};
      if (metadata.source === 'governance_intake') {
        return handleGovernanceTask(task, context, agent);
      }
      return handleNewEmailTask(task, context, agent);
    }
    case 'state_changed':
      return handleStateChanged(task, context, agent);
    case 'task_routing':
      return handleTaskRouting(task, context, agent);
    default:
      return { success: false, reason: `Unknown event type: ${task.event_type}` };
  }
}

/**
 * Handle governance-sourced work items. These come from the governance intake
 * pipeline (submission → audit → board decision → work item). They don't have
 * email context — the audit and board decision ARE the context. Mark as completed
 * since the governance pipeline already handled classification and approval.
 */
async function handleGovernanceTask(task, context, agent) {
  const metadata = context.workItem?.metadata || {};
  console.log(`[orchestrator] Governance task ${task.work_item_id}: submission=${metadata.submission_id}`);
  // Governance work items are informational — the board already decided.
  // Complete the orchestrator's work item to close the loop.
  return { success: true, reason: `Governance submission ${metadata.submission_id} accepted and logged` };
}

/**
 * Handle task_routing INTENT events (A-prime, ADR-008). The signal-action-bridge
 * has ZERO assignment authority: it creates an unassigned (assigned_to=NULL)
 * autonomous work_item and emits this event REQUESTING that the orchestrator —
 * the sole assigner, which holds the executor grant rows — assign it.
 *
 * Reads the target executor from event_data.target_executor, falling back to the
 * work_item's metadata.target_executor (the bridge stamps both). Validates it
 * against agents.json, then assigns the EXISTING work_item in place via
 * assignWorkItem (created_by becomes 'orchestrator', satisfying the assignment
 * trigger). The claimed task_routing event was already marked processed_at by
 * claim_next_task, matching every other event handler here.
 *
 * Best-effort + always returns success:true so a routing failure (bad target,
 * already-assigned, missing item) never crashes or infinitely retries the
 * orchestrator loop — it is logged and surfaced for audit (P3) instead.
 */
async function handleTaskRouting(task, context, agent) {
  const workItemId = task.work_item_id;
  const eventData = task.event_data || {};

  let targetExecutor = eventData.target_executor || null;
  if (!targetExecutor) {
    targetExecutor = context.workItem?.metadata?.target_executor || null;
  }

  if (!targetExecutor) {
    console.warn(`[orchestrator] task_routing for ${workItemId}: no target_executor — skipping`);
    // Durable audit (P3): a routing intent that resolves to no executor would
    // otherwise vanish silently behind success:true. Surface it for review.
    await publishEvent('escalation_received', `task_routing: no target_executor for ${workItemId}`, agent.agentId, workItemId, {
      reason: 'no_target_executor',
      target_executor: null,
      source_signal_id: eventData.source_signal_id || null,
      work_item_id: workItemId,
    }).catch(() => {});
    return { success: true, reason: 'task_routing: no target_executor specified' };
  }

  // Only assign to agents the orchestrator actually knows about. The DB
  // assignment trigger still enforces grants — this is a fast, friendly guard.
  if (!Object.keys(agentsConfig.agents).includes(targetExecutor)) {
    console.warn(`[orchestrator] task_routing for ${workItemId}: unknown target_executor "${targetExecutor}" — skipping`);
    // Durable audit (P3): unknown executor is a routing failure, not a no-op.
    await publishEvent('escalation_received', `task_routing: unknown target_executor "${targetExecutor}" for ${workItemId}`, agent.agentId, workItemId, {
      reason: 'unknown_target_executor',
      target_executor: targetExecutor,
      source_signal_id: eventData.source_signal_id || null,
      work_item_id: workItemId,
    }).catch(() => {});
    return { success: true, reason: `task_routing: unknown target_executor ${targetExecutor}` };
  }

  try {
    const assigned = await assignWorkItem({
      workItemId,
      assignTo: targetExecutor,
      assignerAgentId: agent.agentId,
    });
    if (!assigned) {
      console.log(`[orchestrator] task_routing for ${workItemId}: already assigned or not found — no-op`);
      // Durable audit (P3): assignWorkItem returned null (already-assigned or
      // missing). Benign re-delivery is common, but a missing item is a dropped
      // obligation — record it so the distinction is reviewable, not silent.
      await publishEvent('escalation_received', `task_routing: ${workItemId} already assigned or missing`, agent.agentId, workItemId, {
        reason: 'assign_noop_already_assigned_or_missing',
        target_executor: targetExecutor,
        source_signal_id: eventData.source_signal_id || null,
        work_item_id: workItemId,
      }).catch(() => {});
      return { success: true, reason: 'task_routing: work item already assigned or missing' };
    }
    await publishEvent('routing_decision', `Bridge-routed signal work assigned to ${targetExecutor}`, agent.agentId, workItemId, {
      routing_method: 'bridge_intent',
      target_executor: targetExecutor,
      source_signal_id: eventData.source_signal_id || null,
    }).catch(() => {});
    console.log(`[orchestrator] task_routing → assigned ${workItemId} to ${targetExecutor}`);
    return { success: true, reason: `task_routing: assigned to ${targetExecutor}` };
  } catch (err) {
    // Never crash the loop on a routing failure (e.g. grant missing).
    console.error(`[orchestrator] task_routing for ${workItemId} → ${targetExecutor} failed: ${err.message}`);
    return { success: true, reason: `task_routing: assignment failed — ${err.message}` };
  }
}

async function handleNewEmailTask(task, context, agent) {
  console.log(`[orchestrator] Handler: workItem=${!!context.workItem}, metadata=${JSON.stringify(context.workItem?.metadata)}, email=${!!context.email}`);
  const email = context.email;
  if (!email) {
    // Orphaned work_item: the email body couldn't be loaded into context.
    // Previously this returned success:false but did NOT progress the work_item,
    // leaving it stranded in 'created' forever and the underlying message
    // with NULL processed_at / NULL archived_at. M1 stayed low because
    // hundreds of these accumulated. See STAQPRO-281.
    //
    // Now: archive the message (disposition recorded), cancel the work_item,
    // and return success so the agent loop doesn't retry forever.
    console.warn(`[orchestrator] ORPHAN: no email in context for ${task.work_item_id} — archiving + cancelling`);
    try {
      await query(
        `UPDATE inbox.messages
         SET archived_at = COALESCE(archived_at, now()),
             triage_category = COALESCE(triage_category, 'orphaned')
         WHERE work_item_id = $1`,
        [task.work_item_id]
      );
    } catch (err) {
      console.error(`[orchestrator] Failed to archive orphaned message for ${task.work_item_id}:`, err.message);
    }
    try {
      await transitionState({
        workItemId: task.work_item_id,
        toState: 'cancelled',
        agentId: agent.agentId,
        configHash: agent.configHash,
        reason: 'Orphaned: no email in context (STAQPRO-281)',
      });
    } catch (err) {
      console.error(`[orchestrator] Failed to cancel orphaned work_item ${task.work_item_id}:`, err.message);
    }
    return { success: true, reason: 'Orphaned: archived message and cancelled work_item' };
  }

  // Route through executor-intake (deterministic + LLM classification) if enabled,
  // otherwise fall back to executor-triage directly. Intake sits above triage:
  // it short-circuits known patterns at zero LLM cost and classifies the rest.
  // Fallback: if intake assignment fails (e.g., missing assignment rule), retry with executor-triage.
  const intakeEnabled = agentsConfig?.agents?.['executor-intake']?.enabled;
  let assignTo = intakeEnabled ? 'executor-intake' : 'executor-triage';

  // Propagate account_id from parent work item through the pipeline
  // Inherit pre-triage priority from parent work item so triage claims respect priority ordering
  const inheritedPriority = context.workItem?.metadata?.pre_triage_priority ?? context.workItem?.priority ?? 1;

  let triageTask;
  try {
    triageTask = await createWorkItem({
      type: 'subtask',
      title: `Triage: ${email.subject || '(no subject)'}`,
      description: `Classify email from ${email.from_address} and extract signals`,
      createdBy: agent.agentId,
      parentId: task.work_item_id,
      assignedTo: assignTo,
      priority: inheritedPriority,
      routingClass: 'LIGHTWEIGHT',
      metadata: { email_id: email.id, provider_msg_id: email.provider_msg_id },
      accountId: context.workItem?.account_id || null,
    });
  } catch (err) {
    if (assignTo === 'executor-intake' && err.message?.includes('not authorized')) {
      console.warn(`[orchestrator] Intake assignment failed (${err.message}) — falling back to executor-triage`);
      assignTo = 'executor-triage';
      triageTask = await createWorkItem({
        type: 'subtask',
        title: `Triage: ${email.subject || '(no subject)'}`,
        description: `Classify email from ${email.from_address} and extract signals`,
        createdBy: agent.agentId,
        parentId: task.work_item_id,
        assignedTo: assignTo,
        priority: inheritedPriority,
        routingClass: 'LIGHTWEIGHT',
        metadata: { email_id: email.id, provider_msg_id: email.provider_msg_id },
        accountId: context.workItem?.account_id || null,
      });
    } else {
      throw err;
    }
  }

  console.log(`[orchestrator] → Created triage task ${triageTask.id} for "${truncateSubject(email.subject)}" → ${assignTo}`);

  return {
    success: true,
    reason: `Created triage task ${triageTask.id} for email from ${email.from_address}`,
    costUsd: 0,
  };
}

/**
 * Handle state_changed events — LLM-powered routing for ALL agent completions.
 * Every agent completion flows through one Haiku routing call. Executors set metadata,
 * orchestrator reads it and decides the next hop.
 */
async function handleStateChanged(task, context, agent) {
  const eventData = task.event_data || {};

  // Only process completions — ignore in-progress, blocked, etc.
  if (eventData.to_state !== 'completed') {
    // Failed tasks are terminal — visible in dashboard for manual review, no LLM call needed
    if (eventData.to_state === 'failed') {
      return { success: true, reason: 'Failed task — terminal (manual review via dashboard)' };
    }
    return { success: true, reason: 'Non-completion state change, no routing needed' };
  }

  // Load the completed work item (include account_id for propagation)
  const workItemResult = await query(
    `SELECT id, metadata, parent_id, title, assigned_to, status, account_id
     FROM agent_graph.work_items WHERE id = $1`,
    [eventData.work_item_id || task.work_item_id]
  );
  const completedItem = workItemResult.rows[0];
  if (!completedItem) {
    return { success: true, reason: 'Work item not found for routing' };
  }

  const completingAgent = completedItem.assigned_to;

  // --- Verification spine (flag-gated, orchestrator-mediated child tree) ---
  // Intercept BEFORE the terminal-agent check below: a verify-eligible executor
  // (incl. executor-coder, which is otherwise terminal) routes to the tester,
  // and a tester completion routes a fix back to the implementer. No-op when the
  // VERIFICATION_SPINE_ENABLED flag is off.
  if (isVerificationSpineEnabled()) {
    const vplan = planVerificationRouting({ completedItem, completingAgent });
    if (vplan.action === 'verify' || vplan.action === 'refix') {
      const tgtRes = await query(
        `SELECT id, title, parent_id, account_id, metadata FROM agent_graph.work_items WHERE id = $1`,
        [vplan.targetId]
      );
      const tgt = tgtRes.rows[0];
      if (tgt) {
        const isFix = vplan.action === 'refix';
        await createWorkItem({
          type: 'subtask',
          title: `${isFix ? 'fix' : 'verify'}: ${tgt.title}`.slice(0, 200),
          description: isFix
            ? `Verification failed — fix required. ${vplan.failureMode || ''}`.slice(0, 500)
            : 'Verify completed work against acceptance scenarios (incl. withheld).',
          createdBy: agent.agentId,
          parentId: tgt.parent_id || tgt.id,
          assignedTo: isFix ? vplan.implementer : 'tester',
          priority: isFix ? 88 : 85,
          metadata: isFix
            ? {
                is_verification_fix: true,
                verify_target_id: vplan.targetId,
                verify_implementer: vplan.implementer,
                last_failure_mode: vplan.failureMode,
                worktree_path: tgt.metadata?.worktree_path || null,
              }
            : {
                verify_target_id: vplan.targetId,
                verify_implementer: vplan.implementer,
                worktree_path: tgt.metadata?.worktree_path || null,
              },
          accountId: tgt.account_id || null,
        });
        await publishEvent('routing_decision', vplan.reason, agent.agentId, completedItem.id, {
          routing_method: 'verification_spine', action: vplan.action, target: vplan.targetId,
        }).catch(() => {});
        return { success: true, reason: vplan.reason, costUsd: 0 };
      }
    } else if (vplan.action === 'terminal') {
      return { success: true, reason: vplan.reason, costUsd: 0 };
    }
    // action 'none' → fall through to normal routing.
  }

  // Terminal agents — no downstream routing needed
  if (['reviewer', 'executor-coder'].includes(completingAgent)) {
    // Notify board via Telegram when reviewer completes (draft ready for approval)
    if (completingAgent === 'reviewer' && completedItem.metadata?.draft_id) {
      const emailSubject = completedItem.metadata?.email_subject || completedItem.title || 'Unknown';
      const verdict = completedItem.metadata?.reviewer_verdict || 'reviewed';
      import('../telegram/sender.js').then(({ notifyBoard }) =>
        notifyBoard(`📧 Draft ready: "${emailSubject.slice(0, 60)}" — ${verdict}. Review at board.staqs.io/drafts`)
      ).catch(() => {});
    }
    return { success: true, reason: `Terminal agent ${completingAgent} completed, no routing needed` };
  }

  // Walk up to root task for parentId
  const parentId = completedItem.parent_id || completedItem.id;

  // Load email context
  const emailId = completedItem.metadata?.email_id;
  let email = null;
  if (emailId) {
    const emailResult = await query(`SELECT * FROM inbox.messages WHERE id = $1`, [emailId]);
    email = emailResult.rows[0];
  }

  // Load pipeline history (sibling work items under same parent)
  const siblingsResult = await query(
    `SELECT id, assigned_to, status, title, metadata
     FROM agent_graph.work_items
     WHERE parent_id = $1 AND id != $2
     ORDER BY created_at`,
    [parentId, completedItem.id]
  );
  const siblings = siblingsResult.rows;

  // Load parent metadata
  let parent = null;
  if (completedItem.parent_id) {
    const parentResult = await query(
      `SELECT id, metadata, title FROM agent_graph.work_items WHERE id = $1`,
      [completedItem.parent_id]
    );
    parent = parentResult.rows[0];
  }

  // Receptionist Pattern: try deterministic routing first (saves LLM call)
  const deterministicRoute = await tryDeterministicRoute(completedItem, completingAgent, parent, email);
  if (deterministicRoute) {
    const routes = deterministicRoute.routes || [];
    let created = 0;
    const validAgents = Object.keys(agentsConfig.agents);

    // Dedup: skip routes to agents that already have an active sibling task under the same parent
    // Exclude terminal states (cancelled, failed, timed_out) — those agents didn't complete their work
    const activeSiblings = siblings.filter(s => !['cancelled', 'failed', 'timed_out'].includes(s.status));
    const siblingAgents = new Set(activeSiblings.map(s => s.assigned_to));

    for (const route of routes) {
      if (!route.agent || !validAgents.includes(route.agent)) continue;
      if (siblingAgents.has(route.agent)) {
        console.log(`[orchestrator] DEDUP: skipping ${route.agent} — sibling already exists under parent ${parentId}`);
        continue;
      }

      const metadata = buildMetadataForAgent(route.agent, completedItem, parent, email);
      const subject = email?.subject || completedItem.title || '(no subject)';
      const routingClass = ROUTING_CLASS_MAP[route.agent] || null;

      await createWorkItem({
        type: 'subtask',
        title: `${route.agent}: ${subject}`.slice(0, 200),
        description: route.reason || `Deterministic routing from ${completingAgent}`,
        createdBy: agent.agentId,
        parentId,
        assignedTo: route.agent,
        priority: route.priority ?? 1,
        routingClass,
        metadata,
        accountId: completedItem.account_id || null,
      });
      created++;
      console.log(`[orchestrator] DETERMINISTIC → ${route.agent} (${deterministicRoute.reasoning})`);
    }

    // Publish routing event for audit trail (P3)
    await publishEvent('routing_decision', deterministicRoute.reasoning, agent.agentId, completedItem.id, {
      routing_method: 'deterministic',
      from_agent: completingAgent,
      routes: routes.map(r => r.agent),
      terminal: deterministicRoute.terminal,
    }).catch(() => {});

    if (deterministicRoute.terminal || created === 0) {
      // L1 autonomy: auto-archive noise/FYI (side effect in caller, not in routing function)
      if (deterministicRoute.archive && email?.id) {
        await query(`UPDATE inbox.messages SET archived_at = now() WHERE id = $1 AND archived_at IS NULL`, [email.id])
          .then(() => console.log(`[orchestrator] Auto-archived ${email.id} (${deterministicRoute.reasoning})`))
          .catch(err => console.error(`[orchestrator] Auto-archive failed for ${email.id}:`, err.message));
      }
      // STAQPRO-354: deterministic routing produced 0 spawns despite a
      // non-terminal route list — usually DEDUP killed every candidate.
      // If the upstream category was a draft-requiring one, flag loudly.
      if (!deterministicRoute.terminal && created === 0) {
        const { category, confidence } = extractUpstreamTriage(completedItem.metadata);
        const wantedResponder = (deterministicRoute.routes || []).some(r => r.agent === 'executor-responder' || r.agent === 'strategist');
        if (wantedResponder && ROUTABLE_CATEGORIES.has(category)) {
          await flagUnroutedActionRequired({
            workItemId: completedItem.id,
            completingAgent,
            category,
            confidence,
            reason: `Deterministic route to ${(deterministicRoute.routes || []).map(r => r.agent).join(',')} but all were deduped — no draft will be attempted`,
            agentId: agent.agentId,
          });
        }
      }
      return { success: true, reason: deterministicRoute.reasoning, costUsd: 0 };
    }
    return { success: true, reason: `Deterministic: routed ${created} task(s) from ${completingAgent}`, costUsd: 0 };
  }

  // Call LLM for routing decision (fallback — no deterministic match)
  let routingDecision;
  console.log(`[orchestrator] LLM routing fallback for ${completingAgent} (no deterministic match)`);
  try {
    // Load live topology for dynamic routing (Step 5)
    let topologyBlock = '';
    try {
      const { loadSystemTopology } = await import('../../lib/runtime/context-loader.js');
      const topology = await loadSystemTopology(agent.agentId);
      if (topology.successRates?.length > 0) {
        topologyBlock = '\n\nROUTING SUCCESS RATES (last 7d):\n' +
          topology.successRates.map(r => `  ${r.assigned_to}: ${r.success_pct}% (${r.completed}/${r.total})`).join('\n');
      }
    } catch { /* topology unavailable — route without it */ }

    // P2: Neo4j data is advisory only — never use for enforcement decisions
    // Task-specific context (per-task) > generic reflection context (per-cycle)
    try {
      const { getTaskRelevantContext, formatTaskContext } = await import('../../lib/graph/queries.js');
      const taskCtx = await getTaskRelevantContext(agent.agentId, 'routing', completedItem?.metadata);
      const learningBlock = formatTaskContext(taskCtx, 'sonnet') || agent._reflectionContext?.learningContext;
      if (learningBlock) topologyBlock += '\n\n' + learningBlock;
    } catch {
      if (agent._reflectionContext?.learningContext) {
        topologyBlock += '\n\n' + agent._reflectionContext.learningContext;
      }
    }

    const response = await agent.callLLM(
      ROUTING_SYSTEM_PROMPT,
      buildRoutingPrompt(completedItem, completingAgent, parent, email, siblings) + topologyBlock,
      { taskId: task.work_item_id, maxTokens: 1024, temperature: 0.1 }
    );

    // Parse JSON response
    const jsonMatch = response.text.match(/\{[\s\S]*\}/);
    routingDecision = jsonMatch ? JSON.parse(jsonMatch[0]) : null;

    if (!routingDecision?.routes && !routingDecision?.terminal) {
      console.warn(`[orchestrator] LLM routing returned unparseable response, treating as terminal`);
      // STAQPRO-354: parse failure used to silently terminate. Flag if
      // upstream was a category that demands a downstream draft.
      {
        const { category, confidence } = extractUpstreamTriage(completedItem.metadata);
        if (ROUTABLE_CATEGORIES.has(category)) {
          await flagUnroutedActionRequired({
            workItemId: completedItem.id,
            completingAgent,
            category,
            confidence,
            reason: 'LLM routing returned unparseable response — no draft attempted',
            agentId: agent.agentId,
          });
        }
      }
      return { success: true, reason: 'LLM routing parse failed — terminal (fail-safe)', costUsd: response.costUsd };
    }

    // Process routes
    const routes = routingDecision.routes || [];
    let created = 0;
    const failedRoutes = [];
    const validAgents = Object.keys(agentsConfig.agents);

    for (const route of routes) {
      if (!route.agent || !validAgents.includes(route.agent)) {
        console.warn(`[orchestrator] LLM suggested unknown agent "${route.agent}", skipping`);
        continue;
      }

      const metadata = buildMetadataForAgent(route.agent, completedItem, parent, email);
      const subject = email?.subject || completedItem.title || '(no subject)';
      const routingClass = ROUTING_CLASS_MAP[route.agent] || null;

      // STAQPRO-354: wrap individual createWorkItem so one spawn failure
      // doesn't kill the whole batch silently via the outer catch.
      try {
        await createWorkItem({
          type: 'subtask',
          title: `${route.agent}: ${subject}`.slice(0, 200),
          description: route.reason || `Routed by orchestrator LLM from ${completingAgent}`,
          createdBy: agent.agentId,
          parentId,
          assignedTo: route.agent,
          priority: route.priority ?? 1,
          routingClass,
          metadata,
          accountId: completedItem.account_id || null,
        });
        created++;
        console.log(`[orchestrator] LLM routed → ${route.agent} (from ${completingAgent}: ${route.reason || 'no reason'})`);
      } catch (err) {
        console.error(`[orchestrator] createWorkItem failed for ${route.agent}: ${err.message}`);
        failedRoutes.push({ agent: route.agent, error: err.message });
      }
    }

    const costUsd = response.costUsd || 0;
    if (routingDecision.terminal || created === 0) {
      // STAQPRO-354: terminal-or-zero-created path used to silently terminate
      // even when upstream demanded a draft. Flag if so.
      const { category, confidence } = extractUpstreamTriage(completedItem.metadata);
      if (ROUTABLE_CATEGORIES.has(category) && created === 0) {
        await flagUnroutedActionRequired({
          workItemId: completedItem.id,
          completingAgent,
          category,
          confidence,
          reason: routingDecision.terminal
            ? `LLM declared terminal for ${category} upstream (reasoning: ${routingDecision.reasoning || 'none'})`
            : `LLM proposed routes but all spawns failed/invalid: ${JSON.stringify(failedRoutes)}`,
          agentId: agent.agentId,
        });
      }
      return { success: true, reason: `Terminal: ${routingDecision.reasoning || 'no downstream'}`, costUsd };
    }

    return { success: true, reason: `LLM routed ${created} task(s) from ${completingAgent}`, costUsd };
  } catch (err) {
    // Fail-safe: LLM failure → terminal. Visible in dashboard for manual routing.
    console.error(`[orchestrator] LLM routing failed: ${err.message}`);
    // STAQPRO-354: top-level catch used to swallow the failure silently.
    {
      const { category, confidence } = extractUpstreamTriage(completedItem.metadata);
      if (ROUTABLE_CATEGORIES.has(category)) {
        await flagUnroutedActionRequired({
          workItemId: completedItem.id,
          completingAgent,
          category,
          confidence,
          reason: `LLM routing threw: ${err.message}`,
          agentId: agent.agentId,
        }).catch(() => {});
      }
    }
    return { success: true, reason: `LLM routing error (fail-safe terminal): ${err.message}` };
  }
}

// --- Routing constants, LLM prompt, and metadata construction ---

const ROUTING_CLASS_MAP = {
  'executor-triage': 'LIGHTWEIGHT',
  'strategist': 'FULL',
  'executor-responder': 'FULL',
  'reviewer': 'FULL',
  'executor-ticket': 'LIGHTWEIGHT',
  'executor-coder': 'FULL',
};

// STAQPRO-354: categories that REQUIRE a downstream draft attempt (executor-
// responder) or strategist. If handleStateChanged exits without spawning either
// for one of these, that's a silent drop — the email triaged as needing a
// reply, then the system threw the work away. flagUnroutedActionRequired makes
// these visible in logs, in the work_item metadata (board can surface), and as
// a routing_skipped audit event.
const ROUTABLE_CATEGORIES = new Set(['action_required', 'needs_response']);

/**
 * Extract triage category + confidence from a completed upstream work_item's
 * metadata. Returns nulls when the upstream wasn't a triage agent or the
 * metadata is missing. Pure — same input, same output, no DB calls.
 */
export function extractUpstreamTriage(metadata) {
  const meta = metadata || {};
  const triage = meta.triage_result;
  const intake = meta.intake_classification;
  if (triage && triage.category) {
    return {
      category: triage.category,
      confidence: typeof triage.quick_score === 'number' ? triage.quick_score : null,
      source: 'triage_result',
    };
  }
  if (intake) {
    return {
      category: null, // intake doesn't expose category directly here — leave to downstream mapping
      confidence: typeof intake.confidence === 'number' ? intake.confidence : null,
      source: 'intake_classification',
    };
  }
  return { category: null, confidence: null, source: null };
}

/**
 * Emit a loud, structured signal that an action_required / needs_response
 * upstream completed without spawning a draft attempt. Three side effects so
 * the skip is impossible to miss:
 *   1. console.warn — surfaces in Railway logs
 *   2. work_items.metadata.routing_skipped — surfaces on board.staqs.io
 *   3. publishEvent('routing_skipped') — audit trail (P3)
 *
 * Best-effort: all three are wrapped so flagging itself cannot throw.
 */
export async function flagUnroutedActionRequired({
  workItemId, completingAgent, category, confidence, reason, agentId,
}) {
  const conf = confidence == null ? 'null' : Number(confidence).toFixed(2);
  console.warn(
    `[orchestrator] UNROUTED ${category}: workItem=${workItemId} from=${completingAgent} conf=${conf} reason=${reason}`
  );
  try {
    await query(
      `UPDATE agent_graph.work_items
          SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                'routing_skipped', jsonb_build_object(
                  'category', $2::text,
                  'confidence', $3::numeric,
                  'completing_agent', $4::text,
                  'reason', $5::text,
                  'flagged_at', now()
                )
              )
        WHERE id = $1`,
      [workItemId, category, confidence, completingAgent, reason]
    );
  } catch (err) {
    console.error(`[orchestrator] flagUnroutedActionRequired: metadata update failed for ${workItemId}: ${err.message}`);
  }
  try {
    await publishEvent('routing_skipped', reason, agentId, workItemId, {
      category, confidence, completing_agent: completingAgent,
    });
  } catch (err) {
    console.error(`[orchestrator] flagUnroutedActionRequired: publishEvent failed for ${workItemId}: ${err.message}`);
  }
}

const ROUTING_SYSTEM_PROMPT = `You are the Orchestrator routing engine for Optimus, an AI-staffed organization.
Your ONLY job is to decide which agent(s) should handle the next step after an agent completes work.
You receive a completed work item with its metadata and must return a JSON routing decision.

AVAILABLE AGENTS:
- executor-triage: Classifies emails (action_required, needs_response, fyi, noise). Extracts signals. First step for all new emails.
- strategist: Priority scoring and response strategy for complex/high-priority emails. Opus-tier. Skip for simple emails.
- executor-responder: Drafts replies in the user's voice using voice profiles. Handles both email replies and feedback receipts.
- reviewer: Gate checks on drafts (G2 commitment scan, G3 tone match, G5 reversibility, G7 precedent). Terminal — sends to board for approval.
- executor-ticket: Structures client feedback into Linear + GitHub issues. For bug reports and feature requests.
- executor-coder: Generates code fixes from tickets, creates PRs via Git Trees API. Terminal — creates PR for review.

PIPELINE PATTERNS:
1. Standard email response:
   executor-triage → strategist (if needs_strategist=true) → executor-responder → reviewer
   executor-triage → executor-responder (if needs_strategist=false, category is action_required/needs_response) → reviewer
2. FYI/noise email: executor-triage → terminal (no response needed)
3. Feedback pipeline: executor-triage (pipeline=feedback) → executor-ticket → executor-coder (if bug/feature_request) + executor-responder (feedback receipt)
4. Project change pipeline: executor-triage (pipeline=project_change, has target_project)
   → executor-ticket (creates issue in the project's repo)
   → executor-coder (makes the code change, creates PR)
   + executor-responder (sends confirmation to client)

ROUTING RULES:
- After executor-triage: if triage_result.pipeline="project_change", route to executor-ticket. The sender has an associated project and is requesting a code/content change. Strategist step can be skipped for straightforward content updates.
- After executor-triage: check triage_result.category and metadata to determine next step
- After strategist: if response_needed=true, route to executor-responder
- After executor-responder: if needs_review=true and draft_id present, route to reviewer
- After executor-ticket: if ticket_result.category is bug/feature_request, route to executor-coder. If has_valid_reply_address, also route to executor-responder with reply_type=feedback_receipt
- After reviewer or executor-coder: ALWAYS terminal (never route further)
- After failed tasks: terminal (log for manual review, do not retry)
- NEVER create circular routes
- Multiple routes (parallel) are allowed (e.g., executor-ticket completion can spawn both executor-coder and executor-responder)

Respond with JSON ONLY — no markdown, no explanation outside JSON:
{
  "routes": [
    { "agent": "<agent-id>", "reason": "<1 sentence why>", "priority": <0-3, lower=higher priority> }
  ],
  "terminal": <true if no downstream agents needed>,
  "reasoning": "<1 sentence summary of routing decision>"
}`;

function buildRoutingPrompt(completedItem, completingAgent, parent, email, siblings) {
  const meta = completedItem.metadata || {};
  const parts = [
    `COMPLETED WORK ITEM:`,
    `  Agent: ${completingAgent}`,
    `  Status: ${completedItem.status}`,
    `  Title: ${completedItem.title}`,
  ];

  // Include key metadata fields based on completing agent
  if (meta.triage_result) {
    const t = meta.triage_result;
    parts.push(`  Triage Result: category=${t.category}, needs_strategist=${t.needs_strategist}, quick_score=${t.quick_score}`);
    if (t.sender_register) parts.push(`  Sender Register: ${t.sender_register.register}`);
    if (t.pipeline) parts.push(`  Pipeline: ${t.pipeline}`);
    if (t.target_project) parts.push(`  Target Project: ${t.target_project}`);
    if (t.sender_projects) {
      parts.push(`  Sender Projects: ${t.sender_projects.map(p => `${p.name} (${p.platform}: ${p.locator})`).join(', ')}`);
    }
  }
  if (meta.strategy_result) {
    const s = meta.strategy_result;
    parts.push(`  Strategy Result: urgency=${s.urgency}, priorityScore=${s.priorityScore}, recommendation=${s.recommendation}`);
    parts.push(`  Response Needed: ${meta.response_needed}`);
  }
  if (meta.draft_id) {
    parts.push(`  Draft ID: ${meta.draft_id}`);
    parts.push(`  Needs Review: ${meta.needs_review}`);
  }
  if (meta.ticket_result) {
    const t = meta.ticket_result;
    parts.push(`  Ticket Result: category=${t.category}, severity=${t.severity}, proposal_id=${t.proposal_id}`);
    parts.push(`  Has Valid Reply Address: ${t.has_valid_reply_address}`);
    parts.push(`  Target Repo: ${t.target_repo}`);
  }
  if (meta.pipeline) parts.push(`  Pipeline: ${meta.pipeline}`);
  if (meta.webhook_source) parts.push(`  Webhook Source: ${meta.webhook_source}`);

  // Parent context
  if (email) {
    parts.push('', 'EMAIL CONTEXT:');
    parts.push(`  From: ${email.from_address}`);
    parts.push(`  Subject: ${email.subject || '(no subject)'}`);
    if (email.triage_category) parts.push(`  Triage Category: ${email.triage_category}`);
  }

  if (parent?.metadata) {
    parts.push('', 'PARENT TASK METADATA:');
    if (parent.metadata.email_id) parts.push(`  Email ID: ${parent.metadata.email_id}`);
    if (parent.metadata.pipeline) parts.push(`  Pipeline: ${parent.metadata.pipeline}`);
  }

  // Pipeline history
  if (siblings.length > 0) {
    parts.push('', 'PIPELINE HISTORY (sibling tasks):');
    for (const s of siblings) {
      parts.push(`  - ${s.assigned_to}: ${s.status} (${s.title})`);
    }
  }

  return parts.join('\n');
}

/**
 * Deterministic metadata construction per target agent.
 * LLM decides WHO. This function decides WHAT TO PASS.
 */
function buildMetadataForAgent(targetAgent, completedItem, parent, email) {
  const meta = completedItem.metadata || {};
  const emailId = meta.email_id || parent?.metadata?.email_id;

  switch (targetAgent) {
    case 'executor-triage':
      return {
        email_id: emailId,
        provider_msg_id: meta.provider_msg_id || parent?.metadata?.provider_msg_id,
      };

    case 'strategist':
      return {
        email_id: emailId,
        quick_score: meta.triage_result?.quick_score,
        sender_register: meta.triage_result?.sender_register || null,
      };

    case 'executor-responder': {
      const base = { email_id: emailId };
      // From strategist completion → pass strategy result
      if (meta.strategy_result) {
        base.strategy = meta.strategy_result;
        // sender_register is a top-level field on the strategist work item
        // (set by orchestrator when routing TO strategist from triage)
        base.sender_register = meta.sender_register || null;
      // From triage (skipped strategist) → pass triage context
      } else if (meta.triage_result) {
        base.quick_score = meta.triage_result.quick_score;
        base.skipped_strategist = true;
        base.sender_register = meta.triage_result?.sender_register || null;
      // From executor-ticket → feedback receipt
      } else if (meta.ticket_result) {
        const t = meta.ticket_result;
        base.reply_type = 'feedback_receipt';
        base.pipeline = 'feedback';
        base.ticket_title = t.title;
        base.ticket_severity = t.severity;
        base.ticket_category = t.category;
        base.linear_url = t.linear_url;
        base.github_issue_url = t.github_issue_url;
        base.github_issue_number = t.github_issue_number;
        base.target_repo = t.target_repo;
        base.ticket_proposal_id = t.proposal_id;
      }
      return base;
    }

    case 'reviewer':
      return {
        email_id: emailId,
        draft_id: meta.draft_id,
        sender_register: meta.sender_register || null,
      };

    case 'executor-ticket':
      return {
        email_id: emailId,
        pipeline: meta.triage_result?.pipeline || meta.pipeline || 'feedback',
        target_project: meta.triage_result?.target_project || null,
        sender_projects: meta.triage_result?.sender_projects || null,
        webhook_source: meta.webhook_source || null,
        attachments: meta.attachments || [],
      };

    case 'executor-coder': {
      const t = meta.ticket_result || {};
      return {
        ticket_proposal_id: t.proposal_id,
        email_id: emailId,
        pipeline: 'feedback',
        severity: t.severity,
        target_repo: t.target_repo,
      };
    }

    default:
      return { email_id: emailId };
  }
}

/**
 * Gmail polling loop. Runs independently of the agent event loop.
 * Creates top-level tasks for each new email, which triggers the pipeline.
 */
export async function startPolling(intervalMs = 60000) {
  console.log(`[orchestrator] Starting Gmail poll (${intervalMs / 1000}s interval)`);
  let pollCount = 0;

  const poll = async () => {
    try {
      const newMessages = await pollAllAccounts();

      // Every 5th cycle (~5 min), run the reconciler safety net to catch
      // messages missed by history-based polling (thread continuations, gaps)
      pollCount++;
      if (pollCount % 5 === 0) {
        try {
          const recovered = await reconcileAllAccounts();
          if (recovered.length > 0) {
            console.log(`[orchestrator] Reconciler recovered ${recovered.length} missed message(s)`);
            newMessages.push(...recovered);
          }
        } catch (recErr) {
          console.error('[orchestrator] Reconciler error (non-fatal):', recErr.message);
        }
      }

      // Get owned email addresses from DB accounts (skip outbound mail)
      const ownedResult = await query(
        `SELECT LOWER(identifier) AS email FROM inbox.accounts WHERE channel = 'email' AND is_active = true`
      );
      const ownedEmails = new Set(ownedResult.rows.map(r => r.email));

      for (const msg of newMessages) {
        try {
          // Skip emails FROM any owned account (outbound mail, sent replies)
          if (ownedEmails.has(msg.from_address?.toLowerCase())) {
            continue;
          }

          // Check if we already have this email
          const existing = await query(
            `SELECT id FROM inbox.messages WHERE provider_msg_id = $1`,
            [msg.provider_msg_id]
          );

          if (existing.rows.length > 0) continue;

          // Insert email metadata (D1: no body stored)
          const emailResult = await query(
            `INSERT INTO inbox.messages
             (provider_msg_id, thread_id, message_id, from_address, from_name, to_addresses, cc_addresses,
              subject, snippet, received_at, labels, has_attachments, in_reply_to,
              channel, account_id, headers)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                     'email', $14, $15)
             RETURNING id`,
            [
              msg.provider_msg_id, msg.thread_id, msg.message_id,
              msg.from_address, msg.from_name,
              msg.to_addresses || [], msg.cc_addresses || [],
              msg.subject, msg.snippet,
              msg.received_at, msg.labels || [],
              msg.has_attachments || false, msg.in_reply_to,
              msg.account_id || null,
              // STAQPRO-562: persist sniff-relevant headers so the deterministic
              // header-sniff rules fire on live rows (migration 131). jsonb
              // column; pass NULL when the poller captured none.
              msg.headers && Object.keys(msg.headers).length > 0
                ? JSON.stringify(msg.headers)
                : null,
            ]
          );

          if (!emailResult.rows[0]) {
            console.error(`[orchestrator] INSERT returned no rows for provider_msg_id=${msg.provider_msg_id}`);
            continue;
          }
          const emailId = emailResult.rows[0].id;

          // Pre-triage priority scoring (zero LLM cost, metadata-only)
          const priority = await computePreTriagePriority(msg);

          // Create top-level task in the work graph
          // Propagate account_id from the email so the entire pipeline inherits provenance
          const workItem = await createWorkItem({
            type: 'task',
            title: `Process: ${msg.subject || '(no subject)'}`,
            description: `Email from ${msg.from_address}`,
            createdBy: 'orchestrator',
            assignedTo: 'orchestrator',
            priority,
            metadata: { email_id: emailId, provider_msg_id: msg.provider_msg_id, pre_triage_priority: priority },
            accountId: msg.account_id || null,
          });

          if (!workItem) {
            console.error(`[orchestrator] createWorkItem returned null for email ${emailId}`);
            continue;
          }

          // Update email with work item link
          await query(
            `UPDATE inbox.messages SET work_item_id = $1 WHERE id = $2`,
            [workItem.id, emailId]
          );

          // Emit email.received signal for the Flow Engine (no-op if unwired)
          try {
            await emitAdapterSignal('email.received', {
              email_id: emailId,
              work_item_id: workItem.id,
              provider_msg_id: msg.provider_msg_id,
              thread_id: msg.thread_id,
              account_id: msg.account_id || null,
              from: msg.from_address,
              from_name: msg.from_name || null,
              to_addresses: msg.to_addresses || [],
              subject: msg.subject || null,
              snippet: msg.snippet || null,
              received_at: msg.received_at,
              has_attachments: !!msg.has_attachments,
            }, 'gmail');
          } catch (sigErr) {
            console.warn(`[orchestrator] email.received signal emit failed: ${sigErr.message}`);
          }

          console.log(`[orchestrator] New email: "${truncateSubject(msg.subject)}" from ${redactEmail(msg.from_address)} → task ${workItem.id}`);

          // Auto-ingest into knowledge base + wiki compile queue (non-blocking)
          if (AUTO_INGEST_EMAIL) {
            (async () => {
              try {
                const body = await fetchEmailBody(msg.provider_msg_id, msg.account_id);
                const text = body || msg.snippet || '';
                if (!text.trim()) return;
                const rawText = [
                  `Subject: ${msg.subject || '(no subject)'}`,
                  `From: ${msg.from_address || 'Unknown'}`,
                  `To: ${(msg.to_addresses || []).join(', ')}`,
                  `Date: ${msg.received_at || ''}`,
                  '',
                  text.slice(0, EMAIL_INGEST_MAX_LENGTH),
                ].join('\n');
                const docResult = await ingestDocument({
                  source: 'email',
                  sourceId: msg.provider_msg_id,
                  title: msg.subject || '(no subject)',
                  rawText,
                  format: 'plain',
                  metadata: {
                    threadId: msg.thread_id,
                    from: msg.from_address,
                    account: msg.account_id,
                    direction: 'inbound',
                  },
                  ownerId: null,
                });
                if (docResult?.documentId) {
                  await query(
                    `UPDATE content.documents SET compile_status = 'pending' WHERE id = $1`,
                    [docResult.documentId]
                  );
                  console.log(`[orchestrator] Auto-ingested email "${truncateSubject(msg.subject)}" → doc ${docResult.documentId} (pending wiki compile)`);
                }
              } catch (ingestErr) {
                console.warn(`[orchestrator] Email KB ingest failed for ${msg.provider_msg_id}: ${ingestErr.message}`);
              }
            })();
          }
        } catch (msgErr) {
          console.error(`[orchestrator] Failed to process email (${msg.provider_msg_id}):`, msgErr.message);
        }
      }
    } catch (err) {
      console.error('[orchestrator] Poll error:', err.message);
    }
  };

  // Initial poll
  await poll();

  // Recurring poll
  return setInterval(poll, intervalMs);
}

// Reflection method: orchestrator reviews routing success patterns
handler.reflect = async function(agent, outcome) {
  try {
    const { loadReflectionContext } = await import('../../lib/runtime/context-loader.js');
    const reflectionCtx = await loadReflectionContext(agent.agentId);

    const rates = reflectionCtx.recentOutcomes?.reduce((acc, o) => {
      const key = o.metadata?.assigned_agent || 'unknown';
      if (!acc[key]) acc[key] = { total: 0, completed: 0 };
      acc[key].total++;
      if (o.status === 'completed') acc[key].completed++;
      return acc;
    }, {}) || {};

    const summary = Object.entries(rates)
      .map(([a, stats]) => `${a}: ${Math.round(100 * stats.completed / stats.total)}%`)
      .join(', ');
    if (summary) console.log(`[orchestrator] reflect(): routing success — ${summary}`);

    // Publish insight if any agent's routing success rate drops below 70%
    for (const [agentKey, stats] of Object.entries(rates)) {
      if (stats.total >= 5) {
        const successPct = Math.round(100 * stats.completed / stats.total);
        if (successPct < 70) {
          await publishEvent('agent_insight',
            `Routing success rate for ${agentKey} dropped to ${successPct}% (${stats.completed}/${stats.total} completed) — may need routing adjustment`,
            agent.agentId, outcome?.workItemId || null,
            { insight_type: 'routing_success_decline', target_agent: agentKey, success_pct: successPct, completed: stats.completed, total: stats.total }
          );
        }
      }
    }

    // Store reflection context with multi-hop delegation effectiveness
    let delegationEffectiveness = null;
    try {
      const { getDelegationEffectiveness, formatLearningContext } = await import('../../lib/graph/queries.js');
      delegationEffectiveness = await getDelegationEffectiveness();
      // P2: Neo4j data is advisory only — never use for enforcement decisions
      agent._reflectionContext = {
        routingRates: rates,
        delegationEffectiveness: delegationEffectiveness?.slice(0, 5),
        learningContext: formatLearningContext({
          delegationEffectiveness,
          recentOutcomes: reflectionCtx.recentOutcomes,
        }),
      };
    } catch {
      agent._reflectionContext = { routingRates: rates };
    }
  } catch (err) {
    console.warn(`[orchestrator] reflect() error:`, err.message);
  }
};

export const orchestratorLoop = new AgentLoop('orchestrator', handler);
