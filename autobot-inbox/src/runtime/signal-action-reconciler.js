/**
 * Signal → action reconciler (Stream B, ADR-008).
 *
 * Batch driver over the signal→action bridge. Selects eligible obligations
 * (resolved=false, not yet bridged, eligible type, confidence >= threshold —
 * matching the signals_bridge_eligible partial index from migration 127),
 * runs bridgeSignal on each, and accumulates a per-run summary.
 *
 * PHASE 0 IS MANUAL + DRY-RUN. This reconciler is intentionally NOT wired into
 * the orchestrator poll loop (ADR-008 phased rollout). It is invoked by hand
 * (CLI main() below) so the board can review the dry-run report over the 2,629
 * backlog before any live promotion. Wiring it into the poll loop is a separate,
 * later change (Stream A / Phase 1) and is out of scope here.
 *
 * Re-export shim convention: this product file imports the org-level bridge from
 * lib/runtime (see autobot-inbox/CLAUDE.md — agents consume lib/ via src shims).
 */

import { fileURLToPath } from 'node:url';
import { query as defaultQuery } from '../../../lib/db.js';
import { getConfig } from '../../../lib/config/loader.js';
import { createChildLogger } from '../../../lib/logger.js';
import { bridgeSignal } from '../../../lib/runtime/signal-action-bridge.js';

const log = createChildLogger({ module: 'runtime/signal-action-reconciler' });

/**
 * Bucket a bridge decision reason for the Phase 0 report. Strips the variable
 * day-count suffix so `not_live:stale_occurred_412d` and
 * `not_live:stale_occurred_46d` aggregate to one `not_live:stale_occurred`
 * bucket. Without this, every stale obligation is its own histogram bar and the
 * board can't see the distribution it needs to judge the recency window
 * (ADR-008 §3, B3 — would-drop must be legible by REASON, not just count).
 *
 * @param {string|undefined} reason
 * @returns {string}
 */
export function bucketReason(reason) {
  if (!reason) return 'unknown';
  // collapse a trailing _<digits>d (stale_occurred_412d, stale_due_99d, ...)
  return String(reason).replace(/_\d+d$/, '');
}

/**
 * Run one reconciliation pass.
 *
 * @param {Object} [opts]
 * @param {Function} [opts.query] - pg-style query fn (defaults to lib/db query)
 * @param {boolean} [opts.dryRun] - overrides config.dryRun when provided
 * @param {number} [opts.limit] - overrides config.batchSize when provided
 * @returns {Promise<{
 *   scanned: number,
 *   byDecision: Record<string, number>,
 *   bySkipReason: Record<string, number>,
 *   byClass: Record<string, number>,
 *   estCostUsd: number,
 *   dryRun: boolean,
 *   capHit: boolean,
 * }>}
 */
export async function runBridgeReconciler({ query = defaultQuery, dryRun, limit } = {}) {
  let cfg;
  try {
    cfg = getConfig('signal-routing');
  } catch {
    cfg = {
      dryRun: true,
      confidenceThreshold: 0.70,
      eligibleSignalTypes: ['commitment', 'request', 'action_item'],
      batchSize: 25,
      perRunCostCapUsd: 2.5,
    };
  }

  const effectiveDryRun = typeof dryRun === 'boolean' ? dryRun : !!cfg.dryRun;
  const batchSize = Number.isFinite(limit) ? limit : (cfg.batchSize ?? 25);
  const costCap = cfg.perRunCostCapUsd ?? 2.5;
  const threshold = cfg.confidenceThreshold ?? 0.70;
  const eligibleTypes = cfg.eligibleSignalTypes ?? ['commitment', 'request', 'action_item'];

  // Select eligible obligations. Predicate mirrors signals_bridge_eligible so
  // Postgres can use the partial index. Oldest-occurred first so the dry-run
  // report drains the stale backlog (the 2,629) in a deterministic order.
  const eligible = await query(
    `SELECT id
       FROM inbox.signals
      WHERE resolved = false
        AND work_item_id IS NULL
        AND bridged_at IS NULL
        AND signal_type = ANY($1)
        AND confidence >= $2
      ORDER BY occurred_at ASC NULLS LAST, created_at ASC
      LIMIT $3`,
    [eligibleTypes, threshold, batchSize],
  );

  const summary = {
    scanned: 0,
    byDecision: {},
    // B3 (ADR-008 §3 Phase 0 exit gate): the board must be able to distinguish a
    // would-drop for a GOOD reason (terminated contact, archived engagement) from
    // one driven purely by the recency window (stale_occurred/stale_due) before
    // dryRun is flipped to false. byDecision alone ('skip: N') hides that. These
    // two breakdowns make the dry-run report legible:
    //   bySkipReason — why each 'skip' (not-live) decision dropped the obligation
    //   byClass      — autonomous vs gated split for would-route decisions
    bySkipReason: {},
    byClass: {},
    estCostUsd: 0,
    dryRun: effectiveDryRun,
    capHit: false,
  };

  for (const { id: signalId } of eligible.rows) {
    if (summary.estCostUsd >= costCap) {
      summary.capHit = true;
      log.warn({ costCap, estCostUsd: summary.estCostUsd, scanned: summary.scanned }, 'per-run cost cap hit; stopping');
      break;
    }

    let result;
    try {
      result = await bridgeSignal({ query, signalId, dryRun: effectiveDryRun });
    } catch (err) {
      log.error({ err: err.message, signalId }, 'bridgeSignal threw; counting as error');
      result = { decision: 'error', reason: err.message, costUsd: 0 };
    }

    summary.scanned += 1;
    const d = result.decision || 'unknown';
    summary.byDecision[d] = (summary.byDecision[d] || 0) + 1;

    // B3: break the two decisions the board cares about down further.
    if (d === 'skip') {
      // not-live drop — bucket by WHY (contact_departed / engagement_archived /
      // stale_occurred / stale_due). This is the histogram that validates the
      // staleness window before going live.
      const sr = bucketReason(result.reason);
      summary.bySkipReason[sr] = (summary.bySkipReason[sr] || 0) + 1;
    } else if (result.klass && (d === 'dryrun' || d === 'created' || d === 'gated')) {
      // would-route — autonomous (auto-acts, no card) vs gated (board card).
      summary.byClass[result.klass] = (summary.byClass[result.klass] || 0) + 1;
    }

    summary.estCostUsd += result.costUsd || 0;
  }

  log.info(summary, 'bridge reconciler pass complete');
  return summary;
}

/**
 * CLI entry — manual Phase 0 invocation. Honors --live to override dryRun and
 * --limit=N. Defaults to config (dry-run). Never auto-wired into the runtime.
 */
async function main() {
  const args = process.argv.slice(2);
  const live = args.includes('--live');
  const limitArg = args.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.split('=')[1]) : undefined;

  const summary = await runBridgeReconciler({
    dryRun: live ? false : undefined,
    limit,
  });

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('reconciler failed:', err);
    process.exit(1);
  });
}
