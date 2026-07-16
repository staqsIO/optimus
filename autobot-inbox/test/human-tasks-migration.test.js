/**
 * RED step (TDD) — migration 119-human-tasks.sql does not yet exist.
 *
 * Verifies the schema contract from
 * autobot-inbox/docs/internal/prds/meeting-actions-to-kanban.md §5:
 *
 *   - Table `inbox.human_tasks` exists with required columns.
 *   - CHECK constraints on `priority`, `size`, `status`, `task_type`,
 *     `last_feedback`.
 *   - Indexes for (status, priority, due_date), (assignee_contact_id,
 *     status), (signal_id).
 *   - FK from `signal_id` to `inbox.signals(id)` with ON DELETE SET NULL.
 *   - Defaults: status='inbox', priority='normal', tags='{}',
 *     related_contact_ids='{}', feedback_history='[]'.
 *
 * Tests are framework-agnostic (node:test) and run against the shared
 * PGlite singleton — see test/helpers/setup-db.js.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';

describe('migration 119 — inbox.human_tasks', () => {
  let query;

  before(async () => {
    ({ query } = await getDb());
  });

  // ---- Existence ---------------------------------------------------------

  it('table inbox.human_tasks exists', async () => {
    const result = await query(`
      SELECT 1
        FROM information_schema.tables
       WHERE table_schema = 'inbox'
         AND table_name = 'human_tasks'
    `);
    assert.equal(result.rows.length, 1, 'inbox.human_tasks table must exist');
  });

  // ---- Required columns --------------------------------------------------

  const REQUIRED_COLUMNS = [
    ['id', 'text'],
    ['signal_id', 'text'],
    ['message_id', 'text'],
    ['source_quote', 'text'],
    ['source_ts', 'text'],
    ['title', 'text'],
    ['description', 'text'],
    ['due_date', 'date'],
    ['priority', 'text'],
    ['size', 'text'],
    ['assignee_contact_id', 'text'],
    ['assignee_label', 'text'],
    ['assignee_confidence', 'numeric'],
    ['status', 'text'],
    ['snoozed_until', 'timestamp with time zone'],
    ['task_type', 'text'],
    ['project_id', 'text'],
    ['engagement_id', 'uuid'],
    ['tags', 'ARRAY'],
    ['next_action_hint', 'text'],
    ['related_contact_ids', 'ARRAY'],
    ['relevance_score', 'numeric'],
    ['extraction_confidence', 'numeric'],
    ['last_feedback', 'text'],
    ['last_feedback_at', 'timestamp with time zone'],
    ['feedback_history', 'jsonb'],
    ['linear_issue_id', 'text'],
    ['linear_issue_url', 'text'],
    ['linear_synced_at', 'timestamp with time zone'],
    ['created_by', 'text'],
    ['created_at', 'timestamp with time zone'],
    ['updated_at', 'timestamp with time zone'],
    ['deleted_at', 'timestamp with time zone'],
  ];

  for (const [col, dt] of REQUIRED_COLUMNS) {
    it(`column ${col} (${dt})`, async () => {
      const r = await query(
        `SELECT data_type
           FROM information_schema.columns
          WHERE table_schema = 'inbox'
            AND table_name = 'human_tasks'
            AND column_name = $1`,
        [col],
      );
      assert.equal(r.rows.length, 1, `column ${col} must exist`);
      assert.equal(r.rows[0].data_type, dt, `column ${col} data_type mismatch`);
    });
  }

  // ---- CHECK constraints (functional, not introspective) -----------------
  // Why functional: PGlite's pg_constraint introspection is fragile and the
  // contract that matters to callers is "the DB rejects bad values."

  it('status CHECK rejects unknown status', async () => {
    await assert.rejects(
      () =>
        query(
          `INSERT INTO inbox.human_tasks (id, title, status)
           VALUES ('htm-test-bad-status-1', 'x', 'not_a_status')`,
        ),
      /status|check/i,
    );
  });

  it('status CHECK accepts all 10 documented values', async () => {
    const STATUSES = [
      'inbox', 'proposed', 'todo', 'in_progress', 'blocked',
      'later', 'review', 'done', 'skipped', 'not_for_us',
    ];
    for (const s of STATUSES) {
      const id = `htm-test-status-${s}`;
      await query(
        `INSERT INTO inbox.human_tasks (id, title, status)
         VALUES ($1, 'status check', $2)`,
        [id, s],
      );
      const r = await query(
        `SELECT status FROM inbox.human_tasks WHERE id = $1`,
        [id],
      );
      assert.equal(r.rows[0].status, s);
    }
  });

  it('priority CHECK rejects unknown priority', async () => {
    await assert.rejects(
      () =>
        query(
          `INSERT INTO inbox.human_tasks (id, title, priority)
           VALUES ('htm-test-bad-prio-1', 'x', 'screaming')`,
        ),
      /priority|check/i,
    );
  });

  it('priority CHECK accepts urgent/high/normal/low', async () => {
    for (const p of ['urgent', 'high', 'normal', 'low']) {
      await query(
        `INSERT INTO inbox.human_tasks (id, title, priority)
         VALUES ($1, 'prio check', $2)`,
        [`htm-test-prio-${p}`, p],
      );
    }
  });

  it('size CHECK accepts NULL and quick/small/medium/large', async () => {
    for (const s of [null, 'quick', 'small', 'medium', 'large']) {
      const id = `htm-test-size-${s ?? 'null'}`;
      await query(
        `INSERT INTO inbox.human_tasks (id, title, size)
         VALUES ($1, 'size check', $2)`,
        [id, s],
      );
    }
  });

  it('size CHECK rejects unknown size', async () => {
    await assert.rejects(
      () =>
        query(
          `INSERT INTO inbox.human_tasks (id, title, size)
           VALUES ('htm-test-bad-size-1', 'x', 'huge')`,
        ),
      /size|check/i,
    );
  });

  it('task_type CHECK accepts NULL and the 4 documented values', async () => {
    for (const t of [null, 'action', 'decision_followup', 'request', 'blocker']) {
      const id = `htm-test-type-${t ?? 'null'}`;
      await query(
        `INSERT INTO inbox.human_tasks (id, title, task_type)
         VALUES ($1, 'type check', $2)`,
        [id, t],
      );
    }
  });

  it('last_feedback CHECK accepts the 5 documented values + NULL', async () => {
    for (const f of [null, 'done', 'skip', 'later', 'not_for_me', 'edited']) {
      const id = `htm-test-fb-${f ?? 'null'}`;
      await query(
        `INSERT INTO inbox.human_tasks (id, title, last_feedback)
         VALUES ($1, 'fb check', $2)`,
        [id, f],
      );
    }
  });

  // ---- Defaults ----------------------------------------------------------

  it('default status is "inbox", priority is "normal"', async () => {
    await query(
      `INSERT INTO inbox.human_tasks (id, title) VALUES ('htm-test-defaults-1', 'd')`,
    );
    const r = await query(
      `SELECT status, priority, tags, related_contact_ids, feedback_history,
              created_by, created_at, updated_at
         FROM inbox.human_tasks
        WHERE id = 'htm-test-defaults-1'`,
    );
    const row = r.rows[0];
    assert.equal(row.status, 'inbox');
    assert.equal(row.priority, 'normal');
    assert.deepEqual(row.tags, []);
    assert.deepEqual(row.related_contact_ids, []);
    // feedback_history default is JSONB '[]'
    assert.deepEqual(
      typeof row.feedback_history === 'string'
        ? JSON.parse(row.feedback_history)
        : row.feedback_history,
      [],
    );
    assert.equal(row.created_by, 'meeting_pipeline');
    assert.ok(row.created_at, 'created_at autoset');
    assert.ok(row.updated_at, 'updated_at autoset');
  });

  // ---- title NOT NULL ----------------------------------------------------

  it('title is NOT NULL', async () => {
    await assert.rejects(
      () =>
        query(
          `INSERT INTO inbox.human_tasks (id, title) VALUES ('htm-test-no-title-1', NULL)`,
        ),
      /title|null/i,
    );
  });

  // ---- Indexes -----------------------------------------------------------

  const REQUIRED_INDEXES = [
    'human_tasks_by_status_priority',
    'human_tasks_by_assignee',
    'human_tasks_by_signal',
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
      assert.equal(r.rows.length, 1, `index ${idx} must exist`);
    });
  }

  // Both status-priority and assignee indexes are partial on
  // deleted_at IS NULL. A future hand could drop the partial predicate and
  // tests would still pass — these guard against that.
  for (const idx of ['human_tasks_by_status_priority', 'human_tasks_by_assignee']) {
    it(`index ${idx} is partial on deleted_at IS NULL`, async () => {
      const r = await query(
        `SELECT indexdef FROM pg_indexes
          WHERE schemaname = 'inbox'
            AND tablename = 'human_tasks'
            AND indexname = $1`,
        [idx],
      );
      assert.ok(
        /WHERE\s*\(?\s*deleted_at\s+IS\s+NULL\s*\)?/i.test(r.rows[0].indexdef),
        `index ${idx} must be WHERE deleted_at IS NULL, got: ${r.rows[0].indexdef}`,
      );
    });
  }

  // ---- NUMERIC(3,2) range CHECKs (0..1) — PRD §5 -------------------------

  for (const col of ['assignee_confidence', 'relevance_score', 'extraction_confidence']) {
    it(`${col} rejects values > 1`, async () => {
      await assert.rejects(
        () =>
          query(
            `INSERT INTO inbox.human_tasks (id, title, ${col}) VALUES ($1, 't', 1.5)`,
            [`htm-test-range-hi-${col}`],
          ),
        new RegExp(`${col}|check|range|numeric`, 'i'),
      );
    });

    it(`${col} rejects values < 0`, async () => {
      await assert.rejects(
        () =>
          query(
            `INSERT INTO inbox.human_tasks (id, title, ${col}) VALUES ($1, 't', -0.1)`,
            [`htm-test-range-lo-${col}`],
          ),
        new RegExp(`${col}|check|range|numeric`, 'i'),
      );
    });

    it(`${col} accepts 0 and 1 (boundary)`, async () => {
      await query(
        `INSERT INTO inbox.human_tasks (id, title, ${col}) VALUES ($1, 't', 0)`,
        [`htm-test-range-zero-${col}`],
      );
      await query(
        `INSERT INTO inbox.human_tasks (id, title, ${col}) VALUES ($1, 't', 1)`,
        [`htm-test-range-one-${col}`],
      );
    });
  }

  // ---- FK signal_id → inbox.signals(id) ON DELETE SET NULL ---------------

  it('signal_id FK is ON DELETE SET NULL', async () => {
    // Create a fake message + signal to point at.
    await query(
      `INSERT INTO inbox.accounts (id, owner, label, identifier, channel, provider)
       VALUES ('acc-htm-fk', 'isaias', 'fk', 'fk@example.com', 'email', 'gmail')
       ON CONFLICT DO NOTHING`,
    );
    await query(
      `INSERT INTO inbox.messages
         (id, account_id, channel, provider, provider_msg_id, thread_id,
          message_id, from_address, received_at)
       VALUES ('msg-htm-fk', 'acc-htm-fk', 'email', 'gmail', 'pm-htm-fk', 't-htm-fk',
               'mid-htm-fk', 'sender@example.com', now())`,
    );
    await query(
      `INSERT INTO inbox.signals (id, message_id, signal_type, content, confidence, direction, domain)
       VALUES ('sig-htm-fk', 'msg-htm-fk', 'action_item', 'check fk', 0.9, 'outbound', 'general')`,
    );
    await query(
      `INSERT INTO inbox.human_tasks (id, signal_id, title)
       VALUES ('htm-test-fk-1', 'sig-htm-fk', 'fk test')`,
    );

    // Deleting the signal should NULL out signal_id, not error.
    await query(`DELETE FROM inbox.signals WHERE id = 'sig-htm-fk'`);

    const r = await query(
      `SELECT signal_id FROM inbox.human_tasks WHERE id = 'htm-test-fk-1'`,
    );
    assert.equal(r.rows.length, 1, 'human_tasks row must survive signal delete');
    assert.equal(r.rows[0].signal_id, null, 'signal_id must be SET NULL');
  });
});
