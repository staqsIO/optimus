#!/usr/bin/env node
/**
 * One-shot historic TLDv transcript backfill (STAQPRO-325).
 *
 * Pages through the TLDv API and ingests each meeting into the RAG corpus.
 * Safe to re-run: `ingestTldvMeeting` dedupes on (source='tldv', source_id)
 * + a contentHash check, so existing rows return {status:'skipped'}.
 *
 * For historic backfills we explicitly **skip work-item creation**: each
 * meeting still lands in `content.documents` for RAG retrieval and the
 * participants resolver still populates `signal.contacts`, but the
 * orchestrator + intake + responder agents are NOT triggered. Year-old
 * meetings shouldn't surface as fresh action items.
 *
 * Usage:
 *   node scripts/backfill-tldv.js [--lookback-days 400] [--max-pages 100]
 *                                 [--page-size 50] [--with-work-items]
 *
 *   --lookback-days N   Lookback window in days (default 400; covers May 2025+)
 *   --max-pages N       Page cap (default 100; hard ceiling 200 in poller)
 *   --page-size N       Per-page meetings (default 50; max 100)
 *   --with-work-items   Override the default and DO create work_items
 *                       (matches the live 5-min poller behaviour)
 *
 * On Railway:
 *   railway run -s autobot-inbox-api node scripts/backfill-tldv.js --lookback-days 60
 *   # ↑ small sanity slice first; review counts; then:
 *   railway run -s autobot-inbox-api node scripts/backfill-tldv.js --lookback-days 400
 */

import { backfillTldvTranscripts, isTldvBackfillRunning } from '../src/tldv/poller.js';

function parseArgs(argv) {
  const out = {
    lookbackDays: 400,
    maxPages: 100,
    pageSize: 50,
    skipWorkItem: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    switch (flag) {
      case '--lookback-days':
        out.lookbackDays = Number(next);
        i++;
        break;
      case '--max-pages':
        out.maxPages = Number(next);
        i++;
        break;
      case '--page-size':
        out.pageSize = Number(next);
        i++;
        break;
      case '--with-work-items':
        out.skipWorkItem = false;
        break;
      case '--help':
      case '-h':
        // eslint-disable-next-line no-console
        console.log(
          'Usage: node scripts/backfill-tldv.js [--lookback-days N] [--max-pages N] [--page-size N] [--with-work-items]'
        );
        process.exit(0);
        break;
      default:
        if (flag?.startsWith('--')) {
          console.warn(`Unknown flag: ${flag}`);
          process.exit(2);
        }
    }
  }
  return out;
}

async function main() {
  if (!process.env.TLDV_API_KEY) {
    console.error('TLDV_API_KEY is not set. Run via `railway run` or export it in your shell.');
    process.exit(1);
  }

  const opts = parseArgs(process.argv.slice(2));
  console.log('[backfill-tldv] starting with', opts);

  if (isTldvBackfillRunning()) {
    console.error('Another TLDv backfill is already running. Refusing to stack.');
    process.exit(1);
  }

  const t0 = Date.now();
  const result = await backfillTldvTranscripts(opts);
  const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);

  if (!result.ok) {
    console.error(`[backfill-tldv] failed: ${result.error}`);
    process.exit(1);
  }

  console.log(`[backfill-tldv] done in ${elapsedSec}s`);
  console.log(JSON.stringify(result.stats, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error('[backfill-tldv] unexpected error:', err);
  process.exit(1);
});
