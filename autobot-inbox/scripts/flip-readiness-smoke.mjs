#!/usr/bin/env node
/**
 * STAQPRO-263 / OPT-166 Phase 0 — Flip-Readiness Smoke Test ("THE SENSOR")
 *
 * Simulates the autobot_agent pool flip against a DISPOSABLE, LOCAL docker
 * Postgres (never production). Applies every real migration as superuser,
 * then opens a second connection AS the real non-superuser `autobot_agent`
 * role with RLS enforced, and exercises the enforced-table surface exactly
 * the way the runtime does (system / agent / board scope via lib/db.js),
 * enumerating every result — never stopping at first failure.
 *
 * SAFETY (non-negotiable):
 *   - NEVER reads autobot-inbox/.env or any production DATABASE_URL.
 *   - Only ever connects to a container this script itself created.
 *   - Container is uniquely named and torn down at the end (or left with
 *     a loud "still running" notice on failure so state can be inspected).
 *
 * Usage: node autobot-inbox/scripts/flip-readiness-smoke.mjs [--keep]
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import net from 'node:net';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SQL_DIR = path.join(REPO_ROOT, 'autobot-inbox', 'sql');
const DB_JS_PATH = path.join(REPO_ROOT, 'lib', 'db.js');
const DB_JS_URL = 'file://' + DB_JS_PATH;

const KEEP = process.argv.includes('--keep');
const CONTAINER = `flip-readiness-smoke-${Date.now()}`;
const SUPER_PASS = randomBytes(16).toString('hex');
const AGENT_PASS = randomBytes(16).toString('hex');

const results = []; // { check, principal, table, verb, result, expected, verdict, detail }

function record(check, principal, table, verb, result, expected, detail = '') {
  const verdict = result === expected ? 'ok' : 'BLOCKER';
  results.push({ check, principal, table, verb, result, expected, verdict, detail });
  const tag = verdict === 'ok' ? 'ok  ' : 'FAIL';
  console.log(`[${tag}] ${check} | ${principal} | ${table} | ${verb} -> ${result} (expected ${expected})${detail ? ' :: ' + detail : ''}`);
}

function classifyPgError(err) {
  const msg = String(err?.message || err);
  if (/row-level security policy/i.test(msg)) return 'DENY';
  if (/permission denied/i.test(msg)) return 'DENY';
  return 'ERROR:' + msg.slice(0, 120);
}

// queryFn is the same scoped-query function (sys/ag/brd/brdOther) that fn()
// closes over. A failed query (RLS DENY, FK violation, etc.) aborts the
// enclosing Postgres transaction — every subsequent statement on that same
// connection throws "current transaction is aborted" until a ROLLBACK.
// Since sys/ag/brd/brdOther each hold ONE long-lived transaction across many
// probes, we wrap every probe in its own SAVEPOINT so one expected DENY
// doesn't cascade-fail every check that runs after it.
async function tryRows(queryFn, fn, { emptyIsBlackhole = true } = {}) {
  const sp = 'sp_probe_' + Math.random().toString(36).slice(2, 10);
  await queryFn(`SAVEPOINT ${sp}`);
  try {
    const r = await fn();
    const rowCount = r.rowCount ?? r.rows?.length ?? 0;
    await queryFn(`RELEASE SAVEPOINT ${sp}`);
    if (rowCount === 0 && emptyIsBlackhole) return { status: 'BLACKHOLE(0 rows)', rows: r.rows };
    return { status: 'PASS', rows: r.rows };
  } catch (err) {
    const status = classifyPgError(err);
    await queryFn(`ROLLBACK TO SAVEPOINT ${sp}`);
    await queryFn(`RELEASE SAVEPOINT ${sp}`);
    return { status, rows: [] };
  }
}

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return r;
}

async function waitForReady(container, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // Force TCP (`-h 127.0.0.1`) rather than the Unix socket: the official
    // postgres image runs a temporary initdb-phase server that listens ONLY on
    // the socket before restarting into the real TCP-listening server. A plain
    // `pg_isready -U postgres` (socket) returns ready during that temp phase, so
    // PHASE A's first query then races the restart and hits "Connection
    // terminated unexpectedly". Probing TCP matches the path the pool actually
    // uses and only passes once the real server is accepting connections.
    const r = sh('docker', ['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']);
    if (r.status === 0) return true;
    await new Promise((res) => setTimeout(res, 500));
  }
  return false;
}

// V-8: free-port + HTTP-readiness helpers for PHASE B-FUZZ-HTTP's disposable
// autobot_agent-posture API server (see that phase for context).
async function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// OPTIONS preflight returns 204 unconditionally BEFORE route dispatch / DB
// access (src/api.js), so it's a DB-independent readiness probe — avoids
// racing the pool's lazy first-query connect.
async function waitForHttpReady(baseUrl, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(baseUrl + '/', { method: 'OPTIONS' });
      if (res.status === 204) return true;
    } catch {
      // connection refused while the server is still coming up — keep polling
    }
    await new Promise((res) => setTimeout(res, 300));
  }
  return false;
}

// NOTE: getPgPool() in lib/db.js lazily reads process.env.DATABASE_URL /
// AUTOBOT_AGENT_DB_PASSWORD at first-query time (not at module-import time),
// and the pool it builds is a singleton PER MODULE INSTANCE. Each cache-busted
// dynamic import() below gets its own module instance / own pool, so we
// deliberately do NOT restore the ambient env after import — the env must
// stay set to the values this handle expects for as long as the handle is
// used. The next phase explicitly overwrites env before its own freshDb().
async function freshDb(env) {
  delete process.env.DATABASE_URL;
  delete process.env.AUTOBOT_AGENT_DB_PASSWORD;
  delete process.env.DATABASE_URL_SUPERUSER;
  delete process.env.SQL_DIR;
  Object.assign(process.env, env);
  const mod = await import(DB_JS_URL + '?cachebust=' + Date.now() + '_' + Math.random());
  return mod;
}

let hostPort;
let migrationFailures = [];

async function main() {
  console.log(`>>> Starting disposable container ${CONTAINER}`);
  const run = sh('docker', [
    'run', '-d', '--name', CONTAINER,
    '-p', '127.0.0.1::5432',
    '-e', `POSTGRES_PASSWORD=${SUPER_PASS}`,
    '-e', 'POSTGRES_DB=flip_smoke',
    'pgvector/pgvector:pg16',
  ]);
  if (run.status !== 0) {
    console.error('docker run failed:', run.stderr);
    process.exit(1);
  }

  const portInfo = sh('docker', ['port', CONTAINER, '5432/tcp']);
  const m = /:(\d+)\s*$/.exec(portInfo.stdout.trim());
  if (!m) {
    console.error('Could not determine host port:', portInfo.stdout, portInfo.stderr);
    process.exit(1);
  }
  hostPort = m[1];
  console.log(`>>> Container up on 127.0.0.1:${hostPort}`);

  const ready = await waitForReady(CONTAINER);
  if (!ready) {
    console.error('Postgres never became ready');
    process.exit(1);
  }

  const SUPER_URL = `postgresql://postgres:${SUPER_PASS}@127.0.0.1:${hostPort}/flip_smoke`;

  // ============================================================
  // PHASE A — superuser: migrate + create autobot_agent role + seed
  // ============================================================
  console.log('\n>>> PHASE A — superuser migrate + seed');
  const dbSuper = await freshDb({ DATABASE_URL: SUPER_URL, SQL_DIR });

  const whoami = await dbSuper.query('SELECT current_user AS u');
  console.log('Phase A current_user:', whoami.rows[0].u);
  if (whoami.rows[0].u !== 'postgres') {
    console.error('FATAL: Phase A did not connect as postgres superuser — aborting.');
    process.exit(1);
  }

  // Create autobot_agent BEFORE migrations run, non-superuser, no bypass.
  await dbSuper.query(
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'autobot_agent') THEN
         CREATE ROLE autobot_agent LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD '${AGENT_PASS}';
       END IF;
     END $$;`
  );
  console.log('Created role autobot_agent (NOSUPERUSER NOBYPASSRLS)');

  try {
    await dbSuper.initializeDatabase();
    console.log('initializeDatabase(): all migrations applied cleanly.');
  } catch (err) {
    console.error('initializeDatabase() THREW:', err.message);
    migrationFailures.push(err.message);
  }

  // Re-set the agent password in case a migration recreated the role without it
  // (defensive — some migrations DROP/CREATE ROLE IF NOT EXISTS guards).
  await dbSuper.query(`ALTER ROLE autobot_agent WITH PASSWORD '${AGENT_PASS}' NOSUPERUSER NOBYPASSRLS LOGIN;`);

  // Grant spot-checks
  const grantChecks = [
    ['agent_graph.work_items', 'SELECT'], ['agent_graph.work_items', 'INSERT'], ['agent_graph.work_items', 'UPDATE'],
    ['agent_graph.task_events', 'SELECT'], ['agent_graph.task_events', 'INSERT'],
    ['agent_graph.llm_invocations', 'SELECT'], ['agent_graph.llm_invocations', 'INSERT'],
    ['inbox.messages', 'SELECT'], ['inbox.messages', 'INSERT'], ['inbox.messages', 'UPDATE'],
    ['content.drafts', 'SELECT'], ['content.drafts', 'INSERT'],
    ['content.counterparties', 'SELECT'], ['content.counterparties', 'INSERT'],
  ];
  console.log('\n--- has_table_privilege(autobot_agent, ...) spot-checks ---');
  for (const [tbl, verb] of grantChecks) {
    const r = await dbSuper.query(`SELECT has_table_privilege('autobot_agent', $1, $2) AS ok`, [tbl, verb]);
    console.log(`  ${tbl} ${verb}: ${r.rows[0].ok}`);
  }

  // OPT-166 P2e — align the ephemeral staqs org id to the hardcoded CURRENT_ORG_ID
  // constant BEFORE any app seeding, so the sensor can drive REAL call sites whose
  // internal scope uses that constant (contacts-sync.upsertContact,
  // sent-analyzer, the pollers) rather than only lookalikes injected with the
  // freshly-seeded random id. mig-133 seeds staqs via gen_random_uuid(), and
  // mig-134 stamps owner_org_id DEFAULTs from that random id — so on a fresh DB
  // staqs.id != CURRENT_ORG_ID and any org-scope pinned to the constant fails the
  // org-scoped WITH CHECK (42501). In PROD staqs.id === CURRENT_ORG_ID (the
  // constant was set to prod's real staqs id), so this realignment reproduces the
  // prod identity the constant assumes. Catalog-driven (FK children + every
  // owner_org_id column) and future-proof; runs as postgres superuser on a
  // throwaway DB, using session_replication_role=replica to rewrite the orgs PK
  // without tripping the (non-deferrable) FK triggers. If it breaks anything, the
  // sensor's other ~70 checks fail — it is its own falsifiable verifier.
  const CURRENT_ORG_ID = '7c164445-43f2-4802-a7d3-5cab06611e99';
  await dbSuper.query(`
    DO $$
    DECLARE
      old_id uuid;
      target uuid := '${CURRENT_ORG_ID}';
      r record;
    BEGIN
      SELECT id INTO old_id FROM tenancy.orgs WHERE slug = 'staqs';
      IF old_id IS NULL OR old_id = target THEN RETURN; END IF;

      PERFORM set_config('session_replication_role', 'replica', true);

      -- Repoint the orgs PK, then every FK child that references tenancy.orgs
      -- (catalog-discovered; single-column FKs only, which is all orgs has).
      UPDATE tenancy.orgs SET id = target WHERE id = old_id;
      FOR r IN
        SELECT con.conrelid::regclass::text AS child_tbl, att.attname AS col
        FROM pg_constraint con
        JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
        WHERE con.confrelid = 'tenancy.orgs'::regclass AND con.contype = 'f'
      LOOP
        EXECUTE format('UPDATE %s SET %I = %L WHERE %I = %L', r.child_tbl, r.col, target, r.col, old_id);
      END LOOP;

      -- Repoint every base-table owner_org_id column's rows + DEFAULT that
      -- mig-134 stamped with the old random staqs id.
      FOR r IN
        SELECT c.table_schema AS s, c.table_name AS t
        FROM information_schema.columns c
        JOIN pg_class pc ON pc.relname = c.table_name AND pc.relkind = 'r'
        JOIN pg_namespace pn ON pn.oid = pc.relnamespace AND pn.nspname = c.table_schema
        WHERE c.column_name = 'owner_org_id'
      LOOP
        EXECUTE format('UPDATE %I.%I SET owner_org_id = %L WHERE owner_org_id = %L', r.s, r.t, target, old_id);
        EXECUTE format('ALTER TABLE %I.%I ALTER COLUMN owner_org_id SET DEFAULT %L', r.s, r.t, target);
      END LOOP;

      PERFORM set_config('session_replication_role', 'origin', true);
    END $$;
  `);
  const staqsCheck = await dbSuper.query(`SELECT id FROM tenancy.orgs WHERE slug = 'staqs'`);
  console.log(`staqs org id realigned to CURRENT_ORG_ID: ${staqsCheck.rows[0]?.id === CURRENT_ORG_ID} (${staqsCheck.rows[0]?.id})`);

  // Orgs
  const orgsRes = await dbSuper.query(`SELECT id, slug FROM tenancy.orgs WHERE slug IN ('staqs','consulting-futures')`);
  const orgs = Object.fromEntries(orgsRes.rows.map((r) => [r.slug, r.id]));
  const STAQS_ORG = orgs['staqs'];
  const CF_ORG = orgs['consulting-futures'];
  console.log('orgs:', orgs);

  // --- Seed deterministic rows ---
  const ids = {};

  const parentWi = await dbSuper.query(
    `INSERT INTO agent_graph.work_items (type, title, created_by, parent_id) VALUES ('workstream','smoke parent','orchestrator',NULL) RETURNING id`
  );
  ids.parentWorkItemId = parentWi.rows[0].id;

  const childWi = await dbSuper.query(
    `INSERT INTO agent_graph.work_items (type, title, created_by, assigned_to, parent_id) VALUES ('task','smoke child','orchestrator','orchestrator',$1) RETURNING id`,
    [ids.parentWorkItemId]
  );
  ids.agentWorkItemId = childWi.rows[0].id;

  const msg = await dbSuper.query(
    `INSERT INTO inbox.messages (provider, provider_msg_id, thread_id, message_id, from_address, received_at, channel)
     VALUES ('gmail','smoke-provider-msg-1','smoke-thread-1','smoke-msg-1','smoke@example.com', now(), 'email') RETURNING id`
  );
  ids.messageId = msg.rows[0].id;

  const draft = await dbSuper.query(
    `INSERT INTO content.drafts (content_type, body) VALUES ('blog','smoke body') RETURNING id`
  );
  ids.draftId = draft.rows[0].id;

  const cp = await dbSuper.query(
    `INSERT INTO content.counterparties (name, owner_org_id) VALUES ('Smoke Counterparty', $1) RETURNING id`,
    [STAQS_ORG]
  );
  ids.counterpartyId = cp.rows[0].id;

  const evt = await dbSuper.query(
    `INSERT INTO agent_graph.task_events (event_type, work_item_id, target_agent_id) VALUES ('task_assigned',$1,'orchestrator') RETURNING event_id`,
    [ids.parentWorkItemId]
  );
  ids.taskEventId = evt.rows[0].event_id;

  const inv = await dbSuper.query(
    `INSERT INTO agent_graph.llm_invocations (agent_id, task_id, model, input_tokens, output_tokens, cost_usd, prompt_hash, response_hash, idempotency_key)
     VALUES ('orchestrator',$1,'smoke-model',1,1,0.000001,'h1','h2',$2) RETURNING id`,
    [ids.parentWorkItemId, 'smoke-idem-' + randomUUID()]
  );
  ids.llmInvocationId = inv.rows[0].id;

  // mig190 tables (6 remaining not already covered above: contacts, signals(inbox), human_tasks, briefings, signals(agent_graph), organizations; plus documents)
  const contact = await dbSuper.query(`INSERT INTO signal.contacts (email_address) VALUES ('smoke-contact@example.com') RETURNING id`);
  ids.contactId = contact.rows[0].id;

  const inboxSignal = await dbSuper.query(
    `INSERT INTO inbox.signals (message_id, signal_type, content, confidence) VALUES ($1,'action_item','smoke signal',0.90) RETURNING id`,
    [ids.messageId]
  );
  ids.inboxSignalId = inboxSignal.rows[0].id;

  const humanTask = await dbSuper.query(`INSERT INTO inbox.human_tasks (title) VALUES ('smoke task') RETURNING id`);
  ids.humanTaskId = humanTask.rows[0].id;

  const briefing = await dbSuper.query(
    `INSERT INTO signal.briefings (briefing_date, summary, generated_by) VALUES (CURRENT_DATE + interval '1 day','smoke','smoke-script') RETURNING id`
  );
  ids.briefingId = briefing.rows[0].id;

  const agSignal = await dbSuper.query(
    `INSERT INTO agent_graph.signals (signal_type, source_adapter, payload) VALUES ('smoke.test','internal','{}'::jsonb) RETURNING id`
  );
  ids.agentSignalId = agSignal.rows[0].id;

  const org = await dbSuper.query(
    `INSERT INTO signal.organizations (name, slug) VALUES ('Smoke Org', $1) RETURNING id`,
    ['smoke-org-' + Date.now()]
  );
  ids.orgRowId = org.rows[0].id;

  const doc = await dbSuper.query(
    `INSERT INTO content.documents (source, source_id, raw_text) VALUES ('upload','smoke-doc-1','smoke text') RETURNING id`
  );
  ids.documentId = doc.rows[0].id;

  const campaign = await dbSuper.query(
    `INSERT INTO agent_graph.campaigns (work_item_id, goal_description, budget_envelope_usd, created_by) VALUES ($1,'smoke campaign',1.0,'orchestrator') RETURNING id`,
    [ids.parentWorkItemId]
  );
  ids.campaignId = campaign.rows[0].id;

  // OPT-166 P2b (R5) — a CROSS-AGENT stuck task for the real reaper-recovery probe.
  // status=in_progress, assigned to 'executor-coder' (NOT the reaper), updated_at
  // 10 min old → past the reaper's 5-min plain-timeout branch (no heartbeat needed).
  // Post-flip the reaper must SEE this row (system-scope discovery SELECT) and
  // TRANSITION it (system-scope transitionState) even though it is owned by a
  // different agent. updated_at is set inline in the INSERT — work_items has no
  // BEFORE-INSERT trigger that clobbers it (see reaper-dead-runner.test.js).
  const stuckWi = await dbSuper.query(
    `INSERT INTO agent_graph.work_items (type, title, created_by, assigned_to, status, parent_id, updated_at)
     VALUES ('task','smoke stuck in_progress','orchestrator','executor-coder','in_progress',$1, now() - interval '10 minutes') RETURNING id`,
    [ids.parentWorkItemId]
  );
  ids.stuckWorkItemId = stuckWi.rows[0].id;

  // OPT-166 P2c (R7/R8) — a CROSS-AGENT COMPLETED task + its terminal
  // state_transition, for the real loadReflectionContext + loadSystemTopology probes.
  //  * R8 (loadSystemTopology.successRates): GROUP BY assigned_to over the fleet's
  //    completed/failed items in the last 7d is a CROSS-AGENT aggregate — only a
  //    system scope sees another agent's row; an agent scope keyed to the R8 caller
  //    ('agent-loop') would black-hole it. Assigned to 'executor-triage' (≠ caller).
  //  * R7 (loadReflectionContext.recentOutcomes): JOINs state_transitions ON
  //    to_state = wi.status and filters wi.assigned_to = the reflecting agent, so it
  //    needs the terminal transition row present + recent. The direct INSERT is a
  //    leaf row (hash_chain_* left NULL) — the immutability trigger guards UPDATE/
  //    DELETE (it reads OLD), not INSERT, so a superuser leaf insert is accepted.
  const doneWi = await dbSuper.query(
    `INSERT INTO agent_graph.work_items (type, title, created_by, assigned_to, status)
     VALUES ('task','smoke completed','orchestrator','executor-triage','completed') RETURNING id`
  );
  ids.completedWorkItemId = doneWi.rows[0].id;
  await dbSuper.query(
    `INSERT INTO agent_graph.state_transitions
       (work_item_id, from_state, to_state, agent_id, config_hash, reason, cost_usd, created_at)
     VALUES ($1,'in_progress','completed','executor-triage','smoke-cfg','smoke done',0.0, now())`,
    [ids.completedWorkItemId]
  );

  // OPT-166 P2d (R9) — two ORG-OWNED inbox.signals, each on its own message, for the
  // gmail-poller resolve seam. inbox.signals' write policy (mig200) is
  // tenancy.visible(NULL, owner_org_id, false) — ORG-ONLY (allow_system=false, so a
  // system scope black-holes too; org scope is the only key). One signal is resolved
  // UNDER an org scope (expect rowCount 1); the other is attempted UNSCOPED (expect
  // rowCount 0 — a silent black-hole, proving the injected scope is load-bearing).
  // Separate messages because resolveSignalsByMessage resolves ALL unresolved signals
  // on a message_id in one call, so sharing a message would let the first call resolve
  // both and make the second's rowCount=0 for the wrong reason.
  const r9msgScoped = await dbSuper.query(
    `INSERT INTO inbox.messages (provider, provider_msg_id, thread_id, message_id, from_address, received_at, channel)
     VALUES ('gmail','smoke-r9-scoped','smoke-r9-thread-a','smoke-r9-scoped','r9a@example.com', now(), 'email') RETURNING id`
  );
  ids.r9ScopedMessageId = r9msgScoped.rows[0].id;
  await dbSuper.query(
    `INSERT INTO inbox.signals (message_id, signal_type, content, confidence, owner_org_id)
     VALUES ($1,'action_item','r9 scoped',0.90,$2)`,
    [ids.r9ScopedMessageId, STAQS_ORG]
  );

  const r9msgUnscoped = await dbSuper.query(
    `INSERT INTO inbox.messages (provider, provider_msg_id, thread_id, message_id, from_address, received_at, channel)
     VALUES ('gmail','smoke-r9-unscoped','smoke-r9-thread-b','smoke-r9-unscoped','r9b@example.com', now(), 'email') RETURNING id`
  );
  ids.r9UnscopedMessageId = r9msgUnscoped.rows[0].id;
  await dbSuper.query(
    `INSERT INTO inbox.signals (message_id, signal_type, content, confidence, owner_org_id)
     VALUES ($1,'action_item','r9 unscoped',0.90,$2)`,
    [ids.r9UnscopedMessageId, STAQS_ORG]
  );

  // OPT-166 P2f-A (R14) — an ORG-OWNED transcript message + an inbound high-confidence
  // action_item signal, for the transcript-action-extractor seam. extractTranscriptActions
  // reads inbox.signals JOIN inbox.messages (org-keyed SELECT, mig190/200) — post-flip a BARE
  // read black-holes to 0 rows, so it early-returns "no actionable signals" and EVERY transcript
  // silently produces 0 intents. The real entry point now reads owner_org_id from bare-permissive
  // inbox.messages then brackets the org-keyed read in withTranscriptOrgScope(ownerOrgId).
  // direction='inbound' + confidence>=0.7 so the promoted signal also creates an intent (the
  // createIntent path is unscoped by design — agent_graph.agent_intents has no RLS). Content is
  // deliberately name-free so matchParticipantsToContacts short-circuits (no signal.contacts write
  // — that seam is already covered by R13).
  const r14msg = await dbSuper.query(
    `INSERT INTO inbox.messages (provider, provider_msg_id, thread_id, message_id, from_address, received_at, channel, owner_org_id)
     VALUES ('gmail','smoke-r14-transcript','smoke-r14-thread','smoke-r14-transcript','r14@example.com', now(), 'email', $1) RETURNING id`,
    [STAQS_ORG]
  );
  ids.r14MessageId = r14msg.rows[0].id;
  await dbSuper.query(
    `INSERT INTO inbox.signals (message_id, signal_type, content, confidence, direction, owner_org_id)
     VALUES ($1,'action_item','r14 transcript action item',0.90,'inbound',$2)`,
    [ids.r14MessageId, STAQS_ORG]
  );

  console.log('Seeded ids:', ids);

  await dbSuper.close();

  // ============================================================
  // PHASE A2 — flipped initializeDatabase() BOOT path (OPT-166 regression guard)
  // ============================================================
  // Reproduces the EXACT prod boot: the runtime pool is flipped to the
  // unprivileged autobot_agent role while initializeDatabase() runs migration/
  // bootstrap DDL against schema public. Pre-fix this raised `permission denied
  // for schema public` (42501) and crash-looped the backend (prod outage
  // 2026-07-15). The pre-existing PHASE B builds the flipped pool but NEVER calls
  // initializeDatabase() (see fuzz-http-boot.mjs — it deliberately skips it), so
  // the sensor was blind to this boot path. This phase closes that gap.
  console.log('\n>>> PHASE A2 — flipped initializeDatabase() boot path (OPT-166)');

  // (1) Positive: flipped + DATABASE_URL_SUPERUSER staged (as the flip runbook
  //     requires) → boot must NOT throw, and the runtime pool must connect as the
  //     unprivileged autobot_agent role (migrations ran over the superuser conn,
  //     runtime stays agent-role). This is the check that would have caught the
  //     outage: pre-fix it throws 42501, post-fix it boots clean.
  {
    const dbFlip = await freshDb({
      DATABASE_URL: SUPER_URL,                 // userinfo rewritten to autobot_agent downstream
      AUTOBOT_AGENT_DB_PASSWORD: AGENT_PASS,
      DATABASE_URL_SUPERUSER: SUPER_URL,       // staged rollback creds → migration connection
      SQL_DIR,
    });
    try {
      await dbFlip.initializeDatabase();       // must NOT throw
      const who = await dbFlip.query('SELECT current_user AS u');
      const okRole = who.rows[0].u === 'autobot_agent';
      record('A2 flipped boot (initializeDatabase)', 'agent', '(boot)', 'initializeDatabase',
        okRole ? 'PASS' : 'FAIL:runtime=' + who.rows[0].u, 'PASS');
    } catch (err) {
      record('A2 flipped boot (initializeDatabase)', 'agent', '(boot)', 'initializeDatabase',
        'FAIL:threw', 'PASS', String(err?.message || err).slice(0, 160));
    } finally {
      await dbFlip.close?.();
    }
  }

  // (2) Fail-closed: flipped but DATABASE_URL_SUPERUSER absent → boot must throw
  //     the EXPLICIT fail-closed error (never silently skip migrations, never a
  //     raw 42501 crash). Silent migration-skip is the exact failure class this
  //     project is paranoid about.
  {
    const dbNoSuper = await freshDb({
      DATABASE_URL: SUPER_URL,
      AUTOBOT_AGENT_DB_PASSWORD: AGENT_PASS,
      SQL_DIR,
    });
    let threw = null;
    try {
      await dbNoSuper.initializeDatabase();
    } catch (err) {
      threw = String(err?.message || err);
    }
    const failClosed = !!threw && /DATABASE_URL_SUPERUSER/.test(threw);
    record('A2 flipped boot fail-closed (no superuser URL)', 'agent', '(boot)', 'initializeDatabase',
      failClosed ? 'PASS' : 'FAIL', 'PASS',
      failClosed ? '' : (threw ? 'wrong-error: ' + threw.slice(0, 120) : 'did-not-throw'));
    await dbNoSuper.close?.();
  }

  // ============================================================
  // PHASE B — autobot_agent, RLS enforced
  // ============================================================
  console.log('\n>>> PHASE B — autobot_agent (RLS enforced)');
  const dbAgent = await freshDb({ DATABASE_URL: SUPER_URL, AUTOBOT_AGENT_DB_PASSWORD: AGENT_PASS, SQL_DIR });

  const who2 = await dbAgent.query('SELECT current_user AS u, session_user AS s');
  console.log('Phase B current_user:', who2.rows[0].u, 'session_user:', who2.rows[0].s);
  if (who2.rows[0].u !== 'autobot_agent') {
    console.error('FATAL PRECONDITION FAILURE: expected current_user=autobot_agent, got', who2.rows[0].u, '- aborting rest of sensor.');
    record('precondition', 'n/a', 'n/a', 'connect', 'FAIL:' + who2.rows[0].u, 'autobot_agent');
    await dbAgent.close?.();
    await teardown();
    printInventory();
    process.exit(1);
  }

  // V-6: guard-token must be unreachable
  try {
    await dbAgent.setAgentContext({ query: async () => { throw new Error('should never be called'); } }, 'x', 'system', {});
    record('V-6 guard-token', 'n/a', 'n/a', 'setAgentContext(role=system, no token)', 'PASS(should-not-happen)', 'ERROR');
  } catch (err) {
    const ok = /guard token|reserved for withSystemScope/i.test(err.message);
    record('V-6 guard-token', 'n/a', 'n/a', 'setAgentContext(role=system, no token)', ok ? 'DENY' : 'ERROR:' + err.message, 'DENY');
  }

  // ---- SYSTEM SCOPE ----
  const sys = await dbAgent.withSystemScope('agent-loop', { reason: 'flip-readiness-smoke' });

  {
    const r = await tryRows(sys, () => sys('SELECT id FROM agent_graph.work_items WHERE id = $1', [ids.parentWorkItemId]));
    record('V-1 system SELECT work_items (parent_id IS NULL row)', 'system', 'agent_graph.work_items', 'SELECT', r.status, 'PASS');
  }
  {
    const r = await tryRows(sys, () => sys('SELECT id FROM agent_graph.work_items WHERE id = $1', [ids.agentWorkItemId]));
    record('V-1 system SELECT work_items (child assigned to another agent)', 'system', 'agent_graph.work_items', 'SELECT', r.status, 'PASS',
      'via mig190 tenancy_visible_select_work_items (tenancy.is_system() Tier-0), NOT via agent_read_work_items');
  }
  {
    const r = await tryRows(sys, () => sys(
      `INSERT INTO agent_graph.work_items (type, title, created_by) VALUES ('task','system-inserted','orchestrator') RETURNING id`
    ));
    record('V-1 system INSERT work_items', 'system', 'agent_graph.work_items', 'INSERT', r.status, 'PASS');
    if (r.status === 'PASS') ids.sysWorkItemId = r.rows[0].id;
  }
  {
    // UPDATE own just-inserted row, assigned_to is NULL (not 'agent-loop') — tests agent_update_work_items predicate exactly
    const r = await tryRows(sys, () => sys(
      `UPDATE agent_graph.work_items SET title = 'system-updated' WHERE id = $1 RETURNING id`,
      [ids.sysWorkItemId || ids.agentWorkItemId]
    ));
    record('V-1 system UPDATE work_items (assigned_to != app.agent_id)', 'system', 'agent_graph.work_items', 'UPDATE', r.status, 'PASS',
      'agent_update_work_items USING assigned_to=current_agent_id() OR role=board; system sets role=system not board');
  }
  {
    const r = await tryRows(sys, () => sys('SELECT event_id FROM agent_graph.task_events WHERE event_id = $1', [ids.taskEventId]));
    record('V-1 system SELECT task_events (target_agent_id=orchestrator, not in mig190)', 'system', 'agent_graph.task_events', 'SELECT', r.status, 'PASS');
  }
  {
    const r = await tryRows(sys, () => sys(
      `INSERT INTO agent_graph.task_events (event_type, work_item_id, target_agent_id) VALUES ('task_created',$1,'agent-loop') RETURNING event_id`,
      [ids.parentWorkItemId]
    ));
    record('V-1 system INSERT task_events', 'system', 'agent_graph.task_events', 'INSERT', r.status, 'PASS');
  }
  {
    const r = await tryRows(sys, () => sys('SELECT id FROM agent_graph.llm_invocations WHERE id = $1', [ids.llmInvocationId]));
    record('V-1 system SELECT llm_invocations (agent_id=orchestrator, not in mig190)', 'system', 'agent_graph.llm_invocations', 'SELECT', r.status, 'PASS');
  }
  {
    const r = await tryRows(sys, () => sys(
      `INSERT INTO agent_graph.llm_invocations (agent_id, task_id, model, input_tokens, output_tokens, cost_usd, prompt_hash, response_hash, idempotency_key)
       VALUES ('orchestrator',$1,'smoke-model',1,1,0.000001,'h1','h2',$2) RETURNING id`,
      [ids.parentWorkItemId, 'smoke-sys-idem-' + randomUUID()]
    ));
    record('V-1 system INSERT llm_invocations', 'system', 'agent_graph.llm_invocations', 'INSERT', r.status, 'PASS');
  }

  // mig190 SELECT spot-checks under system scope (expect trivial PASS via Tier-0)
  for (const [tbl, col, id] of [
    ['signal.contacts', 'id', ids.contactId],
    ['agent_graph.campaigns', 'id', ids.campaignId],
    ['content.documents', 'id', ids.documentId],
  ]) {
    const r = await tryRows(sys, () => sys(`SELECT ${col} FROM ${tbl} WHERE ${col} = $1`, [id]));
    record('mig190 system SELECT (Tier-0 bypass)', 'system', tbl, 'SELECT', r.status, 'PASS');
  }

  // Landmine A
  {
    const r = await tryRows(sys, () => sys(
      `INSERT INTO inbox.messages (provider, provider_msg_id, thread_id, message_id, from_address, received_at, channel)
       VALUES ('gmail','smoke-provider-msg-2','smoke-thread-2','smoke-msg-2','smoke2@example.com', now(), 'email') RETURNING id`
    ));
    record('V-2 (Landmine A) system INSERT inbox.messages', 'system', 'inbox.messages', 'INSERT', r.status, 'PASS');
  }

  // Landmine B, REVISED per mig200 architecture: tenant-CRM is READ-ONLY for
  // system scope. Pre-mig200 these were BLOCKERs against a naive
  // expected=PASS; mig200 deliberately repoints these write predicates to
  // tenancy.visible(...,false), so system writes here now correctly DENY.
  // This is NOT a regression — org-scoped writes are covered separately below.
  {
    const r = await tryRows(sys, () => sys(`INSERT INTO content.drafts (content_type, body) VALUES ('blog','system write') RETURNING id`));
    record('V-3 (system-scope tenant-CRM write) system INSERT content.drafts', 'system', 'content.drafts', 'INSERT', r.status, 'DENY',
      'mig200 tenancy_visible_insert_drafts uses tenancy.visible(...,false) — system may READ content.drafts (mig190) but never WRITE it; org-scoped writer required');
  }
  {
    const r = await tryRows(sys, () => sys(`UPDATE content.drafts SET title='x' WHERE id = $1 RETURNING id`, [ids.draftId]));
    // UPDATE denial via a failing USING clause is a silent 0-row no-op, not a
    // thrown RLS-violation error (WITH CHECK never even runs because USING
    // already filtered the row out of visibility) — same shape as the V-4
    // cross-org SELECT check below. BLACKHOLE(0 rows) here IS the deny.
    record('V-3 (system-scope tenant-CRM write) system UPDATE content.drafts', 'system', 'content.drafts', 'UPDATE', r.status, 'BLACKHOLE(0 rows)',
      'mig200 repoints tenancy_visible_update_drafts to allow_system=false (was is_system()-inclusive pre-mig200, a real gap) — USING excludes the row, so UPDATE silently affects 0 rows rather than throwing');
  }
  {
    const r = await tryRows(sys, () => sys(`INSERT INTO signal.contacts (email_address) VALUES ('system-write@example.com') RETURNING id`));
    record('V-3 (system-scope tenant-CRM write) system INSERT signal.contacts (mig190 SELECT-only)', 'system', 'signal.contacts', 'INSERT', r.status, 'DENY',
      'mig200 tenancy_visible_write_contacts uses allow_system=false — system reads via mig190 SELECT, org-scoped principal required to write');
  }

  // V-9 / V-5 abuse: system-scope cross-org WRITE on content.counterparties.
  // Pre-mig200 this was the headline BLOCKER: tenancy.is_system() Tier-0 had
  // no org check and backed BOTH read+write predicates, so a system-scope
  // caller could INSERT a counterparty into an org it has zero relationship
  // to. mig200's tenancy_visible_write_counterparties repoints WITH CHECK to
  // allow_system=false, closing this.
  {
    const r = await tryRows(sys, () => sys(
      `INSERT INTO content.counterparties (name, owner_org_id) VALUES ('Smoke Cross-Org CP', $1) RETURNING id`,
      [CF_ORG]
    ));
    record('V-5/V-9 (ABUSE) system cross-org INSERT content.counterparties', 'system', 'content.counterparties', 'INSERT', r.status, 'DENY',
      'mig200 closes V-9: tenancy_visible_write_counterparties WITH CHECK now allow_system=false');
  }

  await sys.release();

  // ---- AGENT SCOPE ----
  const ag = await dbAgent.withAgentScope('orchestrator', { role: 'agent' });
  {
    const r = await tryRows(ag, () => ag('SELECT id FROM agent_graph.work_items WHERE id = $1', [ids.agentWorkItemId]));
    record('agent SELECT own work_items', 'agent(orchestrator)', 'agent_graph.work_items', 'SELECT', r.status, 'PASS');
  }
  {
    const r = await tryRows(ag, () => ag(`UPDATE agent_graph.work_items SET status='in_progress' WHERE id = $1 RETURNING id`, [ids.agentWorkItemId]));
    record('agent claim/UPDATE own work_items', 'agent(orchestrator)', 'agent_graph.work_items', 'UPDATE', r.status, 'PASS');
  }
  {
    const r = await tryRows(ag, () => ag(
      `INSERT INTO agent_graph.task_events (event_type, work_item_id, target_agent_id) VALUES ('task_completed',$1,'orchestrator') RETURNING event_id`,
      [ids.agentWorkItemId]
    ));
    record('agent INSERT task_events', 'agent(orchestrator)', 'agent_graph.task_events', 'INSERT', r.status, 'PASS');
  }
  {
    const r = await tryRows(ag, () => ag(
      `INSERT INTO agent_graph.llm_invocations (agent_id, task_id, model, input_tokens, output_tokens, cost_usd, prompt_hash, response_hash, idempotency_key)
       VALUES ('orchestrator',$1,'smoke-model',1,1,0.000001,'h1','h2',$2) RETURNING id`,
      [ids.agentWorkItemId, 'smoke-agent-idem-' + randomUUID()]
    ));
    record('agent INSERT llm_invocations', 'agent(orchestrator)', 'agent_graph.llm_invocations', 'INSERT', r.status, 'PASS');
  }
  await ag.release();

  // ---- BOARD SCOPE ----
  const boardUserId = randomUUID();
  const brd = await dbAgent.withBoardScope({ role: 'board', sub: 'smoke-board-user' }, { principal: { userId: boardUserId, readOrgIds: [STAQS_ORG] } });
  {
    const r = await tryRows(brd, () => brd('SELECT id FROM content.counterparties WHERE id = $1', [ids.counterpartyId]));
    record('board SELECT counterparties (own org)', 'board(staqs)', 'content.counterparties', 'SELECT', r.status, 'PASS');
  }
  {
    const r = await tryRows(brd, () => brd('SELECT id FROM content.drafts WHERE id = $1', [ids.draftId]));
    record('board SELECT drafts (own org)', 'board(staqs)', 'content.drafts', 'SELECT', r.status, 'PASS');
  }
  {
    const r = await tryRows(brd, () => brd('SELECT id FROM signal.contacts WHERE id = $1', [ids.contactId]));
    record('board SELECT mig190 signal.contacts (own org)', 'board(staqs)', 'signal.contacts', 'SELECT', r.status, 'PASS');
  }
  {
    const r = await tryRows(brd, () => brd(`INSERT INTO content.drafts (content_type, body) VALUES ('blog','board write') RETURNING id`));
    record('V-3 (org-scoped write, own org) board INSERT content.drafts', 'board(staqs)', 'content.drafts', 'INSERT', r.status, 'PASS');
  }
  {
    const r = await tryRows(brd, () => brd(`UPDATE content.drafts SET title='board-updated' WHERE id = $1 RETURNING id`, [ids.draftId]));
    record('V-9 (org-scoped write, own org) board UPDATE content.drafts', 'board(staqs)', 'content.drafts', 'UPDATE', r.status, 'PASS');
  }
  {
    const r = await tryRows(brd, () => brd(`INSERT INTO signal.contacts (email_address) VALUES ('board-write@example.com') RETURNING id`));
    record('V-9 (org-scoped write, own org) board INSERT signal.contacts', 'board(staqs)', 'signal.contacts', 'INSERT', r.status, 'PASS');
  }
  {
    const r = await tryRows(brd, () => brd(`UPDATE signal.contacts SET email_address='board-updated@example.com' WHERE id = $1 RETURNING id`, [ids.contactId]));
    record('V-9 (org-scoped write, own org) board UPDATE signal.contacts', 'board(staqs)', 'signal.contacts', 'UPDATE', r.status, 'PASS');
  }
  {
    // content.counterparties has NO owner_org_id DEFAULT (mig149) — org-scoped
    // writers must stamp it explicitly, same as the app write path does.
    const r = await tryRows(brd, () => brd(
      `INSERT INTO content.counterparties (name, owner_org_id) VALUES ('Board Own-Org CP', $1) RETURNING id`,
      [STAQS_ORG]
    ));
    record('V-9 (org-scoped write, own org) board INSERT content.counterparties', 'board(staqs)', 'content.counterparties', 'INSERT', r.status, 'PASS');
  }
  {
    const r = await tryRows(brd, () => brd(`UPDATE content.counterparties SET name='board-updated' WHERE id = $1 RETURNING id`, [ids.counterpartyId]));
    record('V-9 (org-scoped write, own org) board UPDATE content.counterparties', 'board(staqs)', 'content.counterparties', 'UPDATE', r.status, 'PASS');
  }
  {
    // V-5/V-9 (ABUSE): org-scoped principal (board, scoped to staqs only) tries
    // to stamp a row into a DIFFERENT org than any it belongs to. Tier-2 of
    // tenancy.visible() must reject this exactly like it does for reads (V-4) —
    // proves the write-side org check is real, not just "any org-scoped caller
    // may write any org."
    const r = await tryRows(brd, () => brd(
      `INSERT INTO content.counterparties (name, owner_org_id) VALUES ('Board Cross-Org CP', $1) RETURNING id`,
      [CF_ORG]
    ));
    record('V-5/V-9 (ABUSE) board(staqs) cross-org INSERT content.counterparties', 'board(staqs)', 'content.counterparties', 'INSERT', r.status, 'DENY',
      'org-scoped principal scoped to staqs must not be able to write a row owned by consulting-futures — Tier-2 org match must fail closed on writes too');
  }
  await brd.release();

  // V-4 abuse: board scoped to a DIFFERENT org must not see staqs-owned rows
  const brdOther = await dbAgent.withBoardScope({ role: 'board', sub: 'smoke-board-user-2' }, { principal: { userId: randomUUID(), readOrgIds: [CF_ORG] } });
  {
    const r = await tryRows(brdOther, () => brdOther('SELECT id FROM content.counterparties WHERE id = $1', [ids.counterpartyId]));
    record('V-4 (ABUSE) cross-org board SELECT counterparties (wrong org)', 'board(consulting-futures)', 'content.counterparties', 'SELECT', r.status, 'BLACKHOLE(0 rows)');
  }
  await brdOther.release();

  // ---- R4: REAL MODULE ENTRY POINT (OPT-166 P2a — tick-context) ----
  // Every probe above drives a scope helper directly + a hand-written SQL string,
  // so a green run proves the POLICIES behave — it proves NOTHING about whether a
  // given module's own call sites route through a scope instead of the unscoped
  // top-level query(). This probe closes that gap for tick-context by invoking the
  // REAL buildTickContext() entry point as autobot_agent (RLS enforced — its
  // canonical lib/db.js pool binds to the agent creds Phase B set into the ambient
  // env; documented lazy-bind contract in freshDb() above).
  //
  // buildTickContext wraps each read in .catch(() => default), so a mis-wire (bare
  // query() or an agent scope) would SILENTLY return empty arrays rather than throw
  // — "did it throw" is not a sufficient assertion. We assert the seeded unclaimed
  // work item (Phase-A parent: status=created, assigned_to NULL — a cross-agent row
  // only a system scope sees) is actually visible in the snapshot's backlog count.
  {
    let status;
    try {
      const tickUrl = 'file://'
        + path.join(REPO_ROOT, 'lib', 'runtime', 'agents', 'tick-context.js')
        + '?cachebust=' + Date.now() + '_' + Math.random();
      const { buildTickContext } = await import(tickUrl);
      const ctx = await buildTickContext('agent-loop');
      const total = Number(ctx?.pendingWork?.total ?? 0);
      status = total >= 1 ? 'PASS' : `BLACKHOLE(pendingWork.total=${total})`;
    } catch (err) {
      status = classifyPgError(err);
    }
    record('V-1 REAL buildTickContext() sees cross-agent backlog (system-scope wiring)',
      'system(tick-context)', 'lib/runtime/agents/tick-context.js', 'buildTickContext()', status, 'PASS',
      'R4 real-entry-point probe: exercises the withSystemScope wiring end-to-end, not just the policy');
  }

  // ---- R5: REAL REAPER RECOVERY (OPT-166 P2b — cross-agent stuck-task recovery) ----
  // Like R4, this drives the REAL module entry point rather than a hand-written
  // scope+SQL probe — it is the only assertion that proves reaper.js actually
  // ROUTES its cross-agent ops through withSystemScope. A mis-wire (bare query()
  // for discovery, or transitionState WITHOUT systemActor:'reaper') would fail
  // silently post-flip: the discovery SELECT black-holes to 0 rows (reaper "finds
  // nothing"), or the pre-transition SELECT ... FOR UPDATE / agent_update_work_items
  // policy black-holes the seeded row → the two-step recovery no-ops and the task
  // stays stuck in_progress forever. Neither throws — so "did it throw" is not a
  // sufficient assertion. We seed a cross-agent stuck row (Phase A: in_progress,
  // assigned_to='executor-coder', updated_at 10 min old) and assert the real
  // Reaper().sweep() moved it OUT of in_progress (in_progress → timed_out →
  // assigned). The reaper imports the canonical lib/db.js pool, which binds to the
  // autobot_agent creds Phase B set into the ambient env (same lazy-bind contract
  // R4 relies on), so the sweep runs with RLS enforced — a true flip rehearsal.
  {
    let status;
    let r5detail = 'R5 real-entry-point probe: exercises reaper discovery SELECT + transitionState({systemActor}) end-to-end under RLS, not just the policy';
    try {
      const reaperUrl = 'file://'
        + path.join(REPO_ROOT, 'lib', 'runtime', 'state', 'reaper.js')
        + '?cachebust=' + Date.now() + '_' + Math.random();
      const { Reaper } = await import(reaperUrl);
      await new Reaper().sweep();
      // Read back the seeded row's status under a system scope (it is owned by
      // another agent, so an agent scope could not see it to verify).
      const chk = await dbAgent.withSystemScope('reaper', { reason: 'r5-assert' });
      try {
        const r = await chk('SELECT status FROM agent_graph.work_items WHERE id = $1', [ids.stuckWorkItemId]);
        const st = r.rows[0]?.status;
        status = (st && st !== 'in_progress') ? 'PASS' : `BLACKHOLE(status=${st ?? 'missing'})`;
      } finally {
        await chk.release();
      }
    } catch (err) {
      status = classifyPgError(err);
      r5detail = String(err?.message || err).slice(0, 200);
    }
    record('V-1 REAL Reaper.sweep() recovers cross-agent stuck task (system-transition wiring)',
      'system(reaper)', 'lib/runtime/state/reaper.js', 'Reaper.sweep()', status, 'PASS', r5detail);
  }

  // ---- R6/R7/R8: REAL context-loader ENTRY POINTS (OPT-166 P2c) ----
  // Same rationale as R4/R5: the V-1..V-9 probes above drive scope helpers + hand-
  // written SQL, proving the POLICIES behave but NOTHING about whether context-
  // loader's own call sites route through the right scope vs the unscoped top-level
  // query(). These three close that gap for the three exported entry points. Each
  // read in context-loader is wrapped in try/catch that swallows to an empty
  // default, so a mis-wire returns empty/null rather than throwing — "did it throw"
  // is insufficient. We assert on a value only a CORRECTLY-scoped read returns.
  // All three import the canonical lib/db.js pool (bound to the autobot_agent creds
  // Phase B set into the ambient env — the freshDb() lazy-bind contract R4/R5 use),
  // so they run with RLS enforced: a true flip rehearsal.
  const clUrl = () => 'file://'
    + path.join(REPO_ROOT, 'lib', 'runtime', 'agents', 'context-loader.js')
    + '?cachebust=' + Date.now() + '_' + Math.random();

  // R6 — loadContext() HEAD READ (work_items PK, system scope). A chat/api/agent
  // load of ANOTHER agent's item must never black-hole the core work item. We drive
  // the REAL loadContext() as 'agent-loop' (NOT the assignee) against the seeded
  // child (assigned_to='orchestrator', parent_id set → invisible to agent-loop's
  // agent scope) and assert context.workItem is populated. Only the system-scoped
  // head read makes that true; a bare query()/agent scope would yield workItem=null
  // (and, because every downstream read tolerates a null work item, throw nothing).
  {
    let status;
    try {
      const { loadContext } = await import(clUrl());
      const ctx = await loadContext('agent-loop', ids.agentWorkItemId);
      const seen = ctx?.workItem?.id;
      status = seen === ids.agentWorkItemId ? 'PASS' : `BLACKHOLE(workItem=${seen ?? 'null'})`;
    } catch (err) {
      status = classifyPgError(err);
    }
    record('V-1 REAL loadContext() head read sees cross-agent item (system-scope wiring)',
      'system(context-loader)', 'lib/runtime/agents/context-loader.js', 'loadContext()', status, 'PASS',
      'R6 real-entry-point probe: the work_items PK head read routes through withSystemScope, not bare query()/agent scope');
  }

  // R7 — loadReflectionContext() (recentOutcomes, own-items AGENT scope). Reads the
  // reflecting agent's OWN completed/failed items (assigned_to=$1). Wrapped in
  // withAgentScope(agentId) — least-privilege (agent_read_work_items grants on
  // assigned_to=current_agent_id()). A mis-wire to bare query() black-holes post-flip
  // (no current_agent_id() → USING false → 0 rows), swallowed to []. We seeded a
  // completed item + terminal transition for 'executor-triage' and assert it surfaces.
  {
    let status;
    try {
      const { loadReflectionContext } = await import(clUrl());
      const rc = await loadReflectionContext('executor-triage');
      const outcomes = rc?.recentOutcomes || [];
      status = outcomes.some((o) => o.id === ids.completedWorkItemId)
        ? 'PASS' : `BLACKHOLE(recentOutcomes=${outcomes.length})`;
    } catch (err) {
      status = classifyPgError(err);
    }
    record('V-1 REAL loadReflectionContext() sees own completed item (agent-scope wiring)',
      'agent(executor-triage)', 'lib/runtime/agents/context-loader.js', 'loadReflectionContext()', status, 'PASS',
      'R7 real-entry-point probe: the recentOutcomes read routes through withAgentScope, not bare query()');
  }

  // R8 — loadSystemTopology() (successRates, cross-agent SYSTEM scope). GROUP BY
  // assigned_to over the whole fleet's completed/failed items is a cross-agent
  // routing aggregate. Wrapped in withSystemScope('context-loader'); an agent scope
  // keyed to the caller would collapse it to the caller's own rows and silently
  // under-report every other agent. We call loadSystemTopology('agent-loop') (NOT the
  // completed item's assignee) and assert the seeded 'executor-triage' row appears.
  {
    let status;
    try {
      const { loadSystemTopology } = await import(clUrl());
      const topo = await loadSystemTopology('agent-loop');
      const rates = topo?.successRates || [];
      status = rates.some((r) => r.assigned_to === 'executor-triage')
        ? 'PASS' : `BLACKHOLE(successRates=${rates.length})`;
    } catch (err) {
      status = classifyPgError(err);
    }
    record('V-1 REAL loadSystemTopology() sees cross-agent success rates (system-scope wiring)',
      'system(context-loader)', 'lib/runtime/agents/context-loader.js', 'loadSystemTopology()', status, 'PASS',
      'R8 real-entry-point probe: the successRates cross-agent aggregate routes through withSystemScope, not agent scope');
  }

  // ---- R9: REAL resolveSignalsByMessage() org-scope seam (OPT-166 P2d — gmail poller) ----
  // Same rationale as R4-R8: the V-1..V-9 probes drive scope helpers + hand-written SQL,
  // proving the POLICIES behave but NOTHING about whether a module's own call sites inject
  // the right scope. The gmail poller's reconcileSignals() marks signals resolved on
  // archived/deleted/replied messages via resolveSignalsByMessage(). inbox.signals' write
  // policy (mig200) is tenancy.visible(NULL, owner_org_id, false) — ORG-ONLY, so post-flip
  // that UPDATE black-holes to rowCount 0 (a SILENT no-op: signals never mark resolved, the
  // poller re-detects them every cycle forever) UNLESS run under an agent scope whose
  // app.org_ids contains the signal's owner_org_id. reconcileSignals injects exactly that
  // via resolveSignalsScoped(ownerOrgId, ...). The Gmail-fetch half of reconcileSignals
  // needs a live googleapis client (network) so it is covered by the poller unit tests;
  // R9 drives the DB seam — the ONLY RLS-relevant part — through the REAL exported
  // resolveSignalsByMessage(), two ways as autobot_agent (RLS enforced):
  //   (a) exec = withAgentScope('gmail-poller', {orgIds:[STAQS_ORG]}) → expect rowCount 1
  //   (b) default (un-injected) query → expect rowCount 0 (black-hole — proves the scope is
  //       load-bearing; a forgotten injection silently no-ops, never throws).
  {
    const extractorUrl = 'file://'
      + path.join(REPO_ROOT, 'autobot-inbox', 'src', 'signal', 'extractor.js')
      + '?cachebust=' + Date.now() + '_' + Math.random();
    const { resolveSignalsByMessage } = await import(extractorUrl);

    // (a) org-scoped → resolves the signal (rowCount 1)
    let scopedStatus;
    const scope = await dbAgent.withAgentScope('gmail-poller', { orgIds: [STAQS_ORG] });
    try {
      const n = await resolveSignalsByMessage(ids.r9ScopedMessageId, 'r9_scoped', { exec: scope });
      scopedStatus = n === 1 ? 'PASS' : `BLACKHOLE(rowCount=${n})`;
    } catch (err) {
      scopedStatus = classifyPgError(err);
    } finally {
      await scope.release();
    }
    record('V-3 REAL resolveSignalsByMessage() resolves under org scope (gmail-poller wiring)',
      'agent(gmail-poller)', 'inbox.signals', 'UPDATE', scopedStatus, 'PASS',
      'R9a real-entry-point probe: org-scoped UPDATE marks the signal resolved (rowCount=1), not bare query()');

    // (b) un-injected default query → black-holes (silent no-op, rowCount 0)
    let unscopedStatus;
    try {
      const n = await resolveSignalsByMessage(ids.r9UnscopedMessageId, 'r9_unscoped');
      unscopedStatus = n === 0 ? 'PASS' : `LEAK(rowCount=${n})`;
    } catch (err) {
      unscopedStatus = classifyPgError(err);
    }
    record('V-3 NEG resolveSignalsByMessage() black-holes WITHOUT scope (gmail-poller wiring)',
      'agent(unscoped)', 'inbox.signals', 'UPDATE', unscopedStatus, 'PASS',
      'R9b negative probe: un-injected UPDATE silently no-ops (rowCount=0) — proves the org scope injected by reconcileSignals is load-bearing');
  }

  // ---- R10: REAL recordSpendMetered() / dailySpendMeteredUsd() metering seam (OPT-166 P2e-E1) ----
  // Same rationale as R4-R9: the V-1 llm_invocations probes prove the POLICIES behave, but say
  // NOTHING about whether the metering primitive's own call sites route through a system scope.
  // The research-source poller + artifact enricher meter direct-SDK spend via recordSpendMetered()
  // / dailySpendMeteredUsd(). agent_graph.llm_invocations' INSERT policy is system_insert_invocations
  // WITH CHECK(is_system()) (sql/200) and its daily-spend SELECT (agent_read_invocations) resolves
  // real rows only via its OR is_system() branch. Post-flip a BARE (unscoped) INSERT satisfies
  // NEITHER agent_insert_invocations (agent_id != unset current_agent_id()) NOR system_insert_invocations
  // → hard-denied, and recordSpend's best-effort swallow turns that into a SILENT {recorded:false};
  // a BARE daily SELECT collapses to $0, blowing G10's self-enforced cap wide open. The metered
  // wrappers open withSystemScope('metering') so both resolve. R10 drives the REAL exported wrappers
  // as autobot_agent (RLS enforced — canonical lib/db.js pool bound to the agent creds Phase B set),
  // with the bare primitives as the negative control:
  //   (a) recordSpendMetered({agentId:'orchestrator',...}) → {recorded:true}   (is_system() INSERT)
  //   (b) dailySpendMeteredUsd('orchestrator')            → committed spend > 0 (is_system() SELECT)
  //   (c) bare recordSpend({...}) (no scope)              → {recorded:false}    (INSERT fail-closed, swallowed)
  //   (d) bare dailySpendUsd('orchestrator')              → 0                   (SELECT black-hole; the row IS committed but RLS hides it)
  {
    const spendUrl = 'file://'
      + path.join(REPO_ROOT, 'lib', 'llm', 'record-spend.js')
      + '?cachebust=' + Date.now() + '_' + Math.random();
    const { recordSpendMetered, dailySpendMeteredUsd, recordSpend, dailySpendUsd } = await import(spendUrl);
    const R10_AGENT = 'orchestrator'; // seeded in agent_configs (V-1 uses it) → satisfies the FK
    const R10_COST = 0.0424;

    // (a) metered INSERT → recorded true (system scope satisfies WITH CHECK is_system())
    let insStatus;
    try {
      const res = await recordSpendMetered({
        agentId: R10_AGENT, model: 'gpt-4o-mini', costUsd: R10_COST,
        taskId: 'r10_metered', kind: 'web_search', provider: 'openai',
      });
      insStatus = res?.recorded === true ? 'PASS' : `BLACKHOLE(recorded=${res?.recorded})`;
    } catch (err) {
      insStatus = classifyPgError(err);
    }
    record('V-1 REAL recordSpendMetered() records spend under system scope (metering wiring)',
      'system(metering)', 'agent_graph.llm_invocations', 'INSERT', insStatus, 'PASS',
      'R10a real-entry-point probe: withSystemScope(metering) satisfies WITH CHECK is_system() → recorded=true, not a swallowed fail-closed');

    // (b) metered daily read → sees the committed spend (> 0), not a $0 black-hole
    let readStatus;
    try {
      const spent = await dailySpendMeteredUsd(R10_AGENT);
      readStatus = spent >= R10_COST ? 'PASS' : `BLACKHOLE(spend=${spent})`;
    } catch (err) {
      readStatus = classifyPgError(err);
    }
    record('V-1 REAL dailySpendMeteredUsd() reads real spend under system scope (G10 cap)',
      'system(metering)', 'agent_graph.llm_invocations', 'SELECT', readStatus, 'PASS',
      'R10b real-entry-point probe: is_system() branch resolves the committed row → spend>0, not a silent $0 that blows G10 open');

    // (c) NEG: bare recordSpend (no scope) → INSERT fails-closed, swallowed to recorded:false
    let negInsStatus;
    try {
      const res = await recordSpend({
        agentId: R10_AGENT, model: 'gpt-4o-mini', costUsd: R10_COST,
        taskId: 'r10_unscoped', kind: 'web_search', provider: 'openai',
      });
      negInsStatus = res?.recorded === false ? 'PASS' : `LEAK(recorded=${res?.recorded})`;
    } catch (err) {
      negInsStatus = classifyPgError(err);
    }
    record('V-1 NEG recordSpend() fails-closed WITHOUT scope (metering wiring)',
      'agent(unscoped)', 'agent_graph.llm_invocations', 'INSERT', negInsStatus, 'PASS',
      'R10c negative probe: bare INSERT matches no WITH CHECK (not agent, not is_system) → swallowed to recorded:false — proves the metering system scope is load-bearing');

    // (d) NEG: bare dailySpendUsd → $0 black-hole (the committed row exists but RLS hides it)
    let negReadStatus;
    try {
      const spent = await dailySpendUsd(R10_AGENT);
      negReadStatus = spent === 0 ? 'PASS' : `LEAK(spend=${spent})`;
    } catch (err) {
      negReadStatus = classifyPgError(err);
    }
    record('V-1 NEG dailySpendUsd() black-holes to $0 WITHOUT scope (metering wiring)',
      'agent(unscoped)', 'agent_graph.llm_invocations', 'SELECT', negReadStatus, 'PASS',
      "R10d negative probe: bare SELECT returns $0 though the row is committed — proves dailySpendMeteredUsd's system scope is load-bearing for G10");
  }

  // ---- R11: REAL ingestDocument() research content.documents seam (OPT-166 P2e-E2) ----
  // Same rationale as R4-R10: the content.documents POLICY probes prove the policies behave,
  // but say NOTHING about whether the research-source poller's ingest call site routes its
  // writes through an org scope. content.documents' write policy is tenancy_visible_write_documents
  // FOR ALL USING/WITH CHECK tenancy.visible(NULL::uuid, owner_org_id, false) (sql/200) —
  // allow_system=FALSE, so post-flip a BARE (unscoped) INSERT satisfies NEITHER an org branch
  // (app.org_ids unset) NOR is_system() → hard-denied 42501. The poller passes
  // writerOrgScope:{actorId:'rd-feed-poller', orgId} into ingestDocument, which force-stamps
  // owner_org_id and opens withAgentScope(orgId) around every content.documents statement group
  // (dedup SELECT, force-update DELETEs, INSERT, compile_status UPDATE). R11 drives the REAL
  // exported ingestDocument as autobot_agent (RLS enforced — canonical lib/db.js pool bound to
  // the agent creds Phase B set), skipEmbedding:true so no embedder network call, with the bare
  // (un-injected) path as the negative control. Read-backs run on dbAgent's own agent-scoped
  // pool (a genuinely separate connection from ingest's canonical pool → also proves the row
  // COMMITs across connections, not just within ingest's transaction):
  //   (a) ingestDocument({writerOrgScope:STAQS}) → documentId non-null (INSERT satisfies WITH CHECK)
  //   (b) scoped read-back under STAQS      → row visible, owner_org_id=STAQS, compile_status='pending'
  //   (c) NEG bare ingestDocument (no scope)→ INSERT hard-denied (42501 → DENY), fail-closed
  //   (d) wrong-org scope (CF) SELECT (a)'s sourceId → 0 rows (cross-org isolation)
  //   (e) forceUpdate under STAQS scope     → documentId non-null, exactly 1 row for the sourceId
  //   (f) autobot_agent is NOT content.documents' owner → FORCE-free RLS still applies to it
  //   (g) agent_graph.project_memberships has 0 RLS policies → the poller's membership INSERT is
  //       inert post-flip (its withResearchOrgScope wrapper is harmless belt-and-suspenders)
  {
    const ingestUrl = 'file://'
      + path.join(REPO_ROOT, 'lib', 'rag', 'ingest.js')
      + '?cachebust=' + Date.now() + '_' + Math.random();
    const { ingestDocument } = await import(ingestUrl);
    const R11_SOURCE = 'feed';
    const R11_SID = 'r11-feed-doc-1';
    const R11_BODY = 'Quarterly research digest on autonomous agent governance. '
      + 'This body carries no email addresses so participant resolution stays a no-op, '
      + 'isolating the probe to the content.documents write path.';

    // (a) scoped INSERT → documentId (system scope would ALSO black-hole; org scope is mandatory)
    let insStatus;
    let r11aDocId = null;
    try {
      const res = await ingestDocument({
        source: R11_SOURCE, sourceId: R11_SID, title: 'R11 feed doc',
        rawText: R11_BODY, format: 'plain', skipEmbedding: true,
        writerOrgScope: { actorId: 'rd-feed-poller', orgId: STAQS_ORG },
      });
      r11aDocId = res?.documentId || null;
      insStatus = r11aDocId ? 'PASS' : `BLACKHOLE(documentId=${res?.documentId})`;
    } catch (err) {
      insStatus = classifyPgError(err);
    }
    record('V-3 REAL ingestDocument() writes content.documents under org scope (research-poller wiring)',
      'agent(rd-feed-poller)', 'content.documents', 'INSERT', insStatus, 'PASS',
      'R11a real-entry-point probe: writerOrgScope force-stamps owner_org_id + opens withAgentScope → INSERT satisfies WITH CHECK tenancy.visible(...) → documentId returned, not a swallowed deny');

    // (b) scoped read-back → row visible, correct org, compile_status pending
    let readStatus;
    {
      const scope = await dbAgent.withAgentScope('rd-feed-poller', { orgIds: [STAQS_ORG] });
      try {
        const r = await scope(
          `SELECT owner_org_id, compile_status FROM content.documents WHERE source = $1 AND source_id = $2`,
          [R11_SOURCE, R11_SID]
        );
        const row = r.rows[0];
        readStatus = (r.rows.length === 1 && row.owner_org_id === STAQS_ORG && row.compile_status === 'pending')
          ? 'PASS'
          : `BLACKHOLE(rows=${r.rows.length},org=${row?.owner_org_id},compile=${row?.compile_status})`;
      } catch (err) {
        readStatus = classifyPgError(err);
      } finally {
        await scope.release();
      }
    }
    record('V-3 REAL ingestDocument() row is org-scoped + wiki-compilable (research-poller wiring)',
      'agent(rd-feed-poller)', 'content.documents', 'SELECT', readStatus, 'PASS',
      "R11b real-entry-point probe: the committed row is visible under STAQS org scope with owner_org_id=STAQS and compile_status='pending' (feed docs feed the wiki pipeline), not a $0-style black-hole");

    // (c) NEG: bare ingestDocument (no writerOrgScope) → INSERT hard-denied, fail-closed
    let negInsStatus;
    try {
      await ingestDocument({
        source: R11_SOURCE, sourceId: 'r11-feed-doc-unscoped', title: 'R11 unscoped',
        rawText: R11_BODY, format: 'plain', skipEmbedding: true,
        // no writerOrgScope → runScoped falls back to bare query()
      });
      negInsStatus = 'LEAK(insert-succeeded-unscoped)';
    } catch (err) {
      negInsStatus = classifyPgError(err) === 'DENY' ? 'PASS' : classifyPgError(err);
    }
    record('V-3 NEG ingestDocument() INSERT fails-closed WITHOUT scope (research-poller wiring)',
      'agent(unscoped)', 'content.documents', 'INSERT', negInsStatus, 'PASS',
      'R11c negative probe: bare INSERT matches no write branch (org_ids unset, allow_system=false) → 42501 hard-deny — proves the writerOrgScope injected by the poller is load-bearing');

    // (d) wrong-org isolation: CF scope cannot see the STAQS row
    let isoStatus;
    {
      const scope = await dbAgent.withAgentScope('rd-feed-poller', { orgIds: [CF_ORG] });
      try {
        const r = await scope(
          `SELECT id FROM content.documents WHERE source = $1 AND source_id = $2`,
          [R11_SOURCE, R11_SID]
        );
        isoStatus = r.rows.length === 0 ? 'PASS' : `LEAK(rows=${r.rows.length})`;
      } catch (err) {
        isoStatus = classifyPgError(err);
      } finally {
        await scope.release();
      }
    }
    record('V-3 NEG cross-org scope cannot read another org\'s research doc',
      'agent(wrong-org)', 'content.documents', 'SELECT', isoStatus, 'PASS',
      "R11d isolation probe: a CF-org scope SELECTing the STAQS row's sourceId returns 0 rows — owner_org_id scoping holds across orgs, not just against the unscoped case");

    // (e) forceUpdate under scope re-ingests (scoped DELETE+INSERT), leaves exactly one row
    let fuStatus;
    try {
      const res = await ingestDocument({
        source: R11_SOURCE, sourceId: R11_SID, title: 'R11 feed doc v2',
        rawText: R11_BODY + ' Revised edition.', format: 'plain', skipEmbedding: true,
        forceUpdate: true,
        writerOrgScope: { actorId: 'rd-feed-poller', orgId: STAQS_ORG },
      });
      if (!res?.documentId) {
        fuStatus = `BLACKHOLE(documentId=${res?.documentId})`;
      } else {
        const scope = await dbAgent.withAgentScope('rd-feed-poller', { orgIds: [STAQS_ORG] });
        try {
          const r = await scope(
            `SELECT count(*)::int AS n FROM content.documents WHERE source = $1 AND source_id = $2`,
            [R11_SOURCE, R11_SID]
          );
          fuStatus = r.rows[0].n === 1 ? 'PASS' : `DUP(rows=${r.rows[0].n})`;
        } finally {
          await scope.release();
        }
      }
    } catch (err) {
      fuStatus = classifyPgError(err);
    }
    record('V-3 REAL ingestDocument(forceUpdate) re-ingests under org scope (research refresh path)',
      'agent(rd-feed-poller)', 'content.documents', 'DELETE+INSERT', fuStatus, 'PASS',
      'R11e real-entry-point probe: forceUpdate deletes+reinserts entirely under withAgentScope (scoped dedup SELECT sees the prior row so refresh triggers) → exactly one row remains, no orphan');

    // (f) autobot_agent must NOT own content.documents (owners bypass non-FORCE RLS)
    let ownerStatus;
    try {
      const r = await dbAgent.query(
        `SELECT tableowner FROM pg_tables WHERE schemaname = 'content' AND tablename = 'documents'`
      );
      ownerStatus = (r.rows.length === 1 && r.rows[0].tableowner !== 'autobot_agent')
        ? 'PASS'
        : `OWNS(tableowner=${r.rows[0]?.tableowner})`;
    } catch (err) {
      ownerStatus = classifyPgError(err);
    }
    record('V-3 content.documents is NOT owned by autobot_agent (RLS actually applies)',
      'n/a', 'content.documents', 'catalog', ownerStatus, 'PASS',
      'R11f invariant probe: a table owner bypasses its own RLS unless FORCE is set — autobot_agent owning content.documents would silently void every write-scope above');

    // (g) project_memberships has 0 RLS policies → poller membership INSERT is inert post-flip
    let memStatus;
    try {
      const r = await dbAgent.query(
        `SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'agent_graph' AND tablename = 'project_memberships'`
      );
      memStatus = r.rows[0].n === 0 ? 'PASS' : `HAS_RLS(policies=${r.rows[0].n})`;
    } catch (err) {
      memStatus = classifyPgError(err);
    }
    record('V-3 agent_graph.project_memberships has no RLS (poller membership INSERT inert)',
      'n/a', 'agent_graph.project_memberships', 'catalog', memStatus, 'PASS',
      "R11g invariant probe: 0 policies confirms the poller's project_memberships INSERT survives the flip unchanged — its withResearchOrgScope wrapper is harmless belt-and-suspenders, not a load-bearing scope");
  }

  // ---- R12: REAL tl;dv poller inbox.messages system-scope seam (OPT-166 P2e-E3) ----
  // The tl;dv poller writes two RLS-governed tables. Its content.documents half rides the
  // SAME ingestDocument({writerOrgScope}) seam R11 already proves end-to-end (identical
  // contract, actorId 'tldv-poller'/'tldv-webhook') — no need to re-prove it. What's NEW and
  // tl;dv-unique is ensureTldvMessageAndWorkItem's inbox.messages INSERT: its policy is
  // system_insert_messages FOR INSERT WITH CHECK (tenancy.is_system()) (sql/200), so post-flip
  // a BARE INSERT satisfies neither an org branch nor is_system() → 42501. The poller wraps ONLY
  // that INSERT in withSystemScope('tldv-poller'); the dedup SELECT + snippet/work_item_id
  // UPDATEs stay unscoped because read_messages / agent_update_messages are bare-permissive
  // (USING true / WITH CHECK true). ensureTldvMessageAndWorkItem isn't exercisable in-sensor
  // (it fetches transcripts over the network + dynamic-imports createWorkItem), so R12 drives the
  // IDENTICAL INSERT SQL under the IDENTICAL scope the poller uses, with the bare path as the
  // negative control, plus the invariants that make the negative real and the gate-cleared claim
  // (createWorkItem survives unscoped) auditable:
  //   (a) withSystemScope('tldv-poller') INSERT → id non-null (satisfies WITH CHECK is_system())
  //   (b) bare read-back (read_messages USING true) → row visible, owner_org_id=STAQS DEFAULT
  //       (proves the role-gated INSERT omitting owner_org_id lands a valid non-NULL default row)
  //   (c) NEG bare INSERT (no scope) → 42501 hard-deny — proves the system scope is load-bearing
  //   (d) bare snippet UPDATE → rowCount 1 — proves agent_update_messages is bare-permissive, so
  //       the poller correctly leaves both inbox.messages UPDATEs unscoped
  //   (e) inbox.messages relforcerowsecurity=true — RLS applies even to the table owner, so (c)'s
  //       deny is real (not an owner-bypass artifact)
  //   (f) state_transitions + work_items INSERT policies are WITH CHECK true — the E3 gate: the
  //       createWorkItem hash-chain + work_item INSERT survive unscoped, so the poller needs NO
  //       system scope around createWorkItem (only the messages INSERT)
  {
    const R12_MID = 'r12-tldv-meeting-1';
    const R12_PMID = `tldv_${R12_MID}`;
    const R12_COLS = `(provider_msg_id, provider, channel, thread_id, message_id,
      from_address, from_name, to_addresses, subject, snippet,
      received_at, labels, has_attachments, channel_id)`;
    const r12Vals = (pmid, chId) => [
      pmid, 'webhook', 'webhook',
      `wh_thread_${pmid}`, `<${pmid}@webhook>`,
      'tldv', 'tl;dv', ['system@autobot'],
      'R12 tldv meeting', 'R12 transcript snippet',
      new Date().toISOString(), ['webhook:tldv', 'tldv:transcript', 'tldv:poll'],
      false, chId,
    ];

    // (a) system-scoped INSERT → id (an org scope would ALSO fail here; is_system() is mandatory)
    let insStatus;
    {
      const sys = await dbAgent.withSystemScope('tldv-poller', { reason: 'flip-readiness-smoke-r12' });
      try {
        const r = await sys(
          `INSERT INTO inbox.messages ${R12_COLS}
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
          r12Vals(R12_PMID, R12_MID)
        );
        insStatus = r.rows[0]?.id ? 'PASS' : `BLACKHOLE(id=${r.rows[0]?.id})`;
      } catch (err) {
        insStatus = classifyPgError(err);
      } finally {
        await sys.release();
      }
    }
    record('V-E3 REAL tl;dv inbox.messages INSERT lands under system scope (poller wiring)',
      'system(tldv-poller)', 'inbox.messages', 'INSERT', insStatus, 'PASS',
      'R12a real-seam probe: the poller wraps the messages INSERT in withSystemScope(tldv-poller) → satisfies WITH CHECK tenancy.is_system() → id returned, not a swallowed 42501');

    // (b) bare read-back (SELECT is bare-permissive) → visible, owner_org_id defaulted to STAQS
    let readStatus;
    try {
      const r = await dbAgent.query(
        `SELECT owner_org_id FROM inbox.messages WHERE channel = 'webhook' AND channel_id = $1`,
        [R12_MID]
      );
      const row = r.rows[0];
      readStatus = (r.rows.length === 1 && row.owner_org_id === STAQS_ORG)
        ? 'PASS'
        : `BLACKHOLE(rows=${r.rows.length},org=${row?.owner_org_id})`;
    } catch (err) {
      readStatus = classifyPgError(err);
    }
    record('V-E3 tl;dv message row is visible with STAQS default owner_org_id (poller wiring)',
      'agent', 'inbox.messages', 'SELECT', readStatus, 'PASS',
      'R12b real-seam probe: read_messages USING(true) makes the row visible unscoped, and the role-gated INSERT omitting owner_org_id lands the mig-138 DEFAULT (STAQS) — not NULL, not a black-hole');

    // (c) NEG: bare INSERT (no system scope) → 42501 hard-deny
    let negStatus;
    try {
      await dbAgent.query(
        `INSERT INTO inbox.messages ${R12_COLS}
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
        r12Vals(`${R12_PMID}-bare`, `${R12_MID}-bare`)
      );
      negStatus = 'LEAK(insert-succeeded-unscoped)';
    } catch (err) {
      negStatus = classifyPgError(err) === 'DENY' ? 'PASS' : classifyPgError(err);
    }
    record('V-E3 NEG bare tl;dv message INSERT fails-closed WITHOUT system scope',
      'agent(unscoped)', 'inbox.messages', 'INSERT', negStatus, 'PASS',
      'R12c negative probe: bare INSERT matches no WITH CHECK branch (not agent-writable, not is_system) → 42501 hard-deny — proves withSystemScope(tldv-poller) is load-bearing, not decorative');

    // (d) bare snippet UPDATE → rowCount 1 (agent_update_messages is bare-permissive)
    let updStatus;
    try {
      const r = await dbAgent.query(
        `UPDATE inbox.messages SET snippet = $1 WHERE channel = 'webhook' AND channel_id = $2`,
        ['R12 refreshed snippet', R12_MID]
      );
      updStatus = r.rowCount === 1 ? 'PASS' : `NOOP(rowCount=${r.rowCount})`;
    } catch (err) {
      updStatus = classifyPgError(err);
    }
    record('V-E3 tl;dv message snippet UPDATE succeeds UNSCOPED (bare-permissive policy)',
      'agent(unscoped)', 'inbox.messages', 'UPDATE', updStatus, 'PASS',
      'R12d invariant probe: agent_update_messages FOR UPDATE USING(true) WITH CHECK(true) → the poller correctly leaves both inbox.messages UPDATEs (snippet refresh, work_item_id) unscoped; only the INSERT needs a scope');

    // (e) inbox.messages FORCE RLS → the (c) deny is real, not an owner-bypass artifact
    let forceStatus;
    try {
      const r = await dbAgent.query(
        `SELECT relforcerowsecurity FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'inbox' AND c.relname = 'messages'`
      );
      forceStatus = r.rows[0]?.relforcerowsecurity === true ? 'PASS' : `NO_FORCE(force=${r.rows[0]?.relforcerowsecurity})`;
    } catch (err) {
      forceStatus = classifyPgError(err);
    }
    record('V-E3 inbox.messages has FORCE RLS (INSERT policy applies to the owner too)',
      'n/a', 'inbox.messages', 'catalog', forceStatus, 'PASS',
      'R12e invariant probe: relforcerowsecurity=true means even a table owner is bound by the INSERT policy — without it R12c could pass by owner-bypass and mask a post-flip 42501');

    // (f) E3 gate: state_transitions + work_items INSERT policies are permissive-true → the
    //     createWorkItem hash-chain + work_item INSERT survive unscoped (poller wraps neither)
    let gateStatus;
    try {
      const r = await dbAgent.query(
        `SELECT tablename, with_check FROM pg_policies
         WHERE schemaname = 'agent_graph'
           AND tablename IN ('state_transitions', 'work_items')
           AND cmd = 'INSERT'`
      );
      const byTable = Object.fromEntries(r.rows.map(x => [x.tablename, (x.with_check || '').replace(/\s/g, '')]));
      const permissive = v => v === 'true';
      gateStatus = (permissive(byTable['state_transitions']) && permissive(byTable['work_items']))
        ? 'PASS'
        : `GATED(st=${byTable['state_transitions']},wi=${byTable['work_items']})`;
    } catch (err) {
      gateStatus = classifyPgError(err);
    }
    record('V-E3 createWorkItem survives unscoped: state_transitions + work_items INSERT are WITH CHECK true',
      'n/a', 'agent_graph.{state_transitions,work_items}', 'catalog', gateStatus, 'PASS',
      'R12f gate probe: both INSERT policies are permissive-true, so the poller correctly wraps ONLY the messages INSERT in system scope and leaves createWorkItem (hash-chain + work_item INSERT) unscoped — the E3 no-migration gate, made falsifiable');
  }

  // ---- R13: REAL calendar attendee resolveAndUpsert signal.contacts seam (OPT-166 P2e-E4) ----
  // The calendar poller resolves attendees into signal.contacts (SELECT + upsert). That table's
  // SELECT policy is org-keyed allow_system=TRUE (visible(NULL,owner_org_id,true), sql/190) and its
  // write policy is org-scoped allow_system=FALSE (visible(NULL,owner_org_id,false), sql/200). So
  // post-flip a BARE read black-holes to 0 rows (every attendee resolves as unresolved) and a BARE
  // write hard-fails 42501. The poller now wraps resolveAndUpsert in withAgentScope('calendar-poller',
  // {orgIds:[CURRENT_ORG_ID]}) — ORG scope, not system (system does NOT satisfy the FALSE write
  // policy → this file is deliberately NOT a withSystemScope caller; the ratchet stays put). R13 drives
  // the REAL resolveAndUpsert(exec) entry point as autobot_agent under that exact scope, then proves
  // the two negatives (bare + system both denied) and the E4-unique SAVEPOINT-isolation invariant that
  // keeps one attendee's denial from poisoning the shared txn and silently dropping the rest of the batch:
  //   (a) org-scoped resolveAndUpsert([new email]) → record.contact_id non-null (read-miss → INSERT
  //       satisfies WITH CHECK visible(NULL,STAQS,false)); resolver swallows write errors, so a non-null
  //       contact_id is the only proof the write actually landed (not a fail-open skip)
  //   (b) bare read-back → row visible with owner_org_id=STAQS DEFAULT (INSERT omits owner_org_id)
  //   (c) NEG raw bare INSERT (no scope) → 42501 — proves the org write scope is load-bearing (probed
  //       raw, not via resolveAndUpsert, because the resolver's fail-open catch would eat the 42501)
  //   (d) NEG cross-org read: CF-org scope SELECTing the STAQS contact → 0 rows — org-keyed SELECT holds
  //   (e) NEG system scope INSERT → 42501 — the write policy is allow_system=FALSE, so system scope is
  //       insufficient; org scope is mandatory — this is exactly why E4 uses withAgentScope (ratchet unmoved)
  //   (f) SAVEPOINT isolation: in ONE org-scope txn a failing statement poisons it (25P02) so a later
  //       bare write throws — WITH a SAVEPOINT bracket (isolatedWrite's mechanism) ROLLBACK TO recovers
  //       and the later write lands. Proves the per-block savepoints keep a mid-batch denial from
  //       vanishing every subsequent attendee.
  {
    const resolverUrl = 'file://'
      + path.join(REPO_ROOT, 'lib', 'rag', 'participants', 'resolver.js')
      + '?cachebust=' + Date.now() + '_' + Math.random();
    const { resolveAndUpsert } = await import(resolverUrl);
    const R13_EMAIL = 'r13.attendee@calendar-probe.example';

    // (a) REAL org-scoped resolveAndUpsert → contact_id lands
    let aStatus;
    {
      const scope = await dbAgent.withAgentScope('calendar-poller', { orgIds: [STAQS_ORG] });
      try {
        const recs = await resolveAndUpsert(
          [{ email: R13_EMAIL, name: 'R13 Attendee', role: 'attendee' }],
          { accountId: null },
          scope,
        );
        aStatus = recs[0]?.contact_id ? 'PASS' : `SWALLOWED(contact_id=${recs[0]?.contact_id})`;
      } catch (err) {
        aStatus = classifyPgError(err);
      } finally {
        await scope.release();
      }
    }
    record('V-E4 REAL calendar resolveAndUpsert lands signal.contacts under org scope (poller wiring)',
      'agent(calendar-poller)', 'signal.contacts', 'INSERT', aStatus, 'PASS',
      'R13a real-seam probe: withAgentScope(calendar-poller,{STAQS}) → read-miss then INSERT satisfies WITH CHECK visible(NULL,STAQS,false) → contact_id returned; the resolver swallows write errors, so a non-null id is the ONLY proof the write landed rather than fail-open-skipping');

    // (b) the committed row black-holes for a BARE read (signal.contacts SELECT is org-keyed,
    //     NOT bare-permissive like inbox.messages) but IS visible under a FRESH STAQS scope on a
    //     DIFFERENT pooled client with owner_org_id=STAQS — proving release() COMMITted durably
    //     (cross-connection) AND the org-scoped INSERT stamped the mig-134 DEFAULT correctly.
    let bStatus;
    try {
      const bare = await dbAgent.query(
        `SELECT owner_org_id FROM signal.contacts WHERE email_address = $1`, [R13_EMAIL]);
      const scope = await dbAgent.withAgentScope('calendar-poller', { orgIds: [STAQS_ORG] });
      let scoped;
      try {
        scoped = await scope(
          `SELECT owner_org_id FROM signal.contacts WHERE email_address = $1`, [R13_EMAIL]);
      } finally {
        await scope.release();
      }
      const row = scoped.rows[0];
      bStatus = (bare.rows.length === 0 && scoped.rows.length === 1 && row.owner_org_id === STAQS_ORG)
        ? 'PASS'
        : `MISMATCH(bare=${bare.rows.length},scoped=${scoped.rows.length},org=${row?.owner_org_id})`;
    } catch (err) {
      bStatus = classifyPgError(err);
    }
    record('V-E4 committed contact black-holes bare but is STAQS-visible under scope (commit + org-stamp)',
      'agent', 'signal.contacts', 'SELECT', bStatus, 'PASS',
      'R13b real-seam probe: the org-keyed SELECT policy black-holes a BARE read-back (rows=0 — the exact pre-scope failure mode E4 closes, and why the read-back CANNOT be bare like tl;dv R12b), while a fresh STAQS scope on a DIFFERENT pooled client sees exactly 1 row with owner_org_id=STAQS DEFAULT — proving withAgentScope.release() COMMITted the write durably and the org-scoped INSERT stamped it correctly');

    // (c) NEG raw bare INSERT (no scope) → 42501 (resolver swallows, so probe raw)
    let cStatus;
    try {
      await dbAgent.query(
        `INSERT INTO signal.contacts
           (email_address, name, contact_type, tier, source_account_id, metadata, created_at, updated_at)
         VALUES ($1, 'R13 bare', 'participant', 'unknown', NULL, '{}'::jsonb, now(), now())`,
        ['r13.bare@calendar-probe.example']
      );
      cStatus = 'LEAK(insert-succeeded-unscoped)';
    } catch (err) {
      cStatus = classifyPgError(err) === 'DENY' ? 'PASS' : classifyPgError(err);
    }
    record('V-E4 NEG bare signal.contacts INSERT fails-closed WITHOUT org scope',
      'agent(unscoped)', 'signal.contacts', 'INSERT', cStatus, 'PASS',
      'R13c negative probe: bare INSERT matches no write branch (org_ids unset, allow_system=false) → 42501 — proves the withAgentScope the poller injects is load-bearing, not decorative (probed raw because resolveAndUpsert fail-opens and would eat the deny)');

    // (d) NEG cross-org read: CF scope cannot see the STAQS contact
    let dStatus;
    {
      const scope = await dbAgent.withAgentScope('calendar-poller', { orgIds: [CF_ORG] });
      try {
        const r = await scope(`SELECT id FROM signal.contacts WHERE email_address = $1`, [R13_EMAIL]);
        dStatus = r.rows.length === 0 ? 'PASS' : `LEAK(rows=${r.rows.length})`;
      } catch (err) {
        dStatus = classifyPgError(err);
      } finally {
        await scope.release();
      }
    }
    record('V-E4 cross-org read: CF scope cannot see the STAQS calendar contact',
      'agent(CF-org)', 'signal.contacts', 'SELECT', dStatus, 'PASS',
      'R13d isolation probe: a CF-org scope SELECTing the STAQS contact returns 0 rows — the org-keyed SELECT policy (visible(NULL,owner_org_id,true)) holds across orgs, not just against the unscoped case');

    // (e) NEG system scope INSERT → 42501 (write policy is allow_system=FALSE → org scope mandatory)
    let eStatus;
    {
      const sys = await dbAgent.withSystemScope('reaper', { reason: 'flip-readiness-smoke-r13' });
      try {
        await sys(
          `INSERT INTO signal.contacts
             (email_address, name, contact_type, tier, source_account_id, metadata, created_at, updated_at)
           VALUES ($1, 'R13 sys', 'participant', 'unknown', NULL, '{}'::jsonb, now(), now())`,
          ['r13.sys@calendar-probe.example']
        );
        eStatus = 'LEAK(system-insert-succeeded)';
      } catch (err) {
        eStatus = classifyPgError(err) === 'DENY' ? 'PASS' : classifyPgError(err);
      } finally {
        await sys.release();
      }
    }
    record('V-E4 NEG system scope CANNOT write signal.contacts (allow_system=FALSE write policy)',
      'system(reaper)', 'signal.contacts', 'INSERT', eStatus, 'PASS',
      'R13e design probe: the write policy is visible(NULL,owner_org_id,FALSE) → system scope does NOT satisfy it → 42501. This is exactly why E4 wires withAgentScope (org), NOT withSystemScope — so the calendar poller adds zero withSystemScope callers and the ratchet is unmoved');

    // (f) SAVEPOINT isolation: a poisoned txn blocks a later write UNLESS bracketed by a savepoint
    let f1Status; // no-savepoint control → later write throws 25P02
    {
      const scope = await dbAgent.withAgentScope('calendar-poller', { orgIds: [STAQS_ORG] });
      try {
        try { await scope('SELECT 1/0'); } catch { /* poison the txn */ }
        await scope(`SELECT 1`); // aborted txn → should throw 25P02
        f1Status = 'LEAK(no-poison)';
      } catch (err) {
        f1Status = err.code === '25P02' ? 'PASS' : `UNEXPECTED(${err.code})`;
      } finally {
        await scope.release();
      }
    }
    record('V-E4 control: an un-bracketed error poisons the shared txn (25P02) — the risk isolatedWrite closes',
      'agent(calendar-poller)', 'signal.contacts', 'txn', f1Status, 'PASS',
      'R13f1 control probe: without a SAVEPOINT the first statement error aborts the whole txn (25P02), so every subsequent attendee write throws and is eaten by the fail-open catches → the batch after the first denial vanishes. This is the failure isolatedWrite exists to prevent');

    let f2Status; // savepoint bracket → later write survives
    {
      const scope = await dbAgent.withAgentScope('calendar-poller', { orgIds: [STAQS_ORG] });
      try {
        await scope('SAVEPOINT sp_r13');
        try { await scope('SELECT 1/0'); } catch { /* failed sub-statement */ }
        await scope('ROLLBACK TO SAVEPOINT sp_r13');
        await scope('RELEASE SAVEPOINT sp_r13');
        const r = await scope(`SELECT 1 AS ok`); // txn recovered → succeeds
        f2Status = r.rows[0]?.ok === 1 ? 'PASS' : `NORECOVER(${JSON.stringify(r.rows[0])})`;
      } catch (err) {
        f2Status = classifyPgError(err);
      } finally {
        await scope.release();
      }
    }
    record('V-E4 SAVEPOINT isolation recovers the txn so later attendee writes survive a mid-batch denial',
      'agent(calendar-poller)', 'signal.contacts', 'txn', f2Status, 'PASS',
      'R13f2 invariant probe: SAVEPOINT + ROLLBACK TO (isolatedWrite\'s mechanism) recovers the aborted txn so a subsequent statement lands — proving the per-block savepoints keep one attendee\'s post-flip denial from silently dropping every remaining attendee in the batch');
  }

  // ---- R14: REAL Google Contacts upsertContact signal.contacts seam (OPT-166 P2e) ----
  // contacts-sync.js's upsertContact does a DIRECT `INSERT ... ON CONFLICT DO UPDATE` on
  // signal.contacts (distinct from R13's resolveAndUpsert path) through its OWN wrapper
  // withContactsOrgScope → withAgentScope('contacts-sync',{orgIds:[CURRENT_ORG_ID]}). R13c/R13e
  // already prove the TABLE's bare/system-scope denials; what's NEW here is driving contacts-sync's
  // real EXPORTED function end-to-end as autobot_agent, so the fix is proven at its OWN call site
  // instead of a reconstructed lookalike (the V-8 sensor-blind-spot the prior rollbacks kept hiding):
  //   (a) REAL upsertContact(new email) → read back under STAQS scope → 1 row, owner_org_id=STAQS
  //       DEFAULT (the INSERT branch satisfies WITH CHECK visible(NULL,STAQS,false) via the wrapper)
  //   (b) REAL upsertContact(SAME email again) → ON CONFLICT DO UPDATE branch → updated_at bumped.
  //       Under RLS an UPDATE whose USING matches no rows silently no-ops (0 rows, no throw), so a
  //       STRICTLY GREATER updated_at is the only proof the UPDATE branch actually executed (USING +
  //       WITH CHECK both passed) rather than fail-open-skipping — the silent-UPDATE mode E4 excludes.
  {
    const contactsSyncUrl = 'file://'
      + path.join(REPO_ROOT, 'autobot-inbox', 'src', 'gmail', 'contacts-sync.js')
      + '?cachebust=' + Date.now() + '_' + Math.random();
    const { upsertContact } = await import(contactsSyncUrl);
    const R14_EMAIL = 'r14.contact@contacts-sync-probe.example';

    // (a) REAL upsertContact INSERT branch lands under the module's own org scope
    let aStatus;
    let ua1 = null;
    try {
      await upsertContact(R14_EMAIL, 'R14 Contact', 'R14 Org', 'people/r14');
      const scope = await dbAgent.withAgentScope('contacts-sync', { orgIds: [STAQS_ORG] });
      let scoped;
      try {
        scoped = await scope(
          `SELECT name, owner_org_id, updated_at FROM signal.contacts WHERE email_address = $1`,
          [R14_EMAIL]);
      } finally {
        await scope.release();
      }
      const row = scoped.rows[0];
      ua1 = row?.updated_at ?? null;
      aStatus = (scoped.rows.length === 1 && row.owner_org_id === STAQS_ORG && row.name === 'R14 Contact')
        ? 'PASS'
        : `MISMATCH(rows=${scoped.rows.length},org=${row?.owner_org_id},name=${row?.name})`;
    } catch (err) {
      aStatus = classifyPgError(err);
    }
    record('V-E4 REAL contacts-sync upsertContact INSERT lands signal.contacts under org scope (Google Contacts wiring)',
      'agent(contacts-sync)', 'signal.contacts', 'INSERT', aStatus, 'PASS',
      'R14a real-seam probe: the exported upsertContact runs its own withContactsOrgScope (withAgentScope(contacts-sync,{CURRENT_ORG_ID})) → INSERT satisfies WITH CHECK visible(NULL,STAQS,false) → row visible under STAQS scope with owner_org_id=STAQS DEFAULT; proves the fix at contacts-sync\'s OWN call site, not a reconstructed lookalike');

    // (b) REAL upsertContact ON CONFLICT DO UPDATE branch executes (updated_at strictly bumped)
    let bStatus;
    try {
      // A tiny gap guarantees a distinct transaction_timestamp (now()) for the UPDATE txn.
      await new Promise((r) => setTimeout(r, 10));
      await upsertContact(R14_EMAIL, 'R14 Renamed', null, 'people/r14');
      const scope = await dbAgent.withAgentScope('contacts-sync', { orgIds: [STAQS_ORG] });
      let scoped;
      try {
        scoped = await scope(
          `SELECT updated_at FROM signal.contacts WHERE email_address = $1`, [R14_EMAIL]);
      } finally {
        await scope.release();
      }
      const ua2 = scoped.rows[0]?.updated_at ?? null;
      bStatus = (scoped.rows.length === 1 && ua1 && ua2 && new Date(ua2) > new Date(ua1))
        ? 'PASS'
        : `NO-UPDATE(rows=${scoped.rows.length},ua1=${ua1},ua2=${ua2})`;
    } catch (err) {
      bStatus = classifyPgError(err);
    }
    record('V-E4 REAL contacts-sync upsertContact ON CONFLICT DO UPDATE executes under org scope (no silent no-op)',
      'agent(contacts-sync)', 'signal.contacts', 'UPDATE', bStatus, 'PASS',
      'R14b real-seam probe: a second upsertContact on the same email takes the ON CONFLICT DO UPDATE branch; under RLS an UPDATE whose USING matches no rows silently no-ops (0 rows, no throw), so a STRICTLY GREATER updated_at is the only proof USING + WITH CHECK both passed under the org scope — the silent-UPDATE failure mode, made falsifiable');
  }

  // ---- R14: REAL extractTranscriptActions() transcript-action-extractor seam (OPT-166 P2f-A) ----
  // The transcript-action-extractor is a process-lifetime onAnyEvent listener that fires on every
  // tl;dv transcript→completed (autobot-inbox/src/index.js). Its main read is inbox.signals JOIN
  // inbox.messages (org-keyed SELECT, mig190/200) — post-flip a BARE read black-holes to 0 rows, so
  // extractTranscriptActions early-returns "no actionable signals" and EVERY transcript silently
  // produces 0 intents (the real damage, broader than the contacts gap R13 closes). The module now
  // reads owner_org_id from bare-permissive inbox.messages (read_messages USING(true)) then brackets
  // the org-keyed read in withTranscriptOrgScope(ownerOrgId) — withAgentScope, NOT system (the
  // inbox.signals SELECT is org-keyed; the participant-write path reuses R13's resolveAndUpsert org
  // seam → zero withSystemScope callers, ratchet unmoved). createIntent sits BETWEEN the two org
  // brackets and is intentionally UNSCOPED: it INSERTs into agent_graph.agent_intents, which has NO
  // RLS (baseline CREATE TABLE only; no ENABLE/FORCE/policy in sql/), on its own bare-query connection
  // → flip-safe as-is. R14 drives the REAL exported entry point as autobot_agent (RLS enforced), with
  // a bare read as the negative control:
  //   (a) extractTranscriptActions(R14_MID) → signalsFound >= 1 (org-scoped main read resolves) AND
  //       intentsCreated >= 1 (the inbound high-confidence signal promotes; agent_intents has no RLS,
  //       so the unscoped createIntent INSERT lands — this also proves the E-style no-migration gate)
  //   (b) NEG bare inbox.signals JOIN inbox.messages read → 0 rows (black-holes without the scope —
  //       the exact silent-0-intents failure mode P2f-A closes; proves the bracket is load-bearing)
  {
    const txExtractorUrl = 'file://'
      + path.join(REPO_ROOT, 'autobot-inbox', 'src', 'transcripts', 'action-extractor.js')
      + '?cachebust=' + Date.now() + '_' + Math.random();
    const { extractTranscriptActions } = await import(txExtractorUrl);

    // (a) REAL entry point under RLS → the org-scoped main read resolves the seeded signal and the
    //     inbound high-confidence signal promotes to an intent (unscoped createIntent, no-RLS table)
    let aStatus;
    try {
      const res = await extractTranscriptActions(ids.r14MessageId);
      aStatus = (res.signalsFound >= 1 && res.intentsCreated >= 1)
        ? 'PASS'
        : `BLACKHOLE(signalsFound=${res.signalsFound},intentsCreated=${res.intentsCreated})`;
    } catch (err) {
      aStatus = classifyPgError(err);
    }
    record('V-P2f-A REAL extractTranscriptActions() sees transcript signals under org scope (extractor wiring)',
      'agent(transcript-extractor)', 'inbox.signals', 'SELECT', aStatus, 'PASS',
      'R14a real-entry-point probe: withTranscriptOrgScope(ownerOrgId) → the org-keyed inbox.signals JOIN inbox.messages read resolves (signalsFound>=1) so the inbound high-confidence signal promotes to an intent (intentsCreated>=1 via the unscoped createIntent — agent_graph.agent_intents has no RLS, the E-style no-migration gate) — NOT the silent 0-intents black-hole a bare read yields on every transcript post-flip');

    // (b) NEG: the same main read, BARE (unscoped) → black-holes to 0 rows
    let bStatus;
    try {
      const r = await dbAgent.query(
        `SELECT s.id FROM inbox.signals s
         JOIN inbox.messages m ON m.id = s.message_id
         WHERE s.message_id = $1
           AND s.signal_type IN ('action_item','commitment','deadline','request')`,
        [ids.r14MessageId]
      );
      bStatus = r.rows.length === 0 ? 'PASS' : `LEAK(rows=${r.rows.length})`;
    } catch (err) {
      bStatus = classifyPgError(err);
    }
    record('V-P2f-A NEG bare transcript signals read black-holes WITHOUT scope (extractor wiring)',
      'agent(unscoped)', 'inbox.signals', 'SELECT', bStatus, 'PASS',
      'R14b negative probe: the bare inbox.signals JOIN inbox.messages read returns 0 rows (org-keyed SELECT, app.org_ids unset) — the exact failure mode that makes extractTranscriptActions early-return 0 intents on every transcript; proves the withTranscriptOrgScope bracket is load-bearing, not decorative');
  }

  // ---- R15: enforcement-mode seam under REQUIRE_AGENT_JWT=true (OPT-166 — the 3-rollback blind spot) ----
  // THE sensor gap that stayed green through all three flip attempts: every probe above runs with
  // REQUIRE_AGENT_JWT UNSET, but prod sets REQUIRE_AGENT_JWT=true. Under enforcement,
  // resolveAgentIdentity() (lib/db.js, flag read per-call) REFUSES a plain-string agentId, so
  // withAgentScope('tldv-poller', …) THROWS — and the OLD system-writer wrappers'
  // catch→return fn(query) fail-softed that throw to a BARE unscoped query → 42501 on the very
  // INSERT the flip was meant to protect. That fail-soft never fired in this sensor because the
  // sensor never turned enforcement on. The fix (withSystemOrgScope) routes system daemons
  // through an org scope opened via setAgentContext WITHOUT going through resolveAgentIdentity,
  // so it is reachable under enforcement. This block turns the exact prod flag ON and drives the
  // REAL always-on write entry points to prove:
  //   (a) THE ROLLBACK MECHANISM: withAgentScope(plain-string) throws the SPECIFIC enforcement
  //       refusal (message-matched — any other throw is recorded as WRONG-THROW, not a pass)
  //   (b) THE FIX (content.documents / rd-feed-poller + tl;dv-poller half): REAL ingestDocument(
  //       {writerOrgScope}) STILL persists a documentId with REQUIRE_AGENT_JWT=true
  //   (c) durable commit under enforcement: read-back on a fresh withSystemOrgScope scope sees the row
  //   (d) NEG: bare ingestDocument (no scope) is STILL 42501-denied under enforcement (fail-closed)
  //   (e) THE FIX (inbox.messages / tl;dv-poller half): withSystemScope (role='system') is
  //       env-independent — it does NOT route through resolveAgentIdentity, so is_system() holds
  //       under enforcement (the messages INSERT half of the poller survives the flag too)
  {
    const priorJwt = process.env.REQUIRE_AGENT_JWT;
    process.env.REQUIRE_AGENT_JWT = 'true';
    try {
      // (a) THE load-bearing negative: withAgentScope(plain-string) throws under enforcement.
      //     This is the precise failure the prior three rollbacks hit — and never sensed.
      //     Message-matched: a throw for any OTHER reason (closed pool, network) must NOT pass.
      let throwStatus = 'LEAK(did-not-throw)';
      let leakedScope;
      try {
        leakedScope = await dbAgent.withAgentScope('tldv-poller', { orgIds: [STAQS_ORG] });
      } catch (err) {
        throwStatus = /refused plain-string agentId in enforcement mode/.test(err.message)
          ? 'THROW'
          : `WRONG-THROW(${String(err.message).slice(0, 80)})`;
      } finally {
        if (leakedScope) { try { await leakedScope.release(); } catch {} }
      }
      record('V-9 withAgentScope(plain-string agentId) THROWS under REQUIRE_AGENT_JWT=true (the rollback mechanism)',
        'agent(tldv-poller)', 'n/a', 'withAgentScope under enforcement', throwStatus, 'THROW',
        'R15a default-fail negative: under enforcement resolveAgentIdentity refuses a plain-string agentId → withAgentScope throws the specific refusal message. The OLD wrappers caught this and fail-softed to a bare query → 42501. This probe is the exact condition all three flip attempts hit; a LEAK here means enforcement is not actually engaged and every downstream R15 pass is false');

      // Fresh import so the block is self-contained; ingest reads REQUIRE_AGENT_JWT per-call, not at import.
      const ingestUrl2 = 'file://'
        + path.join(REPO_ROOT, 'lib', 'rag', 'ingest.js')
        + '?cachebust=' + Date.now() + '_' + Math.random();
      const { ingestDocument: ingestJwt } = await import(ingestUrl2);
      const R15_SRC = 'feed';
      const R15_SID = 'r15-jwt-enforce-1';
      const R15_BODY = 'Enforcement-mode research digest. No email addresses so participant '
        + 'resolution stays a no-op, isolating the probe to the content.documents write path '
        + 'under REQUIRE_AGENT_JWT=true.';

      // (b) THE FIX: real ingestDocument({writerOrgScope}) persists under enforcement.
      let fixStatus;
      try {
        const res = await ingestJwt({
          source: R15_SRC, sourceId: R15_SID, title: 'R15 enforcement doc',
          rawText: R15_BODY, format: 'plain', skipEmbedding: true,
          writerOrgScope: { actorId: 'rd-feed-poller', orgId: STAQS_ORG },
        });
        fixStatus = res?.documentId ? 'PASS' : `BLACKHOLE(documentId=${res?.documentId})`;
      } catch (err) {
        fixStatus = classifyPgError(err);
      }
      record('V-9 REAL ingestDocument({writerOrgScope}) persists content.documents under REQUIRE_AGENT_JWT=true',
        'agent(rd-feed-poller)', 'content.documents', 'INSERT', fixStatus, 'PASS',
        'R15b the fix, under the exact prod flag: withSystemOrgScope opens an org scope WITHOUT resolveAgentIdentity, so the rewired ingest path satisfies WITH CHECK tenancy.visible(...) and returns a documentId even with enforcement ON — the case that 42501-failed before commit c7378fb1');

      // (c) durable commit under enforcement — read-back via withSystemOrgScope (withAgentScope would throw here)
      let readStatus;
      {
        const scope = await dbAgent.withSystemOrgScope('rd-feed-poller', STAQS_ORG);
        try {
          const r = await scope(
            `SELECT owner_org_id, compile_status FROM content.documents WHERE source = $1 AND source_id = $2`,
            [R15_SRC, R15_SID]
          );
          const row = r.rows[0];
          readStatus = (r.rows.length === 1 && row.owner_org_id === STAQS_ORG && row.compile_status === 'pending')
            ? 'PASS'
            : `BLACKHOLE(rows=${r.rows.length},org=${row?.owner_org_id},compile=${row?.compile_status})`;
        } catch (err) {
          readStatus = classifyPgError(err);
        } finally {
          await scope.release();
        }
      }
      record('V-9 enforcement-mode row is committed + org-scoped (withSystemOrgScope read-back)',
        'agent(rd-feed-poller)', 'content.documents', 'SELECT', readStatus, 'PASS',
        'R15c durable-commit probe: the row written under enforcement is visible on a FRESH withSystemOrgScope scope (a separate connection) with owner_org_id=STAQS and compile_status=pending — proving the enforcement-mode write COMMITs, not just returns an id inside an aborting txn');

      // (d) NEG: bare ingestDocument (no scope) is STILL 42501-denied under enforcement
      let negStatus;
      try {
        await ingestJwt({
          source: R15_SRC, sourceId: 'r15-jwt-enforce-unscoped', title: 'R15 unscoped',
          rawText: R15_BODY, format: 'plain', skipEmbedding: true,
          // no writerOrgScope → runScoped falls back to bare query()
        });
        negStatus = 'LEAK(insert-succeeded-unscoped)';
      } catch (err) {
        negStatus = classifyPgError(err) === 'DENY' ? 'PASS' : classifyPgError(err);
      }
      record('V-9 NEG bare ingestDocument STILL fails-closed under REQUIRE_AGENT_JWT=true',
        'agent(unscoped)', 'content.documents', 'INSERT', negStatus, 'PASS',
        'R15d negative probe: enforcement does not accidentally open a bare-write hole — an unscoped INSERT still matches no write branch → 42501, so the org scope remains load-bearing with the flag ON');

      // (e) THE FIX (messages half): withSystemScope (role=system) is env-independent under enforcement
      let sysStatus;
      {
        const sys = await dbAgent.withSystemScope('tldv-poller', { reason: 'flip-readiness-smoke-r15' });
        try {
          const r = await sys(`SELECT tenancy.is_system() AS s`);
          sysStatus = r.rows[0]?.s === true ? 'PASS' : `NO_SYSTEM(s=${r.rows[0]?.s})`;
        } catch (err) {
          sysStatus = classifyPgError(err);
        } finally {
          await sys.release();
        }
      }
      record('V-9 withSystemScope holds is_system() under REQUIRE_AGENT_JWT=true (tl;dv messages half)',
        'system(tldv-poller)', 'n/a', 'tenancy.is_system() under enforcement', sysStatus, 'PASS',
        'R15e env-independence probe: withSystemScope sets role=system via setAgentContext, never touching resolveAgentIdentity, so tenancy.is_system() stays true with enforcement ON — the poller\'s inbox.messages INSERT half (system_insert_messages WITH CHECK is_system()) survives the flag exactly as the content.documents half does');
    } finally {
      if (priorJwt === undefined) delete process.env.REQUIRE_AGENT_JWT;
      else process.env.REQUIRE_AGENT_JWT = priorJwt;
    }
  }

  await dbAgent.close();

  // ============================================================
  // PHASE B-FUZZ — OPT-166 P4: un-skip the STAQPRO-567 tenant-isolation
  // fuzz exit gate under real Postgres.
  // ============================================================
  //
  // test/fuzz/tenant-isolation-fuzz.test.js (37 tenant-data GET routes +
  // 5 non-HTTP surfaces: agent-runtime visibleClause reads, SSE heartbeat
  // aggregates, content.match_chunks() RAG, pg_notify org-tag, Neo4j
  // origin_org) is SKIP-GATED by default (see its file header) because most
  // environments run it against a superuser pool, where every "0 rows
  // leaked" result would be a FALSE GREEN. This sensor is exactly the
  // environment where the gate is safe to release: PHASE A already applied
  // every real migration and created autobot_agent as
  // NOSUPERUSER NOBYPASSRLS, and the suite's own before() independently
  // re-confirms `rolsuper=false` before running a single assertion (it
  // SKIPS rather than reporting green if that self-check fails).
  //
  // PART 1 of that suite (the 37 HTTP routes) self-skips per-test when
  // API_SECRET is unset (its own HTTP_SKIP() predicate) — deliberately NOT
  // set here, since this sensor never boots a live HTTP server and must
  // never reach out to a real TENANCY_BASE_URL. What DOES run for real:
  // PART 0 (route classifier sanity) and PARTS 2-6 (the non-HTTP surfaces),
  // driven against this sensor's own disposable, freshly-migrated DB.
  //
  // Only ever invoked here under real Postgres (this script never runs
  // under PGlite). Run directly under `npm run test:ci` (PGlite, no
  // POOL_IS_NON_SUPERUSER / real DATABASE_URL), the suite stays fully
  // skipped — unchanged from before this change.
  //
  // If this gate fails, that is SIGNAL that RLS enforcement has a real gap
  // — report it verbatim, never weaken the assertion to force green.
  console.log('\n>>> PHASE B-FUZZ — STAQPRO-567 tenant-isolation fuzz gate (real PG, non-HTTP surfaces)');
  {
    const AGENT_URL = `postgresql://autobot_agent:${encodeURIComponent(AGENT_PASS)}@127.0.0.1:${hostPort}/flip_smoke`;
    const fuzzTestPath = path.join(REPO_ROOT, 'autobot-inbox', 'test', 'fuzz', 'tenant-isolation-fuzz.test.js');
    const fuzzRun = sh(process.execPath, ['--test', fuzzTestPath], {
      cwd: path.join(REPO_ROOT, 'autobot-inbox'),
      env: {
        ...process.env,
        DATABASE_URL: AGENT_URL,
        POOL_IS_NON_SUPERUSER: 'true',
        // API_SECRET / TENANCY_BASE_URL intentionally UNSET — see comment above.
      },
    });
    console.log(fuzzRun.stdout);
    if (fuzzRun.stderr) console.error(fuzzRun.stderr);
    record(
      'V-fuzz STAQPRO-567 tenant-isolation gate (real PG, non-HTTP surfaces)',
      'n/a', 'n/a', 'node --test tenant-isolation-fuzz.test.js',
      fuzzRun.status === 0 ? 'PASS' : `FAIL(exit ${fuzzRun.status})`, 'PASS'
    );
  }

  // ============================================================
  // PHASE B-FUZZ-HTTP — OPT-166 V-8: un-skip STAQPRO-567 fuzz PART 1 (the
  // 37+ live-HTTP route probes, plus the bespoke /api/pipeline/timeline
  // probe) by actually booting the API in the flip posture.
  // ============================================================
  //
  // PHASE B-FUZZ above deliberately leaves API_SECRET / TENANCY_BASE_URL
  // unset, so PART 1 self-skips there — that phase only proves the non-HTTP
  // surfaces. A handler that reads a tenant table directly (bypassing
  // visibleClause) on an HTTP route is invisible to PART 0/2-6; only a live
  // HTTP probe against a server actually running AS autobot_agent catches it
  // (this recurred 3x; the latest instance was GET /api/pipeline/timeline).
  //
  // Boot recipe: import ONLY startApiServer() (scripts/fuzz-http-boot.mjs),
  // SKIPPING initializeDatabase() — migrations are already applied by PHASE A
  // as superuser, and initializeDatabase() 42501-fails under autobot_agent
  // (CREATE TABLE public._migrations needs a privilege autobot_agent doesn't
  // have). src/index.js's own boot sequence already calls these two functions
  // independently, so this is a supported seam, not a hack — no src/api.js
  // change was needed.
  //
  // Same disposable PG, same seeded orgs/board_members/autobot_agent as every
  // other phase in this script — no second Postgres, no duplicate seeding.
  console.log('\n>>> PHASE B-FUZZ-HTTP — STAQPRO-567 tenant-isolation fuzz gate (real PG, live HTTP surface, V-8)');
  {
    const AGENT_URL = `postgresql://autobot_agent:${encodeURIComponent(AGENT_PASS)}@127.0.0.1:${hostPort}/flip_smoke`;
    // Disposable, literal test secret — never a real credential. Regenerated
    // every run (randomBytes), scoped to this sensor's own throwaway server.
    const TEST_API_SECRET = randomBytes(16).toString('hex');
    const httpPort = await findFreePort();
    const baseUrl = `http://127.0.0.1:${httpPort}`;
    const bootScript = path.join(__dirname, 'fuzz-http-boot.mjs');

    console.log(`>>> Booting API as autobot_agent on ${baseUrl} (skipping initializeDatabase — migrations already applied)`);
    const apiProc = spawn(process.execPath, [bootScript], {
      cwd: path.join(REPO_ROOT, 'autobot-inbox'),
      env: {
        ...process.env,
        DATABASE_URL: AGENT_URL,
        POOL_IS_NON_SUPERUSER: 'true', // documents the flip posture; api.js/lib/db.js don't read it themselves
        API_SECRET: TEST_API_SECRET,
        PORT: String(httpPort),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let apiStdout = '';
    let apiStderr = '';
    apiProc.stdout.on('data', (d) => { apiStdout += d; });
    apiProc.stderr.on('data', (d) => { apiStderr += d; });
    let apiExited = false;
    apiProc.on('exit', () => { apiExited = true; });

    const httpReady = await waitForHttpReady(baseUrl);

    if (!httpReady || apiExited) {
      console.error('API server (autobot_agent posture) never became ready.');
      console.error('--- stdout ---\n' + apiStdout);
      console.error('--- stderr ---\n' + apiStderr);
      record(
        'V-8 fuzz-http-boot API server ready (autobot_agent posture)',
        'n/a', 'n/a', 'OPTIONS /',
        'FAIL(server never ready)', 'PASS'
      );
      if (!apiExited) apiProc.kill('SIGKILL');
    } else {
      console.log(`>>> API ready on ${baseUrl} — running fuzz PART 1 live`);
      const fuzzTestPath = path.join(REPO_ROOT, 'autobot-inbox', 'test', 'fuzz', 'tenant-isolation-fuzz.test.js');
      // Force the TAP reporter so PART-1 execution is machine-verifiable below
      // (the interactive `spec` reporter uses ✔/﹣ symbols, not `ok`/`# SKIP`).
      const fuzzRun = sh(process.execPath, ['--test', '--test-reporter=tap', fuzzTestPath], {
        cwd: path.join(REPO_ROOT, 'autobot-inbox'),
        env: {
          ...process.env,
          DATABASE_URL: AGENT_URL,
          POOL_IS_NON_SUPERUSER: 'true',
          API_SECRET: TEST_API_SECRET,
          TENANCY_BASE_URL: baseUrl,
          // STAQS_ORG_ID overrides the fuzz file's hardcoded prod default
          // (7c164445-...) with THIS run's freshly-generated disposable org
          // id — without this the HTTP probes' owner_org_id-match leak check
          // would silently never match any row (false negative).
          STAQS_ORG_ID: STAQS_ORG,
        },
      });
      console.log(fuzzRun.stdout);
      if (fuzzRun.stderr) console.error(fuzzRun.stderr);

      // ── V-8 "never false-green" guard ──────────────────────────────────────
      // Node's --test runner exits 0 for an all-skipped suite. The fuzz suite
      // self-DISABLES every test when it detects a superuser pool (HTTP_SKIP →
      // !enabled), and its HTTP probes also skip whenever API_SECRET /
      // TENANCY_BASE_URL are unset. In both cases the process exits 0 while
      // PART 1 — the live-HTTP surface this phase exists to exercise — never
      // actually ran, which is the exact false-green V-8 forbids. Exit code
      // alone is therefore NOT proof. Require positive evidence: the
      // load-bearing bespoke /api/pipeline/timeline probe must appear in the
      // TAP stream as a PASSING, NON-SKIPPED `ok` line, AND the run must report
      // zero failures with a non-zero executed-pass count. If PART 1 silently
      // skips, timelineProbeRan is false → BLOCKER → sensor exits 1.
      const fuzzOut = fuzzRun.stdout || '';
      const TIMELINE_PROBE = 'victim (org-B) and bare secret get no message; control (org-A) does';
      const probeLine = fuzzOut
        .split('\n')
        .find((l) => /^\s*(?:ok|not ok)\b/.test(l) && l.includes(TIMELINE_PROBE));
      const timelineProbeRan =
        !!probeLine && /^\s*ok\b/.test(probeLine) && !/#\s*SKIP/i.test(probeLine);
      const passCount = Number((fuzzOut.match(/^# pass (\d+)/m) || [])[1] || 0);
      const failCount = Number((fuzzOut.match(/^# fail (\d+)/m) || [])[1] || 0);
      const part1Live =
        fuzzRun.status === 0 && failCount === 0 && passCount > 0 && timelineProbeRan;
      console.log(
        `>>> PART 1 executed-for-real check: exit=${fuzzRun.status} pass=${passCount} ` +
          `fail=${failCount} timelineProbeRan=${timelineProbeRan}`
      );
      record(
        'V-8 STAQPRO-567 tenant-isolation fuzz gate (real PG, LIVE HTTP surface incl. /api/pipeline/timeline)',
        'n/a', 'n/a',
        'node --test tenant-isolation-fuzz.test.js (TENANCY_BASE_URL set; live timeline probe must run non-skipped)',
        part1Live
          ? 'PASS'
          : `FAIL(exit ${fuzzRun.status}, fail=${failCount}, pass=${passCount}, timelineProbeRan=${timelineProbeRan})`,
        'PASS'
      );

      console.log('>>> Tearing down fuzz-http-boot API server');
      if (!apiExited) {
        apiProc.kill('SIGTERM');
        await Promise.race([
          new Promise((resolve) => apiProc.once('exit', resolve)),
          new Promise((resolve) => setTimeout(resolve, 3000)),
        ]);
        if (!apiExited) apiProc.kill('SIGKILL');
      }
    }
  }

  // ============================================================
  // PHASE C — rollback verification (V-7)
  // ============================================================
  console.log('\n>>> PHASE C — rollback verification');
  const dbRollback = await freshDb({ DATABASE_URL: SUPER_URL, SQL_DIR }); // no AUTOBOT_AGENT_DB_PASSWORD
  const who3 = await dbRollback.query('SELECT current_user AS u');
  record('V-7 rollback restores superuser', 'n/a', 'n/a', 'unset AUTOBOT_AGENT_DB_PASSWORD', who3.rows[0].u === 'postgres' ? 'PASS' : 'FAIL:' + who3.rows[0].u, 'PASS');
  await dbRollback.close();

  await teardown();
  printInventory();

  const blockers = results.filter((r) => r.verdict === 'BLOCKER');
  // A real migration failure on Postgres must fail the gate, not just print in
  // printInventory() — otherwise a partial-apply that happens not to trip any
  // downstream probe would exit 0 (DBA Verifier finding, 2026-07-15).
  process.exit(blockers.length > 0 || migrationFailures.length > 0 ? 1 : 0);
}

async function teardown() {
  if (KEEP) {
    console.log(`\n>>> --keep passed: leaving container ${CONTAINER} running on port ${hostPort} for inspection.`);
    return;
  }
  console.log(`\n>>> Tearing down disposable container ${CONTAINER}`);
  sh('docker', ['rm', '-f', CONTAINER]);
}

function printInventory() {
  console.log('\n\n================ FAILURE INVENTORY ================');
  console.log('check | principal | table | verb | result | expected | verdict');
  for (const r of results) {
    console.log(`${r.check} | ${r.principal} | ${r.table} | ${r.verb} | ${r.result} | ${r.expected} | ${r.verdict}`);
  }
  if (migrationFailures.length) {
    console.log('\nMIGRATION FAILURES (real Postgres):');
    for (const m of migrationFailures) console.log('  - ' + m);
  } else {
    console.log('\nNo migration failures on real Postgres.');
  }
  const blockers = results.filter((r) => r.verdict === 'BLOCKER');
  console.log(`\n${blockers.length} BLOCKER(s) out of ${results.length} checks.`);
}

main().catch(async (err) => {
  console.error('\nFATAL:', err);
  try { await teardown(); } catch {}
  process.exit(1);
});
