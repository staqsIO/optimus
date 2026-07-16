/**
 * BoldSign E-Signature Adapter
 *
 * Handles document sending, status tracking, and signed document retrieval
 * via the BoldSign REST API. Used by the contract engine to send proposals
 * for e-signature after board approval.
 *
 * Auth: API Key via X-API-KEY header.
 * Env: BOLDSIGN_API_KEY (required), BOLDSIGN_BASE_URL (optional, defaults to production).
 *
 * Docs: https://www.boldsign.com/docs/
 */

import { createChildLogger } from '../logger.js';

const log = createChildLogger({ module: 'boldsign' });

const BASE_URL = process.env.BOLDSIGN_BASE_URL || 'https://api.boldsign.com';
const API_KEY = process.env.BOLDSIGN_API_KEY;

function getHeaders() {
  if (!API_KEY) throw new Error('BOLDSIGN_API_KEY not set');
  return { 'X-API-KEY': API_KEY };
}

/**
 * Send a document for e-signature.
 *
 * @param {Buffer} pdfBuffer - PDF file content
 * @param {Object} opts
 * @param {string} opts.title - Document title
 * @param {string} opts.message - Message to signers
 * @param {Array<{name: string, email: string, role: string}>} opts.signers - Signer list
 * @param {boolean} [opts.useTextTags=true] - Auto-detect text tags in document
 * @param {number} [opts.expiryDays=30] - Days until document expires
 * @returns {Promise<{documentId: string}>}
 */
export async function sendDocument(pdfBuffer, opts) {
  const { title, message, signers, useTextTags = true, expiryDays = 30 } = opts;

  const formData = new FormData();
  formData.append('Title', title);
  formData.append('Message', message || `Please review and sign: ${title}`);
  formData.append('EnableSigningOrder', 'false');
  formData.append('UseTextTags', String(useTextTags));
  formData.append('ExpiryDays', String(expiryDays));

  // Add signers
  signers.forEach((signer, i) => {
    formData.append(`Signers[${i}][Name]`, signer.name);
    formData.append(`Signers[${i}][EmailAddress]`, signer.email);
    formData.append(`Signers[${i}][SignerType]`, 'Signer');
  });

  // Add PDF file
  const blob = new Blob([pdfBuffer], { type: 'application/pdf' });
  formData.append('Files', blob, `${title.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`);

  const res = await fetch(`${BASE_URL}/v1/document/send`, {
    method: 'POST',
    headers: getHeaders(),
    body: formData,
  });

  if (!res.ok) {
    const text = await res.text();
    log.error({ status: res.status, body: text }, 'BoldSign send failed');
    throw new Error(`BoldSign send failed ${res.status}: ${text}`);
  }

  const data = await res.json();
  log.info({ documentId: data.documentId, title }, 'Document sent for signature');
  return { documentId: data.documentId };
}

/**
 * Get document status.
 *
 * @param {string} documentId
 * @returns {Promise<{status: string, signers: Array}>}
 */
export async function getDocumentStatus(documentId) {
  const res = await fetch(`${BASE_URL}/v1/document/properties?documentId=${documentId}`, {
    headers: getHeaders(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`BoldSign status failed ${res.status}: ${text}`);
  }

  const data = await res.json();
  return {
    status: data.status,
    signers: data.signerDetails || [],
    createdDate: data.createdDate,
    expiryDate: data.expiryDate,
  };
}

/**
 * Download the signed/completed document.
 *
 * @param {string} documentId
 * @returns {Promise<Buffer>} PDF buffer
 */
export async function downloadDocument(documentId) {
  const res = await fetch(`${BASE_URL}/v1/document/download?documentId=${documentId}`, {
    headers: getHeaders(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`BoldSign download failed ${res.status}: ${text}`);
  }

  return Buffer.from(await res.arrayBuffer());
}

/**
 * Check if BoldSign is configured.
 * @returns {boolean}
 */
export function isBoldSignConfigured() {
  return !!API_KEY;
}

/**
 * Process a BoldSign webhook event.
 *
 * @param {Object} event - Webhook payload
 * @returns {{eventType: string, documentId: string, data: Object}}
 */
export function parseWebhookEvent(event) {
  return {
    eventType: event.event?.eventType || event.eventType || 'unknown',
    documentId: event.event?.documentId || event.documentId,
    data: event,
  };
}
