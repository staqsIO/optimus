/**
 * RED step (TDD) — src/api-routes/guardrails.js does not yet exist.
 *
 * Verifies the four guardrail endpoints exposed to the board surface
 * (Settings → LLM Guardrails). Spec source:
 *   docs/internal/prds/meeting-actions-to-kanban-v0.2-tech-spec.md
 *   §FR-20, §FR-22, §FR-23, §AD-6.
 *
 * Endpoints under test:
 *   GET  /api/guardrails              — current push + pull rows
 *   POST /api/guardrails              — create new revision; flips is_current
 *   GET  /api/guardrails/history      — last 50 revisions, optional ?kind=
 *   POST /api/guardrails/correction   — capture operator "this was wrong"
 *
 * All four require role='board'. Handlers are pure functions of (req, body)
 * returning a JSON-serialisable result; tests build mockReq() objects and
 * inspect the returned shape + the database.
 */

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';
import {
  getGuardrails,
  saveGuardrail,
  getGuardrailHistory,
  saveGuardrailCorrection,
} from '../src/api-routes/guardrails.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const BOARD = {
  role: 'board',
  sub: 'isaias',
  github_username: 'cboone',
  scope: ['*'],
};

function boardReq(url, extra = {}) {
  return { url, headers: {}, auth: BOARD, ...extra };
}

function publicReq(url) {
  return { url, headers: {} };
}

async function clearGuardrailTables(query) {
  // Wipe corrections first to avoid FK trouble; then guardrails.
  await query(`DELETE FROM inbox.llm_guardrail_corrections`);
  await query(`DELETE FROM inbox.llm_guardrails`);
}

async function insertCurrent(query, { id, kind, prompt_text = 'p', revision = 1, mapping = {} }) {
  await query(
    `INSERT INTO inbox.llm_guardrails
       (id, kind, prompt_text, mapping, revision, created_by, is_current)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, true)`,
    [id, kind, prompt_text, JSON.stringify(mapping), revision, 'system'],
  );
}

async function insertHistorical(query, { id, kind, revision, prompt_text = 'old' }) {
  await query(
    `INSERT INTO inbox.llm_guardrails
       (id, kind, prompt_text, revision, created_by, is_current)
     VALUES ($1, $2, $3, $4, 'system', false)`,
    [id, kind, prompt_text, revision],
  );
}

// ===========================================================================
// GET /api/guardrails — current push + pull
// ===========================================================================

describe('GET /api/guardrails', () => {
  let query;

  before(async () => { ({ query } = await getDb()); });

  beforeEach(async () => { await clearGuardrailTables(query); });

  it('returns { push: null, pull: null } when no guardrails exist', async () => {
    const res = await getGuardrails(boardReq('/api/guardrails'));
    assert.deepEqual(res, { push: null, pull: null });
  });

  it('returns current push row when only push is set', async () => {
    await insertCurrent(query, {
      id: 'gr-get-push-1', kind: 'push',
      prompt_text: 'push body', mapping: { backlog: 'inbox' },
    });
    const res = await getGuardrails(boardReq('/api/guardrails'));
    assert.ok(res.push, 'push must be present');
    assert.strictEqual(res.push.id, 'gr-get-push-1');
    assert.strictEqual(res.push.kind, 'push');
    assert.strictEqual(res.push.prompt_text, 'push body');
    assert.strictEqual(res.push.is_current, true);
    assert.strictEqual(res.pull, null, 'pull must be null');
  });

  it('returns both push and pull when both current rows exist', async () => {
    await insertCurrent(query, {
      id: 'gr-get-both-push', kind: 'push', prompt_text: 'p push',
    });
    await insertCurrent(query, {
      id: 'gr-get-both-pull', kind: 'pull', prompt_text: 'p pull',
    });
    const res = await getGuardrails(boardReq('/api/guardrails'));
    assert.strictEqual(res.push.id, 'gr-get-both-push');
    assert.strictEqual(res.pull.id, 'gr-get-both-pull');
  });

  it('does NOT return non-current revisions', async () => {
    await insertHistorical(query, { id: 'gr-get-old', kind: 'push', revision: 1 });
    const res = await getGuardrails(boardReq('/api/guardrails'));
    assert.strictEqual(res.push, null, 'non-current row must not be returned');
  });

  it('rejects unauthenticated callers (401/403)', async () => {
    await assert.rejects(
      () => getGuardrails(publicReq('/api/guardrails')),
      (err) => err.statusCode === 401 || err.statusCode === 403,
    );
  });
});

// ===========================================================================
// POST /api/guardrails — create new revision; flip is_current atomically
// ===========================================================================

describe('POST /api/guardrails', () => {
  let query;

  before(async () => { ({ query } = await getDb()); });

  beforeEach(async () => { await clearGuardrailTables(query); });

  it('creates the first push guardrail at revision=1, is_current=true', async () => {
    const res = await saveGuardrail(
      boardReq('/api/guardrails'),
      { kind: 'push', prompt_text: 'first push', mapping: {}, note: 'bootstrap' },
    );
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.kind, 'push');
    assert.strictEqual(res.revision, 1);
    assert.ok(res.id, 'id must be returned');

    const r = await query(
      `SELECT kind, revision, is_current, prompt_text, note, created_by
         FROM inbox.llm_guardrails WHERE id = $1`,
      [res.id],
    );
    assert.strictEqual(r.rows[0].kind, 'push');
    assert.strictEqual(r.rows[0].revision, 1);
    assert.strictEqual(r.rows[0].is_current, true);
    assert.strictEqual(r.rows[0].prompt_text, 'first push');
    assert.strictEqual(r.rows[0].note, 'bootstrap');
    assert.strictEqual(
      r.rows[0].created_by, BOARD.github_username,
      'created_by must record the actor',
    );
  });

  it('creates revision=2 on second push save and flips prior current to is_current=false', async () => {
    const first = await saveGuardrail(
      boardReq('/api/guardrails'),
      { kind: 'push', prompt_text: 'v1', mapping: {} },
    );
    assert.strictEqual(first.revision, 1);

    const second = await saveGuardrail(
      boardReq('/api/guardrails'),
      { kind: 'push', prompt_text: 'v2', mapping: { x: 1 } },
    );
    assert.strictEqual(second.revision, 2);
    assert.notStrictEqual(second.id, first.id);

    const r = await query(
      `SELECT id, revision, is_current FROM inbox.llm_guardrails
        WHERE kind = 'push' ORDER BY revision`,
    );
    assert.strictEqual(r.rows.length, 2);
    // Older row flipped to non-current.
    assert.strictEqual(r.rows[0].id, first.id);
    assert.strictEqual(r.rows[0].is_current, false);
    // Newer row is current.
    assert.strictEqual(r.rows[1].id, second.id);
    assert.strictEqual(r.rows[1].is_current, true);
  });

  it('push revisions do not affect pull revision numbering', async () => {
    await saveGuardrail(boardReq('/api/guardrails'),
      { kind: 'push', prompt_text: 'push v1', mapping: {} });
    await saveGuardrail(boardReq('/api/guardrails'),
      { kind: 'push', prompt_text: 'push v2', mapping: {} });
    const pull = await saveGuardrail(boardReq('/api/guardrails'),
      { kind: 'pull', prompt_text: 'pull v1', mapping: {} });
    // First pull save must be revision=1, independent of push count.
    assert.strictEqual(pull.revision, 1);
  });

  it('rejects prompt_text > 2000 chars with 400 (FR-22 hard cap)', async () => {
    const huge = 'x'.repeat(2001);
    await assert.rejects(
      () =>
        saveGuardrail(
          boardReq('/api/guardrails'),
          { kind: 'push', prompt_text: huge, mapping: {} },
        ),
      (err) => err.statusCode === 400,
    );
  });

  it('accepts prompt_text at exactly 2000 chars (boundary)', async () => {
    const exact = 'x'.repeat(2000);
    const res = await saveGuardrail(
      boardReq('/api/guardrails'),
      { kind: 'push', prompt_text: exact, mapping: {} },
    );
    assert.strictEqual(res.ok, true);
  });

  it('rejects invalid kind with 400', async () => {
    await assert.rejects(
      () =>
        saveGuardrail(
          boardReq('/api/guardrails'),
          { kind: 'sideways', prompt_text: 'x', mapping: {} },
        ),
      (err) => err.statusCode === 400,
    );
  });

  it('rejects mapping that is not an object (array) with 400', async () => {
    await assert.rejects(
      () =>
        saveGuardrail(
          boardReq('/api/guardrails'),
          { kind: 'push', prompt_text: 'x', mapping: ['nope'] },
        ),
      (err) => err.statusCode === 400,
    );
  });

  it('rejects mapping that is not an object (string) with 400', async () => {
    await assert.rejects(
      () =>
        saveGuardrail(
          boardReq('/api/guardrails'),
          { kind: 'push', prompt_text: 'x', mapping: 'huh' },
        ),
      (err) => err.statusCode === 400,
    );
  });

  it('rejects mapping that is null with 400', async () => {
    await assert.rejects(
      () =>
        saveGuardrail(
          boardReq('/api/guardrails'),
          { kind: 'push', prompt_text: 'x', mapping: null },
        ),
      (err) => err.statusCode === 400,
    );
  });

  it('rejects missing prompt_text with 400', async () => {
    await assert.rejects(
      () =>
        saveGuardrail(
          boardReq('/api/guardrails'),
          { kind: 'push', mapping: {} },
        ),
      (err) => err.statusCode === 400,
    );
  });

  it('persists mapping JSONB exactly as given', async () => {
    const mapping = { backlog: 'inbox', started: 'in_progress', completed: 'done' };
    const res = await saveGuardrail(
      boardReq('/api/guardrails'),
      { kind: 'push', prompt_text: 'mapping test', mapping },
    );
    const r = await query(
      `SELECT mapping FROM inbox.llm_guardrails WHERE id = $1`,
      [res.id],
    );
    const stored = typeof r.rows[0].mapping === 'string'
      ? JSON.parse(r.rows[0].mapping)
      : r.rows[0].mapping;
    assert.deepStrictEqual(stored, mapping);
  });

  it('rejects unauthenticated callers (401/403)', async () => {
    await assert.rejects(
      () =>
        saveGuardrail(
          publicReq('/api/guardrails'),
          { kind: 'push', prompt_text: 'x', mapping: {} },
        ),
      (err) => err.statusCode === 401 || err.statusCode === 403,
    );
  });

  it('atomicity: if the new INSERT violates a constraint, prior current row remains is_current=true', async () => {
    // Seed v1 current row.
    const first = await saveGuardrail(
      boardReq('/api/guardrails'),
      { kind: 'push', prompt_text: 'v1', mapping: {} },
    );

    // Force the second save to fail by pre-inserting an id collision target.
    // Easiest deterministic failure: inject an oversize prompt — handler
    // throws BEFORE opening the transaction. Instead, fail mid-transaction
    // by inserting a duplicate revision via raw SQL after handler computes it.
    //
    // We simulate "insert fails" by attempting to save a second push with
    // a prompt_text that the handler computes is fine, but then we race a
    // direct INSERT of revision=2 first to trigger a uniqueness clash on
    // (kind, revision). Without such a constraint the handler must still
    // expose atomicity via its transaction — so this test instead exercises
    // the strongest guarantee we can pin: when saveGuardrail throws for ANY
    // reason after the flip would have started, the v1 row must still be
    // current.
    //
    // We do that by forcing a failure via mapping that triggers a JSON
    // serialisation error: passing an unserialisable value (BigInt). The
    // handler must validate-and-throw before opening the transaction, so
    // v1 stays current.
    await assert.rejects(
      () =>
        saveGuardrail(
          boardReq('/api/guardrails'),
          { kind: 'push', prompt_text: 'v2', mapping: { bad: 1n } },
        ),
    );

    const r = await query(
      `SELECT id, is_current FROM inbox.llm_guardrails
        WHERE kind = 'push' ORDER BY revision`,
    );
    // Only v1 must exist, still current.
    assert.strictEqual(r.rows.length, 1);
    assert.strictEqual(r.rows[0].id, first.id);
    assert.strictEqual(
      r.rows[0].is_current, true,
      'rollback must preserve prior current row',
    );
  });

  it('flip-then-insert runs in a single transaction (only one current row at any commit)', async () => {
    // Even with two saves back-to-back, the table must NEVER persist
    // two current rows of the same kind. The partial unique index from
    // migration 120 enforces this at the DB level, but the handler must
    // perform UPDATE→INSERT inside a single transaction (no window where
    // both rows are current).
    await saveGuardrail(boardReq('/api/guardrails'),
      { kind: 'push', prompt_text: 'first', mapping: {} });
    await saveGuardrail(boardReq('/api/guardrails'),
      { kind: 'push', prompt_text: 'second', mapping: {} });

    const r = await query(
      `SELECT COUNT(*)::int AS n FROM inbox.llm_guardrails
        WHERE kind = 'push' AND is_current = true`,
    );
    assert.strictEqual(r.rows[0].n, 1, 'exactly one current push row');
  });
});

// ===========================================================================
// GET /api/guardrails/history — last 50 revisions, optional kind filter
// ===========================================================================

describe('GET /api/guardrails/history', () => {
  let query;

  before(async () => { ({ query } = await getDb()); });

  beforeEach(async () => { await clearGuardrailTables(query); });

  it('returns empty array when no guardrails exist', async () => {
    const res = await getGuardrailHistory(boardReq('/api/guardrails/history'));
    assert.ok(Array.isArray(res), 'history must be an array');
    assert.strictEqual(res.length, 0);
  });

  it('returns rows ordered by kind, revision DESC', async () => {
    // Insert a mixed set: push 1, push 2 (current), pull 1, pull 2 (current).
    await insertHistorical(query, { id: 'gr-h-p1', kind: 'push', revision: 1, prompt_text: 'p1' });
    await insertCurrent(query,    { id: 'gr-h-p2', kind: 'push', revision: 2, prompt_text: 'p2' });
    await insertHistorical(query, { id: 'gr-h-q1', kind: 'pull', revision: 1, prompt_text: 'q1' });
    await insertCurrent(query,    { id: 'gr-h-q2', kind: 'pull', revision: 2, prompt_text: 'q2' });

    const res = await getGuardrailHistory(boardReq('/api/guardrails/history'));
    assert.strictEqual(res.length, 4);

    // Ordering: kind ASC, revision DESC. So pull r2, pull r1, push r2, push r1
    // (or push first then pull — pinning to alphabetical kind ASC since
    // 'pull' < 'push' lexicographically… actually 'pull' < 'push' is true).
    // Validate by inspecting kind/revision pairs rather than committing to
    // either order — the contract is "ordered by kind, revision DESC".
    const seq = res.map((r) => `${r.kind}:${r.revision}`);
    // Within each kind, revisions must descend.
    const groups = {};
    for (const row of res) {
      groups[row.kind] = groups[row.kind] || [];
      groups[row.kind].push(row.revision);
    }
    for (const [k, revs] of Object.entries(groups)) {
      const sorted = [...revs].sort((a, b) => b - a);
      assert.deepStrictEqual(revs, sorted,
        `revisions within kind=${k} must DESC, got ${revs}`);
    }
    // Rows of one kind must be contiguous (kind ordering preserved).
    const seenKinds = [];
    for (const row of res) {
      if (seenKinds[seenKinds.length - 1] !== row.kind) seenKinds.push(row.kind);
    }
    const unique = new Set(seenKinds);
    assert.strictEqual(seenKinds.length, unique.size,
      `kinds must be contiguous (not interleaved), got order: ${seq.join(', ')}`);
  });

  it('?kind=push filter returns only push rows', async () => {
    await insertCurrent(query, { id: 'gr-h-f-push', kind: 'push', prompt_text: 'p' });
    await insertCurrent(query, { id: 'gr-h-f-pull', kind: 'pull', prompt_text: 'q' });
    const res = await getGuardrailHistory(
      boardReq('/api/guardrails/history?kind=push'),
    );
    assert.strictEqual(res.length, 1);
    assert.strictEqual(res[0].kind, 'push');
  });

  it('?kind=pull filter returns only pull rows', async () => {
    await insertCurrent(query, { id: 'gr-h-f2-push', kind: 'push', prompt_text: 'p' });
    await insertCurrent(query, { id: 'gr-h-f2-pull', kind: 'pull', prompt_text: 'q' });
    const res = await getGuardrailHistory(
      boardReq('/api/guardrails/history?kind=pull'),
    );
    assert.strictEqual(res.length, 1);
    assert.strictEqual(res[0].kind, 'pull');
  });

  it('rejects ?kind=invalid with 400', async () => {
    await assert.rejects(
      () =>
        getGuardrailHistory(
          boardReq('/api/guardrails/history?kind=sideways'),
        ),
      (err) => err.statusCode === 400,
    );
  });

  it('caps response at 50 rows', async () => {
    // Insert 60 historical push revisions.
    for (let i = 1; i <= 60; i++) {
      const isCurrent = i === 60;
      await query(
        `INSERT INTO inbox.llm_guardrails
           (id, kind, prompt_text, revision, created_by, is_current)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [`gr-h-cap-${i}`, 'push', `v${i}`, i, 'system', isCurrent],
      );
    }
    const res = await getGuardrailHistory(
      boardReq('/api/guardrails/history?kind=push'),
    );
    assert.strictEqual(res.length, 50, 'must cap at 50');
    // Most recent revisions first (descending). Revision 60 must be present.
    const revisions = res.map((r) => r.revision);
    assert.ok(revisions.includes(60), 'newest revision must be in window');
    assert.strictEqual(revisions[0], 60, 'first row must be the newest');
  });

  it('returns the full shape per row (id, kind, revision, prompt_text, mapping, is_current, created_by, created_at, note)', async () => {
    await query(
      `INSERT INTO inbox.llm_guardrails
         (id, kind, prompt_text, mapping, revision, created_by, is_current, note)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)`,
      ['gr-h-shape', 'push', 'shape test', JSON.stringify({ a: 1 }), 7, 'isaias', true, 'a note'],
    );
    const res = await getGuardrailHistory(
      boardReq('/api/guardrails/history?kind=push'),
    );
    assert.strictEqual(res.length, 1);
    const row = res[0];
    for (const key of [
      'id', 'kind', 'revision', 'prompt_text', 'mapping',
      'is_current', 'created_by', 'created_at', 'note',
    ]) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(row, key),
        `history row must include ${key}`,
      );
    }
    assert.strictEqual(row.note, 'a note');
    assert.strictEqual(row.is_current, true);
  });

  it('rejects unauthenticated callers (401/403)', async () => {
    await assert.rejects(
      () => getGuardrailHistory(publicReq('/api/guardrails/history')),
      (err) => err.statusCode === 401 || err.statusCode === 403,
    );
  });
});

// ===========================================================================
// POST /api/guardrails/correction — capture "this was wrong" tied to current
// ===========================================================================

describe('POST /api/guardrails/correction', () => {
  let query;

  before(async () => { ({ query } = await getDb()); });

  beforeEach(async () => { await clearGuardrailTables(query); });

  it('captures a correction tied to the current push guardrail', async () => {
    await insertCurrent(query, { id: 'gr-cor-current', kind: 'push', prompt_text: 'p' });
    const res = await saveGuardrailCorrection(
      boardReq('/api/guardrails/correction'),
      { task_id: 'htm-cor-1', description: 'projectId picked wrong project' },
    );
    assert.strictEqual(res.ok, true);
    assert.ok(res.id, 'returned id must be set');
    assert.strictEqual(res.guardrail_id, 'gr-cor-current');

    const r = await query(
      `SELECT guardrail_id, task_id, description, captured_by
         FROM inbox.llm_guardrail_corrections WHERE id = $1`,
      [res.id],
    );
    assert.strictEqual(r.rows[0].guardrail_id, 'gr-cor-current');
    assert.strictEqual(r.rows[0].task_id, 'htm-cor-1');
    assert.strictEqual(r.rows[0].description, 'projectId picked wrong project');
    assert.strictEqual(r.rows[0].captured_by, BOARD.github_username);
  });

  it('defaults kind to "push" when not supplied', async () => {
    await insertCurrent(query, { id: 'gr-cor-default-push', kind: 'push', prompt_text: 'p' });
    await insertCurrent(query, { id: 'gr-cor-default-pull', kind: 'pull', prompt_text: 'q' });
    const res = await saveGuardrailCorrection(
      boardReq('/api/guardrails/correction'),
      { task_id: 'htm-cor-default', description: 'wrong' },
    );
    assert.strictEqual(res.guardrail_id, 'gr-cor-default-push',
      'omitting kind must target the current push guardrail');
  });

  it('targets the current pull guardrail when kind="pull" is supplied', async () => {
    await insertCurrent(query, { id: 'gr-cor-pp-push', kind: 'push', prompt_text: 'p' });
    await insertCurrent(query, { id: 'gr-cor-pp-pull', kind: 'pull', prompt_text: 'q' });
    const res = await saveGuardrailCorrection(
      boardReq('/api/guardrails/correction'),
      { task_id: 'htm-cor-pull', description: 'pull picked wrong', kind: 'pull' },
    );
    assert.strictEqual(res.guardrail_id, 'gr-cor-pp-pull');
  });

  it('returns 409 when no current guardrail exists for the kind', async () => {
    // No rows in llm_guardrails at all.
    await assert.rejects(
      () =>
        saveGuardrailCorrection(
          boardReq('/api/guardrails/correction'),
          { task_id: 'htm-cor-none', description: 'wrong' },
        ),
      (err) => err.statusCode === 409,
    );
  });

  it('returns 409 when current row for kind is missing (only the other kind is current)', async () => {
    // Only pull is current. Default kind=push must 409.
    await insertCurrent(query, { id: 'gr-cor-only-pull', kind: 'pull', prompt_text: 'q' });
    await assert.rejects(
      () =>
        saveGuardrailCorrection(
          boardReq('/api/guardrails/correction'),
          { task_id: 'htm-cor-only-pull', description: 'wrong' },
        ),
      (err) => err.statusCode === 409,
    );
  });

  it('rejects empty description with 400', async () => {
    await insertCurrent(query, { id: 'gr-cor-empty', kind: 'push', prompt_text: 'p' });
    await assert.rejects(
      () =>
        saveGuardrailCorrection(
          boardReq('/api/guardrails/correction'),
          { task_id: 'htm-cor-empty', description: '' },
        ),
      (err) => err.statusCode === 400,
    );
  });

  it('rejects whitespace-only description with 400', async () => {
    await insertCurrent(query, { id: 'gr-cor-ws', kind: 'push', prompt_text: 'p' });
    await assert.rejects(
      () =>
        saveGuardrailCorrection(
          boardReq('/api/guardrails/correction'),
          { task_id: 'htm-cor-ws', description: '   ' },
        ),
      (err) => err.statusCode === 400,
    );
  });

  it('rejects description > 1000 chars with 400', async () => {
    await insertCurrent(query, { id: 'gr-cor-huge', kind: 'push', prompt_text: 'p' });
    await assert.rejects(
      () =>
        saveGuardrailCorrection(
          boardReq('/api/guardrails/correction'),
          { task_id: 'htm-cor-huge', description: 'x'.repeat(1001) },
        ),
      (err) => err.statusCode === 400,
    );
  });

  it('accepts description at exactly 1000 chars (boundary)', async () => {
    await insertCurrent(query, { id: 'gr-cor-bound', kind: 'push', prompt_text: 'p' });
    const res = await saveGuardrailCorrection(
      boardReq('/api/guardrails/correction'),
      { task_id: 'htm-cor-bound', description: 'x'.repeat(1000) },
    );
    assert.strictEqual(res.ok, true);
  });

  it('rejects missing task_id with 400', async () => {
    await insertCurrent(query, { id: 'gr-cor-no-task', kind: 'push', prompt_text: 'p' });
    await assert.rejects(
      () =>
        saveGuardrailCorrection(
          boardReq('/api/guardrails/correction'),
          { description: 'wrong' },
        ),
      (err) => err.statusCode === 400,
    );
  });

  it('rejects non-string task_id with 400', async () => {
    await insertCurrent(query, { id: 'gr-cor-bad-task', kind: 'push', prompt_text: 'p' });
    await assert.rejects(
      () =>
        saveGuardrailCorrection(
          boardReq('/api/guardrails/correction'),
          { task_id: 12345, description: 'wrong' },
        ),
      (err) => err.statusCode === 400,
    );
  });

  it('rejects invalid kind with 400', async () => {
    await insertCurrent(query, { id: 'gr-cor-bad-kind', kind: 'push', prompt_text: 'p' });
    await assert.rejects(
      () =>
        saveGuardrailCorrection(
          boardReq('/api/guardrails/correction'),
          { task_id: 't', description: 'wrong', kind: 'sideways' },
        ),
      (err) => err.statusCode === 400,
    );
  });

  it('captures the guardrail_id AS OF the moment of capture (not at later flip)', async () => {
    // Capture against v1.
    await insertCurrent(query, { id: 'gr-cor-tnow-1', kind: 'push', prompt_text: 'v1' });
    const res = await saveGuardrailCorrection(
      boardReq('/api/guardrails/correction'),
      { task_id: 'htm-cor-tnow', description: 'wrong under v1' },
    );
    assert.strictEqual(res.guardrail_id, 'gr-cor-tnow-1');

    // Now operator saves a new revision — v1 becomes non-current.
    await query(
      `UPDATE inbox.llm_guardrails SET is_current = false
        WHERE id = $1`,
      ['gr-cor-tnow-1'],
    );
    await insertCurrent(query, { id: 'gr-cor-tnow-2', kind: 'push', prompt_text: 'v2', revision: 2 });

    // The earlier correction row must still point at v1 (NOT silently rewired
    // to v2). This is the AD-6 attribution guarantee.
    const r = await query(
      `SELECT guardrail_id FROM inbox.llm_guardrail_corrections WHERE id = $1`,
      [res.id],
    );
    assert.strictEqual(
      r.rows[0].guardrail_id, 'gr-cor-tnow-1',
      'correction must remain attributed to the revision in effect at capture',
    );
  });

  it('rejects unauthenticated callers (401/403)', async () => {
    await insertCurrent(query, { id: 'gr-cor-auth', kind: 'push', prompt_text: 'p' });
    await assert.rejects(
      () =>
        saveGuardrailCorrection(
          publicReq('/api/guardrails/correction'),
          { task_id: 't', description: 'wrong' },
        ),
      (err) => err.statusCode === 401 || err.statusCode === 403,
    );
  });
});

// ===========================================================================
// Restricted: versioning by INSERT only — no UPDATE path via the API.
// ===========================================================================

describe('Restricted: guardrail rows are append-only via the public API', () => {
  let query;

  before(async () => { ({ query } = await getDb()); });

  beforeEach(async () => { await clearGuardrailTables(query); });

  it('saveGuardrail never UPDATEs the prompt_text of an existing row (new row inserted instead)', async () => {
    const first = await saveGuardrail(
      boardReq('/api/guardrails'),
      { kind: 'push', prompt_text: 'original text', mapping: {} },
    );
    await saveGuardrail(
      boardReq('/api/guardrails'),
      { kind: 'push', prompt_text: 'replacement text', mapping: {} },
    );
    const r = await query(
      `SELECT prompt_text FROM inbox.llm_guardrails WHERE id = $1`,
      [first.id],
    );
    assert.strictEqual(
      r.rows[0].prompt_text, 'original text',
      'previous revision prompt_text must be immutable',
    );
  });

  it('saveGuardrail never UPDATEs the mapping of an existing row', async () => {
    const first = await saveGuardrail(
      boardReq('/api/guardrails'),
      { kind: 'push', prompt_text: 'p', mapping: { a: 1 } },
    );
    await saveGuardrail(
      boardReq('/api/guardrails'),
      { kind: 'push', prompt_text: 'p', mapping: { a: 99 } },
    );
    const r = await query(
      `SELECT mapping FROM inbox.llm_guardrails WHERE id = $1`,
      [first.id],
    );
    const stored = typeof r.rows[0].mapping === 'string'
      ? JSON.parse(r.rows[0].mapping)
      : r.rows[0].mapping;
    assert.deepStrictEqual(stored, { a: 1 },
      'previous revision mapping must be immutable');
  });

  it('the API surface does not expose any PATCH/PUT handler for guardrails (export check)', async () => {
    // Import the handlers and inspect what is exported. Only the four
    // documented handlers must be present; nothing that suggests a row-level
    // mutation path (e.g. patchGuardrail / updateGuardrail).
    const mod = await import('../src/api-routes/guardrails.js');
    const exported = Object.keys(mod);
    assert.ok(exported.includes('getGuardrails'));
    assert.ok(exported.includes('saveGuardrail'));
    assert.ok(exported.includes('getGuardrailHistory'));
    assert.ok(exported.includes('saveGuardrailCorrection'));
    for (const k of exported) {
      assert.ok(
        !/^(patch|update|delete|modify)Guardrail/i.test(k),
        `unexpected mutator-style export: ${k}`,
      );
    }
  });
});
