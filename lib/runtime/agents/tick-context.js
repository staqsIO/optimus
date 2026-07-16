/**
 * Tick Context Builder (Claude Code Architecture Audit — Change 6).
 *
 * Builds state snapshots for daemon-mode agents on each tick.
 * The tick context tells the agent what has changed since its last action,
 * so it can decide whether to act proactively.
 *
 * Inspired by Claude Code's KAIROS system — periodic `<tick>` prompts
 * with state snapshots for proactive decision-making.
 */

import { withSystemScope } from '../../db.js';

/**
 * Build tick context for a daemon-mode agent.
 * Assembles a snapshot of system state relevant to proactive decisions.
 *
 * @param {string} agentId - The daemon agent
 * @param {Object} [opts]
 * @param {Date} [opts.lastActionAt] - When this agent last took action
 * @returns {Promise<Object>} Tick context snapshot
 */
export async function buildTickContext(agentId, opts = {}) {
  const context = {
    agentId,
    tickAt: new Date().toISOString(),
    timeSinceLastAction: null,
  };

  // STAQPRO-263 / OPT-166 P2a — system-scope this snapshot.
  // buildTickContext reads state_transitions and work_items across ALL agents and
  // orgs (per-agent failure counts for pipeline health; unclaimed backlog with no
  // owning-org filter). Post pool-flip (app connects as autobot_agent, RLS
  // enforced) an agent-scoped principal would black-hole those cross-agent /
  // cross-org reads. This is a read-only operational daemon path, so open a system
  // scope (tenancy.is_system() Tier-0 read bypass, sql/199) for the DB burst and
  // release it before returning. No network/LLM I/O is held across the scoped
  // transaction. INERT until the flip (today's superuser bypasses RLS).
  const q = await withSystemScope('tick-context', { reason: `tick:${agentId}` });

  // Each read is SAVEPOINT-isolated: a single failing read (e.g. a relation that
  // does not exist) rolls back only itself and returns its fallback, instead of
  // aborting the shared scoped transaction and zeroing every OTHER read. The
  // original module got this isolation for free by using 5 independent pooled
  // connections; a system scope holds ONE connection, so isolation must be
  // explicit. Reads run sequentially — on one pg connection queries serialize on
  // the wire regardless, so this costs no latency vs the former Promise.all.
  // NOTE: the fallback must be reached via the query REJECTING (no inner .catch) —
  // swallowing the error before ROLLBACK would leave the txn aborted and break the
  // RELEASE/next read. So `read` owns the try/catch; the query must throw raw.
  let spN = 0;
  const read = async (fn, fallback) => {
    const sp = `tick_sp_${spN++}`;
    await q(`SAVEPOINT ${sp}`);
    try {
      const v = await fn();
      await q(`RELEASE SAVEPOINT ${sp}`);
      return v;
    } catch {
      await q(`ROLLBACK TO SAVEPOINT ${sp}`);
      return fallback;
    }
  };

  let budgetStatus, pipelineHealth, recentEvents, pendingWork, lastAction;
  try {
    // Budget status
    budgetStatus = await read(
      () => q(`SELECT * FROM agent_graph.v_budget_status WHERE period_end >= CURRENT_DATE`).then(r => r.rows),
      []
    );

    // Pipeline health: agent heartbeats + error rate
    pipelineHealth = await read(
      () => q(
        `SELECT h.agent_id, h.status, h.heartbeat_at,
                (SELECT COUNT(*) FROM agent_graph.state_transitions st
                 WHERE st.agent_id = h.agent_id AND st.to_state = 'failed'
                 AND st.created_at > now() - INTERVAL '1 hour') AS recent_failures
         FROM agent_graph.agent_heartbeats h
         ORDER BY h.heartbeat_at DESC`
      ).then(r => r.rows),
      []
    );

    // Recent events: DEAD reference — agent_graph.events has never existed (no
    // table/view on a fully-migrated DB; task_events has a different shape and is
    // not a drop-in). Under the old per-connection code this read always failed
    // into .catch(()=>[]) silently, so recentEvents has ALWAYS been []. Preserve
    // that behavior exactly, but do NOT fire a guaranteed-failing query every tick
    // (3 wasted round-trips + a needless ROLLBACK). Pre-existing latent bug,
    // out of scope for the OPT-166 flip wiring — tracked separately.
    recentEvents = [];

    // Pending work items (unclaimed)
    pendingWork = await read(
      () => q(
        `SELECT COUNT(*) AS total,
                COUNT(*) FILTER (WHERE priority >= 8) AS high_priority,
                MIN(created_at) AS oldest
         FROM agent_graph.work_items
         WHERE status IN ('created', 'assigned')
           AND assigned_to IS NULL`
      ).then(r => r.rows[0]),
      { total: 0, high_priority: 0, oldest: null }
    );

    // This agent's last action
    lastAction = await read(
      () => q(
        `SELECT created_at, to_state, reason
         FROM agent_graph.state_transitions
         WHERE agent_id = $1
         ORDER BY created_at DESC
         LIMIT 1`,
        [agentId]
      ).then(r => r.rows[0]),
      null
    );
  } finally {
    await q.release();
  }

  context.budget = budgetStatus;
  context.pipeline = pipelineHealth;
  context.recentEvents = recentEvents;
  context.pendingWork = pendingWork;

  if (lastAction) {
    context.lastAction = lastAction;
    context.timeSinceLastAction = Date.now() - new Date(lastAction.created_at).getTime();
  }

  // Compute alerts: conditions that should prompt proactive action
  context.alerts = [];

  // Budget alert: >80% spent
  for (const b of budgetStatus) {
    if (b.spent_usd && b.ceiling_usd && b.spent_usd / b.ceiling_usd > 0.8) {
      context.alerts.push({ type: 'budget_high', detail: `${Math.round(b.spent_usd / b.ceiling_usd * 100)}% of budget used` });
    }
  }

  // Pipeline alert: agents with high failure rates
  for (const p of pipelineHealth) {
    if (p.recent_failures > 5) {
      context.alerts.push({ type: 'agent_failing', detail: `${p.agent_id}: ${p.recent_failures} failures in last hour` });
    }
    // Stale heartbeat (>5 min)
    if (p.heartbeat_at && Date.now() - new Date(p.heartbeat_at).getTime() > 300_000) {
      context.alerts.push({ type: 'agent_stale', detail: `${p.agent_id}: heartbeat stale (${p.status})` });
    }
  }

  // Work backlog alert
  if (pendingWork.high_priority > 0) {
    context.alerts.push({ type: 'backlog_high_priority', detail: `${pendingWork.high_priority} high-priority items unclaimed` });
  }
  if (pendingWork.oldest && Date.now() - new Date(pendingWork.oldest).getTime() > 3600_000) {
    context.alerts.push({ type: 'backlog_stale', detail: `Oldest unclaimed item is ${Math.round((Date.now() - new Date(pendingWork.oldest).getTime()) / 60000)}m old` });
  }

  return context;
}
