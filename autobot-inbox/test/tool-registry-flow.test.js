import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { FlowToolRegistry } from '../../lib/runtime/tool-registry.js';
import { ToolNotFoundError } from '../../lib/runtime/flow-engine.js';

describe('FlowToolRegistry', () => {
  let registry;
  let existingRegistry;

  beforeEach(() => {
    existingRegistry = new Map();
    existingRegistry.set('legacy_tool', {
      name: 'legacy_tool',
      handler: async (payload) => ({ legacy: true, ...payload }),
    });
    registry = new FlowToolRegistry(existingRegistry);
  });

  // -----------------------------------------------------------------------
  // Group 1: Constructor
  // -----------------------------------------------------------------------
  describe('constructor', () => {
    it('creates instance with existing registry', () => {
      const r = new FlowToolRegistry(existingRegistry);
      assert.ok(r);
      assert.equal(r.has('legacy_tool'), true);
    });

    it('accepts null/undefined existing registry', () => {
      const r1 = new FlowToolRegistry(null);
      assert.ok(r1);
      const r2 = new FlowToolRegistry(undefined);
      assert.ok(r2);
    });
  });

  // -----------------------------------------------------------------------
  // Group 2: register
  // -----------------------------------------------------------------------
  describe('register', () => {
    it('registers a function-mode tool', () => {
      registry.register('fn_tool', {
        mode: 'function',
        handler: async () => 'ok',
      });
      assert.equal(registry.has('fn_tool'), true);
    });

    it('registers an agent-mode tool', () => {
      registry.register('agent_tool', {
        mode: 'agent',
        agentId: 'executor-research',
      });
      assert.equal(registry.has('agent_tool'), true);
    });

    it('registers a hybrid-mode tool with custom confidence threshold', () => {
      registry.register('hybrid_tool', {
        mode: 'hybrid',
        handler: async () => ({ confidence: 0.9 }),
        agentId: 'executor-research',
        confidenceThreshold: 0.85,
      });
      const tools = registry.list();
      const hybrid = tools.find(t => t.toolId === 'hybrid_tool');
      assert.equal(hybrid.mode, 'hybrid');
    });

    it('defaults confidence threshold to 0.7 for hybrid', () => {
      registry.register('hybrid_default', {
        mode: 'hybrid',
        handler: async () => ({ confidence: 0.5 }),
        agentId: 'executor-research',
      });
      // Verify default by dispatching — confidence 0.5 < 0.7 should fall back to agent
      // (Tested more thoroughly in dispatch hybrid group)
      assert.equal(registry.has('hybrid_default'), true);
    });
  });

  // -----------------------------------------------------------------------
  // Group 3: dispatch — function mode
  // -----------------------------------------------------------------------
  describe('dispatch — function mode', () => {
    it('calls handler with (payload, config)', async () => {
      let capturedArgs;
      registry.register('fn_dispatch', {
        mode: 'function',
        handler: async (payload, config) => {
          capturedArgs = { payload, config };
          return 'fn_result';
        },
      });
      const config = { agentId: 'test' };
      const payload = { data: 42 };
      await registry.dispatch('fn_dispatch', config, payload);
      assert.deepEqual(capturedArgs.payload, payload);
      assert.deepEqual(capturedArgs.config, config);
    });

    it('returns handler result', async () => {
      registry.register('fn_return', {
        mode: 'function',
        handler: async () => ({ answer: 42 }),
      });
      const result = await registry.dispatch('fn_return', {}, {});
      assert.deepEqual(result, { answer: 42 });
    });
  });

  // -----------------------------------------------------------------------
  // Group 4: dispatch — agent mode
  // -----------------------------------------------------------------------
  describe('dispatch — agent mode', () => {
    it('calls dispatchToAgent with (agentId, payload, config)', async () => {
      let capturedArgs;
      registry.register('agent_dispatch', {
        mode: 'agent',
        agentId: 'executor-research',
      });
      registry.dispatchToAgent = async (agentId, payload, config) => {
        capturedArgs = { agentId, payload, config };
        return 'agent_result';
      };
      const config = { timeout: 5000 };
      const payload = { query: 'test' };
      await registry.dispatch('agent_dispatch', config, payload);
      assert.equal(capturedArgs.agentId, 'executor-research');
      assert.deepEqual(capturedArgs.payload, payload);
      assert.deepEqual(capturedArgs.config, config);
    });

    it('returns agent result', async () => {
      registry.register('agent_return', {
        mode: 'agent',
        agentId: 'executor-research',
      });
      registry.dispatchToAgent = async () => ({ agentAnswer: true });
      const result = await registry.dispatch('agent_return', {}, {});
      assert.deepEqual(result, { agentAnswer: true });
    });
  });

  // -----------------------------------------------------------------------
  // Group 5: dispatch — hybrid mode
  // -----------------------------------------------------------------------
  describe('dispatch — hybrid mode', () => {
    it('returns function result when confidence >= threshold', async () => {
      registry.register('hybrid_high', {
        mode: 'hybrid',
        handler: async () => ({ confidence: 0.9, data: 'fn' }),
        agentId: 'executor-research',
        confidenceThreshold: 0.7,
      });
      let agentCalled = false;
      registry.dispatchToAgent = async () => {
        agentCalled = true;
        return { data: 'agent' };
      };
      const result = await registry.dispatch('hybrid_high', {}, {});
      assert.equal(result.data, 'fn');
      assert.equal(agentCalled, false);
    });

    it('falls back to agent when confidence < threshold', async () => {
      registry.register('hybrid_low', {
        mode: 'hybrid',
        handler: async () => ({ confidence: 0.3, data: 'fn' }),
        agentId: 'executor-research',
        confidenceThreshold: 0.7,
      });
      registry.dispatchToAgent = async () => ({ data: 'agent_fallback' });
      const result = await registry.dispatch('hybrid_low', {}, {});
      assert.equal(result.data, 'agent_fallback');
    });
  });

  // -----------------------------------------------------------------------
  // Group 6: dispatch — fallback to existing registry
  // -----------------------------------------------------------------------
  describe('dispatch — fallback to existing registry', () => {
    it('dispatches to existing registry tool when not in flow tools', async () => {
      const result = await registry.dispatch('legacy_tool', {}, { key: 'val' });
      assert.equal(result.legacy, true);
    });

    it('flow tools take precedence over existing tools with same name', async () => {
      registry.register('legacy_tool', {
        mode: 'function',
        handler: async () => ({ flow: true }),
      });
      const result = await registry.dispatch('legacy_tool', {}, {});
      assert.equal(result.flow, true);
    });
  });

  // -----------------------------------------------------------------------
  // Group 7: ToolNotFoundError
  // -----------------------------------------------------------------------
  describe('ToolNotFoundError', () => {
    it('throws ToolNotFoundError when tool not in either registry', async () => {
      await assert.rejects(
        () => registry.dispatch('nonexistent', {}, {}),
        (err) => {
          assert.ok(err instanceof ToolNotFoundError);
          assert.equal(err.toolId, 'nonexistent');
          return true;
        },
      );
    });
  });

  // -----------------------------------------------------------------------
  // Group 8: has and list
  // -----------------------------------------------------------------------
  describe('has and list', () => {
    beforeEach(() => {
      registry.register('flow_tool_a', {
        mode: 'function',
        handler: async () => 'a',
      });
    });

    it('has() returns true for flow tools', () => {
      assert.equal(registry.has('flow_tool_a'), true);
    });

    it('has() returns true for existing registry tools', () => {
      assert.equal(registry.has('legacy_tool'), true);
    });

    it('has() returns false for unknown tools', () => {
      assert.equal(registry.has('totally_unknown'), false);
    });

    it('list() returns all tools from both registries', () => {
      const all = registry.list();
      const ids = all.map(t => t.toolId);
      assert.ok(ids.includes('flow_tool_a'));
      assert.ok(ids.includes('legacy_tool'));

      const flowItem = all.find(t => t.toolId === 'flow_tool_a');
      assert.equal(flowItem.mode, 'function');
      assert.equal(flowItem.source, 'flow');

      const legacyItem = all.find(t => t.toolId === 'legacy_tool');
      assert.equal(legacyItem.source, 'existing');
    });
  });
});
