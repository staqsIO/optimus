/**
 * Tests for Linear comment-driven agent interaction (comment-handler.js).
 *
 * Covers: parseCommand, isBoardMember, isBotUser, handleLinearComment happy paths,
 * and all deny-by-default guard paths (P1).
 *
 * Run: cd autobot-inbox && node --experimental-test-module-mocks --test test/linear-comment-handler.test.js
 */

import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ---- Module-level mocks (must be set before importing handler) ----

const mockGetIssue = mock.fn();
const mockAddComment = mock.fn();
const mockQuery = mock.fn();

mock.module('../src/linear/client.js', {
  namedExports: {
    getIssue: mockGetIssue,
    addComment: mockAddComment,
    addBotComment: mockAddComment,
    getIssueComments: mock.fn(async () => ({ nodes: [] })),
    updateIssueState: mock.fn(),
    updateIssueStateByName: mock.fn(),
    createIssue: mock.fn(),
    getTeams: mock.fn(),
  },
});

mock.module('../src/db.js', {
  namedExports: {
    query: mockQuery,
    initializeDatabase: mock.fn(),
    withTransaction: mock.fn(),
    setAgentContext: mock.fn(),
    withAgentScope: mock.fn(),
    sha256: mock.fn(),
    getMode: mock.fn(() => 'postgres'),
    close: mock.fn(),
  },
});

// Import after mocks installed
const { handleLinearComment, parseCommand, isBoardMember, isBotUser, clearReplyDedupCache } =
  await import('../src/linear/comment-handler.js');

// ---- Helpers ----

function makeCommentPayload(overrides = {}) {
  return {
    action: 'create',
    type: 'Comment',
    data: {
      id: 'comment-uuid-001',
      body: '/retry use repo:optimus',
      issueId: 'issue-uuid-001',
      user: { id: '00000000-0000-0000-0000-000000000001', name: 'Eric Gang' },
      ...overrides,
    },
  };
}

function makeIssue(overrides = {}) {
  return {
    id: 'issue-uuid-001',
    identifier: 'STAQPRO-48',
    url: 'https://linear.app/staqs/issue/STAQPRO-48',
    title: 'Test issue',
    description: 'Test description.',
    priority: 2,
    assignee: { id: 'bot-uuid', name: 'Jamie Bot' },
    team: { id: 'team-1', name: 'Staqs Internal Projects', key: 'STA' },
    project: null,
    state: { id: 'state-1', name: 'Todo', type: 'unstarted' },
    ...overrides,
  };
}

const noopCreateWorkItem = mock.fn(async () => ({ id: 'wi-retry-001' }));

// ---- parseCommand unit tests ----

describe('parseCommand', () => {
  it('parses /retry with no args', () => {
    const result = parseCommand('/retry');
    assert.deepEqual(result, { command: 'retry', args: '' });
  });

  it('parses /retry with instructions', () => {
    const result = parseCommand('/retry use repo:optimus');
    assert.deepEqual(result, { command: 'retry', args: 'use repo:optimus' });
  });

  it('parses /update with instructions', () => {
    const result = parseCommand('/update change the repo name to X');
    assert.deepEqual(result, { command: 'update', args: 'change the repo name to X' });
  });

  it('parses @Jamie mention as reply', () => {
    const result = parseCommand('@Jamie retry with these instructions: do X');
    assert.deepEqual(result, { command: 'reply', args: 'retry with these instructions: do X' });
  });

  it('parses @Jamie Bot mention (with "Bot") as reply', () => {
    const result = parseCommand('@Jamie Bot please retry');
    assert.deepEqual(result, { command: 'reply', args: 'please retry' });
  });

  it('returns null for plain comment', () => {
    const result = parseCommand('Looks good to me!');
    assert.equal(result, null);
  });

  it('returns null for /update without instructions', () => {
    const result = parseCommand('/update');
    assert.equal(result, null);
  });

  it('strips quoted reply lines before parsing', () => {
    const body = '> previous comment\n> more quote\n/retry with new context';
    const result = parseCommand(body);
    assert.deepEqual(result, { command: 'retry', args: 'with new context' });
  });

  it('is case-insensitive for command prefix', () => {
    const result = parseCommand('/RETRY do something');
    assert.deepEqual(result, { command: 'retry', args: 'do something' });
  });
});

// ---- isBoardMember / isBotUser unit tests ----

describe('isBoardMember', () => {
  it('returns true for "Eric Gang" by name', () => {
    assert.equal(isBoardMember('Eric Gang'), true);
  });

  it('returns true for "Dustin Powers" by name', () => {
    assert.equal(isBoardMember('Dustin Powers'), true);
  });

  it('is case-insensitive for name match', () => {
    assert.equal(isBoardMember('eric gang'), true);
  });

  it('returns false for unknown user', () => {
    assert.equal(isBoardMember('Random Person'), false);
  });

  it('returns false for null', () => {
    assert.equal(isBoardMember(null), false);
  });

  it('returns false for partial name match (first name only)', () => {
    assert.equal(isBoardMember('Dustin'), false);
  });
});

describe('isBotUser', () => {
  it('returns true for "Jamie Bot"', () => {
    assert.equal(isBotUser('Jamie Bot'), true);
  });

  it('is case-insensitive', () => {
    assert.equal(isBotUser('jamie bot'), true);
  });

  it('returns false for board member', () => {
    assert.equal(isBotUser('Eric Gang'), false);
  });
});

// ---- handleLinearComment integration tests ----

describe('handleLinearComment', () => {
  beforeEach(() => {
    clearReplyDedupCache(); // Reset dedup state between tests to prevent cross-contamination
    mockGetIssue.mock.resetCalls();
    mockAddComment.mock.resetCalls();
    mockQuery.mock.resetCalls();
    noopCreateWorkItem.mock.resetCalls();
    // Reset implementations to safe defaults so tests don't bleed into each other
    mockGetIssue.mock.mockImplementation(async () => makeIssue());
    mockAddComment.mock.mockImplementation(async () => ({}));
    mockQuery.mock.mockImplementation(async () => ({ rows: [] }));
  });

  // --- Guard / deny-by-default paths (P1) ---

  describe('guard paths (P1: deny by default)', () => {
    it('skips non-create actions', async () => {
      const result = await handleLinearComment(
        { action: 'update', data: { body: '/retry', issueId: 'x', user: { name: 'Eric Gang' } } },
        noopCreateWorkItem
      );
      assert.equal(result.skipped, true);
      assert.match(result.reason, /only 'create' processed/);
    });

    it('skips when comment body is missing', async () => {
      const result = await handleLinearComment(
        { action: 'create', data: { id: 'c1', issueId: 'x', user: { name: 'Eric Gang' } } },
        noopCreateWorkItem
      );
      assert.equal(result.skipped, true);
      assert.match(result.reason, /Missing comment body or issueId/);
    });

    it('skips when issueId is missing', async () => {
      const result = await handleLinearComment(
        { action: 'create', data: { id: 'c1', body: '/retry', user: { name: 'Eric Gang' } } },
        noopCreateWorkItem
      );
      assert.equal(result.skipped, true);
      assert.match(result.reason, /Missing comment body or issueId/);
    });

    it('ignores bot self-replies', async () => {
      const result = await handleLinearComment(
        makeCommentPayload({ user: { id: 'bot-uuid', name: 'Jamie Bot' } }),
        noopCreateWorkItem
      );
      assert.equal(result.skipped, true);
      assert.match(result.reason, /Ignoring bot self-reply/);
    });

    it('ignores comments from non-board members', async () => {
      const result = await handleLinearComment(
        makeCommentPayload({ user: { id: 'random', name: 'Random Person' } }),
        noopCreateWorkItem
      );
      assert.equal(result.skipped, true);
      assert.match(result.reason, /not a board member/);
    });

    it('skips comments with no recognized command', async () => {
      const result = await handleLinearComment(
        makeCommentPayload({ body: 'Great work, agent!' }),
        noopCreateWorkItem
      );
      assert.equal(result.skipped, true);
      assert.match(result.reason, /No recognized command/);
    });

    it('skips when getIssue throws', async () => {
      mockGetIssue.mock.mockImplementation(async () => {
        throw new Error('API rate limited');
      });
      const result = await handleLinearComment(
        makeCommentPayload({ body: '/retry' }),
        noopCreateWorkItem
      );
      assert.equal(result.skipped, true);
      assert.match(result.reason, /Failed to fetch issue/);
      assert.match(result.reason, /API rate limited/);
    });

    it('skips when getIssue returns null', async () => {
      mockGetIssue.mock.mockImplementation(async () => null);
      const result = await handleLinearComment(
        makeCommentPayload({ body: '/retry' }),
        noopCreateWorkItem
      );
      assert.equal(result.skipped, true);
      assert.match(result.reason, /not found via API/);
    });
  });

  // --- /retry command ---

  describe('/retry command', () => {
    it('creates a new work item with board directive', async () => {
      mockGetIssue.mock.mockImplementation(async () => makeIssue());
      // First query: find existing work item (none)
      // Second query: insert action_proposal
      mockQuery.mock.mockImplementation(async (text) => {
        if (text.includes('work_items')) return { rows: [] };
        return { rows: [{ id: 'proposal-retry-001' }] };
      });
      mockAddComment.mock.mockImplementation(async () => ({}));

      const result = await handleLinearComment(
        makeCommentPayload({ body: '/retry use repo:optimus' }),
        noopCreateWorkItem
      );

      assert.equal(result.skipped, undefined);
      assert.equal(result.command, 'retry');
      assert.equal(result.triggeredBy, 'Eric Gang');
      assert.ok(result.workItemId);
    });

    it('passes board directive to work item metadata', async () => {
      mockGetIssue.mock.mockImplementation(async () => makeIssue());
      mockQuery.mock.mockImplementation(async (text) => {
        if (text.includes('work_items')) return { rows: [] };
        return { rows: [{ id: 'proposal-001' }] };
      });
      mockAddComment.mock.mockImplementation(async () => ({}));

      await handleLinearComment(
        makeCommentPayload({ body: '/retry use repo:optimus and fix tests' }),
        noopCreateWorkItem
      );

      const arg = noopCreateWorkItem.mock.calls[0].arguments[0];
      assert.equal(arg.metadata.command, 'retry');
      assert.equal(arg.metadata.triggered_by, 'Eric Gang');
      assert.equal(arg.metadata.source, 'linear-comment');
      assert.equal(arg.metadata.board_directive, 'use repo:optimus and fix tests');
    });

    it('inherits assigned_to from existing active work item', async () => {
      mockGetIssue.mock.mockImplementation(async () => makeIssue());
      mockQuery.mock.mockImplementation(async (text) => {
        if (text.includes('work_items')) {
          return {
            rows: [{
              id: 'wi-old',
              assigned_to: 'claw-workshop',
              metadata: { target_repo: 'staqsIO/optimus' },
            }],
          };
        }
        return { rows: [{ id: 'proposal-001' }] };
      });
      mockAddComment.mock.mockImplementation(async () => ({}));

      await handleLinearComment(
        makeCommentPayload({ body: '/retry' }),
        noopCreateWorkItem
      );

      const arg = noopCreateWorkItem.mock.calls[0].arguments[0];
      assert.equal(arg.assignedTo, 'claw-workshop');
      assert.equal(arg.metadata.target_repo, 'staqsIO/optimus');
    });

    it('defaults to executor-coder when no existing work item', async () => {
      mockGetIssue.mock.mockImplementation(async () => makeIssue());
      mockQuery.mock.mockImplementation(async (text) => {
        if (text.includes('work_items')) return { rows: [] };
        return { rows: [{ id: 'proposal-001' }] };
      });
      mockAddComment.mock.mockImplementation(async () => ({}));

      await handleLinearComment(
        makeCommentPayload({ body: '/retry' }),
        noopCreateWorkItem
      );

      const arg = noopCreateWorkItem.mock.calls[0].arguments[0];
      assert.equal(arg.assignedTo, 'executor-coder');
    });

    it('posts acknowledgment comment after creating work item', async () => {
      mockGetIssue.mock.mockImplementation(async () => makeIssue());
      mockQuery.mock.mockImplementation(async (text) => {
        if (text.includes('work_items')) return { rows: [] };
        return { rows: [{ id: 'proposal-001' }] };
      });
      mockAddComment.mock.mockImplementation(async () => ({}));

      await handleLinearComment(
        makeCommentPayload({ body: '/retry' }),
        noopCreateWorkItem
      );

      assert.equal(mockAddComment.mock.calls.length, 1);
      const [issueId, ackBody] = mockAddComment.mock.calls[0].arguments;
      assert.equal(issueId, 'issue-uuid-001');
      assert.match(ackBody, /Retry queued/);
    });

    it('still succeeds if acknowledgment comment fails', async () => {
      mockGetIssue.mock.mockImplementation(async () => makeIssue());
      mockQuery.mock.mockImplementation(async (text) => {
        if (text.includes('work_items')) return { rows: [] };
        return { rows: [{ id: 'proposal-001' }] };
      });
      mockAddComment.mock.mockImplementation(async () => {
        throw new Error('Linear API down');
      });

      const result = await handleLinearComment(
        makeCommentPayload({ body: '/retry' }),
        noopCreateWorkItem
      );

      // Should still succeed — acknowledgment failure is non-blocking
      assert.equal(result.skipped, undefined);
      assert.equal(result.command, 'retry');
    });
  });

  // --- /update command ---

  describe('/update command', () => {
    it('updates existing work item with board directive', async () => {
      mockGetIssue.mock.mockImplementation(async () => makeIssue());
      mockQuery.mock.mockImplementation(async (text) => {
        if (text.includes('SELECT')) {
          return {
            rows: [{ id: 'wi-active', description: 'Original desc', metadata: {} }],
          };
        }
        return { rows: [] }; // UPDATE
      });
      mockAddComment.mock.mockImplementation(async () => ({}));

      const result = await handleLinearComment(
        makeCommentPayload({ body: '/update change repo name to new-repo' }),
        noopCreateWorkItem
      );

      assert.equal(result.skipped, undefined);
      assert.equal(result.command, 'update');
      assert.equal(result.workItemId, 'wi-active');
      assert.equal(result.triggeredBy, 'Eric Gang');
    });

    it('posts acknowledgment after updating work item', async () => {
      mockGetIssue.mock.mockImplementation(async () => makeIssue());
      mockQuery.mock.mockImplementation(async (text) => {
        if (text.includes('SELECT')) {
          return {
            rows: [{ id: 'wi-active-001', description: 'desc', metadata: {} }],
          };
        }
        return { rows: [] };
      });
      mockAddComment.mock.mockImplementation(async () => ({}));

      await handleLinearComment(
        makeCommentPayload({ body: '/update do X instead' }),
        noopCreateWorkItem
      );

      assert.equal(mockAddComment.mock.calls.length, 1);
      const [issueId, ackBody] = mockAddComment.mock.calls[0].arguments;
      assert.equal(issueId, 'issue-uuid-001');
      assert.match(ackBody, /Context updated/);
    });

    it('skips /update when no active work item found', async () => {
      mockGetIssue.mock.mockImplementation(async () => makeIssue());
      mockQuery.mock.mockImplementation(async () => ({ rows: [] }));
      mockAddComment.mock.mockImplementation(async () => ({}));

      const result = await handleLinearComment(
        makeCommentPayload({ body: '/update fix the tests' }),
        noopCreateWorkItem
      );

      assert.equal(result.skipped, true);
      assert.match(result.reason, /No active work item/);
      // Should post a helpful comment suggesting /retry
      assert.equal(mockAddComment.mock.calls.length, 1);
      assert.match(mockAddComment.mock.calls[0].arguments[1], /\/retry/);
    });

    it('appends to board_directives array (P3: no overwrite)', async () => {
      mockGetIssue.mock.mockImplementation(async () => makeIssue());
      const existingDirective = { instructions: 'first directive', by: 'Eric Gang', comment_id: 'c0', at: '2026-03-20T00:00:00Z' };
      mockQuery.mock.mockImplementation(async (text) => {
        if (text.includes('SELECT')) {
          return {
            rows: [{ id: 'wi-active', description: 'desc', metadata: { board_directives: [existingDirective] } }],
          };
        }
        return { rows: [] }; // UPDATE
      });
      mockAddComment.mock.mockImplementation(async () => ({}));

      await handleLinearComment(
        makeCommentPayload({ body: '/update second directive' }),
        noopCreateWorkItem
      );

      // Verify the UPDATE query appends to the array
      // query(sql, [newDescription, metadataJson, workItemId])
      const updateCall = mockQuery.mock.calls.find(c => c.arguments[0].includes('UPDATE'));
      assert.ok(updateCall, 'Expected an UPDATE query');
      const metadataJson = JSON.parse(updateCall.arguments[1][1]);
      assert.equal(metadataJson.board_directives.length, 2);
      assert.equal(metadataJson.board_directives[0].instructions, 'first directive');
      assert.equal(metadataJson.board_directives[1].instructions, 'second directive');
    });

    it('skips /update without instructions (no args)', async () => {
      // /update with no text after it won't match the pattern — falls through to "no command"
      mockGetIssue.mock.mockImplementation(async () => makeIssue());

      const result = await handleLinearComment(
        makeCommentPayload({ body: '/update' }),
        noopCreateWorkItem
      );

      assert.equal(result.skipped, true);
      // Either "No recognized command" (regex doesn't match) or "/update requires instructions"
      assert.ok(result.reason);
    });
  });

  // --- @Jamie mention alias ---

  describe('@Jamie mention', () => {
    it('treats @Jamie mention as /reply', async () => {
      mockGetIssue.mock.mockImplementation(async () => makeIssue());
      // reply flow: SELECT work_items for parent context, then INSERT into campaigns
      mockQuery.mock.mockImplementation(async () => ({ rows: [] }));
      mockAddComment.mock.mockImplementation(async () => ({}));

      const result = await handleLinearComment(
        makeCommentPayload({ body: '@Jamie what is the status of this issue?' }),
        noopCreateWorkItem
      );

      assert.equal(result.skipped, undefined);
      assert.equal(result.command, 'reply');
      assert.equal(result.triggeredBy, 'Eric Gang');
      assert.ok(result.workItemId);
    });

    it('@Jamie Bot alias also routes to /reply', async () => {
      mockGetIssue.mock.mockImplementation(async () => makeIssue());
      mockQuery.mock.mockImplementation(async () => ({ rows: [] }));
      mockAddComment.mock.mockImplementation(async () => ({}));

      const result = await handleLinearComment(
        makeCommentPayload({ body: '@Jamie Bot can you summarize the problem?' }),
        noopCreateWorkItem
      );

      assert.equal(result.skipped, undefined);
      assert.equal(result.command, 'reply');
    });
  });
});
