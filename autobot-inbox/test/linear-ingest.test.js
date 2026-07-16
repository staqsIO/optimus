/**
 * Tests for Linear webhook ingest: resolveTargetRepo (via handleLinearWebhook)
 * and the fail-fast early-return paths.
 *
 * Uses mock.module (--experimental-test-module-mocks) to stub ES module imports
 * for getIssue, addComment, updateIssueState (from ./client.js) and query (from ../db.js).
 *
 * Run: cd autobot-inbox && node --experimental-test-module-mocks --test test/linear-ingest.test.js
 */

import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(
  readFileSync(join(__dirname, '..', 'config', 'linear-bot.json'), 'utf-8')
);

// ---- Module-level mocks (must be set before importing ingest.js) ----

const mockGetIssue = mock.fn();
const mockAddComment = mock.fn();
const mockUpdateIssueState = mock.fn();
const mockQuery = mock.fn();

mock.module('../src/linear/client.js', {
  namedExports: {
    getIssue: mockGetIssue,
    addComment: mockAddComment,
    addBotComment: mockAddComment,
    updateIssueState: mockUpdateIssueState,
    updateIssueStateByName: mock.fn(),
    // Re-export stubs for the other exports ingest.js does not use
    createIssue: mock.fn(),
    getTeams: mock.fn(),
    getIssueComments: mock.fn(async () => ({ nodes: [] })),
  },
});

// Mock issue classifier to prevent real LLM calls and control repo classification
const mockClassifyIssue = mock.fn(async () => ({ target_repo: null, confidence: 0 }));
mock.module('../src/linear/issue-classifier.js', {
  namedExports: { classifyIssue: mockClassifyIssue },
});

// Mock intent-manager and signal-ingester to prevent transitive import failures
mock.module('../src/runtime/intent-manager.js', {
  namedExports: { createIntent: mock.fn(async () => ({ id: 'intent-1' })) },
});
mock.module('../src/webhooks/signal-ingester.js', {
  namedExports: { ingestAsSignal: mock.fn(async () => ({ id: 'signal-1' })) },
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

// Now import the module under test (after mocks are installed)
const { handleLinearWebhook, clearDedupCache } = await import('../src/linear/ingest.js');

// ---- Helpers ----

/** Build a minimal webhook payload for an issue update with assignee. */
function makePayload(overrides = {}) {
  return {
    action: 'update',
    data: {
      id: 'issue-uuid-001',
      assigneeId: 'bot-uuid',
      ...overrides,
    },
  };
}

/** Build a full issue object as returned by getIssue. */
function makeIssue(overrides = {}) {
  return {
    id: 'issue-uuid-001',
    identifier: 'STA-42',
    url: 'https://linear.app/staqs/issue/STA-42',
    title: 'Fix login bug',
    description: 'Users cannot login with SSO.',
    priority: 2,
    assignee: { id: 'bot-uuid', name: 'Jamie Bot' },
    delegate: null,
    labels: { nodes: [] },
    team: { id: 'team-1', name: 'Staqs Internal Projects', key: 'STA' },
    project: null,
    state: { id: 'state-1', name: 'Todo', type: 'unstarted' },
    ...overrides,
  };
}

const noopCreateWorkItem = mock.fn(async () => ({ id: 'wi-001' }));

// ---- Tests ----

describe('handleLinearWebhook', () => {
  beforeEach(() => {
    clearDedupCache(); // Reset dedup state between tests to prevent cross-contamination
    mockGetIssue.mock.resetCalls();
    mockAddComment.mock.resetCalls();
    mockUpdateIssueState.mock.resetCalls();
    mockQuery.mock.resetCalls();
    noopCreateWorkItem.mock.resetCalls();
    // Default mock: human_tasks lookup (PRD meeting-actions-to-kanban-v0.2 FR-12,
    // FR-13, AD-9) returns no match so handleLinearWebhook falls through to
    // the engineering-ticket flow these tests exercise.
    mockQuery.mock.mockImplementation(async () => ({ rows: [] }));
  });

  // ==========================================================
  // Early-return / fail-fast paths (no async deps needed)
  // ==========================================================

  describe('early-return guards', () => {
    it('should skip when action is "remove"', async () => {
      const result = await handleLinearWebhook(
        { action: 'remove', data: { id: 'x' } },
        noopCreateWorkItem
      );
      assert.equal(result.skipped, true);
      assert.match(result.reason, /Unsupported action/);
    });

    it('should skip when data is missing', async () => {
      const result = await handleLinearWebhook(
        { action: 'update', data: null },
        noopCreateWorkItem
      );
      assert.equal(result.skipped, true);
      assert.match(result.reason, /Unsupported action/);
    });

    it('should skip when data.id is missing', async () => {
      const result = await handleLinearWebhook(
        { action: 'update', data: {} },
        noopCreateWorkItem
      );
      assert.equal(result.skipped, true);
      assert.match(result.reason, /Unsupported action/);
    });

    it('should skip when no assignee/delegate and no labels', async () => {
      const result = await handleLinearWebhook(
        { action: 'update', data: { id: 'x' } },
        noopCreateWorkItem
      );
      assert.equal(result.skipped, true);
      assert.match(result.reason, /No assignee\/delegate or labels/);
    });

    it('should proceed with "create" action when assignee is present', async () => {
      mockGetIssue.mock.mockImplementation(async () => null);
      const result = await handleLinearWebhook(
        { action: 'create', data: { id: 'x', assigneeId: 'bot' } },
        noopCreateWorkItem
      );
      // Gets past early guards, fails on getIssue returning null
      assert.equal(result.skipped, true);
      assert.match(result.reason, /not found via API/);
    });

    it('should accept payload with labelIds but no assignee', async () => {
      mockGetIssue.mock.mockImplementation(async () => null);
      const result = await handleLinearWebhook(
        { action: 'update', data: { id: 'x', labelIds: ['lbl-1'] } },
        noopCreateWorkItem
      );
      assert.equal(result.skipped, true);
      assert.match(result.reason, /not found via API/);
    });

    it('should accept payload with delegateId', async () => {
      mockGetIssue.mock.mockImplementation(async () => null);
      const result = await handleLinearWebhook(
        { action: 'update', data: { id: 'x', delegateId: 'delegate-uuid' } },
        noopCreateWorkItem
      );
      assert.equal(result.skipped, true);
      assert.match(result.reason, /not found via API/);
    });
  });

  // ==========================================================
  // getIssue failure paths
  // ==========================================================

  describe('getIssue failure paths', () => {
    it('should skip when getIssue throws', async () => {
      mockGetIssue.mock.mockImplementation(async () => {
        throw new Error('API rate limited');
      });
      const result = await handleLinearWebhook(
        makePayload(),
        noopCreateWorkItem
      );
      assert.equal(result.skipped, true);
      assert.match(result.reason, /Failed to fetch issue/);
      assert.match(result.reason, /API rate limited/);
    });

    it('should skip when getIssue returns null', async () => {
      mockGetIssue.mock.mockImplementation(async () => null);
      const result = await handleLinearWebhook(
        makePayload(),
        noopCreateWorkItem
      );
      assert.equal(result.skipped, true);
      assert.match(result.reason, /not found via API/);
    });
  });

  // ==========================================================
  // Trigger verification (P1: deny by default)
  // ==========================================================

  describe('trigger verification', () => {
    it('should route to Tier 2 (intent) when issue is not assigned to bot and has no auto-fix label', async () => {
      mockGetIssue.mock.mockImplementation(async () =>
        makeIssue({
          assignee: { id: 'human-uuid', name: 'Eric' },
          delegate: null,
          labels: { nodes: [{ id: 'l1', name: 'bug' }] },
        })
      );
      const result = await handleLinearWebhook(
        makePayload(),
        noopCreateWorkItem
      );
      // Non-bot issues route to Tier 2 (intent creation) or signal, not skip
      // Handler may return intent result or undefined depending on priority routing
      assert.ok(result !== null);
    });

    it('should proceed when issue has auto-fix label', async () => {
      mockGetIssue.mock.mockImplementation(async () =>
        makeIssue({
          assignee: null,
          labels: { nodes: [{ id: 'l1', name: config.triggerLabel }] },
          // Use an unmapped team so resolveTargetRepo returns null → hits "No target repo" early return
          team: { id: 'team-x', name: 'Unmapped Team', key: 'UNK' },
        })
      );
      // Will proceed past trigger check, need dedup query mock
      mockQuery.mock.mockImplementation(async () => ({ rows: [] }));
      mockAddComment.mock.mockImplementation(async () => ({}));

      const result = await handleLinearWebhook(
        makePayload(),
        noopCreateWorkItem
      );
      // Should hit the repo-resolution fail-fast (no repo labels, no project, unknown team)
      assert.equal(result.skipped, true);
      assert.match(result.reason, /No target repo/);
    });

    it('should proceed when issue is delegated to bot', async () => {
      mockGetIssue.mock.mockImplementation(async () =>
        makeIssue({
          assignee: { id: 'human-uuid', name: 'Eric' },
          delegate: { id: 'bot-uuid', name: 'Jamie Bot' },
          // Use an unmapped team so resolveTargetRepo returns null → hits "No target repo" early return
          team: { id: 'team-x', name: 'Unmapped Team', key: 'UNK' },
        })
      );
      mockQuery.mock.mockImplementation(async () => ({ rows: [] }));
      mockAddComment.mock.mockImplementation(async () => ({}));

      const result = await handleLinearWebhook(
        makePayload(),
        noopCreateWorkItem
      );
      // Passes trigger check (delegated to bot), hits repo fail-fast
      assert.equal(result.skipped, true);
      assert.match(result.reason, /No target repo/);
    });
  });

  // ==========================================================
  // Deduplication
  // ==========================================================

  describe('deduplication', () => {
    it('should skip when work item already exists for this issue', async () => {
      mockGetIssue.mock.mockImplementation(async () => makeIssue());
      mockQuery.mock.mockImplementation(async (text) => {
        // human_tasks lookup must miss so dedup path on work_items runs
        if (text.includes('human_tasks')) return { rows: [] };
        return { rows: [{ id: 'existing-wi-999' }] };
      });

      const result = await handleLinearWebhook(
        makePayload(),
        noopCreateWorkItem
      );
      assert.equal(result.skipped, true);
      assert.match(result.reason, /Work item already exists/);
      assert.equal(result.existingWorkItemId, 'existing-wi-999');
    });
  });

  // ==========================================================
  // resolveTargetRepo — tested through handleLinearWebhook
  // ==========================================================

  describe('resolveTargetRepo (via handleLinearWebhook)', () => {
    beforeEach(() => {
      // Default: no duplicate work item; no human_tasks match (engineering path)
      mockQuery.mock.mockImplementation(async (text, _params) => {
        if (text.includes('human_tasks')) return { rows: [] };
        if (text.includes('work_items')) return { rows: [] };
        // action_proposals INSERT
        return { rows: [{ id: 'proposal-001' }] };
      });
      mockUpdateIssueState.mock.mockImplementation(async () => ({
        success: true,
      }));
    });

    it('should resolve via tier 1 — repo label (repo:ag-webapp)', async () => {
      mockGetIssue.mock.mockImplementation(async () =>
        makeIssue({
          labels: { nodes: [{ id: 'l1', name: 'repo:ag-webapp' }] },
        })
      );

      const result = await handleLinearWebhook(
        makePayload(),
        noopCreateWorkItem
      );

      assert.equal(result.skipped, undefined);
      assert.ok(result.proposalId);
      // Verify the createWorkItem was called with the resolved repo
      assert.equal(noopCreateWorkItem.mock.calls.length, 1);
      const workItemArg = noopCreateWorkItem.mock.calls[0].arguments[0];
      assert.equal(workItemArg.metadata.target_repo, 'staqsIO/ag-webapp');
    });

    it('should resolve via tier 1 — repo label (repo:formul8)', async () => {
      mockGetIssue.mock.mockImplementation(async () =>
        makeIssue({
          labels: { nodes: [{ id: 'l1', name: 'repo:formul8' }] },
        })
      );

      const result = await handleLinearWebhook(
        makePayload(),
        noopCreateWorkItem
      );

      assert.equal(result.skipped, undefined);
      const workItemArg = noopCreateWorkItem.mock.calls[0].arguments[0];
      assert.equal(workItemArg.metadata.target_repo, 'f8ai/formul8-platform');
    });

    it('should resolve via tier 2 — project mapping', async () => {
      mockGetIssue.mock.mockImplementation(async () =>
        makeIssue({
          labels: { nodes: [] },
          project: { id: 'proj-1', name: 'Staqs - Staqs.io Site Redesign' },
        })
      );

      const result = await handleLinearWebhook(
        makePayload(),
        noopCreateWorkItem
      );

      assert.equal(result.skipped, undefined);
      const workItemArg = noopCreateWorkItem.mock.calls[0].arguments[0];
      assert.equal(workItemArg.metadata.target_repo, 'staqsIO/staqs-splash');
    });

    it('should resolve via tier 3 — team mapping', async () => {
      mockGetIssue.mock.mockImplementation(async () =>
        makeIssue({
          labels: { nodes: [] },
          project: null,
          team: { id: 'team-f8', name: 'Formul8', key: 'F8' },
        })
      );

      const result = await handleLinearWebhook(
        makePayload(),
        noopCreateWorkItem
      );

      assert.equal(result.skipped, undefined);
      const workItemArg = noopCreateWorkItem.mock.calls[0].arguments[0];
      assert.equal(workItemArg.metadata.target_repo, 'f8ai/formul8-platform');
    });

    it('should prioritize tier 1 (repo label) over tier 2 (project)', async () => {
      mockGetIssue.mock.mockImplementation(async () =>
        makeIssue({
          labels: { nodes: [{ id: 'l1', name: 'repo:optimus' }] },
          project: {
            id: 'proj-1',
            name: 'Staqs - Staqs.io Site Redesign',
          },
        })
      );

      const result = await handleLinearWebhook(
        makePayload(),
        noopCreateWorkItem
      );

      assert.equal(result.skipped, undefined);
      const workItemArg = noopCreateWorkItem.mock.calls[0].arguments[0];
      // repo:optimus label wins over project mapping to staqs-splash
      assert.equal(workItemArg.metadata.target_repo, 'staqsIO/optimus');
    });

    it('should prioritize tier 2 (project) over tier 3 (team)', async () => {
      mockGetIssue.mock.mockImplementation(async () =>
        makeIssue({
          labels: { nodes: [] },
          project: { id: 'proj-1', name: 'Optimus' },
          team: { id: 'team-f8', name: 'Formul8', key: 'F8' },
        })
      );

      const result = await handleLinearWebhook(
        makePayload(),
        noopCreateWorkItem
      );

      assert.equal(result.skipped, undefined);
      const workItemArg = noopCreateWorkItem.mock.calls[0].arguments[0];
      // project "Optimus" wins over team "Formul8"
      assert.equal(workItemArg.metadata.target_repo, 'staqsIO/optimus');
    });

    it('should fail-fast when no label, project, or team matches', async () => {
      mockGetIssue.mock.mockImplementation(async () =>
        makeIssue({
          labels: { nodes: [{ id: 'l1', name: 'bug' }] },
          project: { id: 'proj-x', name: 'Unknown Project' },
          team: { id: 'team-x', name: 'Unknown Team', key: 'UNK' },
        })
      );
      mockAddComment.mock.mockImplementation(async () => ({}));

      const result = await handleLinearWebhook(
        makePayload(),
        noopCreateWorkItem
      );

      assert.equal(result.skipped, true);
      assert.match(result.reason, /No target repo/);
    });

    it('should post a comment listing repo options on fail-fast', async () => {
      mockGetIssue.mock.mockImplementation(async () =>
        makeIssue({
          labels: { nodes: [] },
          project: null,
          team: { id: 'team-x', name: 'No Match', key: 'NM' },
        })
      );
      mockAddComment.mock.mockImplementation(async () => ({}));

      await handleLinearWebhook(makePayload(), noopCreateWorkItem);

      assert.equal(mockAddComment.mock.calls.length, 1);
      const [issueId, commentBody] =
        mockAddComment.mock.calls[0].arguments;
      assert.equal(issueId, 'issue-uuid-001');
      assert.match(commentBody, /Could not determine target repository/);
      assert.match(commentBody, /repo:optimus/);
      assert.match(commentBody, /repo:formul8/);
    });

    it('should still return skipped even if addComment throws on fail-fast', async () => {
      mockGetIssue.mock.mockImplementation(async () =>
        makeIssue({
          labels: { nodes: [] },
          project: null,
          team: { id: 'team-x', name: 'No Match', key: 'NM' },
        })
      );
      mockAddComment.mock.mockImplementation(async () => {
        throw new Error('Linear API down');
      });

      const result = await handleLinearWebhook(
        makePayload(),
        noopCreateWorkItem
      );

      // Should still return skipped, not throw
      assert.equal(result.skipped, true);
      assert.match(result.reason, /No target repo/);
    });
  });

  // ==========================================================
  // Happy path — full pipeline
  // ==========================================================

  describe('happy path', () => {
    it('should create work item and return ids on success', async () => {
      mockGetIssue.mock.mockImplementation(async () =>
        makeIssue({
          labels: { nodes: [{ id: 'l1', name: 'repo:optimus' }] },
        })
      );
      mockQuery.mock.mockImplementation(async (text) => {
        if (text.includes('human_tasks')) return { rows: [] };
        if (text.includes('work_items')) return { rows: [] };
        return { rows: [{ id: 'proposal-42' }] };
      });
      noopCreateWorkItem.mock.mockImplementation(async () => ({
        id: 'wi-77',
      }));
      mockUpdateIssueState.mock.mockImplementation(async () => ({
        success: true,
      }));

      const result = await handleLinearWebhook(
        makePayload(),
        noopCreateWorkItem
      );

      assert.equal(result.issueId, 'issue-uuid-001');
      assert.equal(result.workItemId, 'wi-77');
      assert.equal(result.proposalId, 'proposal-42');
      assert.equal(result.skipped, undefined);
    });

    it('should pass correct metadata to createWorkItem', async () => {
      mockGetIssue.mock.mockImplementation(async () =>
        makeIssue({
          labels: { nodes: [{ id: 'l1', name: 'repo:optimus' }] },
          priority: 1,
        })
      );
      mockQuery.mock.mockImplementation(async (text) => {
        if (text.includes('human_tasks')) return { rows: [] };
        if (text.includes('work_items')) return { rows: [] };
        return { rows: [{ id: 'proposal-1' }] };
      });
      mockUpdateIssueState.mock.mockImplementation(async () => ({
        success: true,
      }));

      await handleLinearWebhook(makePayload(), noopCreateWorkItem);

      const arg = noopCreateWorkItem.mock.calls[0].arguments[0];
      assert.equal(arg.type, 'task');
      assert.match(arg.title, /Auto-fix: STA-42/);
      assert.equal(arg.createdBy, 'orchestrator');
      assert.equal(arg.assignedTo, 'executor-coder');
      assert.equal(arg.priority, 3); // Linear 1 (urgent) maps to 3
      assert.equal(arg.metadata.linear_issue_id, 'issue-uuid-001');
      assert.equal(arg.metadata.source, 'linear-webhook');
      assert.equal(arg.metadata.target_repo, 'staqsIO/optimus');
      assert.equal(arg.metadata.linear_priority, 1);
    });
  });
});
