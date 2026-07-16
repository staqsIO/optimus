import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

/**
 * STAQPRO-313 regression: content.match_chunks() (the vector path) must
 * reject chunks above the caller's classification ceiling.
 *
 * Pre-313: migration 058's match_chunks carried a verbose CASE-IN block
 * mapping the TEXT max_classification to the allowed subset. Functionally
 * correct but fragile (a 5th tier would be silently missed) and a different
 * filter shape than lexicalChunkSearch.
 *
 * Post-313 (migration 118): signature takes max_classification_level SMALLINT
 * and filters `c.classification_level <= max_classification_level` — the same
 * ordinal filter lexicalChunkSearch uses. This test asserts the security
 * invariant directly against the SQL function:
 *   - level=1 (INTERNAL) caller does NOT see CONFIDENTIAL(2) / RESTRICTED(3)
 *   - level=1 caller DOES see PUBLIC(0) / INTERNAL(1)
 *   - level=3 (RESTRICTED) caller sees all four
 *
 * Mirrors test/rag-retriever-classification.test.js fixture shape but seeds
 * embeddings so the vector path is exercised.
 */
describe('content.match_chunks — ordinal classification ceiling (STAQPRO-313)', () => {
  let queryFn;

  const MAGIC = 'staqpro-313';
  const DOC_PUBLIC       = '00000000-0000-0000-0000-000000000130';
  const DOC_INTERNAL     = '00000000-0000-0000-0000-000000000131';
  const DOC_CONFIDENTIAL = '00000000-0000-0000-0000-000000000132';
  const DOC_RESTRICTED   = '00000000-0000-0000-0000-000000000133';

  // Identical 1536-d vector for query and every chunk → cosine similarity 1,
  // so similarity never filters anything out and the classification ceiling
  // is the only thing under test.
  const VEC = `[${Array(1536).fill(0.1).join(',')}]`;

  before(async () => {
    delete process.env.DATABASE_URL;
    process.env.NODE_ENV = 'test';
    process.env.SQL_DIR = new URL('../sql', import.meta.url).pathname;
    process.env.PGLITE_DATA_DIR = new URL('../data/pglite-match-chunks-ordinal', import.meta.url).pathname;

    const db = await import('../src/db.js');
    queryFn = db.query;
    await db.initializeDatabase();

    for (const [id, tier] of [
      [DOC_PUBLIC,       'PUBLIC'],
      [DOC_INTERNAL,     'INTERNAL'],
      [DOC_CONFIDENTIAL, 'CONFIDENTIAL'],
      [DOC_RESTRICTED,   'RESTRICTED'],
    ]) {
      await queryFn(
        `INSERT INTO content.documents
           (id, source, source_id, title, raw_text, classification, owner_id, sanitized)
         VALUES ($1, 'upload', $2, $3, $4, $5, NULL, true)
         ON CONFLICT (source, source_id) DO NOTHING`,
        [id, `${MAGIC}-${tier}`, `Doc ${tier}`, `${MAGIC} body ${tier}`, tier]
      );
      await queryFn(
        `INSERT INTO content.chunks
           (document_id, chunk_index, text, classification, embedding)
         VALUES ($1, 0, $2, $3, $4::vector)`,
        [id, `${MAGIC} chunk ${tier}`, tier, VEC]
      );
    }
  });

  after(async () => {
    const db = await import('../src/db.js');
    await db.close();
  });

  // Migration 135 added filter_org_ids (10th positional arg) and made it
  // fail-closed: NULL/empty → 0 rows. These fixtures seed owner_id NULL docs;
  // migration 134 sets owner_org_id DEFAULT = the real Staqs org UUID (resolved
  // at migration time from tenancy.orgs WHERE slug='staqs'). Migration 133 seeds
  // that org with gen_random_uuid(), so it differs each PGlite run. We must
  // query the live UUID rather than hardcode it.
  let staqsOrgId;

  async function matchAt(level) {
    if (!staqsOrgId) {
      const r = await queryFn(`SELECT id FROM tenancy.orgs WHERE slug = 'staqs'`);
      assert.ok(r.rows.length === 1, 'Staqs org must exist in tenancy.orgs (migration 133)');
      staqsOrgId = r.rows[0].id;
    }
    const r = await queryFn(
      `SELECT document_id
         FROM content.match_chunks($1::vector, 30, 0.0, NULL, $2::smallint, TRUE, FALSE, NULL, NULL, $3::uuid[])`,
      [VEC, level, [staqsOrgId]]
    );
    return new Set(r.rows.map(row => row.document_id));
  }

  it('INTERNAL ceiling (level 1) excludes CONFIDENTIAL and RESTRICTED', async () => {
    const ids = await matchAt(1);
    assert.equal(ids.has(DOC_CONFIDENTIAL), false,
      'CONFIDENTIAL(2) must NOT leak to an INTERNAL(1) caller');
    assert.equal(ids.has(DOC_RESTRICTED), false,
      'RESTRICTED(3) must NOT leak to an INTERNAL(1) caller');
  });

  it('INTERNAL ceiling (level 1) includes PUBLIC and INTERNAL', async () => {
    const ids = await matchAt(1);
    assert.equal(ids.has(DOC_PUBLIC), true, 'PUBLIC(0) must be visible at level 1');
    assert.equal(ids.has(DOC_INTERNAL), true, 'INTERNAL(1) must be visible at level 1');
  });

  it('PUBLIC ceiling (level 0) returns only PUBLIC', async () => {
    const ids = await matchAt(0);
    assert.deepEqual([...ids], [DOC_PUBLIC], 'level 0 sees PUBLIC only');
  });

  it('RESTRICTED ceiling (level 3) returns all four tiers', async () => {
    const ids = await matchAt(3);
    for (const id of [DOC_PUBLIC, DOC_INTERNAL, DOC_CONFIDENTIAL, DOC_RESTRICTED]) {
      assert.equal(ids.has(id), true, `level 3 must see ${id}`);
    }
  });

  it('no TEXT-classification match_chunks overload survives migration 118', async () => {
    // Stronger than probing call-resolution: assert directly against the
    // catalog that every remaining match_chunks signature uses the SMALLINT
    // ordinal, never a TEXT classification arg. This is the literal
    // "old IN-CASE block deleted" acceptance criterion.
    const r = await queryFn(
      `SELECT pg_get_function_identity_arguments(oid) AS args
         FROM pg_proc
        WHERE proname = 'match_chunks'
          AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'content')`
    );
    const sigs = r.rows.map(row => row.args);
    const textClassificationSigs = sigs.filter(s => /max_classification\s+text/i.test(s));
    assert.deepEqual(
      textClassificationSigs, [],
      `legacy TEXT-classification overloads still present:\n${textClassificationSigs.join('\n')}`
    );
    assert.ok(
      sigs.some(s => /max_classification_level\s+smallint/i.test(s)),
      'the SMALLINT ordinal signature must exist'
    );
  });
});
