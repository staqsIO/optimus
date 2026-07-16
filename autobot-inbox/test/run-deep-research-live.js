#!/usr/bin/env node
/**
 * Live test: runs the deep research handler with real LLM + real Brave search.
 *
 * Usage: DATABASE_URL=postgresql://autobot:autobot@localhost:5432/autobot node test/run-deep-research-live.js "topic here"
 *
 * This creates a work item, runs the handler, and prints the report.
 * Budget: $3.00 max, 5 iterations max (configurable below).
 */
import { query } from '../src/db.js';
import { deepResearchHandler } from '../src/agents/research/deep-research-handler.js';
import { AgentLoop } from '../src/runtime/agent-loop.js';

const topic = process.argv.slice(2).join(' ') || 'governed AI agent organizations — coordination patterns and safety mechanisms';
const MAX_ITERATIONS = 5;
const MAX_COST_USD = 1.50;

console.log(`\n🔬 Deep Research: "${topic}"`);
console.log(`   Budget: $${MAX_COST_USD} | Max iterations: ${MAX_ITERATIONS}\n`);

// Create work item directly
const { rows: [item] } = await query(
  `INSERT INTO agent_graph.work_items
   (type, title, description, created_by, assigned_to, priority, status, metadata)
   VALUES ('workstream', $1, $2, 'board', 'executor-research', 1, 'in_progress', $3)
   RETURNING id`,
  [
    `Deep Research: ${topic}`,
    `Live test: iterative web research on ${topic}`,
    JSON.stringify({
      research_type: 'deep_research',
      research_plan: {
        objective: topic,
        hypotheses: [],
        focus_areas: [topic],
        constraints: { max_iterations: MAX_ITERATIONS, max_cost_usd: MAX_COST_USD },
      },
    }),
  ]
);

console.log(`   Work item: ${item.id}\n`);

// Use AgentLoop's callLLM (real Anthropic client with cost tracking)
const loop = new AgentLoop('executor-research', () => {});

const context = {
  workItem: (await query('SELECT * FROM agent_graph.work_items WHERE id = $1', [item.id])).rows[0],
};

const start = Date.now();
const result = await deepResearchHandler({ work_item_id: item.id }, context, loop);
const elapsed = ((Date.now() - start) / 1000).toFixed(1);

console.log(`\n${'='.repeat(60)}`);
console.log(`Result: ${result.success ? '✅ SUCCESS' : '❌ FAILED'}`);
console.log(`Reason: ${result.reason}`);
console.log(`Cost: $${result.costUsd.toFixed(4)} | Time: ${elapsed}s`);

// Print the report if one was generated
const { rows: proposals } = await query(
  `SELECT body FROM agent_graph.action_proposals WHERE work_item_id = $1 AND action_type = 'research_report'`,
  [item.id]
);

if (proposals.length > 0) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(proposals[0].body);
}

// Print iteration summary
const { rows: iters } = await query(
  `SELECT iteration_num, decision, coverage_score, delta_score, cost_usd, duration_ms
   FROM agent_graph.research_iterations WHERE workstream_id = $1 ORDER BY iteration_num`,
  [item.id]
);

if (iters.length > 0) {
  console.log(`\n${'='.repeat(60)}`);
  console.log('Iteration Summary:');
  for (const r of iters) {
    console.log(`  iter ${r.iteration_num}: ${r.decision} | coverage=${parseFloat(r.coverage_score).toFixed(2)} delta=${r.delta_score} cost=$${parseFloat(r.cost_usd).toFixed(4)} time=${r.duration_ms}ms`);
  }
}

process.exit(0);
