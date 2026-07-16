/**
 * RED step (TDD) — lib/linear/issue-payload.js does not exist yet.
 *
 * Tests the pure payload builder that turns a human_tasks row + the cached
 * Linear team metadata + the current push guardrail + an LLM response into
 * a validated Linear issue payload.
 *
 * Contract (PRD §1 FR-5..FR-11, PRD §4 "What the LLM decides"):
 *
 *   - `buildIssuePayload({ task, teamCache, guardrail, llmResponse })` is a
 *     pure function — no I/O, no input mutation.
 *   - If `llmResponse.skip_reason` is a non-empty string, the builder
 *     short-circuits and returns `{ skip_reason }` without validation.
 *   - Otherwise every id in the LLM response is validated against the
 *     team cache. Bad ids drop to guardrail mapping defaults (where
 *     defined) or null. `stateId` is REQUIRED — falls back to
 *     `guardrail.mapping.defaultStateId`; if still absent, throws.
 *   - The `optimus` label id (looked up by name in `teamCache.labels`)
 *     is always included; missing in cache is logged-and-omitted, not
 *     a throw.
 *   - Title defaults to `task.title`, capped at 80 chars with a "…"
 *     suffix.
 *   - Description ALWAYS receives the footer `Pushed under guardrail
 *     v<revision>` exactly once. A `Source: …` line is appended when
 *     `task.message_id` is set.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildIssuePayload } from '../../lib/linear/issue-payload.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTeamCache(overrides = {}) {
  return {
    workflow_states: [
      { id: 's-bl', name: 'Backlog', type: 'backlog' },
      { id: 's-td', name: 'Todo', type: 'unstarted' },
      { id: 's-ip', name: 'In Progress', type: 'started' },
      { id: 's-dn', name: 'Done', type: 'completed' },
    ],
    projects: [
      { id: 'p-staqspro', name: 'StaqsPro', state: 'started' },
      { id: 'p-formul8', name: 'Formul8', state: 'started' },
      { id: 'p-archived', name: 'OldThing', state: 'completed' },
    ],
    members: [
      { id: 'u-eric', name: 'Eric', email: 'eric@staqs.io' },
      { id: 'u-isaias', name: 'Isaias', email: 'isaias@staqs.io' },
      { id: 'u-dustin', name: 'Dustin', email: 'dustin@staqs.io' },
    ],
    labels: [
      { id: 'l-optimus', name: 'optimus', color: '#000' },
      { id: 'l-vendor', name: 'vendor', color: '#f00' },
      { id: 'l-urgent', name: 'urgent', color: '#f60' },
    ],
    ...overrides,
  };
}

function makeTask(overrides = {}) {
  return {
    id: 'task-1',
    title: 'Send vendor follow-up email',
    description: null,
    source_quote: 'Eric to draft the vendor follow-up',
    source_ts: '00:14:22',
    signal_id: 'signal-1',
    message_id: 'msg-meeting-42',
    project_id: 'p-staqspro',
    engagement_id: null,
    assignee_contact_id: 'c-eric',
    assignee_label: 'Eric',
    priority: 3,
    size: 'small',
    due_date: null,
    next_action_hint: 'Draft email then send for review',
    task_type: 'action',
    ...overrides,
  };
}

function makeGuardrail(overrides = {}) {
  return {
    id: 'gr-1',
    revision: 7,
    prompt_text: 'Vendor work goes to the vendor project.',
    mapping: {},
    ...overrides,
  };
}

function makeLlmResponse(overrides = {}) {
  return {
    title: 'Vendor follow-up email',
    description: 'Draft the vendor email Eric committed to in the meeting.',
    projectId: 'p-staqspro',
    assigneeId: 'u-eric',
    stateId: 's-td',
    priority: 2,
    labelIds: ['l-vendor'],
    dueDate: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Skip path
// ---------------------------------------------------------------------------

describe('buildIssuePayload — skip path', () => {
  it('returns { skip_reason } and ignores all other validation when skip_reason is set', () => {
    const result = buildIssuePayload({
      task: makeTask(),
      teamCache: makeTeamCache(),
      guardrail: makeGuardrail(),
      llmResponse: {
        skip_reason: 'unclear',
        // Intentionally invalid garbage — must not be validated.
        projectId: 'NOT-IN-CACHE',
        stateId: 'NOT-IN-CACHE',
        assigneeId: 'NOT-IN-CACHE',
        priority: 99,
        labelIds: ['nonsense'],
        dueDate: 'not-a-date',
      },
    });

    assert.deepEqual(result, { skip_reason: 'unclear' });
  });

  it('treats empty string skip_reason as not-skipping (proceeds to validation)', () => {
    const result = buildIssuePayload({
      task: makeTask(),
      teamCache: makeTeamCache(),
      guardrail: makeGuardrail(),
      llmResponse: makeLlmResponse({ skip_reason: '' }),
    });

    assert.equal(result.skip_reason, undefined);
    assert.equal(result.stateId, 's-td');
  });
});

// ---------------------------------------------------------------------------
// Project validation
// ---------------------------------------------------------------------------

describe('buildIssuePayload — projectId validation', () => {
  it('keeps a projectId that exists in the cache', () => {
    const result = buildIssuePayload({
      task: makeTask(),
      teamCache: makeTeamCache(),
      guardrail: makeGuardrail(),
      llmResponse: makeLlmResponse({ projectId: 'p-staqspro' }),
    });

    assert.equal(result.projectId, 'p-staqspro');
  });

  it('drops a hallucinated projectId to null when no guardrail default is set', () => {
    const result = buildIssuePayload({
      task: makeTask(),
      teamCache: makeTeamCache(),
      guardrail: makeGuardrail(),
      llmResponse: makeLlmResponse({ projectId: 'p-hallucinated' }),
    });

    assert.equal(result.projectId, null);
  });

  it('falls back to guardrail.mapping.defaultProjectId when LLM projectId is invalid', () => {
    const result = buildIssuePayload({
      task: makeTask(),
      teamCache: makeTeamCache(),
      guardrail: makeGuardrail({ mapping: { defaultProjectId: 'p-formul8' } }),
      llmResponse: makeLlmResponse({ projectId: 'p-hallucinated' }),
    });

    assert.equal(result.projectId, 'p-formul8');
  });
});

// ---------------------------------------------------------------------------
// Assignee validation
// ---------------------------------------------------------------------------

describe('buildIssuePayload — assigneeId validation', () => {
  it('keeps an assigneeId that exists in the cache', () => {
    const result = buildIssuePayload({
      task: makeTask(),
      teamCache: makeTeamCache(),
      guardrail: makeGuardrail(),
      llmResponse: makeLlmResponse({ assigneeId: 'u-isaias' }),
    });

    assert.equal(result.assigneeId, 'u-isaias');
  });

  it('drops a hallucinated assigneeId to null', () => {
    const result = buildIssuePayload({
      task: makeTask(),
      teamCache: makeTeamCache(),
      guardrail: makeGuardrail(),
      llmResponse: makeLlmResponse({ assigneeId: 'u-ghost' }),
    });

    assert.equal(result.assigneeId, null);
  });
});

// ---------------------------------------------------------------------------
// State validation (required)
// ---------------------------------------------------------------------------

describe('buildIssuePayload — stateId validation (required)', () => {
  it('keeps a stateId that exists in the cache', () => {
    const result = buildIssuePayload({
      task: makeTask(),
      teamCache: makeTeamCache(),
      guardrail: makeGuardrail(),
      llmResponse: makeLlmResponse({ stateId: 's-ip' }),
    });

    assert.equal(result.stateId, 's-ip');
  });

  it('throws when stateId is missing from cache and no fallback is configured', () => {
    assert.throws(
      () => buildIssuePayload({
        task: makeTask(),
        teamCache: makeTeamCache(),
        guardrail: makeGuardrail(),
        llmResponse: makeLlmResponse({ stateId: 's-hallucinated' }),
      }),
      /no valid state for push/,
    );
  });

  it('uses guardrail.mapping.defaultStateId when LLM stateId is invalid', () => {
    const result = buildIssuePayload({
      task: makeTask(),
      teamCache: makeTeamCache(),
      guardrail: makeGuardrail({ mapping: { defaultStateId: 's-bl' } }),
      llmResponse: makeLlmResponse({ stateId: 's-hallucinated' }),
    });

    assert.equal(result.stateId, 's-bl');
  });

  it('throws when stateId is an empty string and no fallback exists', () => {
    assert.throws(
      () => buildIssuePayload({
        task: makeTask(),
        teamCache: makeTeamCache(),
        guardrail: makeGuardrail(),
        llmResponse: makeLlmResponse({ stateId: '' }),
      }),
      /no valid state for push/,
    );
  });

  it('throws when stateId is missing entirely and no fallback exists', () => {
    assert.throws(
      () => buildIssuePayload({
        task: makeTask(),
        teamCache: makeTeamCache(),
        guardrail: makeGuardrail(),
        llmResponse: makeLlmResponse({ stateId: undefined }),
      }),
      /no valid state for push/,
    );
  });
});

// ---------------------------------------------------------------------------
// Priority validation
// ---------------------------------------------------------------------------

describe('buildIssuePayload — priority validation', () => {
  it('keeps a priority value 0-4', () => {
    for (const p of [0, 1, 2, 3, 4]) {
      const result = buildIssuePayload({
        task: makeTask(),
        teamCache: makeTeamCache(),
        guardrail: makeGuardrail(),
        llmResponse: makeLlmResponse({ priority: p }),
      });
      assert.equal(result.priority, p, `priority ${p} preserved`);
    }
  });

  it('defaults priority to 3 (Linear Medium) when not provided', () => {
    const result = buildIssuePayload({
      task: makeTask(),
      teamCache: makeTeamCache(),
      guardrail: makeGuardrail(),
      llmResponse: makeLlmResponse({ priority: undefined }),
    });

    assert.equal(result.priority, 3);
  });

  it('drops an out-of-range priority to default 3', () => {
    const result = buildIssuePayload({
      task: makeTask(),
      teamCache: makeTeamCache(),
      guardrail: makeGuardrail(),
      llmResponse: makeLlmResponse({ priority: 99 }),
    });

    assert.equal(result.priority, 3);
  });

  it('drops a negative priority to default 3', () => {
    const result = buildIssuePayload({
      task: makeTask(),
      teamCache: makeTeamCache(),
      guardrail: makeGuardrail(),
      llmResponse: makeLlmResponse({ priority: -1 }),
    });

    assert.equal(result.priority, 3);
  });

  it('drops a non-numeric priority to default 3', () => {
    const result = buildIssuePayload({
      task: makeTask(),
      teamCache: makeTeamCache(),
      guardrail: makeGuardrail(),
      llmResponse: makeLlmResponse({ priority: 'high' }),
    });

    assert.equal(result.priority, 3);
  });
});

// ---------------------------------------------------------------------------
// Label validation + optimus tagging
// ---------------------------------------------------------------------------

describe('buildIssuePayload — labelIds validation', () => {
  it('keeps valid label ids and silently drops invalid ones', () => {
    const result = buildIssuePayload({
      task: makeTask(),
      teamCache: makeTeamCache(),
      guardrail: makeGuardrail(),
      llmResponse: makeLlmResponse({
        labelIds: ['l-vendor', 'l-urgent', 'l-ghost'],
      }),
    });

    assert.ok(result.labelIds.includes('l-vendor'));
    assert.ok(result.labelIds.includes('l-urgent'));
    assert.ok(!result.labelIds.includes('l-ghost'));
  });

  it('always includes the optimus label id even when labelIds is empty', () => {
    const result = buildIssuePayload({
      task: makeTask(),
      teamCache: makeTeamCache(),
      guardrail: makeGuardrail(),
      llmResponse: makeLlmResponse({ labelIds: [] }),
    });

    assert.ok(result.labelIds.includes('l-optimus'));
  });

  it('does not duplicate the optimus label when the LLM already included it', () => {
    const result = buildIssuePayload({
      task: makeTask(),
      teamCache: makeTeamCache(),
      guardrail: makeGuardrail(),
      llmResponse: makeLlmResponse({ labelIds: ['l-optimus', 'l-vendor'] }),
    });

    const optimusCount = result.labelIds.filter((id) => id === 'l-optimus').length;
    assert.equal(optimusCount, 1);
  });

  it('omits the optimus label silently when missing from the cache (no throw)', () => {
    const cache = makeTeamCache({
      labels: [
        { id: 'l-vendor', name: 'vendor', color: '#f00' },
        { id: 'l-urgent', name: 'urgent', color: '#f60' },
      ],
    });

    const result = buildIssuePayload({
      task: makeTask(),
      teamCache: cache,
      guardrail: makeGuardrail(),
      llmResponse: makeLlmResponse({ labelIds: ['l-vendor'] }),
    });

    assert.ok(!result.labelIds.includes('l-optimus'));
    assert.ok(result.labelIds.includes('l-vendor'));
  });
});

// ---------------------------------------------------------------------------
// Due-date validation
// ---------------------------------------------------------------------------

describe('buildIssuePayload — dueDate validation', () => {
  it('keeps a valid ISO date string', () => {
    const result = buildIssuePayload({
      task: makeTask(),
      teamCache: makeTeamCache(),
      guardrail: makeGuardrail(),
      llmResponse: makeLlmResponse({ dueDate: '2026-06-15' }),
    });

    assert.equal(result.dueDate, '2026-06-15');
  });

  it('drops an invalid dueDate to null', () => {
    const result = buildIssuePayload({
      task: makeTask(),
      teamCache: makeTeamCache(),
      guardrail: makeGuardrail(),
      llmResponse: makeLlmResponse({ dueDate: 'next Tuesday' }),
    });

    assert.equal(result.dueDate, null);
  });

  it('keeps null dueDate as null', () => {
    const result = buildIssuePayload({
      task: makeTask(),
      teamCache: makeTeamCache(),
      guardrail: makeGuardrail(),
      llmResponse: makeLlmResponse({ dueDate: null }),
    });

    assert.equal(result.dueDate, null);
  });
});

// ---------------------------------------------------------------------------
// Title shaping
// ---------------------------------------------------------------------------

describe('buildIssuePayload — title shaping', () => {
  it('uses task.title when llmResponse.title is missing', () => {
    const task = makeTask({ title: 'Original task title' });
    const result = buildIssuePayload({
      task,
      teamCache: makeTeamCache(),
      guardrail: makeGuardrail(),
      llmResponse: makeLlmResponse({ title: undefined }),
    });

    assert.equal(result.title, 'Original task title');
  });

  it('uses task.title when llmResponse.title is empty', () => {
    const task = makeTask({ title: 'Fallback title' });
    const result = buildIssuePayload({
      task,
      teamCache: makeTeamCache(),
      guardrail: makeGuardrail(),
      llmResponse: makeLlmResponse({ title: '' }),
    });

    assert.equal(result.title, 'Fallback title');
  });

  it('truncates titles longer than 80 chars with a "…" suffix', () => {
    const longTitle = 'A'.repeat(120);
    const result = buildIssuePayload({
      task: makeTask(),
      teamCache: makeTeamCache(),
      guardrail: makeGuardrail(),
      llmResponse: makeLlmResponse({ title: longTitle }),
    });

    assert.equal(result.title.length, 80);
    assert.ok(result.title.endsWith('…'));
  });

  it('does not truncate a title at exactly 80 chars', () => {
    const exact = 'B'.repeat(80);
    const result = buildIssuePayload({
      task: makeTask(),
      teamCache: makeTeamCache(),
      guardrail: makeGuardrail(),
      llmResponse: makeLlmResponse({ title: exact }),
    });

    assert.equal(result.title, exact);
    assert.ok(!result.title.endsWith('…'));
  });
});

// ---------------------------------------------------------------------------
// Description footer + source line
// ---------------------------------------------------------------------------

describe('buildIssuePayload — description shaping', () => {
  it('appends the guardrail-revision footer once', () => {
    const result = buildIssuePayload({
      task: makeTask(),
      teamCache: makeTeamCache(),
      guardrail: makeGuardrail({ revision: 7 }),
      llmResponse: makeLlmResponse({ description: 'Body text.' }),
    });

    const matches = result.description.match(/Pushed under guardrail v7/g) || [];
    assert.equal(matches.length, 1, 'footer present exactly once');
  });

  it('always appends the guardrail footer even when LLM gave no description', () => {
    const result = buildIssuePayload({
      task: makeTask(),
      teamCache: makeTeamCache(),
      guardrail: makeGuardrail({ revision: 12 }),
      llmResponse: makeLlmResponse({ description: '' }),
    });

    assert.ok(/Pushed under guardrail v12/.test(result.description));
  });

  it('does not let the LLM override the footer (no duplicates)', () => {
    const result = buildIssuePayload({
      task: makeTask(),
      teamCache: makeTeamCache(),
      guardrail: makeGuardrail({ revision: 4 }),
      llmResponse: makeLlmResponse({
        description: 'Some body\n\nPushed under guardrail v999',
      }),
    });

    const v999 = (result.description.match(/Pushed under guardrail v999/g) || []).length;
    const v4   = (result.description.match(/Pushed under guardrail v4/g) || []).length;
    assert.equal(v999, 0, 'LLM-supplied fake revision is removed');
    assert.equal(v4, 1, 'true revision footer appears exactly once');
  });

  it('appends a Source line referencing message_id and source_ts when message_id is set', () => {
    const task = makeTask({ message_id: 'msg-42', source_ts: '00:14:22' });
    const result = buildIssuePayload({
      task,
      teamCache: makeTeamCache(),
      guardrail: makeGuardrail(),
      llmResponse: makeLlmResponse(),
    });

    assert.ok(/Source:/.test(result.description));
    assert.ok(result.description.includes('msg-42'));
    assert.ok(result.description.includes('00:14:22'));
  });

  it('omits the Source line when task.message_id is null', () => {
    const task = makeTask({ message_id: null });
    const result = buildIssuePayload({
      task,
      teamCache: makeTeamCache(),
      guardrail: makeGuardrail(),
      llmResponse: makeLlmResponse(),
    });

    assert.ok(!/Source:/.test(result.description));
  });
});

// ---------------------------------------------------------------------------
// End-to-end use cases
// ---------------------------------------------------------------------------

describe('buildIssuePayload — use cases', () => {
  it('use case 1: operator-flagged "ours" task — LLM produces complete valid payload → exact passthrough + footer', () => {
    const task = makeTask();
    const teamCache = makeTeamCache();
    const guardrail = makeGuardrail({ revision: 7 });
    const llmResponse = makeLlmResponse({
      title: 'Send vendor follow-up',
      description: 'Drafted from meeting context.',
      projectId: 'p-staqspro',
      assigneeId: 'u-eric',
      stateId: 's-td',
      priority: 2,
      labelIds: ['l-vendor'],
      dueDate: '2026-06-01',
    });

    const result = buildIssuePayload({ task, teamCache, guardrail, llmResponse });

    assert.equal(result.title, 'Send vendor follow-up');
    assert.equal(result.projectId, 'p-staqspro');
    assert.equal(result.assigneeId, 'u-eric');
    assert.equal(result.stateId, 's-td');
    assert.equal(result.priority, 2);
    assert.equal(result.dueDate, '2026-06-01');
    assert.ok(result.labelIds.includes('l-vendor'));
    assert.ok(result.labelIds.includes('l-optimus'));
    assert.ok(/Pushed under guardrail v7/.test(result.description));
  });

  it('use case 2: LLM hallucinates project_id → builder drops it but produces a valid payload', () => {
    const result = buildIssuePayload({
      task: makeTask(),
      teamCache: makeTeamCache(),
      guardrail: makeGuardrail(),
      llmResponse: makeLlmResponse({ projectId: 'p-does-not-exist' }),
    });

    assert.equal(result.projectId, null);
    assert.equal(result.stateId, 's-td'); // rest of payload intact
    assert.ok(result.title);
  });

  it('use case 3: LLM picks a label not in cache → builder drops it silently', () => {
    const result = buildIssuePayload({
      task: makeTask(),
      teamCache: makeTeamCache(),
      guardrail: makeGuardrail(),
      llmResponse: makeLlmResponse({ labelIds: ['l-vendor', 'l-archived-label'] }),
    });

    assert.ok(result.labelIds.includes('l-vendor'));
    assert.ok(!result.labelIds.includes('l-archived-label'));
  });

  it('use case 4: LLM omits stateId, guardrail has default → builder substitutes', () => {
    const result = buildIssuePayload({
      task: makeTask(),
      teamCache: makeTeamCache(),
      guardrail: makeGuardrail({ mapping: { defaultStateId: 's-bl' } }),
      llmResponse: makeLlmResponse({ stateId: undefined }),
    });

    assert.equal(result.stateId, 's-bl');
  });

  it('use case 5: LLM returns skip_reason → no validation runs, function returns marker', () => {
    const result = buildIssuePayload({
      task: makeTask(),
      teamCache: makeTeamCache(),
      guardrail: makeGuardrail(),
      llmResponse: { skip_reason: 'LLM declined: ambiguous obligor' },
    });

    assert.deepEqual(result, { skip_reason: 'LLM declined: ambiguous obligor' });
  });
});

// ---------------------------------------------------------------------------
// Purity guarantees
// ---------------------------------------------------------------------------

describe('buildIssuePayload — purity guarantees', () => {
  it('does not mutate the task input', () => {
    const task = makeTask();
    const snapshot = JSON.parse(JSON.stringify(task));
    buildIssuePayload({
      task,
      teamCache: makeTeamCache(),
      guardrail: makeGuardrail(),
      llmResponse: makeLlmResponse(),
    });
    assert.deepEqual(task, snapshot);
  });

  it('does not mutate the teamCache input', () => {
    const teamCache = makeTeamCache();
    const snapshot = JSON.parse(JSON.stringify(teamCache));
    buildIssuePayload({
      task: makeTask(),
      teamCache,
      guardrail: makeGuardrail(),
      llmResponse: makeLlmResponse(),
    });
    assert.deepEqual(teamCache, snapshot);
  });

  it('does not mutate the guardrail input', () => {
    const guardrail = makeGuardrail();
    const snapshot = JSON.parse(JSON.stringify(guardrail));
    buildIssuePayload({
      task: makeTask(),
      teamCache: makeTeamCache(),
      guardrail,
      llmResponse: makeLlmResponse(),
    });
    assert.deepEqual(guardrail, snapshot);
  });

  it('does not mutate the llmResponse input', () => {
    const llmResponse = makeLlmResponse();
    const snapshot = JSON.parse(JSON.stringify(llmResponse));
    buildIssuePayload({
      task: makeTask(),
      teamCache: makeTeamCache(),
      guardrail: makeGuardrail(),
      llmResponse,
    });
    assert.deepEqual(llmResponse, snapshot);
  });
});
