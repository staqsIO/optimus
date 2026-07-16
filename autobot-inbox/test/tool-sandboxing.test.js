import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';

describe('tool-sandboxing', () => {

  describe('executeTool authorization', () => {
    it('rejects agent not in tools_allowed', async () => {
      const { executeTool } = await import('../tools/registry.js');

      await assert.rejects(
        () => executeTool('gmail_poll', {}, { id: 'reviewer', tools_allowed: ['gate_check'] }),
        { message: /Agent reviewer not authorized for tool gmail_poll/ }
      );
    });

    it('rejects unknown tool', async () => {
      const { executeTool } = await import('../tools/registry.js');

      await assert.rejects(
        () => executeTool('nonexistent_tool', {}, { id: 'orchestrator', tools_allowed: ['nonexistent_tool'] }),
        { message: /Unknown tool: nonexistent_tool/ }
      );
    });
  });

  describe('tool timeout', () => {
    it('times out slow tool handler', async () => {
      const { tools, executeTool } = await import('../tools/registry.js');

      // Inject a slow mock tool
      const originalHandler = tools.stats_query.handler;
      const originalTimeout = tools.stats_query.timeout;
      tools.stats_query.handler = () => new Promise(() => {}); // never resolves
      tools.stats_query.timeout = 50; // 50ms timeout

      try {
        await assert.rejects(
          () => executeTool('stats_query', {}, { id: 'architect', tools_allowed: ['stats_query'] }),
          { message: /timed out after 50ms/ }
        );
      } finally {
        // Restore
        tools.stats_query.handler = originalHandler;
        tools.stats_query.timeout = originalTimeout;
      }
    });
  });

  describe('tool capabilities and timeout declarations', () => {
    it('all tools have capabilities and timeout', async () => {
      const { tools } = await import('../tools/registry.js');

      for (const [name, tool] of Object.entries(tools)) {
        assert.ok(tool.capabilities, `${name} missing capabilities`);
        assert.ok(Array.isArray(tool.capabilities.schemas), `${name} capabilities.schemas should be array`);
        assert.equal(typeof tool.capabilities.network, 'boolean', `${name} capabilities.network should be boolean`);
        assert.ok(typeof tool.timeout === 'number' && tool.timeout > 0, `${name} timeout should be positive number`);
      }
    });

    it('network tools have network: true', async () => {
      const { tools } = await import('../tools/registry.js');

      assert.equal(tools.gmail_poll.capabilities.network, true);
      assert.equal(tools.gmail_fetch.capabilities.network, true);
    });

    it('non-network tools have network: false', async () => {
      const { tools } = await import('../tools/registry.js');

      assert.equal(tools.task_create.capabilities.network, false);
      assert.equal(tools.voice_query.capabilities.network, false);
      assert.equal(tools.draft_create.capabilities.network, false);
      assert.equal(tools.gate_check.capabilities.network, false);
    });
  });

  describe('agent assignment enforcement (SQL)', () => {
    let queryFn;

    before(async () => {
      ({ query: queryFn } = await getDb());
    });
    // NOTE: Do not call close() — PGlite cannot reinitialize after close

    it('allows architect to create work items assigned to orchestrator', async () => {
      const result = await queryFn(`
        INSERT INTO agent_graph.work_items (type, title, created_by, assigned_to)
        VALUES ('task', 'Test routing to orchestrator', 'architect', 'orchestrator')
        RETURNING id
      `);
      assert.ok(result.rows[0].id);
    });

    it('allows architect to create unassigned work items', async () => {
      const result = await queryFn(`
        INSERT INTO agent_graph.work_items (type, title, created_by, assigned_to)
        VALUES ('task', 'Test unassigned', 'architect', NULL)
        RETURNING id
      `);
      assert.ok(result.rows[0].id);
    });

    it('rejects architect routing to non-orchestrator agent', async () => {
      await assert.rejects(
        () => queryFn(`
          INSERT INTO agent_graph.work_items (type, title, created_by, assigned_to)
          VALUES ('task', 'Bad routing', 'architect', 'executor-triage')
        `),
        /not authorized to assign work to/
      );
    });

    it('rejects architect reassignment via UPDATE', async () => {
      // Create a valid architect work item assigned to orchestrator
      const result = await queryFn(`
        INSERT INTO agent_graph.work_items (type, title, created_by, assigned_to)
        VALUES ('task', 'Will try UPDATE bypass', 'architect', 'orchestrator')
        RETURNING id
      `);
      const id = result.rows[0].id;

      // Attempt to UPDATE assigned_to to a non-orchestrator agent
      await assert.rejects(
        () => queryFn(`
          UPDATE agent_graph.work_items SET assigned_to = 'executor-triage' WHERE id = $1
        `, [id]),
        /not authorized to assign work to/
      );
    });

    it('allows orchestrator to route to authorized agents', async () => {
      const result = await queryFn(`
        INSERT INTO agent_graph.work_items (type, title, created_by, assigned_to)
        VALUES ('task', 'Orchestrator routes to triage', 'orchestrator', 'executor-triage')
        RETURNING id
      `);
      assert.ok(result.rows[0].id);
    });

    it('rejects unauthorized agent assignment', async () => {
      await assert.rejects(
        () => queryFn(`
          INSERT INTO agent_graph.work_items (type, title, created_by, assigned_to)
          VALUES ('task', 'Bad triage routing', 'executor-triage', 'architect')
        `),
        /not authorized to assign work to/
      );
    });

    it('allows self-assignment', async () => {
      const result = await queryFn(`
        INSERT INTO agent_graph.work_items (type, title, created_by, assigned_to)
        VALUES ('task', 'Self-assign', 'orchestrator', 'orchestrator')
        RETURNING id
      `);
      assert.ok(result.rows[0].id);
    });

    it('allows board to assign to any agent', async () => {
      // Seed a board entry in agent_configs (board uses the CLI/direct SQL path
      // in production, but the FK on created_by requires an agent_configs entry)
      await queryFn(`
        INSERT INTO agent_graph.agent_configs (id, agent_type, model, system_prompt, config_hash, is_active)
        VALUES ('board', 'orchestrator', 'none', 'board override', 'board', true)
        ON CONFLICT (id) DO NOTHING
      `);
      const result = await queryFn(`
        INSERT INTO agent_graph.work_items (type, title, created_by, assigned_to)
        VALUES ('task', 'Board override', 'board', 'architect')
        RETURNING id
      `);
      assert.ok(result.rows[0].id);
    });

    it('tool_invocations table is append-only', async () => {
      // Insert a record
      await queryFn(`
        INSERT INTO agent_graph.tool_invocations (agent_id, tool_name, success)
        VALUES ('test-agent', 'test_tool', true)
      `);

      // UPDATE should be rejected
      await assert.rejects(
        () => queryFn(`
          UPDATE agent_graph.tool_invocations SET success = false WHERE agent_id = 'test-agent'
        `),
        /Cannot UPDATE rows in append-only table/
      );

      // DELETE should be rejected
      await assert.rejects(
        () => queryFn(`
          DELETE FROM agent_graph.tool_invocations WHERE agent_id = 'test-agent'
        `),
        /Cannot UPDATE rows in append-only table|Cannot DELETE rows in append-only table/
      );
    });
  });
});
