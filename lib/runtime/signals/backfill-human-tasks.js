/**
 * Backfill: scan existing inbox.signals across ALL channels (ADR-008 Stream A
 * extends coverage from meetings-only to email + meetings) and run them through
 * the promoter. Idempotent — re-running yields `already_promoted` for everything
 * previously seeded.
 *
 * PRD §10.1 Week 1, item 4: "Backfill script: re-run on existing meeting
 * signals to seed the board." — now widened to all channels.
 *
 * The scan is CHUNKED with a cursor on inbox.signals.id (Linus #6): it pages
 * `pageSize` rows at a time and is resumable, never issuing one unbounded query
 * over a large (2,629+ row) backlog.
 *
 * If knownPeople is not supplied, it is loaded once from signal.contacts (with
 * aliases) so the relevance gate works for email obligations — without aliases
 * every email obligation scores 0 and is skipped.
 *
 * Called either as a library from tests / cron, or via the thin CLI in
 * scripts/backfill-human-tasks.js. NOT auto-run here — see Phase 0.
 */

import { promoteSignal, extractObligor } from '../signal-task-promoter.js';
import { gate } from '../human-task-relevance.js';
import { loadKnownPeople } from '../promote-live.js';

const DEFAULT_PAGE_SIZE = 200;

/**
 * @param {Object} opts
 * @param {Function} opts.query - pg-style query fn
 * @param {Array} [opts.knownPeople] - pre-loaded; loaded from signal.contacts if omitted
 * @param {Array} [opts.projects]
 * @param {boolean} [opts.dryRun=false]
 * @param {Date|string} [opts.since] - lower bound for inbox.signals.created_at
 * @param {number} [opts.pageSize=200] - cursor page size for the chunked scan
 * @param {Object} [opts.meta] - shared speakers/obligor for the run (the
 *   CLI variant tends to leave this empty and rely on extractObligor +
 *   metadata-free relevance — the test variant passes speakers directly)
 * @param {(s: string) => void} [opts.log] - logger (default console.log)
 * @returns {Promise<{
 *   scanned: number,
 *   promoted_auto: number,
 *   promoted_proposed: number,
 *   skipped: number,
 *   not_applicable: number,
 *   already_promoted: number,
 *   dryRun: boolean,
 * }>}
 */
export async function backfillHumanTasks({
  query,
  knownPeople = null,
  projects = [],
  dryRun = false,
  since = null,
  pageSize = DEFAULT_PAGE_SIZE,
  meta = {},
  log = (msg) => console.log(`[backfill-human-tasks] ${msg}`),
} = {}) {
  if (!query) throw new Error('backfillHumanTasks requires { query }');

  const sinceIso = since
    ? (since instanceof Date ? since.toISOString() : new Date(since).toISOString())
    : null;

  // Load knownPeople once (with aliases) so the relevance gate can match
  // obligors on email obligations. Caller may pre-supply to skip the load.
  const people = knownPeople ?? (await loadKnownPeople(query));

  const summary = {
    scanned: 0,
    promoted_auto: 0,
    promoted_proposed: 0,
    skipped: 0,
    not_applicable: 0,
    already_promoted: 0,
    dryRun,
  };

  // Chunked cursor scan on the string PK. No channel filter (all channels are
  // promotable now); the optional `since` floor still applies.
  let cursor = '';
  for (;;) {
    const params = [cursor, pageSize];
    if (sinceIso) params.push(sinceIso);
    const rows = await query(
      `SELECT s.id, s.signal_type, s.content, s.domain
         FROM inbox.signals s
        WHERE s.signal_type IN ('action_item', 'commitment', 'request', 'decision')
          AND s.id > $1
          ${sinceIso ? 'AND s.created_at >= $3' : ''}
        ORDER BY s.id ASC
        LIMIT $2`,
      params,
    );
    if (rows.rows.length === 0) break;

    for (const r of rows.rows) {
      summary.scanned++;
      if (dryRun) {
        // Run the gate locally for accurate bucket counts. No INSERT, no
        // signal metadata stamp — pure preview.
        const obligor = meta.obligor ?? extractObligor(r.content);
        const speakers = Array.isArray(meta.speakers) ? meta.speakers : [];
        const decision = gate({
          obligor,
          speakers,
          knownPeople: people,
          domain: r.domain || undefined,
          projects,
        }).decision;
        // Decisions land done-from-creation but for a dry-run summary that is
        // still a "promote" event — so we don't special-case it here.
        switch (decision) {
          case 'auto':    summary.promoted_auto++; break;
          case 'propose': summary.promoted_proposed++; break;
          case 'skip':    summary.skipped++; break;
          default:        summary.not_applicable++;
        }
        continue;
      }
      const result = await promoteSignal({
        query, signalId: r.id, knownPeople: people, projects, meta,
      });
      switch (result.decision) {
        case 'auto':              summary.promoted_auto++; break;
        case 'propose':           summary.promoted_proposed++; break;
        case 'skip':              summary.skipped++; break;
        case 'already_promoted':  summary.already_promoted++; break;
        case 'not_applicable':    summary.not_applicable++; break;
        default:                  summary.not_applicable++;
      }
    }

    cursor = rows.rows[rows.rows.length - 1].id;
    if (rows.rows.length < pageSize) break; // last page
  }

  log(JSON.stringify({ event: 'backfill-summary', ...summary }));
  return summary;
}
