/**
 * E-Signature API Routes
 *
 * Board-authenticated: create, list, revoke, download
 * Public: render signing page data, submit signature
 */

import { query, withBoardScope } from '../db.js';
import { withSystemScope } from '../../../lib/db.js';

export function registerSigningRoutes(routes) {
  // POST /api/signatures/create — create a signing request
  routes.set('POST /api/signatures/create', async (req, body) => {
    const { createSigningRequest } = await import('../../../lib/signatures/index.js');

    const { draftId, signers, message, expiresInHours, signingMode } = body || {};
    if (!draftId || !signers?.length) {
      const err = new Error('draftId and signers[] are required');
      err.statusCode = 400;
      throw err;
    }

    // Get draft title
    // OPT-166 P3-B5: this route's tier is org-shared / AUTHED_ANY with NO
    // requireBoard guard — any authenticated principal (agent / customer-MCP /
    // nemoclaw JWT) passes the identity gate and gets a 200 today. withBoardScope
    // throws for role !== 'board', so wrap the content.drafts read conditionally:
    // only board principals get a scoped session; everyone else keeps the legacy
    // pool (INERT pre-flip; post-flip the unscoped read fails closed via RLS
    // rather than turning today's 200 into a 500).
    const boardScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
    const scopedQuery = boardScope ?? query;
    let draft;
    try {
      draft = await scopedQuery(`SELECT title FROM content.drafts WHERE id = $1`, [draftId]);
    } finally {
      if (boardScope) await boardScope.release();
    }
    if (!draft.rows[0]) {
      const err = new Error('Draft not found');
      err.statusCode = 404;
      throw err;
    }

    const boardUser = req.headers['x-board-user'] || 'unknown';

    const result = await createSigningRequest({
      draftId,
      title: draft.rows[0].title,
      message: message || `Please review and sign: ${draft.rows[0].title}`,
      signers: signers.map(s => ({ name: s.name, email: s.email, order: s.order })),
      createdBy: boardUser,
      expiresInHours: expiresInHours || 72,
      signingMode: signingMode || 'parallel',
    });

    return result;
  });

  // GET /api/signatures — list signing requests
  routes.set('GET /api/signatures', async (req) => {
    const { listRequests } = await import('../../../lib/signatures/index.js');
    const url = new URL(req.url, 'http://localhost');
    const status = url.searchParams.get('status');
    const draftId = url.searchParams.get('draftId');

    const requests = await listRequests({ status, draftId });
    return { requests };
  });

  // GET /api/signatures/:id — get signing request details
  routes.set('GET /api/signatures/:id', async (req) => {
    const { getRequest } = await import('../../../lib/signatures/index.js');
    const parts = new URL(req.url, 'http://localhost').pathname.split('/');
    const id = parts[parts.length - 1];

    const request = await getRequest(id);
    if (!request) {
      const err = new Error('Signing request not found');
      err.statusCode = 404;
      throw err;
    }

    return { request };
  });

  // POST /api/signatures/:id/revoke — revoke a pending request
  routes.set('POST /api/signatures/:id/revoke', async (req, body) => {
    const { revokeRequest } = await import('../../../lib/signatures/index.js');
    const parts = new URL(req.url, 'http://localhost').pathname.split('/');
    const id = parts[parts.length - 2];

    await revokeRequest(id, body?.reason || 'Revoked by board member');
    return { ok: true };
  });

  // GET /api/sign/:token — get signing page data (PUBLIC)
  routes.set('GET /api/sign/:token', async (req) => {
    const { validateToken, recordView } = await import('../../../lib/signatures/index.js');
    const parts = new URL(req.url, 'http://localhost').pathname.split('/');
    const token = parts[parts.length - 1];

    const result = await validateToken(token);
    if (!result.valid) {
      return { error: result.error, valid: false };
    }

    // Record view event
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
    const ua = req.headers['user-agent'] || 'unknown';
    await recordView(token, ip, ua).catch(() => {}); // non-fatal

    // Load attachments (metadata only — content streamed via separate download route)
    const { query } = await import('../db.js');
    const attResult = await query(
      `SELECT id, filename, mime_type, size_bytes, created_at
       FROM content.contract_attachments
       WHERE draft_id = $1
       ORDER BY created_at ASC`,
      [result.signer.draft_id]
    ).catch(() => ({ rows: [] }));

    // Cohort: every signer on this request, ordered, redacted to first
    // initial + last initial of email so the signer can see "where they are"
    // without leaking colleagues' full identities. We expose
    // signing_order + status to drive the multi-signer step indicator.
    let cohort = [];
    let signingMode = null;
    try {
      const reqRow = await query(
        `SELECT signing_mode FROM signatures.signature_requests WHERE id = $1`,
        [result.signer.request_id]
      );
      signingMode = reqRow.rows[0]?.signing_mode || null;

      const cohortRows = await query(
        `SELECT id, display_name, email, status, signing_order, completed_at
           FROM signatures.signers
          WHERE request_id = $1
          ORDER BY signing_order NULLS LAST, email ASC`,
        [result.signer.request_id]
      );
      const redact = (name, email) => {
        if (name && name.trim()) {
          // First name only, plus last initial when available.
          const parts = name.trim().split(/\s+/);
          if (parts.length === 1) return parts[0];
          return `${parts[0]} ${parts[parts.length - 1][0]}.`;
        }
        // Fallback: domain of the email so the signer at least knows who side they're on.
        const at = email.indexOf('@');
        return at > 0 ? `someone @ ${email.slice(at + 1)}` : email;
      };
      cohort = cohortRows.rows.map((s) => ({
        id: s.id,
        is_self: s.id === result.signer.id,
        display: s.id === result.signer.id ? (s.display_name || 'You') : redact(s.display_name, s.email),
        status: s.status,
        signing_order: s.signing_order,
        completed_at: s.completed_at,
      }));
    } catch { /* non-fatal — falling back to no step indicator */ }

    return {
      valid: true,
      title: result.signer.title,
      message: result.signer.message,
      signerName: result.signer.display_name,
      signerEmail: result.signer.email,
      expiresAt: result.signer.expires_at,
      documentBody: result.document.body,
      documentTitle: result.document.title,
      attachments: attResult.rows,
      signingMode,
      cohort,
    };
  });

  // GET /api/sign/:token/attachments/:attId/download — PUBLIC download via signing token
  // Token is re-validated on each request; only attachments for the matched draft are served.
  routes.set('GET /api/sign/:token/attachments/:attId/download', async (req) => {
    const { validateToken } = await import('../../../lib/signatures/index.js');
    const parts = new URL(req.url, 'http://localhost').pathname.split('/');
    // URL: /api/sign/:token/attachments/:attId/download
    const token = parts[3];
    const attId = parts[5];

    const validation = await validateToken(token);
    if (!validation.valid) {
      const err = new Error(validation.error || 'Invalid token');
      err.statusCode = 403;
      throw err;
    }

    const { query } = await import('../db.js');
    const result = await query(
      `SELECT filename, mime_type, content
       FROM content.contract_attachments
       WHERE id = $1 AND draft_id = $2`,
      [attId, validation.signer.draft_id]
    );

    if (!result.rows[0]) {
      const err = new Error('Attachment not found');
      err.statusCode = 404;
      throw err;
    }

    const row = result.rows[0];
    return {
      __raw_response: true,
      status: 200,
      headers: {
        'Content-Type': row.mime_type,
        'Content-Disposition': `attachment; filename="${row.filename.replace(/"/g, '\\"')}"`,
        'Cache-Control': 'private, max-age=300',
      },
      body: row.content,
    };
  });

  // POST /api/sign/:token — submit signature (PUBLIC)
  routes.set('POST /api/sign/:token', async (req, body) => {
    const { executeSign, executeDecline } = await import('../../../lib/signatures/index.js');
    const parts = new URL(req.url, 'http://localhost').pathname.split('/');
    const token = parts[parts.length - 1];

    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
    const ua = req.headers['user-agent'] || 'unknown';

    if (body?.action === 'decline') {
      return executeDecline({ token, ip, userAgent: ua, reason: body.reason });
    }

    if (!body?.typedName) {
      return { success: false, error: 'typedName is required' };
    }

    return executeSign({
      token,
      typedName: body.typedName,
      ip,
      userAgent: ua,
    });
  });

  // POST /api/sign/:token/proposals — signer submits a comment or redline
  // before signing. Does NOT change the signer's status — they can still
  // sign, decline, or wait for the board to resolve the proposal.
  routes.set('POST /api/sign/:token/proposals', async (req, body) => {
    const { getSignerByToken } = await import('../../../lib/signatures/index.js');
    const parts = new URL(req.url, 'http://localhost').pathname.split('/');
    const token = parts[parts.length - 2]; // /api/sign/:token/proposals

    const signer = await getSignerByToken(token);
    if (!signer) {
      const err = new Error('Invalid or expired signing link');
      err.statusCode = 404;
      throw err;
    }
    // Block proposals once the signer has acted — their ship has sailed.
    if (signer.status === 'signed' || signer.status === 'declined' || signer.status === 'expired') {
      const err = new Error(`Cannot submit proposals after ${signer.status}`);
      err.statusCode = 409;
      throw err;
    }
    if (signer.request_status === 'cancelled' || signer.request_status === 'completed' || signer.request_status === 'expired') {
      const err = new Error(`Signing request is ${signer.request_status}`);
      err.statusCode = 409;
      throw err;
    }

    const { proposal_type, quoted_text, proposed_text, note } = body || {};
    if (!['comment', 'redline'].includes(proposal_type)) {
      const err = new Error('proposal_type must be "comment" or "redline"');
      err.statusCode = 400;
      throw err;
    }
    if (proposal_type === 'redline') {
      if (!quoted_text || typeof proposed_text !== 'string') {
        const err = new Error('redline requires quoted_text and proposed_text');
        err.statusCode = 400;
        throw err;
      }
    }

    // Rate limit: cap each signer to 10 proposals per hour. Generous for
    // real negotiation (back-and-forth on several clauses), low enough to
    // catch a runaway script or misclick bomb.
    const recentCount = await query(
      `SELECT count(*)::int AS n
         FROM signatures.signer_proposals
        WHERE signer_id = $1 AND created_at > now() - INTERVAL '1 hour'`,
      [signer.id]
    );
    if (recentCount.rows[0].n >= 10) {
      const err = new Error('Too many proposals — please wait before submitting more.');
      err.statusCode = 429;
      throw err;
    }

    // Anchor to the current latest draft version so the board sees
    // exactly which body text the signer was looking at.
    // OPT-166 P3-B5: magic-link handler — no board/agent principal present,
    // so system-scope the content.draft_versions read (system role reads
    // everything post-flip per tenancy.is_system()).
    const verScope = await withSystemScope('signing-magic-link', { reason: 'signing-proposal-anchor' });
    let latestVer;
    try {
      latestVer = await verScope(
        `SELECT id FROM content.draft_versions
          WHERE draft_id = $1
          ORDER BY version_number DESC LIMIT 1`,
        [signer.draft_id]
      );
    } finally {
      await verScope.release();
    }

    const result = await query(
      `INSERT INTO signatures.signer_proposals
         (request_id, signer_id, draft_version_id, proposal_type,
          quoted_text, proposed_text, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, created_at`,
      [
        signer.request_id,
        signer.id,
        latestVer.rows[0]?.id || null,
        proposal_type,
        quoted_text || null,
        proposed_text ?? null,
        note || null,
      ]
    );

    return { ok: true, proposal_id: result.rows[0].id, created_at: result.rows[0].created_at };
  });

  // GET /api/sign/:token/proposals — list proposals raised BY this signer,
  // each with its reply thread, so the signer sees any board follow-ups.
  routes.set('GET /api/sign/:token/proposals', async (req) => {
    const { getSignerByToken } = await import('../../../lib/signatures/index.js');
    const parts = new URL(req.url, 'http://localhost').pathname.split('/');
    const token = parts[parts.length - 2];

    const signer = await getSignerByToken(token);
    if (!signer) {
      const err = new Error('Invalid or expired signing link');
      err.statusCode = 404;
      throw err;
    }

    const props = await query(
      `SELECT id, proposal_type, quoted_text, proposed_text, note,
              status, resolved_by, resolved_at, resolution_note,
              created_at
         FROM signatures.signer_proposals
        WHERE signer_id = $1
        ORDER BY created_at DESC`,
      [signer.id]
    );
    if (props.rows.length === 0) return { proposals: [] };

    const ids = props.rows.map(p => p.id);
    const replies = await query(
      `SELECT id, proposal_id, actor, actor_display, message, created_at
         FROM signatures.proposal_replies
        WHERE proposal_id = ANY($1::uuid[])
        ORDER BY created_at ASC`,
      [ids]
    );
    const grouped = {};
    for (const r of replies.rows) {
      (grouped[r.proposal_id] ||= []).push(r);
    }
    return {
      proposals: props.rows.map(p => ({ ...p, replies: grouped[p.id] || [] })),
    };
  });

  // POST /api/sign/:token/proposals/:proposalId/reply — signer posts a reply
  routes.set('POST /api/sign/:token/proposals/:proposalId/reply', async (req, body) => {
    const { getSignerByToken } = await import('../../../lib/signatures/index.js');
    const parts = new URL(req.url, 'http://localhost').pathname.split('/');
    // Path: /api/sign/:token/proposals/:proposalId/reply
    const token = parts[3];
    const proposalId = parts[5];

    const signer = await getSignerByToken(token);
    if (!signer) {
      const err = new Error('Invalid or expired signing link');
      err.statusCode = 404;
      throw err;
    }

    // Scope: proposal must belong to THIS signer
    const prop = await query(
      `SELECT p.id, p.signer_id, sr.title, sr.created_by
         FROM signatures.signer_proposals p
         JOIN signatures.signature_requests sr ON sr.id = p.request_id
        WHERE p.id = $1`,
      [proposalId]
    );
    if (!prop.rows[0]) {
      const err = new Error('Proposal not found');
      err.statusCode = 404;
      throw err;
    }
    if (prop.rows[0].signer_id !== signer.id) {
      const err = new Error('You can only reply to proposals you raised');
      err.statusCode = 403;
      throw err;
    }

    const message = String(body?.message || '').trim();
    if (!message) {
      const err = new Error('message is required');
      err.statusCode = 400;
      throw err;
    }
    if (message.length > 5000) {
      const err = new Error('message too long (max 5000 chars)');
      err.statusCode = 400;
      throw err;
    }

    // Rate limit: same shape as proposal rate limit — 10 replies / hour.
    const recentCount = await query(
      `SELECT count(*)::int AS n
         FROM signatures.proposal_replies
        WHERE actor = 'signer' AND actor_identity = $1
          AND created_at > now() - INTERVAL '1 hour'`,
      [signer.id]
    );
    if (recentCount.rows[0].n >= 10) {
      const err = new Error('Too many replies — please wait before sending more.');
      err.statusCode = 429;
      throw err;
    }

    const inserted = await query(
      `INSERT INTO signatures.proposal_replies
         (proposal_id, actor, actor_identity, actor_display, message)
       VALUES ($1, 'signer', $2, $3, $4)
       RETURNING id, created_at`,
      [proposalId, signer.id, signer.display_name, message]
    );

    // Email the board creator — lookup email via board_members
    try {
      const bmRow = await query(
        `SELECT email, display_name FROM agent_graph.board_members
          WHERE lower(github_username) = lower($1) LIMIT 1`,
        [prop.rows[0].created_by]
      );
      if (bmRow.rows[0]?.email) {
        const { sendProposalReplyEmail } = await import('../../../lib/signatures/notifier.js');
        sendProposalReplyEmail({
          recipientEmail: bmRow.rows[0].email,
          recipientName: bmRow.rows[0].display_name,
          documentTitle: prop.rows[0].title,
          authorLabel: signer.display_name,
          message,
          // No boardUrl for now — the board detail URL structure expects
          // the contract id, which we don't have cheaply here. The email
          // body still conveys the reply.
        }).catch(err => console.warn('[sign/reply] board email failed:', err.message));
      }
    } catch (err) {
      console.warn('[sign/reply] board email lookup failed:', err.message);
    }

    return { ok: true, reply_id: inserted.rows[0].id, created_at: inserted.rows[0].created_at };
  });
}
