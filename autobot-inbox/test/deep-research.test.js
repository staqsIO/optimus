/**
 * Integration test for the deep research handler.
 *
 * Tests the iteration loop with:
 * - Real DB (Docker Postgres via DATABASE_URL)
 * - Mocked LLM (no API key needed)
 * - No web search (BRAVE_API_KEY unset — graceful degradation)
 *
 * Run: DATABASE_URL=postgresql://autobot:autobot@localhost:5432/autobot node --test test/deep-research.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';

let query;

let deepResearchHandler;

// Mock agent with fake callLLM
function createMockAgent(responses = []) {
  let callIndex = 0;
  return {
    callLLM: async (_system, _user, _opts) => {
      const resp = responses[callIndex] || responses[responses.length - 1];
      callIndex++;
      return {
        text: typeof resp === 'string' ? resp : JSON.stringify(resp),
        inputTokens: 100,
        outputTokens: 200,
        costUsd: 0.001,
        latencyMs: 50,
        stopReason: 'end_turn',
      };
    },
  };
}

// Insert a work item directly (bypasses state machine FK constraints)
async function insertWorkItem(topic, opts = {}) {
  const maxIter = opts.maxIterations ?? 3;
  const maxCost = opts.maxCostUsd ?? 1.00;
  const focusAreas = opts.focusAreas || [topic];
  const checkpointIter = opts.checkpointIteration ?? undefined;

  const metadata = {
    research_type: 'deep_research',
    research_plan: {
      objective: topic,
      hypotheses: [],
      focus_areas: focusAreas,
      constraints: { max_iterations: maxIter, max_cost_usd: maxCost },
    },
  };
  if (checkpointIter !== undefined) {
    metadata.checkpoint_iteration = checkpointIter;
  }

  const result = await query(
    `INSERT INTO agent_graph.work_items
     (type, title, description, created_by, assigned_to, priority, status, metadata)
     VALUES ('workstream', $1, $2, 'board', 'executor-research', 1, 'in_progress', $3)
     RETURNING id`,
    [`Test: ${topic}`, `Test research: ${topic}`, JSON.stringify(metadata)]
  );
  return result.rows[0].id;
}

async function cleanup(itemId) {
  if (!itemId) return;
  await query('DELETE FROM agent_graph.research_iterations WHERE workstream_id = $1', [itemId]);
  await query('DELETE FROM agent_graph.research_outputs WHERE workstream_id = $1', [itemId]).catch(() => {});
  await query('DELETE FROM agent_graph.action_proposals WHERE work_item_id = $1', [itemId]);
  await query('DELETE FROM agent_graph.state_transitions WHERE work_item_id = $1', [itemId]);
  await query('DELETE FROM agent_graph.work_items WHERE id = $1', [itemId]);
}

describe('deep-research-handler', () => {
  let workItemId;

  before(async () => {
    ({ query } = await getDb());

    // Verify DB
    const { rows } = await query('SELECT 1 AS ok');
    assert.equal(rows[0].ok, 1);

    // Verify table exists
    const t = await query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables
       WHERE table_schema='agent_graph' AND table_name='research_iterations') AS e`
    );
    if (!t.rows[0].e) {
      console.log('[deep-research] Skipping: research_iterations table not found (sql/038-deep-research.sql not applied)');
      return; // before() returning without seeding causes tests to skip gracefully
    }

    // Ensure executor-research + board exist in agent_configs
    for (const [id, type] of [['executor-research', 'executor'], ['board', 'orchestrator']]) {
      await query(
        `INSERT INTO agent_graph.agent_configs (id, agent_type, model, system_prompt, tools_allowed, config_hash)
         VALUES ($1, $2, 'test', 'test', ARRAY[]::text[], $3)
         ON CONFLICT (id) DO NOTHING`,
        [id, type, `hash-${id}`]
      );
    }

    const mod = await import('../src/agents/research/deep-research-handler.js');
    deepResearchHandler = mod.deepResearchHandler;
  });

  it('rejects missing research_plan.objective', async () => {
    const result = await deepResearchHandler(
      { work_item_id: 'fake-id' },
      { workItem: { metadata: {} } },
      createMockAgent()
    );
    assert.equal(result.success, false);
    assert.match(result.reason, /No research_plan.objective/);
  });

  it('runs iterations with mock LLM, early-stops on coverage, produces report', async () => {
    // 2 focus areas → coverage reaches 1.0 after 2 iterations (one finding per area)
    // Handler correctly early-stops at coverage >= 0.85
    workItemId = await insertWorkItem('agent swarm coordination', {
      maxIterations: 5,
      focusAreas: ['swarm coordination', 'consensus mechanisms'],
    });

    const mockResponses = [
      // iter 0: plan
      { hypothesis: 'Stigmergy for coordination', queries: ['stigmergy agents', 'swarm consensus'] },
      // iter 0: synth — covers 'swarm coordination' (1/2 = 0.5)
      { findings: [{ focus_area: 'swarm coordination', claim: 'Stigmergy enables indirect coordination', sources: ['https://ex.com/1'], confidence: 'high' }], new_sources_count: 1, new_claims_count: 1 },
      // iter 1: plan
      { hypothesis: 'PBFT for consensus', queries: ['PBFT multi-agent', 'raft consensus'] },
      // iter 1: synth — covers 'consensus mechanisms' (2/2 = 1.0 → triggers threshold stop)
      { findings: [{ focus_area: 'consensus mechanisms', claim: 'PBFT tolerates f=(n-1)/3 faulty nodes', sources: ['https://ex.com/2'], confidence: 'high' }], new_sources_count: 1, new_claims_count: 1 },
    ];

    const context = {
      workItem: (await query('SELECT * FROM agent_graph.work_items WHERE id = $1', [workItemId])).rows[0],
    };

    const result = await deepResearchHandler(
      { work_item_id: workItemId }, context, createMockAgent(mockResponses)
    );

    assert.equal(result.success, true, `Failed: ${result.reason}`);
    assert.ok(result.costUsd > 0);
    assert.match(result.reason, /2 iterations/);
    assert.match(result.reason, /2 findings/);
    assert.match(result.reason, /coverage_threshold/);

    // Check iteration rows
    const iters = await query(
      'SELECT * FROM agent_graph.research_iterations WHERE workstream_id = $1 ORDER BY iteration_num',
      [workItemId]
    );
    assert.equal(iters.rows.length, 2);
    for (const row of iters.rows) {
      assert.equal(row.decision, 'kept');
    }

    // Check coverage monotonically non-decreasing
    const coverages = iters.rows.map(r => parseFloat(r.coverage_score));
    assert.ok(coverages[1] >= coverages[0]);

    // Check canonical research_outputs row was saved (replaces action_proposals path)
    const outputs = await query(
      `SELECT * FROM agent_graph.research_outputs WHERE workstream_id = $1`,
      [workItemId]
    );
    assert.equal(outputs.rows.length, 1);
    const row = outputs.rows[0];
    assert.ok(row.body_md.includes('Deep Research Report'));
    assert.ok(row.body_md.includes('Stigmergy'));
    assert.equal(row.objective, 'agent swarm coordination');
    assert.equal(row.iteration_count, 2);
    assert.equal(row.source_count, 2);
    assert.ok(parseFloat(row.coverage_score) >= 0.85);
    assert.ok(parseFloat(row.confidence) > 0);
    // key_finding picks the highest-confidence claim (both are 'high' here, first wins)
    assert.ok(row.key_finding && row.key_finding.length > 0);
    // Verify nothing was written to action_proposals (research is no longer there)
    const proposals = await query(
      `SELECT * FROM agent_graph.action_proposals WHERE work_item_id = $1 AND action_type = 'research_report'`,
      [workItemId]
    );
    assert.equal(proposals.rows.length, 0);

    await cleanup(workItemId);
    workItemId = null;
  });

  it('stops on budget exhaustion', async () => {
    workItemId = await insertWorkItem('budget test', {
      maxIterations: 10,
      maxCostUsd: 0.002, // $0.001/call × 2 calls/iter → exhausted after iter 0
    });

    const mockResponses = [
      { hypothesis: 'Budget test', queries: ['test'] },
      { findings: [{ focus_area: 'budget test', claim: 'Claim', sources: ['https://ex.com'], confidence: 'low' }], new_sources_count: 1, new_claims_count: 1 },
    ];

    const context = {
      workItem: (await query('SELECT * FROM agent_graph.work_items WHERE id = $1', [workItemId])).rows[0],
    };

    const result = await deepResearchHandler(
      { work_item_id: workItemId }, context, createMockAgent(mockResponses)
    );

    assert.equal(result.success, true);
    assert.match(result.reason, /budget_exhausted/);

    await cleanup(workItemId);
    workItemId = null;
  });

  it('stops on coverage threshold (0.85)', async () => {
    workItemId = await insertWorkItem('coverage test', {
      maxIterations: 10,
      focusAreas: ['single_area'], // 1 focus area → any finding = 100% coverage
    });

    const mockResponses = [
      { hypothesis: 'Cover single area', queries: ['single area'] },
      { findings: [{ focus_area: 'single_area', claim: 'Fully covered', sources: ['https://ex.com'], confidence: 'high' }], new_sources_count: 1, new_claims_count: 1 },
    ];

    const context = {
      workItem: (await query('SELECT * FROM agent_graph.work_items WHERE id = $1', [workItemId])).rows[0],
    };

    const result = await deepResearchHandler(
      { work_item_id: workItemId }, context, createMockAgent(mockResponses)
    );

    assert.equal(result.success, true);
    assert.match(result.reason, /coverage_threshold/);
    assert.match(result.reason, /1 iterations/);

    await cleanup(workItemId);
    workItemId = null;
  });

  it('handles LLM parse errors gracefully', async () => {
    workItemId = await insertWorkItem('parse error test', { maxIterations: 1 });

    const context = {
      workItem: (await query('SELECT * FROM agent_graph.work_items WHERE id = $1', [workItemId])).rows[0],
    };

    // Return garbage — handler should not crash
    const result = await deepResearchHandler(
      { work_item_id: workItemId }, context, createMockAgent(['not json', 'also not json'])
    );

    assert.equal(result.success, true);
    assert.match(result.reason, /1 iterations/);

    await cleanup(workItemId);
    workItemId = null;
  });

  it('resumes from checkpoint with prior kept iterations', async () => {
    workItemId = await insertWorkItem('checkpoint test', {
      maxIterations: 4,
      focusAreas: ['area1', 'area2'],
      checkpointIteration: 2,
    });

    // Simulate 2 prior kept iterations
    for (let i = 0; i < 2; i++) {
      await query(
        `INSERT INTO agent_graph.research_iterations
         (workstream_id, iteration_num, hypothesis, queries, sources, findings,
          coverage_score, delta_score, decision, cost_usd, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          workItemId, i, `Prior hypothesis ${i}`,
          JSON.stringify([`prior query ${i}`]),
          JSON.stringify([]),
          JSON.stringify([{ focus_area: 'area1', claim: `Prior claim ${i}`, sources: ['https://prior.com'], confidence: 'high' }]),
          0.5, 2, 'kept', 0.001, 100,
        ]
      );
    }

    const mockResponses = [
      { hypothesis: 'Resume: cover area2', queries: ['area2 query'] },
      { findings: [{ focus_area: 'area2', claim: 'New finding for area2', sources: ['https://ex.com/resume'], confidence: 'medium' }], new_sources_count: 1, new_claims_count: 1 },
    ];

    const context = {
      workItem: (await query('SELECT * FROM agent_graph.work_items WHERE id = $1', [workItemId])).rows[0],
    };

    const result = await deepResearchHandler(
      { work_item_id: workItemId }, context, createMockAgent(mockResponses)
    );

    assert.equal(result.success, true);
    // 2 prior findings + 1 new = 3
    assert.match(result.reason, /3 findings/);

    // Total iterations in DB should be >= 3
    const iters = await query(
      'SELECT * FROM agent_graph.research_iterations WHERE workstream_id = $1 ORDER BY iteration_num',
      [workItemId]
    );
    assert.ok(iters.rows.length >= 3, `Expected >= 3 rows, got ${iters.rows.length}`);

    await cleanup(workItemId);
    workItemId = null;
  });

  it('discards iteration when delta is 0', async () => {
    // Use 3 focus areas so first iter doesn't hit coverage threshold
    workItemId = await insertWorkItem('discard test', {
      maxIterations: 2,
      focusAreas: ['area_a', 'area_b', 'area_c'],
    });

    const mockResponses = [
      // iter 0: plan
      { hypothesis: 'First pass', queries: ['query1'] },
      // iter 0: synth — yields finding for area_a (1/3 = 0.33 coverage, kept)
      { findings: [{ focus_area: 'area_a', claim: 'Initial claim', sources: ['https://ex.com'], confidence: 'high' }], new_sources_count: 1, new_claims_count: 1 },
      // iter 1: plan
      { hypothesis: 'Second pass', queries: ['query2'] },
      // iter 1: synth — zero delta (discarded)
      { findings: [], new_sources_count: 0, new_claims_count: 0 },
    ];

    const context = {
      workItem: (await query('SELECT * FROM agent_graph.work_items WHERE id = $1', [workItemId])).rows[0],
    };

    const result = await deepResearchHandler(
      { work_item_id: workItemId }, context, createMockAgent(mockResponses)
    );

    assert.equal(result.success, true);

    const iters = await query(
      'SELECT iteration_num, decision FROM agent_graph.research_iterations WHERE workstream_id = $1 ORDER BY iteration_num',
      [workItemId]
    );
    assert.equal(iters.rows.length, 2);
    assert.equal(iters.rows[0].decision, 'kept');
    assert.equal(iters.rows[1].decision, 'discarded');

    await cleanup(workItemId);
    workItemId = null;
  });

  after(async () => {
    if (workItemId) await cleanup(workItemId);
  });
});
