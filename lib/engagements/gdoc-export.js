/**
 * Google Doc exporter — converts a spec's markdown to HTML, uploads via
 * Drive `files.create` with target mimeType `application/vnd.google-apps.document`,
 * and lets Drive auto-convert the HTML into a real Google Doc.
 *
 * Uses the existing service-account auth from autobot-inbox/src/drive/
 * service-auth.js with domain-wide delegation. The caller passes
 * `userEmail` to impersonate — the doc lands in that user's Drive.
 *
 * Scope required: drive.file (let the app create files; the user can
 * always see and own them via impersonation). Service account's
 * default scopes are read-only, so we override here.
 */

import { marked } from 'marked';
import { google } from 'googleapis';
import { hasServiceAccount } from '../../autobot-inbox/src/drive/service-auth.js';
import { readFileSync } from 'fs';
import { Readable } from 'stream';

const WRITE_SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
];

function loadServiceAccountKey() {
  const envKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (envKey) {
    try {
      return JSON.parse(envKey);
    } catch {
      /* fall through */
    }
  }
  const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH;
  if (keyPath) {
    try {
      return JSON.parse(readFileSync(keyPath, 'utf8'));
    } catch {
      /* fall through */
    }
  }
  return null;
}

/**
 * Build a Drive client with write scope (drive.file) impersonating userEmail.
 * Separate from service-auth.js getDriveClient because that helper hardcodes
 * read-only scopes — Drive write requires drive.file or drive.
 */
function getDriveWriteClient(userEmail) {
  const key = loadServiceAccountKey();
  if (!key) {
    throw new Error('No Google service account configured (GOOGLE_SERVICE_ACCOUNT_KEY)');
  }
  if (!userEmail) {
    throw new Error('userEmail is required to create a Google Doc (impersonation target)');
  }
  const auth = new google.auth.JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: WRITE_SCOPES,
    subject: userEmail,
  });
  return google.drive({ version: 'v3', auth });
}

/**
 * Convert markdown → minimal HTML suitable for Drive's HTML-to-Doc converter.
 * Drive accepts standard HTML; marked's default output works directly.
 */
function markdownToHtml(markdown, { title } = {}) {
  const body = marked.parse(markdown, { gfm: true, breaks: false });
  return `<!DOCTYPE html><html><head><meta charset="utf-8">${
    title ? `<title>${escapeHtml(title)}</title>` : ''
  }</head><body>${body}</body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

/**
 * Create a Google Doc from spec markdown.
 *
 * @returns {{ docId, url, name }} the new doc's id, webViewLink, and title
 */
export async function exportSpecToGoogleDoc({ markdown, title, userEmail, folderId }) {
  if (!hasServiceAccount()) {
    const err = new Error('Google service account is not configured on this server (set GOOGLE_SERVICE_ACCOUNT_KEY)');
    err.code = 'GOOGLE_NOT_CONFIGURED';
    err.statusCode = 503;
    throw err;
  }
  if (!userEmail) {
    const err = new Error('Sign-in user not detected — cannot impersonate to create a Google Doc');
    err.code = 'NO_USER_EMAIL';
    err.statusCode = 400;
    throw err;
  }

  const drive = getDriveWriteClient(userEmail);
  const html = markdownToHtml(markdown, { title });

  const requestBody = {
    name: title,
    mimeType: 'application/vnd.google-apps.document',
  };
  if (folderId) requestBody.parents = [folderId];

  let res;
  try {
    res = await drive.files.create({
      requestBody,
      media: {
        mimeType: 'text/html',
        body: Readable.from([Buffer.from(html, 'utf-8')]),
      },
      fields: 'id, name, webViewLink',
      supportsAllDrives: true,
    });
  } catch (err) {
    // Surface the common Google API failure modes as actionable errors so
    // the board UI's "Google Doc failed: …" toast tells the operator what
    // to do, rather than a bare 502.
    const status = err.response?.status || err.code || null;
    const gErrors = err.response?.data?.error?.errors || [];
    const gReason = gErrors[0]?.reason || err.response?.data?.error?.status || null;
    const detail = err.response?.data?.error?.message || err.message;
    let hint;
    if (status === 401) {
      hint =
        `Drive rejected the service-account JWT (401). Common causes: ` +
        `the JSON in GOOGLE_SERVICE_ACCOUNT_KEY is missing/expired, or ` +
        `domain-wide delegation has NOT been granted for "${userEmail}". ` +
        `In Workspace Admin → Security → API controls → Domain-wide ` +
        `Delegation, add the SA's client_id with scope ` +
        `https://www.googleapis.com/auth/drive.file.`;
    } else if (status === 403) {
      // Common reasons: unauthorized_client (DWD not granted), insufficientScopes
      // (DWD granted but missing drive.file), or storageQuotaExceeded.
      const reasonText = gReason ? ` (reason: ${gReason})` : '';
      hint =
        `Drive forbade the create${reasonText}. Most often this means ` +
        `domain-wide delegation isn't granted for the impersonated user ` +
        `(${userEmail}) or the SA's delegation entry is missing the ` +
        `drive.file scope. Grant ` +
        `https://www.googleapis.com/auth/drive.file in Workspace Admin → ` +
        `Security → API controls → Domain-wide Delegation, then retry.`;
    } else if (status === 404 && folderId) {
      hint =
        `Drive could not find folder ${folderId} (or the impersonated ` +
        `user can't see it). Pass a folder_id the user has access to, ` +
        `or omit it to drop the doc at their My Drive root.`;
    } else if (/invalid_grant|unauthorized_client/i.test(detail || '')) {
      hint =
        `Service-account token exchange failed (${detail}). The SA's ` +
        `client_id is likely not authorized for the requested scope on ` +
        `the target Workspace domain. Re-check DWD setup for ${userEmail}.`;
    } else {
      hint = `Drive upload failed: ${detail}`;
    }
    const wrapped = new Error(hint);
    wrapped.code = 'DRIVE_UPLOAD_FAILED';
    wrapped.statusCode = status || 502;
    wrapped.googleStatus = status;
    wrapped.googleReason = gReason;
    throw wrapped;
  }

  return {
    docId: res.data.id,
    name: res.data.name,
    url: res.data.webViewLink,
  };
}
