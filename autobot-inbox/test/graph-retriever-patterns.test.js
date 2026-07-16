/**
 * OPT-2 loop closure — lib/rag/graph-retriever.js consumes
 * agent_graph.learned_patterns.
 *
 * pattern-extractor.js writes learned_patterns but, until OPT-2, nothing read
 * them — detection never influenced behavior. These tests prove a detected
 * pattern is now surfaced into retrieval context (and that it surfaces even
 * with Neo4j unavailable, which is the case in the test env).
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';
import { searchLearnedPatterns, searchGraph } from '../../lib/rag/graph-retriever.js';

describe('graph-retriever consumes learned_patterns (OPT-2)', () => {
  let query;

  before(async () => {
    ({ query } = await getDb());
    await query(`DELETE FROM agent_graph.learned_patterns WHERE agent_id = 'opt2-test-agent'`);
    await query(
      `INSERT INTO agent_graph.learned_patterns
         (agent_id, pattern_type, description, metric_value, confidence, sample_size, period_start, period_end)
       VALUES
         ('opt2-test-agent', 'success_rate',
          'Responder succeeds 92% on short threads', 0.92, 0.90, 40,
          now() - interval '7 days', now()),
         ('opt2-test-agent', 'failure_mode',
          'Stale pattern, low confidence', 0.10, 0.20, 3,
          now() - interval '7 days', now())`,
    );
  });

  it('searchLearnedPatterns returns recent, confident patterns only', async () => {
    const rows = await searchLearnedPatterns('any query', 5);
    const mine = rows.filter((r) => r.metadata.agent_id === 'opt2-test-agent');

    // The 0.20-confidence row is filtered out (threshold 0.4).
    assert.equal(mine.length, 1, 'only the confident pattern surfaces');
    assert.equal(mine[0].source, 'learned_pattern');
    assert.equal(mine[0].metadata.pattern_type, 'success_rate');
    assert.match(mine[0].text, /Responder succeeds 92%/);
  });

  it('searchGraph surfaces a learned pattern even when Neo4j is unavailable', async () => {
    // No NEO4J in the test env → isGraphAvailable() is false; Strategy 0 still runs.
    const results = await searchGraph('plan the next responder task', 5);
    const patterns = results.filter((r) => r.source === 'learned_pattern');
    assert.ok(patterns.length >= 1, 'at least one detected pattern reaches retrieval (loop closed)');
  });
});
