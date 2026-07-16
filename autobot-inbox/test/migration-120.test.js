/**
 * RED step (TDD) — migration 120-human-tasks-linear-and-guardrails.sql
 * does not yet exist.
 *
 * Verifies the v0.2 schema contract from
 * docs/internal/prds/meeting-actions-to-kanban-v0.2-tech-spec.md §3.1 and §3.2:
 *
 *   - inbox.human_tasks gains 11 Linear-sync + workflow columns.
 *   - last_feedback CHECK widened to include transition/linear_pull/
 *     linear_push/llm_decision.
 *   - Six new partial indexes on inbox.human_tasks.
 *   - New tables: inbox.llm_guardrails, inbox.linear_team_cache,
 *     inbox.human_task_sync_log, inbox.linear_backfill_batches.
 *   - Partial-unique invariant: at most one current llm_guardrails row per kind.
 *   - human_task_sync_log cascades on parent delete.
 *
 * Tests describe operator + system actions, not implementation. They hit the
 * shared PGlite singleton — see test/helpers/setup-db.js.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';

describe('migration 120 — human_tasks Linear integration & guardrails', () => {
  let query;

  before(async () => {
    ({ query } = await getDb());
  });

  // -----------------------------------------------------------------------
  // human_tasks: 11 new columns from §3.1 step 2
  // -----------------------------------------------------------------------

  describe('human_tasks: new Linear-sync columns', () => {
    const NEW_COLUMNS = [
      ['linear_state_id', 'text'],
      ['linear_state_name', 'text'],
      ['linear_assignee_id', 'text'],
      ['linear_project_id', 'text'],
      ['linear_last_event_at', 'timestamp with time zone'],
      ['push_status', 'text'],
      ['push_skip_reason', 'text'],
      ['push_last_error', 'text'],
      ['push_attempts', 'integer'],
      ['enrichment_status', 'text'],
      ['enrichment_at', 'timestamp with time zone'],
      // pushed_at: dedicated stamp for the push worker. Symmetric with
      // enrichment_at; not clobbered by the touch_human_tasks_updated_at
      // BEFORE UPDATE trigger so stale-claim detection can rely on it.
      ['pushed_at', 'timestamp with time zone'],
    ];

    for (const [col, dt] of NEW_COLUMNS) {
      it(`column ${col} (${dt}) exists on inbox.human_tasks`, async () => {
        const r = await query(
          `SELECT data_type
             FROM information_schema.columns
            WHERE table_schema = 'inbox'
              AND table_name = 'human_tasks'
              AND column_name = $1`,
          [col],
        );
        assert.strictEqual(r.rows.length, 1, `column ${col} must exist`);
        assert.strictEqual(
          r.rows[0].data_type,
          dt,
          `column ${col} data_type mismatch`,
        );
      });
    }

    it('push_attempts defaults to 0 on insert', async () => {
      await query(
        `INSERT INTO inbox.human_tasks (id, title) VALUES ($1, $2)`,
        ['htm-120-attempts-default', 'default attempts check'],
      );
      const r = await query(
        `SELECT push_attempts FROM inbox.human_tasks WHERE id = $1`,
        ['htm-120-attempts-default'],
      );
      assert.strictEqual(r.rows[0].push_attempts, 0);
    });

    it('new task inserted post-migration has push_status NULL by default', async () => {
      await query(
        `INSERT INTO inbox.human_tasks (id, title) VALUES ($1, $2)`,
        ['htm-120-push-status-default', 'default push_status'],
      );
      const r = await query(
        `SELECT push_status, enrichment_status
           FROM inbox.human_tasks WHERE id = $1`,
        ['htm-120-push-status-default'],
      );
      assert.strictEqual(r.rows[0].push_status, null);
      assert.strictEqual(r.rows[0].enrichment_status, null);
    });
  });

  // -----------------------------------------------------------------------
  // human_tasks: push_status CHECK
  // -----------------------------------------------------------------------

  describe('human_tasks.push_status CHECK constraint', () => {
    it('rejects human_tasks insert when push_status is invalid', async () => {
      await assert.rejects(
        () =>
          query(
            `INSERT INTO inbox.human_tasks (id, title, push_status)
             VALUES ($1, $2, $3)`,
            ['htm-120-bad-push', 'x', 'invalid'],
          ),
        /push_status|check/i,
      );
    });

    const PUSH_STATUSES = ['pending', 'running', 'succeeded', 'skipped', 'failed'];
    for (const s of PUSH_STATUSES) {
      it(`accepts human_tasks insert when push_status = '${s}'`, async () => {
        const id = `htm-120-push-${s}`;
        await query(
          `INSERT INTO inbox.human_tasks (id, title, push_status)
           VALUES ($1, $2, $3)`,
          [id, 'push check', s],
        );
        const r = await query(
          `SELECT push_status FROM inbox.human_tasks WHERE id = $1`,
          [id],
        );
        assert.strictEqual(r.rows[0].push_status, s);
      });
    }

    it('accepts NULL push_status (pre-existing rows and new auto-NULL inserts)', async () => {
      await query(
        `INSERT INTO inbox.human_tasks (id, title, push_status)
         VALUES ($1, $2, NULL)`,
        ['htm-120-push-null', 'null push'],
      );
    });
  });

  // -----------------------------------------------------------------------
  // human_tasks: enrichment_status CHECK
  // -----------------------------------------------------------------------

  describe('human_tasks.enrichment_status CHECK constraint', () => {
    it('rejects human_tasks insert when enrichment_status is invalid', async () => {
      await assert.rejects(
        () =>
          query(
            `INSERT INTO inbox.human_tasks (id, title, enrichment_status)
             VALUES ($1, $2, $3)`,
            ['htm-120-bad-enrich', 'x', 'invalid'],
          ),
        /enrichment_status|check/i,
      );
    });

    const ENRICHMENT_STATUSES = [
      'pending', 'running', 'completed', 'failed', 'skipped',
    ];
    for (const s of ENRICHMENT_STATUSES) {
      it(`accepts human_tasks insert when enrichment_status = '${s}'`, async () => {
        const id = `htm-120-enrich-${s}`;
        await query(
          `INSERT INTO inbox.human_tasks (id, title, enrichment_status)
           VALUES ($1, $2, $3)`,
          [id, 'enrich check', s],
        );
        const r = await query(
          `SELECT enrichment_status FROM inbox.human_tasks WHERE id = $1`,
          [id],
        );
        assert.strictEqual(r.rows[0].enrichment_status, s);
      });
    }
  });

  // -----------------------------------------------------------------------
  // last_feedback CHECK widened (§3.1 step 1)
  // -----------------------------------------------------------------------

  describe('human_tasks.last_feedback CHECK widened with v0.2 verbs', () => {
    const NEW_VERBS = ['transition', 'linear_pull', 'linear_push', 'llm_decision'];
    for (const v of NEW_VERBS) {
      it(`accepts last_feedback = '${v}'`, async () => {
        const id = `htm-120-fb-${v}`;
        await query(
          `INSERT INTO inbox.human_tasks (id, title, last_feedback)
           VALUES ($1, $2, $3)`,
          [id, 'fb check', v],
        );
        const r = await query(
          `SELECT last_feedback FROM inbox.human_tasks WHERE id = $1`,
          [id],
        );
        assert.strictEqual(r.rows[0].last_feedback, v);
      });
    }

    const KEPT_VERBS = ['done', 'skip', 'later', 'not_for_me', 'edited'];
    for (const v of KEPT_VERBS) {
      it(`still accepts pre-existing last_feedback = '${v}'`, async () => {
        const id = `htm-120-fb-keep-${v}`;
        await query(
          `INSERT INTO inbox.human_tasks (id, title, last_feedback)
           VALUES ($1, $2, $3)`,
          [id, 'fb keep', v],
        );
      });
    }

    it('rejects last_feedback = "garbage"', async () => {
      await assert.rejects(
        () =>
          query(
            `INSERT INTO inbox.human_tasks (id, title, last_feedback)
             VALUES ($1, $2, $3)`,
            ['htm-120-fb-garbage', 'x', 'garbage'],
          ),
        /last_feedback|check/i,
      );
    });
  });

  // -----------------------------------------------------------------------
  // 6 new indexes on inbox.human_tasks (§3.1 step 3)
  // -----------------------------------------------------------------------

  describe('human_tasks: six new partial indexes', () => {
    const REQUIRED_INDEXES = [
      'human_tasks_pending_enrichment',
      'human_tasks_pending_push',
      'human_tasks_by_linear_issue',
      'human_tasks_by_assignee_status_due',
      'human_tasks_quickwins',
      'human_tasks_by_project_status',
    ];

    for (const idx of REQUIRED_INDEXES) {
      it(`index ${idx} exists`, async () => {
        const r = await query(
          `SELECT indexname FROM pg_indexes
            WHERE schemaname = 'inbox'
              AND tablename = 'human_tasks'
              AND indexname = $1`,
          [idx],
        );
        assert.strictEqual(r.rows.length, 1, `index ${idx} must exist`);
      });

      it(`index ${idx} is partial (has WHERE clause)`, async () => {
        const r = await query(
          `SELECT indexdef FROM pg_indexes
            WHERE schemaname = 'inbox'
              AND tablename = 'human_tasks'
              AND indexname = $1`,
          [idx],
        );
        assert.strictEqual(r.rows.length, 1, `index ${idx} must exist`);
        assert.match(
          r.rows[0].indexdef,
          /WHERE/i,
          `index ${idx} must have a partial WHERE predicate, got: ${r.rows[0].indexdef}`,
        );
        assert.match(
          r.rows[0].indexdef,
          /deleted_at\s+IS\s+NULL/i,
          `index ${idx} must filter deleted_at IS NULL, got: ${r.rows[0].indexdef}`,
        );
      });
    }
  });

  // -----------------------------------------------------------------------
  // inbox.llm_guardrails (§3.1 step 4)
  // -----------------------------------------------------------------------

  describe('inbox.llm_guardrails table', () => {
    it('table exists', async () => {
      const r = await query(
        `SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'inbox' AND table_name = 'llm_guardrails'`,
      );
      assert.strictEqual(r.rows.length, 1, 'inbox.llm_guardrails must exist');
    });

    const COLUMNS = [
      ['id', 'text'],
      ['kind', 'text'],
      ['prompt_text', 'text'],
      ['mapping', 'jsonb'],
      ['is_current', 'boolean'],
      ['revision', 'integer'],
      ['created_by', 'text'],
      ['created_at', 'timestamp with time zone'],
      ['note', 'text'],
    ];

    for (const [col, dt] of COLUMNS) {
      it(`column ${col} (${dt})`, async () => {
        const r = await query(
          `SELECT data_type
             FROM information_schema.columns
            WHERE table_schema = 'inbox'
              AND table_name = 'llm_guardrails'
              AND column_name = $1`,
          [col],
        );
        assert.strictEqual(r.rows.length, 1, `column ${col} must exist`);
        assert.strictEqual(r.rows[0].data_type, dt, `column ${col} data_type mismatch`);
      });
    }

    it('rejects kind values outside (push, pull)', async () => {
      await assert.rejects(
        () =>
          query(
            `INSERT INTO inbox.llm_guardrails
               (id, kind, prompt_text, revision, created_by, is_current)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            ['gr-120-bad-kind', 'bogus', 'p', 1, 'system', false],
          ),
        /kind|check/i,
      );
    });

    it('bootstrap inserts first push guardrail as is_current=true; second push current insert fails', async () => {
      // Operator-action 1: bootstrap a push guardrail (revision 1, current).
      await query(
        `INSERT INTO inbox.llm_guardrails
           (id, kind, prompt_text, revision, created_by, is_current)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ['gr-120-push-1', 'push', 'first push prompt', 1, 'system', true],
      );

      // Operator-action 2: a second push row with is_current=true must be rejected
      // by the partial unique index llm_guardrails_current_per_kind.
      await assert.rejects(
        () =>
          query(
            `INSERT INTO inbox.llm_guardrails
               (id, kind, prompt_text, revision, created_by, is_current)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            ['gr-120-push-2', 'push', 'second push prompt', 2, 'system', true],
          ),
        /unique|current/i,
      );
    });

    it('push current=true and pull current=true can coexist', async () => {
      // Note: gr-120-push-1 inserted in the previous test is still current.
      // Insert a pull current row — should succeed (partial index keys on kind).
      await query(
        `INSERT INTO inbox.llm_guardrails
           (id, kind, prompt_text, revision, created_by, is_current)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ['gr-120-pull-1', 'pull', 'first pull prompt', 1, 'system', true],
      );

      const r = await query(
        `SELECT kind, COUNT(*)::int AS n
           FROM inbox.llm_guardrails
          WHERE is_current = true
          GROUP BY kind
          ORDER BY kind`,
      );
      const byKind = Object.fromEntries(r.rows.map(row => [row.kind, row.n]));
      assert.strictEqual(byKind.push, 1, 'exactly one current push row');
      assert.strictEqual(byKind.pull, 1, 'exactly one current pull row');
    });

    it('multiple non-current revisions per kind coexist (history is append-only)', async () => {
      // Revision history: insert two more non-current push rows.
      await query(
        `INSERT INTO inbox.llm_guardrails
           (id, kind, prompt_text, revision, created_by, is_current)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ['gr-120-push-hist-a', 'push', 'older a', 2, 'system', false],
      );
      await query(
        `INSERT INTO inbox.llm_guardrails
           (id, kind, prompt_text, revision, created_by, is_current)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ['gr-120-push-hist-b', 'push', 'older b', 3, 'system', false],
      );

      const r = await query(
        `SELECT COUNT(*)::int AS n FROM inbox.llm_guardrails
          WHERE kind = 'push' AND is_current = false`,
      );
      assert.ok(r.rows[0].n >= 2, 'non-current push history accumulates');
    });

    it('mapping column defaults to empty JSONB object', async () => {
      await query(
        `INSERT INTO inbox.llm_guardrails
           (id, kind, prompt_text, revision, created_by)
         VALUES ($1, $2, $3, $4, $5)`,
        ['gr-120-mapping-default', 'pull', 'mapping default', 99, 'system'],
      );
      const r = await query(
        `SELECT mapping FROM inbox.llm_guardrails WHERE id = $1`,
        ['gr-120-mapping-default'],
      );
      const mapping = typeof r.rows[0].mapping === 'string'
        ? JSON.parse(r.rows[0].mapping)
        : r.rows[0].mapping;
      assert.deepStrictEqual(mapping, {});
    });
  });

  // -----------------------------------------------------------------------
  // inbox.linear_team_cache (§3.1 step 5)
  // -----------------------------------------------------------------------

  describe('inbox.linear_team_cache table', () => {
    it('table exists', async () => {
      const r = await query(
        `SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'inbox' AND table_name = 'linear_team_cache'`,
      );
      assert.strictEqual(r.rows.length, 1);
    });

    const COLUMNS = [
      ['team_id', 'text'],
      ['workflow_states', 'jsonb'],
      ['projects', 'jsonb'],
      ['members', 'jsonb'],
      ['labels', 'jsonb'],
      ['refreshed_at', 'timestamp with time zone'],
    ];

    for (const [col, dt] of COLUMNS) {
      it(`column ${col} (${dt})`, async () => {
        const r = await query(
          `SELECT data_type
             FROM information_schema.columns
            WHERE table_schema = 'inbox'
              AND table_name = 'linear_team_cache'
              AND column_name = $1`,
          [col],
        );
        assert.strictEqual(r.rows.length, 1, `column ${col} must exist`);
        assert.strictEqual(r.rows[0].data_type, dt);
      });
    }

    it('team_id is PRIMARY KEY (single row per team)', async () => {
      await query(
        `INSERT INTO inbox.linear_team_cache (team_id) VALUES ($1)`,
        ['team-120-a'],
      );
      await assert.rejects(
        () =>
          query(
            `INSERT INTO inbox.linear_team_cache (team_id) VALUES ($1)`,
            ['team-120-a'],
          ),
        /unique|primary|duplicate/i,
      );
    });
  });

  // -----------------------------------------------------------------------
  // inbox.human_task_sync_log (§3.1 step 6)
  // -----------------------------------------------------------------------

  describe('inbox.human_task_sync_log table', () => {
    it('table exists', async () => {
      const r = await query(
        `SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'inbox' AND table_name = 'human_task_sync_log'`,
      );
      assert.strictEqual(r.rows.length, 1);
    });

    const COLUMNS = [
      ['id', 'bigint'],
      ['task_id', 'text'],
      ['direction', 'text'],
      ['outcome', 'text'],
      ['before_snapshot', 'jsonb'],
      ['after_snapshot', 'jsonb'],
      ['guardrail_id', 'text'],
      ['backfill_batch_id', 'text'],
      ['error_text', 'text'],
      ['duration_ms', 'integer'],
      ['at', 'timestamp with time zone'],
    ];

    for (const [col, dt] of COLUMNS) {
      it(`column ${col} (${dt})`, async () => {
        const r = await query(
          `SELECT data_type
             FROM information_schema.columns
            WHERE table_schema = 'inbox'
              AND table_name = 'human_task_sync_log'
              AND column_name = $1`,
          [col],
        );
        assert.strictEqual(r.rows.length, 1, `column ${col} must exist`);
        assert.strictEqual(r.rows[0].data_type, dt);
      });
    }

    it('direction CHECK rejects values outside (push, pull, reconcile)', async () => {
      await query(
        `INSERT INTO inbox.human_tasks (id, title) VALUES ($1, $2)`,
        ['htm-120-sync-parent-1', 'sync parent'],
      );
      await assert.rejects(
        () =>
          query(
            `INSERT INTO inbox.human_task_sync_log
               (task_id, direction, outcome) VALUES ($1, $2, $3)`,
            ['htm-120-sync-parent-1', 'bogus', 'success'],
          ),
        /direction|check/i,
      );
    });

    it('outcome CHECK rejects values outside the documented set', async () => {
      await assert.rejects(
        () =>
          query(
            `INSERT INTO inbox.human_task_sync_log
               (task_id, direction, outcome) VALUES ($1, $2, $3)`,
            ['htm-120-sync-parent-1', 'push', 'bogus'],
          ),
        /outcome|check/i,
      );
    });

    it('sync worker inserts a log row and SELECT by task_id returns it ordered DESC', async () => {
      await query(
        `INSERT INTO inbox.human_tasks (id, title) VALUES ($1, $2)`,
        ['htm-120-sync-parent-2', 'sync parent 2'],
      );
      await query(
        `INSERT INTO inbox.human_task_sync_log
           (task_id, direction, outcome, duration_ms)
         VALUES ($1, $2, $3, $4)`,
        ['htm-120-sync-parent-2', 'push', 'success', 100],
      );
      await query(
        `INSERT INTO inbox.human_task_sync_log
           (task_id, direction, outcome, duration_ms)
         VALUES ($1, $2, $3, $4)`,
        ['htm-120-sync-parent-2', 'pull', 'no_change', 50],
      );
      const r = await query(
        `SELECT direction, outcome
           FROM inbox.human_task_sync_log
          WHERE task_id = $1
          ORDER BY at DESC, id DESC`,
        ['htm-120-sync-parent-2'],
      );
      assert.strictEqual(r.rows.length, 2);
      // Most recent insert (pull/no_change) appears first.
      assert.strictEqual(r.rows[0].direction, 'pull');
      assert.strictEqual(r.rows[0].outcome, 'no_change');
    });

    it('deleting a human_tasks row cascades its sync_log rows', async () => {
      await query(
        `INSERT INTO inbox.human_tasks (id, title) VALUES ($1, $2)`,
        ['htm-120-sync-cascade', 'cascade parent'],
      );
      await query(
        `INSERT INTO inbox.human_task_sync_log
           (task_id, direction, outcome) VALUES ($1, $2, $3)`,
        ['htm-120-sync-cascade', 'push', 'success'],
      );

      await query(
        `DELETE FROM inbox.human_tasks WHERE id = $1`,
        ['htm-120-sync-cascade'],
      );

      const r = await query(
        `SELECT COUNT(*)::int AS n
           FROM inbox.human_task_sync_log
          WHERE task_id = $1`,
        ['htm-120-sync-cascade'],
      );
      assert.strictEqual(r.rows[0].n, 0, 'sync_log rows must cascade-delete');
    });

    it('partial index human_task_sync_log_by_batch exists with WHERE backfill_batch_id IS NOT NULL', async () => {
      const r = await query(
        `SELECT indexdef FROM pg_indexes
          WHERE schemaname = 'inbox'
            AND tablename = 'human_task_sync_log'
            AND indexname = $1`,
        ['human_task_sync_log_by_batch'],
      );
      assert.strictEqual(r.rows.length, 1, 'partial backfill index must exist');
      assert.match(
        r.rows[0].indexdef,
        /WHERE\s*\(?\s*backfill_batch_id\s+IS\s+NOT\s+NULL/i,
        `index must be WHERE backfill_batch_id IS NOT NULL, got: ${r.rows[0].indexdef}`,
      );
    });

    it('index human_task_sync_log_by_task exists', async () => {
      const r = await query(
        `SELECT indexname FROM pg_indexes
          WHERE schemaname = 'inbox'
            AND tablename = 'human_task_sync_log'
            AND indexname = $1`,
        ['human_task_sync_log_by_task'],
      );
      assert.strictEqual(r.rows.length, 1);
    });
  });

  // -----------------------------------------------------------------------
  // inbox.linear_backfill_batches (§3.1 step 7)
  // -----------------------------------------------------------------------

  describe('inbox.linear_backfill_batches table', () => {
    it('table exists', async () => {
      const r = await query(
        `SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'inbox' AND table_name = 'linear_backfill_batches'`,
      );
      assert.strictEqual(r.rows.length, 1);
    });

    const COLUMNS = [
      ['id', 'text'],
      ['created_by', 'text'],
      ['created_at', 'timestamp with time zone'],
      ['filter_json', 'jsonb'],
      ['task_count', 'integer'],
      ['state', 'text'],
      ['completed_at', 'timestamp with time zone'],
    ];

    for (const [col, dt] of COLUMNS) {
      it(`column ${col} (${dt})`, async () => {
        const r = await query(
          `SELECT data_type
             FROM information_schema.columns
            WHERE table_schema = 'inbox'
              AND table_name = 'linear_backfill_batches'
              AND column_name = $1`,
          [col],
        );
        assert.strictEqual(r.rows.length, 1, `column ${col} must exist`);
        assert.strictEqual(r.rows[0].data_type, dt);
      });
    }

    it('state CHECK rejects "foo"', async () => {
      await assert.rejects(
        () =>
          query(
            `INSERT INTO inbox.linear_backfill_batches
               (id, created_by, filter_json, task_count, state)
             VALUES ($1, $2, $3, $4, $5)`,
            ['bf-120-bad-state', 'isaias', '{}', 0, 'foo'],
          ),
        /state|check/i,
      );
    });

    it('state defaults to "pending" and accepts an empty (task_count=0) batch', async () => {
      // Operator opens the Backfill panel with no rows matching filter and
      // still creates a batch — empty batches must succeed.
      await query(
        `INSERT INTO inbox.linear_backfill_batches
           (id, created_by, filter_json, task_count)
         VALUES ($1, $2, $3, $4)`,
        ['bf-120-empty', 'isaias', '{}', 0],
      );
      const r = await query(
        `SELECT state, task_count FROM inbox.linear_backfill_batches WHERE id = $1`,
        ['bf-120-empty'],
      );
      assert.strictEqual(r.rows[0].state, 'pending');
      assert.strictEqual(r.rows[0].task_count, 0);
    });

    const VALID_STATES = ['pending', 'in_progress', 'completed', 'cancelled'];
    for (const s of VALID_STATES) {
      it(`accepts batch with state = '${s}'`, async () => {
        const id = `bf-120-state-${s}`;
        await query(
          `INSERT INTO inbox.linear_backfill_batches
             (id, created_by, filter_json, task_count, state)
           VALUES ($1, $2, $3, $4, $5)`,
          [id, 'isaias', '{}', 0, s],
        );
        const r = await query(
          `SELECT state FROM inbox.linear_backfill_batches WHERE id = $1`,
          [id],
        );
        assert.strictEqual(r.rows[0].state, s);
      });
    }
  });

  // -----------------------------------------------------------------------
  // §3.2: existing v0.1 rows survive migration, new columns coexist
  // -----------------------------------------------------------------------

  describe('§3.2 data backfill: pre-existing v0.1 rows survive', () => {
    it('a row inserted with only v0.1 columns still selects cleanly with the new columns present', async () => {
      // Simulate a row that was inserted BEFORE migration 120 ran by inserting
      // it now using only v0.1-known columns. After the migration adds the new
      // columns, this row must still be selectable with NULL/default values.
      await query(
        `INSERT INTO inbox.human_tasks (id, title, status, priority)
         VALUES ($1, $2, $3, $4)`,
        ['htm-120-v01-survivor', 'pretend pre-migration row', 'todo', 'normal'],
      );
      const r = await query(
        `SELECT id, title, status, priority,
                linear_state_id, linear_state_name, linear_assignee_id,
                linear_project_id, linear_last_event_at,
                push_status, push_skip_reason, push_last_error, push_attempts,
                enrichment_status, enrichment_at
           FROM inbox.human_tasks WHERE id = $1`,
        ['htm-120-v01-survivor'],
      );
      assert.strictEqual(r.rows.length, 1, 'v0.1 row must survive');
      const row = r.rows[0];
      assert.strictEqual(row.title, 'pretend pre-migration row');
      assert.strictEqual(row.status, 'todo');
      assert.strictEqual(row.linear_state_id, null);
      assert.strictEqual(row.push_status, null);
      assert.strictEqual(row.push_attempts, 0);
    });
  });
});
