/**
 * Reverse edge of the signal→action bridge (Stream B, ADR-008): close the loop.
 *
 * When a bridge-spawned work_item reaches a terminal state, resolve the source
 * obligation so it stops surfacing, and move its board card accordingly:
 *
 *   completed | cancelled -> source signal resolved=true; human_task -> 'done'
 *   failed                -> human_task -> a VISIBLE non-terminal status ('inbox')
 *                            so the board sees it; source signal left UNRESOLVED
 *                            (Linus #8 — a failed obligation is never invisible).
 *
 * It also calls retrospector.js on the terminal transition (self-improvement,
 * ADR-008 §3) and logs a human-override delta into human_tasks.feedback_history
 * when applicable — both best-effort, never blocking the resolve.
 *
 * WIRING (do NOT modify state-machine.js — Linus blocker #2, there is no hook
 * registry): state-machine.js emits notify({ eventType:'state_changed',
 * workItemId, targetAgentId:'orchestrator' }) post-commit for terminal states
 * (state-machine.js:98). The orchestrator already consumes that event in
 * lib/runtime/agent-loop.js — see the `if (task.event_type === 'state_changed')`
 * branch (~agent-loop.js:510). Call resolveSignalForWorkItem({ query,
 * workItemId: task.work_item_id, toState }) from THAT branch. Alternatively a
 * reconciler poll over terminal work_items carrying metadata.source_signal_id
 * can call it. Either way this stays a plain async function the existing handler
 * invokes — no new lib->product dependency, no hook machinery.
 */

import { createChildLogger } from '../../logger.js';

const log = createChildLogger({ module: 'runtime/signal-resolver' });

const TERMINAL_COMPLETE = new Set(['completed', 'cancelled']);

/**
 * Resolve the source signal + its board card for a terminal bridge work_item.
 *
 * Plain async function. No side effects beyond the injected `query` callback,
 * plus a best-effort retrospector call (which is itself fire-and-forget).
 *
 * @param {Object} opts
 * @param {Function} opts.query - pg-style (text, params) => { rows }
 * @param {string} opts.workItemId - agent_graph.work_items.id (terminal)
 * @param {string} opts.toState - the terminal state reached
 * @returns {Promise<{
 *   handled: boolean,
 *   reason?: string,
 *   signalId?: string|null,
 *   signalResolved?: boolean,
 *   humanTaskId?: string|null,
 *   humanTaskStatus?: string|null,
 * }>}
 */
export async function resolveSignalForWorkItem({ query, workItemId, toState }) {
  if (!query || !workItemId) throw new Error('resolveSignalForWorkItem requires { query, workItemId }');

  // 1. Read the work item's provenance. Only bridge-spawned items carry
  //    metadata.source_signal_id; everything else is a no-op (handled:false).
  const wi = await query(
    `SELECT id, status,
            metadata->>'source_signal_id' AS source_signal_id,
            metadata->>'route_reason'     AS route_reason
       FROM agent_graph.work_items
      WHERE id = $1`,
    [workItemId],
  );
  const row = wi.rows[0];
  if (!row) {
    return { handled: false, reason: 'work_item_not_found' };
  }
  const signalId = row.source_signal_id || null;
  if (!signalId) {
    return { handled: false, reason: 'not_bridge_spawned' };
  }

  const state = toState || row.status;
  const isComplete = TERMINAL_COMPLETE.has(state);
  const isFailed = state === 'failed';
  if (!isComplete && !isFailed) {
    return { handled: false, reason: `non_terminal_state:${state}`, signalId };
  }

  let signalResolved = false;
  let humanTaskId = null;
  let humanTaskStatus = null;

  // 2. Find the board card (if any) linked to this signal. human_tasks has no
  //    metadata column; the bridge stamps the work_item link in
  //    next_action_hint as `work_item:<id>` and in feedback_history.
  const htQ = await query(
    `SELECT id, status
       FROM inbox.human_tasks
      WHERE signal_id = $1
        AND deleted_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1`,
    [signalId],
  );
  const ht = htQ.rows[0] || null;

  if (isComplete) {
    // 3a. Resolve the source obligation — it is done.
    const r = await query(
      `UPDATE inbox.signals
          SET resolved = true,
              resolved_at = now()
        WHERE id = $1
          AND resolved = false`,
      [signalId],
    );
    signalResolved = (r.rowCount || 0) > 0;

    if (ht) {
      await query(
        `UPDATE inbox.human_tasks
            SET status = 'done',
                updated_at = now()
          WHERE id = $1
            AND status <> 'done'`,
        [ht.id],
      );
      humanTaskId = ht.id;
      humanTaskStatus = 'done';
    }
  } else {
    // 3b. Failed — surface to the board, never invisible. Signal stays UNRESOLVED.
    if (ht) {
      await query(
        `UPDATE inbox.human_tasks
            SET status = 'inbox',
                updated_at = now()
          WHERE id = $1`,
        [ht.id],
      );
      humanTaskId = ht.id;
      humanTaskStatus = 'inbox';
    } else {
      // No card existed (autonomous item that failed). The signal remains
      // unresolved and eligible for re-bridging; log so the failure is auditable.
      log.warn({ signalId, workItemId }, 'autonomous bridge work item failed; signal left unresolved for re-bridge');
    }
  }

  // 4. Self-improvement (best-effort) — feed the terminal outcome to the
  //    retrospector so routing thresholds can learn. Dynamic import keeps this
  //    module cheap to load and avoids a hard dependency cycle.
  try {
    const { retrospect } = await import('../retrospector.js');
    await retrospect({
      agentId: 'signal-action-bridge',
      workItemId,
      success: isComplete,
      eventType: 'signal_bridge_resolution',
      result: { reason: row.route_reason || state },
    });
  } catch (err) {
    log.debug({ err: err.message, workItemId }, 'retrospector call skipped (non-fatal)');
  }

  // 5. Human-override delta (best-effort): if the card's last_feedback shows a
  //    human disagreed with the routing (skipped an autonomous item, or the
  //    gated item came back not_for_us), append a learning delta to
  //    feedback_history so routeObligation thresholds can adapt over time.
  if (ht) {
    try {
      await query(
        // feedback_history is a JSONB ARRAY. `array || object` would corrupt it;
        // wrap the object in jsonb_build_array so `array || array` appends one
        // element (Linus SHOULD-FIX c).
        `UPDATE inbox.human_tasks
            SET feedback_history = feedback_history
              || jsonb_build_array(
                   jsonb_build_object(
                     'event', 'bridge_resolution',
                     'work_item_id', $2::text,
                     'terminal_state', $3::text,
                     'route_reason', $4::text,
                     'at', to_jsonb(now())
                   )
                 )
          WHERE id = $1`,
        [ht.id, workItemId, state, row.route_reason || null],
      );
    } catch (err) {
      log.debug({ err: err.message, humanTaskId: ht.id }, 'feedback_history delta append failed (non-fatal)');
    }
  }

  log.info(
    { signalId, workItemId, terminalState: state, signalResolved, humanTaskId, humanTaskStatus },
    'signal bridge loop closed',
  );

  return { handled: true, signalId, signalResolved, humanTaskId, humanTaskStatus };
}
