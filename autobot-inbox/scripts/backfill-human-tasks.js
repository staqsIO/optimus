#!/usr/bin/env node
/**
 * CLI wrapper around lib/runtime/backfill-human-tasks.
 *
 * Usage:
 *   node scripts/backfill-human-tasks.js              # full backfill
 *   node scripts/backfill-human-tasks.js --dry-run    # count, no writes
 *   node scripts/backfill-human-tasks.js --since 30d  # 30 days back only
 *
 * Loads known board members from agent_graph.board_members. Projects list
 * defaults to empty (domain weight = 0) — the relevance gate will still
 * promote on obligor + speaker match.
 */

import 'dotenv/config';
import { query, close } from '../src/db.js';
import { backfillHumanTasks } from '../../lib/runtime/backfill-human-tasks.js';

/**
 * Parse argv. Exported so tests can hit the branches without spawning the
 * CLI. Accepts the slice starting at the first user-supplied argument
 * (caller passes `process.argv.slice(2)` in production).
 *
 * @param {string[]} argv
 * @returns {{ dryRun: boolean, since: Date|null }}
 */
export function parseArgs(argv) {
  const args = { dryRun: false, since: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--since' || a === '-s') {
      const v = argv[++i];
      if (!v) continue;
      const m = v.match(/^(\d+)d$/);
      args.since = m
        ? new Date(Date.now() - Number(m[1]) * 24 * 60 * 60 * 1000)
        : new Date(v);
    }
  }
  return args;
}

async function loadKnownPeople() {
  const r = await query(
    `SELECT id::text AS id, display_name, github_username, email
       FROM agent_graph.board_members
      WHERE is_active = true`,
  );
  return r.rows.map((row) => ({
    id: row.id,
    display_name: row.display_name,
    aliases: [
      row.display_name,
      row.display_name.split(' ')[0], // first name
      row.github_username,
      row.email,
    ].filter(Boolean),
  }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const knownPeople = await loadKnownPeople();
  const summary = await backfillHumanTasks({
    query,
    knownPeople,
    projects: [],
    dryRun: args.dryRun,
    since: args.since,
  });
  console.log('\nSummary:');
  console.log(JSON.stringify(summary, null, 2));
}

// Only run when invoked directly (not when imported by tests).
import { fileURLToPath } from 'url';
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
    .catch((e) => {
      console.error('backfill failed:', e);
      process.exitCode = 1;
    })
    .finally(() => close().catch(() => {}));
}
