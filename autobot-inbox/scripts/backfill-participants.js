#!/usr/bin/env node
import 'dotenv/config';
import { initializeDatabase, close } from '../src/db.js';
import { backfillParticipantsCommand } from '../src/cli/commands/backfill-participants.js';

/**
 * Standalone runner for the participant backfill.
 *
 * Usage:
 *   npm run backfill:participants -- --source tldv --dry-run
 *   npm run backfill:participants -- --source all --limit 2000
 *   railway run npm run backfill:participants -- --source all --dry-run
 *
 * Exits non-zero if the command throws. Safe to re-run — the command skips
 * documents whose participants are already populated (pass --force to redo).
 */
async function main() {
  const args = process.argv.slice(2);
  try {
    await initializeDatabase();
    await backfillParticipantsCommand(args);
  } finally {
    await close();
  }
}

main().catch(err => {
  console.error('Backfill failed:', err.message);
  process.exit(1);
});
