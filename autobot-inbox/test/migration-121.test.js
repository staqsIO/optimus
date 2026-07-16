/**
 * RED step (TDD) — migration 121-llm-guardrail-corrections.sql does not yet
 * exist. Adds `inbox.llm_guardrail_corrections` to capture operator
 * "this was wrong" feedback against the guardrail revision in effect at
 * the time of the bad LLM decision.
 *
 * Spec source:
 *   docs/internal/prds/meeting-actions-to-kanban-v0.2-tech-spec.md
 *   - FR-22 (Settings → LLM Guardrails: "this was wrong" capture button)
 *   - AD-6  (Guardrails are DB-stored, versioned, append-only)
 *
 * Schema contract this test pins:
 *   id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text
 *   guardrail_id  TEXT REFERENCES inbox.llm_guardrails(id) ON DELETE SET NULL
 *   task_id       TEXT
 *   description   TEXT NOT NULL
 *   captured_by   TEXT NOT NULL
 *   captured_at   TIMESTAMPTZ NOT NULL DEFAULT now()
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';

describe('migration 121 — inbox.llm_guardrail_corrections', () => {
  let query;

  before(async () => {
    ({ query } = await getDb());
  });

  // -----------------------------------------------------------------------
  // Table existence + column shape
  // -----------------------------------------------------------------------

  describe('table existence and column types', () => {
    it('table inbox.llm_guardrail_corrections exists', async () => {
      const r = await query(
        `SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'inbox'
            AND table_name = 'llm_guardrail_corrections'`,
      );
      assert.strictEqual(
        r.rows.length, 1,
        'inbox.llm_guardrail_corrections must exist',
      );
    });

    const COLUMNS = [
      ['id', 'text'],
      ['guardrail_id', 'text'],
      ['task_id', 'text'],
      ['description', 'text'],
      ['captured_by', 'text'],
      ['captured_at', 'timestamp with time zone'],
    ];

    for (const [col, dt] of COLUMNS) {
      it(`column ${col} (${dt}) exists`, async () => {
        const r = await query(
          `SELECT data_type
             FROM information_schema.columns
            WHERE table_schema = 'inbox'
              AND table_name = 'llm_guardrail_corrections'
              AND column_name = $1`,
          [col],
        );
        assert.strictEqual(r.rows.length, 1, `column ${col} must exist`);
        assert.strictEqual(
          r.rows[0].data_type, dt,
          `column ${col} data_type mismatch`,
        );
      });
    }

    it('id is the primary key (uniqueness enforced)', async () => {
      // Seed a current push guardrail to satisfy potential FK.
      await query(
        `INSERT INTO inbox.llm_guardrails
           (id, kind, prompt_text, revision, created_by, is_current)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO NOTHING`,
        ['gr-121-pk', 'push', 'pk seed', 1, 'system', false],
      );
      await query(
        `INSERT INTO inbox.llm_guardrail_corrections
           (id, guardrail_id, task_id, description, captured_by)
         VALUES ($1, $2, $3, $4, $5)`,
        ['cor-121-pk-1', 'gr-121-pk', 't1', 'wrong x', 'isaias'],
      );
      await assert.rejects(
        () =>
          query(
            `INSERT INTO inbox.llm_guardrail_corrections
               (id, guardrail_id, task_id, description, captured_by)
             VALUES ($1, $2, $3, $4, $5)`,
            ['cor-121-pk-1', 'gr-121-pk', 't1', 'duplicate', 'isaias'],
          ),
        /duplicate|unique|primary/i,
      );
    });

    it('id defaults to a uuid string when not supplied (gen_random_uuid::text)', async () => {
      await query(
        `INSERT INTO inbox.llm_guardrails
           (id, kind, prompt_text, revision, created_by, is_current)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO NOTHING`,
        ['gr-121-default-id', 'push', 'default id seed', 1, 'system', false],
      );
      const r = await query(
        `INSERT INTO inbox.llm_guardrail_corrections
           (guardrail_id, task_id, description, captured_by)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        ['gr-121-default-id', 't-default', 'auto id', 'isaias'],
      );
      assert.ok(r.rows[0].id, 'id default must generate a value');
      assert.strictEqual(typeof r.rows[0].id, 'string');
      assert.ok(
        /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(r.rows[0].id),
        `id default must look like a uuid, got: ${r.rows[0].id}`,
      );
    });

    it('captured_at defaults to now() when not supplied', async () => {
      await query(
        `INSERT INTO inbox.llm_guardrails
           (id, kind, prompt_text, revision, created_by, is_current)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO NOTHING`,
        ['gr-121-ts', 'push', 'ts seed', 1, 'system', false],
      );
      const before = Date.now();
      const r = await query(
        `INSERT INTO inbox.llm_guardrail_corrections
           (id, guardrail_id, task_id, description, captured_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING captured_at`,
        ['cor-121-ts-1', 'gr-121-ts', 't-ts', 'ts default', 'isaias'],
      );
      const stamped = new Date(r.rows[0].captured_at).getTime();
      assert.ok(
        stamped >= before - 1000 && stamped <= Date.now() + 1000,
        `captured_at must default to now(), got: ${r.rows[0].captured_at}`,
      );
    });
  });

  // -----------------------------------------------------------------------
  // NOT NULL constraints
  // -----------------------------------------------------------------------

  describe('NOT NULL constraints', () => {
    it('rejects insert with NULL description', async () => {
      await query(
        `INSERT INTO inbox.llm_guardrails
           (id, kind, prompt_text, revision, created_by, is_current)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO NOTHING`,
        ['gr-121-nn-desc', 'push', 'seed', 1, 'system', false],
      );
      await assert.rejects(
        () =>
          query(
            `INSERT INTO inbox.llm_guardrail_corrections
               (id, guardrail_id, task_id, description, captured_by)
             VALUES ($1, $2, $3, $4, $5)`,
            ['cor-121-nn-desc', 'gr-121-nn-desc', 't', null, 'isaias'],
          ),
        /description|not.null|null/i,
      );
    });

    it('rejects insert with NULL captured_by', async () => {
      await query(
        `INSERT INTO inbox.llm_guardrails
           (id, kind, prompt_text, revision, created_by, is_current)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO NOTHING`,
        ['gr-121-nn-by', 'push', 'seed', 1, 'system', false],
      );
      await assert.rejects(
        () =>
          query(
            `INSERT INTO inbox.llm_guardrail_corrections
               (id, guardrail_id, task_id, description, captured_by)
             VALUES ($1, $2, $3, $4, $5)`,
            ['cor-121-nn-by', 'gr-121-nn-by', 't', 'wrong', null],
          ),
        /captured_by|not.null|null/i,
      );
    });

    it('accepts NULL guardrail_id (correction may outlive its guardrail)', async () => {
      // Per AD-6 + the FK ON DELETE SET NULL spec, guardrail_id may be NULL.
      await query(
        `INSERT INTO inbox.llm_guardrail_corrections
           (id, guardrail_id, task_id, description, captured_by)
         VALUES ($1, $2, $3, $4, $5)`,
        ['cor-121-nullable-gr', null, 't-orphan', 'detached', 'isaias'],
      );
      const r = await query(
        `SELECT guardrail_id FROM inbox.llm_guardrail_corrections WHERE id = $1`,
        ['cor-121-nullable-gr'],
      );
      assert.strictEqual(r.rows[0].guardrail_id, null);
    });

    it('accepts NULL task_id (correction may be guardrail-only)', async () => {
      await query(
        `INSERT INTO inbox.llm_guardrails
           (id, kind, prompt_text, revision, created_by, is_current)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO NOTHING`,
        ['gr-121-null-task', 'push', 'seed', 1, 'system', false],
      );
      await query(
        `INSERT INTO inbox.llm_guardrail_corrections
           (id, guardrail_id, task_id, description, captured_by)
         VALUES ($1, $2, $3, $4, $5)`,
        ['cor-121-null-task', 'gr-121-null-task', null, 'general note', 'isaias'],
      );
      const r = await query(
        `SELECT task_id FROM inbox.llm_guardrail_corrections WHERE id = $1`,
        ['cor-121-null-task'],
      );
      assert.strictEqual(r.rows[0].task_id, null);
    });
  });

  // -----------------------------------------------------------------------
  // Foreign key: guardrail_id REFERENCES llm_guardrails(id) ON DELETE SET NULL
  // -----------------------------------------------------------------------

  describe('FK guardrail_id → llm_guardrails(id) ON DELETE SET NULL', () => {
    it('FK constraint exists in information_schema with action SET NULL', async () => {
      const r = await query(
        `SELECT rc.delete_rule, ccu.table_schema AS ref_schema,
                ccu.table_name AS ref_table, ccu.column_name AS ref_column,
                kcu.column_name AS child_column
           FROM information_schema.referential_constraints rc
           JOIN information_schema.key_column_usage kcu
             ON kcu.constraint_name = rc.constraint_name
            AND kcu.constraint_schema = rc.constraint_schema
           JOIN information_schema.constraint_column_usage ccu
             ON ccu.constraint_name = rc.constraint_name
            AND ccu.constraint_schema = rc.constraint_schema
          WHERE kcu.table_schema = 'inbox'
            AND kcu.table_name = 'llm_guardrail_corrections'
            AND kcu.column_name = 'guardrail_id'`,
      );
      assert.ok(r.rows.length >= 1, 'FK on guardrail_id must exist');
      const row = r.rows[0];
      assert.strictEqual(row.ref_schema, 'inbox');
      assert.strictEqual(row.ref_table, 'llm_guardrails');
      assert.strictEqual(row.ref_column, 'id');
      assert.match(
        String(row.delete_rule).toUpperCase(),
        /SET\s*NULL/,
        `delete_rule must be SET NULL, got: ${row.delete_rule}`,
      );
    });

    it('rejects insert when guardrail_id points to a non-existent guardrail', async () => {
      await assert.rejects(
        () =>
          query(
            `INSERT INTO inbox.llm_guardrail_corrections
               (id, guardrail_id, task_id, description, captured_by)
             VALUES ($1, $2, $3, $4, $5)`,
            ['cor-121-bad-fk', 'gr-DOES-NOT-EXIST', 't', 'wrong', 'isaias'],
          ),
        /foreign|guardrail_id|violates/i,
      );
    });

    it('deleting referenced guardrail SETs NULL on the correction (does NOT cascade)', async () => {
      await query(
        `INSERT INTO inbox.llm_guardrails
           (id, kind, prompt_text, revision, created_by, is_current)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ['gr-121-fkdel', 'push', 'fkdel', 99, 'system', false],
      );
      await query(
        `INSERT INTO inbox.llm_guardrail_corrections
           (id, guardrail_id, task_id, description, captured_by)
         VALUES ($1, $2, $3, $4, $5)`,
        ['cor-121-fkdel', 'gr-121-fkdel', 't-fkdel', 'orphan me', 'isaias'],
      );
      await query(
        `DELETE FROM inbox.llm_guardrails WHERE id = $1`,
        ['gr-121-fkdel'],
      );
      const r = await query(
        `SELECT id, guardrail_id FROM inbox.llm_guardrail_corrections WHERE id = $1`,
        ['cor-121-fkdel'],
      );
      assert.strictEqual(
        r.rows.length, 1,
        'correction row must survive guardrail delete',
      );
      assert.strictEqual(
        r.rows[0].guardrail_id, null,
        'guardrail_id must be SET NULL on cascade',
      );
    });
  });
});
