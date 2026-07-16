import 'dotenv/config';
import { google } from 'googleapis';
import { initializeDatabase, close, query } from '../src/db.js';
import { getAuth } from '../src/gmail/auth.js';

/**
 * One-shot backfill: populate voice.sent_emails.in_reply_to from Gmail
 * headers for existing rows.
 *
 * STAQPRO-305: M3 voice-similarity uses a RFC822 In-Reply-To join
 * (migration 107) for turn-level draft<->reply matching. Existing
 * sent_emails rows were ingested before in_reply_to was captured;
 * this script walks them, pulls the In-Reply-To header via Gmail's
 * messages.get (format=metadata), and UPDATEs the row.
 *
 * Mirrors scripts/embed-drafts.js for the runner shape:
 *   - dotenv + initializeDatabase up front
 *   - process in batches with progress log
 *   - exit zero with a remaining-count summary
 *
 * Scoping: only processes is_reply=true rows. The is_reply flag was
 * set at ingest time based on header presence; if it's false, there
 * was no In-Reply-To then and there isn't one now — skip those.
 * Idempotent + resumable: re-running only touches still-NULL rows.
 *
 * Gmail quota: messages.get costs 5 units; default user quota is
 * 250 units/sec → ~50 calls/sec safe. ~1011 rows = ~20s minimum.
 * Script runs sequentially (no parallelism) — sleep on rate-limit
 * errors and continue; correctness first, speed second.
 */
async function main() {
  console.log('AutoBot Inbox — sent_emails.in_reply_to backfill (STAQPRO-305)');
  console.log('==============================================================\n');

  if (!process.env.GMAIL_REFRESH_TOKEN) {
    console.error('GMAIL_REFRESH_TOKEN required for Gmail header fetch.');
    process.exit(1);
  }

  await initializeDatabase();

  const queueResult = await query(
    `SELECT count(*) AS cnt
       FROM voice.sent_emails
      WHERE is_reply = true
        AND in_reply_to IS NULL
        AND provider_msg_id IS NOT NULL`
  );
  const queueDepth = parseInt(queueResult.rows[0]?.cnt || '0', 10);
  console.log(`Queue depth: ${queueDepth} sent_email rows pending in_reply_to backfill\n`);

  if (queueDepth === 0) {
    console.log('Nothing to do.');
    await close();
    return;
  }

  const gmail = google.gmail({ version: 'v1', auth: getAuth() });

  let updated = 0;
  let emptyHeader = 0;
  let errors = 0;
  let processed = 0;
  const BATCH_SIZE = 100;

  while (true) {
    const batch = await query(
      `SELECT id, provider_msg_id
         FROM voice.sent_emails
        WHERE is_reply = true
          AND in_reply_to IS NULL
          AND provider_msg_id IS NOT NULL
        ORDER BY sent_at DESC
        LIMIT $1`,
      [BATCH_SIZE]
    );

    if (batch.rows.length === 0) break;

    for (const row of batch.rows) {
      try {
        const resp = await gmail.users.messages.get({
          userId: 'me',
          id: row.provider_msg_id,
          format: 'metadata',
          metadataHeaders: ['In-Reply-To'],
        });

        let inReplyTo = null;
        const headers = resp.data.payload?.headers || [];
        for (const h of headers) {
          if (h.name?.toLowerCase() === 'in-reply-to') {
            inReplyTo = (h.value || '').trim() || null;
            break;
          }
        }

        if (inReplyTo) {
          await query(
            `UPDATE voice.sent_emails
                SET in_reply_to = $1
              WHERE id = $2`,
            [inReplyTo, row.id]
          );
          updated++;
        } else {
          // Header genuinely absent. Leave in_reply_to NULL; is_reply
          // is presumably also stale here — but updating is_reply is
          // out of scope for this backfill.
          emptyHeader++;
        }
      } catch (err) {
        errors++;
        const status = err?.response?.status || err?.code;
        if (status === 429 || status === 403) {
          // Rate-limit. Back off and retry the row on the next outer
          // batch (we don't UPDATE on failure, so it stays in the queue).
          console.warn(`  Rate-limited on ${row.provider_msg_id} (${status}); sleeping 5s and resuming`);
          await new Promise(r => setTimeout(r, 5000));
        } else if (status === 404) {
          // Message no longer exists in Gmail (deleted / different account).
          // Skip silently; the row stays NULL and falls through to the
          // closest-in-time fallback in migration 107.
        } else {
          console.warn(`  Failed ${row.provider_msg_id}: ${err.message || status}`);
        }
      }
      processed++;
    }

    console.log(`Progress: ${processed}/${queueDepth} (updated=${updated}, empty=${emptyHeader}, errors=${errors})`);

    // Safety: if a full batch produced nothing actionable, break to
    // avoid spinning on a stuck queue (errors that don't clear).
    if (batch.rows.length < BATCH_SIZE) break;
  }

  const remainingResult = await query(
    `SELECT count(*) AS cnt
       FROM voice.sent_emails
      WHERE is_reply = true
        AND in_reply_to IS NULL
        AND provider_msg_id IS NOT NULL`
  );
  const remaining = parseInt(remainingResult.rows[0]?.cnt || '0', 10);

  console.log(`\nDone. Updated ${updated} rows; ${emptyHeader} had no In-Reply-To; ${errors} errors; ${remaining} still NULL`);
  if (remaining > 0) {
    console.log('(re-run to retry rate-limited or transient errors)');
  }

  await close();
}

main().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
