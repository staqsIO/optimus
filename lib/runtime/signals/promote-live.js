/**
 * Live signal → human_tasks promotion (Stream A of ADR-008).
 *
 * Until now `promoteSignal` (signal-task-promoter.js) was reachable ONLY from
 * the backfill script — newly-extracted obligations were never promoted to the
 * resolvable, relevance-gated inbox.human_tasks board. They sat in inbox.signals
 * with resolved=false forever (the "set up Lester" bug). This module is the live
 * wiring: call it best-effort, immediately after a signal INSERT, to promote the
 * freshly-inserted signals.
 *
 * Two responsibilities, deliberately separate:
 *   - promoteSignalsLive(): given a list of just-inserted signal IDs, load
 *     knownPeople once and promote each. Used at INSERT sites.
 *   - catchUpPromotions(): a resumable scan that promotes eligible unpromoted
 *     signals. promoteSignal is idempotent on signal_id, so this is safe to run
 *     alongside the INSERT-site wiring and as a backstop.
 *
 * Liveness preflight (ADR-008 §3): before promoting, isStillLive() resolves the
 * obligation against context (departed contact / archived engagement) with a
 * recency fallback. A dead obligation is NOT turned into a board card — its
 * signal is stamped relevance_skipped so it stops surfacing. This is what kills
 * Lester structurally rather than by date heuristic alone.
 *
 * Design constraints:
 *   - Best-effort, non-blocking: callers wrap in try/catch and NEVER let a
 *     promotion failure break ingestion (P3 — provenance is a side effect, not a
 *     gate on the primary write).
 *   - Parameterized queries only (P2/P4). ES modules.
 */

import { promoteSignal } from '../signal-task-promoter.js';
import { isStillLive } from '../signal-action-bridge.js';

/**
 * Build the knownPeople array the relevance gate (human-task-relevance.js)
 * expects: [{ id, name, aliases: [...] }]. The gate matches obligor/speaker
 * names against each person's `aliases` by case-insensitive equality, so for
 * email obligations to score at all we must seed aliases — without them every
 * email obligation scores 0 and is skipped (task requirement).
 *
 * Aliases per contact = the display name, the name tokens (first / last), and
 * the email local-part. Tokens shorter than 2 chars are dropped to avoid noise.
 *
 * @param {Function} query - pg-style (text, params) => { rows }
 * @returns {Promise<Array<{id: string, name: string|null, aliases: string[]}>>}
 */
export async function loadKnownPeople(query) {
  let rows = [];
  try {
    const r = await query(
      `SELECT id, name, email_address FROM signal.contacts`,
    );
    rows = r.rows || [];
  } catch {
    // No contacts table (stripped test DB) or transient error — return empty.
    // The gate still runs; obligations simply won't get an obligor-match boost.
    return [];
  }

  return rows.map((c) => {
    const aliases = new Set();
    const name = c.name || null;
    if (name) {
      aliases.add(name.trim());
      for (const tok of String(name).split(/\s+/)) {
        const clean = tok.trim();
        if (clean.length >= 2) aliases.add(clean);
      }
    }
    if (c.email_address) {
      const lp = String(c.email_address).split('@')[0].trim();
      if (lp.length >= 2) aliases.add(lp);
    }
    return { id: c.id, name, aliases: [...aliases].filter(Boolean) };
  });
}

/**
 * Load active Optimus projects for the relevance gate's domain band.
 * Best-effort; returns [] on any error.
 *
 * @param {Function} query
 * @returns {Promise<Array>}
 */
async function loadProjects(query) {
  try {
    const r = await query(`SELECT id, slug, name FROM agent_graph.projects`);
    return r.rows || [];
  } catch {
    return [];
  }
}

/**
 * Liveness preflight + skip-stamp for a single signal. Returns true when the
 * signal is live (caller should promote), false when it was stamped as
 * not-live (caller should NOT promote — the obligation is dead).
 *
 * Reads the minimal columns isStillLive needs (id, contact_id, occurred_at,
 * due_date). Fails OPEN: any error here returns true (proceed to promote)
 * rather than silently dropping a possibly-live obligation — isStillLive
 * itself already fails open on lookup errors, this guard only covers the
 * row-load.
 *
 * @param {Function} query
 * @param {string} signalId
 * @returns {Promise<boolean>}
 */
async function preflightLive(query, signalId) {
  let sig;
  try {
    const r = await query(
      `SELECT id, contact_id, occurred_at, due_date
         FROM inbox.signals
        WHERE id = $1`,
      [signalId],
    );
    sig = r.rows[0];
  } catch {
    return true; // fail open — let promoteSignal proceed
  }
  if (!sig) return true; // promoteSignal will report not_applicable itself

  let liveness;
  try {
    liveness = await isStillLive({ query, sig });
  } catch {
    return true; // fail open
  }
  if (liveness.live) return true;

  // Dead obligation — stamp the signal so it stops surfacing and is auditable.
  // Mirrors the bridge's resolution stamp shape (resolution_reason) plus the
  // promoter's relevance_skipped marker so both /meetings and /today filters
  // treat it consistently. Best-effort.
  try {
    await query(
      `UPDATE inbox.signals
          SET metadata = COALESCE(metadata, '{}'::jsonb)
                        || jsonb_build_object(
                             'relevance_skipped', true,
                             'live_skip_reason', $2::text,
                             'live_skipped_at', to_jsonb(now())
                           )
        WHERE id = $1`,
      [signalId, `not_live:${liveness.reason}`],
    );
  } catch {
    // non-fatal
  }
  return false;
}

/**
 * Promote a batch of just-inserted signals to inbox.human_tasks, best-effort.
 * Loads knownPeople + projects ONCE for the batch (the relevance gate needs
 * knownPeople — especially for email). Each signal is liveness-preflighted;
 * dead obligations are stamped and skipped, never promoted.
 *
 * NEVER throws — this is called inline with ingestion and must not break it.
 *
 * @param {Object} opts
 * @param {Function} opts.query - pg-style query fn
 * @param {Array<string|number>} opts.signalIds - ids just inserted
 * @param {Array} [opts.knownPeople] - pre-loaded (skips the per-call load)
 * @param {Array} [opts.projects] - pre-loaded
 * @param {Object} [opts.meta] - shared {speakers, obligor, source_ts} for the batch
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{promoted: number, skipped: number, errors: number}>}
 */
export async function promoteSignalsLive({
  query,
  signalIds = [],
  knownPeople = null,
  projects = null,
  meta = {},
  log = (msg) => console.log(`[promote-live] ${msg}`),
} = {}) {
  const out = { promoted: 0, skipped: 0, errors: 0 };
  if (!query || !Array.isArray(signalIds) || signalIds.length === 0) return out;

  const people = knownPeople ?? (await loadKnownPeople(query));
  const projs = projects ?? (await loadProjects(query));

  for (const signalId of signalIds) {
    if (signalId == null) continue;
    try {
      const live = await preflightLive(query, signalId);
      if (!live) {
        out.skipped++;
        continue;
      }
      const result = await promoteSignal({
        query, signalId, knownPeople: people, projects: projs, meta,
      });
      if (result.decision === 'auto' || result.decision === 'propose') {
        out.promoted++;
      } else {
        out.skipped++;
      }
    } catch (err) {
      out.errors++;
      log(`promote failed for signal ${signalId}: ${err.message}`);
    }
  }

  if (out.promoted > 0 || out.errors > 0) {
    log(JSON.stringify({ event: 'promote-live', ...out }));
  }
  return out;
}

/**
 * Resumable catch-up pass: promote eligible, unpromoted signals. A backstop for
 * any signal that missed live promotion at its INSERT site. promoteSignal is
 * idempotent on signal_id (returns already_promoted), so this is safe to run
 * repeatedly and alongside the INSERT-site wiring.
 *
 * Cursors on inbox.signals.id (string PK) in pages, so it is resumable and never
 * issues one unbounded scan (Linus #6, mirrors the chunked backfill).
 *
 * NEVER throws.
 *
 * @param {Object} opts
 * @param {Function} opts.query
 * @param {number} [opts.pageSize=200]
 * @param {number} [opts.maxPages=50] - safety bound so a cron tick is finite
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{scanned: number, promoted: number, skipped: number, errors: number}>}
 */
export async function catchUpPromotions({
  query,
  pageSize = 200,
  maxPages = 50,
  log = (msg) => console.log(`[promote-live] ${msg}`),
} = {}) {
  const out = { scanned: 0, promoted: 0, skipped: 0, errors: 0 };
  if (!query) return out;

  const people = await loadKnownPeople(query);
  const projs = await loadProjects(query);

  let cursor = '';
  for (let page = 0; page < maxPages; page++) {
    let rows;
    try {
      const r = await query(
        `SELECT s.id
           FROM inbox.signals s
          WHERE s.resolved = false
            AND s.signal_type IN ('action_item', 'commitment', 'request', 'decision')
            AND s.id > $1
            AND NOT EXISTS (
              SELECT 1 FROM inbox.human_tasks ht
               WHERE ht.signal_id = s.id AND ht.deleted_at IS NULL
            )
          ORDER BY s.id ASC
          LIMIT $2`,
        [cursor, pageSize],
      );
      rows = r.rows || [];
    } catch (err) {
      log(`catch-up scan failed at cursor ${cursor}: ${err.message}`);
      break;
    }
    if (rows.length === 0) break;

    const ids = rows.map((r) => r.id);
    const res = await promoteSignalsLive({ query, signalIds: ids, knownPeople: people, projects: projs, log });
    out.scanned += ids.length;
    out.promoted += res.promoted;
    out.skipped += res.skipped;
    out.errors += res.errors;

    cursor = rows[rows.length - 1].id;
    if (rows.length < pageSize) break; // last page
  }

  log(JSON.stringify({ event: 'catch-up-summary', ...out }));
  return out;
}
