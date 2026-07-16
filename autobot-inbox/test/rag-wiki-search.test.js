import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

/**
 * STAQPRO-311 Phase 1: wikiPageSearch FTS over content.wiki_pages
 * with classification-tier enforcement.
 *
 * Verifies:
 *   - Migration 109 (content_tsv generated column + retrieval_events
 *     audit table) is in place after initializeDatabase()
 *   - wikiPageSearch returns structured citations (slug, title,
 *     excerpt, score, sourceType: 'wiki_pages')
 *   - Classification ordinal filter (from STAQPRO-310) gates results
 *     correctly across all four tiers
 *   - Audit row written to content.retrieval_events when agentId set
 *
 * Mirrors test/rag-retriever-classification.test.js shape.
 */

describe('RAG wiki search — FTS + classification gating (STAQPRO-311 Phase 1)', () => {
  let queryFn;
  let wikiPageSearch;

  const MAGIC_TOKEN = 'metric-photosynthesis-quasar';

  // STAQPRO-570: validateScope no longer soft-degrades a scope-less / legacy
  // call — it hard-throws. wikiPageSearch has no owner/org SQL column yet
  // (FOLLOWUP-WIKI-OWNER), so these classification tests only need a valid
  // scope arg to satisfy the gate. `architect` is an org-scope-allowed tier;
  // the classification filter under test is orthogonal to the scope shape.
  const STAQS_ORG = '7c164445-43f2-4802-a7d3-5cab06611e99';
  const WIKI_SCOPE = { org: true, agentId: 'architect', readOrgIds: [STAQS_ORG] };

  before(async () => {
    delete process.env.DATABASE_URL;
    process.env.NODE_ENV = 'test';
    process.env.SQL_DIR = new URL('../sql', import.meta.url).pathname;
    process.env.PGLITE_DATA_DIR = new URL('../data/pglite-wiki-search-test', import.meta.url).pathname;

    const db = await import('../src/db.js');
    queryFn = db.query;
    await db.initializeDatabase();

    const retriever = await import('../../lib/rag/retriever.js');
    wikiPageSearch = retriever.wikiPageSearch;

    // Seed one wiki page per classification tier. Each contains the
    // MAGIC_TOKEN so FTS matches all four before the classification
    // filter narrows the set. Content padding ensures the tsvector
    // has enough terms for ts_rank_cd to behave normally.
    for (const tier of ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED']) {
      await queryFn(
        `INSERT INTO content.wiki_pages
           (slug, title, content, classification, created_by, compiled_at)
         VALUES ($1, $2, $3, $4, 'test', now())
         ON CONFLICT (project_id, slug) DO NOTHING`,
        [
          `staqpro-311-${tier.toLowerCase()}`,
          `Test page ${tier}`,
          `This is filler text. The ${MAGIC_TOKEN} appears in this page covering tier ${tier}. ` +
            'Additional padding text for the tsvector index so the rank function has enough material to compute over. ' +
            'More words follow to keep the page above the minimum length threshold for headline excerpting and ranking purposes.',
          tier,
        ]
      );
    }
  });

  after(async () => {
    const db = await import('../src/db.js');
    await db.close();
  });

  it('migration 109: content_tsv is populated and retrieval_events table exists', async () => {
    const indexed = await queryFn(
      `SELECT count(*) AS cnt FROM content.wiki_pages WHERE content_tsv IS NOT NULL AND slug LIKE 'staqpro-311-%'`
    );
    assert.equal(parseInt(indexed.rows[0].cnt, 10), 4, 'all 4 seeded pages must have content_tsv populated');

    const tableExists = await queryFn(
      `SELECT 1 FROM information_schema.tables WHERE table_schema='content' AND table_name='retrieval_events'`
    );
    assert.equal(tableExists.rows.length, 1, 'content.retrieval_events table must exist');
  });

  it('wikiPageSearch returns structured citations with required fields', async () => {
    const result = await wikiPageSearch(MAGIC_TOKEN, { maxClassification: 'CONFIDENTIAL', matchCount: 10 }, WIKI_SCOPE);

    assert.ok(Array.isArray(result.pages), 'returns { pages: [...] }');
    assert.ok(result.pages.length >= 1, 'at least one match');

    const page = result.pages[0];
    assert.ok(typeof page.id === 'string', 'id present');
    assert.ok(typeof page.slug === 'string', 'slug present');
    assert.ok(typeof page.title === 'string', 'title present');
    assert.ok(typeof page.excerpt === 'string', 'excerpt present');
    assert.ok(typeof page.score === 'number', 'numeric score');
    assert.equal(typeof page.classificationLevel, 'number', 'classificationLevel is numeric ordinal');
    assert.equal(page.sourceType, 'wiki_pages', 'source-typed for downstream citation rendering');
  });

  it('maxClassification=INTERNAL excludes CONFIDENTIAL and RESTRICTED, includes PUBLIC and INTERNAL', async () => {
    const result = await wikiPageSearch(MAGIC_TOKEN, { maxClassification: 'INTERNAL', matchCount: 10 }, WIKI_SCOPE);
    const slugs = new Set(result.pages.map(p => p.slug));

    assert.equal(slugs.has('staqpro-311-public'),       true);
    assert.equal(slugs.has('staqpro-311-internal'),     true);
    assert.equal(slugs.has('staqpro-311-confidential'), false, 'CONFIDENTIAL must not leak to INTERNAL caller');
    assert.equal(slugs.has('staqpro-311-restricted'),   false, 'RESTRICTED must not leak to INTERNAL caller');
  });

  it('maxClassification=PUBLIC excludes everything above PUBLIC', async () => {
    const result = await wikiPageSearch(MAGIC_TOKEN, { maxClassification: 'PUBLIC', matchCount: 10 }, WIKI_SCOPE);
    const slugs = new Set(result.pages.map(p => p.slug));

    assert.equal(slugs.has('staqpro-311-public'),       true);
    assert.equal(slugs.has('staqpro-311-internal'),     false);
    assert.equal(slugs.has('staqpro-311-confidential'), false);
    assert.equal(slugs.has('staqpro-311-restricted'),   false);
  });

  it('maxClassification=CONFIDENTIAL includes CONFIDENTIAL but excludes RESTRICTED', async () => {
    const result = await wikiPageSearch(MAGIC_TOKEN, { maxClassification: 'CONFIDENTIAL', matchCount: 10 }, WIKI_SCOPE);
    const slugs = new Set(result.pages.map(p => p.slug));

    assert.equal(slugs.has('staqpro-311-confidential'), true, 'CONFIDENTIAL allowed at this tier');
    assert.equal(slugs.has('staqpro-311-restricted'),   false, 'RESTRICTED still excluded — RESTRICTED is human-only');
  });

  it('numeric maxClassification works too (back-compat with classification policy)', async () => {
    const result = await wikiPageSearch(MAGIC_TOKEN, { maxClassification: 1, matchCount: 10 }, WIKI_SCOPE);
    const slugs = new Set(result.pages.map(p => p.slug));

    assert.equal(slugs.has('staqpro-311-public'),       true);
    assert.equal(slugs.has('staqpro-311-internal'),     true);
    assert.equal(slugs.has('staqpro-311-confidential'), false);
  });

  it('empty query returns empty pages without throwing', async () => {
    const result = await wikiPageSearch('', { maxClassification: 'CONFIDENTIAL' }, WIKI_SCOPE);
    assert.deepEqual(result, { pages: [] });
  });

  it('writes a retrieval_events audit row when agentId is provided', async () => {
    const TEST_AGENT_ID = 'test-agent-staqpro-311';

    await wikiPageSearch(MAGIC_TOKEN, {
      maxClassification: 'CONFIDENTIAL',
      agentId: TEST_AGENT_ID,
      workItemId: '00000000-0000-0000-0000-000000000311',
      matchCount: 5,
    }, WIKI_SCOPE);

    // Audit insert is fire-and-forget; give it a beat to commit.
    await new Promise(r => setTimeout(r, 50));

    const audit = await queryFn(
      `SELECT corpus, query, result_count, agent_id
         FROM content.retrieval_events
        WHERE agent_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [TEST_AGENT_ID]
    );

    assert.equal(audit.rows.length, 1, 'one audit row recorded');
    assert.equal(audit.rows[0].corpus, 'wiki_pages');
    assert.equal(audit.rows[0].query, MAGIC_TOKEN);
    assert.ok(audit.rows[0].result_count >= 1, 'result_count tracks returned pages');
  });

  it('does NOT write an audit row when agentId is omitted (system call)', async () => {
    const before = await queryFn(`SELECT count(*) AS cnt FROM content.retrieval_events`);
    await wikiPageSearch(MAGIC_TOKEN, { maxClassification: 'INTERNAL' }, WIKI_SCOPE);
    await new Promise(r => setTimeout(r, 50));
    const after = await queryFn(`SELECT count(*) AS cnt FROM content.retrieval_events`);
    assert.equal(after.rows[0].cnt, before.rows[0].cnt, 'no audit row for non-agent caller');
  });
});
