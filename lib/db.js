import { createHash } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, readdirSync, mkdirSync, existsSync } from 'fs';
import { createLogger } from './logger.js';
const log = createLogger('db');

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = process.env.SQL_DIR || (existsSync(join(process.cwd(), 'sql'))
  ? join(process.cwd(), 'sql')
  : join(__dirname, '..', 'sql'));

/**
 * Dual-mode database layer.
 *
 * DATABASE_URL set → real Postgres via `pg` Pool (production/Supabase).
 * DATABASE_URL unset → PGlite in-process (demo/dev).
 *
 * Same API surface either way: query(), withTransaction(), setAgentContext(), close().
 * P4: Boring infrastructure. No ORM. Parameterized queries only.
 */

const USE_REAL_PG = !!process.env.DATABASE_URL;
let pool = null;   // pg.Pool (real Postgres mode)
let pglite = null; // PGlite instance (demo mode)

// PGlite has a single session: a global query() issued while a transaction is
// open blocks on the session mutex until COMMIT — but the transaction is
// awaiting that very query, so the whole engine deadlocks permanently (every
// agent loop freezes with no error). Real Postgres never hits this because the
// pool hands the global query a second connection. This store lets query()
// detect "I am being called from inside withTransaction's async context" and
// join the open transaction — which is exactly what a single Postgres session
// would do with the same call sequence.
const pgliteTxStore = new AsyncLocalStorage();
let pgliteSavepointSeq = 0;

// Phase 1 shutdown-race guard: set true the moment close() begins tearing down
// the pool. query()/getPgPool() reject once this is set so a late in-flight
// call can never touch an ended pool (which throws an opaque "Cannot use a pool
// after calling end on the pool"). Normal-path behavior is unchanged while false.
let _closing = false;

// ============================================================
// Circuit breaker — skip non-critical DB ops when pool is unhealthy
// ============================================================
let _consecutiveErrors = 0;
let _circuitOpenUntil = 0;
let _circuitTripped = false;
const CIRCUIT_THRESHOLD = 3;       // errors before tripping
const CIRCUIT_COOLDOWN_MS = 30_000; // 30s backoff when tripped

function recordDbSuccess() {
  if (_circuitTripped) {
    log.info(`Circuit breaker CLOSED — connection recovered after ${_consecutiveErrors} errors`);
    _circuitTripped = false;
  }
  _consecutiveErrors = 0;
}
function recordDbError() {
  _consecutiveErrors++;
  if (_consecutiveErrors >= CIRCUIT_THRESHOLD) {
    _circuitOpenUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
    // Only log on initial trip, not every subsequent error
    if (!_circuitTripped) {
      log.warn(`Circuit breaker OPEN — skipping non-critical ops for ${CIRCUIT_COOLDOWN_MS / 1000}s`);
      _circuitTripped = true;
    }
  }
}

/**
 * Returns true if the DB circuit breaker is open (pool is unhealthy).
 * Non-critical callers (heartbeats, polling) should skip when true.
 */
export function isCircuitOpen() {
  if (_consecutiveErrors < CIRCUIT_THRESHOLD) return false;
  if (Date.now() > _circuitOpenUntil) {
    // Allow a probe — reset threshold but keep count at threshold-1
    _consecutiveErrors = CIRCUIT_THRESHOLD - 1;
    return false;
  }
  return true;
}

// ============================================================
// Initialization
// ============================================================

// STAQPRO-303 PR-B-2: switch the pool's connecting role from the Supabase
// `postgres.<project>` superuser to the unprivileged `autobot_agent` role.
//
// Why: superuser BYPASSES RLS entirely (Postgres always exempts the role
// owner / superuser from row-level security, regardless of FORCE). All of
// the `current_agent_id()`-keyed policies that ship in 001-baseline.sql are
// therefore dead code today — they only activate once the connecting role
// is unprivileged. PR-B-prereq.1e (the FORCE ROW LEVEL SECURITY migration
// shipping alongside this code change) flips the policy enforcement on, but
// is meaningless until the pool stops connecting as superuser.
//
// Rollout: gated by env var AUTOBOT_AGENT_DB_PASSWORD. When set, we rewrite
// the DATABASE_URL's userinfo to `autobot_agent[:<project>]` with that
// password and connect as the unprivileged role. When unset, we connect as
// whatever DATABASE_URL specifies (today: superuser) and log a one-shot
// warning so the deviation is visible in production logs. Gating is
// deliberate: missing the rollout env in a local dev env would silently
// break every query, and the failure mode (RLS now active for the first
// time) is the exact thing this work is enabling — so a clean opt-in
// switch in Railway is the only safe rollout.
//
// Supabase pooler convention: PgBouncer demands the username include the
// project ref as a suffix, e.g. `postgres.<project>` or
// `autobot_agent.<project>`. For non-Supabase hosts (Railway internal,
// localhost) we use a bare `autobot_agent`.
function applyAutobotAgentRole(urlObj, { isSupabase, log }) {
  const password = process.env.AUTOBOT_AGENT_DB_PASSWORD;
  if (!password) {
    // One-shot superuser warning — surfaces in Railway logs that the pool
    // is still connecting as the privileged role and RLS is therefore
    // bypassed. Remove the warning once AUTOBOT_AGENT_DB_PASSWORD is wired
    // into every environment that runs this code. Worded env-agnostically
    // (OPT-166 P4): the active connection string may be DATABASE_URL
    // (legacy) or DATABASE_URL_SUPERUSER (explicit flip-window rollback,
    // see selectDbConnectionSource()) — either way the role is unprivileged
    // to RLS iff the connection string itself carries superuser creds.
    log.warn(
      '[STAQPRO-303 PR-B-2] AUTOBOT_AGENT_DB_PASSWORD not set — pool will ' +
      'connect as the role embedded in the active connection string. If ' +
      'that role is a superuser (Supabase postgres.<project>), RLS is BYPASSED.'
    );
    return urlObj;
  }
  // Derive the project ref (Supabase pooler usernames are `user.<projectref>`)
  // from the existing DATABASE_URL username. Falls back to bare `autobot_agent`
  // when the existing user has no dot suffix (non-Supabase hosts).
  let newUser = 'autobot_agent';
  if (isSupabase) {
    const currentUser = decodeURIComponent(urlObj.username || '');
    const dotIdx = currentUser.indexOf('.');
    if (dotIdx > -1) {
      const projectRef = currentUser.slice(dotIdx + 1);
      newUser = `autobot_agent.${projectRef}`;
    }
  }
  urlObj.username = encodeURIComponent(newUser);
  urlObj.password = encodeURIComponent(password);
  log.info(
    `[STAQPRO-303 PR-B-2] Pool will connect as unprivileged role "${newUser}" ` +
    `— RLS policies are now enforced.`
  );
  return urlObj;
}

/**
 * STAQPRO-* Phase 2 (query-pool split): derive the QUERY pool's connection
 * string from DATABASE_URL.
 *
 * The architecture splits the two Supabase pooler ports:
 *   - port 5432 (SESSION pooler)     → LISTEN connections only
 *     (lib/runtime/pg-listener.js + the signal workers). Session mode keeps a
 *     dedicated server connection, which LISTEN requires. UNCHANGED here —
 *     those clients connect with the RAW process.env.DATABASE_URL.
 *   - port 6543 (TRANSACTION pooler) → the query pool (this function).
 *     Transaction mode multiplexes many clients onto few server connections,
 *     killing the session-connection exhaustion (EMAXCONNSESSION). LISTEN is
 *     unsupported under transaction mode — that is exactly why queries and
 *     LISTEN are split onto different ports.
 *
 * Derivation rules:
 *   - DATABASE_URL_QUERY set  → use it verbatim (lets a deploy pin 6543
 *     explicitly, incl. a different host if Supabase ever splits them).
 *   - else, isSupabase        → swap ONLY the authority port 5432 → 6543 via
 *     new URL().port (never a string-replace, so a literal "5432" elsewhere in
 *     the URL — e.g. in a password — is never touched). pgbouncer=true is kept
 *     so node-postgres disables named prepared statements (required for
 *     transaction pooling).
 *   - else (non-Supabase: localhost/127.0.0.1/.railway.internal/Docker) →
 *     return DATABASE_URL unchanged. No port swap; behavior is identical to
 *     pre-Phase-2.
 *
 * Pure + exported for unit testing. Does NOT apply the autobot_agent role
 * rewrite — the caller runs applyAutobotAgentRole() on the returned URL so the
 * role swap lands on the DERIVED (6543) query URL, not the raw 5432 one.
 *
 * @param {string} databaseUrl  the raw DATABASE_URL (session pooler / 5432)
 * @param {{ isSupabase: boolean, queryUrlOverride?: string }} opts
 * @returns {string} the query pool connection string
 */
export function deriveQueryPoolUrl(databaseUrl, { isSupabase, queryUrlOverride } = {}) {
  // 1. Explicit override always wins. Enforce pgbouncer=true even here — a 6543
  //    transaction-pooler URL without it makes node-postgres issue named prepared
  //    statements, which error non-deterministically under load (Linus blocker).
  //    Operators shouldn't have to remember the flag.
  if (queryUrlOverride) {
    const ov = new URL(queryUrlOverride);
    if (!ov.searchParams.has('pgbouncer')) {
      ov.searchParams.set('pgbouncer', 'true');
      return ov.toString();
    }
    return queryUrlOverride; // verbatim when already correct
  }

  const urlObj = new URL(databaseUrl);

  // 2. Non-Supabase: do not touch the port. Still honor pgbouncer if the
  //    operator set it, but never inject a port swap on localhost/Railway.
  if (!isSupabase) return urlObj.toString();

  // 3. Supabase: swap ONLY the authority port to the transaction pooler.
  //    Default Supabase pooler port is 5432 (session); 6543 is transaction.
  //    Set unconditionally rather than string-replacing so we never depend on
  //    the port being literally present, and never match "5432" elsewhere.
  if (urlObj.port === '' || urlObj.port === '5432') {
    urlObj.port = '6543';
  }
  // Transaction mode requires prepared statements OFF (node-postgres must not
  // use named prepared statements under PgBouncer transaction pooling).
  if (!urlObj.searchParams.has('pgbouncer')) {
    urlObj.searchParams.set('pgbouncer', 'true');
  }
  return urlObj.toString();
}

// OPT-166 P4 (flip runbook, V-7): explicit rollback connection source.
//
// Priority:
//   1. AUTOBOT_AGENT_DB_PASSWORD set  → DATABASE_URL, unprivileged autobot_agent
//      role applied downstream by applyAutobotAgentRole(). Unchanged behavior
//      from the STAQPRO-303 rollout.
//   2. unset + DATABASE_URL_SUPERUSER set → explicit flip-window ROLLBACK path:
//      unsetting AUTOBOT_AGENT_DB_PASSWORD and setting DATABASE_URL_SUPERUSER
//      lets the service reconnect as superuser via that connection string
//      WITHOUT touching DATABASE_URL itself (which may still carry
//      autobot_agent credentials mid-incident). This is the "flip the
//      breaker back" lever documented in plans/opt-166-flip-readiness-program.md.
//   3. both unset → legacy behavior: DATABASE_URL as-is, byte-for-byte
//      identical to pre-P4 code.
//
// Pure + exported for unit testing. Never logs or returns credential
// content — callers log only the returned `mode` label, never `connStr`.
export function selectDbConnectionSource({ databaseUrl, agentPassword, superuserUrl } = {}) {
  if (agentPassword) {
    return { connStr: databaseUrl, mode: 'agent-role (DATABASE_URL + AUTOBOT_AGENT_DB_PASSWORD)' };
  }
  if (superuserUrl) {
    return { connStr: superuserUrl, mode: 'superuser-rollback (DATABASE_URL_SUPERUSER)' };
  }
  return { connStr: databaseUrl, mode: 'legacy (DATABASE_URL, no rollback var set)' };
}

async function getPgPool() {
  if (_closing) throw new Error('DB shutting down — query rejected');
  if (!pool) {
    const { default: pg } = await import('pg');
    const { connStr, mode } = selectDbConnectionSource({
      databaseUrl: process.env.DATABASE_URL,
      agentPassword: process.env.AUTOBOT_AGENT_DB_PASSWORD,
      superuserUrl: process.env.DATABASE_URL_SUPERUSER,
    });
    // Boot line for the flip runbook (V-7) — names the mode only, never a
    // credential or URL. This is the log line an operator checks after
    // unsetting AUTOBOT_AGENT_DB_PASSWORD during rollback.
    log.info(`[OPT-166 P4] DB connection mode: ${mode}`);
    // Enable SSL for any external Postgres (Supabase, Railway proxy, etc.)
    // Disable only for localhost/Docker connections
    const isLocal = connStr?.includes('localhost') || connStr?.includes('127.0.0.1') || connStr?.includes('.railway.internal');
    // Supabase session pooler has limited slots (~15 for Small compute).
    // Use transaction pooler (port 6543) for higher concurrency, or keep pool small.
    const isSupabase = connStr?.includes('supabase.com');
    // Phase 2 (query-pool split): the QUERY pool connects to the TRANSACTION
    // pooler (6543, multiplexed) — NOT the session pooler (5432). LISTEN stays
    // on 5432 via lib/runtime/pg-listener.js with the raw DATABASE_URL. See
    // deriveQueryPoolUrl() for the full split rationale.
    const queryUrlStr = deriveQueryPoolUrl(connStr, {
      isSupabase,
      queryUrlOverride: process.env.DATABASE_URL_QUERY,
    });
    const urlObj = new URL(queryUrlStr);
    // STAQPRO-303 PR-B-2: rewrite userinfo to autobot_agent when opted in.
    // Applied to the DERIVED (6543) query URL so the role swap lands on the
    // pool we actually connect with.
    applyAutobotAgentRole(urlObj, { isSupabase, log });
    pool = new pg.Pool({
      connectionString: urlObj.toString(),
      // Phase 2: the query pool now rides the TRANSACTION pooler (6543), which
      // multiplexes clients onto a small set of server connections — so a
      // larger client-side max no longer maps 1:1 to session connections. The
      // old max=5 throttled throughput unnecessarily once the LISTEN clients
      // moved off this pool (Phase 1). DB_POOL_MAX overrides per-env.
      max: Number(process.env.DB_POOL_MAX) || (isSupabase ? 10 : 25),
      idleTimeoutMillis: 20_000,    // Release idle connections faster (was 30s)
      connectionTimeoutMillis: 15_000, // Phase 2: transaction-pooler connects can queue under load
      keepAlive: true,              // Reuse TCP sockets — prevents EADDRNOTAVAIL
      keepAliveInitialDelayMillis: 10_000,
      // Removed global statement_timeout — was killing legitimate long operations
      // (workspace provisioning, campaign iterations, migration runs).
      // Instead, individual query callers should set timeouts via AbortSignal when needed.
      ...(!isLocal ? { ssl: { rejectUnauthorized: false } } : {}),
    });
    // Surface connection errors early
    pool.on('error', (err) => {
      log.error('Pool error:', err.message);
    });
    // STAQPRO-303 PR-B-2 diagnostic: one-shot probe of the effective
    // connecting role. Fire-and-forget — failure here is non-fatal (the
    // first real query will surface the same auth error). The log line is
    // the audit trail for "is RLS actually being enforced today?".
    pool.connect()
      .then(async (probe) => {
        try {
          const { rows } = await probe.query('SELECT current_user AS u, session_user AS s');
          log.info(
            `[STAQPRO-303 PR-B-2] DB pool current_user=${rows[0].u} ` +
            `session_user=${rows[0].s}`
          );
        } finally {
          probe.release();
        }
      })
      .catch((err) => log.warn(`[STAQPRO-303 PR-B-2] role probe failed: ${err.message}`));
  }
  return pool;
}

/**
 * STAQPRO-352: expose the underlying PGlite handle to tests so they can
 * subscribe to `LISTEN <channel>` for trigger-driven assertions
 * (signal.notify_graph_change, migration 112 size guard, etc.). Returns null
 * outside PGlite mode or before initializeDatabase() has run. Test-only —
 * production code must continue to go through query()/withTransaction().
 */
export async function _getPgLiteForTest() {
  if (USE_REAL_PG) return null;
  return getPgLite();
}

async function getPgLite() {
  if (!pglite) {
    const { PGlite } = await import('@electric-sql/pglite');
    const { vector } = await import('@electric-sql/pglite/vector');
    const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');

    const DEFAULT_DATA_DIR = join(__dirname, '..', 'data', 'pglite');
    const dataDir = process.env.PGLITE_DATA_DIR || DEFAULT_DATA_DIR;
    mkdirSync(dataDir, { recursive: true });

    pglite = new PGlite(dataDir, {
      extensions: { vector, pg_trgm },
    });
    await pglite.waitReady;

    // PGlite lacks roles that production Postgres has. Pre-create them so
    // migrations with GRANT/CREATE ROLE don't fail. Idempotent — errors
    // are swallowed (role may already exist from a persisted data dir).
    for (const role of ['postgres', 'autobot_agent', 'explorer_ro']) {
      try { await pglite.exec(`CREATE ROLE ${role} SUPERUSER`); } catch { /* exists */ }
    }

    // Auto-close PGlite when the process exits to prevent test hangs.
    // Without this, any test that imports a module touching db.js will
    // hold the process open indefinitely (exit code 100).
    process.on('beforeExit', () => {
      if (pglite) { pglite.close().catch(() => {}); pglite = null; }
    });
  }
  return pglite;
}

// STAQPRO-392: the migrate runner used to log `FAILED: …` and continue, so a
// real migration bug (e.g. STAQPRO-314's narrowed CHECK) was silently skipped
// and `npm run migrate` still exited 0 — CI's migrate gate could never fail.
// Now any migration error is fatal (throws → caller/migrate.js exits non-zero)
// EXCEPT:
//   - "already exists": idempotent re-run, recorded as applied (unchanged).
//   - the PGlite engine gaps below, tolerated ONLY on PGlite (!USE_REAL_PG).
//     On real Postgres these never occur and ANY error there is always fatal.
//     Enumerated from a clean PGlite run 2026-05-17 — keep this list minimal;
//     widening it re-opens the STAQPRO-314 masking hole.
const PGLITE_INCOMPAT_SIGNATURES = [
  'function gen_random_bytes',          // pgcrypto absent in PGlite (054)
  'schema "signatures" does not exist', // cascades from 054 (063/066/067/069/072)
  'schema "auth" does not exist',       // Supabase-managed schema (070/071/073)
];

function isPgliteIncompatible(message) {
  return !USE_REAL_PG && PGLITE_INCOMPAT_SIGNATURES.some(s => message.includes(s));
}

function assertNoHardFailures(hardFailures) {
  if (hardFailures.length === 0) return;
  const detail = hardFailures.map(f => `  - ${f.file}: ${f.message}`).join('\n');
  throw new Error(
    `${hardFailures.length} migration(s) failed (STAQPRO-392 strict gate):\n${detail}`
  );
}

/**
 * Initialize the database: run all SQL migrations on first launch.
 * Idempotent — checks for schema existence before running.
 */
export async function initializeDatabase() {
  if (USE_REAL_PG) {
    return initializeRealPg();
  }
  return initializePgLite();
}

// OPT-166: the boot-time migration/bootstrap path issues DDL against schema
// `public` (`CREATE TABLE public._migrations`, and every migration file). The
// unprivileged `autobot_agent` role the runtime pool flips to post-flip
// (AUTOBOT_AGENT_DB_PASSWORD set) has NO CREATE on schema public, so running
// migrations over the runtime pool raises `permission denied for schema public`
// (42501) and crash-loops boot (prod outage 2026-07-15). Route all migration/
// bootstrap DDL over a dedicated SUPERUSER connection (DATABASE_URL_SUPERUSER —
// the same rollback creds the flip runbook stages) whenever the runtime pool is
// flipped. Fail LOUD (never silently skip migrations) if the superuser URL is
// absent while flipped. Pre-flip (no AUTOBOT_AGENT_DB_PASSWORD) this returns the
// runtime pool unchanged → byte-identical to the pre-OPT-166 path (INERT).
async function getMigrationDb() {
  const flipped = !!process.env.AUTOBOT_AGENT_DB_PASSWORD;
  if (!flipped) {
    return { db: await getPgPool(), dedicated: false };
  }
  const superUrl = process.env.DATABASE_URL_SUPERUSER;
  if (!superUrl) {
    throw new Error(
      '[OPT-166] AUTOBOT_AGENT_DB_PASSWORD is set (runtime pool flipped to the ' +
      'unprivileged autobot_agent role) but DATABASE_URL_SUPERUSER is not set. ' +
      'Migrations issue DDL against schema public, which autobot_agent cannot do ' +
      '(CREATE denied). Stage DATABASE_URL_SUPERUSER (the superuser rollback ' +
      'connection string) before flipping. Refusing to boot rather than silently ' +
      'skip migrations (fail-closed).'
    );
  }
  const { default: pg } = await import('pg');
  const isLocal = superUrl.includes('localhost') || superUrl.includes('127.0.0.1') || superUrl.includes('.railway.internal');
  const migPool = new pg.Pool({
    connectionString: superUrl,
    max: 2,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 15_000,
    ...(!isLocal ? { ssl: { rejectUnauthorized: false } } : {}),
  });
  // node-postgres crashes the process on an unhandled Pool 'error' event (a
  // transient blip on an idle superuser client during the boot window). Without
  // this listener the anti-crash-loop fix would itself introduce a new crash-loop
  // vector — swallow it here exactly as the runtime pool does above.
  migPool.on('error', (err) => {
    log.error('[OPT-166] migration superuser pool error:', err.message);
  });
  log.info('[OPT-166] migrations running over dedicated superuser connection (DATABASE_URL_SUPERUSER); runtime pool stays agent-role');
  return { db: migPool, dedicated: true };
}

async function initializeRealPg() {
  const { db: migrationDb, dedicated } = await getMigrationDb();
  try {
    return await runMigrations(migrationDb);
  } finally {
    if (dedicated) await migrationDb.end();
  }
}

async function runMigrations(p) {
  // Best-effort bootstrap so a plain Postgres image (local pgvector/pg17) gets
  // what Supabase ships by default. Supabase ships pgcrypto enabled and an `auth`
  // schema with `auth.uid()`; a vanilla image has neither, so migrations 054
  // (gen_random_bytes) and 070/071/073 (auth.uid in contract RLS) hard-fail the
  // STAQPRO-392 strict gate without it.
  //
  // CRITICAL — these statements MUST be best-effort and MUST NOT crash init.
  // On managed Postgres (Supabase) the connecting `postgres` role is NOT a
  // superuser and lacks privileges on the locked-down `auth` schema, so
  // `CREATE SCHEMA`/`CREATE FUNCTION` there raises `permission denied for schema
  // auth`. That is harmless (auth + pgcrypto already exist on Supabase), so each
  // statement is wrapped: a privilege/exists error is logged and skipped, never
  // fatal. Regression guard: an unwrapped throw here crash-looped the production
  // backend and took the board down (2026-05-30). The to_regproc guard still
  // prevents overriding Supabase's real auth.uid() on the vanilla path.
  const bootstrapStmts = [
    ['pgcrypto extension', `CREATE EXTENSION IF NOT EXISTS pgcrypto`],
    ['auth schema', `CREATE SCHEMA IF NOT EXISTS auth`],
    ['auth.uid() stub', `
      DO $bootstrap$
      BEGIN
        IF to_regproc('auth.uid()') IS NULL THEN
          CREATE FUNCTION auth.uid() RETURNS uuid
            LANGUAGE sql STABLE SECURITY DEFINER
            SET search_path = pg_catalog, auth
          AS $body$
            SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
          $body$;
        END IF;
      END
      $bootstrap$;
    `],
  ];
  for (const [label, sql] of bootstrapStmts) {
    try {
      await p.query(sql);
    } catch (err) {
      log.warn(`[db] bootstrap skipped (${label}) — pre-provisioned/managed DB: ${err.message}`);
    }
  }

  // Ensure migration tracking table exists
  await p.query(`
    CREATE TABLE IF NOT EXISTS public._migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const applied = await p.query(`SELECT filename FROM public._migrations`);
  const appliedSet = new Set(applied.rows.map(r => r.filename));

  const files = readdirSync(SQL_DIR)
    .filter(f => f.endsWith('.sql') && !f.startsWith('.'))
    .sort();

  const pending = files.filter(f => !appliedSet.has(f));

  if (pending.length === 0) {
    log.info('Connected to Postgres (all migrations applied)');
    return false;
  }

  log.info(`Running ${pending.length} pending migration(s) (Postgres)...`);

  const hardFailures = [];
  for (const file of pending) {
    const sql = readFileSync(join(SQL_DIR, file), 'utf-8');
    log.info(`Running ${file}...`);
    const client = await p.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(`INSERT INTO public._migrations (filename) VALUES ($1)`, [file]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.message.includes('already exists')) {
        log.info(`Skipped (already exists)`);
        await p.query(
          `INSERT INTO public._migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING`,
          [file]
        );
      } else if (isPgliteIncompatible(err.message)) {
        log.info(`SKIPPED (pglite-incompatible): ${file}: ${err.message}`);
      } else {
        log.error(`FAILED: ${file}: ${err.message}`);
        hardFailures.push({ file, message: err.message });
      }
    } finally {
      client.release();
    }
  }

  assertNoHardFailures(hardFailures);
  log.info('Database initialized (Postgres)');
  return true;
}

async function initializePgLite() {
  const d = await getPgLite();

  // Ensure migration tracking table exists
  await d.exec(`
    CREATE TABLE IF NOT EXISTS public._migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const applied = await d.query(`SELECT filename FROM public._migrations`);
  const appliedSet = new Set(applied.rows.map(r => r.filename));

  const files = readdirSync(SQL_DIR)
    .filter(f => f.endsWith('.sql') && !f.startsWith('.'))
    .sort();

  const pending = files.filter(f => !appliedSet.has(f));

  if (pending.length === 0) {
    log.info('PGlite already initialized (all migrations applied)');
    return false;
  }

  log.info(`Running ${pending.length} pending migration(s) (PGlite)...`);

  const hardFailures = [];
  for (const file of pending) {
    const sql = readFileSync(join(SQL_DIR, file), 'utf-8');
    log.info(`Running ${file}...`);
    try {
      await d.exec(sql);
      await d.query(`INSERT INTO public._migrations (filename) VALUES ($1)`, [file]);
    } catch (err) {
      if (err.message.includes('already exists')) {
        log.info(`Skipped (already exists)`);
        await d.query(
          `INSERT INTO public._migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING`,
          [file]
        );
      } else if (isPgliteIncompatible(err.message)) {
        log.info(`SKIPPED (pglite-incompatible): ${file}: ${err.message}`);
      } else {
        log.error(`FAILED: ${file}: ${err.message}`);
        hardFailures.push({ file, message: err.message });
      }
    }
  }

  assertNoHardFailures(hardFailures);
  log.info('Database initialized (PGlite)');
  return true;
}

// ============================================================
// Query
// ============================================================

/**
 * Execute a parameterized query. No string interpolation ever.
 * P4: boring infrastructure.
 */
export async function query(text, params = []) {
  // Phase 1 shutdown-race guard: reject once close() has begun rather than
  // letting a late call hit an ended pool (opaque pg error) or a closing PGlite.
  if (_closing) throw new Error('DB shutting down — query rejected');
  const start = Date.now();
  let result;

  if (USE_REAL_PG) {
    const p = await getPgPool();
    try {
      result = await p.query(text, params);
      recordDbSuccess();
    } catch (err) {
      recordDbError();
      throw err;
    }
  } else {
    // Inside withTransactionPgLite's async context? Join the open transaction
    // instead of deadlocking on the single PGlite session (see pgliteTxStore).
    // `done` guards stale contexts: a timer or other deferred callback created
    // inside the transaction inherits the store after the tx has committed —
    // those must route to the live DB, not a closed transaction.
    const txStore = pgliteTxStore.getStore();
    if (txStore && !txStore.done) {
      result = await txStore.tx.query(text, params);
    } else {
      const d = await getPgLite();
      result = await d.query(text, params);
    }
    // pg compat: PGlite uses affectedRows, pg uses rowCount
    if (result.rowCount === undefined) {
      result.rowCount = result.affectedRows ?? 0;
    }
  }

  const duration = Date.now() - start;
  if (duration > 1000) {
    log.warn(`Slow query (${duration}ms):`, text.slice(0, 100));
  }
  return result;
}

// ============================================================
// Transactions
// ============================================================

/**
 * Execute within a transaction. guardCheck + transition_state in same tx.
 */
export async function withTransaction(fn) {
  if (USE_REAL_PG) {
    return withTransactionPg(fn);
  }
  return withTransactionPgLite(fn);
}

async function withTransactionPg(fn) {
  const p = await getPgPool();
  const client = await p.connect();
  // Pool removes its error handler on checkout — add one to prevent unhandled crash
  const onError = (err) => {
    log.error('Checked-out client error (transaction):', err.message);
  };
  client.on('error', onError);
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.removeListener('error', onError);
    client.release();
  }
}

async function withTransactionPgLite(fn) {
  // Nested withTransaction inside an open PGlite transaction would deadlock on
  // the session mutex. Emulate an independent sub-transaction with a SAVEPOINT
  // so an inner failure rolls back only the inner writes, matching the
  // pool-backed path's isolation for the rollback case. (True independence —
  // an inner COMMIT surviving an outer ROLLBACK — is impossible on a single
  // session; PGlite is dev/demo-only, so that residual divergence is accepted.)
  const outer = pgliteTxStore.getStore();
  if (outer && !outer.done) {
    const sp = `pglite_nested_sp_${++pgliteSavepointSeq}`;
    await outer.tx.query(`SAVEPOINT ${sp}`);
    try {
      const result = await fn(outer.tx);
      await outer.tx.query(`RELEASE SAVEPOINT ${sp}`);
      return result;
    } catch (err) {
      await outer.tx.query(`ROLLBACK TO SAVEPOINT ${sp}`).catch(() => {});
      throw err;
    }
  }
  const d = await getPgLite();
  return d.transaction(async (tx) => {
    // Wrap tx for pg-compatible result shape
    const wrapped = {
      query: async (text, params = []) => {
        const result = await tx.query(text, params);
        if (result.rowCount === undefined) {
          result.rowCount = result.affectedRows ?? 0;
        }
        return result;
      },
    };
    // Run fn inside the store so any global query() it (or its transitive
    // callees, e.g. guardCheck → evaluateConstitutional) awaits joins this
    // transaction instead of deadlocking the single PGlite session. `done`
    // flips in finally so async work that outlives the transaction (timers,
    // fire-and-forget promises) falls back to the live DB.
    const store = { tx: wrapped, done: false };
    try {
      return await pgliteTxStore.run(store, () => fn(wrapped));
    } finally {
      store.done = true;
    }
  });
}

// ============================================================
// Agent context (RLS)
// ============================================================

/**
 * Set agent context for RLS policies.
 * Uses set_config() with parameterized values (not string interpolation).
 *
 * STAQPRO-303 PR-B-prereq.1a: extended to carry `tier` and `org` from the
 * verified JWT into Postgres session variables `app.tier` and `app.org`.
 * RLS policies in B-prereq.1e check `current_setting('app.tier', true)`
 * to gate is_board() / is_orchestrator() / external-agent paths. Unset
 * tier/org leaves the setting absent so RLS reads NULL — policies must
 * treat NULL as "no privilege" and never grant on NULL.
 *
 * Signature kept positional-compatible: existing two- and three-arg
 * callers (e.g. state-machine.js:226 passing 'board') keep working
 * unchanged. The new `opts` parameter is the only way to set tier/org.
 */
// STAQPRO-263 Bucket 2 (§4.1) — the system-scope guard token.
// A module-private Symbol that ONLY withSystemScope (below) holds. setAgentContext
// refuses to stamp app.role='system' unless it is handed this exact token, so the
// full-cross-org Tier-0 bypass (tenancy.is_system(), sql/199) is mechanically
// unreachable from withAgentScope, withBoardScope, and every direct/future caller
// — P2 infra enforcement, not a lint. Never export this.
const SYSTEM_ROLE_GUARD = Symbol('STAQPRO-263 system-role guard');

// The fixed, frozen allow-list of system-actor identities withSystemScope will
// open a scope for. This restricts the VALUE of the actor id; the companion import
// ratchet (scripts/audit-system-scope-importers.mjs) restricts WHICH files may call
// withSystemScope. Deny-by-default (P1): an id not listed here throws. Bucket 3
// curates this set as it routes each always-on runtime path; the entries below are
// the always-on backends enumerated in the STAQPRO-263 system-scope design §1.3.
const SYSTEM_ACTORS = Object.freeze({
  'agent-loop': true,       // poll loop + its own bookkeeping reads
  'context-loader': true,   // prompt-context assembly
  'tick-context': true,     // OPT-166 P2a — daemon tick snapshots (cross-agent/org reads)
  'graph': true,            // task-graph reads/writes
  'reaper': true,           // OPT-166 P2b — stuck-task recovery daemon (cross-agent work_items read + transition)
  'gmail-poller': true,
  'calendar-poller': true,
  'tldv-poller': true,
  'research-poller': true,
  'audit-writer': true,     // append-only audit emitters
  'metering': true,         // OPT-166 P2e-E1 — cross-cutting spend metering (recordSpend
                            // INSERT + dailySpendUsd SELECT on agent_graph.llm_invocations);
                            // shared by the research-source poller AND the artifact enricher,
                            // so it is a distinct actor, not tied to one scheduler.
  'voice-memo-intake': true,   // OPT-166 P3-B5 — voice-memo webhook: inbox.messages INSERT
                               // (system-writable operational table) in the AssemblyAI
                               // callback path (autobot-inbox/src/api-routes/voice-memo.js).
  'redesign-intake': true,     // OPT-166 P3-B5 — redesign pipeline: agent_graph.work_items
                               // reads/writes (system-writable operational table) across the
                               // public redesign submit/status/notify/cancel/retry/clear routes
                               // (autobot-inbox/src/api-routes/redesign.js).
  'signing-magic-link': true,  // OPT-166 P3-B5 — unauthenticated /api/sign/:token/* reads of
                               // content.drafts / content.draft_versions
                               // (autobot-inbox/src/api-routes/signing.js).
  'federation-query': true,    // OPT-166 P3-B5 — receipt-JWS /query + revocation paths, no
                               // board principal present (autobot-inbox/src/api-routes/federation.js).
  'webhook-intake': true,      // OPT-166 P3-B6 — generic POST /api/webhooks/:source fallthrough
                               // (non-GitHub/Linear sources): inbox.messages INSERT + work_item_id
                               // UPDATE (system-writable operational table), no board principal
                               // present (autobot-inbox/src/api.js).
});

// OPT-166 P2g — allow-list for withSystemOrgScope (deny-by-default, P1).
//
// SEPARATE from SYSTEM_ACTORS on purpose. SYSTEM_ACTORS grants role='system' —
// the Tier-0 CROSS-ORG read bypass (tenancy.is_system(), sql/199). These actors
// need something strictly NARROWER: they write to ONE org's tenancy-scoped tables
// (signal.contacts, content.documents, inbox.*), whose mig-200 write policies are
// `tenancy.visible(NULL, owner_org_id, false)` — allow_system=false, so role='system'
// does NOT satisfy them; the WITH CHECK passes only when owner_org_id ∈ app.org_ids.
// withSystemOrgScope hands these daemons exactly that (app.org_ids=[orgId], role='agent')
// and NOTHING more — no cross-org read, no is_system() bypass. Keeping the two
// allow-lists distinct means adding an org-writer here does not silently also grant
// it full cross-org system reads.
//
// Reachable under REQUIRE_AGENT_JWT=true (unlike withAgentScope) because these are
// always-on daemons that hold no JWT principal — their id is a frozen source constant,
// not a request-derived value, so it is not an injection vector (same trust model as
// SYSTEM_ACTORS). Pre-flip the pool is a BYPASSRLS superuser, so this is INERT until
// the STAQPRO-263 pool flip activates RLS.
const SYSTEM_ORG_WRITERS = Object.freeze({
  'contacts-sync': true,        // Google Contacts sync → signal.contacts upsert
  'backfill-participants': true,// participant backfill CLI → signal.contacts + content.documents
  'sent-analyzer': true,        // sent-mail contact extraction → signal.contacts upsert
  'tldv-poller': true,          // tl;dv transcript ingest → content.documents
  'gmail-poller': true,         // signal reconciliation → inbox.signals org-scoped read/UPDATE
  'tldv-webhook': true,         // tl;dv webhook ingest → content.documents
  'rd-feed-poller': true,       // research-source poller ingest → content.documents
  'voice-memo-intake': true,    // voice-memo transcript ingest → content.documents
});

export async function setAgentContext(client, agentId, role = 'agent', opts = {}) {
  if (!/^[a-z0-9_-]+$/.test(agentId)) throw new Error(`Invalid agent ID: ${agentId}`);
  if (!/^[a-z]+$/.test(role)) throw new Error(`Invalid role: ${role}`);
  const { tier = null, org = null, user = null, orgIds = null, __systemGuard = null } = opts;
  // STAQPRO-263 Bucket 2 (§4.1): app.role='system' is the Tier-0 cross-org read
  // bypass (sql/199 tenancy.is_system()). It is reachable ONLY via withSystemScope,
  // which passes SYSTEM_ROLE_GUARD. Any other path that reaches role='system'
  // (withAgentScope/withBoardScope both hardcode 'agent'/'board'; a future
  // request-derived value) throws here — mechanical enforcement of the
  // load-bearing invariant, independent of call-site syntax.
  if (role === 'system' && __systemGuard !== SYSTEM_ROLE_GUARD) {
    throw new Error('app.role=system is reserved for withSystemScope (missing guard token)');
  }
  if (tier !== null && !/^[a-z]+$/.test(tier)) throw new Error(`Invalid tier: ${tier}`);
  // org DID may include letters, digits, dots, colons, @, underscore, hyphen
  // (DID syntax: did:method:identifier; also accepts 'self', org names).
  if (org !== null && !/^[a-z0-9_:.@-]+$/i.test(org)) throw new Error(`Invalid org: ${org}`);
  // Tenancy GUCs (ADR-012 §5.2): the predicate function tenancy.visible() reads
  // these to evaluate Tier-1 (own) and Tier-2/3 (org-shared / federation) rows.
  // app.user must be a UUID; app.org_ids must be a CSV of UUIDs. Both are
  // emitted as text params so set_config() can store them — tenancy.visible()
  // casts back via ::uuid / string_to_array(...)::uuid[]. The UUID regex below
  // is the canonical 8-4-4-4-12 shape; any deviation throws here rather than
  // poisoning the GUC with a value the SQL function will fail-closed on.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (user !== null && !UUID_RE.test(user)) throw new Error(`Invalid user UUID: ${user}`);
  let orgIdsCsv = null;
  if (orgIds !== null) {
    if (!Array.isArray(orgIds)) throw new Error('orgIds must be an array of UUID strings');
    for (const id of orgIds) {
      if (typeof id !== 'string' || !UUID_RE.test(id)) {
        throw new Error(`Invalid org UUID in orgIds: ${id}`);
      }
    }
    // Empty array → empty string → NULLIF(...,'') → NULL inside tenancy.visible
    // → Tier-2/3 branches fail-closed (no rows). That is the correct outcome
    // for a board user with zero org memberships.
    orgIdsCsv = orgIds.join(',');
  }

  // Build the set_config call list incrementally so unset tier/org leave
  // the Postgres setting absent (current_setting(..., true) → NULL).
  // Setting names are string literals — only values are parameterized.
  const calls = [
    `set_config('app.agent_id', $1, true)`,
    `set_config('app.role', $2, true)`,
  ];
  const params = [agentId, role];
  if (tier !== null) {
    calls.push(`set_config('app.tier', $${params.length + 1}, true)`);
    params.push(tier);
  }
  if (org !== null) {
    calls.push(`set_config('app.org', $${params.length + 1}, true)`);
    params.push(org);
  }
  if (user !== null) {
    calls.push(`set_config('app.user', $${params.length + 1}, true)`);
    params.push(user);
  }
  if (orgIdsCsv !== null) {
    calls.push(`set_config('app.org_ids', $${params.length + 1}, true)`);
    params.push(orgIdsCsv);
  }
  await client.query(`SELECT ${calls.join(', ')}`, params);
}

/**
 * Detect whether the argument looks like a JWT.
 * JWT shape is 3 base64url-encoded segments separated by dots.
 */
function looksLikeJwt(s) {
  if (typeof s !== 'string') return false;
  const parts = s.split('.');
  if (parts.length !== 3) return false;
  return parts.every((p) => p.length > 0 && /^[A-Za-z0-9_-]+$/.test(p));
}

/**
 * Resolve the input (token or plain agentId) to a verified agentId.
 *
 * STAQPRO-263 / ADR-018: agent identity must be cryptographically verifiable.
 * During rollout this function accepts both shapes for backward compatibility:
 *
 *   - JWT token (preferred): verified via verifyAgentToken(); the `sub` claim
 *     is the trusted agentId.
 *   - Plain agentId string (legacy): accepted with a warning. When the env
 *     var REQUIRE_AGENT_JWT=true is set, plain strings throw — enforcement
 *     mode for production.
 *
 * Returns: { agentId, source: 'jwt'|'string', tier?, tools? }
 */
async function resolveAgentIdentity(tokenOrAgentId) {
  if (looksLikeJwt(tokenOrAgentId)) {
    // Dynamic import to avoid load-order issues (agent-jwt requires keys init).
    const { verifyAgentToken } = await import('./runtime/agent-jwt.js');
    let claims;
    try {
      claims = verifyAgentToken(tokenOrAgentId);
    } catch (err) {
      // STAQPRO-263 PR-C: audit every JWT verification failure to threat_memory.
      // Fire-and-forget so audit infrastructure can't break the auth path.
      emitJwtAuditEvent({
        threatClass: 'INTEGRITY_FAILURE',
        severity: 'HIGH',
        detail: {
          reason: err.message,
          source: 'verifyAgentToken',
          tokenPrefix: typeof tokenOrAgentId === 'string' ? tokenOrAgentId.slice(0, 16) : null,
        },
      });
      throw err;
    }
    return {
      agentId: claims.sub,
      source: 'jwt',
      tier: claims.tier,
      tools: claims.tools,
      // STAQPRO-303 PR-B-prereq.1a: surface verified federation org so
      // withAgentScope can plumb it into app.org for RLS policies.
      // verifyAgentToken defaults v1 tokens to org='self'.
      org: claims.org,
    };
  }
  // Plain-string fallback.
  if (process.env.REQUIRE_AGENT_JWT === 'true') {
    // STAQPRO-263 PR-C: a plain agentId in enforcement mode is a deliberate
    // attempt to bypass cryptographic identity. Classify as ESCALATION_BYPASS.
    emitJwtAuditEvent({
      threatClass: 'ESCALATION_BYPASS',
      severity: 'HIGH',
      detail: {
        reason: 'plain-string agentId rejected under REQUIRE_AGENT_JWT=true',
        source: 'resolveAgentIdentity',
        receivedPrefix: typeof tokenOrAgentId === 'string' ? tokenOrAgentId.slice(0, 32) : typeof tokenOrAgentId,
      },
    });
    throw new Error(
      `withAgentScope refused plain-string agentId in enforcement mode ` +
      `(REQUIRE_AGENT_JWT=true). Pass a verified JWT instead. ` +
      `Received: ${typeof tokenOrAgentId === 'string' ? tokenOrAgentId.slice(0, 32) : typeof tokenOrAgentId}`
    );
  }
  log.warn(
    `[STAQPRO-263] withAgentScope called with plain agentId "${tokenOrAgentId}" — ` +
    `should be a JWT after ADR-018 rollout. Set REQUIRE_AGENT_JWT=true to enforce.`
  );
  return { agentId: tokenOrAgentId, source: 'string' };
}

/**
 * Fire-and-forget audit emission for JWT identity failures (STAQPRO-263 PR-C).
 *
 * Dynamic import avoids a load-order cycle: escalation-manager → db (this file).
 * Errors are swallowed so audit infrastructure failures cannot break auth.
 */
function emitJwtAuditEvent({ threatClass, severity, detail }) {
  import('./runtime/escalation-manager.js')
    .then(({ recordThreatEvent }) =>
      recordThreatEvent({
        sourceType: 'gateway_inbound',
        scopeType: 'agent',
        scopeId: '*', // sub claim is not trusted on failure paths
        threatClass,
        severity,
        detail,
      })
    )
    .catch((auditErr) => {
      log.warn(`[STAQPRO-263] JWT audit emission failed: ${auditErr.message}`);
    });
}

/**
 * Execute a function with a dedicated connection that has RLS agent context set.
 * Guarantees all queries within fn() use the same connection with app.agent_id set.
 *
 * Usage in agent-loop.js:
 *   const scopedQuery = await withAgentScope(agentToken);  // JWT preferred
 *   try { await handler(task, context, { ...agent, query: scopedQuery }); }
 *   finally { scopedQuery.release(); }
 *
 * The argument is either:
 *   - A JWT token (preferred per ADR-018) — verified and the `sub` claim is
 *     used as the trusted agentId.
 *   - A plain agentId string (legacy) — accepted with a warning. Throws when
 *     REQUIRE_AGENT_JWT=true is set in env.
 *
 * The optional second argument is an options object:
 *   - `role` ('agent' | 'board'): defaults to 'agent'. Pass 'board' from
 *     autobot-inbox HTTP handlers that have already verified a board JWT via
 *     `resolveAuth` (req.auth.role === 'board'); board-keyed RLS policies
 *     (`current_agent_id() OR current_setting('app.role') = 'board'`) then
 *     return the full row set the board member is entitled to. Required for
 *     correctness once PR-B-2 (pool role flip) + 126-force-rls land —
 *     without it, board API calls will return 0 rows under FORCE.
 *
 * P2: Infrastructure enforces. The handler cannot accidentally query without RLS context.
 */
export async function withAgentScope(tokenOrAgentId, opts = {}) {
  const identity = await resolveAgentIdentity(tokenOrAgentId);
  const { agentId } = identity;
  // user/orgIds plumb the tenancy GUCs read by tenancy.visible() at the DB
  // layer. Callers from the board HTTP path (withBoardScope) pass the
  // resolved principal so RLS policies of the form `USING (tenancy.visible(...))`
  // can backstop the app-layer visibleClause(). Agent callers leave both null
  // and the Tier-1/Tier-2/Tier-3 branches fail-closed inside the predicate.
  const { role = 'agent', user = null, orgIds = null } = opts;
  if (!/^[a-z]+$/.test(role)) throw new Error(`Invalid role: ${role}`);

  if (!USE_REAL_PG) {
    // PGlite: single-connection, no pool. Wrap in an explicit transaction
    // for consistency with the Postgres path — set_config(..., true) is
    // transaction-local and PGlite's auto-commit semantics on a SELECT
    // would otherwise lose the agent context the same way pgbouncer does
    // in production (STAQPRO-307).
    const d = await getPgLite();
    await d.query('BEGIN');
    try {
      // STAQPRO-303 PR-B-prereq.1a: route through setAgentContext so the
      // PGlite path sets app.tier + app.org from the verified JWT, matching
      // the Postgres path below. Identity tier/org are null for plain-string
      // legacy callers and the set_config calls are skipped — preserving
      // existing PGlite behavior under REQUIRE_AGENT_JWT=false.
      // `role` defaults to 'agent'; HTTP handlers serving board JWT requests
      // pass `role: 'board'` so `current_setting('app.role') = 'board'`
      // policy branches return the expected row set.
      await setAgentContext(d, agentId, role, {
        tier: identity.tier ?? null,
        org: identity.org ?? null,
        user,
        orgIds,
      });
    } catch (err) {
      try { await d.query('ROLLBACK'); } catch { /* ignored */ }
      throw err;
    }
    const scopedQuery = async (text, params = []) => {
      const result = await d.query(text, params);
      if (result.rowCount === undefined) result.rowCount = result.affectedRows ?? 0;
      return result;
    };
    scopedQuery.release = async () => {
      try { await d.query('COMMIT'); }
      catch (err) {
        log.warn(`[STAQPRO-307] PGlite COMMIT on agent scope release failed: ${err.message}`);
      }
    };
    scopedQuery.agentId = agentId;
    scopedQuery.identitySource = identity.source;
    return scopedQuery;
  }

  const p = await getPgPool();
  const client = await p.connect();
  // Pool removes its error handler on checkout — add one to prevent unhandled crash
  const onError = (err) => {
    log.error(`Checked-out client error (agent: ${agentId}):`, err.message);
  };
  client.on('error', onError);

  // STAQPRO-307: open an explicit transaction for the lifetime of this scoped
  // session. setAgentContext below uses `set_config(..., true)` which is
  // TRANSACTION-LOCAL. Without an explicit transaction, the setting is bound
  // to the implicit transaction of the SELECT call and evaporates on its
  // auto-commit — so subsequent client.query() calls see app.agent_id=NULL
  // and every RLS policy keyed on current_agent_id() falls through to its
  // remaining OR clauses (the parent_id IS NULL backdoor on work_items, etc).
  //
  // The bug is invisible today because the pool connects as the postgres
  // superuser, which bypasses RLS entirely. The moment STAQPRO-303 PR-B-2
  // switches the pool to autobot_agent, RLS activates and this silently
  // bypasses agent scoping — exactly the failure mode the JWT work was
  // supposed to prevent. Wrapping in BEGIN/COMMIT makes set_config(..., true)
  // bind to a real, persistent transaction that lasts until release().
  //
  // Behavior change: all queries in a scoped session now share one tx. A
  // failing query aborts the tx; subsequent queries throw until release.
  // This matches what most handlers already expect — a tick that errors
  // mid-way should not partially apply.
  try {
    await client.query('BEGIN');
    // STAQPRO-303 PR-B-prereq.1a: plumb verified tier + org from JWT
    // identity into app.tier / app.org. Legacy plain-string callers see
    // tier=null/org=null and the corresponding set_config calls are
    // skipped — current_setting('app.tier', true) returns NULL, which is
    // what the RLS policies in B-prereq.1e require for deny-by-default.
    // `role` defaults to 'agent'; pass `role: 'board'` when the caller has
    // already verified a board JWT (autobot-inbox HTTP handlers).
    await setAgentContext(client, agentId, role, {
      tier: identity.tier ?? null,
      org: identity.org ?? null,
      user,
      orgIds,
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* tx may already be aborted */ }
    client.removeListener('error', onError);
    client.release();
    throw err;
  }

  const scopedQuery = async (text, params = []) => {
    const start = Date.now();
    const result = await client.query(text, params);
    const duration = Date.now() - start;
    if (duration > 1000) {
      log.warn(`Slow query (${duration}ms):`, text.slice(0, 100));
    }
    return result;
  };
  // release is now async — callers must await it, e.g.
  // `finally { await scopedQuery.release(); }`
  // The single existing caller (lib/runtime/agent-loop.js) is updated to
  // await in the same patch.
  scopedQuery.release = async () => {
    let destroyClient = false;
    try {
      await client.query('COMMIT');
    } catch (err) {
      destroyClient = true;
      log.warn(`[STAQPRO-307] COMMIT on agent scope release failed (tx likely aborted): ${err.message}`);
      try {
        await client.query('ROLLBACK');
      } catch {
        /* connection/transaction may already be unusable */
      }
    } finally {
      client.removeListener('error', onError);
      client.release(destroyClient);
    }
  };
  scopedQuery.agentId = agentId;
  scopedQuery.identitySource = identity.source;
  return scopedQuery;
}

/**
 * Open a scoped DB session bound to a board member identity.
 *
 * Intended call site: autobot-inbox HTTP handlers (`src/api.js` routes)
 * that need to issue queries against RLS-FORCE'd tables on behalf of a
 * board user. Once 126-force-rls + PR-B-2 (pool role flip) land, naked
 * `query()` calls from these handlers will return 0 rows — wrapping them
 * in withBoardScope() flips `app.role='board'` so policies of the form
 * `current_agent_id() OR current_setting('app.role') = 'board'` pass.
 *
 * Accepts the full board JWT (Authorization Bearer minus the "Bearer ")
 * so identity is RE-verified inside the DB layer (P2: infra enforces,
 * not the HTTP middleware). This prevents an HTTP handler bug from
 * silently passing an unverified sub.
 *
 * Falls back to accepting a plain `req.auth` object shape when the caller
 * has *already* called resolveAuth() and wants to avoid double-verifying.
 * In that case the caller takes responsibility for verification — this is
 * the pattern src/api.js uses today since resolveAuth runs once per req.
 *
 * Optional second argument `opts.principal` carries the resolved tenancy
 * principal (lib/tenancy/scope.js resolvePrincipal) so app.user + app.org_ids
 * GUCs are set inside the same transaction as app.role='board'. Required for
 * tenancy.visible()-based RLS policies (ADR-012 §5.2) to evaluate correctly
 * once those policies start enforcing. Pass it explicitly — withBoardScope
 * deliberately does NOT auto-resolve the principal (it would introduce a
 * cyclic import lib/db → lib/tenancy/scope → lib/db, and conflate two
 * separate auth concerns: identity verification vs. tenancy resolution).
 * When omitted, app.user/app.org_ids stay unset → tenancy.visible() returns
 * FALSE (Tier-1/2/3 branches all fail-closed) for every row, which is the
 * correct fail-closed posture before the GUCs are plumbed end-to-end.
 */
export async function withBoardScope(boardTokenOrAuth, opts = {}) {
  const { principal = null } = opts;
  // Path A: full JWT — re-verify here.
  if (typeof boardTokenOrAuth === 'string') {
    const { verifyBoardToken } = await import('./runtime/board-jwt.js');
    const claims = await verifyBoardToken(boardTokenOrAuth);
    // sub may be a UUID (boardMembers.id) or a github username — both match
    // the agentId regex `^[a-z0-9_-]+$` when uuid is lowercased.
    const subForRls = String(claims.sub).toLowerCase();
    return withAgentScope(subForRls, {
      role: 'board',
      user: principal?.userId ?? null,
      orgIds: principal?.readOrgIds ?? null,
    });
  }
  // Path B: already-verified req.auth object.
  if (
    boardTokenOrAuth &&
    typeof boardTokenOrAuth === 'object' &&
    boardTokenOrAuth.role === 'board' &&
    typeof boardTokenOrAuth.sub === 'string'
  ) {
    return withAgentScope(boardTokenOrAuth.sub.toLowerCase(), {
      role: 'board',
      user: principal?.userId ?? null,
      orgIds: principal?.readOrgIds ?? null,
    });
  }
  throw new Error(
    'withBoardScope: must be called with a board JWT string OR a verified ' +
    'req.auth object (role==="board" and sub is a string)'
  );
}

/**
 * Open a scoped DB session bound to the SYSTEM identity (STAQPRO-263 Bucket 2).
 *
 * The always-on runtime read paths — the poll loop, task graph, context-loader,
 * the gmail/calendar/tldv/research pollers, audit writers, and ~40 HTTP read
 * routes — are NOT tenant users: they legitimately process work for ALL orgs.
 * After the STAQPRO-263 pool flip (superuser → NOBYPASSRLS autobot_agent), a bare
 * `query()` from these paths sees no `app.user`/`app.org_ids` and `tenancy.visible()`
 * fail-closes every row → full runtime outage. withSystemScope stamps
 * `app.role='system'` so the Tier-0 `tenancy.is_system()` branch (sql/199) admits
 * the cross-org read — and records the open in an append-only ledger.
 *
 * Three hardening properties, all MANDATORY (STAQPRO-263 design §3.2/§4):
 *   1. Guard token — setAgentContext refuses role='system' unless handed the
 *      module-private SYSTEM_ROLE_GUARD, which only this function holds. The
 *      full-bypass value is mechanically unreachable from any other caller (P2).
 *   2. Frozen actor allow-list — the id must be a key of SYSTEM_ACTORS (deny by
 *      default, P1). Callers cannot pass a request-derived actor id.
 *   3. Fail-closed audit-on-open — a single INSERT into audit.system_scope_opens
 *      runs SYNCHRONOUSLY, in the SAME transaction, BEFORE scopedQuery is
 *      returned. If it fails, the whole BEGIN rolls back and NO system-scoped
 *      read ever executes — a cross-org read cannot occur untraced (P3).
 *
 * A companion CI ratchet (scripts/audit-system-scope-importers.mjs +
 * test/system-scope-importer-ratchet.test.js) fails the build if any NEW file
 * imports withSystemScope beyond the baseline — restricting the *caller set*,
 * which the allow-list does not.
 *
 * Does NOT reuse withAgentScope: that routes through resolveAgentIdentity, which
 * would reject a plain system-actor id under REQUIRE_AGENT_JWT=true. System
 * identity is not a JWT principal.
 *
 * Usage (Bucket 3 wires the call sites — ZERO callers today, this is inert):
 *   const q = await withSystemScope('agent-loop');
 *   try { await q('SELECT ...'); } finally { await q.release(); }
 *
 * @param {string} systemActorId  a key of SYSTEM_ACTORS (e.g. 'agent-loop').
 * @param {{reason?: string}} [opts]  optional audit context.
 */
export async function withSystemScope(systemActorId, opts = {}) {
  const { reason = null } = opts;
  if (!Object.prototype.hasOwnProperty.call(SYSTEM_ACTORS, systemActorId)) {
    throw new Error(
      `withSystemScope: unknown system actor "${systemActorId}" — ` +
      `not in the SYSTEM_ACTORS allow-list (deny-by-default)`
    );
  }
  const AUDIT_SQL = 'INSERT INTO audit.system_scope_opens (system_actor, reason) VALUES ($1, $2)';
  const auditParams = [systemActorId, reason];

  // Fail-closed audit-on-open (§3.2 property 3), with DURABLE audit independent of
  // the caller's transaction. The audit row is written and COMMITTED in its OWN
  // short transaction BEFORE the caller's scoped transaction is opened. Two
  // properties fall out:
  //   * Fail-closed: if the audit write (or its commit) fails, we throw and NEVER
  //     return a scoped query — no cross-org system read can occur untraced.
  //   * Durable: because the audit row commits in a separate transaction, a later
  //     abort/rollback of the CALLER's transaction cannot erase the record of a
  //     scope that was already granted (and possibly already used for a cross-org
  //     read). Coupling the ledger's durability to the caller's txn success — as an
  //     in-txn INSERT would — loses exactly the traces that matter most (the error
  //     paths). "Audit on OPEN" means the record survives regardless of outcome.
  // Single connection, sequential txns — no second pool checkout; identical shape
  // on both engines (PGlite executes the two transactions sequentially too). The
  // RLS INSERT policy (sql/199, WITH CHECK is_system()) is satisfied because
  // app.role='system' is set inside the audit txn before the INSERT. set_config is
  // txn-local, so app.role must be re-established in the scoped txn below.

  if (!USE_REAL_PG) {
    // PGlite: single-connection, explicit txns (parity with withAgentScope) so the
    // set_config(..., true) system context survives to the caller's queries.
    const d = await getPgLite();
    // Audit txn — commit the durable open record first.
    await d.query('BEGIN');
    try {
      await setAgentContext(d, systemActorId, 'system', { __systemGuard: SYSTEM_ROLE_GUARD });
      await d.query(AUDIT_SQL, auditParams);
      await d.query('COMMIT');
    } catch (err) {
      try { await d.query('ROLLBACK'); } catch { /* ignored */ }
      throw err;
    }
    // Scoped txn — re-establish system context (txn-local) for the caller.
    await d.query('BEGIN');
    try {
      await setAgentContext(d, systemActorId, 'system', { __systemGuard: SYSTEM_ROLE_GUARD });
    } catch (err) {
      try { await d.query('ROLLBACK'); } catch { /* ignored */ }
      throw err;
    }
    const scopedQuery = async (text, params = []) => {
      const result = await d.query(text, params);
      if (result.rowCount === undefined) result.rowCount = result.affectedRows ?? 0;
      return result;
    };
    scopedQuery.release = async () => {
      try { await d.query('COMMIT'); }
      catch (err) {
        log.warn(`[STAQPRO-263] PGlite COMMIT on system scope release failed: ${err.message}`);
      }
    };
    scopedQuery.agentId = systemActorId;
    scopedQuery.identitySource = 'system';
    return scopedQuery;
  }

  const p = await getPgPool();
  const client = await p.connect();
  const onError = (err) => {
    log.error(`Checked-out client error (system: ${systemActorId}):`, err.message);
  };
  client.on('error', onError);
  // Audit txn — commit the durable open record first (see block comment above).
  try {
    await client.query('BEGIN');
    await setAgentContext(client, systemActorId, 'system', { __systemGuard: SYSTEM_ROLE_GUARD });
    await client.query(AUDIT_SQL, auditParams);
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* tx may already be aborted */ }
    client.removeListener('error', onError);
    client.release();
    throw err;
  }
  // Scoped txn — re-establish system context (txn-local) for the caller's lifetime.
  try {
    await client.query('BEGIN');
    await setAgentContext(client, systemActorId, 'system', { __systemGuard: SYSTEM_ROLE_GUARD });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* tx may already be aborted */ }
    client.removeListener('error', onError);
    client.release();
    throw err;
  }

  const scopedQuery = async (text, params = []) => {
    const start = Date.now();
    const result = await client.query(text, params);
    const duration = Date.now() - start;
    if (duration > 1000) {
      log.warn(`Slow query (${duration}ms):`, text.slice(0, 100));
    }
    return result;
  };
  scopedQuery.release = async () => {
    let destroyClient = false;
    try {
      await client.query('COMMIT');
    } catch (err) {
      destroyClient = true;
      log.warn(`[STAQPRO-263] COMMIT on system scope release failed (tx likely aborted): ${err.message}`);
      try { await client.query('ROLLBACK'); } catch { /* connection may already be unusable */ }
    } finally {
      client.removeListener('error', onError);
      client.release(destroyClient);
    }
  };
  scopedQuery.agentId = systemActorId;
  scopedQuery.identitySource = 'system';
  return scopedQuery;
}

/**
 * Open a scoped DB session bound to a SYSTEM daemon writing to a SINGLE org
 * (OPT-166 P2g). The always-on ingestion paths — Google Contacts sync, the
 * tl;dv poller/webhook, the research-source poller, sent-mail contact
 * extraction, voice-memo intake, and the participant-backfill CLI — persist
 * rows into tenancy-scoped tables (signal.contacts, content.documents) whose
 * mig-200 write policy is `tenancy.visible(NULL::uuid, owner_org_id, false)`.
 * With allow_system=false, the ONLY predicate branch that can pass is Tier-2
 * federation: `owner_org_id = ANY(app.org_ids)`. So a passing write needs
 * exactly ONE GUC — `app.org_ids` containing the row's owner_org_id.
 *
 * Why this exists instead of withAgentScope(id, {orgIds}):
 *   Under REQUIRE_AGENT_JWT=true (prod), withAgentScope routes a plain-string
 *   daemon id through resolveAgentIdentity, which THROWS (ESCALATION_BYPASS).
 *   Every P2e/P2g org-scope wrapper then fail-softed to a bare unscoped
 *   `query()` → 42501 the moment the STAQPRO-263 pool flip activated RLS
 *   (the defect that rolled the flip back three times). These daemons hold no
 *   JWT principal — like withSystemScope, their identity is not a JWT. This
 *   helper opens the org scope WITHOUT resolveAgentIdentity, so it is reachable
 *   under enforcement.
 *
 * Why NOT withSystemScope:
 *   withSystemScope sets role='system' (the cross-org is_system() bypass), which
 *   does NOT satisfy the allow_system=false write policy — org scope is required.
 *   It is also broader privilege than these daemons need (they touch one org).
 *
 * Guarantees (deny-by-default, P1/P2):
 *   1. Frozen allow-list — systemActorId must be a key of SYSTEM_ORG_WRITERS
 *      (distinct from SYSTEM_ACTORS; org-write ≠ cross-org read). Callers cannot
 *      pass a request-derived id.
 *   2. role='agent', never 'system' — so setAgentContext's SYSTEM_ROLE_GUARD is
 *      not needed and the is_system() bypass is mechanically unreachable here.
 *   3. Single-org scope — app.org_ids is exactly [orgId]; the daemon sees and
 *      writes only that org's rows, identical to a normal org-scoped agent.
 *
 * No audit-on-open (unlike withSystemScope): this grants the SAME privilege a
 * normal org-scoped agent already holds (one org, no cross-org bypass), not the
 * sensitive cross-org read withSystemScope's ledger exists to trace — and these
 * are hot poll-loop paths where a per-open audit INSERT would amplify writes.
 * The persisted row's owner_org_id is itself the durable record of the write.
 *
 * Callers must keep `fn`'s body to pure DB work — the scope is one transaction
 * (set_config is txn-local), so it must never span network I/O.
 *
 * @param {string} systemActorId  a key of SYSTEM_ORG_WRITERS (e.g. 'tldv-poller').
 * @param {string} orgId          the owner_org_id (UUID) the writes belong to.
 * @returns a scoped query fn with `.release()` (await it in a finally block).
 */
export async function withSystemOrgScope(systemActorId, orgId) {
  if (!Object.prototype.hasOwnProperty.call(SYSTEM_ORG_WRITERS, systemActorId)) {
    throw new Error(
      `withSystemOrgScope: unknown system org-writer "${systemActorId}" — ` +
      `not in the SYSTEM_ORG_WRITERS allow-list (deny-by-default)`
    );
  }
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (typeof orgId !== 'string' || !UUID_RE.test(orgId)) {
    throw new Error(`withSystemOrgScope: orgId must be a UUID string, got: ${orgId}`);
  }

  if (!USE_REAL_PG) {
    // PGlite: single-connection, explicit txn (parity with withAgentScope) so the
    // set_config(..., true) org context survives to the caller's queries.
    const d = await getPgLite();
    await d.query('BEGIN');
    try {
      await setAgentContext(d, systemActorId, 'agent', { orgIds: [orgId] });
    } catch (err) {
      try { await d.query('ROLLBACK'); } catch { /* ignored */ }
      throw err;
    }
    const scopedQuery = async (text, params = []) => {
      const result = await d.query(text, params);
      if (result.rowCount === undefined) result.rowCount = result.affectedRows ?? 0;
      return result;
    };
    scopedQuery.release = async () => {
      try { await d.query('COMMIT'); }
      catch (err) {
        log.warn(`[OPT-166 P2g] PGlite COMMIT on system-org scope release failed: ${err.message}`);
      }
    };
    scopedQuery.agentId = systemActorId;
    scopedQuery.identitySource = 'system-org';
    return scopedQuery;
  }

  const p = await getPgPool();
  const client = await p.connect();
  const onError = (err) => {
    log.error(`Checked-out client error (system-org: ${systemActorId}):`, err.message);
  };
  client.on('error', onError);
  try {
    await client.query('BEGIN');
    await setAgentContext(client, systemActorId, 'agent', { orgIds: [orgId] });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* tx may already be aborted */ }
    client.removeListener('error', onError);
    client.release();
    throw err;
  }

  const scopedQuery = async (text, params = []) => {
    const start = Date.now();
    const result = await client.query(text, params);
    const duration = Date.now() - start;
    if (duration > 1000) {
      log.warn(`Slow query (${duration}ms):`, text.slice(0, 100));
    }
    return result;
  };
  scopedQuery.release = async () => {
    let destroyClient = false;
    try {
      await client.query('COMMIT');
    } catch (err) {
      destroyClient = true;
      log.warn(`[OPT-166 P2g] COMMIT on system-org scope release failed (tx likely aborted): ${err.message}`);
      try { await client.query('ROLLBACK'); } catch { /* connection may already be unusable */ }
    } finally {
      client.removeListener('error', onError);
      client.release(destroyClient);
    }
  };
  scopedQuery.agentId = systemActorId;
  scopedQuery.identitySource = 'system-org';
  return scopedQuery;
}

// ============================================================
// Utilities
// ============================================================

/**
 * SHA256 hash for config/prompt verification.
 */
export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Get the connection mode for diagnostics.
 */
export function getMode() {
  return USE_REAL_PG ? 'postgres' : 'pglite';
}

/**
 * Return the pg.Pool instance (real Postgres mode only).
 * Returns null when running PGlite or before initialization.
 */
export function getPool() {
  return pool;
}

export async function close() {
  // Phase 1: flip the guard BEFORE tearing anything down so any concurrent
  // in-flight query()/getPgPool() rejects cleanly instead of racing pool.end().
  _closing = true;
  if (pool) {
    await pool.end();
    pool = null;
  }
  if (pglite) {
    await pglite.close();
    pglite = null;
  }
}
