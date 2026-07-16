// lib/content/meeting-prefs.js — Feature 007: configurable D4 source precedence.
//
// The "primary" transcript/summary a meeting surfaces is picked by source
// precedence (D4). This module makes that ordering configurable per-org and
// per-user instead of the old hardcoded constant. Resolution, per meeting scope:
//   user override (owner_org_id, owner_id) → org default (owner_org_id, NULL)
//   → SYSTEM_DEFAULT.
//
// SERVER-INTERNAL for the write helpers' trust (ownerOrgId is stamped from the
// token at the HTTP edge, never the body — same rule as create-artifact.js).

import { query as defaultQuery, withTransaction } from '../db.js';

// The meeting transcript/summary source_system values that can be ranked. Other
// source_systems (web, optimus, …) never produce meeting transcripts, so they
// are not offerable; an unranked source sorts LAST in the re-pick (array_position
// → NULL → NULLS LAST). 'drive' = Gemini Notes on Drive; 'mcp' = manual upload.
export const MEETING_SOURCE_KINDS = Object.freeze(['drive', 'tldv', 'mcp']);

// The factory default when no org/user pref is set: Gemini Notes (curated summary
// + action items) > TL;DV (raw verbatim) > manual. Keep in sync with the spec D4.
export const SYSTEM_DEFAULT_PRECEDENCE = Object.freeze(['drive', 'tldv', 'mcp']);

// Sentinel the unique scope index folds NULL owner_id to (migration 161).
const ORG_SHARED_SENTINEL = '00000000-0000-0000-0000-000000000000';

// Re-pick cap per save so a runaway org never blocks the request; we LOG when we
// hit it rather than silently leaving stale primaries.
const RECOMPUTE_CAP = 2000;

/**
 * Validate a submitted precedence array. Returns the cleaned array or throws.
 * Rules: non-empty array of strings, each in MEETING_SOURCE_KINDS, no dupes.
 * A SUBSET is allowed (omitted sources just sort last) — but no unknown kinds.
 */
export function validatePrecedence(input) {
  if (!Array.isArray(input) || input.length === 0) {
    throw Object.assign(new Error('precedence must be a non-empty array of source kinds'), { statusCode: 400 });
  }
  const seen = new Set();
  for (const raw of input) {
    const s = String(raw || '').toLowerCase().trim();
    if (!MEETING_SOURCE_KINDS.includes(s)) {
      throw Object.assign(new Error(`unknown meeting source "${raw}" (allowed: ${MEETING_SOURCE_KINDS.join(', ')})`), { statusCode: 400 });
    }
    if (seen.has(s)) {
      throw Object.assign(new Error(`duplicate source "${s}" in precedence`), { statusCode: 400 });
    }
    seen.add(s);
  }
  return [...seen];
}

/**
 * Resolve the effective precedence for a SCOPE (used by the GET surface and by
 * the per-meeting re-pick). One query: of the (user row, org-default row) that
 * match, prefer the user row (owner_id non-null sorts first). Falls back to the
 * system default when neither exists.
 *
 * @param {Function} queryFn
 * @param {string} ownerOrgId
 * @param {string|null} ownerId  - null → resolve the org-default chain only
 * @returns {Promise<{precedence: string[], source: 'user'|'org'|'system'}>}
 */
export async function resolveSourcePrecedence(queryFn, ownerOrgId, ownerId = null) {
  if (!ownerOrgId) return { precedence: [...SYSTEM_DEFAULT_PRECEDENCE], source: 'system' };
  const res = await queryFn(
    `SELECT precedence, owner_id
       FROM content.meeting_source_prefs
      WHERE owner_org_id = $1
        AND (owner_id = $2::uuid OR owner_id IS NULL)
      ORDER BY owner_id NULLS LAST
      LIMIT 1`,
    [ownerOrgId, ownerId]
  );
  const row = res.rows[0];
  if (!row) return { precedence: [...SYSTEM_DEFAULT_PRECEDENCE], source: 'system' };
  const precedence = Array.isArray(row.precedence) ? row.precedence : JSON.parse(row.precedence);
  return { precedence, source: row.owner_id ? 'user' : 'org' };
}

/**
 * Read all three layers for the GET surface so the UI can show what is effective
 * and what is overriding what.
 */
export async function getPrecedenceLayers(queryFn, ownerOrgId, ownerId) {
  const res = await queryFn(
    `SELECT owner_id, precedence FROM content.meeting_source_prefs
      WHERE owner_org_id = $1 AND (owner_id = $2::uuid OR owner_id IS NULL)`,
    [ownerOrgId, ownerId]
  );
  const parse = (p) => (Array.isArray(p) ? p : JSON.parse(p));
  const orgRow = res.rows.find((r) => !r.owner_id);
  const userRow = res.rows.find((r) => String(r.owner_id) === String(ownerId));
  const org = orgRow ? parse(orgRow.precedence) : null;
  const user = userRow ? parse(userRow.precedence) : null;
  return {
    system_default: [...SYSTEM_DEFAULT_PRECEDENCE],
    org,                                   // null when unset
    user,                                  // null when unset
    effective: user || org || [...SYSTEM_DEFAULT_PRECEDENCE],
    source_kinds: [...MEETING_SOURCE_KINDS],
  };
}

/**
 * Upsert or clear a precedence row, then re-pick primaries across the affected
 * scope so the change is immediately reflected. TRUSTED ownerOrgId/ownerId.
 *
 * @param {object} params
 * @param {string} params.ownerOrgId
 * @param {string|null} params.ownerId  - null = the org default
 * @param {string[]|null} params.precedence - null clears the row (revert to the
 *   next level in the chain)
 * @param {string|null} params.updatedBy
 * @param {Function} [params.recomputeFn] - injectable per-meeting re-pick (tests)
 * @returns {Promise<{ok: boolean, precedence: string[]|null, recomputed: number}>}
 */
export async function setSourcePrecedence({ ownerOrgId, ownerId = null, precedence, updatedBy = null, recomputeFn } = {}) {
  if (!ownerOrgId) throw Object.assign(new Error('ownerOrgId is required (no silent default)'), { statusCode: 400 });
  const cleaned = precedence == null ? null : validatePrecedence(precedence);

  await withTransaction(async (client) => {
    if (cleaned == null) {
      await client.query(
        `DELETE FROM content.meeting_source_prefs
          WHERE owner_org_id = $1
            AND COALESCE(owner_id, '${ORG_SHARED_SENTINEL}'::uuid) = COALESCE($2::uuid, '${ORG_SHARED_SENTINEL}'::uuid)`,
        [ownerOrgId, ownerId]
      );
    } else {
      await client.query(
        `INSERT INTO content.meeting_source_prefs (owner_org_id, owner_id, precedence, updated_by)
         VALUES ($1, $2, $3::jsonb, $4)
         ON CONFLICT (owner_org_id, COALESCE(owner_id, '${ORG_SHARED_SENTINEL}'::uuid))
           DO UPDATE SET precedence = EXCLUDED.precedence, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [ownerOrgId, ownerId, JSON.stringify(cleaned), updatedBy]
      );
    }
  });

  const recomputed = await recomputePrimariesForScope({ ownerOrgId, ownerId, recomputeFn });
  return { ok: true, precedence: cleaned, recomputed };
}

/**
 * Re-pick primaries for every active meeting a precedence change could affect.
 * - org change (ownerId null): every active meeting in the org (each re-resolves
 *   its OWN effective precedence, so users with their own override keep it).
 * - user change (ownerId set): that user's active personal meetings only.
 *
 * Each meeting re-pick is the same recomputePrimariesTx the write path uses, so
 * resolution stays identical. Bounded by RECOMPUTE_CAP (logged, not silent).
 *
 * @returns {Promise<number>} meetings re-picked
 */
export async function recomputePrimariesForScope({ ownerOrgId, ownerId = null, recomputeFn, queryFn = defaultQuery } = {}) {
  const recompute = recomputeFn
    || (async (client, meetingId) => {
        const { recomputePrimariesTx } = await import('./meetings.js');
        return recomputePrimariesTx(client, meetingId);
      });

  const sel = ownerId
    ? await queryFn(
        `SELECT id FROM content.meetings
          WHERE owner_org_id = $1 AND owner_id = $2::uuid AND status = 'active'
          ORDER BY updated_at DESC LIMIT $3`,
        [ownerOrgId, ownerId, RECOMPUTE_CAP + 1])
    : await queryFn(
        `SELECT id FROM content.meetings
          WHERE owner_org_id = $1 AND status = 'active'
          ORDER BY updated_at DESC LIMIT $2`,
        [ownerOrgId, RECOMPUTE_CAP + 1]);

  const ids = sel.rows.map((r) => r.id);
  if (ids.length > RECOMPUTE_CAP) {
    console.warn(`[meeting-prefs] precedence change for org ${ownerOrgId}${ownerId ? `/user ${ownerId}` : ''} affects > ${RECOMPUTE_CAP} meetings; re-picking the ${RECOMPUTE_CAP} most-recent now — older meetings re-pick on their next write.`);
    ids.length = RECOMPUTE_CAP;
  }

  let n = 0;
  for (const id of ids) {
    try {
      await withTransaction((client) => recompute(client, id));
      n++;
    } catch (err) {
      console.warn(`[meeting-prefs] re-pick failed for meeting ${id}: ${err.message}`);
    }
  }
  return n;
}
