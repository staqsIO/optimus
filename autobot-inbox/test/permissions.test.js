import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';

/**
 * Tests for the unified permission grants system (ADR-017).
 *
 * Covers:
 *   - checkPermission()  — DB-backed deny-by-default, fail-closed
 *   - requirePermission() — throws on deny with descriptive message
 *   - logCapabilityInvocation() — fire-and-forget audit trail
 *   - SQL enforcement — constraints, check_permission() function
 *   - executeTool() Layer 1 — accepts both `tools` and `tools_allowed` keys
 *
 * Uses PGlite via shared setup-db helper.
 */

describe('permissions (ADR-017)', () => {
  let queryFn;
  let checkPermission, requirePermission, logCapabilityInvocation;

  before(async () => {
    ({ query: queryFn } = await getDb());

    // Dynamic import of permissions module (after DB is ready)
    const perms = await import('../src/runtime/permissions.js');
    checkPermission = perms.checkPermission;
    requirePermission = perms.requirePermission;
    logCapabilityInvocation = perms.logCapabilityInvocation;
  });

  // NOTE: Do not call close() here — PGlite WASM cannot be reinitialized
  // after close in the same process, which breaks other PGlite-using test files.
  // Process exit handles cleanup.

  // ============================================================
  // 1. checkPermission() — DB-backed tests
  // ============================================================
  describe('checkPermission()', () => {
    it('returns true for seeded grant', async () => {
      // orchestrator has tool:gmail_poll from 041 seed data
      const allowed = await checkPermission('orchestrator', 'tool', 'gmail_poll');
      assert.equal(allowed, true);
    });

    it('returns false for unseeded agent/resource (P1: deny by default)', async () => {
      // executor-triage does NOT have api_client:linear
      const allowed = await checkPermission('executor-triage', 'api_client', 'linear');
      assert.equal(allowed, false);
    });

    it('returns false for completely unknown agent', async () => {
      const allowed = await checkPermission('nonexistent-agent', 'tool', 'gmail_poll');
      assert.equal(allowed, false);
    });

    it('returns false for revoked grant', async () => {
      // Insert a test grant, then revoke it
      await queryFn(`
        INSERT INTO agent_graph.permission_grants
          (agent_id, resource_type, resource_name, risk_class, granted_by)
        VALUES ('strategist', 'tool', 'test_revoked_tool', 'Internal', 'test')
        ON CONFLICT (agent_id, resource_type, resource_name) DO NOTHING
      `);
      // Revoke it
      await queryFn(`
        UPDATE agent_graph.permission_grants
        SET revoked_at = now()
        WHERE agent_id = 'strategist' AND resource_type = 'tool' AND resource_name = 'test_revoked_tool'
      `);

      const allowed = await checkPermission('strategist', 'tool', 'test_revoked_tool');
      assert.equal(allowed, false);
    });

    it('fail-closed on DB error — returns false, does not throw', async () => {
      // Temporarily drop the check_permission function to cause a DB error
      await queryFn(`DROP FUNCTION agent_graph.check_permission(TEXT, TEXT, TEXT)`);
      try {
        const allowed = await checkPermission('orchestrator', 'tool', 'gmail_poll');
        assert.equal(allowed, false, 'Should return false when DB function is missing');
      } finally {
        // Recreate the function
        await queryFn(`
          CREATE OR REPLACE FUNCTION agent_graph.check_permission(
            p_agent_id TEXT, p_resource_type TEXT, p_resource_name TEXT
          ) RETURNS BOOLEAN AS $$
          BEGIN
            RETURN EXISTS (
              SELECT 1 FROM agent_graph.permission_grants
              WHERE agent_id = p_agent_id
                AND resource_type = p_resource_type
                AND resource_name = p_resource_name
                AND revoked_at IS NULL
            );
          END;
          $$ LANGUAGE plpgsql STABLE
        `);
      }
    });
  });

  // ============================================================
  // 2. requirePermission() — throws on deny
  // ============================================================
  describe('requirePermission()', () => {
    it('succeeds silently for valid grant', async () => {
      // Should not throw — orchestrator has tool:gmail_poll
      await requirePermission('orchestrator', 'tool', 'gmail_poll');
    });

    it('throws with descriptive message for denied grant', async () => {
      await assert.rejects(
        () => requirePermission('executor-triage', 'api_client', 'linear'),
        { message: /Permission denied.*lacks grant/ }
      );
    });

    it('error message includes agent, type, and resource', async () => {
      await assert.rejects(
        () => requirePermission('reviewer', 'subprocess', 'claude_cli'),
        (err) => {
          assert.match(err.message, /reviewer/);
          assert.match(err.message, /subprocess/);
          assert.match(err.message, /claude_cli/);
          return true;
        }
      );
    });
  });

  // ============================================================
  // 3. logCapabilityInvocation() — audit trail
  // ============================================================
  describe('logCapabilityInvocation()', () => {
    it('inserts row into tool_invocations with correct resource_type', async () => {
      const marker = `test_audit_${Date.now()}`;
      logCapabilityInvocation({
        agentId: 'orchestrator',
        resourceType: 'adapter',
        resourceName: marker,
        success: true,
        durationMs: 42,
      });

      // Give fire-and-forget time to complete
      await new Promise((r) => setTimeout(r, 200));

      const result = await queryFn(
        `SELECT * FROM agent_graph.tool_invocations WHERE tool_name = $1`,
        [marker]
      );
      assert.equal(result.rows.length, 1);
      assert.equal(result.rows[0].agent_id, 'orchestrator');
      assert.equal(result.rows[0].resource_type, 'adapter');
      assert.equal(result.rows[0].success, true);
      assert.equal(result.rows[0].duration_ms, 42);
    });

    it('supports all resource_type values', async () => {
      const types = ['tool', 'adapter', 'api_client', 'subprocess'];
      for (const type of types) {
        const marker = `test_type_${type}_${Date.now()}`;
        logCapabilityInvocation({
          agentId: 'orchestrator',
          resourceType: type,
          resourceName: marker,
          success: true,
        });
        await new Promise((r) => setTimeout(r, 100));

        const result = await queryFn(
          `SELECT resource_type FROM agent_graph.tool_invocations WHERE tool_name = $1`,
          [marker]
        );
        assert.equal(result.rows.length, 1, `row should exist for resource_type=${type}`);
        assert.equal(result.rows[0].resource_type, type);
      }
    });

    it('records work_item_id when provided', async () => {
      const marker = `test_wid_${Date.now()}`;
      logCapabilityInvocation({
        agentId: 'architect',
        resourceType: 'tool',
        resourceName: marker,
        success: true,
        workItemId: 'wi-test-123',
      });

      await new Promise((r) => setTimeout(r, 200));

      const result = await queryFn(
        `SELECT work_item_id FROM agent_graph.tool_invocations WHERE tool_name = $1`,
        [marker]
      );
      assert.equal(result.rows.length, 1);
      assert.equal(result.rows[0].work_item_id, 'wi-test-123');
    });

    it('fire-and-forget — does not throw on failure', async () => {
      // Pass an invalid resource_type to trigger CHECK constraint violation.
      // logCapabilityInvocation catches internally — should not bubble up.
      logCapabilityInvocation({
        agentId: 'orchestrator',
        resourceType: 'invalid_type',  // violates CHECK constraint
        resourceName: 'test_no_throw',
        success: true,
      });

      // If we get here without unhandled rejection, the test passes.
      // Give time for the async query to fail and be caught.
      await new Promise((r) => setTimeout(r, 200));
    });
  });

  // ============================================================
  // 4. SQL enforcement (permission_grants table)
  // ============================================================
  describe('SQL enforcement', () => {
    it('UNIQUE constraint rejects duplicate (agent_id, resource_type, resource_name)', async () => {
      // orchestrator + tool + gmail_poll already exists from seed
      await assert.rejects(
        () => queryFn(`
          INSERT INTO agent_graph.permission_grants
            (agent_id, resource_type, resource_name, risk_class, granted_by)
          VALUES ('orchestrator', 'tool', 'gmail_poll', 'Internal', 'test')
        `),
        /unique|duplicate/i
      );
    });

    it('resource_type CHECK constraint rejects invalid type', async () => {
      await assert.rejects(
        () => queryFn(`
          INSERT INTO agent_graph.permission_grants
            (agent_id, resource_type, resource_name, risk_class, granted_by)
          VALUES ('orchestrator', 'rpc', 'test_invalid', 'Internal', 'test')
        `),
        /check|violates|resource_type/i
      );
    });

    it('risk_class CHECK constraint rejects invalid class', async () => {
      await assert.rejects(
        () => queryFn(`
          INSERT INTO agent_graph.permission_grants
            (agent_id, resource_type, resource_name, risk_class, granted_by)
          VALUES ('orchestrator', 'tool', 'test_risk', 'Dangerous', 'test')
        `),
        /check|violates|risk_class/i
      );
    });

    it('check_permission() SQL function returns true for active grant', async () => {
      const result = await queryFn(
        `SELECT agent_graph.check_permission('orchestrator', 'tool', 'gmail_poll') AS allowed`
      );
      assert.equal(result.rows[0].allowed, true);
    });

    it('check_permission() SQL function returns false for missing grant', async () => {
      const result = await queryFn(
        `SELECT agent_graph.check_permission('reviewer', 'subprocess', 'claude_cli') AS allowed`
      );
      assert.equal(result.rows[0].allowed, false);
    });

    it('check_permission() SQL function returns false for revoked grant', async () => {
      // Use the revoked grant from the checkPermission test
      const result = await queryFn(
        `SELECT agent_graph.check_permission('strategist', 'tool', 'test_revoked_tool') AS allowed`
      );
      assert.equal(result.rows[0].allowed, false);
    });
  });

  // ============================================================
  // 5. executeTool Layer 1 — accepts both `tools` and `tools_allowed`
  // ============================================================
  describe('executeTool Layer 1', () => {
    it('accepts `tools` key (from agents.json)', async () => {
      const { executeTool } = await import('../tools/registry.js');

      // task_read with a nonexistent ID just returns undefined — no throw
      const result = await executeTool(
        'task_read',
        { workItemId: 'nonexistent-id' },
        { id: 'architect', tools: ['task_read'] }
      );
      // Handler returns undefined for missing row — that's fine, Layer 1 passed
      assert.equal(result, undefined);
    });

    it('still accepts `tools_allowed` key (backward compat)', async () => {
      const { executeTool } = await import('../tools/registry.js');

      const result = await executeTool(
        'task_read',
        { workItemId: 'nonexistent-id' },
        { id: 'architect', tools_allowed: ['task_read'] }
      );
      assert.equal(result, undefined);
    });

    it('rejects when tool is in neither `tools` nor `tools_allowed`', async () => {
      const { executeTool } = await import('../tools/registry.js');

      await assert.rejects(
        () => executeTool('task_read', {}, { id: 'architect', tools: ['gmail_poll'] }),
        { message: /Agent architect not authorized for tool task_read/ }
      );
    });
  });
});
