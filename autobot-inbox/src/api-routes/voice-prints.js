/**
 * Voice prints — speaker enrollment and listing.
 *
 *   POST   /api/voice-prints/enroll  — upload an audio clip + contact id, run
 *                                      Picovoice Eagle profiler, and (if it
 *                                      reaches 100%) save the resulting profile
 *                                      bytes against the contact. Audio body
 *                                      is captured by parseBody on req.rawBody;
 *                                      contact metadata travels in the URL
 *                                      query string.
 *
 *   GET    /api/voice-prints         — list enrolled prints (no profile bytes
 *                                      in the response).
 *
 *   DELETE /api/voice-prints/:id     — drop one print.
 *
 * Eagle profile bytes are opaque vendor blobs (~10 KB each) — we hand them
 * back to the SDK at match time and never inspect their contents.
 */

import { query, withBoardScope } from '../db.js';
import { enroll, activeEngine } from '../../../lib/voice/embedder.js';
import { visibleClause, CURRENT_ORG_ID } from '../../../lib/tenancy/scope.js';

// pgvector wants a literal like '[0.1,0.2,...]' — no spaces, square brackets.
function vectorLiteral(float32) {
  return `[${Array.from(float32).map((x) => x.toFixed(7)).join(',')}]`;
}

function parseQS(req) {
  const url = new URL(req.url, 'http://localhost');
  return Object.fromEntries(url.searchParams.entries());
}

// STAQPRO-263/531 (OPT-166 P3-B2): signal.contacts is RLS-enforced (sql/190).
// Accepts a queryFn (scopedQuery from withBoardScope, or the bare pool query)
// so the caller controls whether this runs inside a scoped session.
async function ensureContactExists(queryFn, contactId) {
  const r = await queryFn(
    `SELECT id, name, owner_org_id FROM signal.contacts WHERE id = $1 LIMIT 1`,
    [contactId],
  );
  return r.rows[0] || null;
}

export function registerVoicePrintsRoutes(routes, { withViewer } = {}) {
  // STAQPRO-608: voice.voice_prints carries owner_org_id (migration 148), so
  // the list endpoint serves PER-ORG rows. Resolve the tenancy principal and
  // apply visibleClause(vp.owner_org_id) fail-closed (unresolved principal →
  // 'FALSE' → zero rows). withViewer is injected by api.js; when it is absent
  // (older callers / tests) the principal is null → visibleClause emits FALSE.
  // Mirrors the runs.js / projects.js pattern shipped last round.
  const resolvePrincipalFor = async (req) => {
    if (!withViewer) return null;
    try {
      return (await withViewer(req)).principal;
    } catch {
      return null;
    }
  };

  routes.set('POST /api/voice-prints/enroll', async (req, _body) => {
    const audio = req.rawBody;
    if (!audio || !audio.length) {
      throw Object.assign(new Error('audio body required'), { statusCode: 400 });
    }

    const qs = parseQS(req);
    const contactId = qs.contactId;
    if (!contactId) {
      throw Object.assign(new Error('contactId query param required'), { statusCode: 400 });
    }

    // OPT-166 P3-B6: split into three phases so a board scope is never held
    // across the enroll(audio) network call (Picovoice) — pinning a scope
    // across external I/O would hold one of the pooled prod connections for
    // the duration of that call. Phase 1 (lookup) and phase 3 (write) each
    // acquire and release their own scope; phase 2 (enroll) runs unscoped.

    // Phase 1: contact lookup.
    let contact;
    {
      const lookupScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
      const scopedQuery = lookupScope ?? query;
      try {
        contact = await ensureContactExists(scopedQuery, contactId);
      } finally {
        if (lookupScope) await lookupScope.release();
      }
    }
    if (!contact) {
      throw Object.assign(new Error(`contact ${contactId} not found`), { statusCode: 404 });
    }

    const displayName = String(qs.displayName || contact.name || 'Speaker').slice(0, 200);
    const enrolledBy = req.auth?.sub || qs.enrolledBy || null;

    // Phase 2: enrollment (external Picovoice call) — no DB scope held.
    let result;
    try {
      result = await enroll(audio);
    } catch (e) {
      throw Object.assign(new Error(`enrollment failed: ${e.message}`), { statusCode: 422 });
    }

    const engine = activeEngine();
    const isEagle = engine === 'eagle';
    const payload = isEagle ? result.profile : result.embedding;

    if (!payload) {
      // Not enough usable speech yet — tell the UI to keep recording.
      return {
        ok: false,
        contactId,
        percentage: result.percentage,
        sampleSeconds: result.sampleSeconds,
        message: 'Need more clean speech — try a longer or quieter recording.',
      };
    }

    const profileBuf = isEagle ? Buffer.from(payload) : null;
    const embeddingLiteral = isEagle ? null : vectorLiteral(payload);
    // Stamp the print's tenancy org so it is visible to its enroller. Without
    // this the row lands NULL and visibleClause (NULL = ANY(orgs) is never true)
    // hides it from every non-admin caller. Derive from the contact's org,
    // falling back to this install's home org (single-org default).
    const ownerOrgId = contact.owner_org_id || CURRENT_ORG_ID;

    // Phase 3: write — fresh scope, acquired only now.
    const writeScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
    const writeQuery = writeScope ?? query;
    try {
      const inserted = await writeQuery(
        `INSERT INTO voice.voice_prints
           (contact_id, display_name, profile, embedding, embedder,
            picovoice_version, sample_seconds, enrolled_by, owner_org_id)
         VALUES ($1, $2, $3, $4::vector, $5, $6, $7, $8, $9)
         ON CONFLICT (contact_id) DO UPDATE
           SET display_name = EXCLUDED.display_name,
               profile = EXCLUDED.profile,
               embedding = EXCLUDED.embedding,
               embedder = EXCLUDED.embedder,
               picovoice_version = EXCLUDED.picovoice_version,
               sample_seconds = EXCLUDED.sample_seconds,
               enrolled_at = now(),
               enrolled_by = EXCLUDED.enrolled_by,
               -- re-enrollment inherits the contact's current org (home-org
               -- fallback). Intentional: a contact moved between orgs re-homes
               -- its print. Inert in the current single-org install.
               owner_org_id = EXCLUDED.owner_org_id
         RETURNING id, contact_id, display_name, sample_seconds, enrolled_at, embedder`,
        [contactId, displayName, profileBuf, embeddingLiteral, engine,
         result.version, result.sampleSeconds, enrolledBy, ownerOrgId],
      );

      return {
        ok: true,
        voicePrint: inserted.rows[0],
        percentage: result.percentage,
      };
    } finally {
      if (writeScope) await writeScope.release();
    }
  });

  routes.set('GET /api/voice-prints', async (req) => {
    const principal = await resolvePrincipalFor(req);
    // Tenancy scope (fail-closed): vp.owner_org_id ∈ visible orgs. Legacy rows
    // (pre-mig-148, or whose contact was deleted before the backfill) may carry
    // NULL — COALESCE them to this install's home org so they read as the
    // single-org default rather than vanishing (NULL = ANY(orgs) is never true).
    // Mirrors lib/rag/retriever.js. Unresolved principal still → 'FALSE' → 0 rows.
    const v = visibleClause(principal, {
      ownerOrgCol: `COALESCE(vp.owner_org_id, '${CURRENT_ORG_ID}'::uuid)`,
      startIndex: 1,
    });
    const r = await query(
      `SELECT vp.id, vp.contact_id, vp.display_name, vp.embedder,
              vp.picovoice_version, vp.sample_seconds, vp.enrolled_at, vp.enrolled_by,
              c.name AS contact_name, c.email_address
         FROM voice.voice_prints vp
         LEFT JOIN signal.contacts c ON c.id = vp.contact_id
         WHERE ${v.sql}
         ORDER BY vp.enrolled_at DESC`,
      v.params,
    );
    return { voicePrints: r.rows };
  });

  routes.set('DELETE /api/voice-prints/:id', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const id = decodeURIComponent(url.pathname.split('/').pop() || '');
    if (!id) throw Object.assign(new Error('id required'), { statusCode: 400 });
    const r = await query(
      `DELETE FROM voice.voice_prints WHERE id = $1 RETURNING id`,
      [id],
    );
    if (r.rows.length === 0) {
      throw Object.assign(new Error('not found'), { statusCode: 404 });
    }
    return { ok: true, id: r.rows[0].id };
  });

  // ── Unenrolled (candidate) speakers ─────────────────────────────────
  // The speaker-resolver writes a row here whenever it hears a voice
  // that doesn't match any enrolled print. The board surfaces these so
  // the user can name them once; approval promotes the row into
  // voice_prints and the standard resolver matches them automatically
  // from then on.

  routes.set('GET /api/voice-prints/unenrolled', async () => {
    const r = await query(
      `SELECT id, occurrence_count, candidate_label, sample_utterance,
              first_heard_at, last_heard_at,
              array_length(source_memo_ids, 1) AS memo_count
         FROM voice.unenrolled_speakers
        ORDER BY occurrence_count DESC, last_heard_at DESC
        LIMIT 100`,
    );
    return { candidates: r.rows };
  });

  routes.set('POST /api/voice-prints/unenrolled/:id/approve', async (req, body) => {
    const url = new URL(req.url, 'http://localhost');
    const id = decodeURIComponent(
      url.pathname.split('/api/voice-prints/unenrolled/')[1]?.split('/approve')[0] || ''
    );
    if (!id) throw Object.assign(new Error('id required'), { statusCode: 400 });

    const contactId = body?.contact_id || body?.contactId;
    const displayName = body?.display_name || body?.displayName;
    if (!contactId || !displayName) {
      throw Object.assign(
        new Error('contact_id and display_name required'),
        { statusCode: 400 },
      );
    }

    // Atomic promote: read embedding, insert into voice_prints, delete
    // candidate row. Wrapped in a transaction so a partial failure leaves
    // both tables consistent.
    const { withTransaction } = await import('../db.js');
    const result = await withTransaction(async (client) => {
      const candidate = await client.query(
        `SELECT id, embedding, embedder
           FROM voice.unenrolled_speakers
          WHERE id = $1
          FOR UPDATE`,
        [id],
      );
      if (candidate.rows.length === 0) {
        throw Object.assign(new Error('candidate not found'), { statusCode: 404 });
      }
      const row = candidate.rows[0];

      const inserted = await client.query(
        `INSERT INTO voice.voice_prints
            (contact_id, display_name, embedder, embedding, sample_seconds, enrolled_by)
         VALUES ($1, $2, $3, $4::vector, NULL, 'board:approve-unenrolled')
         ON CONFLICT (contact_id) DO UPDATE
           SET display_name = EXCLUDED.display_name,
               embedding    = EXCLUDED.embedding,
               embedder     = EXCLUDED.embedder,
               enrolled_at  = now(),
               enrolled_by  = 'board:approve-unenrolled'
         RETURNING id, contact_id, display_name`,
        [contactId, displayName, row.embedder, row.embedding],
      );

      await client.query(
        `DELETE FROM voice.unenrolled_speakers WHERE id = $1`,
        [id],
      );

      return inserted.rows[0];
    });

    return { ok: true, voicePrint: result };
  });

  // Dismiss a candidate without enrolling — useful when a one-off voice
  // (a podcast guest, a random street voice in a memo) shouldn't be
  // tracked at all.
  routes.set('DELETE /api/voice-prints/unenrolled/:id', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const id = decodeURIComponent(
      url.pathname.split('/api/voice-prints/unenrolled/')[1] || ''
    );
    if (!id) throw Object.assign(new Error('id required'), { statusCode: 400 });
    const r = await query(
      `DELETE FROM voice.unenrolled_speakers WHERE id = $1 RETURNING id`,
      [id],
    );
    if (r.rows.length === 0) {
      throw Object.assign(new Error('not found'), { statusCode: 404 });
    }
    return { ok: true, id: r.rows[0].id };
  });
}
