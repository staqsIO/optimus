// Feature 010-C (OPT-131) — entity tagging in chat memory extraction.
// Pure-function coverage of the parse/normalize layer that writes
// agent_memories.metadata.entities (no migration; jsonb).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeEntities,
  parseExtractedMemories,
  parseDistilledFailure,
} from '../src/commands/agent-chat.js';

describe('010-C normalizeEntities', () => {
  it('keeps valid person/org entities and lowercases email', () => {
    const out = normalizeEntities([
      { kind: 'person', name: 'Kevin Durant', email: 'Kevin@Empire.CO' },
      { kind: 'org', name: 'Frontpoint' },
    ]);
    assert.deepEqual(out, [
      { kind: 'person', name: 'Kevin Durant', email: 'kevin@empire.co' },
      { kind: 'org', name: 'Frontpoint' },
    ]);
  });

  it('dedupes by email (canonical key), ignoring name differences', () => {
    const out = normalizeEntities([
      { kind: 'person', name: 'Kevin D', email: 'k@x.co' },
      { kind: 'person', name: 'Kevin Durant', email: 'k@x.co' },
    ]);
    assert.equal(out.length, 1);
  });

  it('falls back to name as the dedup key when no email', () => {
    const out = normalizeEntities([
      { kind: 'org', name: 'Acme' },
      { kind: 'org', name: 'acme' },
    ]);
    assert.equal(out.length, 1);
  });

  it('drops entries with no name and no email, and bad kinds', () => {
    const out = normalizeEntities([
      { kind: 'person' },
      { kind: 'place', name: 'Paris' },
      { kind: 'org', name: 'Real Co' },
    ]);
    assert.deepEqual(out, [{ kind: 'org', name: 'Real Co' }]);
  });

  it('caps at 12 and tolerates non-array input', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ kind: 'person', name: `P${i}` }));
    assert.equal(normalizeEntities(many).length, 12);
    assert.deepEqual(normalizeEntities(null), []);
    assert.deepEqual(normalizeEntities('nope'), []);
  });
});

describe('010-C parseExtractedMemories with entities', () => {
  it('preserves and normalizes per-memory entities', () => {
    const text = JSON.stringify([
      { type: 'preference', content: 'Keep client updates short for Frontpoint', entities: [{ kind: 'org', name: 'Frontpoint' }] },
    ]);
    const out = parseExtractedMemories(text);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].entities, [{ kind: 'org', name: 'Frontpoint' }]);
  });

  it('defaults entities to [] when the model omits them', () => {
    const out = parseExtractedMemories(JSON.stringify([{ type: 'context', content: 'Member prefers async updates' }]));
    assert.deepEqual(out[0].entities, []);
  });

  it('returns [] on malformed input', () => {
    assert.deepEqual(parseExtractedMemories('not json'), []);
  });
});

describe('010-C parseDistilledFailure', () => {
  it('parses JSON {lesson, entities}', () => {
    const out = parseDistilledFailure(JSON.stringify({
      lesson: "Don't quote pricing for Empire without checking the contract first",
      entities: [{ kind: 'org', name: 'Empire', email: 'AP@empire.co' }],
    }));
    assert.match(out.lesson, /pricing/);
    assert.deepEqual(out.entities, [{ kind: 'org', name: 'Empire', email: 'ap@empire.co' }]);
  });

  it('returns null on NONE', () => {
    assert.equal(parseDistilledFailure('NONE'), null);
    assert.equal(parseDistilledFailure('  none  '), null);
  });

  it('falls back to a bare sentence as the lesson (pre-010-C compatibility)', () => {
    const out = parseDistilledFailure("Don't answer meeting questions without checking the KB.");
    assert.match(out.lesson, /meeting questions/);
    assert.deepEqual(out.entities, []);
  });

  it('returns null for too-short or empty signal', () => {
    assert.equal(parseDistilledFailure('no'), null);
    assert.equal(parseDistilledFailure(''), null);
  });
});
