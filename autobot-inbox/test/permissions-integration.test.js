import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';

/**
 * Integration tests for ADR-017 permission enforcement at call sites.
 *
 * Verifies that the permission wiring in context-loader, executor-ticket,
 * and executor-coder actually enforces grants from the DB — not just that
 * the permission functions work in isolation (that's permissions.test.js).
 *
 * Uses PGlite via shared setup-db helper.
 */

describe('permissions integration (ADR-017 call sites)', () => {
  let queryFn;

  before(async () => {
    ({ query: queryFn } = await getDb());
  });

  // NOTE: Do not call close() here — PGlite WASM cannot be reinitialized
  // after close in the same process, which breaks other PGlite-using test files.
  // Process exit handles cleanup.

  // ============================================================
  // 1. context-loader: adapter permission enforcement
  // ============================================================
  describe('context-loader adapter permission', () => {
    let loadContext, registerAdapter, clearAdapters;
    let workItemId, emailId;

    before(async () => {
      // Import modules
      const cl = await import('../src/runtime/context-loader.js');
      loadContext = cl.loadContext;
      const reg = await import('../src/adapters/registry.js');
      registerAdapter = reg.registerAdapter;
      clearAdapters = reg.clearAdapters;

      // Seed an inbox.messages row + work_item pointing to it
      // Use unique provider_msg_id to avoid PGlite persistence conflicts
      const provId = `prov-test-perm-${Date.now()}`;
      const msgResult = await queryFn(`
        INSERT INTO inbox.messages
          (provider, provider_msg_id, thread_id, message_id, from_address, from_name, subject, snippet, received_at, channel)
        VALUES
          ('gmail', $1, 'thread-test-1', $1, 'alice@test.com', 'Alice', 'Test Subject', 'Test snippet', now(), 'email')
        RETURNING id
      `, [provId]);
      emailId = msgResult.rows[0].id;

      const wiResult = await queryFn(`
        INSERT INTO agent_graph.work_items
          (type, title, created_by, assigned_to, metadata)
        VALUES
          ('task', 'Test task for permission integration', 'orchestrator', 'executor-triage',
           $1::jsonb)
        RETURNING id
      `, [JSON.stringify({ email_id: emailId })]);
      workItemId = wiResult.rows[0].id;
    });

    beforeEach(() => {
      clearAdapters();
      // Register a mock gmail adapter
      registerAdapter('gmail', {
        channel: 'email',
        fetchContent: async () => 'Mock email body for permission test',
        buildPromptContext: (msg, body) => ({
          channel: 'email',
          body,
          contentLabel: 'untrusted_email',
          contentType: 'email',
          sender: { name: msg.from_name, address: msg.from_address },
          threading: null,
          channelHint: '',
        }),
      });
    });

    it('loads email body when agent has adapter:gmail grant', async () => {
      // orchestrator has adapter:gmail from 041 seed
      const ctx = await loadContext('orchestrator', workItemId);
      assert.equal(ctx.emailBody, 'Mock email body for permission test');
      assert.ok(ctx.promptContext, 'promptContext should be populated');
      assert.equal(ctx.promptContext.channel, 'email');
    });

    it('returns null body when agent lacks adapter grant', async () => {
      // architect does NOT have any adapter grants (only tools)
      const ctx = await loadContext('architect', workItemId);
      assert.equal(ctx.emailBody, null, 'emailBody should be null when permission denied');
    });

    it('writes audit trail on permission denial', async () => {
      // Snapshot count before
      const before = await queryFn(`
        SELECT count(*)::int AS c FROM agent_graph.tool_invocations
        WHERE agent_id = 'architect' AND resource_type = 'adapter' AND tool_name = 'gmail' AND success = false
      `);

      // Call as architect (no adapter:gmail grant)
      await loadContext('architect', workItemId);

      // Wait for fire-and-forget audit
      await new Promise((r) => setTimeout(r, 200));

      const after = await queryFn(`
        SELECT count(*)::int AS c FROM agent_graph.tool_invocations
        WHERE agent_id = 'architect' AND resource_type = 'adapter' AND tool_name = 'gmail' AND success = false
      `);
      assert.ok(after.rows[0].c > before.rows[0].c, 'Should have a new audit trail entry for denied adapter');
    });

    it('writes audit trail on successful fetch', async () => {
      // Clear any stale audit
      const beforeCount = await queryFn(`
        SELECT count(*)::int AS c FROM agent_graph.tool_invocations
        WHERE agent_id = 'orchestrator' AND resource_type = 'adapter' AND tool_name = 'gmail' AND success = true
      `);

      await loadContext('orchestrator', workItemId);
      await new Promise((r) => setTimeout(r, 200));

      const afterCount = await queryFn(`
        SELECT count(*)::int AS c FROM agent_graph.tool_invocations
        WHERE agent_id = 'orchestrator' AND resource_type = 'adapter' AND tool_name = 'gmail' AND success = true
      `);
      assert.ok(
        afterCount.rows[0].c > beforeCount.rows[0].c,
        'Should have a new audit trail entry for successful adapter fetch'
      );
    });

    it('returns null body when adapter grant is revoked', async () => {
      // Temporarily revoke orchestrator's gmail adapter grant
      await queryFn(`
        UPDATE agent_graph.permission_grants
        SET revoked_at = now()
        WHERE agent_id = 'orchestrator' AND resource_type = 'adapter' AND resource_name = 'gmail'
      `);

      try {
        const ctx = await loadContext('orchestrator', workItemId);
        assert.equal(ctx.emailBody, null, 'emailBody should be null after grant revoked');
      } finally {
        // Restore the grant
        await queryFn(`
          UPDATE agent_graph.permission_grants
          SET revoked_at = NULL
          WHERE agent_id = 'orchestrator' AND resource_type = 'adapter' AND resource_name = 'gmail'
        `);
      }
    });
  });

  // ============================================================
  // 2. Grant coverage: all call sites have matching seed grants
  // ============================================================
  describe('grant coverage audit', () => {
    // Every requirePermission/checkPermission call site in the codebase
    // must have a corresponding active grant in the 041 seed data.
    // If this test fails, a new call site was added without a grant.

    const EXPECTED_GRANTS = [
      // context-loader: checkPermission(agentId, 'adapter', channel)
      // All agents that process emails need adapter grants for each channel
      { agent: 'orchestrator',       type: 'adapter', name: 'gmail' },
      { agent: 'orchestrator',       type: 'adapter', name: 'outlook' },
      { agent: 'orchestrator',       type: 'adapter', name: 'slack' },
      { agent: 'orchestrator',       type: 'adapter', name: 'webhook' },
      { agent: 'executor-triage',    type: 'adapter', name: 'gmail' },
      { agent: 'executor-triage',    type: 'adapter', name: 'outlook' },
      { agent: 'executor-triage',    type: 'adapter', name: 'slack' },
      { agent: 'executor-triage',    type: 'adapter', name: 'webhook' },
      { agent: 'executor-responder', type: 'adapter', name: 'gmail' },
      { agent: 'executor-responder', type: 'adapter', name: 'outlook' },
      { agent: 'executor-responder', type: 'adapter', name: 'slack' },
      { agent: 'executor-responder', type: 'adapter', name: 'webhook' },
      { agent: 'reviewer',           type: 'adapter', name: 'gmail' },
      { agent: 'reviewer',           type: 'adapter', name: 'outlook' },
      { agent: 'reviewer',           type: 'adapter', name: 'slack' },
      { agent: 'reviewer',           type: 'adapter', name: 'webhook' },
      { agent: 'strategist',         type: 'adapter', name: 'gmail' },
      { agent: 'strategist',         type: 'adapter', name: 'outlook' },
      { agent: 'strategist',         type: 'adapter', name: 'slack' },
      { agent: 'strategist',         type: 'adapter', name: 'webhook' },

      // executor-ticket: requirePermission('executor-ticket', 'api_client', ...)
      { agent: 'executor-ticket', type: 'api_client', name: 'linear' },
      { agent: 'executor-ticket', type: 'api_client', name: 'github_issues' },
      { agent: 'executor-ticket', type: 'api_client', name: 'slack_notify' },

      // executor-coder: requirePermission(agent.agentId, ...)
      { agent: 'executor-coder', type: 'api_client',  name: 'github_repo' },
      { agent: 'executor-coder', type: 'subprocess',  name: 'claude_cli' },
      { agent: 'executor-coder', type: 'api_client',  name: 'slack_notify' },
    ];

    for (const { agent, type, name } of EXPECTED_GRANTS) {
      it(`${agent} has active ${type}:${name} grant`, async () => {
        const result = await queryFn(
          `SELECT agent_graph.check_permission($1, $2, $3) AS allowed`,
          [agent, type, name]
        );
        assert.equal(
          result.rows[0].allowed, true,
          `Missing grant: ${agent} → ${type}:${name}. Add to 041-permission-grants.sql`
        );
      });
    }

    // Negative cases: agents that should NOT have certain grants
    const DENIED_GRANTS = [
      // architect has no adapter grants (Q4 tier — aggregate only, no email bodies)
      { agent: 'architect', type: 'adapter', name: 'gmail' },
      // executor-triage has no api_client grants (classify only, no external writes)
      { agent: 'executor-triage', type: 'api_client', name: 'linear' },
      // reviewer has no subprocess grants
      { agent: 'reviewer', type: 'subprocess', name: 'claude_cli' },
      // orchestrator has no api_client grants (routes tasks, doesn't call APIs)
      { agent: 'orchestrator', type: 'api_client', name: 'linear' },
    ];

    for (const { agent, type, name } of DENIED_GRANTS) {
      it(`${agent} is correctly denied ${type}:${name}`, async () => {
        const result = await queryFn(
          `SELECT agent_graph.check_permission($1, $2, $3) AS allowed`,
          [agent, type, name]
        );
        assert.equal(
          result.rows[0].allowed, false,
          `Unexpected grant: ${agent} → ${type}:${name} should NOT exist (P1: deny by default)`
        );
      });
    }
  });

  // ============================================================
  // 3. requirePermission blocks denied agent at call site
  // ============================================================
  describe('requirePermission blocks denied agents', () => {
    let requirePermission;

    before(async () => {
      const perms = await import('../src/runtime/permissions.js');
      requirePermission = perms.requirePermission;
    });

    it('executor-ticket denied for subprocess:claude_cli', async () => {
      // executor-ticket should NOT be able to spawn Claude CLI
      await assert.rejects(
        () => requirePermission('executor-ticket', 'subprocess', 'claude_cli'),
        { message: /Permission denied.*executor-ticket.*lacks grant.*subprocess:claude_cli/ }
      );
    });

    it('executor-triage denied for api_client:linear', async () => {
      await assert.rejects(
        () => requirePermission('executor-triage', 'api_client', 'linear'),
        { message: /Permission denied.*executor-triage.*lacks grant/ }
      );
    });

    it('architect denied for api_client:github_repo', async () => {
      await assert.rejects(
        () => requirePermission('architect', 'api_client', 'github_repo'),
        { message: /Permission denied.*architect.*lacks grant/ }
      );
    });

    it('revocation kills a previously valid grant', async () => {
      // executor-coder has subprocess:claude_cli — verify, then revoke, then verify denial
      await requirePermission('executor-coder', 'subprocess', 'claude_cli'); // should pass

      await queryFn(`
        UPDATE agent_graph.permission_grants
        SET revoked_at = now()
        WHERE agent_id = 'executor-coder' AND resource_type = 'subprocess' AND resource_name = 'claude_cli'
      `);

      try {
        await assert.rejects(
          () => requirePermission('executor-coder', 'subprocess', 'claude_cli'),
          { message: /Permission denied/ }
        );
      } finally {
        // Restore
        await queryFn(`
          UPDATE agent_graph.permission_grants
          SET revoked_at = NULL
          WHERE agent_id = 'executor-coder' AND resource_type = 'subprocess' AND resource_name = 'claude_cli'
        `);
      }
    });
  });

  // ============================================================
  // 4. Grant count sanity check
  // ============================================================
  describe('seed data sanity', () => {
    it('has 57 grandfathered grants from migration', async () => {
      const result = await queryFn(`
        SELECT count(*)::int AS c FROM agent_graph.permission_grants
        WHERE granted_by = 'migration'
      `);
      // The seed data should have exactly 57 grants (may have +1 from test_revoked_tool in unit tests)
      assert.ok(result.rows[0].c >= 57, `Expected ≥57 migration grants, got ${result.rows[0].c}`);
    });

    it('all migration grants have valid risk_class', async () => {
      const result = await queryFn(`
        SELECT DISTINCT risk_class FROM agent_graph.permission_grants
        WHERE granted_by = 'migration'
      `);
      const classes = result.rows.map(r => r.risk_class).sort();
      const valid = ['Computational', 'External-Read', 'External-Write', 'Internal'];
      for (const cls of classes) {
        assert.ok(valid.includes(cls), `Unexpected risk_class: ${cls}`);
      }
    });

    it('no grants for nonexistent agents', async () => {
      const result = await queryFn(`
        SELECT pg.agent_id
        FROM agent_graph.permission_grants pg
        LEFT JOIN agent_graph.agent_configs ac ON ac.id = pg.agent_id
        WHERE ac.id IS NULL AND pg.granted_by = 'migration'
      `);
      assert.equal(
        result.rows.length, 0,
        `Found grants for nonexistent agents: ${result.rows.map(r => r.agent_id).join(', ')}`
      );
    });
  });
});
