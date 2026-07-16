/**
 * Transcript ingestion routes.
 *
 * Surfaces operator-driven backfill for tl;dv (API), the transcript source
 * Optimus pulls into RAG. Kicks off long-running jobs in the background and
 * returns a job descriptor the UI can use to poll status.
 */

import {
  backfillTldvTranscripts,
  isTldvBackfillRunning,
  backfillTldvMessages,
  isTldvMessagesBackfillRunning,
} from '../tldv/poller.js';

export function registerTranscriptRoutes(routes) {
  // GET /api/transcripts/status — overview for the Transcripts UI tab.
  // Reports tl;dv configuration in one call.
  routes.set('GET /api/transcripts/status', async () => {
    return {
      tldv: {
        api_key_configured: Boolean(process.env.TLDV_API_KEY),
        webhook_secret_configured: Boolean(process.env.TLDV_WEBHOOK_SECRET),
        backfill_running: isTldvBackfillRunning(),
        messages_backfill_running: isTldvMessagesBackfillRunning(),
        poll_interval_ms: parseInt(process.env.TLDV_POLL_INTERVAL_MS || '300000', 10),
      },
    };
  });

  // POST /api/transcripts/backfill-tldv — kick off the full-history sweep.
  // Body (all optional): { lookbackDays, maxPages, pageSize }
  routes.set('POST /api/transcripts/backfill-tldv', async (_req, body = {}) => {
    if (!process.env.TLDV_API_KEY) {
      throw Object.assign(new Error('TLDV_API_KEY not configured'), { statusCode: 400 });
    }
    if (isTldvBackfillRunning()) {
      throw Object.assign(new Error('tl;dv backfill already running'), { statusCode: 409 });
    }
    const jobId = `tldv-backfill-${Date.now()}`;
    setImmediate(() => {
      backfillTldvTranscripts({
        lookbackDays: body.lookbackDays,
        maxPages: body.maxPages,
        pageSize: body.pageSize,
      }).catch(err => console.error(`[tldv-backfill] ${jobId} failed: ${err.message}`));
    });
    return {
      ok: true,
      jobId,
      message: 'tl;dv backfill started — check Railway logs and re-poll /api/transcripts/status for progress.',
    };
  });

  // POST /api/transcripts/backfill-tldv-messages — repair tl;dv documents
  // ingested before the poller wrote inbox.messages rows. Without those
  // rows, signal extraction never ran and /api/today/meetings returns
  // empty action_items. Re-fetches the transcript per meeting to populate
  // the snippet, then enqueues triage. Idempotent.
  routes.set('POST /api/transcripts/backfill-tldv-messages', async () => {
    if (!process.env.TLDV_API_KEY) {
      throw Object.assign(new Error('TLDV_API_KEY not configured'), { statusCode: 400 });
    }
    if (isTldvMessagesBackfillRunning()) {
      throw Object.assign(new Error('tl;dv messages backfill already running'), { statusCode: 409 });
    }
    const jobId = `tldv-msg-backfill-${Date.now()}`;
    setImmediate(() => {
      backfillTldvMessages().catch(err =>
        console.error(`[tldv-msg-backfill] ${jobId} failed: ${err.message}`)
      );
    });
    return {
      ok: true,
      jobId,
      message: 'tl;dv messages backfill started — check Railway logs and re-poll /api/transcripts/status for progress.',
    };
  });
}
