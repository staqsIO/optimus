/**
 * Tests for the AssemblyAI voice-memo callback (POST /api/webhooks/assemblyai)
 * and the reaper's voice-memo strand sweep.
 *
 * Goal: prove the transactional refactor closes the silent-skip-on-partial-failure
 * gap (P0) and that the strand detector recovers stuck rows.
 *
 * Run: cd autobot-inbox && node --experimental-test-module-mocks --test test/voice-memo.test.js
 */

import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ---- Module-level mocks (must be set before importing voice-memo.js / reaper.js) ----

const mockQuery = mock.fn();
const mockWithTransaction = mock.fn();
const mockFetchTranscript = mock.fn();
const mockFormatWithSpeakers = mock.fn();
const mockIngestDocument = mock.fn();
const mockCreateWorkItem = mock.fn();
const mockNotify = mock.fn();

// OPT-166 P2b: reaper.js now imports withSystemScope from db.js. The scope is a
// callable executor (q(text, params)) carrying a .release() — faithfully stub it
// to delegate to mockQuery so sysQuery()/emit-scope DB calls route through the
// same mock the assertions already inspect (behavior identical to pre-P2b).
const mockWithSystemScope = mock.fn(async () => {
  const scoped = async (text, params) => mockQuery(text, params);
  scoped.release = async () => {};
  return scoped;
});

mock.module('../src/db.js', {
  namedExports: {
    query: mockQuery,
    withTransaction: mockWithTransaction,
    withSystemScope: mockWithSystemScope,
    withSystemOrgScope: mockWithSystemScope,
    initializeDatabase: mock.fn(),
    setAgentContext: mock.fn(),
    withAgentScope: mock.fn(),
    sha256: mock.fn(),
    getMode: mock.fn(),
    getPool: mock.fn(),
    close: mock.fn(),
  },
});

mock.module('../../lib/transcription/assemblyai.js', {
  namedExports: {
    uploadAudio: mock.fn(),
    requestTranscript: mock.fn(),
    fetchTranscript: mockFetchTranscript,
    formatWithSpeakers: mockFormatWithSpeakers,
  },
});

mock.module('../../lib/rag/ingest.js', {
  namedExports: { ingestDocument: mockIngestDocument },
});

mock.module('../src/runtime/state-machine.js', {
  namedExports: { createWorkItem: mockCreateWorkItem },
});

mock.module('../src/runtime/event-bus.js', {
  namedExports: { notify: mockNotify },
});

// db module that reaper.js imports lives at lib/db.js relative to lib/runtime.
// reaper.js does `import { query } from '../db.js'` — that resolves to lib/db.js.
mock.module('../../lib/db.js', {
  namedExports: {
    query: mockQuery,
    withTransaction: mockWithTransaction,
    withSystemScope: mockWithSystemScope,
    withSystemOrgScope: mockWithSystemScope,
    initializeDatabase: mock.fn(),
    setAgentContext: mock.fn(),
    withAgentScope: mock.fn(),
    sha256: mock.fn(),
    getMode: mock.fn(),
    getPool: mock.fn(),
    close: mock.fn(),
  },
});

// Reaper indirectly imports state-machine + event-bus; same paths from lib/runtime/.
mock.module('../../lib/runtime/state-machine.js', {
  namedExports: {
    createWorkItem: mockCreateWorkItem,
    transitionState: mock.fn(async () => true),
    claimNextTask: mock.fn(),
    claimAndStart: mock.fn(),
    createEdge: mock.fn(),
  },
});

mock.module('../../lib/runtime/event-bus.js', {
  namedExports: { notify: mockNotify, emit: mock.fn(async () => true) },
});

mock.module('../../lib/runtime/infrastructure.js', {
  namedExports: { publishEvent: mock.fn() },
});

// Helper: route handlers are registered via a Map. Build a fake req/body.
function buildReq(overrides = {}) {
  return {
    headers: { 'x-optimus-webhook-auth': 'test-secret' },
    ...overrides,
  };
}

beforeEach(() => {
  process.env.WEBHOOK_AUTH_ASSEMBLYAI_VALUE = 'test-secret';
  mockQuery.mock.resetCalls();
  mockWithTransaction.mock.resetCalls();
  mockFetchTranscript.mock.resetCalls();
  mockFormatWithSpeakers.mock.resetCalls();
  mockIngestDocument.mock.resetCalls();
  mockCreateWorkItem.mock.resetCalls();
  mockNotify.mock.resetCalls();
  mockWithSystemScope.mock.resetCalls();
  mockQuery.mock.mockImplementation(async () => ({ rows: [] }));
  mockWithTransaction.mock.mockImplementation(async (fn) => fn({ query: mockQuery }));
  mockFetchTranscript.mock.mockImplementation(async () => ({ utterances: [], text: '', audio_duration: 60 }));
  mockFormatWithSpeakers.mock.mockImplementation(() => ({ text: 'formatted', speakers: { eric: 1 } }));
  mockIngestDocument.mock.mockImplementation(async () => ({ documentId: null }));
  mockCreateWorkItem.mock.mockImplementation(async () => ({ id: 'work-item-1' }));
  mockNotify.mock.mockImplementation(async () => true);
});

async function getRoute(path) {
  const { registerVoiceMemoRoutes } = await import('../src/api-routes/voice-memo.js');
  const routes = new Map();
  registerVoiceMemoRoutes(routes);
  return routes.get(path);
}

describe('POST /api/webhooks/assemblyai', () => {
  it('happy path: claim → INSERT → createWorkItem → complete', async () => {
    // Sequence of client.query() return values inside the transaction.
    let call = 0;
    const queryResponses = [
      // 1: claim pending
      { rows: [{ id: 'pending-1', tracking_id: 'trk', primary_speaker: 'eric', metadata: { name: 'Memo' } }] },
      // 2: INSERT messages
      { rows: [{ id: 'msg-1' }] },
      // 3: UPDATE messages.work_item_id
      { rows: [] },
      // 4: UPDATE pending completed
      { rows: [] },
    ];
    mockQuery.mock.mockImplementation(async () => queryResponses[call++] || { rows: [] });

    const handler = await getRoute('POST /api/webhooks/assemblyai');
    const result = await handler(buildReq(), { transcript_id: 'tr-1', status: 'completed' });

    assert.equal(result.id, 'msg-1');
    assert.equal(result.workItemId, 'work-item-1');
    assert.equal(result.source, 'voice_memo');

    // createWorkItem received a client (parent tx)
    const wiCall = mockCreateWorkItem.mock.calls[0].arguments[0];
    assert.ok(wiCall.client, 'createWorkItem must receive parent client');

    // Notification fired AFTER the tx completed
    assert.equal(mockNotify.mock.calls.length, 1);
    assert.equal(mockNotify.mock.calls[0].arguments[0].targetAgentId, 'executor-triage');

    // RAG ingest fired post-commit
    assert.equal(mockIngestDocument.mock.calls.length, 1);
  });

  it('partial-failure rollback: createWorkItem throws → no UPDATE pending completed', async () => {
    let call = 0;
    const queryResponses = [
      // 1: claim pending
      { rows: [{ id: 'pending-1', tracking_id: 'trk', primary_speaker: 'eric', metadata: {} }] },
      // 2: INSERT messages
      { rows: [{ id: 'msg-1' }] },
      // 3+ should never run because createWorkItem throws first
    ];
    mockQuery.mock.mockImplementation(async () => queryResponses[call++] || { rows: [] });
    mockCreateWorkItem.mock.mockImplementation(async () => {
      throw new Error('simulated createWorkItem crash');
    });

    const handler = await getRoute('POST /api/webhooks/assemblyai');
    await assert.rejects(
      () => handler(buildReq(), { transcript_id: 'tr-2', status: 'completed' }),
      /simulated createWorkItem crash/
    );

    // The final UPDATE pending 'completed' must NOT have fired — withTransaction
    // would roll it back along with the messages INSERT. In our mock, the throw
    // exits the callback before we reach those statements.
    const allSql = mockQuery.mock.calls.map((c) => c.arguments[0]).join('\n');
    assert.ok(!/SET status = 'completed'/.test(allSql),
      'pending must NOT be marked completed when createWorkItem throws');

    // No post-commit notify, no RAG ingest
    assert.equal(mockNotify.mock.calls.length, 0);
    assert.equal(mockIngestDocument.mock.calls.length, 0);
  });

  it('conflict path with no prior work item: recover by reusing messages row', async () => {
    let call = 0;
    const queryResponses = [
      // 1: claim pending
      { rows: [{ id: 'pending-1', tracking_id: 'trk', primary_speaker: 'eric', metadata: {} }] },
      // 2: INSERT messages → ON CONFLICT DO NOTHING returns no rows
      { rows: [] },
      // 3: SELECT existing messages row (no work_item_id)
      { rows: [{ id: 'msg-existing', work_item_id: null }] },
      // 4: UPDATE messages.work_item_id
      { rows: [] },
      // 5: UPDATE pending completed
      { rows: [] },
    ];
    mockQuery.mock.mockImplementation(async () => queryResponses[call++] || { rows: [] });

    const handler = await getRoute('POST /api/webhooks/assemblyai');
    const result = await handler(buildReq(), { transcript_id: 'tr-3', status: 'completed' });

    assert.equal(result.id, 'msg-existing', 'should reuse the pre-existing messages row');
    assert.equal(result.workItemId, 'work-item-1', 'should create the missing work item');
    assert.equal(mockCreateWorkItem.mock.calls.length, 1);
  });

  it('conflict path with existing work item: clean-skip, mark pending complete', async () => {
    let call = 0;
    const queryResponses = [
      // 1: claim pending
      { rows: [{ id: 'pending-1', tracking_id: 'trk', primary_speaker: 'eric', metadata: {} }] },
      // 2: INSERT messages → conflict
      { rows: [] },
      // 3: SELECT existing → has work_item_id
      { rows: [{ id: 'msg-existing', work_item_id: 'work-existing' }] },
      // 4: UPDATE pending completed (the clean-skip path)
      { rows: [] },
    ];
    mockQuery.mock.mockImplementation(async () => queryResponses[call++] || { rows: [] });

    const handler = await getRoute('POST /api/webhooks/assemblyai');
    const result = await handler(buildReq(), { transcript_id: 'tr-4', status: 'completed' });

    assert.equal(result.skipped, true);
    assert.match(result.reason, /work_item already exists/);
    assert.equal(mockCreateWorkItem.mock.calls.length, 0, 'must not create a duplicate work item');
    assert.equal(mockNotify.mock.calls.length, 0);
    assert.equal(mockIngestDocument.mock.calls.length, 0);
  });

  it('unclaimable pending row: clean exit without side effects', async () => {
    mockQuery.mock.mockImplementation(async () => ({ rows: [] })); // claim returns no rows

    const handler = await getRoute('POST /api/webhooks/assemblyai');
    const result = await handler(buildReq(), { transcript_id: 'tr-5', status: 'completed' });

    assert.equal(result.skipped, true);
    assert.match(result.reason, /unknown or already processed/);
    assert.equal(mockCreateWorkItem.mock.calls.length, 0);
    assert.equal(mockFetchTranscript.mock.calls.length, 0);
  });

  it('AssemblyAI error status: marks pending failed, no work item', async () => {
    let call = 0;
    const queryResponses = [
      // 1: claim
      { rows: [{ id: 'pending-1', tracking_id: 'trk', primary_speaker: 'eric', metadata: {} }] },
      // 2: UPDATE pending failed
      { rows: [] },
    ];
    mockQuery.mock.mockImplementation(async () => queryResponses[call++] || { rows: [] });

    const handler = await getRoute('POST /api/webhooks/assemblyai');
    const result = await handler(buildReq(), { transcript_id: 'tr-6', status: 'error', error: 'transcription failed' });

    assert.equal(result.status, 'failed');
    assert.equal(mockCreateWorkItem.mock.calls.length, 0);
    assert.equal(mockFetchTranscript.mock.calls.length, 0);
  });
});

describe('Reaper.sweepVoiceMemos', () => {
  it('resets stuck pending rows and logs each recovery', async () => {
    mockQuery.mock.mockImplementation(async () => ({
      rows: [
        { id: 'p1', transcript_id: 't1', tracking_id: 'trk1', created_at: new Date(Date.now() - 11 * 60 * 1000) },
        { id: 'p2', transcript_id: 't2', tracking_id: 'trk2', created_at: new Date(Date.now() - 15 * 60 * 1000) },
      ],
    }));

    const { Reaper } = await import('../../lib/runtime/reaper.js');
    const reaper = new Reaper({ voiceMemoStrandMs: 10 * 60 * 1000 });
    await reaper.sweepVoiceMemos();

    assert.equal(mockQuery.mock.calls.length, 1);
    const sql = mockQuery.mock.calls[0].arguments[0];
    assert.match(sql, /UPDATE inbox\.voice_memo_pending/);
    assert.match(sql, /SET status = 'pending'/);
    assert.match(sql, /WHERE status = 'processing'/);
  });

  it('survives a missing schema (does not throw past the catch)', async () => {
    mockQuery.mock.mockImplementation(async () => {
      throw new Error('relation "inbox.voice_memo_pending" does not exist');
    });

    const { Reaper } = await import('../../lib/runtime/reaper.js');
    const reaper = new Reaper();
    await assert.doesNotReject(() => reaper.sweepVoiceMemos());
  });
});
