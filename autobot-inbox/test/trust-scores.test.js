// OPT-82: per-agent trust-score materialized view (migration 168) + read path.
//
// Pins the structural contract: the MV is keyed one-row-per-agent, every
// component is a deterministic aggregate over observable audit tables, and the
// composite trust_score is the documented weighted mean over only the components
// that have evidence. Also verifies the read path shapes rows correctly.

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';
import {
  getTrustScores,
  getAgentTrustScore,
  refreshTrustScores,
} from '../src/runtime/trust-scores.js';

describe('OPT-82 — agent trust-score materialized view', () => {
  let query;
  const AID = 'executor-responder';

  before(async () => {
    ({ query } = await getDb());

    // Seed OBSERVABLE signals for one agent with hand-computable components.
    // gate: 8 healthy + 2 failure transitions -> gate_pass_rate = 0.80
    for (let i = 0; i < 8; i++) {
      await query(
        `INSERT INTO agent_graph.state_transitions
           (work_item_id, from_state, to_state, agent_id, config_hash)
         VALUES ('w', 'assigned', 'completed', $1, 'h')`,
        [AID]
      );
    }
    for (let i = 0; i < 2; i++) {
      await query(
        `INSERT INTO agent_graph.state_transitions
           (work_item_id, from_state, to_state, agent_id, config_hash)
         VALUES ('w', 'in_progress', 'failed', $1, 'h')`,
        [AID]
      );
    }
    // retro: 9 success / 10 runs -> retro_outcome_rate = 0.90
    await query(
      `INSERT INTO agent_graph.skill_performance
         (agent_id, event_type, tool_name, total_runs, success_count, fail_count)
       VALUES ($1, 'email', '_task', 10, 9, 1)
       ON CONFLICT (agent_id, event_type, tool_name)
       DO UPDATE SET total_runs = 10, success_count = 9, fail_count = 1`,
      [AID]
    );
    // retry: 2 completed items, retry_count 0 -> retry_health = 1.00
    await query(
      `INSERT INTO agent_graph.work_items
         (id, type, title, status, assigned_to, created_by, retry_count, updated_at)
       VALUES ('opt82_wi_a', 'task', 't', 'completed', $1, 'orchestrator', 0, now())`,
      [AID]
    );
    await query(
      `INSERT INTO agent_graph.work_items
         (id, type, title, status, assigned_to, created_by, retry_count, updated_at)
       VALUES ('opt82_wi_b', 'task', 't', 'completed', $1, 'orchestrator', 0, now())`,
      [AID]
    );
    // cost: 4 low-variance invocations -> high cost_stability
    let n = 0;
    for (const c of [0.010, 0.011, 0.009, 0.010]) {
      await query(
        `INSERT INTO agent_graph.llm_invocations
           (agent_id, task_id, model, input_tokens, output_tokens, cost_usd,
            prompt_hash, response_hash, idempotency_key)
         VALUES ($1, 't', 'm', 10, 10, $2, 'p', 'r', $3)`,
        [AID, c, 'opt82_k_' + n++]
      );
    }

    await refreshTrustScores();
  });

  it('creates the materialized view keyed per agent (one row per agent)', async () => {
    const dup = await query(
      `SELECT agent_id, COUNT(*) AS c
         FROM agent_graph.agent_trust_scores
        GROUP BY agent_id HAVING COUNT(*) > 1`
    );
    assert.equal(dup.rows.length, 0, 'agent_trust_scores must have at most one row per agent');
  });

  it('ships a UNIQUE index so REFRESH ... CONCURRENTLY is legal', async () => {
    const idx = await query(
      `SELECT indexdef
         FROM pg_indexes
        WHERE schemaname = 'agent_graph'
          AND tablename = 'agent_trust_scores'
          AND indexdef ILIKE '%UNIQUE%'`
    );
    assert.ok(idx.rows.length >= 1, 'a UNIQUE index on agent_id is required for CONCURRENTLY refresh');
  });

  it('computes each component as the documented deterministic aggregate', async () => {
    const row = await getAgentTrustScore(AID);
    assert.ok(row, 'seeded agent must appear');
    assert.equal(Number(row.components.gate_pass_rate.toFixed(2)), 0.80);
    assert.equal(Number(row.components.retro_outcome_rate.toFixed(2)), 0.90);
    assert.equal(Number(row.components.retry_health.toFixed(2)), 1.00);
    assert.ok(row.components.cost_stability > 0.8, 'low cost variance -> high stability');
  });

  it('composite trust_score is the weighted mean over present components', async () => {
    const row = await getAgentTrustScore(AID);
    const c = row.components;
    const expected =
      0.40 * c.gate_pass_rate +
      0.25 * c.retro_outcome_rate +
      0.20 * c.retry_health +
      0.15 * c.cost_stability;
    assert.equal(Number(row.trust_score.toFixed(4)), Number(expected.toFixed(4)));
    assert.ok(row.trust_score >= 0 && row.trust_score <= 1, 'score in [0,1]');
  });

  it('carries evidence volume (sample_size > 0 for a seeded agent)', async () => {
    const row = await getAgentTrustScore(AID);
    assert.ok(row.evidence.sample_size > 0);
    assert.equal(
      row.evidence.sample_size,
      row.evidence.gate_transitions + row.evidence.retro_runs +
        row.evidence.retry_items + row.evidence.cost_invocations
    );
  });

  it('returns NULL score (not 0) for an agent with no observable evidence', async () => {
    // architect is a real config'd agent we did not seed.
    const row = await getAgentTrustScore('architect');
    assert.ok(row, 'all config agents appear in the MV');
    assert.equal(row.trust_score, null, 'no evidence -> NULL, never a fabricated 0');
    assert.equal(row.evidence.sample_size, 0);
  });

  it('getTrustScores orders by score desc, NULLs last', async () => {
    const all = await getTrustScores();
    assert.ok(all.length >= 1);
    const scored = all.filter((r) => r.trust_score !== null);
    for (let i = 1; i < scored.length; i++) {
      assert.ok(scored[i - 1].trust_score >= scored[i].trust_score, 'descending by score');
    }
    // any NULL-score rows must come after all scored rows
    const firstNull = all.findIndex((r) => r.trust_score === null);
    if (firstNull !== -1) {
      assert.ok(all.slice(firstNull).every((r) => r.trust_score === null), 'NULLs grouped last');
    }
  });

  it('unknown agent returns null from the read path', async () => {
    const row = await getAgentTrustScore('no-such-agent-xyz');
    assert.equal(row, null);
  });
});
