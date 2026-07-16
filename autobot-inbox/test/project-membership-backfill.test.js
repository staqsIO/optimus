import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

/**
 * STAQPRO-551: project entity counters (campaigns / chat sessions) read solely
 * from agent_graph.project_memberships. Two bugs:
 *   1. Write path never inserted 'campaign' / 'chat_session' membership rows.
 *   2. No backfill for rows that pre-dated the (now-wired) write-path inserts.
 *
 * These tests pin the SQL invariants behind the fix:
 *   - The membership insert used by the write path is idempotent on its PK
 *     (project_id, entity_type, entity_id) — a retried create never double-counts.
 *   - Migration 140's chat_session backfill links project-scoped sessions, skips
 *     global (project_id IS NULL) sessions, and is safe to run twice.
 */
describe('STAQPRO-551 project membership write-path + backfill', () => {
  let queryFn;

  const PROJECT_ID = '00000000-0000-0000-0000-0000000p0551';
  const PROJECT_SLUG = 'staqpro-551-test';
  const CAMPAIGN_ID = '00000000-0000-0000-0000-0000000c0551';
  const SCOPED_SESSION_ID = '00000000-0000-0000-0000-0000000551a1';
  const GLOBAL_SESSION_ID = '00000000-0000-0000-0000-0000000551b2';

  before(async () => {
    delete process.env.DATABASE_URL;
    process.env.NODE_ENV = 'test';
    process.env.SQL_DIR = new URL('../sql', import.meta.url).pathname;
    process.env.PGLITE_DATA_DIR = new URL('../data/pglite-staqpro-551-test', import.meta.url).pathname;

    const db = await import('../src/db.js');
    queryFn = db.query;
    await db.initializeDatabase();

    await queryFn(
      `INSERT INTO agent_graph.projects (id, slug, name)
       VALUES ($1, $2, 'STAQPRO-551 Test Project')
       ON CONFLICT (id) DO NOTHING`,
      [PROJECT_ID, PROJECT_SLUG]
    );

    // One project-scoped chat session (should backfill) and one global
    // session (must NOT backfill — project_id IS NULL).
    await queryFn(
      `INSERT INTO agent_graph.board_chat_sessions (id, board_user, agent_id, project_id)
       VALUES ($1, 'eric', 'orchestrator', $2)
       ON CONFLICT (id) DO NOTHING`,
      [SCOPED_SESSION_ID, PROJECT_ID]
    );
    await queryFn(
      `INSERT INTO agent_graph.board_chat_sessions (id, board_user, agent_id, project_id)
       VALUES ($1, 'eric', 'orchestrator', NULL)
       ON CONFLICT (id) DO NOTHING`,
      [GLOBAL_SESSION_ID]
    );
  });

  // Mirrors the write-path INSERT in campaigns.js — the membership row IS the
  // campaign<->project association the counter reads.
  async function linkCampaign() {
    await queryFn(
      `INSERT INTO agent_graph.project_memberships (project_id, entity_type, entity_id, added_by)
       VALUES ($1, 'campaign', $2, 'board')
       ON CONFLICT (project_id, entity_type, entity_id) DO NOTHING`,
      [PROJECT_ID, CAMPAIGN_ID]
    );
  }

  // Mirrors the chat_session backfill block of migration 140.
  async function backfillSessions() {
    await queryFn(
      `INSERT INTO agent_graph.project_memberships (project_id, entity_type, entity_id, added_by)
       SELECT s.project_id, 'chat_session', s.id::text, 'backfill-140'
       FROM agent_graph.board_chat_sessions s
       JOIN agent_graph.projects p ON p.id = s.project_id
       WHERE s.project_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM agent_graph.project_memberships pm
           WHERE pm.project_id = s.project_id
             AND pm.entity_type = 'chat_session'
             AND pm.entity_id = s.id::text
         )
       ON CONFLICT (project_id, entity_type, entity_id) DO NOTHING`
    );
  }

  async function countMemberships(entityType) {
    const r = await queryFn(
      `SELECT count(*)::int AS n FROM agent_graph.project_memberships
       WHERE project_id = $1 AND entity_type = $2`,
      [PROJECT_ID, entityType]
    );
    return r.rows[0].n;
  }

  it('campaign write-path link is idempotent (retried create never double-counts)', async () => {
    await linkCampaign();
    assert.equal(await countMemberships('campaign'), 1, 'one campaign membership after first link');

    await linkCampaign(); // simulate retry / re-submit
    assert.equal(await countMemberships('campaign'), 1, 'still one after retry — ON CONFLICT held');
  });

  it('migration 140 backfills project-scoped sessions, skips global ones, runs twice safely', async () => {
    await backfillSessions();
    assert.equal(await countMemberships('chat_session'), 1, 'only the project-scoped session linked');

    // The global (project_id IS NULL) session must never produce a membership.
    const globalLinked = await queryFn(
      `SELECT count(*)::int AS n FROM agent_graph.project_memberships
       WHERE entity_type = 'chat_session' AND entity_id = $1`,
      [GLOBAL_SESSION_ID]
    );
    assert.equal(globalLinked.rows[0].n, 0, 'global session not linked to any project');

    await backfillSessions(); // re-run deploy
    assert.equal(await countMemberships('chat_session'), 1, 'idempotent — no duplicate on second run');
  });
});
