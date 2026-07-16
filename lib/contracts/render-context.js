/**
 * Shared render-context loader for the two contract renderers.
 *
 * `renderContractDocx` (docx-render.js) and `renderContractPdf`
 * (pdf-render.js) opened with a byte-for-byte-identical block that ran the
 * same three SQL queries (draft + counterparty, latest signature request,
 * signers + latest event per signer) and resolved the brand profile the
 * same way. That data-loading block lives here now so a column change on the
 * contract query is edited in exactly one place.
 *
 * Only the data load is shared. The format-specific rendering (docx object
 * tree vs. Playwright HTML→PDF) stays in each renderer, and so does each
 * renderer's hard `FALLBACK_BRAND` — those genuinely differ by output
 * substrate (Word needs a real font name like Calibri; the PDF/CSS path uses
 * a system-font stack), so the caller passes its own via `fallbackBrand`.
 */

import { query } from '../db.js';
import { createChildLogger } from '../logger.js';
import { loadBrandProfileForDraft } from './brand-profile.js';

const log = createChildLogger({ module: 'contracts/render-context' });

/**
 * Load the draft, latest signature request, signers, latest event per
 * signer, and resolved brand for a contract draft.
 *
 * @param {Object} opts
 * @param {string} opts.draftId
 * @param {Object} opts.fallbackBrand  Format-specific brand used when no
 *   brand profile resolves (docx → Calibri; pdf → CSS system-font stack).
 * @returns {Promise<{
 *   row: Object,
 *   request: Object|null,
 *   signers: Object[],
 *   latestEvents: Object[],
 *   profile: Object,
 *   assets: Object,
 * }>}
 */
export async function loadContractRenderContext({ draftId, fallbackBrand }) {
  const draft = await query(
    `SELECT d.id, d.title, d.body, d.created_at, d.template_id,
            d.seo_metadata,
            cp.name AS counterparty_name
       FROM content.drafts d
       LEFT JOIN content.counterparties cp ON cp.id = d.counterparty_id
      WHERE d.id = $1 AND d.content_type = 'contract'`,
    [draftId]
  );
  if (!draft.rows[0]) throw new Error(`Contract ${draftId} not found`);
  const row = draft.rows[0];

  // Latest signing request (null if contract never sent)
  const sigReq = await query(
    `SELECT id, document_hash, hash_version, signing_mode, status,
            expires_at, created_by, created_at
       FROM signatures.signature_requests
      WHERE draft_id = $1
      ORDER BY created_at DESC LIMIT 1`,
    [draftId]
  );
  const request = sigReq.rows[0] || null;

  let signers = [];
  let latestEvents = [];
  if (request) {
    const s = await query(
      `SELECT id, display_name, email, status, signing_order, completed_at
         FROM signatures.signers
        WHERE request_id = $1
        ORDER BY signing_order NULLS LAST, email`,
      [request.id]
    );
    signers = s.rows;

    // Latest event per signer for the audit block
    const e = await query(
      `SELECT DISTINCT ON (se.signer_id)
              se.signer_id, se.event_type, se.typed_name,
              encode(se.hash_chain_current, 'hex') AS hash_chain_current_hex,
              se.ip_address, se.created_at
         FROM signatures.signature_events se
        WHERE se.request_id = $1
        ORDER BY se.signer_id, se.created_at DESC`,
      [request.id]
    );
    latestEvents = e.rows;
  }

  // Resolve brand (draft → counterparty → default → hard fallback).
  const brand = await loadBrandProfileForDraft(draftId).catch((err) => {
    log.warn({ err: err.message }, 'brand profile lookup failed; using fallback');
    return null;
  });
  const profile = brand?.profile || fallbackBrand;
  const assets = brand?.assets || {};

  return { row, request, signers, latestEvents, profile, assets };
}
