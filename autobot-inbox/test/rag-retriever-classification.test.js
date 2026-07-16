import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

/**
 * STAQPRO-310 regression: lib/rag/retriever.js classification filter
 * must reject documents above the caller's max tier.
 *
 * Pre-fix bug: `lib/rag/retriever.js:121` used `d.classification <= $3`
 * with the text column. Postgres compares text lexicographically;
 * CONFIDENTIAL (C=67) sorts before INTERNAL (I=73), so the filter
 * `<= 'INTERNAL'` already included CONFIDENTIAL — a P1/P2 data
 * leakage bug live in production since migration 017.
 *
 * Post-fix: filter is `d.classification_level <= $3` on the numeric
 * ordinal column added by migration 108. This test asserts both
 * directions:
 *   - CONFIDENTIAL / RESTRICTED documents are NOT returned to an
 *     INTERNAL-tier caller (no leak above tier)
 *   - PUBLIC documents ARE returned (the lexicographic bug also
 *     hid PUBLIC from INTERNAL callers because P > I alphabetically)
 *
 * Runs against ephemeral PGlite, mirrors api-queries.test.js shape.
 */

describe('RAG retriever — classification tier enforcement (STAQPRO-310)', () => {
  let queryFn;
  let lexicalChunkSearch;
  let toClassificationLevel;

  const MAGIC_TOKEN = 'classification-test-token-xyz';

  const DOC_PUBLIC       = '00000000-0000-0000-0000-000000000310';
  const DOC_INTERNAL     = '00000000-0000-0000-0000-000000000311';
  const DOC_CONFIDENTIAL = '00000000-0000-0000-0000-000000000312';
  const DOC_RESTRICTED   = '00000000-0000-0000-0000-000000000313';

  // Phase-2 tenancy (live read-leak): lexicalChunkSearch now fails closed
  // without a readable org set, mirroring the vector path. The seeded docs have
  // owner_org_id NULL → the org gate COALESCEs them to the canonical Staqs UUID,
  // so a Staqs-scoped reader sees them; readOrgIds is threaded into every call.
  const STAQS_ORG = '7c164445-43f2-4802-a7d3-5cab06611e99';

  // STAQPRO-570: the legacy {ownerId, includeOrgWide, sharedDocumentsOnly} opts
  // triple is no longer accepted (hard-throw). These classification tests need
  // org-wide visibility, so they pass a modern validated scope arg instead —
  // `architect` is an org-scope-allowed tier. The classification filter under
  // test is orthogonal to the scope shape.
  const ORG_SCOPE = { org: true, agentId: 'architect', readOrgIds: [STAQS_ORG] };

  before(async () => {
    delete process.env.DATABASE_URL;
    process.env.NODE_ENV = 'test';
    process.env.SQL_DIR = new URL('../sql', import.meta.url).pathname;
    process.env.PGLITE_DATA_DIR = new URL('../data/pglite-rag-classification-test', import.meta.url).pathname;

    const db = await import('../src/db.js');
    queryFn = db.query;
    await db.initializeDatabase();

    const retriever = await import('../../lib/rag/retriever.js');
    lexicalChunkSearch = retriever.lexicalChunkSearch;
    toClassificationLevel = retriever.toClassificationLevel;

    // Seed four documents, one per classification tier. Same magic
    // token in every chunk so the lexical LIKE matches all four
    // before the classification filter narrows the set.
    for (const [id, tier] of [
      [DOC_PUBLIC,       'PUBLIC'],
      [DOC_INTERNAL,     'INTERNAL'],
      [DOC_CONFIDENTIAL, 'CONFIDENTIAL'],
      [DOC_RESTRICTED,   'RESTRICTED'],
    ]) {
      await queryFn(
        `INSERT INTO content.documents
           (id, source, source_id, title, raw_text, classification, owner_id, owner_org_id)
         VALUES ($1, 'upload', $2, $3, $4, $5, NULL, NULL)
         ON CONFLICT (source, source_id) DO NOTHING`,
        [id, `staqpro-310-${tier}`, `Test doc ${tier}`, `${MAGIC_TOKEN} body for ${tier}`, tier]
      );

      await queryFn(
        `INSERT INTO content.chunks
           (document_id, chunk_index, text, classification)
         VALUES ($1, 0, $2, $3)`,
        [id, `${MAGIC_TOKEN} chunk text for tier ${tier}`, tier]
      );
    }
  });

  after(async () => {
    const db = await import('../src/db.js');
    await db.close();
  });

  it('toClassificationLevel maps text → numeric ordinals correctly', () => {
    assert.equal(toClassificationLevel('PUBLIC'),       0);
    assert.equal(toClassificationLevel('INTERNAL'),     1);
    assert.equal(toClassificationLevel('CONFIDENTIAL'), 2);
    assert.equal(toClassificationLevel('RESTRICTED'),   3);
    assert.equal(toClassificationLevel(undefined),      1, 'undefined → default INTERNAL');
    assert.equal(toClassificationLevel('GARBAGE'),      1, 'unknown text → default INTERNAL');
    assert.equal(toClassificationLevel(2),              2, 'numeric passthrough');
  });

  it('migration 108: classification_level is auto-populated for every seeded row', async () => {
    const result = await queryFn(
      `SELECT classification, classification_level
         FROM content.documents
        WHERE id = ANY($1::uuid[])
        ORDER BY classification_level`,
      [[DOC_PUBLIC, DOC_INTERNAL, DOC_CONFIDENTIAL, DOC_RESTRICTED]]
    );

    assert.deepEqual(
      result.rows.map(r => [r.classification, r.classification_level]),
      [
        ['PUBLIC', 0],
        ['INTERNAL', 1],
        ['CONFIDENTIAL', 2],
        ['RESTRICTED', 3],
      ],
      'generated column must mirror the text classification'
    );
  });

  it('lexicalChunkSearch with maxClassification=INTERNAL excludes CONFIDENTIAL and RESTRICTED', async () => {
    const result = await lexicalChunkSearch(MAGIC_TOKEN, {
      maxClassification: 'INTERNAL',
      matchCount: 30,
    }, ORG_SCOPE);

    const returnedDocIds = new Set(result.chunks.map(c => c.documentId));

    assert.equal(returnedDocIds.has(DOC_CONFIDENTIAL), false,
      'CONFIDENTIAL document must NOT leak to INTERNAL-tier caller (the original lexicographic-compare bug)');
    assert.equal(returnedDocIds.has(DOC_RESTRICTED), false,
      'RESTRICTED document must NOT leak to INTERNAL-tier caller');
  });

  it('lexicalChunkSearch with maxClassification=INTERNAL includes PUBLIC and INTERNAL', async () => {
    const result = await lexicalChunkSearch(MAGIC_TOKEN, {
      maxClassification: 'INTERNAL',
      matchCount: 30,
    }, ORG_SCOPE);

    const returnedDocIds = new Set(result.chunks.map(c => c.documentId));

    assert.equal(returnedDocIds.has(DOC_PUBLIC), true,
      'PUBLIC document must be returned (the original bug also hid PUBLIC because P > I alphabetically)');
    assert.equal(returnedDocIds.has(DOC_INTERNAL), true,
      'INTERNAL document must be returned (matches caller tier)');
  });

  it('lexicalChunkSearch with maxClassification=CONFIDENTIAL includes CONFIDENTIAL but excludes RESTRICTED', async () => {
    const result = await lexicalChunkSearch(MAGIC_TOKEN, {
      maxClassification: 'CONFIDENTIAL',
      matchCount: 30,
    }, ORG_SCOPE);

    const returnedDocIds = new Set(result.chunks.map(c => c.documentId));

    assert.equal(returnedDocIds.has(DOC_PUBLIC),       true);
    assert.equal(returnedDocIds.has(DOC_INTERNAL),     true);
    assert.equal(returnedDocIds.has(DOC_CONFIDENTIAL), true,  'CONFIDENTIAL allowed at this tier');
    assert.equal(returnedDocIds.has(DOC_RESTRICTED),   false, 'RESTRICTED still excluded');
  });

  it('lexicalChunkSearch with maxClassification=PUBLIC excludes everything above PUBLIC', async () => {
    const result = await lexicalChunkSearch(MAGIC_TOKEN, {
      maxClassification: 'PUBLIC',
      matchCount: 30,
    }, ORG_SCOPE);

    const returnedDocIds = new Set(result.chunks.map(c => c.documentId));

    assert.equal(returnedDocIds.has(DOC_PUBLIC),       true,  'PUBLIC matches');
    assert.equal(returnedDocIds.has(DOC_INTERNAL),     false);
    assert.equal(returnedDocIds.has(DOC_CONFIDENTIAL), false);
    assert.equal(returnedDocIds.has(DOC_RESTRICTED),   false);
  });

  it('lexicalChunkSearch accepts numeric maxClassification too', async () => {
    const result = await lexicalChunkSearch(MAGIC_TOKEN, {
      maxClassification: 1, // INTERNAL as ordinal
      matchCount: 30,
    }, ORG_SCOPE);

    const returnedDocIds = new Set(result.chunks.map(c => c.documentId));
    assert.equal(returnedDocIds.has(DOC_CONFIDENTIAL), false);
    assert.equal(returnedDocIds.has(DOC_PUBLIC),       true);
  });
});
