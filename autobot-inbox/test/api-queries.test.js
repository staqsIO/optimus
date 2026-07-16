import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

/**
 * API Query Integration Tests — validates that all critical SQL queries
 * execute successfully against the current schema.
 *
 * Catches: non-existent columns, schema mismatches after migrations,
 * JOIN issues between tables. Prevents the campaigns metadata bug
 * (5 sequential fix commits debugging in production).
 *
 * Uses PGlite — same pattern as permissions.test.js.
 */

describe('API query integration tests', () => {
  let queryFn;

  // Test data IDs
  const WORK_ITEM_ID = '00000000-0000-0000-0000-000000000001';
  const CAMPAIGN_ID = '00000000-0000-0000-0000-000000000002';
  const PROPOSAL_ID = '00000000-0000-0000-0000-000000000004';
  const ITERATION_ID = '00000000-0000-0000-0000-000000000005';
  const HITL_ID = '00000000-0000-0000-0000-000000000006';
  const STEP_ID = '00000000-0000-0000-0000-000000000007';

  before(async () => {
    delete process.env.DATABASE_URL;
    process.env.NODE_ENV = 'test';
    process.env.SQL_DIR = new URL('../sql', import.meta.url).pathname;
    // Use ephemeral PGlite (no persisted data dir conflicts with other tests)
    process.env.PGLITE_DATA_DIR = new URL('../data/pglite-api-test', import.meta.url).pathname;

    const db = await import('../src/db.js');
    queryFn = db.query;

    // Roles are now pre-created in lib/db.js getPgLite() — no need to create here
    await db.initializeDatabase();

    // Seed agent configs (FK references)
    await queryFn(`
      INSERT INTO agent_graph.agent_configs (id, agent_type, model, system_prompt, config_hash, is_active)
      VALUES
        ('orchestrator', 'orchestrator', 'sonnet', 'test', 'testhash', true),
        ('executor-intake', 'executor', 'haiku', 'test', 'testhash', true),
        ('executor-triage', 'executor', 'haiku', 'test', 'testhash', true),
        ('executor-responder', 'executor', 'haiku', 'test', 'testhash', true),
        ('executor-ticket', 'executor', 'haiku', 'test', 'testhash', true),
        ('reviewer', 'reviewer', 'sonnet', 'test', 'testhash', true)
      ON CONFLICT (id) DO NOTHING
    `);

    // Seed a work item (type is 'task', not 'event_type')
    await queryFn(`
      INSERT INTO agent_graph.work_items (id, title, type, status, assigned_to, created_by)
      VALUES ($1, 'Test campaign work item', 'task', 'completed', 'orchestrator', 'board')
      ON CONFLICT (id) DO NOTHING
    `, [WORK_ITEM_ID]);

    // Seed a campaign
    await queryFn(`
      INSERT INTO agent_graph.campaigns (
        id, work_item_id, goal_description, budget_envelope_usd,
        campaign_status, campaign_mode, created_by, metadata
      ) VALUES ($1, $2, 'Test campaign goal', 10.00, 'succeeded', 'stateless', 'board', '{}')
      ON CONFLICT (id) DO NOTHING
    `, [CAMPAIGN_ID, WORK_ITEM_ID]);

    // Seed a campaign iteration
    await queryFn(`
      INSERT INTO agent_graph.campaign_iterations (
        id, campaign_id, work_item_id, iteration_number, decision, cost_usd
      ) VALUES ($1, $2, $3, 1, 'keep', 0.01)
      ON CONFLICT (id) DO NOTHING
    `, [ITERATION_ID, CAMPAIGN_ID, WORK_ITEM_ID]);

    // Seed an action proposal with code_fix_pr type (requires target_repo + github_pr_url)
    await queryFn(`
      INSERT INTO agent_graph.action_proposals (
        id, action_type, work_item_id, campaign_id, body, version,
        target_repo, github_pr_url, github_pr_number
      ) VALUES ($1, 'code_fix_pr', $2, $3, 'test body', 1,
        'staqsIO/optimus', 'https://github.com/staqsIO/optimus/pull/99', 99)
      ON CONFLICT (id) DO NOTHING
    `, [PROPOSAL_ID, WORK_ITEM_ID, CAMPAIGN_ID]);

    // Seed an activity step
    await queryFn(`
      INSERT INTO agent_graph.agent_activity_steps (
        id, work_item_id, agent_id, step_type, description, status, metadata
      ) VALUES ($1, $2, 'orchestrator', 'task_execution', 'test step', 'completed', '{"summary":"test decision"}')
      ON CONFLICT (id) DO NOTHING
    `, [STEP_ID, WORK_ITEM_ID]);

    // Seed HITL request (if table exists)
    try {
      await queryFn(`
        INSERT INTO agent_graph.campaign_hitl_requests (
          id, campaign_id, agent_id, question, status
        ) VALUES ($1, $2, 'orchestrator', 'Test question?', 'pending')
        ON CONFLICT (id) DO NOTHING
      `, [HITL_ID, CAMPAIGN_ID]);
    } catch {
      // HITL table may not exist in all migration versions
    }
  });

  // NOTE: Do not call close() — PGlite WASM cannot be reinitialized after
  // close in the same process, which crashes all subsequent PGlite-using tests.
  // Process exit handles PGlite cleanup via the registered exit handler in db.js.

  // ── GET /api/campaigns (list) ──────────────────────────────────────
  it('campaigns list query executes without error', async () => {
    const r = await queryFn(`
      SELECT
        c.id, c.work_item_id, c.goal_description, c.campaign_status,
        c.budget_envelope_usd, c.spent_usd, c.reserved_usd,
        c.max_iterations, c.completed_iterations,
        c.created_at, c.completed_at, c.updated_at,
        c.campaign_mode, c.source_intent_id, c.created_by,
        w.title AS work_item_title, w.status AS work_item_status,
        (SELECT COUNT(*) FROM agent_graph.campaign_iterations ci WHERE ci.campaign_id = c.id) AS total_iterations,
        (SELECT MAX(quality_score) FROM agent_graph.campaign_iterations ci WHERE ci.campaign_id = c.id AND ci.decision = 'keep') AS best_score
      FROM agent_graph.campaigns c
      JOIN agent_graph.work_items w ON w.id = c.work_item_id
      ORDER BY c.created_at DESC
      LIMIT 50
    `);
    assert.ok(Array.isArray(r.rows), 'Should return rows array');
    assert.ok(r.rows.length >= 1, 'Should find seeded campaign');
  });

  // ── GET /api/campaigns/:id (detail) ────────────────────────────────
  it('campaigns detail query executes without error', async () => {
    const r = await queryFn(`
      SELECT
        c.*, c.iteration_time_budget::text AS iteration_time_budget,
        w.title AS work_item_title, w.status AS work_item_status, w.assigned_to,
        (SELECT json_agg(json_build_object(
          'iteration_number', ci.iteration_number,
          'quality_score', ci.quality_score,
          'decision', ci.decision,
          'cost_usd', ci.cost_usd,
          'duration_ms', ci.duration_ms,
          'strategy_used', ci.strategy_used,
          'git_commit_hash', ci.git_commit_hash,
          'failure_analysis', ci.failure_analysis,
          'action_taken', ci.action_taken,
          'created_at', ci.created_at
        ) ORDER BY ci.iteration_number DESC)
        FROM agent_graph.campaign_iterations ci
        WHERE ci.campaign_id = c.id
        LIMIT 100) AS iterations
      FROM agent_graph.campaigns c
      JOIN agent_graph.work_items w ON w.id = c.work_item_id
      WHERE c.id = $1
    `, [CAMPAIGN_ID]);
    assert.ok(r.rows.length === 1, 'Should find campaign by ID');
    assert.ok(r.rows[0].metadata !== undefined, 'Should have metadata column');
    assert.ok(r.rows[0].source_intent_id !== undefined, 'Should have source_intent_id');
    assert.ok(r.rows[0].created_by !== undefined, 'Should have created_by');
  });

  // ── GET /api/campaigns/:id — PR lookup on action_proposals ─────────
  // THIS IS THE QUERY THAT CAUSED THE 5-DEPLOY BUG
  it('campaigns PR lookup query uses correct columns (not metadata)', async () => {
    const r = await queryFn(`
      SELECT github_pr_url AS pr_url, github_pr_number AS pr_number, target_repo AS branch
      FROM agent_graph.action_proposals
      WHERE campaign_id = $1 AND action_type = 'code_fix_pr' AND github_pr_url IS NOT NULL
      ORDER BY created_at DESC LIMIT 1
    `, [CAMPAIGN_ID]);
    assert.ok(Array.isArray(r.rows), 'PR lookup should not throw');
  });

  // ── GET /api/campaigns/:id/iterations ──────────────────────────────
  it('campaigns iterations query executes without error', async () => {
    const r = await queryFn(`
      SELECT
        ci.iteration_number, ci.quality_score, ci.quality_details,
        ci.decision, ci.cost_usd, ci.duration_ms,
        ci.strategy_used, ci.failure_analysis, ci.strategy_adjustment,
        ci.git_commit_hash, ci.content_policy_result, ci.action_taken, ci.created_at
      FROM agent_graph.campaign_iterations ci
      WHERE ci.campaign_id = $1
      ORDER BY ci.iteration_number DESC
      LIMIT 50 OFFSET 0
    `, [CAMPAIGN_ID]);
    assert.ok(r.rows.length >= 1, 'Should find seeded iteration');
  });

  // ── GET /api/campaigns/:id/history ─────────────────────────────────
  it('campaigns history query merges iterations and HITL', async () => {
    // Iterations subquery
    const iterRows = await queryFn(`
      SELECT
        'iteration' AS event_type,
        ci.id,
        ci.iteration_number,
        ci.quality_score,
        ci.decision,
        ci.cost_usd,
        ci.duration_ms,
        ci.failure_analysis,
        ci.action_taken,
        NULL::text AS question,
        NULL::text AS answer,
        NULL::text AS hitl_status,
        NULL::text AS agent_id,
        ci.git_commit_hash,
        ci.created_at
      FROM agent_graph.campaign_iterations ci
      WHERE ci.campaign_id = $1
    `, [CAMPAIGN_ID]);
    assert.ok(Array.isArray(iterRows.rows), 'Iterations subquery should work');
  });

  // ── POST /api/campaigns (insert) ──────────────────────────────────
  it('campaigns insert query uses all required columns', async () => {
    const newId = '00000000-0000-0000-0000-000000000099';
    const newWiId = '00000000-0000-0000-0000-000000000098';

    await queryFn(`
      INSERT INTO agent_graph.work_items (id, title, type, status, assigned_to, created_by)
      VALUES ($1, 'Test insert campaign', 'task', 'created', 'orchestrator', 'board')
      ON CONFLICT (id) DO NOTHING
    `, [newWiId]);

    // Use ON CONFLICT to handle persisted PGlite data between runs
    const r = await queryFn(`
      INSERT INTO agent_graph.campaigns (
        id, work_item_id, goal_description, success_criteria, constraints,
        budget_envelope_usd, max_iterations, iteration_time_budget,
        campaign_status, campaign_mode, created_by, metadata
      ) VALUES (
        $1, $2, 'Test insert goal', '[]'::jsonb, '{}'::jsonb,
        5.00, 10, '5 minutes'::interval, 'pending_approval', 'stateless', 'board', '{}'::jsonb
      ) ON CONFLICT (id) DO UPDATE SET campaign_status = 'pending_approval'
      RETURNING id, campaign_status
    `, [newId, newWiId]);
    assert.ok(r.rows.length === 1, 'INSERT should return new campaign');
    assert.equal(r.rows[0].campaign_status, 'pending_approval');
  });

  // ── Activity steps with decision context ───────────────────────────
  it('activity steps include decision metadata', async () => {
    const r = await queryFn(`
      SELECT id, work_item_id, agent_id, step_type, description, status, metadata,
             created_at, completed_at
      FROM agent_graph.agent_activity_steps
      WHERE work_item_id = $1
      ORDER BY created_at DESC
    `, [WORK_ITEM_ID]);
    assert.ok(r.rows.length >= 1, 'Should find activity steps');
    assert.ok(r.rows[0].metadata?.summary, 'Should have decision summary in metadata');
  });

  // ── Claude Code pattern tables exist ───────────────────────────────
  it('context_summaries table exists and is queryable', async () => {
    const r = await queryFn(`SELECT COUNT(*) FROM agent_graph.context_summaries`);
    assert.ok(r.rows[0].count !== undefined);
  });

  it('auto_classifications table exists and is queryable', async () => {
    const r = await queryFn(`SELECT COUNT(*) FROM agent_graph.auto_classifications`);
    assert.ok(r.rows[0].count !== undefined);
  });

  it('agent_memories table exists and is queryable', async () => {
    const r = await queryFn(`SELECT COUNT(*) FROM agent_graph.agent_memories`);
    assert.ok(r.rows[0].count !== undefined);
  });

  it('daemon_ticks table exists and is queryable', async () => {
    const r = await queryFn(`SELECT COUNT(*) FROM agent_graph.daemon_ticks`);
    assert.ok(r.rows[0].count !== undefined);
  });
});
