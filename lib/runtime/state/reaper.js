import { query, withSystemScope } from '../../db.js';
import { transitionState } from '../state-machine.js';
import { emit } from '../event-bus.js';
import { publishEvent } from '../infrastructure.js';
import { createLogger } from '../../logger.js';
const log = createLogger('runtime/reaper');

/**
 * OPT-166 P2b — run a single query under a system scope, then release it.
 *
 * The reaper is a cross-agent recovery daemon: it reads and re-transitions work
 * items OWNED BY OTHER agents. Once the pool flips to the non-superuser
 * autobot_agent role (RLS enforced), a bare `query()` runs role-less and an
 * agent-scoped connection only sees its own rows — either way the work_items
 * SELECT/UPDATE/EXISTS/COUNT below would black-hole to 0 rows and the reaper
 * would silently recover nothing. The system scope's tenancy.is_system() branch
 * (sql/199) grants the cross-agent read+write; withSystemScope also writes the
 * durable audit-on-open row (P3), so every reaper DB burst is attributable.
 *
 * ONE scope per call (own connection + own audit row + own txn) mirrors the
 * per-op autocommit the reaper had with the pooled `query()` — a mid-sweep
 * failure leaves earlier recoveries committed, exactly as today. INERT until the
 * flip (today's superuser bypasses RLS, so the extra scope is behaviorally a
 * no-op beyond the audit row).
 *
 * Ops that touch agent_graph.work_items are routed here. The re-queue emit() is
 * ALSO scoped (see its call site): its INSERT ... RETURNING implicitly re-checks
 * the agent_read_events SELECT policy on the new row, which only is_system()
 * satisfies when the event targets another agent. Ops on un-RLS'd tables
 * (inbox.voice_memo_pending, agent_graph.budgets, agent_heartbeats) and the
 * task_events INSERT-only UPDATE (agent_update_events `USING(true)`) stay on the
 * bare pooled `query()` — scoping them would add audit noise for no isolation gain.
 */
async function sysQuery(text, params) {
  const q = await withSystemScope('reaper', { reason: 'reaper-sweep' });
  try {
    return await q(text, params);
  } finally {
    await q.release();
  }
}

/**
 * Reaper: detect and recover stuck tasks (spec §11).
 *
 * Runs periodically. Finds tasks that have been in_progress longer than
 * the timeout threshold and transitions them to timed_out.
 * The orchestrator can then retry (up to max_retries) or escalate.
 *
 * No framework. Just a setInterval and a SQL query.
 */

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
// Dead-runner detection: if an agent's LATEST heartbeat is older than this, its
// in_progress claims are reclaimed even when updated_at is still recent — a runner
// can die mid-iteration having just bumped updated_at. 2×TICK_GAP_WARN_MS (120s).
const DEFAULT_CLAIM_TTL_MS = 4 * 60 * 1000; // 4 minutes
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_INTERVAL_MS = 60 * 1000; // check every 60s
const DEFAULT_VOICE_MEMO_STRAND_MS = 10 * 60 * 1000; // 10 minutes

export class Reaper {
  constructor(opts = {}) {
    this.timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.claimTtlMs = opts.claimTtlMs || DEFAULT_CLAIM_TTL_MS;
    this.maxRetries = opts.maxRetries || DEFAULT_MAX_RETRIES;
    this.intervalMs = opts.intervalMs || DEFAULT_INTERVAL_MS;
    this.voiceMemoStrandMs = opts.voiceMemoStrandMs || DEFAULT_VOICE_MEMO_STRAND_MS;
    this.timer = null;
    // Track re-queue latencies for Phase 1 metric 8 (crash recovery < 60s)
    this.recentRequeueLatenciesMs = [];
  }

  start() {
    log.info(`Starting (timeout: ${this.timeoutMs}ms, interval: ${this.intervalMs}ms)`);
    this.timer = setInterval(() => this.sweep().catch(err => {
      log.error('Sweep error:', err.message);
    }), this.intervalMs);
    // Run immediately on start
    this.sweep().catch(err => log.error('Initial sweep error:', err.message));
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    log.info('Stopped');
  }

  async sweep() {
    // Phase 3.2: un-route events pinned to a DEAD runner so the work isn't
    // orphaned. A routed-but-unclaimed event whose target runner's latest
    // heartbeat is stale is reset to NULL → any runner can then claim it.
    // MAX(heartbeat_at) IS NULL (runner never seen) → excluded, matching the
    // dead-runner reclaim below (the orchestrator only routes to online runners).
    await query(
      `UPDATE agent_graph.task_events te
          SET target_runner_id = NULL
        WHERE te.processed_at IS NULL
          AND te.target_runner_id IS NOT NULL
          AND (SELECT max(h.heartbeat_at)
                 FROM agent_graph.agent_heartbeats h
                WHERE h.runner_id = te.target_runner_id)
              < now() - ($1 || ' milliseconds')::interval`,
      [this.claimTtlMs]
    ).catch(err => log.warn(`dead-runner un-route failed: ${err.message}`));

    // Find tasks stuck in in_progress beyond the timeout threshold.
    // All agents use the same timeout — executor-redesign writes heartbeats to
    // updated_at every 20s, so a 5-min stale threshold safely detects dead agents.
    const stuckResult = await sysQuery(
      `SELECT id, title, assigned_to, retry_count, updated_at, status
       FROM agent_graph.work_items
       WHERE (status = 'in_progress'
         AND updated_at < now() - ($1 || ' milliseconds')::interval)
         OR (status = 'assigned' AND assigned_to IS NOT NULL
             AND updated_at < now() - interval '60 minutes')
         -- Dead-runner reclaim: in_progress item whose assigned agent has a
         -- heartbeat HISTORY but its latest heartbeat is stale (runner died).
         -- MAX(heartbeat_at) IS NULL for agents that never heartbeated → excluded,
         -- so a fresh system/test does NOT mass-reclaim (those fall to the timeout).
         OR (status = 'in_progress' AND assigned_to IS NOT NULL
             AND updated_at < now() - interval '60 seconds'
             AND (SELECT max(h.heartbeat_at)
                    FROM agent_graph.agent_heartbeats h
                   WHERE h.agent_id = agent_graph.work_items.assigned_to)
                 < now() - ($2 || ' milliseconds')::interval)
       ORDER BY updated_at
       LIMIT 10`,
      [this.timeoutMs, this.claimTtlMs]
    );

    if (stuckResult.rows.length === 0) return;

    log.info(`Found ${stuckResult.rows.length} stuck task(s)`);

    for (const task of stuckResult.rows) {
      const retryCount = task.retry_count || 0;
      const stuckSinceMs = Date.now() - new Date(task.updated_at).getTime();

      // Stale-assigned tasks: never started, transition directly to cancelled
      // (assigned → timed_out is not a valid state transition)
      if (task.status === 'assigned') {
        log.info(`Task ${task.id} stuck in assigned for ${Math.round(stuckSinceMs / 1000)}s → cancelled`);
        const cancelled = await transitionState({
          workItemId: task.id,
          toState: 'cancelled',
          agentId: 'reaper',
          configHash: 'system',
          reason: `Stuck in assigned for > 60 minutes (agent never claimed)`,
          systemActor: 'reaper',
        });
        if (!cancelled) {
          log.error(`FAILED: ${task.id} transition assigned → cancelled returned false`);
        }
        continue;
      }

      if (retryCount >= this.maxRetries) {
        // Max retries exhausted — go straight to cancelled (terminal state).
        // Previously this went to 'failed', but failed is non-terminal and tasks
        // would linger indefinitely. Direct in_progress → cancelled is a valid
        // transition and ensures exhausted tasks don't show as stuck.
        log.info(`Task ${task.id} exceeded max retries (${retryCount}/${this.maxRetries}) → cancelled`);
        const cancelled = await transitionState({
          workItemId: task.id,
          toState: 'cancelled',
          agentId: 'reaper',
          configHash: 'system',
          reason: `Auto-cancelled: timed out after ${retryCount} retries (max: ${this.maxRetries})`,
          systemActor: 'reaper',
        });
        if (!cancelled) {
          log.error(`FAILED: ${task.id} transition in_progress → cancelled returned false`);
        } else {
          await publishEvent(
            'task_auto_cancelled',
            `Task "${task.title}" auto-cancelled after ${retryCount} retries`,
            'reaper',
            task.id
          );
        }
      } else {
        // Timeout — transition in_progress → timed_out → assigned (two-step recovery)
        // claim_next_task() only picks up events for work items in 'assigned' or 'created' state,
        // so we must complete the full timed_out → assigned transition before emitting the event.
        log.info(`Task ${task.id} timed out (${Math.round(stuckSinceMs / 1000)}s in in_progress, retry ${retryCount}/${this.maxRetries}) → timed_out`);
        const timedOut = await transitionState({
          workItemId: task.id,
          toState: 'timed_out',
          agentId: 'reaper',
          configHash: 'system',
          reason: `Stuck in in_progress for ${Math.round(stuckSinceMs / 1000)}s`,
          systemActor: 'reaper',
        });
        if (!timedOut) {
          log.error(`FAILED: ${task.id} transition in_progress → timed_out returned false`);
          continue;
        }

        // Transition timed_out → assigned so claim_next_task() can pick it up
        const reassigned = await transitionState({
          workItemId: task.id,
          toState: 'assigned',
          agentId: 'reaper',
          configHash: 'system',
          reason: `Reaper re-queue (retry ${retryCount + 1}/${this.maxRetries})`,
          systemActor: 'reaper',
        });
        if (!reassigned) {
          log.error(`FAILED: ${task.id} transition timed_out → assigned returned false`);
          continue;
        }

        // Both transitions succeeded — safe to increment retry count and emit event
        await sysQuery(
          `UPDATE agent_graph.work_items SET retry_count = retry_count + 1 WHERE id = $1`,
          [task.id]
        );

        // Emit re-queue event so the assigned agent picks it up again (spec §11).
        // Runs under a system scope: emit()'s INSERT ... RETURNING event_id
        // implicitly re-checks the agent_read_events SELECT policy on the new row,
        // whose target_agent_id is ANOTHER agent — only tenancy.is_system()
        // satisfies it post-flip. One scope covers the INSERT, owner-org lookup,
        // and pg_notify. INERT today (superuser bypasses RLS; the scope just adds
        // the durable audit-on-open row).
        const targetAgent = task.assigned_to || 'orchestrator';
        const emitScope = await withSystemScope('reaper', { reason: 'reaper-sweep' });
        try {
          await emit({
            eventType: 'task_assigned',
            workItemId: task.id,
            targetAgentId: targetAgent,
            priority: 0,
            eventData: { retry: retryCount + 1, reason: 'reaper_retry' },
            exec: emitScope,
          });
        } finally {
          await emitScope.release();
        }

        // Track re-queue latency (Phase 1 metric 8: crash recovery < 60s)
        this.recentRequeueLatenciesMs.push(stuckSinceMs);
        log.info(`Re-queued ${task.id}: timed_out → assigned (retry ${retryCount + 1}/${this.maxRetries}, latency ${(stuckSinceMs / 1000).toFixed(1)}s)`);
      }
    }

    // Keep only last 100 latencies to bound memory
    if (this.recentRequeueLatenciesMs.length > 100) {
      this.recentRequeueLatenciesMs = this.recentRequeueLatenciesMs.slice(-100);
    }

    // B5: Reclaim orphaned budget reservations for timed-out/failed tasks
    // Tasks that crashed after reserve_budget() but before commit/release leak reservations
    await this.reclaimOrphanedBudget();

    // Voice-memo strand recovery: detect and reset pending rows stuck at
    // status='processing' past the strand threshold. Once the transactional
    // callback ships, this should fire ~never; it's a safety net.
    await this.sweepVoiceMemos();

    // Stuck-created recovery: detect events claimed but never followed by a
    // state transition (runtime SIGKILL'd mid-claim, etc.) and re-open them.
    await this.sweepStuckCreated();

    // STAQPRO-353: orphan-created recovery — work_items in 'created' with no
    // unprocessed task_events row (event never inserted, or all instances of it
    // processed without progressing the work_item). Re-emits task_assigned so
    // claim_next_task() can see them.
    await this.sweepOrphanedCreated();
  }

  /**
   * Recover work items left in 'created' after their task_event was claimed.
   *
   * The claim path runs as one transaction: claim_next_task() sets
   * task_events.processed_at, then claimAndStart() transitions the work item
   * to in_progress. If the runtime is killed between those steps in a way
   * that lets the UPDATE commit but not the transition (rare — typically
   * Railway redeploy mid-tick), the work item gets stranded: status='created'
   * but processed_at IS NOT NULL means claim_next_task() will never re-pick
   * it. Reset processed_at so the next poll re-claims.
   *
   * The 60s threshold avoids racing with active claims: real claim+transition
   * completes in well under a second, so anything older is genuinely stuck.
   */
  async sweepStuckCreated() {
    // sysQuery: the EXISTS subquery reads agent_graph.work_items across all
    // agents, so this must run under the system scope post-flip (an agent role
    // would see no other agent's 'created' rows and the EXISTS would never match).
    const result = await sysQuery(
      `UPDATE agent_graph.task_events te
         SET processed_at = NULL
       WHERE te.processed_at IS NOT NULL
         AND te.processed_at < now() - interval '60 seconds'
         AND te.event_type = 'task_assigned'
         AND EXISTS (
           SELECT 1 FROM agent_graph.work_items wi
           WHERE wi.id = te.work_item_id
             AND wi.status = 'created'
         )
       RETURNING te.event_id, te.work_item_id, te.target_agent_id`
    );
    for (const row of result.rows) {
      log.warn(`Stuck-created recovery: reset task_event ${row.event_id} (work_item ${row.work_item_id}, target ${row.target_agent_id})`);
    }
  }

  /**
   * STAQPRO-353: recover work_items orphaned with no unprocessed task_events row.
   *
   * claim_next_task() is queue-driven — it only scans task_events. If a work_item
   * ends up in 'created' state without any unprocessed task_assigned event
   * pointing at it (event row purged, never inserted because createWorkItem was
   * called through a non-standard path, or all instances of it landed
   * processed_at=NOT NULL via Case A and were never replayed before the row was
   * cleaned up), the queue can't see it.
   *
   * sweepStuckCreated() handles Case A (processed_at IS NOT NULL).
   * This handles Case B (no unprocessed event at all): we INSERT a fresh
   * task_assigned event so the next claim picks it up. Idempotent — the
   * NOT EXISTS guard makes re-runs harmless.
   *
   * 60s age threshold avoids racing with fresh creates whose post-commit
   * notify() may not have fired yet.
   */
  async sweepOrphanedCreated() {
    // sysQuery: the INSERT ... SELECT scans agent_graph.work_items (and the
    // NOT EXISTS reads task_events) across all agents — post-flip only the system
    // scope sees other agents' orphaned 'created' rows to re-emit for them.
    const result = await sysQuery(
      `INSERT INTO agent_graph.task_events
         (event_type, work_item_id, target_agent_id, priority, event_data)
       SELECT 'task_assigned', wi.id, wi.assigned_to, wi.priority,
              jsonb_build_object('recovered_from_orphan', true, 'recovered_at', now())
         FROM agent_graph.work_items wi
        WHERE wi.status = 'created'
          AND wi.assigned_to IS NOT NULL
          AND wi.updated_at < now() - interval '60 seconds'
          AND NOT EXISTS (
            SELECT 1 FROM agent_graph.task_events te
             WHERE te.work_item_id = wi.id
               AND te.event_type = 'task_assigned'
               AND te.processed_at IS NULL
          )
       RETURNING work_item_id, target_agent_id`
    );
    if (result.rows.length === 0) return;

    // Aggregate by agent for a clean single-line log per recovery batch
    // (acceptance criterion: "orchestrator: drained N stale work_items").
    const byAgent = new Map();
    for (const row of result.rows) {
      byAgent.set(row.target_agent_id, (byAgent.get(row.target_agent_id) || 0) + 1);
    }
    for (const [agent, count] of byAgent) {
      log.warn(`Orphan-created recovery: re-emitted ${count} stale work_item(s) → ${agent}`);
    }
  }

  /**
   * Reset voice_memo_pending rows stuck at 'processing' past the strand
   * threshold back to 'pending' so the next AssemblyAI retry callback (if any)
   * can re-claim cleanly. Logs each recovery as WARN so the regression surfaces
   * in the runtime log.
   */
  async sweepVoiceMemos() {
    try {
      const result = await query(
        `UPDATE inbox.voice_memo_pending
            SET status = 'pending',
                failure_reason = COALESCE(NULLIF(failure_reason, ''), '') ||
                                 (CASE WHEN COALESCE(failure_reason, '') = '' THEN '' ELSE ' | ' END) ||
                                 'auto-recovered after ' || ($1::int / 60000) || 'm timeout'
          WHERE status = 'processing'
            AND created_at < now() - ($1 || ' milliseconds')::interval
          RETURNING id, transcript_id, tracking_id, created_at`,
        [this.voiceMemoStrandMs]
      );
      for (const row of result.rows) {
        const ageMs = Date.now() - new Date(row.created_at).getTime();
        log.warn(`Voice memo strand recovered: tracking=${row.tracking_id} transcript=${row.transcript_id} age=${Math.round(ageMs / 1000)}s`);
      }
    } catch (err) {
      // Schema may not have inbox.voice_memo_pending in some test envs (PGlite, etc).
      // Don't let strand sweep failure abort the rest of the reaper tick.
      log.error('Voice memo strand sweep failed:', err.message);
    }
  }

  /**
   * Get re-queue latency stats for Phase 1 metric 8 (crash recovery < 60s).
   * Returns { count, avg_ms, max_ms, p95_ms } or null if no data.
   */
  getRequeueLatencyStats() {
    const data = this.recentRequeueLatenciesMs;
    if (data.length === 0) return null;
    const sorted = [...data].sort((a, b) => a - b);
    const p95Index = Math.min(Math.floor(sorted.length * 0.95), sorted.length - 1);
    return {
      count: data.length,
      avg_ms: Math.round(data.reduce((s, v) => s + v, 0) / data.length),
      max_ms: sorted[sorted.length - 1],
      p95_ms: sorted[p95Index],
    };
  }

  async reclaimOrphanedBudget() {
    // Find tasks that are no longer in_progress but may still have leaked reservations.
    // The budget reservation is tied to the daily budget row, not individual tasks.
    // Reset reserved_usd to match only currently in-progress estimated costs.
    //
    // SCOPE GUARD (account_id IS NULL): this flat-rate reclaim (in_progress count x $0.01)
    // is only valid for the GLOBAL daily row. Per-account rows (account_id NOT NULL) carry
    // real, per-task reservations; clobbering them with the global flat rate would zero out
    // a live reservation and open an overspend window against budgets_no_overspend
    // (account allocated=$10; Task A reserves $5; reaper resets to ~$0.03; Task B's reserve
    // check then passes and both commit -> spent > allocated). A correct per-account reclaim
    // needs a per-work-item reservation column that does not yet exist, so per-account rows
    // are deliberately left untouched here (over-conservative, never overspend) pending the
    // schema-column board decision (Plan 016).
    // sysQuery: agent_graph.budgets itself has no RLS, but the reserved_usd
    // recompute embeds a `COUNT(*) FROM agent_graph.work_items WHERE status =
    // 'in_progress'` that spans ALL agents. Under an agent role post-flip that
    // COUNT would only see this principal's own in-progress items and undercount,
    // zeroing out live reservations and opening an overspend window. The system
    // scope makes the COUNT global (matching today's superuser behavior).
    const result = await sysQuery(
      `UPDATE agent_graph.budgets
       SET reserved_usd = GREATEST(0,
         (SELECT COALESCE(COUNT(*), 0) FROM agent_graph.work_items WHERE status = 'in_progress')
         * 0.01),
         updated_at = now()
       WHERE scope = 'daily' AND period_start = CURRENT_DATE
         AND account_id IS NULL
         AND reserved_usd > 0
       RETURNING reserved_usd`
    );
    if (result.rows.length > 0 && parseFloat(result.rows[0].reserved_usd) === 0) {
      log.info('Reclaimed orphaned budget reservations');
    }
  }
}
