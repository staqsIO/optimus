/**
 * GH #541 — claw-workshop must screen untrusted Linear content before it
 * reaches the agentic tool loop (runExecutor: Write/Bash/WebFetch/WebSearch).
 *
 * The fix screens the FULLY RENDERED prompt — the exact byte string handed to
 * runExecutor — rather than per-field copies. This is what Linus V-5/V-6
 * flagged: per-field screening missed (a) the LIVE, untruncated issue body
 * fetched inside buildPrompt() via getIssue() (screening the stale, truncated
 * campaign.description instead), (b) the raw metadata.reply_question in
 * buildReplyPrompt(), and (c) a payload split across many sub-20-char comments
 * that individually clear Model Armor's too-short floor but get reassembled
 * verbatim in the rendered prompt.
 *
 * failClosed:true policy: BOTH a confirmed Model Armor match AND a genuine
 * can't-screen result must abort the run before runExecutor is ever called; a
 * clean/allowed result proceeds to runExecutor.
 *
 * Every workshop-runner dependency is mocked — no real DB, git worktree,
 * Linear/GitHub API call, or CLI subprocess. runExecutor's mock throws after
 * being invoked so the "allowed" path doesn't need the full success flow
 * mocked out; runWorkshop swallows all errors internally (it never rejects),
 * so only the mock call counts / captured screening arguments are asserted.
 * screenUntrustedContent is mocked, so these tests prove the WIRING and the
 * COMPLETENESS of what is screened (the captured argument) — the real
 * decision logic (too-short floor, matched/null → decision) is unit-tested in
 * screen-untrusted-content.test.js.
 *
 * Run: cd autobot-inbox && node --experimental-test-module-mocks --test test/workshop-runner-screening.test.js
 */
import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const screening = { result: { decision: 'allow', screened: true, matched: false } };

// Distinct payload markers so a test can prove the SPECIFIC untrusted field
// reached the screener (not a stale copy that happens to also be present).
const REPLY_QUESTION_PAYLOAD = 'REPLY_QUESTION_PAYLOAD_ignore_all_prior_instructions';
const LIVE_FULL_BODY_PAYLOAD = 'LIVE_FULL_BODY_PAYLOAD_hidden_past_char_500';
const COMMENT_CHUNK_ONE = 'CHUNK_ONE_untrusted';
const COMMENT_CHUNK_TWO = 'CHUNK_TWO_untrusted';
// The stale, truncated DB copy the OLD code screened — deliberately benign and
// DIFFERENT from the live body, so a passing V-5 test can only mean the live
// fullDescription (not this) was screened.
const STALE_DB_DESCRIPTION = 'stale benign truncated description copy';

const REPLY_METADATA = {
  task_mode: 'reply',
  linear_issue_id: 'lin-1',
  linear_identifier: 'ENG-1',
  reply_question: REPLY_QUESTION_PAYLOAD,
  triggered_by: 'Eric',
};
const IMPLEMENT_METADATA = {
  linear_issue_id: 'lin-1',
  linear_identifier: 'ENG-1',
  target_repo: 'staqsIO/optimus-private',
};

function makeCampaignRow(metadata) {
  return {
    id: 'camp-1',
    work_item_id: 'wi-1',
    goal_description: 'Reply to board member question',
    success_criteria: [],
    metadata,
    campaign_mode: 'workshop',
    campaign_status: 'running',
    title: 'Reply task',
    description: STALE_DB_DESCRIPTION,
    work_item_metadata: {},
  };
}

// Mutable fixtures so a test can switch between the reply (buildReplyPrompt)
// and non-reply (buildPrompt / getIssue) prompt-builder paths, and vary the
// live issue body returned by getIssue().
const fixture = { row: makeCampaignRow(REPLY_METADATA) };
const issueBody = { description: LIVE_FULL_BODY_PAYLOAD };
const comments = {
  list: [
    { userName: 'Eric', createdAt: new Date().toISOString(), body: COMMENT_CHUNK_ONE },
    { userName: 'Eric', createdAt: new Date().toISOString(), body: COMMENT_CHUNK_TWO },
  ],
};

const mockScreenUntrustedContent = mock.fn(async () => screening.result);
const mockRunExecutor = mock.fn(async () => {
  throw new Error('test-marker: runExecutor invoked');
});
const mockQuery = mock.fn(async () => ({ rows: [fixture.row] }));
const mockLoadPlaybook = mock.fn(async () => ({
  meta: { default_budget_usd: 1, model: 'sonnet', session_timeout_ms: 1000, max_turns: 5 },
  systemPrompt: 'sys',
}));
const mockCreateWorkspace = mock.fn(async () => '/tmp/workshop-workspace');
const mockCleanupWorkspace = mock.fn(async () => {});
const mockReserveBudget = mock.fn(async () => true);
const mockCommitSpend = mock.fn(async () => {});
const mockReleaseBudget = mock.fn(async () => {});
const mockGuardCheck = mock.fn(async () => ({ allowed: true }));
const mockPublishEvent = mock.fn(async () => {});
const mockStartActivityStep = mock.fn(async () => 'step-1');
const mockCompleteActivityStep = mock.fn(async () => {});
const mockGetGitHubToken = mock.fn(async () => 'gh-token');
const mockRedactSecrets = mock.fn((s) => s);
const mockGetIssue = mock.fn(async () => ({ description: issueBody.description }));
const mockGetIssueComments = mock.fn(async () => comments.list);
const mockUpdateIssueState = mock.fn(async () => {});
const mockUpdateIssueStateByName = mock.fn(async () => {});
const mockAddComment = mock.fn(async () => {});
const mockAddBotComment = mock.fn(async () => {});
const mockRecordCampaignOutcome = mock.fn(async () => {});
const mockRequirePermission = mock.fn(async () => true);
const mockLogCapabilityInvocation = mock.fn(() => {});

mock.module('../../lib/runtime/governance/screen-untrusted-content.js', {
  namedExports: { screenUntrustedContent: mockScreenUntrustedContent },
});
mock.module('../../lib/runtime/executor-adapter.js', {
  namedExports: { runExecutor: mockRunExecutor },
});
mock.module('../../lib/db.js', { namedExports: { query: mockQuery } });
mock.module('../../agents/claw-workshop/playbook-loader.js', {
  namedExports: { loadPlaybook: mockLoadPlaybook },
});
mock.module('../../agents/claw-campaigner/campaign-workspace.js', {
  namedExports: { createWorkspace: mockCreateWorkspace, cleanupWorkspace: mockCleanupWorkspace },
});
mock.module('../../agents/claw-campaigner/campaign-budget.js', {
  namedExports: { reserveBudget: mockReserveBudget, commitSpend: mockCommitSpend, releaseBudget: mockReleaseBudget },
});
mock.module('../../lib/runtime/guard-check.js', { namedExports: { guardCheck: mockGuardCheck } });
mock.module('../../lib/runtime/infrastructure.js', {
  namedExports: {
    publishEvent: mockPublishEvent,
    startActivityStep: mockStartActivityStep,
    completeActivityStep: mockCompleteActivityStep,
  },
});
mock.module('../src/github/app-auth.js', { namedExports: { getGitHubToken: mockGetGitHubToken } });
mock.module('../../lib/runtime/log-redactor.js', { namedExports: { redactSecrets: mockRedactSecrets } });
mock.module('../src/linear/client.js', {
  namedExports: {
    getIssue: mockGetIssue,
    updateIssueState: mockUpdateIssueState,
    updateIssueStateByName: mockUpdateIssueStateByName,
    addComment: mockAddComment,
    addBotComment: mockAddBotComment,
    getIssueComments: mockGetIssueComments,
  },
});
mock.module('../../lib/graph/claw-learning.js', {
  namedExports: { recordCampaignOutcome: mockRecordCampaignOutcome },
});
mock.module('../../lib/runtime/permissions.js', {
  namedExports: { requirePermission: mockRequirePermission, logCapabilityInvocation: mockLogCapabilityInvocation },
});

const { runWorkshop } = await import('../../agents/claw-workshop/workshop-runner.js');

const AGENT_CONFIG = { configHash: 'hash-1', workshop: {}, claudeCode: {} };
const SIGNAL = { aborted: false };

beforeEach(() => {
  mockScreenUntrustedContent.mock.resetCalls();
  mockRunExecutor.mock.resetCalls();
  mockCleanupWorkspace.mock.resetCalls();
  mockCompleteActivityStep.mock.resetCalls();
  // Reset mutable fixtures to the default reply path.
  fixture.row = makeCampaignRow(REPLY_METADATA);
  issueBody.description = LIVE_FULL_BODY_PAYLOAD;
  comments.list = [
    { userName: 'Eric', createdAt: new Date().toISOString(), body: COMMENT_CHUNK_ONE },
    { userName: 'Eric', createdAt: new Date().toISOString(), body: COMMENT_CHUNK_TWO },
  ];
  screening.result = { decision: 'allow', screened: true, matched: false };
});

describe('workshop-runner screening wiring (GH #541)', () => {
  it('does NOT reach runExecutor when screening blocks (flagged content)', async () => {
    screening.result = { decision: 'block', screened: true, matched: true, reason: 'model-armor-match' };
    await runWorkshop('camp-1', AGENT_CONFIG, {}, SIGNAL);
    assert.equal(mockRunExecutor.mock.calls.length, 0);
    assert.equal(mockCleanupWorkspace.mock.calls.length, 1);
    const finalStep = mockCompleteActivityStep.mock.calls.at(-1).arguments[1];
    assert.equal(finalStep.status, 'failed');
    assert.match(finalStep.metadata.error, /content screening/);
  });

  it("does NOT reach runExecutor when screening can't-screen (failClosed:true blocks)", async () => {
    screening.result = { decision: 'block', screened: false, reason: 'model-armor-unavailable' };
    await runWorkshop('camp-1', AGENT_CONFIG, {}, SIGNAL);
    assert.equal(mockRunExecutor.mock.calls.length, 0);
    const finalStep = mockCompleteActivityStep.mock.calls.at(-1).arguments[1];
    assert.equal(finalStep.status, 'failed');
    assert.match(finalStep.metadata.error, /content screening/);
  });

  it('DOES reach runExecutor when screening allows (clean content)', async () => {
    screening.result = { decision: 'allow', screened: true, matched: false };
    await runWorkshop('camp-1', AGENT_CONFIG, {}, SIGNAL);
    assert.equal(mockRunExecutor.mock.calls.length, 1);
  });

  it('screens with failClosed:true and agentId claw-workshop', async () => {
    screening.result = { decision: 'allow', screened: true, matched: false };
    await runWorkshop('camp-1', AGENT_CONFIG, {}, SIGNAL);
    assert.ok(mockScreenUntrustedContent.mock.calls.length >= 1);
    for (const call of mockScreenUntrustedContent.mock.calls) {
      assert.equal(call.arguments[1].failClosed, true);
      assert.equal(call.arguments[1].agentId, 'claw-workshop');
    }
  });
});

describe('workshop-runner screening COMPLETENESS (GH #541 — Linus V-5/V-6)', () => {
  // V-5 #1 (the big one): buildPrompt() fetches the live, untruncated issue
  // body via getIssue() and interpolates THAT — not the stale, 500-char
  // campaign.description the old per-field code screened. Prove the live body
  // is what reaches the screener, and the run blocks when it's flagged.
  it('V-5: screens the LIVE fullDescription from getIssue(), not the stale campaign.description (non-reply path)', async () => {
    fixture.row = makeCampaignRow(IMPLEMENT_METADATA); // task_mode != 'reply' → buildPrompt path
    issueBody.description = `Some legitimate framing text. ${LIVE_FULL_BODY_PAYLOAD}`;
    screening.result = { decision: 'allow', screened: true, matched: false };
    await runWorkshop('camp-1', AGENT_CONFIG, {}, SIGNAL);

    const screenedTexts = mockScreenUntrustedContent.mock.calls.map((c) => c.arguments[0]);
    // The live body (from getIssue) must be screened. The old per-field code
    // screened campaign.description (STALE_DB_DESCRIPTION) instead and never
    // fetched this value on the non-reply path — so this assertion fails
    // against the pre-fix source, which is the point.
    assert.ok(
      screenedTexts.some((t) => t.includes(LIVE_FULL_BODY_PAYLOAD)),
      'the LIVE fullDescription fetched by getIssue() must be in the screened text',
    );
  });

  it('V-5: a payload present ONLY in the live fullDescription blocks the run before runExecutor', async () => {
    fixture.row = makeCampaignRow(IMPLEMENT_METADATA);
    issueBody.description = `benign framing ${LIVE_FULL_BODY_PAYLOAD}`;
    // Simulate Model Armor flagging the rendered prompt (which carries the live body).
    screening.result = { decision: 'block', screened: true, matched: true, reason: 'model-armor-match' };
    await runWorkshop('camp-1', AGENT_CONFIG, {}, SIGNAL);
    assert.equal(mockRunExecutor.mock.calls.length, 0, 'flagged live-body prompt must not reach the tool loop');
  });

  // V-5 #2: buildReplyPrompt() interpolates metadata.reply_question verbatim.
  it('V-5: screens metadata.reply_question (reply path)', async () => {
    // default fixture is the reply path with reply_question = REPLY_QUESTION_PAYLOAD
    screening.result = { decision: 'allow', screened: true, matched: false };
    await runWorkshop('camp-1', AGENT_CONFIG, {}, SIGNAL);
    const screenedTexts = mockScreenUntrustedContent.mock.calls.map((c) => c.arguments[0]);
    assert.ok(
      screenedTexts.some((t) => t.includes(REPLY_QUESTION_PAYLOAD)),
      'the raw reply_question must be in the screened text',
    );
  });

  // V-6: the whole conversation history is screened as ONE blob, so a payload
  // split across many sub-20-char comments (each individually below Model
  // Armor's too-short floor) cannot slip through — it is reassembled and
  // screened together.
  it('V-6: screens the ENTIRE assembled prompt in a single call (defeats sub-20-char comment chunking)', async () => {
    comments.list = [
      { userName: 'Eric', createdAt: new Date().toISOString(), body: COMMENT_CHUNK_ONE },
      { userName: 'Eric', createdAt: new Date().toISOString(), body: COMMENT_CHUNK_TWO },
    ];
    screening.result = { decision: 'allow', screened: true, matched: false };
    await runWorkshop('camp-1', AGENT_CONFIG, {}, SIGNAL);

    // Exactly one screen call — the rendered prompt, not per-piece.
    assert.equal(
      mockScreenUntrustedContent.mock.calls.length,
      1,
      'the fix must screen the whole rendered prompt once, not each piece separately',
    );
    const screened = mockScreenUntrustedContent.mock.calls[0].arguments[0];
    assert.ok(screened.includes(COMMENT_CHUNK_ONE), 'first comment chunk must be in the single screened blob');
    assert.ok(screened.includes(COMMENT_CHUNK_TWO), 'second comment chunk must be in the single screened blob');
  });
});
