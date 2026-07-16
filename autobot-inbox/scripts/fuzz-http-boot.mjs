#!/usr/bin/env node
/**
 * fuzz-http-boot.mjs — OPT-166 V-8: minimal, committed API boot harness for
 * live-HTTP tenant-isolation fuzzing (STAQPRO-567 PART 1).
 *
 * Boots ONLY the HTTP API (`startApiServer` from src/api.js) against an
 * already-migrated Postgres, WITHOUT calling `initializeDatabase()`.
 * `initializeDatabase()` runs `CREATE TABLE public._migrations` and applies
 * every SQL migration — both 42501-deny under a NOSUPERUSER NOBYPASSRLS role
 * like `autobot_agent`. This script exists so a caller (the flip-readiness
 * sensor) can exercise the API in the exact post-STAQPRO-263-flip posture:
 * pool connects as `autobot_agent`, migrations already applied by a prior
 * superuser phase.
 *
 * `src/index.js`'s normal boot sequence already calls `initializeDatabase()`
 * and `startApiServer()` as two independent, sequential steps — this script
 * simply skips the first one. No changes to src/api.js were required.
 *
 * Env in (all required):
 *   DATABASE_URL   — postgresql://autobot_agent:<pw>@host:port/db (flip posture)
 *   API_SECRET     — legacy Bearer secret for requireLegacyAuth (see src/api.js)
 *   PORT           — port to listen on
 *
 * Signals SIGTERM/SIGINT close the server and exit cleanly, so a parent
 * process (the sensor) can tear this down deterministically.
 *
 * Usage: node autobot-inbox/scripts/fuzz-http-boot.mjs
 */

import { startApiServer } from '../src/api.js';

const port = Number(process.env.PORT);
if (!port) {
  console.error('[fuzz-http-boot] PORT env var required');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('[fuzz-http-boot] DATABASE_URL env var required');
  process.exit(1);
}
if (!process.env.API_SECRET) {
  console.error('[fuzz-http-boot] API_SECRET env var required');
  process.exit(1);
}

const server = startApiServer(port);

// Signal readiness on a line the parent process can grep for, in addition to
// the real readiness probe (parent polls via HTTP OPTIONS — this is belt +
// suspenders for debugging a hung boot).
console.log(`[fuzz-http-boot] listening on ${port} (DATABASE_URL mode: flip posture, autobot_agent)`);

function shutdown() {
  server.close(() => process.exit(0));
  // Force-exit if close() hangs on an open keep-alive connection.
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
