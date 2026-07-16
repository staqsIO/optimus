/**
 * RED — board/src/app/governance/guardrails/guardrail-form.js does not exist.
 *
 * FR-22 (Settings → LLM Guardrails). Pure helpers backing the editor UI:
 *
 *   - validateGuardrailForm({kind, prompt_text, mapping})
 *       → { valid, errors: { [field]: msg } }
 *
 *       kind ∈ {'push','pull'}; prompt_text required, ≤ 2000 chars;
 *       mapping must be a plain object.
 *
 *   - diffGuardrailMapping(prev, next)
 *       → { added: [stateId,...], removed: [...], changed: [{stateId, from, to}] }
 *
 *   - diffGuardrailPrompt(prev, next)
 *       → { changed: boolean, lineDiff: [{type:'add'|'remove', text}] }
 *
 *       Rule: lineDiff contains ONLY add/remove entries. Unchanged lines
 *       are omitted (no 'context' type).
 *
 * ADR-004: pure JS + JSDoc, node:test only, no RTL.
 * Run: cd board && node --test src/app/governance/guardrails/guardrail-form.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateGuardrailForm,
  diffGuardrailMapping,
  diffGuardrailPrompt,
} from './guardrail-form.js';

// ---------------------------------------------------------------------------
// validateGuardrailForm
// ---------------------------------------------------------------------------

describe('validateGuardrailForm', () => {
  it('returns valid=true and empty errors when the form is well-formed', () => {
    const out = validateGuardrailForm({
      kind: 'push',
      prompt_text: 'Be conservative when pushing tasks to Linear.',
      mapping: { 'state-1': 'inbox' },
    });
    assert.equal(out.valid, true);
    assert.deepEqual(out.errors, {});
  });

  it('accepts kind="pull" as well as kind="push"', () => {
    const out = validateGuardrailForm({
      kind: 'pull',
      prompt_text: 'Interpret @optimus comments carefully.',
      mapping: {},
    });
    assert.equal(out.valid, true);
    assert.deepEqual(out.errors, {});
  });

  it('flags missing prompt_text', () => {
    const out = validateGuardrailForm({
      kind: 'push',
      prompt_text: '',
      mapping: {},
    });
    assert.equal(out.valid, false);
    assert.ok(out.errors.prompt_text, 'errors.prompt_text should be set');
  });

  it('flags whitespace-only prompt_text as missing', () => {
    const out = validateGuardrailForm({
      kind: 'push',
      prompt_text: '   \n\t  ',
      mapping: {},
    });
    assert.equal(out.valid, false);
    assert.ok(out.errors.prompt_text);
  });

  it('flags prompt_text longer than 2000 chars', () => {
    const out = validateGuardrailForm({
      kind: 'push',
      prompt_text: 'x'.repeat(2001),
      mapping: {},
    });
    assert.equal(out.valid, false);
    assert.ok(out.errors.prompt_text);
  });

  it('accepts prompt_text at exactly 2000 chars (boundary)', () => {
    const out = validateGuardrailForm({
      kind: 'push',
      prompt_text: 'x'.repeat(2000),
      mapping: {},
    });
    assert.equal(out.valid, true);
    assert.equal(out.errors.prompt_text, undefined);
  });

  it('flags invalid kind', () => {
    const out = validateGuardrailForm({
      kind: 'sideways',
      prompt_text: 'ok',
      mapping: {},
    });
    assert.equal(out.valid, false);
    assert.ok(out.errors.kind, 'errors.kind should be set');
  });

  it('flags missing kind', () => {
    const out = validateGuardrailForm({
      kind: undefined,
      prompt_text: 'ok',
      mapping: {},
    });
    assert.equal(out.valid, false);
    assert.ok(out.errors.kind);
  });

  it('flags mapping that is not a plain object (array)', () => {
    const out = validateGuardrailForm({
      kind: 'push',
      prompt_text: 'ok',
      mapping: ['not', 'an', 'object'],
    });
    assert.equal(out.valid, false);
    assert.ok(out.errors.mapping, 'errors.mapping should be set');
  });

  it('flags mapping that is not a plain object (null)', () => {
    const out = validateGuardrailForm({
      kind: 'push',
      prompt_text: 'ok',
      mapping: null,
    });
    assert.equal(out.valid, false);
    assert.ok(out.errors.mapping);
  });

  it('flags mapping that is not a plain object (string)', () => {
    const out = validateGuardrailForm({
      kind: 'push',
      prompt_text: 'ok',
      mapping: 'inbox',
    });
    assert.equal(out.valid, false);
    assert.ok(out.errors.mapping);
  });

  it('collects multiple errors at once (does not short-circuit)', () => {
    const out = validateGuardrailForm({
      kind: 'bogus',
      prompt_text: '',
      mapping: 'not-an-object',
    });
    assert.equal(out.valid, false);
    assert.ok(out.errors.kind);
    assert.ok(out.errors.prompt_text);
    assert.ok(out.errors.mapping);
  });
});

// ---------------------------------------------------------------------------
// diffGuardrailMapping
// ---------------------------------------------------------------------------

describe('diffGuardrailMapping', () => {
  it('returns empty buckets when prev and next are identical', () => {
    const prev = { s1: 'inbox', s2: 'todo' };
    const next = { s1: 'inbox', s2: 'todo' };
    assert.deepEqual(diffGuardrailMapping(prev, next), {
      added: [],
      removed: [],
      changed: [],
    });
  });

  it('reports a newly mapped state in added', () => {
    const prev = { s1: 'inbox' };
    const next = { s1: 'inbox', s2: 'todo' };
    const out = diffGuardrailMapping(prev, next);
    assert.deepEqual(out.added, ['s2']);
    assert.deepEqual(out.removed, []);
    assert.deepEqual(out.changed, []);
  });

  it('reports a removed state in removed', () => {
    const prev = { s1: 'inbox', s2: 'todo' };
    const next = { s1: 'inbox' };
    const out = diffGuardrailMapping(prev, next);
    assert.deepEqual(out.added, []);
    assert.deepEqual(out.removed, ['s2']);
    assert.deepEqual(out.changed, []);
  });

  it('reports a remapped state in changed with from/to', () => {
    const prev = { s1: 'inbox' };
    const next = { s1: 'in_progress' };
    const out = diffGuardrailMapping(prev, next);
    assert.deepEqual(out.added, []);
    assert.deepEqual(out.removed, []);
    assert.deepEqual(out.changed, [
      { stateId: 's1', from: 'inbox', to: 'in_progress' },
    ]);
  });

  it('handles a mix of additions, removals, and changes in one diff', () => {
    const prev = { s1: 'inbox', s2: 'todo', s3: 'in_progress' };
    const next = { s1: 'inbox', s3: 'done', s4: 'not_for_us' };
    const out = diffGuardrailMapping(prev, next);
    assert.deepEqual(out.added.sort(), ['s4']);
    assert.deepEqual(out.removed.sort(), ['s2']);
    assert.deepEqual(out.changed, [
      { stateId: 's3', from: 'in_progress', to: 'done' },
    ]);
  });

  it('treats empty prev as all-added', () => {
    const prev = {};
    const next = { s1: 'inbox', s2: 'todo' };
    const out = diffGuardrailMapping(prev, next);
    assert.deepEqual(out.added.sort(), ['s1', 's2']);
    assert.deepEqual(out.removed, []);
    assert.deepEqual(out.changed, []);
  });

  it('treats empty next as all-removed', () => {
    const prev = { s1: 'inbox', s2: 'todo' };
    const next = {};
    const out = diffGuardrailMapping(prev, next);
    assert.deepEqual(out.added, []);
    assert.deepEqual(out.removed.sort(), ['s1', 's2']);
    assert.deepEqual(out.changed, []);
  });
});

// ---------------------------------------------------------------------------
// diffGuardrailPrompt
// ---------------------------------------------------------------------------

describe('diffGuardrailPrompt', () => {
  it('returns changed=false and empty lineDiff when prev === next', () => {
    const text = 'line one\nline two\nline three';
    const out = diffGuardrailPrompt(text, text);
    assert.equal(out.changed, false);
    assert.deepEqual(out.lineDiff, []);
  });

  it('returns changed=false for two empty strings', () => {
    const out = diffGuardrailPrompt('', '');
    assert.equal(out.changed, false);
    assert.deepEqual(out.lineDiff, []);
  });

  it('flags a purely added line as an add entry', () => {
    const prev = 'line one\nline two';
    const next = 'line one\nline two\nline three';
    const out = diffGuardrailPrompt(prev, next);
    assert.equal(out.changed, true);
    const adds = out.lineDiff.filter((d) => d.type === 'add');
    assert.ok(
      adds.some((d) => d.text === 'line three'),
      'lineDiff should include an add entry for "line three"',
    );
  });

  it('flags a purely removed line as a remove entry', () => {
    const prev = 'line one\nline two\nline three';
    const next = 'line one\nline two';
    const out = diffGuardrailPrompt(prev, next);
    assert.equal(out.changed, true);
    const removes = out.lineDiff.filter((d) => d.type === 'remove');
    assert.ok(
      removes.some((d) => d.text === 'line three'),
      'lineDiff should include a remove entry for "line three"',
    );
  });

  it('flags a modified line as remove(old) + add(new)', () => {
    const prev = 'be conservative';
    const next = 'be aggressive';
    const out = diffGuardrailPrompt(prev, next);
    assert.equal(out.changed, true);
    const removes = out.lineDiff.filter((d) => d.type === 'remove');
    const adds = out.lineDiff.filter((d) => d.type === 'add');
    assert.ok(removes.some((d) => d.text === 'be conservative'));
    assert.ok(adds.some((d) => d.text === 'be aggressive'));
  });

  it('handles prev empty and next non-empty (all adds)', () => {
    const out = diffGuardrailPrompt('', 'first\nsecond');
    assert.equal(out.changed, true);
    const adds = out.lineDiff.filter((d) => d.type === 'add').map((d) => d.text);
    assert.ok(adds.includes('first'));
    assert.ok(adds.includes('second'));
  });

  it('unchanged lines do NOT appear in lineDiff (no context entries)', () => {
    const prev = 'keep one\nkeep two\nremove me';
    const next = 'keep one\nkeep two\nadd me';
    const out = diffGuardrailPrompt(prev, next);
    assert.equal(out.changed, true);
    // Contract: lineDiff contains ONLY add/remove entries.
    assert.ok(
      out.lineDiff.every((d) => d.type === 'add' || d.type === 'remove'),
      'every lineDiff entry must be type "add" or "remove"',
    );
    assert.equal(
      out.lineDiff.some((d) => d.type === 'context'),
      false,
      'no lineDiff entry should have type "context"',
    );
    // Unchanged lines ("keep one", "keep two") must be omitted entirely.
    assert.equal(
      out.lineDiff.some((d) => d.text === 'keep one'),
      false,
    );
    assert.equal(
      out.lineDiff.some((d) => d.text === 'keep two'),
      false,
    );
  });
});
