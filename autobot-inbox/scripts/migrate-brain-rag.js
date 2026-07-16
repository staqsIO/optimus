#!/usr/bin/env node
/**
 * Migrate brain-rag data from Carlos's Supabase project into Optimus's
 * content.documents + content.chunks tables.
 *
 * Maps:
 *   brain-rag public.sources  → content.documents
 *   brain-rag public.chunks   → content.chunks
 *
 * Usage:
 *   node scripts/migrate-brain-rag.js
 *
 * Env vars (from .env):
 *   SUPABASE_DATABASE_URL  — brain-rag Supabase (source)
 *   OPTIMUS_SUPABASE_URL   — Optimus Supabase (target) — or uses pooler directly
 */

import pg from 'pg';
const { Pool } = pg;

// Brain-rag source (Carlos's Supabase)
const brainRagPool = new Pool({
  host: 'aws-0-us-west-2.pooler.supabase.com',
  port: 6543,
  database: 'postgres',
  user: 'postgres.acgedshlwkdzcuqyrvri',
  password: '!DQUBFa*m*vNVTsc@3MM8',
  ssl: { rejectUnauthorized: false },
});

// Optimus target (new Supabase)
const optimusPool = new Pool({
  host: 'aws-0-us-west-2.pooler.supabase.com',
  port: 5432, // session pooler for DDL support
  database: 'postgres',
  user: 'postgres.bqcsspyrwfvzwjlwopge',
  password: 'ypq7jmu.kfd@NHY*cnb',
  ssl: { rejectUnauthorized: false },
});

async function migrate() {
  console.log('[migrate] Connecting to brain-rag...');
  await brainRagPool.query('SELECT 1');
  console.log('[migrate] Connecting to Optimus...');
  await optimusPool.query('SELECT 1');

  // 1. Read all sources from brain-rag
  const sources = await brainRagPool.query(`
    SELECT s.id, s.name, s.source_type, s.metadata, s.created_at,
           d.id as document_id
    FROM public.sources s
    LEFT JOIN public.documents d ON d.source_id = s.id
    ORDER BY s.created_at
  `);
  console.log(`[migrate] Found ${sources.rows.length} sources in brain-rag`);

  // 2. Read all segments (raw text) per document
  let docsCreated = 0;
  let chunksCreated = 0;
  let skipped = 0;

  for (const source of sources.rows) {
    // Check dedup — already migrated?
    const existing = await optimusPool.query(
      `SELECT id FROM content.documents WHERE source = 'brain-rag' AND source_id = $1`,
      [source.id]
    );
    if (existing.rows.length > 0) {
      skipped++;
      continue;
    }

    // Get raw text from segments
    let rawText = '';
    if (source.document_id) {
      const segments = await brainRagPool.query(
        `SELECT content, metadata FROM public.document_segments
         WHERE document_id = $1 ORDER BY "index"`,
        [source.document_id]
      );
      rawText = segments.rows.map(s => {
        const speaker = s.metadata?.speaker;
        const timestamp = s.metadata?.timestamp;
        const prefix = speaker ? `${speaker}: ` : '';
        return prefix + s.content;
      }).join('\n');
    }

    if (!rawText || rawText.trim().length === 0) {
      console.log(`[migrate] Skipping empty source: ${source.name}`);
      skipped++;
      continue;
    }

    // Determine format
    const format = source.source_type === 'tldv' ? 'tldv' : 'plain';

    // Estimate tokens
    const tokenCount = Math.ceil(rawText.length / 4);

    // Insert document
    const docResult = await optimusPool.query(
      `INSERT INTO content.documents
       (source, source_id, title, raw_text, format, metadata, sanitized, token_count,
        embedding_model, embedding_dimensions, created_at)
       VALUES ('brain-rag', $1, $2, $3, $4, $5, true, $6, 'text-embedding-3-small', 1536, $7)
       RETURNING id`,
      [
        source.id,
        source.name,
        rawText,
        format,
        JSON.stringify(source.metadata || {}),
        tokenCount,
        source.created_at,
      ]
    );
    const newDocId = docResult.rows[0].id;
    docsCreated++;

    // Get chunks with embeddings from brain-rag
    const chunks = await brainRagPool.query(
      `SELECT chunk_index, content, embedding, metadata
       FROM public.chunks
       WHERE source_id = $1
       ORDER BY chunk_index`,
      [source.id]
    );

    for (const chunk of chunks.rows) {
      const chunkTokens = Math.ceil(chunk.content.length / 4);
      // Embedding comes as pgvector string "[0.1,0.2,...]" — pass through directly
      const embeddingStr = chunk.embedding || null;

      await optimusPool.query(
        `INSERT INTO content.chunks
         (document_id, chunk_index, text, token_count, embedding, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          newDocId,
          chunk.chunk_index,
          chunk.content,
          chunkTokens,
          embeddingStr,
          JSON.stringify(chunk.metadata || {}),
        ]
      );
      chunksCreated++;
    }

    console.log(`[migrate] ${source.name}: ${chunks.rows.length} chunks (${format})`);
  }

  // Summary
  console.log('\n[migrate] === COMPLETE ===');
  console.log(`[migrate] Documents created: ${docsCreated}`);
  console.log(`[migrate] Chunks migrated: ${chunksCreated}`);
  console.log(`[migrate] Skipped (empty/duplicate): ${skipped}`);

  // Verify
  const docCount = await optimusPool.query('SELECT count(*) as c FROM content.documents');
  const chunkCount = await optimusPool.query('SELECT count(*) as c FROM content.chunks');
  const embeddedCount = await optimusPool.query('SELECT count(*) as c FROM content.chunks WHERE embedding IS NOT NULL');
  console.log(`[migrate] Optimus totals: ${docCount.rows[0].c} documents, ${chunkCount.rows[0].c} chunks (${embeddedCount.rows[0].c} with embeddings)`);

  await brainRagPool.end();
  await optimusPool.end();
}

migrate().catch(err => {
  console.error('[migrate] FATAL:', err.message);
  process.exit(1);
});
