// Feature 010-D (OPT-133) — relevance-scored memory recall.
// Locks AC-2 (an entity-tagged memory is recalled when its entity appears in the
// turn, even when it's not among the 20 most recent) and the §2.C failure boost.
// Detection/ranking are pure + sync (AC-6: no added latency on the recall path).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  entityKey,
  memoryEntityKeys,
  detectTurnEntities,
  rankMemoriesByRelevance,
} from '../../lib/runtime/agents/agent-memory.js';

describe('010-D entityKey / memoryEntityKeys', () => {
  it('uses lowercased email as the canonical key, name as fallback', () => {
    assert.equal(entityKey('person', 'Kevin', 'Kevin@X.CO'), 'person:kevin@x.co');
    assert.equal(entityKey('org', 'Frontpoint', ''), 'org:frontpoint');
    assert.equal(entityKey('person', '', ''), null);
  });

  it('derives keys from metadata.entities', () => {
    assert.deepEqual(
      memoryEntityKeys({ entities: [{ kind: 'org', name: 'Acme' }, { kind: 'person', email: 'a@b.co' }] }),
      ['org:acme', 'person:a@b.co'],
    );
    assert.deepEqual(memoryEntityKeys({}), []);
  });
});

describe('010-D detectTurnEntities', () => {
  const vocab = [
    { kind: 'org', name: 'Frontpoint' },
    { kind: 'person', name: 'Kevin Durant', email: 'kevin@empire.co' },
    { kind: 'org', name: 'Ann' },
  ];

  it('matches a whole-word org name, case-insensitively', () => {
    const d = detectTurnEntities("how is frontpoint doing this week?", vocab);
    assert.ok(d.has('org:frontpoint'));
  });

  it('matches a distinctive email substring', () => {
    const d = detectTurnEntities('ping kevin@empire.co about the deck', vocab);
    assert.ok(d.has('person:kevin@empire.co'));
  });

  it('does NOT match a name embedded inside another word', () => {
    const d = detectTurnEntities('an announcement is coming', vocab); // "Ann" ⊄ "announcement"
    assert.ok(!d.has('org:ann'));
  });

  it('returns an empty set when the turn names nothing known', () => {
    assert.equal(detectTurnEntities('what time is it?', vocab).size, 0);
  });
});

describe('010-D rankMemoriesByRelevance', () => {
  it('AC-2: an entity-tagged memory outside the 20 most recent ranks in', () => {
    // 25 recency-ordered memories; the relevant one is the OLDEST (index 24).
    const mems = Array.from({ length: 25 }, (_, i) => ({
      id: `m${i}`, memory_type: 'preference', content: `note ${i}`, metadata: {},
    }));
    mems[24] = { id: 'rel', memory_type: 'preference', content: 'Frontpoint prefers PDF updates', metadata: { entities: [{ kind: 'org', name: 'Frontpoint' }] } };

    const ranked = rankMemoriesByRelevance(mems, new Set(['org:frontpoint']));
    assert.equal(ranked[0].id, 'rel', 'entity-overlap memory ranks first');
    assert.ok(ranked.slice(0, 20).some((m) => m.id === 'rel'), 'recalled within the 20-budget');
  });

  it('§2.C: a failure with overlap outranks a preference with the same overlap', () => {
    const mems = [
      { id: 'pref', memory_type: 'preference', metadata: { entities: [{ kind: 'org', name: 'Acme' }] } },
      { id: 'fail', memory_type: 'failure', metadata: { entities: [{ kind: 'org', name: 'Acme' }] } },
    ];
    const ranked = rankMemoriesByRelevance(mems, new Set(['org:acme']));
    assert.equal(ranked[0].id, 'fail');
  });

  it('falls back to recency order when nothing is detected (budget unchanged)', () => {
    const mems = [{ id: 'a', metadata: {} }, { id: 'b', metadata: {} }, { id: 'c', metadata: {} }];
    assert.deepEqual(rankMemoriesByRelevance(mems, new Set()).map((m) => m.id), ['a', 'b', 'c']);
  });

  it('more topical overlap outranks a failure with less overlap', () => {
    const mems = [
      { id: 'fail1', memory_type: 'failure', metadata: { entities: [{ kind: 'org', name: 'Acme' }] } },
      { id: 'pref2', memory_type: 'preference', metadata: { entities: [{ kind: 'org', name: 'Acme' }, { kind: 'person', name: 'Kevin' }] } },
    ];
    // pref2 overlap=2 (score 20) vs fail1 overlap=1 (score 15) → pref2 first.
    const ranked = rankMemoriesByRelevance(mems, new Set(['org:acme', 'person:kevin']));
    assert.equal(ranked[0].id, 'pref2');
  });
});
