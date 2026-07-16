import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

/**
 * STAQPRO-311 Phase 4: agent_graph.v_wiki_metrics view tests.
 *
 * Verifies the view returns correct metric values for a seeded set of
 * email_draft action_proposals across the four key shapes:
 *   - Empty corpus → both percent metrics NULL (not 0)
 *   - No citations → citation_rate = 0%, kept_rate NULL (no cited drafts)
 *   - Citations present, all approved → kept_rate = 100%
 *   - Mixed: some approved, some edited, some pending — denominator
 *     excludes pending (only acted-on cited drafts count for kept_rate)
 *
 * Regex matched in the view: `\[(wiki|doc):` — case-insensitive.
 */

describe('v_wiki_metrics (STAQPRO-311 Phase 4)', () => {
  let queryFn;

  // Use a distinct work_item to scope the test's seeded drafts
  const WORK_ITEM = '00000000-0000-0000-0000-000000041100';

  before(async () => {
    delete process.env.DATABASE_URL;
    process.env.NODE_ENV = 'test';
    process.env.SQL_DIR = new URL('../sql', import.meta.url).pathname;
    process.env.PGLITE_DATA_DIR = new URL('../data/pglite-wiki-metrics-test', import.meta.url).pathname;

    const db = await import('../src/db.js');
    queryFn = db.query;
    await db.initializeDatabase();

    // Seed the parent work_item once
    await queryFn(`
      INSERT INTO agent_graph.work_items (id, title, type, status, assigned_to, created_by)
      VALUES ($1, 'staqpro-311 phase4 fixture', 'task', 'in_progress', 'executor-responder', 'board')
      ON CONFLICT (id) DO NOTHING
    `, [WORK_ITEM]);
  });

  after(async () => {
    const db = await import('../src/db.js');
    await db.close();
  });

  async function readMetrics() {
    const r = await queryFn('SELECT * FROM agent_graph.v_wiki_metrics');
    return r.rows[0];
  }

  async function clearDrafts() {
    await queryFn(
      `DELETE FROM agent_graph.action_proposals WHERE work_item_id = $1`,
      [WORK_ITEM]
    );
  }

  async function seedDraft({ body, boardAction = null, ageDays = 1 }) {
    // CHECK action_proposals_email_requires_fields: for email_draft,
    // need to_addresses + channel + (source='flow' OR message_id).
    // Easiest: source='flow' (avoids needing a real inbox.messages row).
    await queryFn(
      `INSERT INTO agent_graph.action_proposals
         (work_item_id, action_type, body, board_action, created_at, acted_at, version,
          to_addresses, channel, source)
       VALUES ($1, 'email_draft', $2, $3::text, now() - ($4 || ' days')::interval,
               CASE WHEN $3::text IS NULL THEN NULL ELSE now() END,
               1, ARRAY['test@example.com']::text[], 'email', 'flow')`,
      [WORK_ITEM, body, boardAction, ageDays]
    );
  }

  // Postgres count() returns BIGINT which pg-protocol surfaces as string;
  // PGlite may surface as number. Coerce defensively in assertions.
  const n = v => parseInt(v ?? '0', 10);

  it('empty corpus → both percent metrics NULL', async () => {
    await clearDrafts();
    const m = await readMetrics();
    assert.equal(n(m.total_drafts_14d), 0);
    assert.equal(m.knowledge_citation_rate_pct, null);
    assert.equal(m.kept_citation_rate_pct, null);
  });

  it('drafts with no citations → citation_rate 0, kept_rate NULL', async () => {
    await clearDrafts();
    await seedDraft({ body: 'Hi Nicole, sounds good!', boardAction: 'approved' });
    await seedDraft({ body: 'No citations here.', boardAction: 'edited' });

    const m = await readMetrics();
    assert.equal(n(m.total_drafts_14d), 2);
    assert.equal(n(m.cited_drafts_14d), 0);
    assert.equal(parseFloat(m.knowledge_citation_rate_pct), 0);
    assert.equal(m.kept_citation_rate_pct, null,
      'no cited drafts → kept_rate denominator is zero → NULL, not 0%');
  });

  it('cited drafts all approved → citation_rate >0, kept_rate = 100', async () => {
    await clearDrafts();
    await seedDraft({ body: 'Per [wiki:voice/profiles] this should be casual.', boardAction: 'approved' });
    await seedDraft({ body: 'See [doc:abc-123] for context.', boardAction: 'approved' });

    const m = await readMetrics();
    assert.equal(n(m.total_drafts_14d), 2);
    assert.equal(n(m.cited_drafts_14d), 2);
    assert.equal(parseFloat(m.knowledge_citation_rate_pct), 100);
    assert.equal(parseFloat(m.kept_citation_rate_pct), 100);
  });

  it('mixed board_actions on cited drafts: pending excluded from kept denominator', async () => {
    await clearDrafts();
    // 4 cited drafts: 2 approved, 1 edited, 1 pending (NULL board_action)
    await seedDraft({ body: 'See [wiki:foo] and proceed.',  boardAction: 'approved' });
    await seedDraft({ body: 'Per [wiki:bar] reasoning...',  boardAction: 'approved' });
    await seedDraft({ body: 'From [doc:baz] this implies', boardAction: 'edited'   });
    await seedDraft({ body: '[wiki:still-deciding]',        boardAction: null      });
    // 1 uncited approved (background context)
    await seedDraft({ body: 'No citation here at all.', boardAction: 'approved' });

    const m = await readMetrics();
    assert.equal(n(m.total_drafts_14d), 5);
    assert.equal(n(m.cited_drafts_14d), 4);
    assert.equal(n(m.cited_approved_14d), 2);
    assert.equal(n(m.cited_edited_14d), 1);
    assert.equal(n(m.cited_pending_14d), 1);

    // citation_rate = 4 cited / 5 total = 80%
    assert.equal(parseFloat(m.knowledge_citation_rate_pct), 80.00);
    // kept_rate = 2 approved / 3 acted-on (2 approved + 1 edited; pending excluded) = 66.67%
    assert.equal(parseFloat(m.kept_citation_rate_pct), 66.67);
  });

  it('14-day window excludes older drafts', async () => {
    await clearDrafts();
    await seedDraft({ body: 'Recent [wiki:x] draft.', boardAction: 'approved', ageDays: 1 });
    await seedDraft({ body: 'Old [wiki:y] draft.',    boardAction: 'approved', ageDays: 30 });

    const m = await readMetrics();
    assert.equal(n(m.total_drafts_14d), 1, 'old draft excluded by 14d window');
    assert.equal(n(m.cited_drafts_14d), 1);
    assert.equal(parseFloat(m.knowledge_citation_rate_pct), 100);
  });

  it('regex matches both [wiki: and [doc: case-insensitively', async () => {
    await clearDrafts();
    await seedDraft({ body: 'lower [wiki:slug]', boardAction: 'approved' });
    await seedDraft({ body: 'Upper [DOC:ID-1]',  boardAction: 'approved' });
    await seedDraft({ body: 'Mixed [Wiki:foo]',  boardAction: 'approved' });

    const m = await readMetrics();
    assert.equal(n(m.cited_drafts_14d), 3, 'regex case-insensitive matched all three');
  });
});
