/**
 * RED step (TDD) — lib/linear/team-cache.js does not exist yet.
 *
 * Tests the Linear team-metadata cache. Contract (PRD §1 FR-24..FR-26,
 * §2 NFR-11, §6 AD-7, AD-8):
 *
 *   - `loadCache(teamId)` reads inbox.linear_team_cache (DB only, no
 *     network) and returns the snapshot row or null.
 *   - `refreshCache({ teamId, client })` calls a Linear GraphQL client
 *     ONCE for team workflow_states + projects + members + labels, then
 *     UPSERTs into inbox.linear_team_cache. Idempotent — repeated calls
 *     bump refreshed_at, never duplicate. On network failure: reject
 *     with a typed error and leave the existing cache row untouched.
 *   - `bootstrapDefaultMapping(workflowStates)` produces a pure
 *     state_id → human_tasks.status map using Linear's normalised
 *     `state.type` (backlog | unstarted | started | completed | canceled).
 *     Unknown types map to `inbox` and surface a warnings array.
 *   - `startCacheRefresher({ teamId, intervalMs, client })` returns
 *     `{ stop() }` and calls refreshCache on an interval. stop()
 *     halts further refreshes cleanly. A refresh that throws is
 *     logged and the next interval still fires.
 *
 * Tests use the real PGlite DB + an injectable mock Linear client so we
 * never hit the network.
 */

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';
import {
  loadCache,
  refreshCache,
  startCacheRefresher,
  bootstrapDefaultMapping,
} from '../../lib/linear/team-cache.js';

const TEAM_ID = 'team-cache-test-1';
const OTHER_TEAM = 'team-cache-test-2';

// ---- Fixtures ----

function makeTeamPayload(overrides = {}) {
  return {
    team: {
      id: TEAM_ID,
      states: {
        nodes: [
          { id: 's-bl', name: 'Backlog', type: 'backlog' },
          { id: 's-td', name: 'Todo', type: 'unstarted' },
          { id: 's-ip', name: 'In Progress', type: 'started' },
          { id: 's-dn', name: 'Done', type: 'completed' },
          { id: 's-cx', name: 'Cancelled', type: 'canceled' },
        ],
      },
      projects: {
        nodes: [
          { id: 'p-1', name: 'StaqsPro', state: 'started' },
          { id: 'p-2', name: 'Formul8', state: 'planned' },
        ],
      },
      members: {
        nodes: [
          { id: 'u-eric', name: 'Eric Gang', email: 'eric@staqs.io' },
          { id: 'u-isaias', name: 'Isaias Valle', email: 'isaias@staqs.io' },
        ],
      },
      labels: {
        nodes: [
          { id: 'l-bug', name: 'bug' },
          { id: 'l-pri', name: 'priority' },
        ],
      },
      ...overrides,
    },
  };
}

/** Build an injectable mock Linear client that records calls. */
function makeMockClient(payloadFactory = makeTeamPayload) {
  const calls = [];
  const client = async (query, variables) => {
    calls.push({ query, variables });
    return payloadFactory();
  };
  client.calls = calls;
  return client;
}

// Wait helper — same shape as enrichment-worker test.
async function waitUntil(predicate, { timeoutMs = 1500, intervalMs = 20 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
}

// ---- Suite ----

describe('linear/team-cache — integration', () => {
  let query;

  before(async () => {
    ({ query } = await getDb());
  });

  beforeEach(async () => {
    await query(`DELETE FROM inbox.linear_team_cache WHERE team_id LIKE 'team-cache-test-%'`);
  });

  // ============================================================
  // loadCache (DB read)
  // ============================================================

  describe('loadCache (DB read)', () => {
    it('returns null when no cache row exists for the team', async () => {
      const cache = await loadCache({ teamId: TEAM_ID, query });
      assert.equal(cache, null);
    });

    it('returns the full cache snapshot after refreshCache populates the row', async () => {
      const client = makeMockClient();
      await refreshCache({ teamId: TEAM_ID, client, query });

      const cache = await loadCache({ teamId: TEAM_ID, query });
      assert.ok(cache, 'cache row exists');
      assert.ok(Array.isArray(cache.workflow_states), 'workflow_states is array');
      assert.ok(Array.isArray(cache.projects), 'projects is array');
      assert.ok(Array.isArray(cache.members), 'members is array');
      assert.ok(Array.isArray(cache.labels), 'labels is array');
      assert.ok(cache.refreshed_at, 'refreshed_at present');

      assert.equal(cache.workflow_states.length, 5);
      assert.equal(cache.projects.length, 2);
      assert.equal(cache.members.length, 2);
      assert.equal(cache.labels.length, 2);
    });

    it('does NOT make any network calls (no client argument needed)', async () => {
      // Seed the row directly so loadCache has something to read.
      await query(
        `INSERT INTO inbox.linear_team_cache
           (team_id, workflow_states, projects, members, labels, refreshed_at)
         VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb, now())`,
        [
          TEAM_ID,
          JSON.stringify([{ id: 's1', name: 'Backlog', type: 'backlog' }]),
          JSON.stringify([]),
          JSON.stringify([]),
          JSON.stringify([]),
        ],
      );

      // No client passed — must not throw, must not attempt a network call.
      const cache = await loadCache({ teamId: TEAM_ID, query });
      assert.ok(cache, 'returned cache row');
      assert.equal(cache.workflow_states[0].name, 'Backlog');
    });

    it('scopes by teamId — other teams are not returned', async () => {
      const client = makeMockClient();
      await refreshCache({ teamId: TEAM_ID, client, query });

      const missing = await loadCache({ teamId: OTHER_TEAM, query });
      assert.equal(missing, null);
    });
  });

  // ============================================================
  // refreshCache (GraphQL → DB write)
  // ============================================================

  describe('refreshCache (GraphQL → DB write)', () => {
    it('calls the injected Linear client exactly once', async () => {
      const client = makeMockClient();
      await refreshCache({ teamId: TEAM_ID, client, query });
      assert.equal(client.calls.length, 1, 'one GraphQL call');
    });

    it('sends a well-formed GraphQL query covering states, projects, members, and labels', async () => {
      const client = makeMockClient();
      await refreshCache({ teamId: TEAM_ID, client, query });

      const call = client.calls[0];
      assert.ok(typeof call.query === 'string', 'query is a string');
      // The query must reference all four metadata sections of the team.
      assert.match(call.query, /team\s*\(/i, 'queries the team root');
      assert.match(call.query, /states/i, 'requests workflow states');
      assert.match(call.query, /projects/i, 'requests projects');
      assert.match(call.query, /members/i, 'requests members');
      assert.match(call.query, /labels/i, 'requests labels');
      // Variables include the team id.
      assert.ok(
        call.variables && Object.values(call.variables).includes(TEAM_ID),
        'team id is passed as a variable',
      );
    });

    it('persists the GraphQL result as a single row keyed by team_id', async () => {
      const client = makeMockClient();
      await refreshCache({ teamId: TEAM_ID, client, query });

      const r = await query(
        `SELECT team_id, workflow_states, projects, members, labels, refreshed_at
           FROM inbox.linear_team_cache WHERE team_id = $1`,
        [TEAM_ID],
      );
      assert.equal(r.rows.length, 1);
      const row = r.rows[0];
      const ws = typeof row.workflow_states === 'string'
        ? JSON.parse(row.workflow_states) : row.workflow_states;
      const projects = typeof row.projects === 'string'
        ? JSON.parse(row.projects) : row.projects;
      assert.equal(ws.length, 5);
      assert.equal(projects.length, 2);
      assert.equal(projects[0].name, 'StaqsPro');
    });

    it('returns the new cache snapshot', async () => {
      const client = makeMockClient();
      const result = await refreshCache({ teamId: TEAM_ID, client, query });
      assert.ok(result, 'returns something');
      assert.equal(result.team_id, TEAM_ID);
      assert.ok(Array.isArray(result.workflow_states), 'workflow_states array');
      assert.equal(result.workflow_states.length, 5);
      assert.ok(result.refreshed_at, 'refreshed_at set');
    });

    it('is idempotent — calling twice UPSERTs (no duplicate rows, refreshed_at advances)', async () => {
      const client = makeMockClient();
      await refreshCache({ teamId: TEAM_ID, client, query });
      const first = await loadCache({ teamId: TEAM_ID, query });
      const firstTs = new Date(first.refreshed_at).getTime();

      // Wait a hair so refreshed_at can advance even on fast clocks.
      await new Promise((r) => setTimeout(r, 10));

      await refreshCache({ teamId: TEAM_ID, client, query });
      const second = await loadCache({ teamId: TEAM_ID, query });
      const secondTs = new Date(second.refreshed_at).getTime();

      const countRes = await query(
        `SELECT COUNT(*)::int AS n FROM inbox.linear_team_cache WHERE team_id = $1`,
        [TEAM_ID],
      );
      assert.equal(countRes.rows[0].n, 1, 'still exactly one row');
      assert.ok(secondTs >= firstTs, 'refreshed_at moves forward');
      assert.equal(client.calls.length, 2, 'two GraphQL calls');
    });

    it('rejects with a typed error on network failure and leaves the cache row intact', async () => {
      // Seed an existing cache row so we can verify it is NOT overwritten.
      const goodClient = makeMockClient();
      await refreshCache({ teamId: TEAM_ID, client: goodClient, query });
      const before = await loadCache({ teamId: TEAM_ID, query });

      // Now a failing client.
      const failingClient = async () => {
        const err = new Error('Linear API 503: service unavailable');
        err.code = 'LINEAR_REFRESH_FAILED';
        throw err;
      };

      await assert.rejects(
        () => refreshCache({ teamId: TEAM_ID, client: failingClient, query }),
        (err) => {
          // A typed error — either an Error with a recognisable shape or a
          // named code. Accept any of: err.code set, err.name not the bare
          // 'Error', or message mentions linear/refresh.
          const hasCode = typeof err.code === 'string' && err.code.length > 0;
          const hasNamedClass = err.name && err.name !== 'Error';
          const looksLikeRefreshErr = /linear|refresh/i.test(err.message || '');
          return hasCode || hasNamedClass || looksLikeRefreshErr;
        },
        'refreshCache rejects with a typed error on network failure',
      );

      const after = await loadCache({ teamId: TEAM_ID, query });
      assert.ok(after, 'pre-existing row still present');
      assert.equal(
        new Date(after.refreshed_at).getTime(),
        new Date(before.refreshed_at).getTime(),
        'refreshed_at unchanged after failure',
      );
      assert.deepEqual(after.workflow_states, before.workflow_states,
        'workflow_states unchanged after failure');
    });

    it('first-time setup use case — refresh then loadCache returns the full snapshot', async () => {
      const cache0 = await loadCache({ teamId: TEAM_ID, query });
      assert.equal(cache0, null, 'starts empty');

      const client = makeMockClient();
      await refreshCache({ teamId: TEAM_ID, client, query });

      const cache1 = await loadCache({ teamId: TEAM_ID, query });
      assert.ok(cache1, 'has data after refresh');
      assert.equal(cache1.workflow_states.length, 5);
      assert.equal(cache1.members.length, 2);
    });
  });

  // ============================================================
  // bootstrapDefaultMapping (pure function)
  // ============================================================

  describe('bootstrapDefaultMapping', () => {
    it('maps Linear normalised types to human_tasks.status', () => {
      const states = [
        { id: 's1', type: 'backlog' },
        { id: 's2', type: 'unstarted' },
        { id: 's3', type: 'started' },
        { id: 's4', type: 'completed' },
        { id: 's5', type: 'canceled' },
      ];
      const result = bootstrapDefaultMapping(states);
      assert.equal(result.mapping.s1, 'inbox');
      assert.equal(result.mapping.s2, 'todo');
      assert.equal(result.mapping.s3, 'in_progress');
      assert.equal(result.mapping.s4, 'done');
      assert.equal(result.mapping.s5, 'not_for_us');
      assert.deepEqual(result.warnings, [], 'no warnings for standard types');
    });

    it('maps a custom "Up Next" (type=unstarted) state to todo', () => {
      const states = [{ id: 's-up-next', name: 'Up Next', type: 'unstarted' }];
      const result = bootstrapDefaultMapping(states);
      assert.equal(result.mapping['s-up-next'], 'todo');
      assert.deepEqual(result.warnings, []);
    });

    it('maps a non-standard state type to inbox and flags it in warnings', () => {
      const states = [
        { id: 's-cv', name: 'Customer Verified', type: 'verified' },
        { id: 's-bl', name: 'Backlog', type: 'backlog' },
      ];
      const result = bootstrapDefaultMapping(states);
      assert.equal(result.mapping['s-cv'], 'inbox',
        'unknown type falls back to inbox');
      assert.equal(result.mapping['s-bl'], 'inbox', 'standard mapping unaffected');
      assert.ok(
        result.warnings.includes('s-cv'),
        'unknown-type state id surfaced in warnings',
      );
      assert.ok(
        !result.warnings.includes('s-bl'),
        'standard-type state not in warnings',
      );
    });

    it('returns an empty mapping and no warnings for empty input', () => {
      const result = bootstrapDefaultMapping([]);
      assert.deepEqual(result.mapping, {});
      assert.deepEqual(result.warnings, []);
    });

    it('treats missing or null state type as unrecognised (warning + inbox default)', () => {
      const states = [
        { id: 's-x', name: 'Mystery State' }, // no type
        { id: 's-y', name: 'Null Type', type: null },
      ];
      const result = bootstrapDefaultMapping(states);
      assert.equal(result.mapping['s-x'], 'inbox');
      assert.equal(result.mapping['s-y'], 'inbox');
      assert.ok(result.warnings.includes('s-x'));
      assert.ok(result.warnings.includes('s-y'));
    });
  });

  // ============================================================
  // startCacheRefresher (cron)
  // ============================================================

  describe('startCacheRefresher (cron)', () => {
    it('returns an object with a stop() function', async () => {
      const client = makeMockClient();
      const handle = startCacheRefresher({
        teamId: TEAM_ID, intervalMs: 10_000, client, query,
      });
      try {
        assert.equal(typeof handle.stop, 'function', 'has stop()');
      } finally {
        await handle.stop();
      }
    });

    it('invokes refreshCache repeatedly at the configured interval', async () => {
      const client = makeMockClient();
      const handle = startCacheRefresher({
        teamId: TEAM_ID, intervalMs: 50, client, query,
      });

      try {
        await waitUntil(() => client.calls.length >= 3, { timeoutMs: 2000 });
      } finally {
        await handle.stop();
      }

      assert.ok(client.calls.length >= 3,
        `expected ≥3 refreshes, got ${client.calls.length}`);
    });

    it('persists each refresh — cache row is up to date after the refresher runs', async () => {
      const client = makeMockClient();
      const handle = startCacheRefresher({
        teamId: TEAM_ID, intervalMs: 50, client, query,
      });

      try {
        await waitUntil(async () => {
          const c = await loadCache({ teamId: TEAM_ID, query });
          return c !== null;
        }, { timeoutMs: 2000 });
      } finally {
        await handle.stop();
      }

      const cache = await loadCache({ teamId: TEAM_ID, query });
      assert.ok(cache, 'cache populated by refresher');
      assert.equal(cache.workflow_states.length, 5);
    });

    it('stop() halts further refreshes', async () => {
      const client = makeMockClient();
      const handle = startCacheRefresher({
        teamId: TEAM_ID, intervalMs: 50, client, query,
      });

      // Wait for at least one call to land before stopping.
      await waitUntil(() => client.calls.length >= 1, { timeoutMs: 1500 });
      await handle.stop();

      const countAtStop = client.calls.length;
      // Give the would-be-next interval time to fire (it must not).
      await new Promise((r) => setTimeout(r, 250));
      const countAfter = client.calls.length;

      // Allow at most one in-flight call to settle after stop(); no NEW
      // intervals should fire.
      assert.ok(
        countAfter - countAtStop <= 1,
        `stop() halts further refreshes (before=${countAtStop}, after=${countAfter})`,
      );
    });

    it('logs and continues when a refresh throws — next interval still fires', async () => {
      let i = 0;
      // First call throws, subsequent calls succeed.
      const flakyClient = async (_queryStr, _variables) => {
        i++;
        if (i === 1) throw new Error('transient network blip');
        return makeTeamPayload();
      };
      flakyClient.calls = [];

      // Capture console.error/warn so the test doesn't pollute stderr.
      const origErr = console.error;
      const origWarn = console.warn;
      let captured = [];
      console.error = (...args) => captured.push(['error', args.join(' ')]);
      console.warn  = (...args) => captured.push(['warn',  args.join(' ')]);

      const handle = startCacheRefresher({
        teamId: TEAM_ID, intervalMs: 40, client: flakyClient, query,
      });

      try {
        await waitUntil(() => i >= 2, { timeoutMs: 2000 });
      } finally {
        await handle.stop();
        console.error = origErr;
        console.warn = origWarn;
      }

      assert.ok(i >= 2, 'refresher kept running after first throw');
      // At least one log entry mentions the error.
      const sawLog = captured.some(([, msg]) => /transient|refresh|linear/i.test(msg));
      assert.ok(sawLog, 'error was logged');
    });

    it('1-hour cron use case — refresher started, sped up via small interval; refreshCache called repeatedly', async () => {
      // Spec NFR-11 mandates a 60-min refresh; we simulate it with a tight
      // interval and assert the loop semantics (interval-driven repeats).
      const client = makeMockClient();
      const handle = startCacheRefresher({
        teamId: TEAM_ID, intervalMs: 30, client, query,
      });

      try {
        await waitUntil(() => client.calls.length >= 4, { timeoutMs: 2000 });
      } finally {
        await handle.stop();
      }

      assert.ok(client.calls.length >= 4);
      const cache = await loadCache({ teamId: TEAM_ID, query });
      assert.ok(cache, 'cache populated by recurring refresh');
    });
  });
});
