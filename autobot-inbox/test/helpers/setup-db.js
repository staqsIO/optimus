/**
 * Shared test database setup — single import replaces custom before() hooks.
 *
 * Usage in test files:
 *   import { getDb } from './helpers/setup-db.js';
 *
 *   describe('my tests', () => {
 *     let query;
 *     before(async () => { ({ query } = await getDb()); });
 *     // NOTE: Do NOT call close() — PGlite cannot reinitialize after close
 *     // within the same Node process. The process exit handles cleanup.
 *   });
 *
 * Handles: PGlite init, role creation, migration execution, common seed data.
 * Cached: multiple imports in the same process reuse the same instance.
 *
 * DB mode selection:
 *   - FORCE_PGLITE=true  → always use PGlite (ignores DATABASE_URL)
 *   - DATABASE_URL set   → use real Postgres (passthrough for deep-research tests etc.)
 *   - neither            → use PGlite with an ephemeral temp dir (isolated per run)
 *
 * PGlite isolation: each test run creates a fresh PGLITE_DATA_DIR under os.tmpdir().
 * The temp dir is deleted on process exit, preventing cross-run state bleed.
 */

import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { rmSync } from 'fs';

let _db = null;
let _initPromise = null;
let _tempDataDir = null;

/**
 * Get an initialized database connection. Cached — safe to call multiple times.
 * Returns { query, close, initializeDatabase }.
 */
async function withTemporaryEnv(overrides, fn) {
  const previous = {};

  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = Object.prototype.hasOwnProperty.call(process.env, key)
      ? process.env[key]
      : undefined;

    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

/**
 * Get an initialized database connection. Cached — safe to call multiple times.
 * Returns { query, close, initializeDatabase }.
 */
export async function getDb(options = {}) {
  if (_db) return _db;
  if (_initPromise) return _initPromise;

  _initPromise = _init(options);
  _db = await _initPromise;
  return _db;
}

async function _init(options = {}) {
  const { fileURLToPath } = await import('url');
  const forcePGlite =
    options.forcePGlite ??
    (process.env.FORCE_PGLITE === 'true' || !process.env.DATABASE_URL);
  const sqlDir = fileURLToPath(new URL('../../sql', import.meta.url));

  let db;
  if (forcePGlite) {
    // Create an ephemeral temp dir for this test run so DB state never bleeds
    // between runs. Set it persistently (not inside withTemporaryEnv) because
    // getPgLite() reads PGLITE_DATA_DIR lazily — after the import() completes.
    _tempDataDir = `${tmpdir()}/pglite-test-${randomUUID()}`;
    process.env.PGLITE_DATA_DIR = _tempDataDir;

    db = await withTemporaryEnv(
      { DATABASE_URL: undefined, NODE_ENV: 'test', SQL_DIR: sqlDir },
      () => import('../../src/db.js')
    );

    // Clean up the temp dir on process exit (handles normal exit and SIGINT).
    process.on('exit', () => {
      try { rmSync(_tempDataDir, { recursive: true, force: true }); } catch {}
    });
  } else {
    // DATABASE_URL is set — pass through to real Postgres (e.g. deep-research tests).
    db = await import('../../src/db.js');
  }
  const { query, close, initializeDatabase } = db;

  // PGlite lacks roles that production Postgres has — db.js pre-creates them
  // since our fix, but call initializeDatabase to run migrations
  await initializeDatabase();

  // Seed common agent_configs (FK references used by most tests)
  await query(`
    INSERT INTO agent_graph.agent_configs (id, agent_type, model, system_prompt, config_hash, is_active)
    VALUES
      ('orchestrator', 'orchestrator', 'sonnet', 'test', 'testhash', true),
      ('strategist', 'strategist', 'opus', 'test', 'testhash', true),
      ('executor-intake', 'executor', 'haiku', 'test', 'testhash', true),
      ('executor-triage', 'executor', 'haiku', 'test', 'testhash', true),
      ('executor-responder', 'executor', 'haiku', 'test', 'testhash', true),
      ('executor-ticket', 'executor', 'haiku', 'test', 'testhash', true),
      ('executor-coder', 'executor', 'sonnet', 'test', 'testhash', true),
      ('executor-research', 'executor', 'sonnet', 'test', 'testhash', true),
      ('executor-redesign', 'executor', 'sonnet', 'test', 'testhash', true),
      ('executor-blueprint', 'executor', 'sonnet', 'test', 'testhash', true),
      ('reviewer', 'reviewer', 'sonnet', 'test', 'testhash', true),
      ('architect', 'architect', 'sonnet', 'test', 'testhash', true),
      ('board', 'board', 'sonnet', 'test', 'testhash', true),
      ('claw-campaigner', 'orchestrator', 'sonnet', 'test', 'testhash', true),
      ('claw-workshop', 'orchestrator', 'sonnet', 'test', 'testhash', true)
    ON CONFLICT (id) DO NOTHING
  `);

  // Seed a daily budget period (required by G1 budget checks)
  await query(`
    INSERT INTO agent_graph.budget_periods (id, period_start, period_end, ceiling_usd)
    VALUES ('test-budget', CURRENT_DATE, CURRENT_DATE + INTERVAL '1 day', 100.00)
    ON CONFLICT DO NOTHING
  `).catch(() => {}); // table may not exist in all migration versions

  // Seed assignment rules (required by delegation checks)
  const assignmentRulesTable = await query(`
    SELECT to_regclass('agent_graph.agent_assignment_rules') AS table_name
  `);

  if (assignmentRulesTable.rows[0]?.table_name) {
    await query(`
      INSERT INTO agent_graph.agent_assignment_rules (agent_id, can_assign)
      VALUES
        ('orchestrator', 'executor-intake'),
        ('orchestrator', 'executor-triage'),
        ('orchestrator', 'executor-responder'),
        ('orchestrator', 'executor-ticket'),
        ('orchestrator', 'executor-coder'),
        ('orchestrator', 'reviewer'),
        ('orchestrator', 'strategist')
      ON CONFLICT DO NOTHING
    `);
  }
  return { query, close, initializeDatabase };
}
