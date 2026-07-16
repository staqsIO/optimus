import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

/**
 * STAQPRO-354: when the orchestrator's handleStateChanged exits without
 * spawning a downstream draft for an action_required / needs_response upstream,
 * flagUnroutedActionRequired must make the skip loud:
 *   1. console.warn (not unit-testable from here)
 *   2. work_items.metadata.routing_skipped (DB side-effect)
 *   3. publishEvent('routing_skipped') (event log side-effect)
 *
 * We exercise (2) directly. We also pin extractUpstreamTriage's pure mapping
 * so a refactor of the metadata shape can't silently break the gate that
 * decides whether to flag.
 */
describe('STAQPRO-354 routing-skip observability', () => {
  let queryFn;
  let extractUpstreamTriage;
  let flagUnroutedActionRequired;
  const RUN = `354-${Date.now()}`;
  const idFor = (k) => `wi-rskip-${RUN}-${k}`;

  before(async () => {
    delete process.env.DATABASE_URL;
    process.env.NODE_ENV = 'test';
    process.env.SQL_DIR = new URL('../sql', import.meta.url).pathname;
    process.env.PGLITE_DATA_DIR = new URL('../data/pglite-routing-skip', import.meta.url).pathname;
    const db = await import('../src/db.js');
    queryFn = db.query;
    await db.initializeDatabase();
    ({ extractUpstreamTriage, flagUnroutedActionRequired } =
      await import('../../agents/orchestrator/index.js'));
  });

  describe('extractUpstreamTriage (pure)', () => {
    it('returns nulls when metadata has neither triage nor intake', () => {
      assert.deepEqual(extractUpstreamTriage({}), {
        category: null, confidence: null, source: null,
      });
      assert.deepEqual(extractUpstreamTriage(null), {
        category: null, confidence: null, source: null,
      });
    });

    it('reads triage_result with quick_score as confidence', () => {
      const got = extractUpstreamTriage({
        triage_result: { category: 'action_required', quick_score: 0.5 },
      });
      assert.equal(got.category, 'action_required');
      assert.equal(got.confidence, 0.5);
      assert.equal(got.source, 'triage_result');
    });

    it('reads intake_classification confidence even without a category', () => {
      const got = extractUpstreamTriage({
        intake_classification: { confidence: 0.75, complexity: 'MODERATE' },
      });
      assert.equal(got.category, null);
      assert.equal(got.confidence, 0.75);
      assert.equal(got.source, 'intake_classification');
    });

    it('treats non-numeric quick_score as null confidence', () => {
      const got = extractUpstreamTriage({
        triage_result: { category: 'action_required', quick_score: 'low' },
      });
      assert.equal(got.confidence, null);
    });
  });

  describe('flagUnroutedActionRequired side-effects', () => {
    async function insertWorkItem(id) {
      await queryFn(
        `INSERT INTO agent_graph.work_items
           (id, type, title, created_by, assigned_to, status, priority, metadata)
         VALUES ($1, 'task', 'flag test', 'board', 'orchestrator', 'completed', 0, '{}'::jsonb)
         ON CONFLICT (id) DO UPDATE SET status = 'completed', metadata = '{}'::jsonb`,
        [id],
      );
    }

    it('writes routing_skipped into work_item metadata', async () => {
      const wiId = idFor('meta');
      await insertWorkItem(wiId);

      await flagUnroutedActionRequired({
        workItemId: wiId,
        completingAgent: 'executor-triage',
        category: 'action_required',
        confidence: 0.5,
        reason: 'test: deduped',
        agentId: 'orchestrator',
      });

      const r = await queryFn(
        `SELECT metadata->'routing_skipped' AS skip FROM agent_graph.work_items WHERE id = $1`,
        [wiId],
      );
      const skip = r.rows[0].skip;
      assert.ok(skip, 'metadata.routing_skipped must be present');
      assert.equal(skip.category, 'action_required');
      assert.equal(Number(skip.confidence), 0.5);
      assert.equal(skip.completing_agent, 'executor-triage');
      assert.equal(skip.reason, 'test: deduped');
      assert.ok(skip.flagged_at, 'flagged_at timestamp must be set');
    });

    it('preserves existing metadata keys when flagging', async () => {
      const wiId = idFor('preserve');
      await queryFn(
        `INSERT INTO agent_graph.work_items
           (id, type, title, created_by, assigned_to, status, priority, metadata)
         VALUES ($1, 'task', 'preserve', 'board', 'orchestrator', 'completed', 0,
                 jsonb_build_object('existing_key', 'keep me', 'email_id', 'em-1'))
         ON CONFLICT (id) DO UPDATE SET
           metadata = jsonb_build_object('existing_key', 'keep me', 'email_id', 'em-1')`,
        [wiId],
      );

      await flagUnroutedActionRequired({
        workItemId: wiId,
        completingAgent: 'executor-triage',
        category: 'needs_response',
        confidence: null,
        reason: 'test: parse fail',
        agentId: 'orchestrator',
      });

      const r = await queryFn(
        `SELECT metadata FROM agent_graph.work_items WHERE id = $1`,
        [wiId],
      );
      const meta = r.rows[0].metadata;
      assert.equal(meta.existing_key, 'keep me', 'pre-existing keys must survive');
      assert.equal(meta.email_id, 'em-1');
      assert.ok(meta.routing_skipped, 'routing_skipped must be added');
      assert.equal(meta.routing_skipped.reason, 'test: parse fail');
    });

    it('handles null confidence gracefully (no NaN, no throw)', async () => {
      const wiId = idFor('nullconf');
      await insertWorkItem(wiId);

      await flagUnroutedActionRequired({
        workItemId: wiId,
        completingAgent: 'executor-intake',
        category: 'action_required',
        confidence: null,
        reason: 'test: llm threw',
        agentId: 'orchestrator',
      });

      const r = await queryFn(
        `SELECT metadata->'routing_skipped' AS skip FROM agent_graph.work_items WHERE id = $1`,
        [wiId],
      );
      const skip = r.rows[0].skip;
      assert.ok(skip);
      assert.equal(skip.confidence, null);
    });
  });
});
