/**
 * Integration test: flow: prefix routing through FlowToolRegistry.
 *
 * Verifies that attachFlowWrappers() routes `flow:*` agentIds through the
 * shared runner (flow-agents/shared/runner.js) rather than the pipeline
 * wrapper map. The existing (pipeline) routing path stays intact.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { FlowToolRegistry } from '../../lib/runtime/tool-registry.js';
import { attachFlowWrappers } from '../src/flow-wrappers/index.js';
import { setLLMImpl, resetLLMImpl } from '../agents/flow-agents/shared/llm.js';

afterEach(() => resetLLMImpl());

function makeRegistry() {
  const reg = new FlowToolRegistry(null);
  attachFlowWrappers(reg);
  // Register the flow-agent tool the way autobot-inbox/tools/registry.js does.
  reg.register('summarize', { mode: 'agent', agentId: 'flow:summarize' });
  reg.register('classify_text', { mode: 'agent', agentId: 'flow:classify_text' });
  return reg;
}

describe('flow: prefix dispatch', () => {
  it('routes flow:summarize through the shared runner', async () => {
    const calls = [];
    setLLMImpl(async (args) => {
      calls.push(args);
      return { text: 'mocked summary', inputTokens: 10, outputTokens: 5, costUsd: 0.0001 };
    });

    const reg = makeRegistry();
    const result = await reg.dispatch('summarize', {}, { text: 'hello world' });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, 'claude-haiku-4-5-20251001');
    assert.deepEqual(result, { summary: 'mocked summary' });
  });

  it('routes flow:classify_text through the shared runner with JSON parsing', async () => {
    setLLMImpl(async () => ({
      text: JSON.stringify({ category: 'urgent', confidence: 0.9, rationale: 'deadline' }),
      inputTokens: 20, outputTokens: 10, costUsd: 0.0002,
    }));

    const reg = makeRegistry();
    const result = await reg.dispatch('classify_text', {}, {
      text: 'respond by noon',
      categories: ['urgent', 'fyi', 'spam'],
    });

    assert.deepEqual(result, { category: 'urgent', confidence: 0.9, rationale: 'deadline' });
  });

  it('throws a clear error for unknown flow: ids', async () => {
    const reg = makeRegistry();
    reg.register('bogus', { mode: 'agent', agentId: 'flow:bogus' });
    await assert.rejects(
      reg.dispatch('bogus', {}, {}),
      /Unknown flow-agent: "flow:bogus"/
    );
  });

  it('still routes un-prefixed agentIds to the pipeline wrapper map (not the runner)', async () => {
    const reg = makeRegistry();
    reg.register('dummy', { mode: 'agent', agentId: 'executor-does-not-exist' });
    // Pipeline agent not in the wrappers map -> original error path still fires.
    await assert.rejects(
      reg.dispatch('dummy', {}, {}),
      /No flow wrapper registered for agent "executor-does-not-exist"/
    );
  });
});
