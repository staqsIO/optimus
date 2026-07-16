/**
 * Signature sweeper
 *
 * Called on a schedule (registered by the product's cron route) to do two
 * housekeeping tasks:
 *   1. Expire signature_requests whose expires_at has passed. Pending signers
 *      on those requests are also marked expired so per-signer status stays
 *      truthful in the board UI.
 *   2. Email a reminder to pending signers whose request expires within the
 *      configured horizon and who haven't been reminded in the cooldown
 *      window. Reminder rate-limiting is per signer (signatures.signers
 *      .last_reminded_at), not per request — each signer gets their own
 *      cooldown.
 *
 * Design notes
 * ------------
 * - The expiry update runs as one CTE so a request and its signers transition
 *   atomically. No retry loop: if the CTE fails, the cron will try again
 *   on the next tick.
 * - Reminders ARE sent best-effort: if Resend returns an error, we log and
 *   skip marking last_reminded_at, so the next cron tick can retry. We only
 *   bump last_reminded_at on a successful send.
 * - Reminder cooldown and horizon are pure wall-clock values — no attempt
 *   to pace differently for parallel vs sequential mode yet. Sequential mode
 *   should probably only remind the current signer, not the whole chain;
 *   deferred to a later iteration.
 */

import { query } from '../db.js';
import { createChildLogger } from '../logger.js';

const log = createChildLogger({ module: 'signatures/sweeper' });

const SIGNING_BASE_URL = process.env.SIGNING_BASE_URL || 'https://board.staqs.io';

/**
 * @typedef {Object} SweepResult
 * @property {number} requestsExpired
 * @property {number} signersExpired
 * @property {number} remindersSent
 * @property {number} remindersFailed
 * @property {string[]} errors
 */

/**
 * Run one sweep pass. Safe to call concurrently with signing traffic — the
 * queries only touch rows whose status makes them eligible.
 *
 * @param {Object} [opts]
 * @param {string} [opts.reminderHorizon='48 hours'] Postgres interval — start reminding signers whose request expires within this window.
 * @param {string} [opts.reminderCooldown='24 hours'] Postgres interval — minimum gap between reminders to the same signer.
 * @returns {Promise<SweepResult>}
 */
export async function sweepSignatures(opts = {}) {
  const reminderHorizon = opts.reminderHorizon || '48 hours';
  const reminderCooldown = opts.reminderCooldown || '24 hours';

  const result = {
    requestsExpired: 0,
    signersExpired: 0,
    remindersSent: 0,
    remindersFailed: 0,
    errors: [],
  };

  // 1. Expire overdue requests + their pending signers in one CTE
  try {
    const expired = await query(
      `WITH expired_requests AS (
         UPDATE signatures.signature_requests
            SET status = 'expired', updated_at = now()
          WHERE status IN ('pending', 'in_progress')
            AND expires_at < now()
          RETURNING id
       ),
       expired_signers AS (
         UPDATE signatures.signers
            SET status = 'expired', updated_at = now()
          WHERE request_id IN (SELECT id FROM expired_requests)
            AND status IN ('pending', 'viewed')
          RETURNING id
       )
       SELECT
         (SELECT count(*) FROM expired_requests)::int AS requests_expired,
         (SELECT count(*) FROM expired_signers)::int  AS signers_expired`
    );
    result.requestsExpired = expired.rows[0].requests_expired;
    result.signersExpired = expired.rows[0].signers_expired;
    if (result.requestsExpired > 0) {
      log.info({ requestsExpired: result.requestsExpired, signersExpired: result.signersExpired }, 'Expired signature requests swept');
    }
  } catch (err) {
    log.error({ err: err.message }, 'Expiry sweep failed');
    result.errors.push(`expiry: ${err.message}`);
  }

  // 2. Gather reminder candidates.
  // Parallel mode: every pending/viewed signer on an expiring request is
  //   eligible (subject to rate-limit cooldown).
  // Sequential mode: only the *current* signer is eligible — the one with
  //   the lowest signing_order whose status is still pending/viewed.
  //   Nudging signer 3 while signer 1 hasn't acted is noise and confuses
  //   the counterparty. The DISTINCT ON subquery picks that row per request.
  let candidates = [];
  try {
    const cand = await query(
      `WITH active_sequential AS (
         SELECT DISTINCT ON (s.request_id) s.id
           FROM signatures.signers s
           JOIN signatures.signature_requests sr ON sr.id = s.request_id
          WHERE sr.signing_mode = 'sequential'
            AND sr.status IN ('pending', 'in_progress')
            AND s.status IN ('pending', 'viewed')
          ORDER BY s.request_id, s.signing_order NULLS LAST, s.email
       )
       SELECT s.id, s.email, s.display_name, s.signing_token,
              sr.id AS request_id, sr.title, sr.expires_at, sr.created_by
         FROM signatures.signers s
         JOIN signatures.signature_requests sr ON sr.id = s.request_id
        WHERE sr.status IN ('pending', 'in_progress')
          AND sr.expires_at > now()
          AND sr.expires_at < now() + ($1::interval)
          AND s.status IN ('pending', 'viewed')
          AND (s.last_reminded_at IS NULL
               OR s.last_reminded_at < now() - ($2::interval))
          AND (
            sr.signing_mode = 'parallel'
            OR s.id IN (SELECT id FROM active_sequential)
          )
        ORDER BY sr.expires_at ASC
        LIMIT 200`,
      [reminderHorizon, reminderCooldown]
    );
    candidates = cand.rows;
  } catch (err) {
    log.error({ err: err.message }, 'Reminder candidate query failed');
    result.errors.push(`candidates: ${err.message}`);
    return result;
  }

  if (candidates.length === 0) return result;

  // Lazy-import so the sweeper is still useful when notifier fails to import
  // (e.g. RESEND_API_KEY unset).
  const { sendSigningReminder } = await import('./notifier.js');

  for (const s of candidates) {
    const signingUrl = `${SIGNING_BASE_URL}/sign/${s.signing_token}`;
    let sendResult;
    try {
      sendResult = await sendSigningReminder({
        signerName: s.display_name,
        signerEmail: s.email,
        signingUrl,
        documentTitle: s.title,
        senderName: s.created_by,
        expiresAt: s.expires_at,
      });
    } catch (err) {
      sendResult = { success: false, error: err.message };
    }

    if (sendResult.success) {
      try {
        await query(
          `UPDATE signatures.signers SET last_reminded_at = now() WHERE id = $1`,
          [s.id]
        );
        result.remindersSent += 1;
      } catch (err) {
        // Email went out but we couldn't record it — next tick will re-send.
        // Flag it so the operator notices.
        log.error({ err: err.message, signerId: s.id }, 'Reminder sent but last_reminded_at update failed');
        result.errors.push(`mark-reminded ${s.id}: ${err.message}`);
      }
    } else {
      result.remindersFailed += 1;
      log.warn({ signerId: s.id, email: s.email, error: sendResult.error }, 'Reminder send failed');
    }
  }

  return result;
}
