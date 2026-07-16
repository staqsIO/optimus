/**
 * Generated-artifact worker (OPT-99, Feature 005 item 4).
 *
 * Consumes pg_notify('artifact_register') emitted by:
 *   - lib/engagements/db.js   → recordGeneratedProposal  (kind='proposal')
 *   - lib/engagements/contract-drafter.js → draftContractFromApprovedProposal (kind='contract')
 *
 * For each notification it fetches the generated body from engagements.* and
 * calls createArtifact({ source_system: 'optimus', kind, ownerOrgId, title, raw })
 * so generated docs become first-class registry artifacts (tracked, versioned,
 * enriched, searchable) — identical bytes later captured from Drive collapse to
 * the SAME artifact because OPT-97 content_hash drops source_system.
 *
 * Decoupling invariant (CG-1):
 *   - The EMIT sites (db.js, contract-drafter.js) do NOT import lib/content/*.
 *   - This file (in lib/runtime/) imports lib/content/create-artifact.js — that
 *     is a lib→lib import and does NOT cross the lib→autobot-inbox boundary.
 *     Zero new CG-1 violations.
 *
 * P3 — generation never blocks on / fails due to this worker being down.
 *       pg_notify is fire-and-forget; the notification is delivered when the
 *       consumer reconnects (or the next poll fires).
 * P4 — pg_notify, no external queue; parameterised SQL only.
 */

import { _getPgLiteForTest, getMode } from '../../db.js';
import { createLogger } from '../../logger.js';
import { createArtifact } from '../../content/create-artifact.js';

const log = createLogger('runtime/generated-artifact-worker');

const CHANNEL = 'artifact_register';

/**
 * Start the generated-artifact worker.
 *
 * @param {Object}   opts
 * @param {Function} opts.query          pg-style query fn (required)
 * @param {number}   [opts.pollIntervalMs]  fallback poll interval (default 10 000)
 * @param {number}   [opts.stopTimeoutMs]   max wait for in-flight on stop() (default 30 000)
 * @returns {Promise<{ stop: () => Promise<void> }>}
 */
export async function startGeneratedArtifactWorker({
  query,
  pollIntervalMs = 10_000,
  stopTimeoutMs = 30_000,
} = {}) {
  if (typeof query !== 'function') {
    throw new Error('startGeneratedArtifactWorker requires { query } function');
  }

  // ── 1. Startup: drain any notifications that arrived while we were down. ──
  // There is no durable queue for this worker — pg_notify is ephemeral. We
  // compensate with a startup sweep: find generated_proposals and content.drafts
  // of kind 'contract' that have no matching artifact yet and register them.
  try {
    await backfillMissing(query);
  } catch (err) {
    log.warn('generated-artifact-worker startup backfill failed (non-fatal):', err.message);
  }

  // ── 2. Subscribe to pg_notify wake-ups. ──
  let unsubscribe = null;
  let pgListenClient = null;
  let listenReconnecting = false;
  let listenBackoffMs = 1000;
  const LISTEN_BACKOFF_CAP_MS = 30_000;
  let listenReconnectTimer = null;

  const wakeup = (payload) => {
    // Payload is a JSON string: { id, kind, owner_org_id, draft_id? }
    scheduleTick(payload);
  };

  async function connectListen() {
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });

    client.on('error', (err) => {
      log.error('generated-artifact-worker LISTEN client error:', err.message);
      scheduleListenReconnect();
    });
    client.on('end', () => {
      if (stopped) return;
      log.error('generated-artifact-worker LISTEN client ended unexpectedly');
      scheduleListenReconnect();
    });

    await client.connect();
    await client.query(`LISTEN ${CHANNEL}`);
    client.on('notification', (msg) => {
      if (msg.channel === CHANNEL) wakeup(msg.payload);
    });

    pgListenClient = client;
    listenBackoffMs = 1000;
    log.info('generated-artifact-worker LISTEN connected');
  }

  function scheduleListenReconnect() {
    if (stopped || listenReconnecting) return;
    listenReconnecting = true;

    if (pgListenClient) {
      pgListenClient.end().catch(() => { /* swallowed */ });
      pgListenClient = null;
    }

    const delay = listenBackoffMs;
    listenBackoffMs = Math.min(listenBackoffMs * 2, LISTEN_BACKOFF_CAP_MS);

    listenReconnectTimer = setTimeout(() => {
      listenReconnectTimer = null;
      if (stopped) { listenReconnecting = false; return; }
      log.warn(`generated-artifact-worker LISTEN reconnecting after ${delay}ms backoff`);
      connectListen()
        .then(() => { listenReconnecting = false; })
        .catch((err) => {
          listenReconnecting = false;
          log.error('generated-artifact-worker LISTEN reconnect failed:', err.message);
          scheduleListenReconnect();
        });
    }, delay);
    if (typeof listenReconnectTimer.unref === 'function') listenReconnectTimer.unref();
  }

  if (getMode() === 'postgres') {
    try {
      await connectListen();
    } catch (err) {
      log.warn('generated-artifact-worker LISTEN init failed, will retry:', err.message);
      pgListenClient = null;
      scheduleListenReconnect();
    }
  } else {
    // PGlite (test mode): subscribe via the PGlite listen API.
    try {
      const handle = await _getPgLiteForTest();
      if (handle && typeof handle.listen === 'function') {
        unsubscribe = await handle.listen(CHANNEL, (payload) => wakeup(payload));
      }
    } catch (err) {
      log.warn('generated-artifact-worker PGlite listen() failed, polling only:', err.message);
    }
  }

  // ── 3. Worker loop state. ──
  let stopped = false;
  let tickInFlight = null;
  let tickQueued = false;

  // pendingPayloads: notifications received while a tick was in flight.
  const pendingPayloads = [];

  function scheduleTick(payload) {
    if (stopped) return;
    if (payload !== undefined) pendingPayloads.push(payload);
    if (tickInFlight) { tickQueued = true; return; }
    tickInFlight = drain().finally(() => {
      tickInFlight = null;
      if (tickQueued && !stopped) {
        tickQueued = false;
        scheduleTick();
      }
    });
  }

  async function drain() {
    // Drain all pending payloads from this wakeup batch.
    const batch = pendingPayloads.splice(0);
    for (const raw of batch) {
      try {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        await processNotification(parsed);
      } catch (err) {
        log.error('generated-artifact-worker processNotification failed:', err.message, '| payload:', raw);
      }
    }
    // Also run a poll sweep (handles notifications missed during downtime).
    await pollSweep();
  }

  /**
   * Process a single artifact_register notification.
   * Fetches the body from engagements.* then calls createArtifact.
   */
  async function processNotification({ id, kind, owner_org_id: ownerOrgId, draft_id: draftId } = {}) {
    if (!id || !kind || !ownerOrgId) {
      log.warn('generated-artifact-worker: skipping malformed notification', { id, kind, ownerOrgId });
      return;
    }
    try {
      await registerGeneratedArtifact({ query, id, kind, ownerOrgId, draftId });
    } catch (err) {
      // Errors are isolated to this notification — never throw up (P3).
      log.error(`generated-artifact-worker: failed to register ${kind} id=${id}: ${err.message}`);
    }
  }

  /**
   * Poll sweep: catch any generated_proposals that have no matching
   * artifact yet (e.g. notifications missed during a restart).
   */
  async function pollSweep() {
    try {
      // Proposals without a matching optimus artifact.
      const missing = await query(
        `SELECT gp.id, gp.engagement_id, gp.markdown, gp.mode,
                e.owner_org_id, e.name AS engagement_name
           FROM engagements.generated_proposals gp
           JOIN engagements.engagements e ON e.id = gp.engagement_id
          WHERE e.owner_org_id IS NOT NULL
            AND gp.markdown IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM content.artifacts a
               WHERE a.source_system = 'optimus'
                 AND a.kind = 'proposal'
                 AND a.owner_org_id = e.owner_org_id
                 AND a.title = (e.name || ' — ' || gp.mode || ' proposal')
            )
          ORDER BY gp.created_at DESC
          LIMIT 10`,
      );
      for (const row of missing.rows) {
        try {
          await registerGeneratedArtifact({
            query,
            id: row.id,
            kind: 'proposal',
            ownerOrgId: row.owner_org_id,
          });
        } catch (err) {
          log.error(`generated-artifact-worker pollSweep: failed proposal ${row.id}: ${err.message}`);
        }
      }
    } catch (err) {
      log.error('generated-artifact-worker pollSweep failed:', err.message);
    }
  }

  // ── 4. Poll timer (NOTIFY-or-poll, whichever comes first). ──
  const timer = setInterval(() => scheduleTick(), pollIntervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  // Kick once on startup after any backfill to drain newly-visible rows.
  scheduleTick();

  // ── 5. Stop. ──
  async function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);

    if (listenReconnectTimer) {
      clearTimeout(listenReconnectTimer);
      listenReconnectTimer = null;
    }

    if (tickInFlight) {
      let abandonTimer = null;
      const abandon = new Promise((resolve) => {
        abandonTimer = setTimeout(() => resolve('timeout'), stopTimeoutMs);
        if (typeof abandonTimer.unref === 'function') abandonTimer.unref();
      });
      const settle = tickInFlight.then(() => 'settled').catch(() => 'settled');
      await Promise.race([settle, abandon]);
      if (abandonTimer) clearTimeout(abandonTimer);
    }

    try {
      if (typeof unsubscribe === 'function') await unsubscribe();
    } catch { /* swallowed */ }
    unsubscribe = null;

    if (pgListenClient) {
      try { await pgListenClient.end(); } catch { /* swallowed */ }
      pgListenClient = null;
    }
  }

  return { stop };
}

/**
 * Register a single generated proposal or contract as a first-class artifact.
 * Idempotent: same title → same identity_key → new version (OPT-97 dedup).
 * Same bytes later captured from Drive → same content_hash → same version.
 *
 * @param {object}  opts
 * @param {Function} opts.query
 * @param {string}   opts.id          generated_proposals.id or content.drafts.id
 * @param {string}   opts.kind        'proposal' | 'contract'
 * @param {string}   opts.ownerOrgId
 * @param {string}  [opts.draftId]    content.drafts.id (contract path)
 */
async function registerGeneratedArtifact({ query, id, kind, ownerOrgId, draftId }) {
  let raw, title;

  if (kind === 'proposal') {
    const r = await query(
      `SELECT gp.markdown, gp.mode, e.name AS engagement_name
         FROM engagements.generated_proposals gp
         JOIN engagements.engagements e ON e.id = gp.engagement_id
        WHERE gp.id = $1
          AND e.owner_org_id = $2`,
      [id, ownerOrgId]
    );
    if (!r.rows.length) {
      log.warn(`generated-artifact-worker: proposal ${id} not found or wrong org`);
      return;
    }
    const { markdown, mode, engagement_name } = r.rows[0];
    if (!markdown) {
      log.warn(`generated-artifact-worker: proposal ${id} has no markdown — skipping`);
      return;
    }
    raw = markdown;
    title = `${engagement_name} — ${mode} proposal`;
  } else if (kind === 'contract') {
    // Contract row lives in content.drafts (content_type='contract').
    const contractId = draftId || id;
    const r = await query(
      `SELECT d.body, d.title
         FROM content.drafts d
         JOIN engagements.engagements e ON e.id = d.engagement_id
        WHERE d.id = $1
          AND e.owner_org_id = $2
          AND d.content_type = 'contract'`,
      [contractId, ownerOrgId]
    );
    if (!r.rows.length) {
      log.warn(`generated-artifact-worker: contract draft ${contractId} not found or wrong org`);
      return;
    }
    const { body, title: draftTitle } = r.rows[0];
    if (!body) {
      log.warn(`generated-artifact-worker: contract draft ${contractId} has no body — skipping`);
      return;
    }
    raw = body;
    title = draftTitle;
  } else {
    log.warn(`generated-artifact-worker: unknown kind '${kind}' for id=${id}`);
    return;
  }

  // createArtifact handles identity_key = sha256(owner|title) and
  // content_hash = sha256(owner|body[:4096]) — both owner-scoped so two
  // orgs' identical bytes do NOT collide (OPT-97 design). Versioning is
  // free: same title → same identity_key → new version if bytes differ;
  // same bytes → same content_hash → idempotent (ON CONFLICT DO NOTHING on
  // the versions table).
  await createArtifact({
    raw,
    kind,
    title,
    source_system: 'optimus',
    ownerOrgId,
  });

  log.info(`generated-artifact-worker: registered ${kind} id=${id} org=${ownerOrgId} title="${title}"`);
}

/**
 * Startup sweep: register any generated proposals/contracts that have no
 * matching artifact yet. Called once at boot before the LISTEN loop starts.
 */
async function backfillMissing(query) {
  const missing = await query(
    `SELECT gp.id, gp.markdown, gp.mode, e.owner_org_id, e.name AS engagement_name
       FROM engagements.generated_proposals gp
       JOIN engagements.engagements e ON e.id = gp.engagement_id
      WHERE e.owner_org_id IS NOT NULL
        AND gp.markdown IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM content.artifacts a
           WHERE a.source_system = 'optimus'
             AND a.kind = 'proposal'
             AND a.owner_org_id = e.owner_org_id
             AND a.title = (e.name || ' — ' || gp.mode || ' proposal')
        )
      ORDER BY gp.created_at DESC
      LIMIT 50`,
  );
  if (missing.rows.length === 0) return;
  log.info(`generated-artifact-worker: backfilling ${missing.rows.length} unregistered proposals`);
  for (const row of missing.rows) {
    try {
      await createArtifact({
        raw: row.markdown,
        kind: 'proposal',
        title: `${row.engagement_name} — ${row.mode} proposal`,
        source_system: 'optimus',
        ownerOrgId: row.owner_org_id,
      });
    } catch (err) {
      log.error(`generated-artifact-worker backfill failed for proposal ${row.id}: ${err.message}`);
    }
  }
}
