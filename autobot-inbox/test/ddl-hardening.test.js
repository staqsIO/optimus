import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';

/**
 * Tests for 025-ddl-hardening.sql migration.
 *
 * Uses PGlite (no DATABASE_URL) so tests are self-contained.
 * Verifies: indexes, CHECK constraints, immutability triggers, conditional FK.
 */

describe('ddl-hardening', () => {
  let queryFn;

  before(async () => {
    ({ query: queryFn } = await getDb());
  });
  // NOTE: Do not call close() — PGlite cannot reinitialize after close

  // ---- Section 1: Index existence ----

  it('index exists on work_items.created_by', async () => {
    const result = await queryFn(`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'agent_graph'
        AND tablename = 'work_items'
        AND indexname = 'idx_work_items_created_by'
    `);
    assert.equal(result.rows.length, 1, 'idx_work_items_created_by should exist');
  });

  it('index exists on agent_config_history.agent_id', async () => {
    const result = await queryFn(`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'agent_graph'
        AND tablename = 'agent_config_history'
        AND indexname = 'idx_agent_config_history_agent'
    `);
    assert.equal(result.rows.length, 1, 'idx_agent_config_history_agent should exist');
  });

  it('index exists on strategic_decisions.agent_id', async () => {
    const result = await queryFn(`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'agent_graph'
        AND tablename = 'strategic_decisions'
        AND indexname = 'idx_strategic_decisions_agent'
    `);
    assert.equal(result.rows.length, 1, 'idx_strategic_decisions_agent should exist');
  });

  // ---- Section 2: CHECK constraint on retention_rate ----

  it('rejects retention_rate > 1', async () => {
    // Seed a product for FK
    await queryFn(`
      INSERT INTO autobot_value.products (id, name)
      VALUES ('test-product', 'Test Product')
      ON CONFLICT (id) DO NOTHING
    `);

    await assert.rejects(
      () => queryFn(`
        INSERT INTO autobot_value.product_metrics (product_id, measurement_date, retention_rate)
        VALUES ('test-product', '2026-01-01', 1.5)
      `),
      /chk_retention_rate_range/
    );
  });

  it('rejects retention_rate < 0', async () => {
    await assert.rejects(
      () => queryFn(`
        INSERT INTO autobot_value.product_metrics (product_id, measurement_date, retention_rate)
        VALUES ('test-product', '2026-01-03', -0.1)
      `),
      /chk_retention_rate_range/
    );
  });

  it('accepts retention_rate within 0..1 range', async () => {
    const result = await queryFn(`
      INSERT INTO autobot_value.product_metrics (product_id, measurement_date, retention_rate)
      VALUES ('test-product', '2026-01-02', 0.85)
      RETURNING id
    `);
    assert.ok(result.rows[0].id);
  });

  // ---- Section 3a: event_log immutability ----

  it('rejects UPDATE on event_log', async () => {
    await queryFn(`
      INSERT INTO autobot_public.event_log (id, event_type, summary)
      VALUES ('evt-test-1', 'email_received', 'test event')
      ON CONFLICT (id) DO NOTHING
    `);

    await assert.rejects(
      () => queryFn(`
        UPDATE autobot_public.event_log SET summary = 'tampered' WHERE id = 'evt-test-1'
      `),
      /Cannot UPDATE rows in append-only table/
    );
  });

  it('rejects DELETE on event_log', async () => {
    await assert.rejects(
      () => queryFn(`
        DELETE FROM autobot_public.event_log WHERE id = 'evt-test-1'
      `),
      /Cannot DELETE rows in append-only table/
    );
  });

  // ---- Section 3b: audit_findings immutability ----

  it('rejects DELETE on audit_findings', async () => {
    await queryFn(`
      INSERT INTO agent_graph.audit_findings (id, audit_tier, finding_type, severity, description)
      VALUES ('af-test-1', 1, 'anomaly', 'low', 'test finding')
      ON CONFLICT (id) DO NOTHING
    `);

    await assert.rejects(
      () => queryFn(`
        DELETE FROM agent_graph.audit_findings WHERE id = 'af-test-1'
      `),
      /Cannot DELETE rows in append-only table/
    );
  });

  it('allows UPDATE on audit_findings status (workflow)', async () => {
    const result = await queryFn(`
      UPDATE agent_graph.audit_findings
      SET status = 'resolved', resolved_by = 'human', resolved_at = now()
      WHERE id = 'af-test-1'
      RETURNING id, status
    `);
    assert.equal(result.rows[0].status, 'resolved');
  });

  // ---- Section 4: Conditional FK ----

  it('created_by FK constraint exists on work_items', async () => {
    const result = await queryFn(`
      SELECT constraint_name FROM information_schema.table_constraints
      WHERE table_schema = 'agent_graph'
        AND table_name = 'work_items'
        AND constraint_name = 'fk_work_items_created_by'
    `);
    assert.equal(result.rows.length, 1, 'fk_work_items_created_by should exist (no orphans in fresh DB)');
  });

  it('rejects work_item with unknown created_by', async () => {
    await assert.rejects(
      () => queryFn(`
        INSERT INTO agent_graph.work_items (type, title, created_by)
        VALUES ('task', 'FK test', 'nonexistent-agent')
      `),
      /fk_work_items_created_by|violates foreign key/
    );
  });
});
