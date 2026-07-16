import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';

/**
 * Tests for 037-signals-flows.sql migration.
 *
 * Signal->Tool->Output Flow Engine (STAQPRO-92).
 * Uses PGlite (no DATABASE_URL) so tests are self-contained.
 * Verifies: table existence, columns, indexes, constraints, defaults, FKs.
 */

describe('signals-flows', () => {
  let queryFn;

  before(async () => {
    ({ query: queryFn } = await getDb());
  });
  // NOTE: Do not call close() — PGlite cannot reinitialize after close

  // ---- Section 1: Table existence ----

  const expectedTables = ['signals', 'flow_definitions', 'flow_executions', 'step_executions'];

  for (const table of expectedTables) {
    it(`table agent_graph.${table} exists`, async () => {
      const result = await queryFn(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'agent_graph'
          AND table_name = $1
      `, [table]);
      assert.equal(result.rows.length, 1, `agent_graph.${table} should exist`);
    });
  }

  // ---- Section 2: Column verification ----

  const expectedColumns = {
    signals: [
      'id', 'signal_type', 'source_adapter', 'payload',
      'project_id', 'created_by', 'created_at',
    ],
    flow_definitions: [
      'id', 'name', 'version', 'description', 'trigger_signal_type',
      'steps', 'is_active', 'created_by', 'output_permissions',
      'max_depth', 'timeout_ms', 'retry_policy', 'created_at', 'updated_at',
    ],
    flow_executions: [
      'id', 'flow_definition_id', 'trigger_signal_id', 'status', 'depth',
      'parent_execution_id', 'input_payload', 'output_payload', 'error',
      'dry_run', 'started_at', 'completed_at', 'duration_ms',
    ],
    step_executions: [
      'id', 'flow_execution_id', 'step_index', 'tool_id', 'dispatch_mode',
      'input_payload', 'output_payload', 'status', 'error',
      'started_at', 'completed_at', 'duration_ms',
    ],
  };

  for (const [table, columns] of Object.entries(expectedColumns)) {
    it(`agent_graph.${table} has all expected columns`, async () => {
      const result = await queryFn(`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'agent_graph'
          AND table_name = $1
        ORDER BY ordinal_position
      `, [table]);
      const actual = result.rows.map(r => r.column_name);
      for (const col of columns) {
        assert.ok(actual.includes(col), `column ${col} missing from agent_graph.${table}`);
      }
    });
  }

  // ---- Section 3: Index existence ----

  const expectedIndexes = [
    { table: 'signals', index: 'idx_signals_type' },
    { table: 'signals', index: 'idx_signals_project' },
    { table: 'flow_executions', index: 'idx_flow_exec_status' },
    { table: 'flow_executions', index: 'idx_flow_exec_flow' },
    { table: 'flow_executions', index: 'idx_flow_exec_parent' },
    { table: 'step_executions', index: 'idx_step_exec_flow' },
  ];

  for (const { table, index } of expectedIndexes) {
    it(`index ${index} exists on agent_graph.${table}`, async () => {
      const result = await queryFn(`
        SELECT indexname FROM pg_indexes
        WHERE schemaname = 'agent_graph'
          AND tablename = $1
          AND indexname = $2
      `, [table, index]);
      assert.equal(result.rows.length, 1, `${index} should exist`);
    });
  }

  // ---- Section 4: CHECK constraint on max_depth ----

  it('rejects max_depth < 1', async () => {
    await assert.rejects(
      () => queryFn(`
        INSERT INTO agent_graph.flow_definitions
          (id, name, version, trigger_signal_type, steps, created_by, max_depth)
        VALUES
          (gen_random_uuid(), 'bad-depth-low', 1, 'test.signal', '[]'::jsonb, 'test-agent', 0)
      `),
      /valid_max_depth|violates check constraint/
    );
  });

  it('rejects max_depth > 32', async () => {
    await assert.rejects(
      () => queryFn(`
        INSERT INTO agent_graph.flow_definitions
          (id, name, version, trigger_signal_type, steps, created_by, max_depth)
        VALUES
          (gen_random_uuid(), 'bad-depth-high', 1, 'test.signal', '[]'::jsonb, 'test-agent', 33)
      `),
      /valid_max_depth|violates check constraint/
    );
  });

  it('accepts max_depth within 1..32 range', async () => {
    const result = await queryFn(`
      INSERT INTO agent_graph.flow_definitions
        (id, name, version, trigger_signal_type, steps, created_by, max_depth)
      VALUES
        (gen_random_uuid(), 'good-depth', 1, 'test.signal', '[]'::jsonb, 'test-agent', 16)
      RETURNING id
    `);
    assert.ok(result.rows[0].id);
  });

  // ---- Section 5: UNIQUE constraint on (name, version) ----

  it('rejects duplicate (name, version) in flow_definitions', async () => {
    await queryFn(`
      INSERT INTO agent_graph.flow_definitions
        (id, name, version, trigger_signal_type, steps, created_by)
      VALUES
        (gen_random_uuid(), 'unique-test', 1, 'test.signal', '[]'::jsonb, 'test-agent')
    `);

    await assert.rejects(
      () => queryFn(`
        INSERT INTO agent_graph.flow_definitions
          (id, name, version, trigger_signal_type, steps, created_by)
        VALUES
          (gen_random_uuid(), 'unique-test', 1, 'test.signal', '[]'::jsonb, 'test-agent')
      `),
      /unique|duplicate key/
    );
  });

  // ---- Section 6: FK constraints ----

  it('rejects flow_execution with non-existent flow_definition_id', async () => {
    // First create a valid signal for the FK
    const sig = await queryFn(`
      INSERT INTO agent_graph.signals (id, signal_type, source_adapter, payload)
      VALUES (gen_random_uuid(), 'test.signal', 'test', '{}'::jsonb)
      RETURNING id
    `);

    await assert.rejects(
      () => queryFn(`
        INSERT INTO agent_graph.flow_executions
          (id, flow_definition_id, trigger_signal_id, input_payload)
        VALUES
          (gen_random_uuid(), gen_random_uuid(), $1, '{}'::jsonb)
      `, [sig.rows[0].id]),
      /foreign key|violates foreign key/
    );
  });

  it('rejects flow_execution with non-existent trigger_signal_id', async () => {
    // Use the flow_definition inserted in the unique-test above
    const fd = await queryFn(`
      SELECT id FROM agent_graph.flow_definitions WHERE name = 'good-depth' LIMIT 1
    `);

    await assert.rejects(
      () => queryFn(`
        INSERT INTO agent_graph.flow_executions
          (id, flow_definition_id, trigger_signal_id, input_payload)
        VALUES
          (gen_random_uuid(), $1, gen_random_uuid(), '{}'::jsonb)
      `, [fd.rows[0].id]),
      /foreign key|violates foreign key/
    );
  });

  it('rejects step_execution with non-existent flow_execution_id', async () => {
    await assert.rejects(
      () => queryFn(`
        INSERT INTO agent_graph.step_executions
          (id, flow_execution_id, step_index, tool_id, dispatch_mode, input_payload)
        VALUES
          (gen_random_uuid(), gen_random_uuid(), 0, 'test-tool', 'sync', '{}'::jsonb)
      `),
      /foreign key|violates foreign key/
    );
  });

  // ---- Section 7: Default values ----

  it('flow_definitions defaults are applied correctly', async () => {
    const result = await queryFn(`
      INSERT INTO agent_graph.flow_definitions
        (id, name, version, trigger_signal_type, steps, created_by)
      VALUES
        (gen_random_uuid(), 'defaults-test', 1, 'test.signal', '[]'::jsonb, 'test-agent')
      RETURNING is_active, max_depth, timeout_ms, retry_policy, output_permissions
    `);
    const row = result.rows[0];
    assert.equal(row.is_active, true, 'is_active should default to true');
    assert.equal(row.max_depth, 8, 'max_depth should default to 8');
    assert.equal(row.timeout_ms, 30000, 'timeout_ms should default to 30000');
    assert.deepEqual(row.retry_policy, { max_retries: 0, strategy: 'none' }, 'retry_policy should default to no retries');
    assert.deepEqual(row.output_permissions, {}, 'output_permissions should default to empty object');
  });

  it('flow_executions defaults are applied correctly', async () => {
    // Need valid FKs
    const fd = await queryFn(`
      SELECT id FROM agent_graph.flow_definitions WHERE name = 'defaults-test' LIMIT 1
    `);
    const sig = await queryFn(`
      INSERT INTO agent_graph.signals (id, signal_type, source_adapter, payload)
      VALUES (gen_random_uuid(), 'test.defaults', 'test', '{}'::jsonb)
      RETURNING id
    `);

    const result = await queryFn(`
      INSERT INTO agent_graph.flow_executions
        (id, flow_definition_id, trigger_signal_id, input_payload)
      VALUES
        (gen_random_uuid(), $1, $2, '{"key": "value"}'::jsonb)
      RETURNING status, depth, dry_run
    `, [fd.rows[0].id, sig.rows[0].id]);
    const row = result.rows[0];
    assert.equal(row.status, 'running', 'status should default to running');
    assert.equal(row.depth, 0, 'depth should default to 0');
    assert.equal(row.dry_run, false, 'dry_run should default to false');
  });

  it('step_executions status defaults to running', async () => {
    // Get a valid flow_execution_id
    const fe = await queryFn(`
      SELECT id FROM agent_graph.flow_executions LIMIT 1
    `);

    const result = await queryFn(`
      INSERT INTO agent_graph.step_executions
        (id, flow_execution_id, step_index, tool_id, dispatch_mode, input_payload)
      VALUES
        (gen_random_uuid(), $1, 0, 'test-tool', 'sync', '{}'::jsonb)
      RETURNING status
    `, [fe.rows[0].id]);
    assert.equal(result.rows[0].status, 'running', 'status should default to running');
  });

  // ---- Section 8: NOT NULL constraints ----

  it('rejects signal without signal_type', async () => {
    await assert.rejects(
      () => queryFn(`
        INSERT INTO agent_graph.signals (id, source_adapter, payload)
        VALUES (gen_random_uuid(), 'test', '{}'::jsonb)
      `),
      /not-null|null value|violates not-null/
    );
  });

  it('rejects signal without source_adapter', async () => {
    await assert.rejects(
      () => queryFn(`
        INSERT INTO agent_graph.signals (id, signal_type, payload)
        VALUES (gen_random_uuid(), 'test.signal', '{}'::jsonb)
      `),
      /not-null|null value|violates not-null/
    );
  });

  it('rejects signal without payload', async () => {
    await assert.rejects(
      () => queryFn(`
        INSERT INTO agent_graph.signals (id, signal_type, source_adapter)
        VALUES (gen_random_uuid(), 'test.signal', 'test')
      `),
      /not-null|null value|violates not-null/
    );
  });

  it('rejects flow_definition without created_by', async () => {
    await assert.rejects(
      () => queryFn(`
        INSERT INTO agent_graph.flow_definitions
          (id, name, trigger_signal_type, steps)
        VALUES
          (gen_random_uuid(), 'no-author', 'test.signal', '[]'::jsonb)
      `),
      /not-null|null value|violates not-null/
    );
  });

  it('rejects flow_definition without trigger_signal_type', async () => {
    await assert.rejects(
      () => queryFn(`
        INSERT INTO agent_graph.flow_definitions
          (id, name, steps, created_by)
        VALUES
          (gen_random_uuid(), 'no-trigger', '[]'::jsonb, 'test-agent')
      `),
      /not-null|null value|violates not-null/
    );
  });

  it('rejects flow_execution without input_payload', async () => {
    await assert.rejects(
      () => queryFn(`
        INSERT INTO agent_graph.flow_executions
          (id, flow_definition_id, trigger_signal_id)
        VALUES
          (gen_random_uuid(), gen_random_uuid(), gen_random_uuid())
      `),
      /not-null|null value|violates not-null/
    );
  });

  it('rejects step_execution without tool_id', async () => {
    await assert.rejects(
      () => queryFn(`
        INSERT INTO agent_graph.step_executions
          (id, flow_execution_id, step_index, dispatch_mode, input_payload)
        VALUES
          (gen_random_uuid(), gen_random_uuid(), 0, 'sync', '{}'::jsonb)
      `),
      /not-null|null value|violates not-null/
    );
  });
});
