#!/usr/bin/env node
// Backfill voice.unenrolled_speakers from existing completed voice memos.
//
// For every row in inbox.voice_memo_pending where status='completed' and
// audio_url is still reachable, refetches the transcript utterances from
// AssemblyAI and runs the same resolver the live webhook uses with
// captureUnmatched=true. The resolver:
//   - matches against existing voice_prints (no-op if already named),
//   - dedupes against existing unenrolled_speakers (increments counts),
//   - or inserts a new candidate.
//
// Cost: WavLM embedding runs locally (~5s per speaker bucket per memo)
// + AssemblyAI API call + audio download. For ~50 memos, expect a few
// minutes. Use --limit to cap a run.
//
// Usage:
//   node autobot-inbox/scripts/backfill-unenrolled-speakers.js                # dry-run, all
//   node autobot-inbox/scripts/backfill-unenrolled-speakers.js --apply        # actually capture
//   node autobot-inbox/scripts/backfill-unenrolled-speakers.js --apply --limit=10
//
// Re-runnable: matched/duplicate speakers won't double-insert.

import 'dotenv/config';
import { query } from '../src/db.js';
import { fetchTranscript } from '../../lib/transcription/assemblyai.js';
import { resolveAssemblyAISpeakers } from '../../lib/voice/speaker-resolver.js';

function parseArgs(argv) {
  const apply = argv.includes('--apply');
  const limitArg = argv.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : 200;
  return { apply, limit };
}

async function main() {
  const { apply, limit } = parseArgs(process.argv.slice(2));
  console.log(`[backfill-speakers] mode=${apply ? 'APPLY' : 'DRY-RUN'} limit=${limit}`);

  const pendings = await query(
    `SELECT id, transcript_id, audio_url, primary_speaker
       FROM inbox.voice_memo_pending
      WHERE status = 'completed'
        AND audio_url IS NOT NULL
        AND transcript_id IS NOT NULL
      ORDER BY created_at DESC
      LIMIT $1`,
    [limit]
  );

  console.log(`[backfill-speakers] candidates: ${pendings.rows.length}`);
  if (pendings.rows.length === 0) {
    process.exit(0);
  }

  // Snapshot existing candidate count so we can show net additions.
  const before = await query(
    `SELECT COUNT(*)::int AS n,
            COALESCE(SUM(occurrence_count), 0)::int AS total_occurrences
       FROM voice.unenrolled_speakers`,
  );
  console.log(`[backfill-speakers] unenrolled_speakers before: rows=${before.rows[0].n} occurrences=${before.rows[0].total_occurrences}`);

  let processed = 0, skipped = 0, errors = 0;
  for (const p of pendings.rows) {
    try {
      const transcript = await fetchTranscript(p.transcript_id);
      const utterances = Array.isArray(transcript?.utterances) ? transcript.utterances : [];
      if (utterances.length === 0) {
        skipped += 1;
        continue;
      }

      const audioRes = await fetch(p.audio_url);
      if (!audioRes.ok) {
        skipped += 1;
        console.warn(`[backfill-speakers] memo ${p.id}: audio fetch ${audioRes.status}`);
        continue;
      }
      const audioBuf = Buffer.from(await audioRes.arrayBuffer());

      await resolveAssemblyAISpeakers(query, audioBuf, utterances, {
        memoId: p.id,
        captureUnmatched: apply, // dry-run never writes
      });

      processed += 1;
      if (processed % 10 === 0) {
        console.log(`[backfill-speakers] processed ${processed}/${pendings.rows.length}`);
      }
    } catch (err) {
      errors += 1;
      console.warn(`[backfill-speakers] memo ${p.id} failed: ${err.message}`);
    }
  }

  const after = await query(
    `SELECT COUNT(*)::int AS n,
            COALESCE(SUM(occurrence_count), 0)::int AS total_occurrences
       FROM voice.unenrolled_speakers`,
  );

  console.log('');
  console.log(`[backfill-speakers] processed : ${processed}`);
  console.log(`[backfill-speakers] skipped   : ${skipped}`);
  console.log(`[backfill-speakers] errors    : ${errors}`);
  console.log(`[backfill-speakers] unenrolled_speakers after : rows=${after.rows[0].n} occurrences=${after.rows[0].total_occurrences}`);
  console.log(`[backfill-speakers] delta     : +${after.rows[0].n - before.rows[0].n} rows, +${after.rows[0].total_occurrences - before.rows[0].total_occurrences} occurrences`);
  console.log('');

  if (!apply) {
    console.log(`[backfill-speakers] DRY-RUN — re-run with --apply to capture candidates.`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('[backfill-speakers] fatal:', err.message);
  process.exit(1);
});
