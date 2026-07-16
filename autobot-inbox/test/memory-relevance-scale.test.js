// Feature 010-D / OPT-134 — jsonb+GIN recall scale path.
// loadRelevantMemories no longer caps at a fixed recency pool: entity matches
// are pulled via a GIN-indexed containment query (any age) and unioned with the
// recency budget. Tested with an injected query that dispatches by SQL shape —
// no live Postgres.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  loadRelevantMemories,
  loadMemoriesByEntities,
} from '../../lib/runtime/agents/agent-memory.js';

// Dispatch a fake query by which of the 3 statements it is.
function fakeQuery({ recency = [], vocab = [], matched = [] } = {}) {
  const calls = [];
  const fn = async (sql, params) => {
    calls.push({ sql, params });
    if (/jsonb_array_elements\(metadata->'entities'\)/.test(sql)) return { rows: vocab };
    if (/metadata->'entities' @>/.test(sql)) {
      return { rows: typeof matched === 'function' ? matched(sql, params) : matched };
    }
    return { rows: recency }; // loadMemory recency set
  };
  return { fn, calls };
}

const mem = (id, over = {}) => ({
  id, memory_type: 'preference', content: `m${id}`,
  created_at: `2026-06-${String((id % 27) + 1).padStart(2, '0')}T00:00:00.000Z`,
  metadata: {}, ...over,
});

describe('OPT-134 loadRelevantMemories scale path', () => {
  it('AC-2 at scale: an entity match OUTSIDE the recency budget surfaces & ranks first', async () => {
    // 20 recent memories, none about Frontpoint (the budget).
    const recency = Array.from({ length: 20 }, (_, i) => mem(i + 1));
    // The relevant memory is old (not in `recency`) — only the GIN query finds it.
    const old = mem(999, {
      content: 'Frontpoint prefers PDF updates',
      created_at: '2026-01-01T00:00:00.000Z',
      metadata: { entities: [{ kind: 'org', name: 'Frontpoint' }] },
    });
    const vocab = [{ kind: 'org', email: null, name: 'Frontpoint' }];
    const { fn } = fakeQuery({ recency, vocab, matched: [old] });

    const out = await loadRelevantMemories('chat-x', {
      limit: 20, turnText: 'how is Frontpoint doing?', query: fn,
    });
    assert.equal(out[0].id, 999, 'entity-matched memory ranks first');
    assert.ok(out.some((m) => m.id === 999), 'recalled within the budget despite being oldest');
    assert.ok(out.length <= 20);
  });

  it('no turnText → returns recency only, never queries vocab/match', async () => {
    const recency = [mem(1), mem(2)];
    const { fn, calls } = fakeQuery({ recency });
    const out = await loadRelevantMemories('chat-x', { limit: 20, query: fn });
    assert.deepEqual(out.map((m) => m.id), [1, 2]);
    assert.equal(calls.length, 1, 'only the recency query runs');
  });

  it('turn names no known entity → recency, no containment query', async () => {
    const recency = [mem(1)];
    const { fn, calls } = fakeQuery({ recency, vocab: [{ kind: 'org', name: 'Acme' }] });
    await loadRelevantMemories('chat-x', { limit: 20, turnText: 'what time is it?', query: fn });
    assert.ok(!calls.some((c) => /metadata->'entities' @>/.test(c.sql)), 'no GIN containment query when nothing detected');
  });

  it('dedups a memory present in both recency and the entity match', async () => {
    const shared = mem(7, { metadata: { entities: [{ kind: 'org', name: 'Acme' }] } });
    const { fn } = fakeQuery({
      recency: [shared, mem(8)],
      vocab: [{ kind: 'org', name: 'Acme' }],
      matched: [shared],
    });
    const out = await loadRelevantMemories('chat-x', { limit: 20, turnText: 'Acme update', query: fn });
    assert.equal(out.filter((m) => m.id === 7).length, 1, 'id 7 appears once');
  });
});

describe('OPT-134 loadMemoriesByEntities probe building', () => {
  it('emits a lowercased-email containment probe and GIN-friendly OR query', async () => {
    const { fn, calls } = fakeQuery({ matched: [] });
    const detected = new Set(['person:kevin@empire.co']);
    const vocab = [{ kind: 'person', email: 'kevin@empire.co', name: 'Kevin' }];
    await loadMemoriesByEntities('chat-x', detected, vocab, 20, fn);
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /metadata->'entities' @> \$2::jsonb/);
    assert.deepEqual(JSON.parse(calls[0].params[1]), [{ email: 'kevin@empire.co' }]);
  });

  it('uses a name probe when the entity has no email; returns [] with no probes', async () => {
    const nameCall = fakeQuery({ matched: [] });
    await loadMemoriesByEntities('x', new Set(['org:acme']), [{ kind: 'org', name: 'Acme' }], 10, nameCall.fn);
    assert.deepEqual(JSON.parse(nameCall.calls[0].params[1]), [{ name: 'Acme' }]);

    const noProbe = fakeQuery({ matched: [] });
    const out = await loadMemoriesByEntities('x', new Set(['org:unknown']), [{ kind: 'org', name: 'Acme' }], 10, noProbe.fn);
    assert.deepEqual(out, []);
    assert.equal(noProbe.calls.length, 0, 'no query when nothing matches the vocab');
  });
});
