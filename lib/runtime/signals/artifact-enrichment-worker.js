/**
 * Artifact enrichment worker (OPT-93, Feature 004 item 2 — the #1 priority layer).
 *
 * Feature spec: spec/features/004-capture-enrich-artifacts.md ("Resolved data
 * model" + Decisions D2/D3). Producer side (registry + durable queue +
 * pg_notify('capture_ingested') trigger) shipped in OPT-92 / migration 154; this
 * is the CONSUMER.
 *
 * Drains content.enrichment_queue rows. Per row it:
 *   1. atomically claims the row (status pending -> processing),
 *   2. loads the artifact's current version document_id -> content.documents.raw_text,
 *   3. hard G10 cap check (dailySpendMeteredUsd('artifact-enricher')) — over cap leaves
 *      the row PENDING and skips (fail-closed, not fail-loud),
 *   4. extracts people/orgs via the extract_entities flow-agent (injectable),
 *   5. resolves each entity against signal.contacts/organizations (+ project/
 *      engagement context) SCOPED to the artifact's org, links + derives facts,
 *   6. on success status='done'; on error attempts+1 back to pending, and after
 *      3 attempts status='failed'. A failure isolates to the one row and NEVER
 *      throws out of the loop (capture already returned — D2).
 *
 * Mirrors lib/runtime/signals/human-task-enrichment-worker.js: LISTEN +
 * poll-fallback, dedicated pg.Client with reconnect-backoff, startup orphan
 * reset (processing -> pending after 5 min).
 *
 * P3 — append-only: links/facts use ON CONFLICT DO NOTHING so re-enrichment is a
 * net-zero no-op. P4 — pg_notify, no external queue. Parameterised SQL only.
 * Tenancy — every candidate query + write carries the artifact's owner_org_id
 * (from the queue row), NEVER the worker's: a Staqs artifact can never touch a
 * UMB contact.
 */

import { _getPgLiteForTest, getMode } from '../../db.js';
import { createLogger } from '../../logger.js';
import { dailySpendMeteredUsd } from '../../llm/record-spend.js';
import { applyResolution } from './artifact-entity-resolver.js';

const log = createLogger('runtime/artifact-enrichment-worker');

const CHANNEL = 'capture_ingested';
const ENRICHER_AGENT_ID = 'artifact-enricher';
const MAX_ATTEMPTS = 3;

// Entity classes we ask the extractor for (mirror meeting-classifier's pattern).
const ENTITY_TYPES = ['person', 'org'];

/**
 * Default extractor — calls the extract_entities flow-agent (Haiku, $0.03/call,
 * mirror lib/runtime/meeting-classifier.js). Lazily imported so unit tests can
 * inject a fake without dragging in the LLM stack.
 *
 * @param {{ text: string, context?: string }} input
 * @returns {Promise<{entities: Array<{type,value,snippet}>}>}
 */
async function defaultExtractEntities({ text, context }) {
  const [{ getFlowAgent }, { runFlowAgent }] = await Promise.all([
    import('../../../autobot-inbox/agents/flow-agents/index.js'),
    import('../../../autobot-inbox/agents/flow-agents/shared/runner.js'),
  ]);
  const definition = getFlowAgent('flow:extract_entities');
  const { output } = await runFlowAgent({
    definition,
    input: { text, entityTypes: ENTITY_TYPES, context: context || '' },
  });
  return output; // { entities: [{ type, value, snippet }] }
}

/**
 * Start the artifact enrichment worker.
 *
 * @param {Object} opts
 * @param {Function} opts.query                    pg-style query fn (required)
 * @param {Function} [opts.extractEntities]        override (default: extract_entities flow-agent)
 * @param {number}   [opts.pollIntervalMs]         poll fallback (default 5000)
 * @param {number}   [opts.stopTimeoutMs]          max wait for in-flight tick on stop() (default 30000)
 * @param {number}   [opts.dailyCapUsd]            G10 hard cap (default ARTIFACT_ENRICH_DAILY_USD or 5)
 * @returns {Promise<{ stop: () => Promise<void> }>}
 */
export async function startArtifactEnrichmentWorker({
  query,
  extractEntities = defaultExtractEntities,
  pollIntervalMs = 5000,
  stopTimeoutMs = 30_000,
  dailyCapUsd = Number(process.env.ARTIFACT_ENRICH_DAILY_USD || 5),
} = {}) {
  if (typeof query !== 'function') {
    throw new Error('startArtifactEnrichmentWorker requires { query } function');
  }

  // ── 1. Startup cleanup: reset stale 'processing' rows back to 'pending'. ──
  // A row 'processing' with updated_at older than 5 min is a crash-orphan.
  // Fresh 'processing' rows belong to some other in-flight worker — leave them.
  try {
    await query(
      `UPDATE content.enrichment_queue
          SET status = 'pending', updated_at = now()
        WHERE status = 'processing'
          AND updated_at < now() - interval '5 minutes'`,
    );
  } catch (err) {
    log.error('artifact-enrichment-worker startup cleanup failed:', err.message);
  }

  // ── 2. Subscribe to pg_notify wake-ups (mirror human-task worker). ──
  let unsubscribe = null;
  let pgListenClient = null;
  let listenReconnecting = false;
  let listenBackoffMs = 1000;
  const LISTEN_BACKOFF_CAP_MS = 30_000;
  let listenReconnectTimer = null;

  const wakeup = () => { scheduleTick(); };

  async function connectListen() {
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });

    client.on('error', (err) => {
      log.error('artifact-enrichment-worker LISTEN client error:', err.message);
      scheduleListenReconnect();
    });
    client.on('end', () => {
      if (stopped) return;
      log.error('artifact-enrichment-worker LISTEN client ended unexpectedly');
      scheduleListenReconnect();
    });

    await client.connect();
    await client.query(`LISTEN ${CHANNEL}`);
    client.on('notification', (msg) => {
      if (msg.channel === CHANNEL) wakeup();
    });

    pgListenClient = client;
    listenBackoffMs = 1000;
  }

  function scheduleListenReconnect() {
    if (stopped) return;
    if (listenReconnecting) return;
    listenReconnecting = true;

    if (pgListenClient) {
      const dead = pgListenClient;
      pgListenClient = null;
      dead.end().catch(() => { /* swallowed */ });
    }

    const delay = listenBackoffMs;
    listenBackoffMs = Math.min(listenBackoffMs * 2, LISTEN_BACKOFF_CAP_MS);

    listenReconnectTimer = setTimeout(() => {
      listenReconnectTimer = null;
      if (stopped) { listenReconnecting = false; return; }
      log.warn(`artifact-enrichment-worker LISTEN reconnecting after ${delay}ms backoff`);
      connectListen()
        .then(() => {
          listenReconnecting = false;
          log.info('artifact-enrichment-worker LISTEN reconnected');
        })
        .catch((err) => {
          listenReconnecting = false;
          log.error('artifact-enrichment-worker LISTEN reconnect failed:', err.message);
          scheduleListenReconnect();
        });
    }, delay);
    if (typeof listenReconnectTimer.unref === 'function') listenReconnectTimer.unref();
  }

  if (getMode() === 'postgres') {
    try {
      await connectListen();
    } catch (err) {
      log.warn('artifact-enrichment-worker LISTEN init failed, will retry:', err.message);
      pgListenClient = null;
      scheduleListenReconnect();
    }
  } else {
    try {
      const handle = await _getPgLiteForTest();
      if (handle && typeof handle.listen === 'function') {
        unsubscribe = await handle.listen(CHANNEL, () => wakeup());
      }
    } catch (err) {
      log.warn('artifact-enrichment-worker PGlite listen() failed, polling only:', err.message);
    }
  }

  // ── 3. Worker loop state. ──
  let stopped = false;
  let tickInFlight = null;
  let tickQueued = false;
  const inFlightIds = new Set();

  function scheduleTick() {
    if (stopped) return;
    if (tickInFlight) { tickQueued = true; return; }
    tickInFlight = drain().finally(() => {
      tickInFlight = null;
      if (tickQueued && !stopped) {
        tickQueued = false;
        scheduleTick();
      }
    });
  }

  // When true, the daily G10 cap is exhausted — stop draining for this tick so
  // we don't hot-loop re-claiming the row we just released. The poll timer
  // re-tries on the next interval (by when CURRENT_DATE may have rolled or
  // spend been freed). Reset at the top of each drain.
  let capExhausted = false;

  async function drain() {
    capExhausted = false;
    while (!stopped) {
      const claimed = await claimOne();
      if (!claimed) return;
      await processRow(claimed);
      if (stopped) return;
      // A cap skip released the row back to pending; re-claiming it immediately
      // would spin. Yield this tick — the poll timer brings us back.
      if (capExhausted) return;
    }
  }

  async function claimOne() {
    try {
      // Atomic claim: UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED
      // LIMIT 1) AND status='pending'. Two workers racing on a row → only one
      // gets a RETURNING row.
      const result = await query(
        `UPDATE content.enrichment_queue
            SET status = 'processing', updated_at = now()
          WHERE id IN (
            SELECT id FROM content.enrichment_queue
             WHERE status = 'pending'
             ORDER BY created_at
             FOR UPDATE SKIP LOCKED
             LIMIT 1
          )
          RETURNING *`,
      );
      if (result.rows.length === 0) return null;
      const row = result.rows[0];
      inFlightIds.add(row.id);
      return row;
    } catch (err) {
      log.error('artifact-enrichment-worker claimOne failed:', err.message);
      return null;
    }
  }

  async function processRow(row) {
    try {
      // ── G10 hard cap (fail-closed, not fail-loud). Over cap → release the
      // row back to pending and skip; a future tick (after CURRENT_DATE rolls
      // or spend is freed) re-attempts. We do NOT burn an attempt for a cap
      // skip — it isn't the row's fault.
      const spent = await dailySpendMeteredUsd(ENRICHER_AGENT_ID);
      if (spent >= dailyCapUsd) {
        log.warn(`G10 cap reached ($${spent.toFixed(2)} >= $${dailyCapUsd}); leaving queue row ${row.id} pending`);
        await releasePending(row.id);
        inFlightIds.delete(row.id);
        capExhausted = true; // stop draining this tick (don't hot-loop the released row)
        return;
      }

      // Load the artifact's current-version document text, org-scoped.
      const ctx = await loadArtifactDoc(row.artifact_id, row.document_id, row.owner_org_id);
      if (!ctx || !ctx.rawText) {
        // No document text (deleted / not visible / wrong org) → nothing to
        // enrich. Mark done (idempotent no-op) rather than retry forever.
        log.warn(`queue row ${row.id}: no document text for artifact ${row.artifact_id}; marking done`);
        await markDone(row.id);
        inFlightIds.delete(row.id);
        return;
      }

      const extraction = await extractEntities({ text: ctx.rawText, context: ctx.title || '' });
      const entities = Array.isArray(extraction?.entities) ? extraction.entities : [];

      await applyResolution({
        query,
        artifactId: row.artifact_id,
        documentId: row.document_id,
        ownerOrgId: row.owner_org_id,
        entities,
      });

      await markDone(row.id);
    } catch (err) {
      log.error(`artifact enrichment failed for queue row ${row.id}: ${err.message}`);
      await markAttemptOrFailed(row.id).catch((e) =>
        log.error(`could not record attempt/failure for ${row.id}: ${e.message}`),
      );
    } finally {
      inFlightIds.delete(row.id);
    }
  }

  // Load the artifact's CURRENT version document, gated on the artifact's org.
  // The document_id on the queue row is the producer-supplied pin; we re-resolve
  // through artifacts.current_version_id so an edited artifact enriches its
  // latest bytes, and we org-gate every join to enforce tenancy.
  async function loadArtifactDoc(artifactId, queueDocumentId, ownerOrgId) {
    try {
      const r = await query(
        `SELECT d.raw_text, d.title
           FROM content.artifacts a
           JOIN content.artifact_versions av ON av.id = a.current_version_id
           JOIN content.documents d ON d.id = av.document_id
          WHERE a.id = $1
            AND a.owner_org_id = $2`,
        [artifactId, ownerOrgId],
      );
      if (r.rows.length > 0) return { rawText: r.rows[0].raw_text, title: r.rows[0].title };

      // Fallback to the queue's pinned document_id (still org-gated via the
      // artifact) — covers a row enqueued before current_version_id flipped.
      const r2 = await query(
        `SELECT d.raw_text, d.title
           FROM content.documents d
           JOIN content.artifacts a ON a.id = $1 AND a.owner_org_id = $3
          WHERE d.id = $2`,
        [artifactId, queueDocumentId, ownerOrgId],
      );
      if (r2.rows.length > 0) return { rawText: r2.rows[0].raw_text, title: r2.rows[0].title };
      return null;
    } catch (err) {
      log.error(`loadArtifactDoc failed for ${artifactId}: ${err.message}`);
      return null;
    }
  }

  async function markDone(id) {
    await query(
      `UPDATE content.enrichment_queue
          SET status = 'done', updated_at = now()
        WHERE id = $1 AND status = 'processing'`,
      [id],
    );
  }

  // Release a processing row back to pending WITHOUT burning an attempt
  // (used for the G10 cap skip).
  async function releasePending(id) {
    await query(
      `UPDATE content.enrichment_queue
          SET status = 'pending', updated_at = now()
        WHERE id = $1 AND status = 'processing'`,
      [id],
    );
  }

  // On a genuine enrichment error: increment attempts. Below MAX_ATTEMPTS →
  // back to pending for retry; at/after MAX_ATTEMPTS → terminal 'failed'.
  async function markAttemptOrFailed(id) {
    await query(
      `UPDATE content.enrichment_queue
          SET attempts = attempts + 1,
              status = CASE WHEN attempts + 1 >= $2 THEN 'failed' ELSE 'pending' END,
              updated_at = now()
        WHERE id = $1 AND status = 'processing'`,
      [id, MAX_ATTEMPTS],
    );
  }

  // ── 4. Poll timer (NOTIFY-or-poll, whichever comes first). ──
  const timer = setInterval(scheduleTick, pollIntervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  // Kick once on startup so existing pending rows get drained.
  scheduleTick();

  // ── 5. Stop: drain in-flight, release any rows we still hold. ──
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
      const outcome = await Promise.race([settle, abandon]);
      if (abandonTimer) clearTimeout(abandonTimer);
      if (outcome === 'timeout') {
        log.error(
          `artifact-enrichment-worker stop() timed out after ${stopTimeoutMs}ms; abandoning in-flight tick`,
        );
      }
    }

    // Anything still in flight was holding 'processing' — release to pending so
    // a future worker re-enriches it (the 5min orphan sweep is the backstop).
    if (inFlightIds.size > 0) {
      const ids = Array.from(inFlightIds);
      try {
        await query(
          `UPDATE content.enrichment_queue
              SET status = 'pending', updated_at = now()
            WHERE id = ANY($1::uuid[])
              AND status = 'processing'`,
          [ids],
        );
      } catch (err) {
        log.error('artifact-enrichment-worker stop() cleanup failed:', err.message);
      }
      inFlightIds.clear();
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
