import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';

/**
 * Tests for migrations 103 + 104 (STAQPRO-301): M3 redefinition as
 * voice-similarity between AI draft embeddings and Eric's actual sent
 * reply embeddings, joined on email thread.
 *
 * Uses PGlite (no DATABASE_URL). PGlite has no pgvector, so:
 *   - migration 103 falls back to JSONB for the embedding column
 *   - migration 104 creates the view + function but
 *     agent_graph.m3_voice_similarity() returns NULL via the
 *     pg_extension guard
 *
 * These tests assert the schema lands correctly and the view degrades
 * gracefully without pgvector. Production correctness of the cosine
 * math is verified after deploy via the migration's NOTICE output and
 * the post-merge sanity-check query in the PR description.
 */

describe('m3 voice similarity (STAQPRO-301)', () => {
  let queryFn;

  before(async () => {
    ({ query: queryFn } = await getDb());
  });
  // NOTE: Do not call close() — PGlite cannot reinitialize after close

  it('migration 103: embedding column exists on action_proposals', async () => {
    const result = await queryFn(`
      SELECT column_name, data_type
        FROM information_schema.columns
       WHERE table_schema = 'agent_graph'
         AND table_name = 'action_proposals'
         AND column_name = 'embedding'
    `);
    assert.equal(result.rows.length, 1, 'embedding column must exist');
    // Accept either path:
    //   - USER-DEFINED → pgvector present, column is vector(1024)
    //     (PGlite bundles pgvector; production Supabase has it too)
    //   - jsonb        → pgvector-less fallback path in migration 103
    const dataType = String(result.rows[0].data_type).toLowerCase();
    assert.ok(
      dataType === 'user-defined' || dataType.includes('json'),
      `embedding column must be vector or JSONB, got "${dataType}"`
    );
  });

  it('migration 103: backfill-queue partial index exists', async () => {
    const result = await queryFn(`
      SELECT indexname FROM pg_indexes
       WHERE schemaname = 'agent_graph'
         AND tablename = 'action_proposals'
         AND indexname = 'idx_action_proposals_embed_pending'
    `);
    assert.equal(result.rows.length, 1, 'embed-pending partial index must exist');
  });

  it('migration 104: agent_graph.m3_voice_similarity() function exists', async () => {
    const result = await queryFn(`
      SELECT p.proname
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'agent_graph'
         AND p.proname = 'm3_voice_similarity'
    `);
    assert.equal(result.rows.length, 1, 'function must be created');
  });

  it('migration 104: function returns NULL with empty data (count < 5 threshold)', async () => {
    // With pgvector present (PGlite bundles it) but no embedded drafts,
    // the inner SELECT returns 0 rows so the CASE returns NULL.
    // With pgvector absent, the function's pg_extension guard returns NULL.
    // Either way: NULL is the correct return on an empty/fresh DB.
    const result = await queryFn(`SELECT agent_graph.m3_voice_similarity() AS m3`);
    assert.equal(
      result.rows[0].m3,
      null,
      'function must return NULL with no embedded paired drafts'
    );
  });

  it('migration 104: v_phase1_metrics exposes m3_voice_similarity_pct', async () => {
    const result = await queryFn(`
      SELECT column_name
        FROM information_schema.columns
       WHERE table_schema = 'agent_graph'
         AND table_name = 'v_phase1_metrics'
         AND column_name IN ('m3_voice_similarity_pct', 'm3_draft_accuracy_pct')
    `);
    const cols = result.rows.map(r => r.column_name);
    assert.ok(
      cols.includes('m3_voice_similarity_pct'),
      'new M3 column must exist'
    );
    assert.ok(
      !cols.includes('m3_draft_accuracy_pct'),
      'old M3 column name must be removed (rename, not alias)'
    );
  });

  it('migration 104: m4 is unchanged (still m4_edit_rate_14d_pct)', async () => {
    const result = await queryFn(`
      SELECT column_name
        FROM information_schema.columns
       WHERE table_schema = 'agent_graph'
         AND table_name = 'v_phase1_metrics'
         AND column_name = 'm4_edit_rate_14d_pct'
    `);
    assert.equal(result.rows.length, 1, 'M4 must remain untouched per STAQPRO-301 scope');
  });

  it('selecting from v_phase1_metrics succeeds end-to-end (no syntax errors in the view body)', async () => {
    // Sanity: the full view must SELECT cleanly even with empty tables.
    // Catches things like the M3 function dropping a required column from
    // the view's row shape.
    const result = await queryFn(`SELECT * FROM agent_graph.v_phase1_metrics`);
    assert.equal(result.rows.length, 1, 'view must return exactly one row');
    assert.equal(
      result.rows[0].m3_voice_similarity_pct,
      null,
      'M3 must be NULL with no embedded drafts'
    );
  });
});
