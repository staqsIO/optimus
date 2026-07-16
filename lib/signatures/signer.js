/**
 * Signing Execution
 *
 * Handles the signing action: validates token, captures signer metadata,
 * calls the stored function for atomic hash-chained event insertion.
 */

import { query } from '../db.js';
import { createChildLogger } from '../logger.js';
import { getSignerByToken, getDocumentBody } from './session.js';
import { getCapability } from '../runtime/capability-registry.js';

const log = createChildLogger({ module: 'signatures/signer' });

/**
 * Recompute the canonical document hash for a signer's request. The hash is
 * computed by the DB (signatures.compute_document_hash) using the hash_version
 * stored on the signature request — so the formula matches what was anchored
 * at send time. Never hash in Node.
 */
async function recomputeDocumentHash(draftId, hashVersion) {
  const result = await query(
    `SELECT signatures.compute_document_hash($1, $2) AS hash`,
    [draftId, hashVersion ?? 1]
  );
  return result.rows[0].hash;
}

const CONSENT_TEXT = 'I agree to electronically sign this document. I understand that my electronic signature has the same legal effect as a handwritten signature under the ESIGN Act and UETA.';

/**
 * Validate a signing token and return the session context.
 *
 * @param {string} token - 64-char hex token from URL
 * @returns {Promise<{valid: boolean, signer?: Object, document?: Object, error?: string}>}
 */
export async function validateToken(token) {
  if (!token || token.length !== 64) {
    return { valid: false, error: 'Invalid token format' };
  }

  const signer = await getSignerByToken(token);
  if (!signer) {
    return { valid: false, error: 'Signing link not found or expired' };
  }

  if (signer.request_status === 'cancelled') {
    return { valid: false, error: 'This signing request has been cancelled' };
  }

  if (new Date(signer.expires_at) < new Date()) {
    return { valid: false, error: 'This signing link has expired' };
  }

  if (signer.status === 'signed') {
    return { valid: false, error: 'You have already signed this document' };
  }

  if (signer.status === 'declined') {
    return { valid: false, error: 'You have declined this document' };
  }

  // Fetch document body
  const document = await getDocumentBody(signer.draft_id);
  if (!document) {
    return { valid: false, error: 'Document not found' };
  }

  return { valid: true, signer, document };
}

/**
 * Record a document view event.
 */
export async function recordView(token, ip, userAgent) {
  const signer = await getSignerByToken(token);
  if (!signer) return;

  // Recompute the current canonical hash (body + attachments under the
  // formula version stored at send time) so append_signature_event can
  // compare it to the stored anchor and detect tampering.
  const docHash = await recomputeDocumentHash(signer.draft_id, signer.hash_version);

  await query(
    `SELECT * FROM signatures.append_signature_event($1, $2, 'viewed', $3, NULL, NULL, $4, $5)`,
    [signer.request_id, signer.id, docHash, ip, userAgent]
  );

  log.info({ signerId: signer.id, email: signer.email }, 'Document viewed');
}

/**
 * Execute the signing operation.
 *
 * @param {Object} opts
 * @param {string} opts.token - Signing token
 * @param {string} opts.typedName - Name typed by signer
 * @param {string} opts.ip - Signer's IP address
 * @param {string} opts.userAgent - Browser user agent
 * @returns {Promise<{success: boolean, error?: string, eventId?: string}>}
 */
export async function executeSign(opts) {
  const { token, typedName, ip, userAgent } = opts;

  if (!typedName?.trim()) {
    return { success: false, error: 'Please type your full legal name' };
  }

  const signer = await getSignerByToken(token);
  if (!signer) {
    return { success: false, error: 'Invalid or expired signing link' };
  }

  if (signer.status !== 'pending' && signer.status !== 'viewed') {
    return { success: false, error: `Cannot sign: current status is "${signer.status}"` };
  }

  if (new Date(signer.expires_at) < new Date()) {
    return { success: false, error: 'This signing link has expired' };
  }

  // Recompute current canonical hash for tamper detection
  const docHash = await recomputeDocumentHash(signer.draft_id, signer.hash_version);

  // Call stored function (atomic: hash chain + signer status + request status)
  const result = await query(
    `SELECT * FROM signatures.append_signature_event($1, $2, 'signed', $3, $4, $5, $6, $7)`,
    [signer.request_id, signer.id, docHash, CONSENT_TEXT, typedName.trim(), ip, userAgent]
  );

  const row = result.rows[0];

  if (row.tamper_detected) {
    log.error({ signerId: signer.id, expectedHash: signer.document_hash, actualHash: docHash },
      'TAMPER DETECTED: document modified after signing request was created');
    return { success: false, error: 'Document has been modified since the signing request was created. Please contact the sender.' };
  }

  log.info({
    eventId: row.event_id,
    signerId: signer.id,
    email: signer.email,
    chainHash: row.chain_hash_hex,
    ip,
  }, 'Document signed successfully');

  // Post-sign fire-and-forget: render PDF once, attach to the signer's
  // confirmation email, and — if this sign completed the request — also
  // spawn work_items and email the board creator with the same PDF.
  //
  // PDF render is ~1-2s (Playwright cold Chromium). Keeping it in the
  // async IIFE means the signer gets HTTP success immediately; they won't
  // see any latency from the render.
  //
  // append_signature_event flipped the request status inside the
  // transaction we just ran, so the SELECT below sees the post-transition
  // value. The spawn hand-off is idempotent via work_items_spawned_at.
  (async () => {
    let pdfBuffer = null;
    try {
      // Plan 037: renderer is injected by the product via the capability
      // registry (lib/* no longer names lib/contracts/*). getCapability throws
      // when unregistered — caught below, so the confirmation email degrades to
      // no-attachment exactly like a render failure. Behaviour-preserving.
      const { renderContractPdf } = getCapability('contracts/pdf-render');
      pdfBuffer = await renderContractPdf({ draftId: signer.draft_id });
    } catch (err) {
      log.warn({ err: err.message, signerId: signer.id }, 'PDF render for confirmation failed — email will omit attachment');
    }

    // Signer gets their own PDF copy, independent of the board portal.
    try {
      const { sendSignedConfirmation } = await import('./notifier.js');
      await sendSignedConfirmation({
        signerName: typedName.trim(),
        signerEmail: signer.email,
        documentTitle: signer.title,
        signedAt: new Date(),
        pdfBuffer,
      }).catch(() => {});
    } catch { /* non-fatal */ }

    // Completion hand-off — only runs on the last signer
    try {
      const statusCheck = await query(
        `SELECT sr.status, sr.title, sr.created_by,
                cp.name AS counterparty_name,
                bm.email AS creator_email
           FROM signatures.signature_requests sr
           LEFT JOIN content.drafts d ON d.id = sr.draft_id
           LEFT JOIN content.counterparties cp ON cp.id = d.counterparty_id
           LEFT JOIN agent_graph.board_members bm ON lower(bm.github_username) = lower(sr.created_by)
          WHERE sr.id = $1`,
        [signer.request_id]
      );
      const reqRow = statusCheck.rows[0];
      if (reqRow?.status === 'completed') {
        // Spawn work items (idempotent)
        try {
          // Plan 037: spawn callback injected via the capability registry.
          // getCapability throws when unregistered — caught below (logged,
          // non-fatal), preserving the fire-and-forget contract.
          const { spawnWorkItemsForRequest } = getCapability('contracts/spawn-work-items');
          await spawnWorkItemsForRequest({ requestId: signer.request_id });
        } catch (err) {
          log.error({ err: err.message, requestId: signer.request_id }, 'spawnWorkItemsForRequest failed');
        }

        // STAQPRO-618 (ADR-015): a fully-signed contract means the deal is won.
        // The signature_request links to a draft (sr.draft_id); content.drafts
        // (migration 125) soft-links the draft to its engagement. If this draft
        // came from an engagement, advance that engagement to 'won' (idempotent,
        // non-downgrading). Best-effort — a lifecycle blip must never break the
        // signing flow, so this is wrapped like every other completion hook.
        try {
          const draftRow = await query(
            `SELECT engagement_id FROM content.drafts WHERE id = $1`,
            [signer.draft_id]
          );
          const engagementId = draftRow.rows[0]?.engagement_id || null;
          if (engagementId) {
            const { markEngagementWon } = await import('../engagements/db.js');
            const updated = await markEngagementWon(engagementId);
            log.info(
              { requestId: signer.request_id, engagementId, status: updated?.status ?? 'no-op (already won/active/closed)' },
              'engagement lifecycle advanced on contract completion',
            );
          }
        } catch (err) {
          log.error(
            { err: err.message, requestId: signer.request_id },
            'markEngagementWon hook failed (non-fatal)',
          );
        }

        // Notify the board creator
        if (reqRow.creator_email) {
          try {
            const signerList = await query(
              `SELECT display_name FROM signatures.signers
                WHERE request_id = $1
                ORDER BY signing_order NULLS LAST, email`,
              [signer.request_id]
            );
            const { sendRequestCompletedToBoard } = await import('./notifier.js');
            await sendRequestCompletedToBoard({
              recipientEmail: reqRow.creator_email,
              documentTitle: reqRow.title,
              counterpartyName: reqRow.counterparty_name,
              signerNames: signerList.rows.map(r => r.display_name),
              pdfBuffer,
            }).catch(() => {});
          } catch (err) {
            log.warn({ err: err.message, requestId: signer.request_id }, 'Board completion email failed');
          }
        } else {
          log.info({ requestId: signer.request_id, createdBy: reqRow.created_by }, 'Request completed but no board member email known — skipping completion email');
        }
      }
    } catch (err) {
      log.error({ err: err.message, requestId: signer.request_id }, 'Post-sign completion hook failed');
    }
  })();

  return {
    success: true,
    eventId: row.event_id,
    chainHash: row.chain_hash_hex,
  };
}

/**
 * Record a decline event.
 */
export async function executeDecline(opts) {
  const { token, ip, userAgent, reason } = opts;

  const signer = await getSignerByToken(token);
  if (!signer) {
    return { success: false, error: 'Invalid or expired signing link' };
  }

  const docHash = await recomputeDocumentHash(signer.draft_id, signer.hash_version);

  await query(
    `SELECT * FROM signatures.append_signature_event($1, $2, 'declined', $3, $4, NULL, $5, $6)`,
    [signer.request_id, signer.id, docHash, reason || 'Declined by signer', ip, userAgent]
  );

  log.info({ signerId: signer.id, email: signer.email, reason }, 'Document declined');
  return { success: true };
}

export { CONSENT_TEXT };
