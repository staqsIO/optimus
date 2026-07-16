#!/usr/bin/env node
import { config as loadEnv } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
// Shared config (DATABASE_URL etc.) lives in the optimus repo-root .env;
// autobot-inbox/.env is allowed to override per-product. Static-importing
// db.js here would be too early — ESM hoists imports above this code and
// `lib/db.js` reads process.env.DATABASE_URL at module-init time. The
// dynamic imports below run AFTER loadEnv() so the env is populated first.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(__dirname, '../../.env') });
loadEnv({ path: path.resolve(__dirname, '../.env'), override: true });

const { initializeDatabase, query, close } = await import('../src/db.js');
const { parseGeminiTitleTime } = await import('../src/drive/gemini-title.js');

/**
 * Backfill `content.documents.metadata.happenedAt` for Gemini Notes docs.
 *
 * The Drive watcher historically didn't set metadata.happenedAt for
 * gemini-source files, so the calendar and /today/meetings endpoints
 * fall back to created_at — which is the file-creation moment, often
 * hours after the meeting ends. The actual meeting time is embedded in
 * the doc title:
 *
 *   "<Meeting Name> - YYYY/MM/DD HH:MM <TZ> - Notes by Gemini"
 *
 * This script parses every gemini doc's title with the same logic the
 * watcher now uses on ingest, then writes the parsed ISO timestamp into
 * metadata.happenedAt.
 *
 * Defaults to dry-run. Pass --write to actually update rows. Run
 * dry-run first and check the unmatched-titles report before writing.
 *
 * Usage:
 *   npm run backfill:gemini-happened-at                       # dry-run
 *   npm run backfill:gemini-happened-at -- --write            # write
 *   npm run backfill:gemini-happened-at -- --limit 50         # peek
 *   npm run backfill:gemini-happened-at -- --force --write    # overwrite
 *                                                              # existing
 *   npm run backfill:gemini-happened-at -- --show-unmatched 50
 */

function parseArgs(argv) {
  const out = { write: false, limit: null, showUnmatched: 20, showChanges: 10 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--write') out.write = true;
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--show-unmatched') {
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n)) { out.showUnmatched = n; i++; }
    } else if (a === '--show-changes') {
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n)) { out.showChanges = n; i++; }
    } else if (a === '--help' || a === '-h') {
      out.help = true;
    } else {
      console.warn(`(ignoring unknown arg: ${a})`);
    }
  }
  return out;
}

const HELP = `
Backfill content.documents.metadata.happenedAt for Gemini Notes docs.

The title is the source of truth for Gemini meetings (it's auto-generated
by Gemini Notes), so when a title parses, its value wins over any existing
happenedAt — including ISO values that earlier migrations may have set to
file-creation time. Rows whose existing happenedAt already matches the
parsed title are reported as "already correct" with no UPDATE issued.

  --write              Apply updates. Without it, runs in dry-run mode.
  --limit N            Stop after examining N candidate rows.
  --show-changes N     Print up to N before/after pairs in the diff
                       preview (default 10).
  --show-unmatched N   Print up to N unmatched titles (default 20).
  --help, -h           Show this help.
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }

  await initializeDatabase();

  const limitClause = args.limit ? `LIMIT ${Number(args.limit)}` : '';
  const { rows } = await query(
    `
    SELECT id, title, metadata
    FROM content.documents
    WHERE deleted_at IS NULL
      AND (
        source = 'gemini'
        OR (source = 'drive' AND format = 'gemini')
      )
    ORDER BY created_at DESC
    ${limitClause}
    `,
  );

  let parsed = 0;
  let updated = 0;
  let unchanged = 0;
  const changes = [];
  const unmatched = [];

  for (const row of rows) {
    const existing = row.metadata?.happenedAt ?? null;
    const happenedAt = parseGeminiTitleTime(row.title);
    if (!happenedAt) {
      unmatched.push({ id: row.id, title: row.title });
      continue;
    }
    parsed++;

    if (existing === happenedAt) {
      unchanged++;
      continue;
    }

    changes.push({ id: row.id, title: row.title, was: existing, now: happenedAt });

    if (!args.write) continue;

    await query(
      `
      UPDATE content.documents
      SET metadata = jsonb_set(
        COALESCE(metadata, '{}'::jsonb),
        '{happenedAt}',
        to_jsonb($1::text)
      )
      WHERE id = $2
      `,
      [happenedAt, row.id],
    );
    updated++;

    if (updated % 100 === 0) console.log(`  ${updated} rows updated…`);
  }

  console.log('');
  console.log('── backfill-gemini-happened-at ──');
  console.log(`mode             : ${args.write ? 'WRITE' : 'dry-run'}`);
  console.log(`candidates       : ${rows.length}`);
  console.log(`title parsed     : ${parsed}`);
  console.log(`needs update     : ${changes.length}`);
  console.log(`actually updated : ${updated}`);
  console.log(`already correct  : ${unchanged}`);
  console.log(`unmatched titles : ${unmatched.length}`);

  if (changes.length > 0) {
    console.log('');
    console.log(`First ${Math.min(args.showChanges, changes.length)} changes:`);
    for (const c of changes.slice(0, args.showChanges)) {
      const wasStr = c.was ?? '(unset)';
      console.log(`  [${c.id.slice(0, 8)}] ${c.title.slice(0, 60)}${c.title.length > 60 ? '…' : ''}`);
      console.log(`    was: ${wasStr}`);
      console.log(`    now: ${c.now}`);
    }
    if (changes.length > args.showChanges) {
      console.log(`  …and ${changes.length - args.showChanges} more (--show-changes N to see more)`);
    }
  }

  if (unmatched.length > 0) {
    console.log('');
    console.log(`First ${Math.min(args.showUnmatched, unmatched.length)} unmatched titles:`);
    for (const u of unmatched.slice(0, args.showUnmatched)) {
      console.log(`  - ${u.title}  [${u.id.slice(0, 8)}]`);
    }
    if (unmatched.length > args.showUnmatched) {
      console.log(`  …and ${unmatched.length - args.showUnmatched} more (--show-unmatched N to see more)`);
    }
    console.log('');
    console.log('These rows fall back to metadata.happenedAt → created_at on read.');
    console.log('If the patterns above are common, extend src/drive/gemini-title.js.');
  }

  if (!args.write && changes.length > 0) {
    console.log('');
    console.log('Dry-run only — re-run with --write to apply.');
  }
}

main()
  .catch((err) => {
    console.error('Backfill failed:', err.message);
    console.error(err.stack);
    process.exitCode = 1;
  })
  .finally(async () => {
    await close();
  });
