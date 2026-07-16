/**
 * Tests for the Slack listener's ingest path.
 *
 * Pre-fix bugs (Neo audit G4 + voice-memo-shape G1):
 *   - SELECT-then-INSERT TOCTOU race: concurrent retries both pass SELECT,
 *     second INSERT throws unique-violation, request 500s, Slack retries
 *     forever and eventually pauses the subscription.
 *   - Same partial-failure-mid-flow strand as voice-memo: INSERT lands, then
 *     createWorkItem throws → messages row exists, no work item, no recovery.
 *
 * Post-fix invariants:
 *   - Concurrent retries collapse via ON CONFLICT (no exception, no 500).
 *   - Partial failure rolls back the whole flow (no orphan messages row).
 *   - True duplicate (work_item exists) is a clean-skip.
 *   - Orphan recovery (messages row exists, no work_item) creates the missing
 *     work item against the existing row.
 *
 * Run: cd autobot-inbox && node --experimental-test-module-mocks --test test/slack-listener-ingest.test.js
 */

import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const mockQuery = mock.fn();
const mockWithTransaction = mock.fn();
const mockCreateWorkItem = mock.fn();
const mockGetUserInfo = mock.fn();
const mockNotify = mock.fn();

mock.module('../src/db.js', {
  namedExports: {
    query: mockQuery,
    withTransaction: mockWithTransaction,
    initializeDatabase: mock.fn(),
    setAgentContext: mock.fn(),
    withAgentScope: mock.fn(),
    sha256: mock.fn(),
    getMode: mock.fn(),
    getPool: mock.fn(),
    close: mock.fn(),
  },
});

mock.module('../src/runtime/state-machine.js', {
  namedExports: { createWorkItem: mockCreateWorkItem },
});

mock.module('../src/runtime/event-bus.js', {
  namedExports: { notify: mockNotify },
});

mock.module('../src/slack/client.js', {
  namedExports: {
    getUserInfo: mockGetUserInfo,
    sendMessage: mock.fn(),
  },
});

// Transitive mocks so the module graph loads cleanly.
mock.module('../src/commands/board-commands.js', {
  namedExports: { parseCommand: mock.fn(), executeCommand: mock.fn() },
});

mock.module('../src/commands/board-query.js', {
  namedExports: { handleBoardQuery: mock.fn() },
});

const baseArgs = {
  channelId: 'C1',
  messageTs: '1700000000.000100',
  threadTs: null,
  userId: 'U-eric',
  text: 'hello slack',
  slackAccountId: 'acct-1',
};

beforeEach(() => {
  mockQuery.mock.resetCalls();
  mockWithTransaction.mock.resetCalls();
  mockCreateWorkItem.mock.resetCalls();
  mockGetUserInfo.mock.resetCalls();
  mockNotify.mock.resetCalls();
  mockQuery.mock.mockImplementation(async () => ({ rows: [] }));
  mockWithTransaction.mock.mockImplementation(async (fn) => fn({ query: mockQuery }));
  mockCreateWorkItem.mock.mockImplementation(async () => ({ id: 'work-item-1' }));
  mockGetUserInfo.mock.mockImplementation(async () => ({ realName: 'Eric', email: 'eric@staqs.io' }));
  mockNotify.mock.mockImplementation(async () => true);
});

describe('ingestSlackMessage', () => {
  it('happy path: INSERT → createWorkItem → UPDATE → notify', async () => {
    let call = 0;
    const responses = [
      // 1: INSERT messages → returns msg id
      { rows: [{ id: 'msg-1' }] },
      // 2: UPDATE messages.work_item_id
      { rows: [] },
    ];
    mockQuery.mock.mockImplementation(async () => responses[call++] || { rows: [] });

    const { ingestSlackMessage } = await import('../src/slack/listener.js');
    await ingestSlackMessage(baseArgs);

    assert.equal(mockCreateWorkItem.mock.calls.length, 1);
    assert.ok(mockCreateWorkItem.mock.calls[0].arguments[0].client, 'createWorkItem must receive parent client');
    assert.equal(mockNotify.mock.calls.length, 1);
    assert.equal(mockNotify.mock.calls[0].arguments[0].targetAgentId, 'orchestrator');

    // Confirm the INSERT used ON CONFLICT, not a SELECT-then-INSERT.
    const sqlSeen = mockQuery.mock.calls.map((c) => c.arguments[0]).join('\n');
    assert.match(sqlSeen, /ON CONFLICT \(channel, channel_id\) DO NOTHING/);
    assert.doesNotMatch(sqlSeen, /SELECT id FROM inbox\.messages WHERE channel = 'slack'/,
      'must not use SELECT-then-INSERT pattern');
  });

  it('partial-failure rollback: createWorkItem throws → no UPDATE messages.work_item_id', async () => {
    let call = 0;
    const responses = [
      { rows: [{ id: 'msg-1' }] }, // 1: INSERT
      // No further responses needed — createWorkItem throws first
    ];
    mockQuery.mock.mockImplementation(async () => responses[call++] || { rows: [] });
    mockCreateWorkItem.mock.mockImplementation(async () => {
      throw new Error('simulated createWorkItem crash');
    });

    const { ingestSlackMessage } = await import('../src/slack/listener.js');
    await assert.rejects(() => ingestSlackMessage(baseArgs), /simulated createWorkItem crash/);

    const sqlSeen = mockQuery.mock.calls.map((c) => c.arguments[0]).join('\n');
    assert.doesNotMatch(sqlSeen, /UPDATE inbox\.messages SET work_item_id/,
      'must not run the link UPDATE when createWorkItem throws');
    assert.equal(mockNotify.mock.calls.length, 0);
  });

  it('conflict path with existing work item: clean-skip', async () => {
    let call = 0;
    const responses = [
      // 1: INSERT messages → ON CONFLICT, no rows
      { rows: [] },
      // 2: SELECT existing → has work_item_id
      { rows: [{ id: 'msg-existing', work_item_id: 'work-existing' }] },
    ];
    mockQuery.mock.mockImplementation(async () => responses[call++] || { rows: [] });

    const { ingestSlackMessage } = await import('../src/slack/listener.js');
    await ingestSlackMessage(baseArgs);

    assert.equal(mockCreateWorkItem.mock.calls.length, 0, 'must not create a duplicate work item');
    assert.equal(mockNotify.mock.calls.length, 0);
  });

  it('conflict path with no work item: recover by reusing messages row', async () => {
    let call = 0;
    const responses = [
      // 1: INSERT messages → ON CONFLICT
      { rows: [] },
      // 2: SELECT existing → no work_item_id
      { rows: [{ id: 'msg-orphan', work_item_id: null }] },
      // 3: UPDATE messages.work_item_id (link to newly created work item)
      { rows: [] },
    ];
    mockQuery.mock.mockImplementation(async () => responses[call++] || { rows: [] });

    const { ingestSlackMessage } = await import('../src/slack/listener.js');
    await ingestSlackMessage(baseArgs);

    assert.equal(mockCreateWorkItem.mock.calls.length, 1, 'must create the missing work item');
    assert.equal(mockNotify.mock.calls.length, 1);
  });

  it('user lookup failure falls back to userId without breaking ingest', async () => {
    mockGetUserInfo.mock.mockImplementation(async () => { throw new Error('slack down'); });
    let call = 0;
    const responses = [
      { rows: [{ id: 'msg-1' }] },
      { rows: [] },
    ];
    mockQuery.mock.mockImplementation(async () => responses[call++] || { rows: [] });

    const { ingestSlackMessage } = await import('../src/slack/listener.js');
    await assert.doesNotReject(() => ingestSlackMessage(baseArgs));
    // INSERT params should include the raw userId as fallback for from_name.
    const insertCall = mockQuery.mock.calls.find((c) => /INSERT INTO inbox\.messages/.test(c.arguments[0]));
    assert.ok(insertCall, 'INSERT must have run');
    assert.ok(insertCall.arguments[1].includes('U-eric'), 'fallback fromName=userId must be in params');
  });
});
