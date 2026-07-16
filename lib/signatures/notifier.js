/**
 * Signing Notification — sends signing links via Resend.
 *
 * Uses Resend API (not Gmail) so it's not tied to any personal account.
 * Sends from signing@umbadvisors.com (or configurable SIGNING_FROM_EMAIL).
 *
 * Env: RESEND_API_KEY (required), SIGNING_FROM_EMAIL (optional, defaults to signing@umbadvisors.com)
 */

import { createChildLogger } from '../logger.js';

const log = createChildLogger({ module: 'signatures/notifier' });

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.SIGNING_FROM_EMAIL || 'signing@umbadvisors.com';
const FROM_NAME = process.env.SIGNING_FROM_NAME || 'UMB Advisors';

/**
 * Send a signing request email to a signer.
 *
 * @param {Object} opts
 * @param {string} opts.signerName - Recipient name
 * @param {string} opts.signerEmail - Recipient email
 * @param {string} opts.signingUrl - The signing link
 * @param {string} opts.documentTitle - Contract/proposal title
 * @param {string} [opts.message] - Custom message from sender
 * @param {string} [opts.senderName] - Who sent it (board member name)
 * @param {string} [opts.expiresAt] - When the link expires
 * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
 */
export async function sendSigningEmail(opts) {
  const { signerName, signerEmail, signingUrl, documentTitle, message, senderName, expiresAt } = opts;

  if (!RESEND_API_KEY) {
    log.warn('RESEND_API_KEY not set — skipping signing email');
    return { success: false, error: 'RESEND_API_KEY not configured' };
  }

  const expiryText = expiresAt
    ? `This link expires on ${new Date(expiresAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}.`
    : 'This link expires in 72 hours.';

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:40px 24px;">
    <!-- Header -->
    <div style="margin-bottom:32px;">
      <h2 style="color:#fafafa;font-size:18px;font-weight:600;margin:0 0 4px;">
        Document Ready for Signature
      </h2>
      <p style="color:#71717a;font-size:13px;margin:0;">
        ${senderName ? `${senderName} has` : 'UMB Advisors has'} sent you a document to review and sign.
      </p>
    </div>

    <!-- Document card -->
    <div style="background:#18181b;border:1px solid #27272a;border-radius:12px;padding:20px;margin-bottom:24px;">
      <p style="color:#a1a1aa;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;margin:0 0 8px;">
        Document
      </p>
      <p style="color:#fafafa;font-size:16px;font-weight:600;margin:0 0 12px;">
        ${escapeHtml(documentTitle)}
      </p>
      ${message ? `<p style="color:#a1a1aa;font-size:13px;margin:0 0 12px;line-height:1.5;">${escapeHtml(message)}</p>` : ''}
      <p style="color:#71717a;font-size:12px;margin:0;">
        Prepared for: ${escapeHtml(signerName)}
      </p>
    </div>

    <!-- CTA button -->
    <div style="text-align:center;margin-bottom:24px;">
      <a href="${signingUrl}" style="display:inline-block;background:#d97706;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;padding:12px 32px;border-radius:8px;">
        Review & Sign Document
      </a>
    </div>

    <!-- Expiry note -->
    <p style="color:#71717a;font-size:12px;text-align:center;margin:0 0 32px;">
      ${expiryText}
    </p>

    <!-- Footer -->
    <div style="border-top:1px solid #27272a;padding-top:20px;">
      <p style="color:#52525b;font-size:11px;margin:0 0 4px;">
        This document was sent via UMB Advisors' secure signing platform.
        Your electronic signature is legally binding under the ESIGN Act and UETA.
      </p>
      <p style="color:#52525b;font-size:11px;margin:0;">
        If you did not expect this email, please disregard it.
      </p>
    </div>
  </div>
</body>
</html>`.trim();

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `${FROM_NAME} <${FROM_EMAIL}>`,
        to: [signerEmail],
        subject: `Please sign: ${documentTitle}`,
        html,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      log.error({ status: res.status, body: text }, 'Resend API error');
      return { success: false, error: `Resend ${res.status}: ${text}` };
    }

    const data = await res.json();
    log.info({ messageId: data.id, to: signerEmail, title: documentTitle }, 'Signing email sent');
    return { success: true, messageId: data.id };
  } catch (err) {
    log.error({ err: err.message, to: signerEmail }, 'Failed to send signing email');
    return { success: false, error: err.message };
  }
}

/**
 * Send a reminder email to a signer who hasn't completed their signature.
 * Uses the same layout as sendSigningEmail but flags urgency and the
 * time-to-expiry prominently.
 */
export async function sendSigningReminder(opts) {
  const { signerName, signerEmail, signingUrl, documentTitle, senderName, expiresAt } = opts;

  if (!RESEND_API_KEY) {
    log.warn('RESEND_API_KEY not set — skipping reminder email');
    return { success: false, error: 'RESEND_API_KEY not configured' };
  }

  // Show the number of hours remaining; floor to 1 so we never say "0 hours".
  const hoursRemaining = expiresAt
    ? Math.max(1, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 3_600_000))
    : null;
  const urgencyText = hoursRemaining === null
    ? 'This signing link will expire soon.'
    : hoursRemaining <= 24
      ? `This signing link expires in ${hoursRemaining} hour${hoursRemaining === 1 ? '' : 's'}.`
      : `This signing link expires in about ${Math.round(hoursRemaining / 24)} day${Math.round(hoursRemaining / 24) === 1 ? '' : 's'}.`;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:40px 24px;">
    <div style="margin-bottom:32px;">
      <p style="color:#f59e0b;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;margin:0 0 6px;">
        Reminder
      </p>
      <h2 style="color:#fafafa;font-size:18px;font-weight:600;margin:0 0 4px;">
        Document still awaiting your signature
      </h2>
      <p style="color:#71717a;font-size:13px;margin:0;">
        ${senderName ? `${escapeHtml(senderName)} is` : 'UMB Advisors is'} waiting on your signature.
      </p>
    </div>

    <div style="background:#18181b;border:1px solid #27272a;border-radius:12px;padding:20px;margin-bottom:24px;">
      <p style="color:#a1a1aa;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;margin:0 0 8px;">
        Document
      </p>
      <p style="color:#fafafa;font-size:16px;font-weight:600;margin:0 0 12px;">
        ${escapeHtml(documentTitle)}
      </p>
      <p style="color:#71717a;font-size:12px;margin:0;">
        Prepared for: ${escapeHtml(signerName)}
      </p>
    </div>

    <div style="text-align:center;margin-bottom:24px;">
      <a href="${signingUrl}" style="display:inline-block;background:#d97706;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;padding:12px 32px;border-radius:8px;">
        Review & Sign Document
      </a>
    </div>

    <p style="color:#f59e0b;font-size:12px;text-align:center;margin:0 0 32px;font-weight:500;">
      ${urgencyText}
    </p>

    <div style="border-top:1px solid #27272a;padding-top:20px;">
      <p style="color:#52525b;font-size:11px;margin:0;">
        If you no longer need to sign, you can ignore this email — the link will expire automatically.
      </p>
    </div>
  </div>
</body>
</html>`.trim();

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `${FROM_NAME} <${FROM_EMAIL}>`,
        to: [signerEmail],
        subject: `Reminder: please sign ${documentTitle}`,
        html,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      log.error({ status: res.status, body: text }, 'Resend API error on reminder');
      return { success: false, error: `Resend ${res.status}: ${text}` };
    }

    const data = await res.json();
    log.info({ messageId: data.id, to: signerEmail, title: documentTitle }, 'Reminder email sent');
    return { success: true, messageId: data.id };
  } catch (err) {
    log.error({ err: err.message, to: signerEmail }, 'Failed to send reminder email');
    return { success: false, error: err.message };
  }
}

/**
 * Send confirmation email after signing is complete.
 *
 * @param {Object} opts
 * @param {string} opts.signerName
 * @param {string} opts.signerEmail
 * @param {string} opts.documentTitle
 * @param {Date|string} [opts.signedAt]
 * @param {Buffer} [opts.pdfBuffer]      When provided, attached as a PDF.
 * @param {string} [opts.pdfFilename]    Defaults to a slugified title.
 */
export async function sendSignedConfirmation(opts) {
  const { signerName, signerEmail, documentTitle, signedAt, pdfBuffer, pdfFilename } = opts;

  if (!RESEND_API_KEY) return { success: false, error: 'RESEND_API_KEY not configured' };

  const attachmentNote = pdfBuffer
    ? 'A copy of the signed contract is attached to this email for your records.'
    : 'A copy of the signed document will be provided by UMB Advisors.';

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:40px 24px;">
    <div style="text-align:center;margin-bottom:24px;">
      <div style="width:48px;height:48px;margin:0 auto 12px;border-radius:50%;background:rgba(16,185,129,0.1);display:flex;align-items:center;justify-content:center;">
        <span style="color:#10b981;font-size:24px;">✓</span>
      </div>
      <h2 style="color:#fafafa;font-size:18px;font-weight:600;margin:0 0 4px;">Document Signed</h2>
      <p style="color:#71717a;font-size:13px;margin:0;">Your signature has been recorded.</p>
    </div>
    <div style="background:#18181b;border:1px solid #27272a;border-radius:12px;padding:20px;margin-bottom:24px;">
      <p style="color:#fafafa;font-size:15px;font-weight:600;margin:0 0 8px;">${escapeHtml(documentTitle)}</p>
      <p style="color:#a1a1aa;font-size:12px;margin:0;">
        Signed by ${escapeHtml(signerName)} on ${new Date(signedAt || Date.now()).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
      </p>
    </div>
    <p style="color:#52525b;font-size:11px;margin:0;">
      ${attachmentNote} This confirmation serves as your receipt of signing.
    </p>
  </div>
</body>
</html>`.trim();

  const payload = {
    from: `${FROM_NAME} <${FROM_EMAIL}>`,
    to: [signerEmail],
    subject: `Signed: ${documentTitle}`,
    html,
  };
  if (pdfBuffer) {
    payload.attachments = [{
      filename: pdfFilename || defaultPdfFilename(documentTitle),
      content: Buffer.isBuffer(pdfBuffer) ? pdfBuffer.toString('base64') : pdfBuffer,
    }];
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const text = await res.text();
      return { success: false, error: `Resend ${res.status}: ${text}` };
    }

    const data = await res.json();
    log.info({ messageId: data.id, to: signerEmail, withPdf: !!pdfBuffer }, 'Signed confirmation sent');
    return { success: true, messageId: data.id };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Send a "fully signed" notification to the board creator of a request.
 * Fires once per request when signature_requests.status transitions to
 * 'completed'. PDF is attached so the board has a single-email archive.
 *
 * @param {Object} opts
 * @param {string} opts.recipientEmail
 * @param {string} opts.documentTitle
 * @param {string} opts.counterpartyName
 * @param {string[]} opts.signerNames       Who signed, in order
 * @param {Buffer} [opts.pdfBuffer]
 * @param {string} [opts.pdfFilename]
 */
export async function sendRequestCompletedToBoard(opts) {
  const { recipientEmail, documentTitle, counterpartyName, signerNames, pdfBuffer, pdfFilename } = opts;

  if (!RESEND_API_KEY) return { success: false, error: 'RESEND_API_KEY not configured' };
  if (!recipientEmail) return { success: false, error: 'recipientEmail required' };

  const signerList = (signerNames || []).map(n => `<li style="margin:2px 0;">${escapeHtml(n)}</li>`).join('');
  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:40px 24px;">
    <div style="margin-bottom:24px;">
      <p style="color:#10b981;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;margin:0 0 6px;">
        Fully signed
      </p>
      <h2 style="color:#fafafa;font-size:18px;font-weight:600;margin:0 0 4px;">
        ${escapeHtml(documentTitle)}
      </h2>
      <p style="color:#71717a;font-size:13px;margin:0;">
        All signers have completed their signatures.
      </p>
    </div>
    <div style="background:#18181b;border:1px solid #27272a;border-radius:12px;padding:20px;margin-bottom:24px;">
      ${counterpartyName ? `<p style="color:#a1a1aa;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;margin:0 0 4px;">Counterparty</p>
      <p style="color:#fafafa;font-size:14px;font-weight:600;margin:0 0 12px;">${escapeHtml(counterpartyName)}</p>` : ''}
      <p style="color:#a1a1aa;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;margin:0 0 4px;">Signers</p>
      <ul style="color:#fafafa;font-size:13px;margin:0;padding-left:18px;">
        ${signerList || '<li style="color:#71717a;">(no signers recorded)</li>'}
      </ul>
    </div>
    <p style="color:#52525b;font-size:11px;margin:0;">
      ${pdfBuffer ? 'The signed contract with embedded audit trail is attached. ' : ''}Deliverables have been queued as work items in the task graph.
    </p>
  </div>
</body>
</html>`.trim();

  const payload = {
    from: `${FROM_NAME} <${FROM_EMAIL}>`,
    to: [recipientEmail],
    subject: `Fully signed: ${documentTitle}`,
    html,
  };
  if (pdfBuffer) {
    payload.attachments = [{
      filename: pdfFilename || defaultPdfFilename(documentTitle),
      content: Buffer.isBuffer(pdfBuffer) ? pdfBuffer.toString('base64') : pdfBuffer,
    }];
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text();
      return { success: false, error: `Resend ${res.status}: ${text}` };
    }
    const data = await res.json();
    log.info({ messageId: data.id, to: recipientEmail, withPdf: !!pdfBuffer }, 'Request-completed email sent to board');
    return { success: true, messageId: data.id };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Notify a party (signer or board) that a reply landed on a proposal
 * they're part of. Lightweight email — subject carries the contract
 * title and a short truncated preview lives in the body.
 */
export async function sendProposalReplyEmail(opts) {
  const {
    recipientEmail, recipientName,
    documentTitle,
    authorLabel,   // "Eric Gang (UMB)" or signer display name
    message,
    signingUrl,    // present when recipient is the signer
    boardUrl,      // present when recipient is the board
  } = opts;

  if (!RESEND_API_KEY) return { success: false, error: 'RESEND_API_KEY not configured' };
  if (!recipientEmail) return { success: false, error: 'recipientEmail required' };

  const preview = (message || '').length > 280
    ? `${message.slice(0, 280)}…`
    : message;
  const cta = signingUrl
    ? { href: signingUrl, label: 'Open signing page' }
    : boardUrl
      ? { href: boardUrl, label: 'Open contract' }
      : null;

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:40px 24px;">
    <div style="margin-bottom:24px;">
      <p style="color:#d97706;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;margin:0 0 6px;">
        New reply on your proposal
      </p>
      <h2 style="color:#fafafa;font-size:17px;font-weight:600;margin:0 0 4px;">
        ${escapeHtml(documentTitle)}
      </h2>
      <p style="color:#71717a;font-size:13px;margin:0;">
        ${escapeHtml(authorLabel || 'A party on this contract')} replied${recipientName ? ` to ${escapeHtml(recipientName)}` : ''}.
      </p>
    </div>
    <div style="background:#18181b;border:1px solid #27272a;border-radius:12px;padding:16px 18px;margin-bottom:24px;">
      <p style="color:#d4d4d8;font-size:13px;line-height:1.55;margin:0;white-space:pre-wrap;">${escapeHtml(preview)}</p>
    </div>
    ${cta ? `
    <div style="text-align:center;margin-bottom:24px;">
      <a href="${cta.href}" style="display:inline-block;background:#d97706;color:#ffffff;font-size:13px;font-weight:600;text-decoration:none;padding:10px 24px;border-radius:8px;">
        ${escapeHtml(cta.label)}
      </a>
    </div>` : ''}
    <p style="color:#52525b;font-size:11px;margin:0;">Reply on the contract to continue the thread.</p>
  </div>
</body>
</html>`.trim();

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `${FROM_NAME} <${FROM_EMAIL}>`,
        to: [recipientEmail],
        subject: `Re: ${documentTitle}`,
        html,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      return { success: false, error: `Resend ${res.status}: ${text}` };
    }
    const data = await res.json();
    log.info({ messageId: data.id, to: recipientEmail }, 'Proposal-reply email sent');
    return { success: true, messageId: data.id };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function defaultPdfFilename(documentTitle) {
  const slug = (documentTitle || 'contract')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 80) || 'contract';
  return `${slug}.pdf`;
}

function escapeHtml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
