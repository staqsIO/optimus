/**
 * OPT-162 Phase 1 (ADR-020) — migration 178-work-items-obligation-tenancy.sql
 *
 * Verifies the additive schema contract for the obligation/tenancy columns on
 * agent_graph.work_items:
 *   - owner_org_id (UUID), obligation_type (TEXT), source_message_id (TEXT),
 *     viewer_emails (ARRAY) all exist.
 *   - obligation_type CHECK rejects unknown values and accepts the documented
 *     domain + NULL.
 *   - The partial tenant-scoped index exists and is partial on
 *     obligation_type IS NOT NULL.
 *
 * Framework-agnostic (node:test), runs against the shared PGlite singleton —
 * see test/helpers/setup-db.js. Mirrors test/human-tasks-migration.test.js.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';

describe('migration 178 — agent_graph.work_items obligation/tenancy columns', () => {
  let query;

  before(async () => {
    ({ query } = await getDb());
  });

  // ---- Required columns --------------------------------------------------

  const REQUIRED_COLUMNS = [
    ['owner_org_id', 'uuid'],
    ['obligation_type', 'text'],
    ['source_message_id', 'text'],
    ['viewer_emails', 'ARRAY'],
  ];

  for (const [col, dt] of REQUIRED_COLUMNS) {
    it(`column ${col} (${dt})`, async () => {
      const r = await query(
        `SELECT data_type
           FROM information_schema.columns
          WHERE table_schema = 'agent_graph'
            AND table_name = 'work_items'
            AND column_name = $1`,
        [col],
      );
      assert.equal(r.rows.length, 1, `column ${col} must exist`);
      assert.equal(r.rows[0].data_type, dt, `column ${col} data_type mismatch`);
    });
  }

  // ---- obligation_type CHECK (functional) --------------------------------

  it('obligation_type CHECK rejects unknown value', async () => {
    await assert.rejects(
      () =>
        query(
          `INSERT INTO agent_graph.work_items (id, type, title, created_by, obligation_type)
           VALUES ('wi-test-bad-obl-1', 'task', 'x', 'orchestrator', 'not_an_obligation')`,
        ),
      /obligation_type|check/i,
    );
  });

  it('obligation_type CHECK accepts NULL + the 6 documented values', async () => {
    const VALUES = [
      null, 'action', 'request', 'commitment',
      'deadline', 'blocker', 'decision_followup',
    ];
    for (const v of VALUES) {
      const id = `wi-test-obl-${v ?? 'null'}`;
      await query(
        `INSERT INTO agent_graph.work_items (id, type, title, created_by, obligation_type)
         VALUES ($1, 'task', 'obligation check', 'orchestrator', $2)`,
        [id, v],
      );
      const r = await query(
        `SELECT obligation_type FROM agent_graph.work_items WHERE id = $1`,
        [id],
      );
      assert.equal(r.rows[0].obligation_type, v);
    }
  });

  // ---- viewer_emails round-trips as a text[] -----------------------------

  it('viewer_emails accepts a text array', async () => {
    await query(
      `INSERT INTO agent_graph.work_items (id, type, title, created_by, viewer_emails)
       VALUES ('wi-test-viewers-1', 'task', 'viewer check', 'orchestrator',
               ARRAY['a@example.com','b@example.com']::text[])`,
    );
    const r = await query(
      `SELECT viewer_emails FROM agent_graph.work_items WHERE id = 'wi-test-viewers-1'`,
    );
    assert.deepEqual(r.rows[0].viewer_emails, ['a@example.com', 'b@example.com']);
  });

  // ---- Index -------------------------------------------------------------

  it('index idx_work_items_owner_org_obligation exists', async () => {
    const r = await query(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = 'agent_graph'
          AND tablename = 'work_items'
          AND indexname = 'idx_work_items_owner_org_obligation'`,
    );
    assert.equal(r.rows.length, 1, 'index must exist');
  });

  it('index is partial on obligation_type IS NOT NULL', async () => {
    const r = await query(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'agent_graph'
          AND tablename = 'work_items'
          AND indexname = 'idx_work_items_owner_org_obligation'`,
    );
    assert.ok(
      /WHERE[\s\S]*obligation_type\s+IS\s+NOT\s+NULL/i.test(r.rows[0].indexdef),
      `index must be partial on obligation_type IS NOT NULL, got: ${r.rows[0].indexdef}`,
    );
  });
});
