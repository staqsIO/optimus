/**
 * RED step (TDD) — lib/linear/guardrail-bootstrap.js does not yet exist.
 *
 * Spec source:
 *   docs/internal/prds/meeting-actions-to-kanban-v0.2-tech-spec.md
 *   §FR-25, §3.2 — auto-populate the push state mapping on first run via
 *   bootstrapDefaultMapping; pull guardrail seeded with empty mapping.
 *
 * Module under test exports:
 *   bootstrapGuardrails({ query, linearClient, teamId, force? })
 *     → { pushCreated, pullCreated, mapping }
 *
 * Contract:
 *   - Idempotent. Re-running on a DB that already has current guardrails of
 *     both kinds returns { pushCreated:false, pullCreated:false } and does
 *     NOT mutate any row.
 *   - On empty DB: fetches team-cache via refreshCache(linearClient),
 *     computes mapping via bootstrapDefaultMapping(cache.workflow_states),
 *     INSERTs push revision 1 with that mapping AND pull revision 1 with
 *     empty mapping {}.
 *   - prompt_text is '' (empty), created_by='system-bootstrap',
 *     note='Auto-detected via FR-25'.
 *   - force=true follows the saveGuardrail pattern for the affected kind:
 *     flips prior current to is_current=false, inserts a NEW revision.
 *     Each kind is independent — force only re-bootstraps the kind that
 *     would otherwise be skipped (push always — pull has nothing to detect).
 */

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';
import { bootstrapGuardrails } from '../../lib/linear/guardrail-bootstrap.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEAM_ID = 'team-bootstrap-uuid';

const DEFAULT_STATES = [
  { id: 's1', name: 'Backlog',     type: 'backlog'   },
  { id: 's2', name: 'Todo',        type: 'unstarted' },
  { id: 's3', name: 'In Progress', type: 'started'   },
  { id: 's4', name: 'Done',        type: 'completed' },
  { id: 's5', name: 'Cancelled',   type: 'canceled'  },
];

const EXPECTED_DEFAULT_MAPPING = {
  s1: 'inbox',
  s2: 'todo',
  s3: 'in_progress',
  s4: 'done',
  s5: 'not_for_us',
};

function makeLinearClient(states) {
  // Mock client returns the Linear GraphQL `TeamCache` payload shape.
  // The client is invoked by refreshCache with (query, variables).
  return async () => ({
    team: {
      id: TEAM_ID,
      states:   { nodes: states ?? [] },
      projects: { nodes: [] },
      members:  { nodes: [] },
      labels:   { nodes: [] },
    },
  });
}

function makeFailingLinearClient(message = 'Linear unavailable') {
  return async () => { throw new Error(message); };
}

async function clearAll(query) {
  await query(`DELETE FROM inbox.llm_guardrail_corrections`);
  await query(`DELETE FROM inbox.llm_guardrails`);
  await query(`DELETE FROM inbox.linear_team_cache`);
}

async function readGuardrail(query, kind, isCurrent = true) {
  const r = await query(
    `SELECT id, kind, prompt_text, mapping, revision, is_current,
            created_by, note, created_at
       FROM inbox.llm_guardrails
      WHERE kind = $1 AND is_current = $2`,
    [kind, isCurrent],
  );
  return r.rows;
}

function parseMapping(value) {
  if (value == null) return null;
  if (typeof value === 'string') return JSON.parse(value);
  return value;
}

// ===========================================================================
// Happy path — empty DB, both kinds seeded
// ===========================================================================

describe('bootstrapGuardrails — happy path on empty DB', () => {
  let query;

  before(async () => { ({ query } = await getDb()); });

  beforeEach(async () => { await clearAll(query); });

  it('reports both pushCreated=true and pullCreated=true on empty DB', async () => {
    const res = await bootstrapGuardrails({
      query,
      linearClient: makeLinearClient(DEFAULT_STATES),
      teamId: TEAM_ID,
    });
    assert.strictEqual(res.pushCreated, true);
    assert.strictEqual(res.pullCreated, true);
  });

  it('inserts a current push row with the bootstrapped mapping', async () => {
    await bootstrapGuardrails({
      query,
      linearClient: makeLinearClient(DEFAULT_STATES),
      teamId: TEAM_ID,
    });

    const rows = await readGuardrail(query, 'push', true);
    assert.strictEqual(rows.length, 1, 'exactly one current push row');
    const row = rows[0];
    assert.strictEqual(row.kind, 'push');
    assert.strictEqual(row.revision, 1);
    assert.strictEqual(row.is_current, true);
    assert.strictEqual(row.prompt_text, '');
    assert.strictEqual(row.created_by, 'system-bootstrap');
    assert.strictEqual(row.note, 'Auto-detected via FR-25');
    assert.deepStrictEqual(parseMapping(row.mapping), EXPECTED_DEFAULT_MAPPING);
  });

  it('inserts a current pull row with empty mapping {}', async () => {
    await bootstrapGuardrails({
      query,
      linearClient: makeLinearClient(DEFAULT_STATES),
      teamId: TEAM_ID,
    });

    const rows = await readGuardrail(query, 'pull', true);
    assert.strictEqual(rows.length, 1, 'exactly one current pull row');
    const row = rows[0];
    assert.strictEqual(row.kind, 'pull');
    assert.strictEqual(row.revision, 1);
    assert.strictEqual(row.is_current, true);
    assert.strictEqual(row.prompt_text, '');
    assert.strictEqual(row.created_by, 'system-bootstrap');
    assert.strictEqual(row.note, 'Auto-detected via FR-25');
    assert.deepStrictEqual(parseMapping(row.mapping), {});
  });

  it('returns the computed mapping in the result for caller inspection', async () => {
    const res = await bootstrapGuardrails({
      query,
      linearClient: makeLinearClient(DEFAULT_STATES),
      teamId: TEAM_ID,
    });
    assert.deepStrictEqual(res.mapping, EXPECTED_DEFAULT_MAPPING);
  });
});

// ===========================================================================
// Idempotency — re-run on populated DB is a no-op
// ===========================================================================

describe('bootstrapGuardrails — idempotency', () => {
  let query;

  before(async () => { ({ query } = await getDb()); });

  beforeEach(async () => { await clearAll(query); });

  it('reports both pushCreated=false and pullCreated=false on second run', async () => {
    await bootstrapGuardrails({
      query,
      linearClient: makeLinearClient(DEFAULT_STATES),
      teamId: TEAM_ID,
    });
    const second = await bootstrapGuardrails({
      query,
      linearClient: makeLinearClient(DEFAULT_STATES),
      teamId: TEAM_ID,
    });
    assert.strictEqual(second.pushCreated, false);
    assert.strictEqual(second.pullCreated, false);
  });

  it('inserts no new rows on re-run', async () => {
    await bootstrapGuardrails({
      query,
      linearClient: makeLinearClient(DEFAULT_STATES),
      teamId: TEAM_ID,
    });
    const beforeCount = await query(
      `SELECT COUNT(*)::int AS n FROM inbox.llm_guardrails`,
    );
    await bootstrapGuardrails({
      query,
      linearClient: makeLinearClient(DEFAULT_STATES),
      teamId: TEAM_ID,
    });
    const afterCount = await query(
      `SELECT COUNT(*)::int AS n FROM inbox.llm_guardrails`,
    );
    assert.strictEqual(
      afterCount.rows[0].n, beforeCount.rows[0].n,
      'row count must be unchanged after re-run',
    );
    assert.strictEqual(afterCount.rows[0].n, 2,
      'still exactly 2 rows (push current + pull current)');
  });

  it('preserves the existing current rows (is_current stays true)', async () => {
    await bootstrapGuardrails({
      query,
      linearClient: makeLinearClient(DEFAULT_STATES),
      teamId: TEAM_ID,
    });
    const firstPush = (await readGuardrail(query, 'push', true))[0];
    const firstPull = (await readGuardrail(query, 'pull', true))[0];

    await bootstrapGuardrails({
      query,
      linearClient: makeLinearClient(DEFAULT_STATES),
      teamId: TEAM_ID,
    });

    const stillPush = (await readGuardrail(query, 'push', true))[0];
    const stillPull = (await readGuardrail(query, 'pull', true))[0];

    assert.strictEqual(stillPush.id, firstPush.id,
      'push current row id must be unchanged');
    assert.strictEqual(stillPush.is_current, true);
    assert.strictEqual(stillPull.id, firstPull.id,
      'pull current row id must be unchanged');
    assert.strictEqual(stillPull.is_current, true);
  });

  it('does not call the linear client when push current already exists (idempotency short-circuit)', async () => {
    // First seed.
    await bootstrapGuardrails({
      query,
      linearClient: makeLinearClient(DEFAULT_STATES),
      teamId: TEAM_ID,
    });

    // Second call with a client that throws — must NOT invoke it because
    // push is already current. (Pull is also already current, so neither
    // branch should require the network.)
    let called = false;
    const tripwireClient = async () => {
      called = true;
      throw new Error('client must not be called on full idempotent re-run');
    };
    const res = await bootstrapGuardrails({
      query,
      linearClient: tripwireClient,
      teamId: TEAM_ID,
    });
    assert.strictEqual(called, false,
      'linear client must not be called when both kinds are already current');
    assert.strictEqual(res.pushCreated, false);
    assert.strictEqual(res.pullCreated, false);
  });
});

// ===========================================================================
// Force re-bootstrap — independent per kind
// ===========================================================================

describe('bootstrapGuardrails — force re-bootstrap', () => {
  let query;

  before(async () => { ({ query } = await getDb()); });

  beforeEach(async () => { await clearAll(query); });

  it('force=true with existing push current inserts revision=2 and flips prior current to false', async () => {
    // Seed revision 1.
    await bootstrapGuardrails({
      query,
      linearClient: makeLinearClient(DEFAULT_STATES),
      teamId: TEAM_ID,
    });
    const firstPush = (await readGuardrail(query, 'push', true))[0];
    assert.strictEqual(firstPush.revision, 1);

    // Force re-bootstrap.
    const res = await bootstrapGuardrails({
      query,
      linearClient: makeLinearClient(DEFAULT_STATES),
      teamId: TEAM_ID,
      force: true,
    });
    assert.strictEqual(res.pushCreated, true,
      'force=true must report push as created (new revision)');

    // Prior current must be flipped.
    const r = await query(
      `SELECT id, revision, is_current, prompt_text, mapping, note, created_at
         FROM inbox.llm_guardrails
        WHERE kind = 'push' ORDER BY revision ASC`,
    );
    assert.strictEqual(r.rows.length, 2, 'push must have exactly 2 revisions');
    assert.strictEqual(r.rows[0].id, firstPush.id);
    assert.strictEqual(r.rows[0].is_current, false,
      'prior push current must be flipped to false');
    assert.strictEqual(r.rows[1].revision, 2);
    assert.strictEqual(r.rows[1].is_current, true);

    // Audit-immutability: prior revision 1 row's content fields MUST be
    // unchanged — only `is_current` flipped. Compare full non-is_current
    // payload against the row originally read post-seed.
    const oldRowNow = {
      prompt_text: r.rows[0].prompt_text,
      mapping:     parseMapping(r.rows[0].mapping),
      note:        r.rows[0].note,
      created_at:  r.rows[0].created_at instanceof Date
        ? r.rows[0].created_at.toISOString()
        : r.rows[0].created_at,
    };
    const oldRowSeeded = {
      prompt_text: firstPush.prompt_text,
      mapping:     parseMapping(firstPush.mapping),
      note:        firstPush.note,
      created_at:  firstPush.created_at instanceof Date
        ? firstPush.created_at.toISOString()
        : firstPush.created_at,
    };
    assert.deepStrictEqual(oldRowNow, oldRowSeeded,
      'prior revision 1 row content fields must be unchanged — only is_current may flip');

    // Constants assertion: new revision 2 row carries the same seed constants
    // as revision 1 (prompt_text='' and note='Auto-detected via FR-25').
    assert.strictEqual(r.rows[1].prompt_text, '',
      'force revision 2 must have prompt_text=""');
    assert.strictEqual(r.rows[1].note, 'Auto-detected via FR-25',
      'force revision 2 must have note="Auto-detected via FR-25"');
  });

  it('force=true does NOT touch the existing pull row (each kind independent)', async () => {
    await bootstrapGuardrails({
      query,
      linearClient: makeLinearClient(DEFAULT_STATES),
      teamId: TEAM_ID,
    });
    const firstPull = (await readGuardrail(query, 'pull', true))[0];

    await bootstrapGuardrails({
      query,
      linearClient: makeLinearClient(DEFAULT_STATES),
      teamId: TEAM_ID,
      force: true,
    });

    // Only ONE pull row must exist, still current at revision 1.
    const r = await query(
      `SELECT id, revision, is_current FROM inbox.llm_guardrails
        WHERE kind = 'pull'`,
    );
    assert.strictEqual(r.rows.length, 1,
      'pull must still have exactly 1 row after force re-bootstrap of push');
    assert.strictEqual(r.rows[0].id, firstPull.id);
    assert.strictEqual(r.rows[0].revision, 1);
    assert.strictEqual(r.rows[0].is_current, true);
  });

  it('without force, existing pull row is not touched even when push is missing', async () => {
    // Seed only pull manually.
    await query(
      `INSERT INTO inbox.llm_guardrails
         (id, kind, prompt_text, mapping, revision, created_by, is_current, note)
       VALUES ($1, 'pull', '', $2::jsonb, 1, 'system-bootstrap', true, 'Auto-detected via FR-25')`,
      ['gr-prebuilt-pull', JSON.stringify({})],
    );

    const res = await bootstrapGuardrails({
      query,
      linearClient: makeLinearClient(DEFAULT_STATES),
      teamId: TEAM_ID,
    });
    // Push gets created, pull stays as-is.
    assert.strictEqual(res.pushCreated, true);
    assert.strictEqual(res.pullCreated, false);

    const pullRows = await query(
      `SELECT id, revision, is_current FROM inbox.llm_guardrails WHERE kind = 'pull'`,
    );
    assert.strictEqual(pullRows.rows.length, 1);
    assert.strictEqual(pullRows.rows[0].id, 'gr-prebuilt-pull');
    assert.strictEqual(pullRows.rows[0].is_current, true);
  });
});

// ===========================================================================
// Mapping correctness — driven by Linear states
// ===========================================================================

describe('bootstrapGuardrails — mapping correctness', () => {
  let query;

  before(async () => { ({ query } = await getDb()); });

  beforeEach(async () => { await clearAll(query); });

  it('maps Linear state.type values per bootstrapDefaultMapping (full set)', async () => {
    const res = await bootstrapGuardrails({
      query,
      linearClient: makeLinearClient(DEFAULT_STATES),
      teamId: TEAM_ID,
    });
    assert.deepStrictEqual(res.mapping, EXPECTED_DEFAULT_MAPPING);

    const row = (await readGuardrail(query, 'push', true))[0];
    assert.deepStrictEqual(parseMapping(row.mapping), EXPECTED_DEFAULT_MAPPING);
  });

  it('maps a partial set (backlog + unstarted only)', async () => {
    const partial = [
      { id: 'a', type: 'backlog'   },
      { id: 'b', type: 'unstarted' },
    ];
    const res = await bootstrapGuardrails({
      query,
      linearClient: makeLinearClient(partial),
      teamId: TEAM_ID,
    });
    assert.deepStrictEqual(res.mapping, {
      a: 'inbox',
      b: 'todo',
    });
  });

  it('falls back unknown types to "inbox" (per FR-25 default branch)', async () => {
    const unknown = [
      { id: 'x', type: 'unicorn' },
      { id: 'y', type: 'started' },
    ];
    const res = await bootstrapGuardrails({
      query,
      linearClient: makeLinearClient(unknown),
      teamId: TEAM_ID,
    });
    assert.deepStrictEqual(res.mapping, {
      x: 'inbox',
      y: 'in_progress',
    });
  });

  it('produces an empty mapping when Linear returns zero states, but still inserts the push guardrail', async () => {
    const res = await bootstrapGuardrails({
      query,
      linearClient: makeLinearClient([]),
      teamId: TEAM_ID,
    });
    assert.strictEqual(res.pushCreated, true);
    assert.deepStrictEqual(res.mapping, {});

    const row = (await readGuardrail(query, 'push', true))[0];
    assert.deepStrictEqual(parseMapping(row.mapping), {},
      'push guardrail must be inserted with mapping={} when no states exist');
    assert.strictEqual(row.revision, 1);
    assert.strictEqual(row.is_current, true);
  });

  it('throws when the Linear client fails during fetch (no partial DB writes)', async () => {
    await assert.rejects(
      () => bootstrapGuardrails({
        query,
        linearClient: makeFailingLinearClient('boom'),
        teamId: TEAM_ID,
      }),
      (err) => err instanceof Error && /boom|Linear/i.test(err.message),
    );

    // No guardrail rows must have been inserted — pull is gated on push
    // success per the bootstrap contract (Linear is the source of truth
    // for the mapping; if it can't be fetched, we abort).
    const r = await query(
      `SELECT COUNT(*)::int AS n FROM inbox.llm_guardrails`,
    );
    assert.strictEqual(r.rows[0].n, 0,
      'no guardrails may be inserted when the Linear fetch fails');
  });
});

// ===========================================================================
// Pull guardrail — always empty mapping
// ===========================================================================

describe('bootstrapGuardrails — pull guardrail', () => {
  let query;

  before(async () => { ({ query } = await getDb()); });

  beforeEach(async () => { await clearAll(query); });

  it('always seeds pull mapping as {} regardless of Linear state set', async () => {
    await bootstrapGuardrails({
      query,
      linearClient: makeLinearClient(DEFAULT_STATES),
      teamId: TEAM_ID,
    });
    const row = (await readGuardrail(query, 'pull', true))[0];
    assert.deepStrictEqual(parseMapping(row.mapping), {});
  });

  it('seeds pull mapping as {} even when Linear has no states', async () => {
    await bootstrapGuardrails({
      query,
      linearClient: makeLinearClient([]),
      teamId: TEAM_ID,
    });
    const row = (await readGuardrail(query, 'pull', true))[0];
    assert.deepStrictEqual(parseMapping(row.mapping), {});
  });
});

// ===========================================================================
// Concurrency — force=true must not produce duplicate revisions under race
// ===========================================================================

describe('bootstrapGuardrails — concurrency safety', () => {
  let query;

  before(async () => { ({ query } = await getDb()); });

  beforeEach(async () => { await clearAll(query); });

  // PGlite is a single-connection in-process Postgres — all queries share one
  // underlying connection, so BEGIN/COMMIT/ROLLBACK from two logically-concurrent
  // callers DO NOT form independent transactions. Statements from both calls
  // enter the same transaction context, and a ROLLBACK from the failing call
  // tears down the successful call's work. Real Postgres (which uses one
  // connection per call from a pool) makes this race test meaningful; PGlite
  // does not. Marked skipped per the test plan's PGlite fallback clause.
  //
  // The transactional fix in guardrail-bootstrap.js is still correct under
  // real Postgres: two force=true callers each open their own tx, the unique
  // index (llm_guardrails_current_per_kind, migration 120) ensures one of
  // them aborts cleanly, and no duplicate revisions are produced.
  it('two concurrent force=true calls do not produce duplicate revisions',
     { skip: 'PGlite shares one connection — BEGIN/COMMIT from concurrent callers cross-contaminate; assertion is meaningful only against real Postgres' },
     async () => {
    // Seed revision 1.
    await bootstrapGuardrails({
      query,
      linearClient: makeLinearClient(DEFAULT_STATES),
      teamId: TEAM_ID,
    });

    const results = await Promise.allSettled([
      bootstrapGuardrails({
        query,
        linearClient: makeLinearClient(DEFAULT_STATES),
        teamId: TEAM_ID,
        force: true,
      }),
      bootstrapGuardrails({
        query,
        linearClient: makeLinearClient(DEFAULT_STATES),
        teamId: TEAM_ID,
        force: true,
      }),
    ]);

    const succeeded = results.filter(r => r.status === 'fulfilled').length;
    assert.ok(succeeded >= 1,
      `at least one force=true call must succeed (got ${succeeded})`);

    // Invariant 1: exactly ONE current push row.
    const currentRows = await readGuardrail(query, 'push', true);
    assert.strictEqual(currentRows.length, 1,
      'exactly one current push row must exist after concurrent force calls');

    // Invariant 2: at most one NEW revision beyond the seed (revision 1).
    const all = await query(
      `SELECT revision, is_current FROM inbox.llm_guardrails
        WHERE kind = 'push' ORDER BY revision ASC`,
    );
    assert.ok(all.rows.length >= 2 && all.rows.length <= 3,
      `expected 2-3 push rows, got ${all.rows.length}`);

    const revisions = all.rows.map(r => r.revision);
    const unique = new Set(revisions);
    assert.strictEqual(unique.size, revisions.length,
      `duplicate revisions detected: ${revisions.join(',')}`);

    const maxRevision = Math.max(...revisions);
    assert.strictEqual(currentRows[0].revision, maxRevision,
      'current row must be the highest revision');
  });
});

// ===========================================================================
// Restricted — independence + return contract
// ===========================================================================

describe('bootstrapGuardrails — restricted: kind independence + return shape', () => {
  let query;

  before(async () => { ({ query } = await getDb()); });

  beforeEach(async () => { await clearAll(query); });

  it('force-bootstrapping push does not insert a new pull revision', async () => {
    await bootstrapGuardrails({
      query,
      linearClient: makeLinearClient(DEFAULT_STATES),
      teamId: TEAM_ID,
    });
    const pullBefore = await query(
      `SELECT COUNT(*)::int AS n FROM inbox.llm_guardrails WHERE kind = 'pull'`,
    );

    await bootstrapGuardrails({
      query,
      linearClient: makeLinearClient(DEFAULT_STATES),
      teamId: TEAM_ID,
      force: true,
    });

    const pullAfter = await query(
      `SELECT COUNT(*)::int AS n FROM inbox.llm_guardrails WHERE kind = 'pull'`,
    );
    assert.strictEqual(pullAfter.rows[0].n, pullBefore.rows[0].n,
      'force=true on push must not insert any pull rows');
    assert.strictEqual(pullAfter.rows[0].n, 1,
      'pull still has exactly one row (the original revision 1)');
  });

  it('returns the mapping so the caller (CLI script) can inspect it', async () => {
    const res = await bootstrapGuardrails({
      query,
      linearClient: makeLinearClient(DEFAULT_STATES),
      teamId: TEAM_ID,
    });
    assert.ok(res && typeof res === 'object', 'return must be an object');
    assert.ok(Object.prototype.hasOwnProperty.call(res, 'mapping'),
      'return must include "mapping" key');
    assert.deepStrictEqual(res.mapping, EXPECTED_DEFAULT_MAPPING);
  });

  it('returns a mapping on subsequent idempotent runs (echoes the bootstrapped mapping)', async () => {
    await bootstrapGuardrails({
      query,
      linearClient: makeLinearClient(DEFAULT_STATES),
      teamId: TEAM_ID,
    });
    const second = await bootstrapGuardrails({
      query,
      linearClient: makeLinearClient(DEFAULT_STATES),
      teamId: TEAM_ID,
    });
    // Idempotent re-run: client is not called, so the mapping echoed back
    // is the one stored on the current push row (still EXPECTED_DEFAULT_MAPPING).
    assert.ok(Object.prototype.hasOwnProperty.call(second, 'mapping'));
    assert.deepStrictEqual(second.mapping, EXPECTED_DEFAULT_MAPPING);
  });
});
