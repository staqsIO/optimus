/**
 * Unit tests for lib/runtime/push-prompt.js — push LLM prompt builder.
 *
 * PRD: autobot-inbox/docs/internal/prds/meeting-actions-to-kanban-v0.2-tech-spec.md
 *      FR-21 — the current `push` guardrail's `prompt_text` MUST be prepended
 *      to the push LLM system prompt.
 *
 * The builder is a pure function. No I/O, no LLM SDK imports. The push
 * worker injects its own llm callable; this module only shapes the prompt.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { buildPushPrompt } from '../../lib/runtime/push-prompt.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUSH_PROMPT_PATH = resolve(__dirname, '../../lib/runtime/push-prompt.js');

function makeTask(overrides = {}) {
  return {
    id: 'task-1',
    title: 'Send the proposal draft to Acme',
    description: 'Follow up on yesterday\'s pricing call.',
    source_quote: 'I\'ll send the proposal by Friday.',
    source_ts: '2026-05-19T14:30:00Z',
    signal_id: 'sig-42',
    message_id: 'msg-99',
    assignee_label: 'Isaias',
    project_id: 'proj-foo',
    engagement_id: 'eng-foo',
    priority: 'high',
    size: 'small',
    due_date: '2026-05-23',
    task_type: 'action',
    next_action_hint: 'Draft proposal in Google Docs',
    ...overrides,
  };
}

function makeTeamCache(overrides = {}) {
  return {
    workflow_states: [
      { id: 'state-todo', name: 'Todo', type: 'unstarted' },
      { id: 'state-doing', name: 'In Progress', type: 'started' },
    ],
    projects: [
      { id: 'proj-foo', name: 'Acme Onboarding' },
      { id: 'proj-bar', name: 'Internal Tooling' },
    ],
    members: [
      { id: 'member-i', name: 'Isaias' },
      { id: 'member-d', name: 'Dustin' },
    ],
    labels: [
      { id: 'label-bug', name: 'bug' },
      { id: 'label-optimus', name: 'optimus' },
    ],
    ...overrides,
  };
}

function makeGuardrail(promptText = 'GUARDRAIL: never push tasks without a source_quote.') {
  return {
    id: 'gr-1',
    revision: 7,
    prompt_text: promptText,
    mapping: { defaultStateId: 'state-todo' },
  };
}

test('prompt contains task title and source_quote', () => {
  const prompt = buildPushPrompt({
    task: makeTask(),
    teamCache: makeTeamCache(),
    guardrail: makeGuardrail(),
  });
  assert.ok(prompt.includes('Send the proposal draft to Acme'),
    'expected task title in prompt');
  assert.ok(prompt.includes("I'll send the proposal by Friday."),
    'expected source_quote in prompt');
});

test('prompt contains all team workflow states with id, name, and type', () => {
  const prompt = buildPushPrompt({
    task: makeTask(),
    teamCache: makeTeamCache(),
    guardrail: makeGuardrail(),
  });
  assert.ok(prompt.includes('state-todo'), 'state id missing');
  assert.ok(prompt.includes('Todo'), 'state name missing');
  assert.ok(prompt.includes('unstarted'), 'state type missing');
  assert.ok(prompt.includes('state-doing'), 'second state id missing');
  assert.ok(prompt.includes('In Progress'), 'second state name missing');
  assert.ok(prompt.includes('started'), 'second state type missing');
});

test('prompt contains all team projects with id and name', () => {
  const prompt = buildPushPrompt({
    task: makeTask(),
    teamCache: makeTeamCache(),
    guardrail: makeGuardrail(),
  });
  assert.ok(prompt.includes('proj-foo'), 'project id missing');
  assert.ok(prompt.includes('Acme Onboarding'), 'project name missing');
  assert.ok(prompt.includes('proj-bar'), 'second project id missing');
  assert.ok(prompt.includes('Internal Tooling'), 'second project name missing');
});

test('prompt contains all team members with id and name', () => {
  const prompt = buildPushPrompt({
    task: makeTask(),
    teamCache: makeTeamCache(),
    guardrail: makeGuardrail(),
  });
  assert.ok(prompt.includes('member-i'), 'member id missing');
  assert.ok(prompt.includes('Isaias'), 'member name missing');
  assert.ok(prompt.includes('member-d'), 'second member id missing');
  assert.ok(prompt.includes('Dustin'), 'second member name missing');
});

test('prompt contains all team labels with id and name', () => {
  const prompt = buildPushPrompt({
    task: makeTask(),
    teamCache: makeTeamCache(),
    guardrail: makeGuardrail(),
  });
  assert.ok(prompt.includes('label-bug'), 'label id missing');
  assert.ok(prompt.includes('bug'), 'label name missing');
  assert.ok(prompt.includes('label-optimus'), 'second label id missing');
  assert.ok(prompt.includes('optimus'), 'second label name missing');
});

test('prompt contains JSON schema instructions for all required fields', () => {
  const prompt = buildPushPrompt({
    task: makeTask(),
    teamCache: makeTeamCache(),
    guardrail: makeGuardrail(),
  });
  for (const field of [
    'title',
    'description',
    'projectId',
    'assigneeId',
    'stateId',
    'priority',
    'labelIds',
    'dueDate',
    'skip_reason',
  ]) {
    assert.ok(prompt.includes(field), `JSON schema field "${field}" missing`);
  }
  assert.ok(prompt.includes('DO NOT invent ids'),
    'invent-ids guard missing');
});

test('empty guardrail.prompt_text → no leading section, rest of prompt still present', () => {
  const prompt = buildPushPrompt({
    task: makeTask(),
    teamCache: makeTeamCache(),
    guardrail: makeGuardrail(''),
  });
  // Should still contain the body — title, schema, etc.
  assert.ok(prompt.includes('Send the proposal draft to Acme'),
    'task body missing when guardrail.prompt_text empty');
  assert.ok(prompt.includes('TEAM STATES'),
    'team states header missing when guardrail.prompt_text empty');
  // Should start with the push agent header (not a leading guardrail block).
  assert.ok(prompt.trimStart().startsWith('You are the Optimus push agent'),
    'prompt should start with push agent header when guardrail.prompt_text empty, got: '
      + JSON.stringify(prompt.slice(0, 80)));
});

test('non-empty guardrail.prompt_text → prepended at top of prompt', () => {
  const guardrailText = 'GUARDRAIL: never push tasks without a source_quote.';
  const prompt = buildPushPrompt({
    task: makeTask(),
    teamCache: makeTeamCache(),
    guardrail: makeGuardrail(guardrailText),
  });
  assert.ok(prompt.startsWith(guardrailText),
    'guardrail prompt_text must be at the very top of the prompt');
  // Must still come BEFORE the push agent header.
  const guardrailIdx = prompt.indexOf(guardrailText);
  const headerIdx = prompt.indexOf('You are the Optimus push agent');
  assert.ok(guardrailIdx >= 0 && headerIdx >= 0 && guardrailIdx < headerIdx,
    'guardrail text must appear before the push agent header');
});

test('missing guardrail object → no leading section, rest of prompt still present', () => {
  const prompt = buildPushPrompt({
    task: makeTask(),
    teamCache: makeTeamCache(),
    guardrail: null,
  });
  assert.ok(prompt.trimStart().startsWith('You are the Optimus push agent'),
    'prompt should start with push agent header when guardrail is null');
  assert.ok(prompt.includes('TEAM STATES'),
    'team states header missing when guardrail is null');
});

test('empty teamCache fields → render "(none)" placeholders', () => {
  const prompt = buildPushPrompt({
    task: makeTask(),
    teamCache: {
      workflow_states: [],
      projects: [],
      members: [],
      labels: [],
    },
    guardrail: makeGuardrail(),
  });
  // Each of the four lists should have its own "(none)" placeholder line.
  const noneCount = (prompt.match(/\(none\)/g) || []).length;
  assert.ok(noneCount >= 4,
    `expected at least 4 "(none)" placeholders (states/projects/members/labels), got ${noneCount}`);
});

test('missing teamCache entirely → still produces "(none)" placeholders, does not throw', () => {
  let prompt;
  assert.doesNotThrow(() => {
    prompt = buildPushPrompt({
      task: makeTask(),
      teamCache: undefined,
      guardrail: makeGuardrail(),
    });
  });
  assert.ok(prompt.includes('(none)'),
    'expected at least one "(none)" placeholder when teamCache missing');
});

test('source file does not import any LLM SDK', () => {
  const src = readFileSync(PUSH_PROMPT_PATH, 'utf8');
  // Match any common LLM SDK identifier in import statements.
  const forbidden = [
    '@anthropic-ai/sdk',
    'openai',
    '@google/generative-ai',
    '@google-cloud/vertexai',
    'lib/llm',
    '../llm/',
    './llm',
  ];
  for (const needle of forbidden) {
    assert.ok(
      !new RegExp(`from\\s+['"\`][^'"\`]*${needle.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}[^'"\`]*['"\`]`).test(src),
      `push-prompt.js must not import an LLM SDK (found "${needle}")`,
    );
  }
});
