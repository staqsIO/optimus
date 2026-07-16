#!/usr/bin/env node
/**
 * READ-ONLY audit of current TLDv ingestion state in prod.
 *
 * Answers the questions we need before running a TLDv-API backfill:
 *   1. How many `content.documents` rows are tagged `source='tldv'`?
 *   2. How many were ingested via the Drive watcher path (`source='drive'`
 *      with `format='tldv'`)?
 *   3. What's the date range of each?
 *   4. Is there a meeting_id stored on Drive-source rows that we can use
 *      to dedup against the API backfill?
 *
 * Run on Railway:  railway run -s autobot-inbox-api node scripts/audit-tldv-ingestion.js
 *
 * Pure SELECTs. Nothing is written.
 */

import { query } from '../src/db.js';

async function main() {
  console.log('=== TLDv corpus audit ===\n');

  // 1. Counts by source family
  const counts = await query(`
    SELECT
      CASE
        WHEN source = 'tldv' THEN 'tldv (API)'
        WHEN source = 'drive' AND format = 'tldv' THEN 'drive (TLDv format)'
        WHEN source = 'drive' AND format = 'gemini' THEN 'drive (Gemini format)'
        WHEN source = 'drive' THEN 'drive (other)'
        ELSE source
      END AS bucket,
      count(*) AS docs,
      min(created_at)::date AS earliest_ingested,
      max(created_at)::date AS latest_ingested
    FROM content.documents
    WHERE source IN ('tldv','drive')
      AND deleted_at IS NULL
    GROUP BY bucket
    ORDER BY bucket
  `);
  console.log('Documents by source/format (excluding soft-deleted):');
  console.table(counts.rows);

  // 2. TLDv-source monthly distribution
  const tldvMonthly = await query(`
    SELECT
      to_char(date_trunc('month', created_at), 'YYYY-MM') AS month,
      count(*) AS rows
    FROM content.documents
    WHERE source = 'tldv' AND deleted_at IS NULL
    GROUP BY 1 ORDER BY 1
  `);
  console.log('\nsource=tldv (API path) by month:');
  console.table(tldvMonthly.rows);

  // 3. Drive-source TLDv-format monthly distribution
  const driveTldvMonthly = await query(`
    SELECT
      to_char(date_trunc('month', created_at), 'YYYY-MM') AS month,
      count(*) AS rows
    FROM content.documents
    WHERE source = 'drive' AND format = 'tldv' AND deleted_at IS NULL
    GROUP BY 1 ORDER BY 1
  `);
  console.log("\nsource=drive AND format='tldv' (Drive watcher path) by month:");
  console.table(driveTldvMonthly.rows);

  // 4. Do drive-source TLDv rows carry a meeting_id in metadata?
  const driveMetadataShape = await query(`
    SELECT
      jsonb_object_keys(metadata) AS metadata_key,
      count(*) AS occurrences
    FROM content.documents
    WHERE source = 'drive' AND format = 'tldv' AND deleted_at IS NULL
    GROUP BY 1
    ORDER BY 2 DESC
    LIMIT 25
  `);
  console.log("\nKeys present in drive+tldv metadata (helps decide dedup strategy):");
  console.table(driveMetadataShape.rows);

  // 5. Sample 3 drive+tldv rows so we can eyeball their shape
  const driveSamples = await query(`
    SELECT id, title, source_id, format, metadata, created_at::date AS ingested_on
    FROM content.documents
    WHERE source = 'drive' AND format = 'tldv' AND deleted_at IS NULL
    ORDER BY created_at DESC
    LIMIT 3
  `);
  console.log('\nSample drive+tldv rows:');
  for (const row of driveSamples.rows) {
    console.log(
      `  ${row.ingested_on}  ${row.title?.slice(0, 60) || '<no title>'}  source_id=${row.source_id?.slice(0, 14)}…\n    metadata=${JSON.stringify(row.metadata)?.slice(0, 240)}…`
    );
  }

  // 6. Inbox.messages → tldv linkage. ensureTldvMessageAndWorkItem writes
  // a row per meeting; count them so we know how many meetings the runtime
  // already knows about (independent of corpus path).
  const inboxTldv = await query(`
    SELECT count(*) AS messages
    FROM inbox.messages
    WHERE channel = 'tldv' OR provider = 'tldv'
       OR (metadata IS NOT NULL AND metadata::text ILIKE '%tldv%')
  `);
  console.log(`\ninbox.messages with TLDv signal: ${inboxTldv.rows[0]?.messages}`);

  console.log('\n=== End audit ===');
  process.exit(0);
}

main().catch((err) => {
  console.error('Audit failed:', err);
  process.exit(1);
});
