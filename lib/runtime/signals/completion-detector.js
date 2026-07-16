/**
 * OPT-44: Completion-detection — auto-advance work_item status from signals.
 *
 * Polls completion signals (merged PRs linked to a work_item, Slack "done"/
 * approval messages, email replies marking an obligation closed) and maps
 * them to the next legal work_item status in the state graph:
 *
 *   created → assigned → in_progress → review → completed
 *
 * SAFETY GATE: live auto-advancement only runs when
 *   COMPLETION_DETECTION_ENABLED=true
 * is set in the environment. Default is OFF — this module is safe to deploy
 * without changing any work_item state in production.
 *
 * On each successful auto-advance the module emits a signed capability receipt
 * (ADR-007 §4) via lib/audit/capability-receipt.js.
 *
 * State transitions go EXCLUSIVELY through the existing atomic path:
 *   transitionState() → agent_graph.transition_state()  (lib/runtime/state/state-machine.js)
 * which calls guardCheck() + transition_state() in the same Postgres transaction.
 * No raw UPDATEs to agent_graph.work_items.status are ever made here.
 *
 * Signal → status mapping (analogous to lib/linear/pull-mapping.js):
 *
 *   Signal type          | Condition                        | toState
 *   ---------------------+----------------------------------+----------
 *   pr_merged            | github_pr_merged = true          | completed
 *   slack_approval       | content matches approval terms   | completed
 *   slack_done           | content matches done terms       | review
 *   email_closed         | email reply with closing phrase  | completed
 *   manual_override      | explicit next_status field       | <next_status>
 *
 * Only legal forward transitions in the state graph are attempted. Attempts to
 * advance a work_item that is already in the target state or further ahead are
 * treated as no-ops (idempotent).
 */

import { createHash } from 'crypto';
import { createChildLogger } from '../../logger.js';
import { transitionState } from '../state-machine.js';
import { signReceipt } from '../../audit/capability-receipt.js';

const log = createChildLogger({ module: 'runtime/completion-detector' });

// ── Constants ─────────────────────────────────────────────────────────────────

/** The agent identity used for auto-advance transitions. */
const DETECTOR_AGENT_ID = 'completion-detector';

/** Config hash for the detector "agent" (no real config — use a stable sentinel). */
const DETECTOR_CONFIG_HASH = createHash('sha256').update('completion-detector-v1').digest('hex');

/**
 * Legal forward-only state graph (created→assigned is handled by orchestrator;
 * detector only advances in_progress→review and review→completed here, but the
 * mapping allows any legal hop from any non-terminal state).
 *
 * Terminal states: completed, cancelled, failed (detector never initiates these
 * directly except for the completion terminal signals like pr_merged).
 */
const LEGAL_FORWARD_TRANSITIONS = {
  created:     'assigned',
  assigned:    'in_progress',
  in_progress: 'review',
  review:      'completed',
};

/** Signals that drive a work_item to `completed`. */
const COMPLETION_SIGNAL_TYPES = new Set(['pr_merged', 'slack_approval', 'email_closed']);

/** Signals that drive a work_item to `review`. */
const REVIEW_SIGNAL_TYPES = new Set(['slack_done']);

/** Slack approval keywords (case-insensitive). */
const SLACK_APPROVAL_TERMS = /\b(approved|approve|lgtm|ship it|✅|:white_check_mark:)\b/i;

/** Slack done keywords (case-insensitive). */
const SLACK_DONE_TERMS = /\b(done|finished|complete|completed|submitted|delivered|shipped)\b/i;

/** Email closing phrases. */
const EMAIL_CLOSE_TERMS = /\b(closing|resolved|done|completed|delivered|consider this done|all set)\b/i;

// ── Signal → work_item status mapping ─────────────────────────────────────────

/**
 * Pure mapper: classify a completion signal into the next work_item status.
 *
 * @param {{
 *   signal_type: string,
 *   channel: string|null,
 *   content: string|null,
 *   pr_merged: boolean|null,
 *   next_status: string|null,
 * }} signal
 * @param {string} currentStatus - current work_item.status
 * @returns {{ toState: string|null, reason: string }}
 */
export function mapSignalToNextStatus(signal, currentStatus) {
  const { signal_type, channel, content = '', pr_merged, next_status } = signal;
  const text = String(content || '').trim();

  // Terminal: already completed or cancelled — no advance
  if (currentStatus === 'completed' || currentStatus === 'cancelled') {
    return { toState: null, reason: 'already_terminal' };
  }

  // Manual override: explicit next_status field (board-set)
  if (signal_type === 'manual_override' && next_status) {
    const legal = LEGAL_FORWARD_TRANSITIONS[currentStatus];
    if (!legal) return { toState: null, reason: 'no_legal_forward_from_current' };
    // Only allow the immediate next legal step (never skip)
    if (next_status !== legal) {
      return { toState: null, reason: `manual_override_illegal_hop: ${currentStatus} → ${next_status} (expected ${legal})` };
    }
    return { toState: next_status, reason: 'manual_override' };
  }

  // PR merged → completed
  if (signal_type === 'pr_merged' && pr_merged === true) {
    return { toState: 'completed', reason: 'pr_merged' };
  }

  // Slack approval → completed
  if (signal_type === 'slack_approval' && channel === 'slack' && SLACK_APPROVAL_TERMS.test(text)) {
    return { toState: 'completed', reason: 'slack_approval' };
  }

  // Slack done → review
  if (signal_type === 'slack_done' && channel === 'slack' && SLACK_DONE_TERMS.test(text)) {
    return { toState: 'review', reason: 'slack_done' };
  }

  // Email closed → completed
  if (signal_type === 'email_closed' && channel === 'email' && EMAIL_CLOSE_TERMS.test(text)) {
    return { toState: 'completed', reason: 'email_closed' };
  }

  return { toState: null, reason: 'no_matching_signal_pattern' };
}

// ── Core advance logic ────────────────────────────────────────────────────────

/**
 * Attempt to auto-advance a single work_item based on a completion signal.
 *
 * @param {{
 *   query: Function,
 *   workItemId: string,
 *   signal: object,
 *   dryRun?: boolean,
 * }} opts
 * @returns {Promise<{
 *   outcome: 'advanced'|'noop'|'illegal'|'error'|'dry_run',
 *   workItemId: string,
 *   fromState?: string,
 *   toState?: string,
 *   reason: string,
 *   receipt?: object,
 * }>}
 */
export async function advanceWorkItem({ query, workItemId, signal, dryRun = false }) {
  // Load current work_item status
  const res = await query(
    `SELECT id, status FROM agent_graph.work_items WHERE id = $1`,
    [workItemId],
  );
  if (res.rows.length === 0) {
    return { outcome: 'noop', workItemId, reason: 'work_item_not_found' };
  }
  const currentStatus = res.rows[0].status;
  const { toState, reason } = mapSignalToNextStatus(signal, currentStatus);

  if (!toState) {
    return { outcome: 'noop', workItemId, fromState: currentStatus, reason };
  }

  // Validate the target is a legal forward hop (never skip states, never go backwards)
  const legalNext = LEGAL_FORWARD_TRANSITIONS[currentStatus];
  if (toState !== 'completed' && toState !== legalNext) {
    log.warn({ workItemId, currentStatus, toState, legalNext }, 'illegal state hop blocked');
    return {
      outcome: 'illegal',
      workItemId,
      fromState: currentStatus,
      toState,
      reason: `illegal_hop: ${currentStatus} → ${toState}`,
    };
  }

  // Completed is always legal from review; also allowed from in_progress for
  // direct-merge signals (PR merged without a review step)
  if (toState === 'completed' && currentStatus !== 'review' && currentStatus !== 'in_progress') {
    log.warn({ workItemId, currentStatus }, 'completed signal skipped: not in review/in_progress');
    return {
      outcome: 'illegal',
      workItemId,
      fromState: currentStatus,
      toState,
      reason: `completed_from_${currentStatus}_blocked`,
    };
  }

  if (dryRun) {
    log.info({ workItemId, currentStatus, toState, reason }, '[dry-run] would advance');
    return { outcome: 'dry_run', workItemId, fromState: currentStatus, toState, reason };
  }

  // Advance via the atomic transition path
  let success = false;
  try {
    success = await transitionState({
      workItemId,
      toState,
      agentId: DETECTOR_AGENT_ID,
      configHash: DETECTOR_CONFIG_HASH,
      reason: `completion-detector: ${reason}`,
      guardrailChecks: { completion_signal: signal.signal_type },
    });
  } catch (err) {
    log.error({ err: err.message, workItemId, toState }, 'transitionState threw');
    return { outcome: 'error', workItemId, fromState: currentStatus, toState, reason: err.message };
  }

  if (!success) {
    return { outcome: 'noop', workItemId, fromState: currentStatus, toState, reason: 'transition_rejected_by_guard' };
  }

  // Emit capability receipt for each auto-advance (ADR-007 §4)
  const transitionHash = `sha256:${createHash('sha256')
    .update(`${workItemId}|${currentStatus}|${toState}|${Date.now()}`)
    .digest('hex')}`;

  let receipt = null;
  try {
    receipt = signReceipt({
      receipt_version: '1',
      origin_org: process.env.OPTIMUS_ORG_ID || 'self',
      grant_id: `completion-detector:${workItemId}`,
      agent_sub: `agent:${DETECTOR_AGENT_ID}`,
      agent_tier: 'utility',
      action: 'work_item_auto_advance',
      document_ids: [workItemId],
      issued_at: new Date().toISOString(),
      transition_hash: transitionHash,
    });
    log.info({ workItemId, fromState: currentStatus, toState, reason }, 'auto-advanced + receipt issued');
  } catch (receiptErr) {
    // Receipt emission is best-effort — don't fail the advance
    log.warn({ err: receiptErr.message }, 'capability receipt signing failed (non-fatal)');
  }

  return { outcome: 'advanced', workItemId, fromState: currentStatus, toState, reason, receipt };
}

// ── Poller ────────────────────────────────────────────────────────────────────

/**
 * Process a batch of pending completion signals from the database.
 *
 * Reads inbox.completion_signals rows where processed_at IS NULL, attempts
 * to advance the linked work_item, and stamps processed_at on completion
 * (success or no-op — not on error so retries work).
 *
 * @param {{
 *   query: Function,
 *   dryRun?: boolean,
 *   batchSize?: number,
 * }} opts
 * @returns {Promise<{ processed: number, advanced: number, errors: number }>}
 */
export async function processCompletionSignals({ query, dryRun = false, batchSize = 50 }) {
  // Read unprocessed completion signals joined with their linked work_item
  const rows = await query(
    `SELECT cs.id, cs.work_item_id, cs.signal_type, cs.channel,
            cs.content, cs.pr_merged, cs.next_status,
            cs.created_at
       FROM agent_graph.completion_signals cs
       JOIN agent_graph.work_items wi ON wi.id = cs.work_item_id
      WHERE cs.processed_at IS NULL
        AND wi.status NOT IN ('completed', 'cancelled')
      ORDER BY cs.created_at ASC
      LIMIT $1`,
    [batchSize],
  );

  let processed = 0;
  let advanced = 0;
  let errors = 0;

  for (const row of rows.rows) {
    const signal = {
      signal_type: row.signal_type,
      channel: row.channel,
      content: row.content,
      pr_merged: row.pr_merged,
      next_status: row.next_status,
    };

    let result;
    try {
      result = await advanceWorkItem({ query, workItemId: row.work_item_id, signal, dryRun });
    } catch (err) {
      log.error({ err: err.message, signalId: row.id }, 'advanceWorkItem threw unexpectedly');
      errors++;
      continue;
    }

    // Stamp processed_at unless it was an error (so retries are possible)
    if (result.outcome !== 'error') {
      try {
        await query(
          `UPDATE agent_graph.completion_signals
              SET processed_at = NOW(),
                  outcome = $2,
                  outcome_reason = $3
            WHERE id = $1`,
          [row.id, result.outcome, result.reason],
        );
        processed++;
        if (result.outcome === 'advanced') advanced++;
      } catch (stampErr) {
        log.error({ err: stampErr.message, signalId: row.id }, 'failed to stamp processed_at');
        errors++;
      }
    } else {
      errors++;
    }
  }

  log.info({ processed, advanced, errors, dryRun }, 'completion-detector batch complete');
  return { processed, advanced, errors };
}

// ── Scheduler helper ──────────────────────────────────────────────────────────

/**
 * Start the completion-detection poller.
 *
 * SAFETY GATE: does nothing unless COMPLETION_DETECTION_ENABLED=true.
 * Gate is checked on every invocation (not cached) so a runtime flip can
 * disable the poller between intervals.
 *
 * @param {{
 *   query: Function,
 *   intervalMs?: number,
 *   batchSize?: number,
 * }} opts
 * @returns {{ stop: Function }}
 */
export function startCompletionDetector({ query, intervalMs = 30_000, batchSize = 50 }) {
  if (process.env.COMPLETION_DETECTION_ENABLED !== 'true') {
    log.info('completion-detector NOT started (COMPLETION_DETECTION_ENABLED != true)');
    return { stop: () => {} };
  }

  log.info({ intervalMs, batchSize }, 'completion-detector starting (COMPLETION_DETECTION_ENABLED=true)');

  const run = async () => {
    // Re-check gate on every tick so a runtime env flip takes effect
    if (process.env.COMPLETION_DETECTION_ENABLED !== 'true') {
      log.info('completion-detector paused (COMPLETION_DETECTION_ENABLED unset mid-run)');
      return;
    }
    try {
      await processCompletionSignals({ query, dryRun: false, batchSize });
    } catch (err) {
      log.error({ err: err.message }, 'completion-detector tick failed');
    }
  };

  // Stagger startup by 15s to avoid racing with agent init
  const startupTimeout = setTimeout(() => {
    run(); // first tick
    handle = setInterval(run, intervalMs);
  }, 15_000);

  let handle = null;
  return {
    stop: () => {
      clearTimeout(startupTimeout);
      if (handle) clearInterval(handle);
      log.info('completion-detector stopped');
    },
  };
}
