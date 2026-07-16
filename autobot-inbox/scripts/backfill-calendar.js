#!/usr/bin/env node
/**
 * One-shot historic Google Calendar backfill (STAQPRO-327).
 *
 * Pages through `calendarId='primary'` for the configured `accountEmail`
 * (`CALENDAR_ACCOUNT_EMAIL` env var, or `--account-email` flag) and
 * upserts each event into `inbox.calendar_events`.
 *
 * Safe to re-run: dedup is two-layer (`UNIQUE(account_email,
 * gcal_event_id)` + a contentHash short-circuit in
 * `upsertCalendarEvent`), so unchanged events return `{status: 'unchanged'}`.
 *
 * Usage:
 *   node scripts/backfill-calendar.js [--lookback-days 400] [--lookahead-days 14]
 *                                     [--account-email eric@staqs.io]
 *
 * On Railway:
 *   railway run -s autobot-inbox-api node scripts/backfill-calendar.js --lookback-days 60
 *   # ↑ small sanity slice first; review counts; then:
 *   railway run -s autobot-inbox-api node scripts/backfill-calendar.js --lookback-days 400
 */

import { backfillCalendarEvents, isCalendarBackfillRunning } from '../src/calendar/poller.js';

function parseArgs(argv) {
  const out = {
    lookbackDays: 400,
    lookaheadDays: 14,
    accountEmail: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    switch (flag) {
      case '--lookback-days':
        out.lookbackDays = Number(next);
        i++;
        break;
      case '--lookahead-days':
        out.lookaheadDays = Number(next);
        i++;
        break;
      case '--account-email':
        out.accountEmail = next;
        i++;
        break;
      case '--help':
      case '-h':
        // eslint-disable-next-line no-console
        console.log(
          'Usage: node scripts/backfill-calendar.js [--lookback-days N] [--lookahead-days N] [--account-email EMAIL]',
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
  const opts = parseArgs(process.argv.slice(2));
  console.log('[backfill-calendar] starting with', opts);

  if (isCalendarBackfillRunning()) {
    console.error('Another calendar backfill is already running. Refusing to stack.');
    process.exit(1);
  }

  const t0 = Date.now();
  const result = await backfillCalendarEvents(opts);
  const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);

  if (!result.ok) {
    console.error(`[backfill-calendar] failed: ${result.error}`);
    process.exit(1);
  }

  console.log(`[backfill-calendar] done in ${elapsedSec}s`);
  console.log(JSON.stringify(result.stats, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error('[backfill-calendar] unexpected error:', err);
  process.exit(1);
});
