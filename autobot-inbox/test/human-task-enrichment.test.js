/**
 * Tests the autofill enrichment as a pure function with an injectable LLM.
 * The contract from PRD §6:
 *
 *   enrichTask({task, contacts, projects, llm}) → patch
 *
 * The function bundles all autofillable fields into one LLM call and
 * returns a patch object the API layer applies. Tests inject a fake `llm`
 * so we exercise the field-mapping + safety guards without network.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { enrichTask, buildEnrichmentPrompt } from '../../lib/runtime/human-task-enrichment.js';

const CONTACTS = [
  { id: 'ct-eric', name: 'Eric Gang', email_address: 'eric@staqs.io', aliases: ['Eric'] },
  { id: 'ct-isaias', name: 'Isaias Valle', email_address: 'isaias@staqs.io', aliases: ['Isaias'] },
];
const PROJECTS = [
  { id: 'proj-staqs', name: 'StaqsPro' },
  { id: 'proj-claw', name: 'Claw' },
];
const ENGAGEMENTS = [
  { id: 'eng-1', name: 'Acme', is_active: true },
  { id: 'eng-2', name: 'Beta', is_active: true },
];

function fakeLlm(payload) {
  return async () => JSON.stringify(payload);
}

describe('enrichTask — happy path', () => {
  it('maps LLM output to a patch with all expected fields', async () => {
    const llm = fakeLlm({
      assignee_contact_id: 'ct-eric',
      assignee_confidence: 0.9,
      task_type: 'action',
      priority: 'high',
      size: 'small',
      project_id: 'proj-staqs',
      tags: ['migration', 'urgent'],
      next_action_hint: 'Open a PR for migration 119',
      description: 'Eric agreed to ship the human_tasks table before EOW.',
      extraction_confidence: 0.85,
      related_contact_ids: ['ct-isaias'],
    });

    const patch = await enrichTask({
      task: {
        id: 'htm-1',
        title: 'Eric to ship the migration',
        source_quote: 'Eric to ship the migration before EOW',
        task_type: null,
        assignee_label: 'Eric',
      },
      contacts: CONTACTS,
      projects: PROJECTS,
      llm,
    });

    assert.equal(patch.assignee_contact_id, 'ct-eric');
    assert.equal(patch.assignee_confidence, 0.9);
    assert.equal(patch.priority, 'high');
    assert.equal(patch.size, 'small');
    assert.equal(patch.project_id, 'proj-staqs');
    assert.deepEqual(patch.tags, ['migration', 'urgent']);
    assert.equal(patch.next_action_hint, 'Open a PR for migration 119');
    assert.equal(patch.extraction_confidence, 0.85);
    assert.deepEqual(patch.related_contact_ids, ['ct-isaias']);
  });
});

describe('enrichTask — safety guards', () => {
  it('rejects an assignee_contact_id that is not in the provided contacts list', async () => {
    // Hallucination guard: the model can mention any UUID; we only trust
    // ones we actually have on file.
    const llm = fakeLlm({ assignee_contact_id: 'ct-imaginary' });
    const patch = await enrichTask({
      task: { id: 't', title: 'x' },
      contacts: CONTACTS,
      projects: PROJECTS,
      llm,
    });
    assert.equal(patch.assignee_contact_id, null);
  });

  it('drops an unknown project_id', async () => {
    const llm = fakeLlm({ project_id: 'proj-imaginary' });
    const patch = await enrichTask({
      task: { id: 't', title: 'x' },
      contacts: CONTACTS,
      projects: PROJECTS,
      llm,
    });
    assert.equal(patch.project_id, null);
  });

  it('coerces a bad priority to "normal"', async () => {
    const llm = fakeLlm({ priority: 'screaming' });
    const patch = await enrichTask({
      task: { id: 't', title: 'x' },
      contacts: CONTACTS,
      projects: PROJECTS,
      llm,
    });
    assert.equal(patch.priority, 'normal');
  });

  it('drops a bad size', async () => {
    const llm = fakeLlm({ size: 'huge' });
    const patch = await enrichTask({
      task: { id: 't', title: 'x' },
      contacts: CONTACTS,
      projects: PROJECTS,
      llm,
    });
    assert.equal(patch.size, null);
  });

  it('clamps confidence fields into [0, 1]', async () => {
    const llm = fakeLlm({
      assignee_confidence: 1.5,
      extraction_confidence: -0.2,
    });
    const patch = await enrichTask({
      task: { id: 't', title: 'x' },
      contacts: CONTACTS,
      projects: PROJECTS,
      llm,
    });
    assert.equal(patch.assignee_confidence, 1);
    assert.equal(patch.extraction_confidence, 0);
  });

  it('NEVER invents a due_date (PRD §6: "lift from sibling signal otherwise NULL")', async () => {
    const llm = fakeLlm({ due_date: '2030-01-01' });
    const patch = await enrichTask({
      task: { id: 't', title: 'x' },
      contacts: CONTACTS,
      projects: PROJECTS,
      llm,
    });
    assert.equal('due_date' in patch, false);
  });

  it('NEVER touches status (PRD §6: status not autofilled)', async () => {
    const llm = fakeLlm({ status: 'done' });
    const patch = await enrichTask({
      task: { id: 't', title: 'x', status: 'inbox' },
      contacts: CONTACTS,
      projects: PROJECTS,
      llm,
    });
    assert.equal('status' in patch, false);
  });

  it('returns an empty patch when the LLM throws (fail safe)', async () => {
    const patch = await enrichTask({
      task: { id: 't', title: 'x' },
      contacts: CONTACTS,
      projects: PROJECTS,
      llm: async () => { throw new Error('upstream'); },
    });
    assert.deepEqual(patch, {});
  });

  it('returns an empty patch when the LLM returns malformed JSON', async () => {
    const patch = await enrichTask({
      task: { id: 't', title: 'x' },
      contacts: CONTACTS,
      projects: PROJECTS,
      llm: async () => 'not json at all',
    });
    assert.deepEqual(patch, {});
  });

  it('caps tags at 3 and lowercases them', async () => {
    const llm = fakeLlm({
      tags: ['Migration', 'URGENT', 'security', 'extra1', 'extra2'],
    });
    const patch = await enrichTask({
      task: { id: 't', title: 'x' },
      contacts: CONTACTS,
      projects: PROJECTS,
      llm,
    });
    assert.equal(patch.tags.length, 3);
    assert.deepEqual(patch.tags, ['migration', 'urgent', 'security']);
  });

  it('description is trimmed and capped at 1000 chars', async () => {
    const long = 'a '.repeat(700); // 1400 chars
    const llm = fakeLlm({ description: long });
    const patch = await enrichTask({
      task: { id: 't', title: 'x' },
      contacts: CONTACTS,
      projects: PROJECTS,
      llm,
    });
    assert.ok(patch.description.length <= 1000);
    assert.ok(patch.description.endsWith('…'));
  });

  it('description: empty string is dropped (not written)', async () => {
    const llm = fakeLlm({ description: '   ' });
    const patch = await enrichTask({
      task: { id: 't', title: 'x' },
      contacts: CONTACTS,
      projects: PROJECTS,
      llm,
    });
    assert.equal('description' in patch, false);
  });

  it('related_contact_ids: mixed valid+invalid keeps only valid', async () => {
    const llm = fakeLlm({
      related_contact_ids: ['ct-eric', 'ct-imaginary', 'ct-isaias', 42, null],
    });
    const patch = await enrichTask({
      task: { id: 't', title: 'x' },
      contacts: CONTACTS,
      projects: PROJECTS,
      llm,
    });
    assert.deepEqual(patch.related_contact_ids, ['ct-eric', 'ct-isaias']);
  });

  it('LLM returns an array → empty patch', async () => {
    const llm = fakeLlm([{ priority: 'urgent' }]);
    const patch = await enrichTask({
      task: { id: 't', title: 'x' },
      contacts: CONTACTS,
      projects: PROJECTS,
      llm,
    });
    assert.deepEqual(patch, {});
  });

  it('task_type: invalid value becomes null', async () => {
    const llm = fakeLlm({ task_type: 'random' });
    const patch = await enrichTask({
      task: { id: 't', title: 'x' },
      contacts: CONTACTS,
      projects: PROJECTS,
      llm,
    });
    assert.equal(patch.task_type, null);
  });

  it('task_type: valid value passes through', async () => {
    const llm = fakeLlm({ task_type: 'blocker' });
    const patch = await enrichTask({
      task: { id: 't', title: 'x' },
      contacts: CONTACTS,
      projects: PROJECTS,
      llm,
    });
    assert.equal(patch.task_type, 'blocker');
  });

  it('tags dedupe — duplicate input collapses to unique entries', async () => {
    const llm = fakeLlm({ tags: ['Migration', 'MIGRATION', 'migration'] });
    const patch = await enrichTask({
      task: { id: 't', title: 'x' },
      contacts: CONTACTS,
      projects: PROJECTS,
      llm,
    });
    assert.deepEqual(patch.tags, ['migration']);
  });

  it('empty contacts/projects arrays still work', async () => {
    const llm = fakeLlm({
      priority: 'high',
      assignee_contact_id: 'ct-eric', // none on file → null
    });
    const patch = await enrichTask({
      task: { id: 't', title: 'x' },
      contacts: [],
      projects: [],
      llm,
    });
    assert.equal(patch.priority, 'high');
    assert.equal(patch.assignee_contact_id, null);
  });

  it('caps next_action_hint to one line', async () => {
    const llm = fakeLlm({
      next_action_hint: 'Open the PR\nThen tag for review\nThen merge',
    });
    const patch = await enrichTask({
      task: { id: 't', title: 'x' },
      contacts: CONTACTS,
      projects: PROJECTS,
      llm,
    });
    assert.equal(patch.next_action_hint.includes('\n'), false);
    assert.equal(patch.next_action_hint, 'Open the PR');
  });
});

describe('buildEnrichmentPrompt', () => {
  it('includes the task title + source quote + contact list + project list', () => {
    const p = buildEnrichmentPrompt({
      task: { id: 't', title: 'Eric to ship migration', source_quote: 'Eric to ship migration before EOW' },
      contacts: CONTACTS,
      projects: PROJECTS,
    });
    assert.match(p, /Eric to ship migration/);
    assert.match(p, /ct-eric/);
    assert.match(p, /proj-staqs/);
  });

  it('lists the allowed enum values for priority/size/task_type', () => {
    const p = buildEnrichmentPrompt({
      task: { id: 't', title: 'x', source_quote: 'x' },
      contacts: CONTACTS,
      projects: PROJECTS,
    });
    assert.match(p, /urgent.*high.*normal.*low/s);
    assert.match(p, /quick.*small.*medium.*large/s);
    assert.match(p, /action.*decision_followup.*request.*blocker/s);
  });
});

describe('engagement allow-list (FR-2, G0.2)', () => {
  it('renders each active engagement as "id: name" under an ACTIVE ENGAGEMENTS heading', () => {
    const p = buildEnrichmentPrompt({
      task: { id: 't', title: 'x', source_quote: 'x' },
      contacts: CONTACTS,
      projects: PROJECTS,
      engagements: ENGAGEMENTS,
    });
    assert.match(p, /ACTIVE ENGAGEMENTS:/);
    assert.match(p, /eng-1: Acme/);
    assert.match(p, /eng-2: Beta/);
  });

  it('renders "(none)" when engagements is an empty array', () => {
    const p = buildEnrichmentPrompt({
      task: { id: 't', title: 'x', source_quote: 'x' },
      contacts: CONTACTS,
      projects: PROJECTS,
      engagements: [],
    });
    assert.match(p, /ACTIVE ENGAGEMENTS:\s*\n\s*\(none\)/);
  });

  it('mentions engagement_id in the JSON schema instructions', () => {
    const p = buildEnrichmentPrompt({
      task: { id: 't', title: 'x', source_quote: 'x' },
      contacts: CONTACTS,
      projects: PROJECTS,
      engagements: ENGAGEMENTS,
    });
    assert.ok(p.includes('engagement_id'), 'prompt must mention engagement_id');
  });

  it('keeps engagement_id in the patch when the LLM returns a value from the allow-list', async () => {
    const llm = fakeLlm({ engagement_id: 'eng-1' });
    const patch = await enrichTask({
      task: { id: 't', title: 'Acme client wants a demo', source_quote: 'Send the Acme client a proposal' },
      contacts: CONTACTS,
      projects: PROJECTS,
      engagements: ENGAGEMENTS,
      llm,
    });
    assert.equal(patch.engagement_id, 'eng-1');
  });

  it('drops engagement_id to null when the LLM returns an id outside the allow-list', async () => {
    const llm = fakeLlm({ engagement_id: 'eng-fake' });
    const patch = await enrichTask({
      task: { id: 't', title: 'x' },
      contacts: CONTACTS,
      projects: PROJECTS,
      engagements: ENGAGEMENTS,
      llm,
    });
    assert.equal(patch.engagement_id, null);
  });

  it('drops engagement_id to null when the LLM returns a non-string (number)', async () => {
    const llm = fakeLlm({ engagement_id: 42 });
    const patch = await enrichTask({
      task: { id: 't', title: 'x' },
      contacts: CONTACTS,
      projects: PROJECTS,
      engagements: ENGAGEMENTS,
      llm,
    });
    assert.equal(patch.engagement_id, null);
  });

  it('drops engagement_id to null when the LLM returns a non-string (object)', async () => {
    const llm = fakeLlm({ engagement_id: { id: 'eng-1' } });
    const patch = await enrichTask({
      task: { id: 't', title: 'x' },
      contacts: CONTACTS,
      projects: PROJECTS,
      engagements: ENGAGEMENTS,
      llm,
    });
    assert.equal(patch.engagement_id, null);
  });

  it('omits engagement_id from the patch when the LLM omits the field', async () => {
    const llm = fakeLlm({ priority: 'high' });
    const patch = await enrichTask({
      task: { id: 't', title: 'x' },
      contacts: CONTACTS,
      projects: PROJECTS,
      engagements: ENGAGEMENTS,
      llm,
    });
    assert.equal('engagement_id' in patch, false);
  });

  it('drops engagement_id to null when engagements is omitted (legacy call site) but LLM returns an id', async () => {
    // Backward compat: caller doesn't pass `engagements`; allow-list is
    // effectively empty so any LLM-supplied id is dropped to null.
    const llm = fakeLlm({ engagement_id: 'eng-1' });
    const patch = await enrichTask({
      task: { id: 't', title: 'x' },
      contacts: CONTACTS,
      projects: PROJECTS,
      llm,
    });
    assert.equal(patch.engagement_id, null);
  });

  it('does not crash when engagements is omitted and the LLM omits engagement_id', async () => {
    const llm = fakeLlm({ priority: 'normal' });
    const patch = await enrichTask({
      task: { id: 't', title: 'x' },
      contacts: CONTACTS,
      projects: PROJECTS,
      llm,
    });
    assert.equal('engagement_id' in patch, false);
    assert.equal(patch.priority, 'normal');
  });

  it('renders "(none)" for engagements when caller omits the parameter entirely', () => {
    const p = buildEnrichmentPrompt({
      task: { id: 't', title: 'x', source_quote: 'x' },
      contacts: CONTACTS,
      projects: PROJECTS,
    });
    assert.match(p, /ACTIVE ENGAGEMENTS:\s*\n\s*\(none\)/);
  });
});
