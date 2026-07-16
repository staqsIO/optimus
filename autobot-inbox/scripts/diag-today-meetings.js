#!/usr/bin/env node
import { config as loadEnv } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(__dirname, '../../.env') });
loadEnv({ path: path.resolve(__dirname, '../.env'), override: true });

const { initializeDatabase, query, close } = await import('../src/db.js');

/**
 * Diagnostic: shows exactly what the chat orchestrator's today-context
 * query returns, plus a wider view of meetings around now, so we can tell
 * whether a missing "today's meeting" is a data problem, a query problem,
 * or a deploy/restart problem.
 *
 * Run:  node scripts/diag-today-meetings.js
 */

async function main() {
  await initializeDatabase();

  const tightSql = `
    WITH parsed AS (
      SELECT d.id, d.source, d.format, d.title, d.participants,
             d.metadata->>'happenedAt' AS stored_happened_at,
             d.created_at,
             COALESCE(
               CASE
                 WHEN (d.source = 'gemini' OR (d.source = 'drive' AND d.format = 'gemini'))
                  AND d.title ~ '[0-9]{4}[/-][0-9]{2}[/-][0-9]{2}\\s+[0-9]{1,2}:[0-9]{2}\\s+(PDT|PST|EDT|EST|MDT|MST|CDT|CST|UTC|GMT)'
                 THEN (
                   replace(
                     (regexp_match(
                       d.title,
                       '([0-9]{4}[/-][0-9]{2}[/-][0-9]{2}\\s+[0-9]{1,2}:[0-9]{2}\\s+(PDT|PST|EDT|EST|MDT|MST|CDT|CST|UTC|GMT))'
                     ))[1],
                     '/', '-'
                   )
                 )::timestamptz
                 ELSE NULL
               END,
               CASE WHEN d.metadata->>'happenedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
                    THEN (d.metadata->>'happenedAt')::timestamptz ELSE NULL END,
               d.created_at
             ) AS resolved_happened_at
      FROM content.documents d
      WHERE d.deleted_at IS NULL
        AND (d.source IN ('tldv','gemini')
             OR (d.source = 'drive' AND d.format IN ('tldv','gemini')))
    )
    SELECT id, source, format, title, stored_happened_at,
           resolved_happened_at, created_at
    FROM parsed
    WHERE (resolved_happened_at AT TIME ZONE 'America/Los_Angeles')::date
        = (now() AT TIME ZONE 'America/Los_Angeles')::date
    ORDER BY resolved_happened_at DESC
  `;

  const wideSql = `
    SELECT id, source, format, title,
           metadata->>'happenedAt' AS stored_happened_at,
           created_at
    FROM content.documents
    WHERE deleted_at IS NULL
      AND (source IN ('tldv','gemini')
           OR (source = 'drive' AND format IN ('tldv','gemini')))
      AND (
        created_at > now() - interval '7 days'
        OR (metadata->>'happenedAt')::text > (now() - interval '7 days')::text
      )
    ORDER BY created_at DESC
    LIMIT 30
  `;

  const steveSql = `
    SELECT id, source, format, title,
           metadata->>'happenedAt' AS stored_happened_at,
           created_at
    FROM content.documents
    WHERE deleted_at IS NULL
      AND title ILIKE '%steve%'
    ORDER BY created_at DESC
    LIMIT 20
  `;

  const nowResult = await query(
    `SELECT now() AS now_utc,
            (now() AT TIME ZONE 'America/Los_Angeles')::date AS today_pt`
  );
  const { now_utc, today_pt } = nowResult.rows[0];

  console.log('');
  console.log('── server time ──');
  console.log(`now (UTC):       ${new Date(now_utc).toISOString()}`);
  console.log(`today (Pacific): ${today_pt}`);

  console.log('');
  console.log("── chat 'today' (Pacific calendar day) ──");
  const tight = await query(tightSql);
  if (tight.rows.length === 0) {
    console.log('(none)');
  } else {
    for (const r of tight.rows) {
      console.log(`  [${r.source}/${r.format || '-'}] ${r.title?.slice(0, 70) || '(no title)'}`);
      console.log(`    stored happenedAt:   ${r.stored_happened_at || '(null)'}`);
      console.log(`    resolved happenedAt: ${new Date(r.resolved_happened_at).toISOString()}`);
      console.log(`    created_at:          ${new Date(r.created_at).toISOString()}`);
      console.log(`    id: ${r.id}`);
    }
  }

  console.log('');
  console.log('── wide view: any meeting doc in past 7 days ──');
  const wide = await query(wideSql);
  if (wide.rows.length === 0) {
    console.log('(none)');
  } else {
    for (const r of wide.rows) {
      console.log(`  [${r.source}/${r.format || '-'}] ${r.title?.slice(0, 70) || '(no title)'}`);
      console.log(`    stored: ${r.stored_happened_at || '(null)'}    created: ${new Date(r.created_at).toISOString()}`);
    }
  }

  console.log('');
  console.log('── any doc with "steve" in title ──');
  const steve = await query(steveSql);
  if (steve.rows.length === 0) {
    console.log('(none)');
  } else {
    for (const r of steve.rows) {
      console.log(`  [${r.source}/${r.format || '-'}] ${r.title?.slice(0, 70)}`);
      console.log(`    stored: ${r.stored_happened_at || '(null)'}    created: ${new Date(r.created_at).toISOString()}`);
    }
  }
}

main()
  .catch((err) => {
    console.error('Diagnostic failed:', err.message);
    console.error(err.stack);
    process.exitCode = 1;
  })
  .finally(async () => {
    await close();
  });
