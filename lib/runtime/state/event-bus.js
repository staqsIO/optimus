import { query, getMode } from '../../db.js';
import { EventEmitter } from 'events';
import { publishEvent } from '../infrastructure.js';
import { subscribe as pgSubscribe } from '../pg-listener.js';
import { createLogger } from '../../logger.js';
const log = createLogger('runtime/event-bus');

/**
 * Event bus: dual-mode dispatch.
 * PGlite mode: in-process EventEmitter (zero DB connections held).
 * Real Postgres mode: pg_notify/LISTEN for cross-process wake-up (spec §16).
 * Both modes use EventEmitter for in-process dispatch; real PG adds LISTEN on top.
 */

const bus = new EventEmitter();
bus.setMaxListeners(20); // 6 agents + headroom

// Unsubscribe fn from the shared pg-listener (autobot_events channel). Held so
// unsubscribeAll() can detach without tearing down the shared client.
let _pgUnsubscribe = null;

/**
 * Initialize the autobot_events listener for real Postgres mode.
 * Call once at startup. No-op in PGlite mode.
 *
 * Phase 1 consolidation: this no longer opens its own pg.Client LISTEN
 * connection. It registers an autobot_events handler on the single shared
 * pg-listener (lib/runtime/pg-listener.js), whose connect/reconnect/watchdog
 * are owned by the boot sequence. subscribe() is callable before the shared
 * start(), so registration order at boot does not matter. The reconnect logic
 * (formerly STAQPRO-351's _reconnecting guard + connectPgListen retry loop)
 * now lives in the shared listener.
 */
export async function initPgNotify() {
  if (getMode() !== 'postgres') return;
  // Idempotent: avoid stacking duplicate handlers on repeat calls.
  if (_pgUnsubscribe) return;
  _pgUnsubscribe = pgSubscribe('autobot_events', (payloadStr) => {
    try {
      const payload = JSON.parse(payloadStr);
      bus.emit('task_events', payload);
    } catch {
      // Ignore malformed notifications
    }
  });
  log.info('autobot_events handler registered (shared pg-listener)');
}

/**
 * Subscribe to task events for a specific agent.
 * In-process dispatch — zero DB connections held.
 */
export async function subscribe(agentId, callback) {
  const handler = (payload) => {
    if (
      !payload.target_agent_id ||
      payload.target_agent_id === agentId ||
      payload.target_agent_id === '*'
    ) {
      callback(payload);
    }
  };

  bus.on('task_events', handler);
  return () => bus.off('task_events', handler);
}

/**
 * Subscribe to ALL task events (unfiltered).
 * Used by API cache invalidation — state_changed events target 'orchestrator',
 * so the filtered subscribe() can't catch them.
 */
export function onAnyEvent(callback) {
  bus.on('task_events', callback);
  return () => bus.off('task_events', callback);
}

/**
 * Phase-2 tenancy (live read-leak, Commit B): resolve a work item's owning org
 * so emitted autobot_events payloads carry owner_org_id and the SSE boundary
 * filter (autobot-inbox/src/api.js) can drop cross-tenant events.
 *
 * Robust against missed call sites (Linus blocker 2): callers pass an event with
 * a work_item_id and we do ONE indexed PK read here, rather than threading the
 * org through every state-machine producer. Event volume is low, so one read per
 * event is cheap. Resilient: any failure / null result leaves owner_org_id null
 * (the SSE filter treats org-less events per its CONTROL_EVENT_TYPES allowlist —
 * fail-closed for tenant-bearing types).
 *
 * Skips the lookup entirely for the sentinel workItemId 'system' (kill-switch /
 * halt fan-out — genuinely org-less control signals) and for null/empty ids.
 *
 * @param {string|null|undefined} workItemId
 * @returns {Promise<string|null>} owner_org_id or null
 */
async function resolveOwnerOrgId(workItemId, exec = query) {
  if (!workItemId || workItemId === 'system') return null;
  try {
    const r = await exec(
      `SELECT owner_org_id FROM agent_graph.work_items WHERE id = $1`,
      [workItemId]
    );
    return r.rows[0]?.owner_org_id ?? null;
  } catch {
    // Resilient: a missing column / transient error must not break event
    // dispatch. Null org → SSE filter fail-closed for tenant-bearing types.
    return null;
  }
}

/**
 * Emit a task event (insert into outbox + in-process dispatch).
 * Optional idempotencyKey prevents duplicate event processing (spec §4 step 2, Gap 11).
 *
 * `exec` (default: the pooled `query`) lets a caller run the whole emit — INSERT,
 * owner-org lookup, and pg_notify — through an alternate executor. OPT-166 P2b: the
 * reaper passes a system-scoped executor (withSystemScope, actor 'reaper') because
 * the INSERT's `RETURNING event_id` implicitly re-checks the `agent_read_events` SELECT policy
 * on the new row, and post-flip a re-queue event targets ANOTHER agent — only
 * `tenancy.is_system()` satisfies that USING clause. Bare `query()` would raise
 * 42501. All other callers keep the default and are unaffected.
 */
export async function emit({
  eventType,
  workItemId,
  targetAgentId,
  priority = 0,
  eventData = {},
  idempotencyKey = null,
  exec = query,
}) {
  const result = await exec(
    `INSERT INTO agent_graph.task_events
     (event_type, work_item_id, target_agent_id, priority, event_data, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
     RETURNING event_id`,
    [eventType, workItemId, targetAgentId, priority, JSON.stringify(eventData), idempotencyKey]
  );

  // If ON CONFLICT triggered, the event was a duplicate — skip dispatch
  if (result.rows.length === 0) {
    return null; // duplicate suppressed
  }

  // Commit B: stamp owner_org_id so the SSE boundary filter can scope per-org.
  // One indexed PK read; null for 'system' / unknown ids (control signals).
  const ownerOrgId = await resolveOwnerOrgId(workItemId, exec);

  const payload = {
    event_type: eventType,
    work_item_id: workItemId,
    target_agent_id: targetAgentId,
    owner_org_id: ownerOrgId,
  };

  // In-process dispatch
  bus.emit('task_events', payload);

  // pg_notify for cross-process dispatch (real Postgres mode)
  if (getMode() === 'postgres') {
    await exec(
      `SELECT pg_notify('autobot_events', $1)`,
      [JSON.stringify(payload)]
    ).catch(() => {}); // Non-critical: in-process dispatch is the fallback
  }

  return result.rows[0]?.event_id;
}

/**
 * Fire wake-up notifications (EventEmitter + pg_notify) without inserting a task_events row.
 * Use when the row was already inserted inside a transaction (e.g. createWorkItem).
 */
export async function notify({ eventType, workItemId, targetAgentId, ownerOrgId }) {
  // Commit B: accept a pass-through ownerOrgId for callers that already hold it
  // (skip the lookup); otherwise resolve it from work_item_id. Null for 'system'.
  const resolvedOrgId = ownerOrgId ?? await resolveOwnerOrgId(workItemId);
  const payload = {
    event_type: eventType,
    work_item_id: workItemId,
    target_agent_id: targetAgentId,
    owner_org_id: resolvedOrgId,
  };
  bus.emit('task_events', payload);
  if (getMode() === 'postgres') {
    await query(`SELECT pg_notify('autobot_events', $1)`, [JSON.stringify(payload)])
      .catch(() => {});
  }
}

/**
 * Emit a halt signal. Fail-closed: immediately blocks new tasks.
 * Writes to halt_signals (canonical) AND task_events (for legacy wake-up).
 */
export async function emitHalt(reason = 'Manual halt', signalType = 'human') {
  invalidateHaltCache();
  // Write to canonical halt_signals table (spec §9)
  try {
    await query(
      `INSERT INTO agent_graph.halt_signals (signal_type, reason, triggered_by)
       VALUES ($1, $2, $3)`,
      [signalType, reason, 'board']
    );
  } catch (err) {
    if (!err.message?.includes('does not exist')) throw err;
  }

  // Also emit to task_events for in-process wake-up
  await publishEvent('halt_triggered', `System halted: ${reason}`, null, null, { signal_type: signalType });

  return emit({
    eventType: 'halt_signal',
    workItemId: 'system',
    targetAgentId: '*',
    priority: 100,
    eventData: { reason, halted_at: new Date().toISOString() },
  });
}

/**
 * Clear halt signal (resume operations).
 * Clears both task_events and halt_signals (spec §9).
 */
export async function clearHalt() {
  invalidateHaltCache();
  const eventResult = await query(
    `UPDATE agent_graph.task_events
     SET processed_at = now()
     WHERE event_type = 'halt_signal' AND processed_at IS NULL
     RETURNING event_id`
  );
  let haltCount = 0;
  try {
    const haltResult = await query(
      `UPDATE agent_graph.halt_signals
       SET is_active = false, resolved_at = now(), resolved_by = 'board'
       WHERE is_active = true
       RETURNING id`
    );
    haltCount = haltResult.rowCount || 0;
  } catch (err) {
    if (!err.message?.includes('does not exist')) throw err;
  }
  await publishEvent('halt_cleared', `System resumed by board`, null, null, { events_cleared: eventResult.rowCount, halts_cleared: haltCount });

  return (eventResult.rowCount || 0) + haltCount;
}

/**
 * Check if system is halted.
 * Checks both task_events (legacy) and halt_signals table (spec §9).
 * Financial halts from reserve_budget() go into halt_signals.
 *
 * Result is cached for 2s to reduce PGlite contention — 6 agents calling
 * isHalted() every tick would otherwise fire 6 identical queries.
 */
let _haltCache = { value: false, ts: 0 };
const HALT_CACHE_TTL = 2000;

export async function isHalted() {
  if (Date.now() - _haltCache.ts < HALT_CACHE_TTL) return _haltCache.value;
  try {
    const result = await query(
      `SELECT 1 FROM agent_graph.task_events
       WHERE event_type = 'halt_signal' AND processed_at IS NULL
       UNION ALL
       SELECT 1 FROM agent_graph.halt_signals
       WHERE is_active = true
       LIMIT 1`
    );
    _haltCache = { value: result.rows.length > 0, ts: Date.now() };
    return _haltCache.value;
  } catch (err) {
    // Fallback: one of the tables may not exist (stale PGlite or partial migration)
    if (err.message?.includes('does not exist')) {
      // Try each table individually — one might exist without the other
      for (const fallbackSql of [
        `SELECT 1 FROM agent_graph.halt_signals WHERE is_active = true LIMIT 1`,
        `SELECT 1 FROM agent_graph.task_events WHERE event_type = 'halt_signal' AND processed_at IS NULL LIMIT 1`,
      ]) {
        try {
          const result = await query(fallbackSql);
          _haltCache = { value: result.rows.length > 0, ts: Date.now() };
          return _haltCache.value;
        } catch { /* try next */ }
      }
      // Neither table exists — log once and assume not halted
      log.warn('Neither task_events nor halt_signals exists — assuming not halted');
      _haltCache = { value: false, ts: Date.now() };
      return false;
    }
    throw err;
  }
}

/** Force-invalidate halt cache (called when emitting/clearing halt). */
export function invalidateHaltCache() { _haltCache.ts = 0; }

/**
 * Unsubscribe all listeners. Called on shutdown.
 */
export async function unsubscribeAll() {
  bus.removeAllListeners('task_events');
  // Detach our handler from the shared pg-listener. Does NOT stop the shared
  // client — that is owned by the boot sequence (other subsystems share it).
  if (_pgUnsubscribe) {
    _pgUnsubscribe();
    _pgUnsubscribe = null;
  }
}
