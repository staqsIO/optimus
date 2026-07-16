// runtime/pg-listener.js — Single shared pg.Client LISTEN connection.
//
// Phase 1 of the DB connection-exhaustion fix. Three subsystems used to open
// THREE separate raw `pg.Client` LISTEN connections — lib/graph/sync.js,
// lib/graph/pattern-extractor.js, and lib/runtime/state/event-bus.js. Each
// holds a session-pinned Supabase connection, so the pooler budget was paying
// 3× the LISTEN cost per process. This module consolidates them into ONE
// shared client that LISTENs on every registered channel and fans the
// notifications in-process to the registered handlers.
//
// P4: Boring infrastructure — raw `pg`, no new dependencies. The connection
// string is `process.env.DATABASE_URL` (the SESSION pooler), unchanged.
//
// PGlite / dev mode (no DATABASE_URL): start()/stop() are no-ops; subscribe()
// still records handlers (PGlite LISTEN is handled elsewhere, not via this
// client). Dev/tests never crash.
import { createLogger } from '../logger.js';
const log = createLogger('runtime/pg-listener');

// channel -> Set<handler>. Buffered registrations: subscribe() may be called
// before start(); start() LISTENs on every channel present here at boot, and
// a subscribe() after start() issues the LISTEN immediately.
const _handlers = new Map();

let _client = null;
let _started = false;
let _destroying = false;
let _reconnectTimer = null;
let _reconnectDelayMs = 1000; // exponential backoff seed (1s → cap 30s)
const RECONNECT_CAP_MS = 30_000;

// Liveness keepalive: every PG_LISTENER_KEEPALIVE_MS run `SELECT 1` on the
// LISTEN client. Success = no-op; error = reconnect. This is liveness-based,
// so (unlike a notification-absence watchdog) it never false-positives on a
// legitimately quiet channel and never tears down all channels on a quiet
// window — it only acts when the connection is actually dead.
const PG_LISTENER_KEEPALIVE_MS =
  Number(process.env.PG_LISTENER_KEEPALIVE_MS) || 60_000;
let _keepaliveTimer = null;

// Test seam: a factory that returns a pg.Client-shaped object. Production
// leaves this null and we dynamically import('pg'). Mirrors the existing
// _getPgLiteForTest / _drainSyncQueueForTest test seams in this codebase —
// lets the unit test inject a fake client without the bare-specifier + flag
// fragility of mock.module('pg', …) inside a nested lib/ directory.
let _clientFactoryForTest = null;
export function __setClientFactoryForTest(factory) {
  _clientFactoryForTest = factory;
}

/**
 * Register a handler for a channel. Callable BEFORE start() (buffered) or
 * after (LISTEN issued immediately). Multiple handlers per channel allowed.
 *
 * @param {string} channel  pg_notify channel name
 * @param {(payload: string, channel: string) => void} handler
 *        Called with the raw NOTIFY payload string and the channel name.
 * @returns {() => void} unsubscribe function
 */
export function subscribe(channel, handler) {
  if (typeof channel !== 'string' || !channel) {
    throw new Error('pg-listener.subscribe: channel must be a non-empty string');
  }
  if (typeof handler !== 'function') {
    throw new Error('pg-listener.subscribe: handler must be a function');
  }
  let set = _handlers.get(channel);
  const isNewChannel = !set;
  if (!set) {
    set = new Set();
    _handlers.set(channel, set);
  }
  set.add(handler);

  // If we're already connected and this is the first handler for the channel,
  // issue the LISTEN now so late subscribers still receive notifications.
  if (isNewChannel && _started && _client && !_destroying) {
    _client.query(`LISTEN ${quoteIdent(channel)}`).catch((err) => {
      log.error(`LISTEN ${channel} (late subscribe) failed: ${err.message}`);
    });
  }

  return () => {
    const s = _handlers.get(channel);
    if (!s) return;
    s.delete(handler);
    // Keep the channel key (and its LISTEN) even when empty — channels are
    // few and re-subscribing is common; UNLISTEN churn is not worth it. The
    // empty Set simply fans out to nobody until a new handler registers.
  };
}

/**
 * Connect the shared client and LISTEN on every registered channel.
 * Idempotent. No-op in PGlite/dev mode (no DATABASE_URL).
 */
export async function start() {
  if (!process.env.DATABASE_URL) {
    // PGlite / dev mode: handlers are still recorded by subscribe(), but this
    // client never connects. LISTEN in PGlite is handled elsewhere.
    log.info('No DATABASE_URL — shared pg-listener disabled (PGlite mode)');
    return;
  }
  if (_started) return; // idempotent
  _started = true;
  _destroying = false;
  await connect();
}

async function connect() {
  if (_destroying) return;
  try {
    if (_clientFactoryForTest) {
      _client = _clientFactoryForTest();
    } else {
      const { default: pg } = await import('pg');
      // Phase 2 (query-pool split): LISTEN MUST connect via the RAW
      // process.env.DATABASE_URL = the SESSION pooler (port 5432). It is
      // deliberately NOT the query pool's derived URL (lib/db.js
      // deriveQueryPoolUrl → TRANSACTION pooler, port 6543). Transaction
      // pooling multiplexes and reassigns server connections per transaction,
      // which silently breaks LISTEN — so queries go to 6543 and LISTEN stays
      // on 5432. This separation is the entire point of the split; do not
      // route this client through db.js's pool or the 6543 URL.
      _client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    }

    // Register the error handler BEFORE connect to avoid an unhandled-error
    // window. Mirrors the pattern in the three modules this replaces.
    _client.on('error', (err) => {
      log.error(`shared LISTEN connection error — will reconnect: ${err.message}`);
      scheduleReconnect();
    });

    _client.on('notification', (msg) => {
      const set = _handlers.get(msg.channel);
      if (!set || set.size === 0) return;
      for (const handler of set) {
        try {
          handler(msg.payload, msg.channel);
        } catch (err) {
          // One bad handler must never break dispatch to the others.
          log.error(`handler for ${msg.channel} threw: ${err.message}`);
        }
      }
    });

    await _client.connect();

    // LISTEN on every channel registered so far (buffered + late).
    for (const channel of _handlers.keys()) {
      await _client.query(`LISTEN ${quoteIdent(channel)}`);
    }

    // A clean connect resets the backoff and (re)arms the keepalive probe.
    _reconnectDelayMs = 1000;
    armKeepalive();

    log.info(
      `shared pg-listener active (LISTEN ${[..._handlers.keys()].join(', ') || '<no channels>'})`
    );
  } catch (err) {
    log.error(`Failed to start shared pg-listener: ${err.message}`);
    if (_client) {
      // Detach handlers BEFORE end() so an 'error' event emitted during/after
      // end() can't re-trigger scheduleReconnect() — we call it explicitly below.
      _client.removeAllListeners();
      _client.end().catch(() => {});
      _client = null;
    }
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (_destroying) return;
  if (_reconnectTimer) return; // a reconnect is already armed
  // Stop probing the dead client; the keepalive is re-armed on next connect().
  if (_keepaliveTimer) {
    clearInterval(_keepaliveTimer);
    _keepaliveTimer = null;
  }
  // Tear down the dead client so its handlers don't fire during the gap.
  if (_client) {
    _client.removeAllListeners();
    _client.end().catch(() => {});
    _client = null;
  }
  const delay = _reconnectDelayMs;
  _reconnectDelayMs = Math.min(_reconnectDelayMs * 2, RECONNECT_CAP_MS);
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    if (_destroying) return;
    log.info('Attempting shared pg-listener reconnect...');
    connect().catch((err) =>
      log.error(`shared pg-listener reconnect failed: ${err.message}`)
    );
  }, delay);
  _reconnectTimer.unref?.();
}

// Active liveness probe: `SELECT 1` on an interval. Success = connection alive
// (no-op); error = the connection is dead (e.g. Supabase pooler dropped it
// without firing an 'error' event) → reconnect. Re-armed by connect() on each
// successful connection; cleared by scheduleReconnect() and stop().
function armKeepalive() {
  if (_keepaliveTimer) clearInterval(_keepaliveTimer);
  if (_destroying) return;
  _keepaliveTimer = setInterval(() => {
    if (_destroying || !_client) return;
    _client.query('SELECT 1').catch((err) => {
      log.warn(`keepalive probe failed (${err.message}) — reconnecting shared pg-listener`);
      scheduleReconnect();
    });
  }, PG_LISTENER_KEEPALIVE_MS);
  _keepaliveTimer.unref?.();
}

/**
 * UNLISTEN, destroy the client, clear timers. Idempotent.
 * Sets the destroying flag so any in-flight reconnect/keepalive stops.
 */
export async function stop() {
  _destroying = true;
  _started = false;
  if (_reconnectTimer) {
    clearTimeout(_reconnectTimer);
    _reconnectTimer = null;
  }
  if (_keepaliveTimer) {
    clearInterval(_keepaliveTimer);
    _keepaliveTimer = null;
  }
  if (_client) {
    const c = _client;
    _client = null;
    try {
      await c.query('UNLISTEN *');
    } catch {
      // Connection may already be dead — ignore.
    }
    await c.end().catch(() => {});
  }
}

/**
 * Raw client accessor — diagnostics / tests only. Production code must
 * subscribe() instead of touching the client directly.
 */
export function getListenerClient() {
  return _client;
}

// pg_notify channel names are identifiers. The channels in this codebase are
// fixed string literals (task_completed, autobot_events, etc.), but quote
// defensively so a channel can never break out of the LISTEN statement. We do
// NOT parameterize: LISTEN does not accept bind parameters in Postgres.
function quoteIdent(ident) {
  return `"${String(ident).replace(/"/g, '""')}"`;
}
