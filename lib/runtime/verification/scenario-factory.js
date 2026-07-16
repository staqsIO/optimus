import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { query, withTransaction } from '../../db.js';
import { createLLMClient, callProvider } from '../../llm/provider.js';
import { createChildLogger } from '../../logger.js';

const log = createChildLogger({ component: 'scenario-factory' });

const __dirname = dirname(fileURLToPath(import.meta.url));

// Cheap, structured generation. Haiku is sufficient for turning an intent into
// concrete observable scenarios.
const FACTORY_MODEL = 'claude-haiku-4-5-20251001';
const MAX_OUTPUT_TOKENS = 2000;

/**
 * Scenario Factory — Phase 1 of the verification spine.
 *
 * Turns a work item's INTENT into a set of observable success scenarios
 * (given/when/then), splits them into happy-path (visible to the implementer)
 * and edge-case (WITHHELD — checked only by the Tester so the implementer can't
 * game the spec), persists both, and mirrors the visible set into
 * work_items.acceptance_criteria.
 *
 * Idempotency is gated on acceptance_criteria carrying our stamp — NOT on
 * counting work_item_scenarios rows, because that table FORCE-hides withheld
 * rows from any non-tester app.agent_id (this code runs under the creating
 * agent's context), which would undercount and regenerate forever.
 */

const EMIT_SCENARIOS_TOOL = {
  name: 'emit_scenarios',
  description:
    'Emit the verification scenarios for this work item. You MUST call this tool to deliver your output. ' +
    'Each scenario is an OBSERVABLE outcome, not a unit test: a concrete given/when/then a human (or an agent ' +
    'driving the real artifact) could check. Produce 3-6 happy_path scenarios and 2-4 edge_case scenarios.',
  input_schema: {
    type: 'object',
    required: ['scenarios'],
    properties: {
      scenarios: {
        type: 'array',
        description: 'The verification scenarios. Concrete and observable — name real inputs and expected results.',
        items: {
          type: 'object',
          required: ['given', 'when', 'then', 'category'],
          properties: {
            given: { type: 'string', description: 'Preconditions / starting state.' },
            when: { type: 'string', description: 'The action taken.' },
            then: { type: 'string', description: 'The observable expected outcome.' },
            category: {
              type: 'string',
              enum: ['happy_path', 'edge_case'],
              description:
                'happy_path = core expected behavior (shown to the implementer). ' +
                'edge_case = boundary/failure behavior (WITHHELD; checked only by the tester).',
            },
          },
        },
      },
    },
  },
};

function loadModelsConfig() {
  const candidates = [
    join(__dirname, '..', '..', '..', 'autobot-inbox', 'config', 'agents.json'),
    join(process.cwd(), 'autobot-inbox', 'config', 'agents.json'),
    join(process.cwd(), 'config', 'agents.json'),
  ];
  for (const p of candidates) {
    try {
      return JSON.parse(readFileSync(p, 'utf-8'));
    } catch {
      /* try next */
    }
  }
  throw new Error('scenario-factory: could not locate autobot-inbox/config/agents.json');
}

/**
 * @param {object} opts
 * @param {string} opts.workItemId
 * @param {string} opts.intent              - The task's intent (title + description).
 * @param {string} [opts.dataClassification]
 * @returns {Promise<{visible: object[], withheld: object[], generated: boolean, costUsd: number}>}
 */
export async function generateScenarios({ workItemId, intent, dataClassification = 'INTERNAL' }) {
  if (!workItemId || !intent) {
    throw new Error('scenario-factory: workItemId and intent are required');
  }

  // Idempotency: if we already stamped acceptance_criteria, return the visible
  // set without regenerating. (Withheld rows are RLS-hidden here, so we report
  // them as empty; only the tester ever needs to read them back.)
  const existing = await query(
    `SELECT acceptance_criteria FROM agent_graph.work_items WHERE id = $1`,
    [workItemId]
  );
  const ac = existing.rows[0]?.acceptance_criteria;
  if (ac && ac.generated_by === 'scenario-factory' && Array.isArray(ac.scenarios)) {
    return { visible: ac.scenarios, withheld: [], generated: false, costUsd: 0 };
  }

  const modelsConfig = loadModelsConfig();
  const llm = createLLMClient(FACTORY_MODEL, modelsConfig.models);

  const system =
    'You generate verification scenarios for autonomous agents. Given a task intent, produce concrete, ' +
    'observable success scenarios. Withhold harder edge cases as a separate category so they can verify ' +
    'work the implementer never saw. Never restate the intent; produce checkable outcomes.';
  const user =
    `Work item intent:\n${intent}\n\nData classification: ${dataClassification}\n\n` +
    'Emit happy_path scenarios (the core behavior) and edge_case scenarios (boundaries, failure modes, ' +
    'and anything an implementer might cut a corner on). Call emit_scenarios.';

  const response = await callProvider(llm, {
    system,
    messages: [{ role: 'user', content: user }],
    maxTokens: MAX_OUTPUT_TOKENS,
    temperature: 0.3,
    tools: [EMIT_SCENARIOS_TOOL],
    toolChoice: { type: 'tool', name: 'emit_scenarios' },
  });

  const toolCall = (response.toolCalls || []).find((t) => t.name === 'emit_scenarios');
  const scenarios = toolCall?.input?.scenarios;
  if (!Array.isArray(scenarios) || scenarios.length === 0) {
    throw new Error('scenario-factory: model did not emit any scenarios');
  }

  // Withhold every edge_case; happy_path is visible to the implementer.
  const visible = scenarios.filter((s) => s.category === 'happy_path');
  const withheld = scenarios.filter((s) => s.category === 'edge_case');

  const costUsd =
    (response.inputTokens || 0) * 0.25 / 1_000_000 +
    (response.outputTokens || 0) * 1.25 / 1_000_000;

  await withTransaction(async (client) => {
    for (const s of scenarios) {
      await client.query(
        `INSERT INTO agent_graph.work_item_scenarios (work_item_id, scenario, withheld, category)
         VALUES ($1, $2, $3, $4)`,
        [
          workItemId,
          JSON.stringify({ given: s.given, when: s.when, then: s.then }),
          s.category === 'edge_case',
          s.category,
        ]
      );
    }
    // Mirror ONLY the visible scenarios into acceptance_criteria (the implementer
    // reads this; it must never contain withheld scenarios).
    await client.query(
      `UPDATE agent_graph.work_items
       SET acceptance_criteria = $2, updated_at = now()
       WHERE id = $1`,
      [
        workItemId,
        JSON.stringify({
          generated_by: 'scenario-factory',
          scenarios: visible.map((s) => ({ given: s.given, when: s.when, then: s.then })),
        }),
      ]
    );
  });

  log.info(
    `generated ${scenarios.length} scenarios for ${workItemId} (${visible.length} visible, ${withheld.length} withheld), cost $${costUsd.toFixed(4)}`
  );

  return { visible, withheld, generated: true, costUsd };
}
