/**
 * Artifact entity resolver (OPT-93, Feature 004 item 2).
 *
 * Deterministic, boring (P4) confidence scorer that maps an extracted entity
 * mention (person/org) to an existing Optimus entity — a `signal.contacts`
 * row, a `signal.organizations` row, an `agent_graph.projects` row, or an
 * `engagements.engagements` row — scoped to the ARTIFACT's org.
 *
 * No ML. A weighted additive score over signals the spec fixed (004 "Confidence
 * (deterministic, no ML)"):
 *
 *   exact email match (signal.contacts.email_address) ...... +0.70
 *   normalized-name exact match ............................ +0.25
 *   pg_trgm name similarity >= 0.6 ......................... +0.15
 *   org / domain agreement ................................. +0.10
 *   entity already linked to a project/engagement the
 *     artifact also links .................................. +0.10
 *   (score clamped to [0,1])
 *
 * Banding (D3 — auto-link high confidence, queue the ambiguous tail):
 *   >= 0.85  -> auto-link   (artifact_entity_links.link_status='auto')
 *   0.55..0.85 -> pending   (the board review queue / partial index)
 *   <  0.55  -> drop        (no row written)
 *
 * New-email person (a person mention carrying an email NOT in contacts) ->
 * INSERT signal.contacts owner-stamped with the artifact org, then auto-link.
 * A person/org NAME-ONLY trigram match landing in the pending band is a merge
 * SUGGESTION, never a silent insert or merge.
 *
 * TENANCY (the load-bearing invariant): every candidate query is scoped to the
 * artifact's owner_org_id, and every write (link, new contact) is stamped with
 * that SAME org — never the worker's or a request's. A Staqs artifact can
 * therefore never match nor write a UMB contact. signal.organizations has no
 * owner_org_id column, so org candidates are scoped indirectly: an org is only a
 * candidate if a contact within the artifact's org references it.
 *
 * Parameterized SQL only. No cross-schema FK (links carry entity_type+entity_id
 * TEXT with app-layer integrity, matching sql/154).
 */

import crypto from 'crypto';
import { createLogger } from '../../logger.js';

const log = createLogger('runtime/artifact-entity-resolver');

// Confidence weights — the spec's fixed constants. Centralised so the day-one
// auto-link-precision SLO (Liotta risk 1) can tune ONE place against data.
export const WEIGHTS = Object.freeze({
  exactEmail: 0.70,
  exactName: 0.25,
  trigramName: 0.15,
  orgDomain: 0.10,
  sharedContext: 0.10,
});

export const TRIGRAM_FLOOR = 0.6;       // pg_trgm similarity below this scores 0
export const AUTO_LINK_THRESHOLD = 0.85; // >= -> auto
export const PENDING_FLOOR = 0.55;       // [floor, auto) -> pending; below -> drop

/** Lowercase + collapse internal whitespace for name-exact comparison. */
export function normalizeName(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Extract a bare email address from a mention string, or null. */
export function extractEmail(s) {
  const m = String(s || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return m ? m[0].toLowerCase() : null;
}

/** The domain of an email, or null. */
function emailDomain(email) {
  if (!email) return null;
  const at = email.lastIndexOf('@');
  return at >= 0 ? email.slice(at + 1).toLowerCase() : null;
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/** Stable provenance hash for a derived fact (idempotent re-enrichment). */
export function provenanceHash({ entityType, entityId, fact, documentId }) {
  return crypto
    .createHash('sha256')
    .update(`${entityType}|${entityId}|${fact}|${documentId || ''}`)
    .digest('hex');
}

/**
 * Resolve ONE extracted entity to candidates and pick the best, all scoped to
 * `ownerOrgId`. Returns { decision, score, entityType, entityId, mention } or
 * { decision:'insert_contact', ... } for a new-email person, or
 * { decision:'drop' }.
 *
 * @param {object} o
 * @param {Function} o.query           pg-style query fn
 * @param {string}   o.ownerOrgId      the artifact's org (tenancy boundary)
 * @param {{type:string,value:string,snippet?:string}} o.entity  extracted mention
 * @param {Set<string>} [o.artifactProjectIds]     project ids the artifact links
 * @param {Set<string>} [o.artifactEngagementIds]  engagement ids the artifact links
 * @returns {Promise<object>}
 */
export async function resolveEntity({
  query,
  ownerOrgId,
  entity,
  artifactProjectIds = new Set(),
  artifactEngagementIds = new Set(),
}) {
  const type = String(entity?.type || '').toLowerCase();
  const mention = String(entity?.value || '').trim();
  if (!mention) return { decision: 'drop', reason: 'empty_mention' };

  // person | org are the v1 entity classes the worker asks the extractor for.
  // Anything else (date/amount/url/etc.) is not a linkable entity → drop.
  if (type === 'person' || type === 'people' || type === 'contact') {
    return resolvePerson({ query, ownerOrgId, mention, entity });
  }
  if (type === 'org' || type === 'organization' || type === 'company') {
    return resolveOrg({ query, ownerOrgId, mention });
  }
  return { decision: 'drop', reason: `unlinkable_type:${type}` };
}

async function resolvePerson({ query, ownerOrgId, mention, entity }) {
  const email = extractEmail(mention) || extractEmail(entity?.snippet) || null;
  const nameNorm = normalizeName(mention.replace(/<[^>]*>/g, ' ')); // strip "<email>"

  // ── 1. Exact email match (the unique identity key). Scoped to the org. ──
  if (email) {
    const r = await query(
      `SELECT id, name, organization, owner_org_id
         FROM signal.contacts
        WHERE lower(email_address) = $1
          AND owner_org_id = $2
        LIMIT 1`,
      [email, ownerOrgId],
    );
    if (r.rows.length > 0) {
      const c = r.rows[0];
      // A scoped exact-email match IS the identity key (email_address is org-wide
      // UNIQUE) — it auto-links on its own (Linus M1 / Liotta intent: "email-exact
      // alone clears 0.85"). An email-only mention must NOT be forced through the
      // human queue. The name bonus only reinforces (clamps to 1.0).
      let score = AUTO_LINK_THRESHOLD;
      if (nameNorm && normalizeName(c.name) === nameNorm) score += WEIGHTS.exactName;
      return finalize('contact', c.id, clamp01(score), mention);
    }
    // A person mention with a NEW email (not in contacts for this org) →
    // insert the contact owner-stamped, then auto-link. The insert path is the
    // ONLY place we mint a contact; a name-only match never does.
    return {
      decision: 'insert_contact',
      email,
      name: nameNorm ? mention.replace(/<[^>]*>/g, '').trim() : null,
      domain: emailDomain(email),
      mention,
    };
  }

  // ── 2. No email — name match only. Exact + trigram, scoped to org. ──
  if (!nameNorm) return { decision: 'drop', reason: 'no_email_no_name' };

  const r = await query(
    `SELECT id, name,
            similarity(name, $1) AS sim
       FROM signal.contacts
      WHERE owner_org_id = $2
        AND name IS NOT NULL
        AND (lower(name) = $3 OR similarity(name, $1) >= $4)
      ORDER BY sim DESC
      LIMIT 1`,
    [mention, ownerOrgId, nameNorm, TRIGRAM_FLOOR],
  );
  if (r.rows.length === 0) return { decision: 'drop', reason: 'no_name_match' };

  const c = r.rows[0];
  let score = 0;
  if (normalizeName(c.name) === nameNorm) score += WEIGHTS.exactName;
  if (Number(c.sim) >= TRIGRAM_FLOOR) score += WEIGHTS.trigramName;
  // Name-only match → ALWAYS a pending merge-suggestion, NEVER an auto-link and
  // never a silent merge (spec 004: "name-only trigram match → pending merge-
  // suggestion, never a silent merge"). The exact-email branch above is the ONLY
  // path to auto. nameOnly clamps the band to pending regardless of the additive
  // score, so a plausible name match always lands in the board review queue
  // rather than being dropped below the 0.55 floor.
  return finalize('contact', c.id, clamp01(score), mention, { nameOnly: true });
}

async function resolveOrg({ query, ownerOrgId, mention }) {
  const nameNorm = normalizeName(mention);
  if (!nameNorm) return { decision: 'drop', reason: 'empty_org' };

  // signal.organizations has no owner_org_id. Scope org candidates indirectly:
  // an org is only a candidate if a contact WITHIN the artifact's org references
  // it (by name/slug). This keeps a Staqs artifact from matching a UMB-only org.
  const r = await query(
    `SELECT o.id, o.name, o.slug,
            similarity(o.name, $1) AS sim
       FROM signal.organizations o
      WHERE (lower(o.name) = $2 OR o.slug = $2 OR similarity(o.name, $1) >= $3)
        AND EXISTS (
          SELECT 1 FROM signal.contacts c
           WHERE c.owner_org_id = $4
             AND c.organization IS NOT NULL
             AND (lower(c.organization) = lower(o.name)
                  OR lower(c.organization) = o.slug
                  OR similarity(c.organization, o.name) >= $3)
        )
      ORDER BY sim DESC
      LIMIT 1`,
    [mention, nameNorm, TRIGRAM_FLOOR, ownerOrgId],
  );
  if (r.rows.length === 0) return { decision: 'drop', reason: 'no_org_match' };

  const o = r.rows[0];
  let score = 0;
  if (normalizeName(o.name) === nameNorm || o.slug === nameNorm) score += WEIGHTS.exactName;
  if (Number(o.sim) >= TRIGRAM_FLOOR) score += WEIGHTS.trigramName;
  // Org agreement bonus: a name/slug exact is also an org/domain agreement
  // signal for the org class itself.
  if (normalizeName(o.name) === nameNorm) score += WEIGHTS.orgDomain;
  return finalize('org', o.id, clamp01(score), mention, { nameOnly: true });
}

/**
 * Map a clamped score to a banded decision (auto / pending / drop).
 *
 * `nameOnly` matches (no unique-email confirmation) are clamped to the PENDING
 * band: a genuine name match is always a review suggestion (never dropped below
 * the floor, never auto-linked) so the board adjudicates the merge. Only an
 * exact-email match (which does not set nameOnly) can reach the auto band.
 */
function finalize(entityType, entityId, score, mention, extra = {}) {
  let decision;
  if (extra.nameOnly) {
    decision = 'pending';
  } else if (score >= AUTO_LINK_THRESHOLD) {
    decision = 'auto';
  } else if (score >= PENDING_FLOOR) {
    decision = 'pending';
  } else {
    decision = 'drop';
  }
  return { decision, score, entityType, entityId, mention, ...extra };
}

/**
 * Persist resolver decisions for one artifact: link rows + derived facts + any
 * new contacts. ALL writes carry `ownerOrgId` (the artifact's org). Returns a
 * receipt-shaped summary { autoLinked, pending, dropped, contactsInserted,
 * facts }.
 *
 * Idempotent: links use ON CONFLICT (artifact_id, entity_type, entity_id) DO
 * NOTHING; facts use ON CONFLICT (owner_org_id, provenance_hash) DO NOTHING.
 *
 * @param {object} o
 * @param {Function} o.query
 * @param {string}   o.artifactId
 * @param {string}   o.documentId
 * @param {string}   o.ownerOrgId
 * @param {Array}    o.entities       extractor output [{type,value,snippet}]
 */
export async function applyResolution({ query, artifactId, documentId, ownerOrgId, entities }) {
  const summary = { autoLinked: 0, pending: 0, dropped: 0, contactsInserted: 0, facts: 0 };
  if (!Array.isArray(entities) || entities.length === 0) return summary;

  // Load the artifact's existing project/engagement links once, so the
  // "shared context" bonus can be applied without an N+1 per entity.
  const ctx = await loadArtifactContext(query, artifactId);

  for (const entity of entities) {
    let res;
    try {
      res = await resolveEntity({
        query,
        ownerOrgId,
        entity,
        artifactProjectIds: ctx.projectIds,
        artifactEngagementIds: ctx.engagementIds,
      });
    } catch (err) {
      log.warn(`resolve failed for mention "${entity?.value}": ${err.message}`);
      summary.dropped++;
      continue;
    }

    // New-email person → insert contact (owner-stamped), then auto-link it.
    if (res.decision === 'insert_contact') {
      const contactId = await insertContact({ query, ownerOrgId, email: res.email, name: res.name });
      if (!contactId) { summary.dropped++; continue; }
      summary.contactsInserted++;
      await writeLink({ query, artifactId, ownerOrgId, entityType: 'contact', entityId: contactId, confidence: WEIGHTS.exactEmail, status: 'auto' });
      summary.autoLinked++;
      await writeFact({ query, artifactId, documentId, ownerOrgId, entityType: 'contact', entityId: contactId, fact: factText(entity), confidence: WEIGHTS.exactEmail, summary });
      continue;
    }

    if (res.decision === 'drop') { summary.dropped++; continue; }

    const status = res.decision; // 'auto' | 'pending'
    await writeLink({ query, artifactId, ownerOrgId, entityType: res.entityType, entityId: res.entityId, confidence: res.score, status });
    if (status === 'auto') summary.autoLinked++; else summary.pending++;

    // Derived facts are written for confident (auto) links only — a pending
    // link is an unresolved suggestion, not a durable fact yet.
    if (status === 'auto') {
      await writeFact({ query, artifactId, documentId, ownerOrgId, entityType: res.entityType, entityId: res.entityId, fact: factText(entity), confidence: res.score, summary });
    }
  }
  return summary;
}

function factText(entity) {
  const snippet = (entity?.snippet && String(entity.snippet).trim()) || '';
  const value = String(entity?.value || '').trim();
  return snippet || value;
}

async function loadArtifactContext(query, artifactId) {
  const projectIds = new Set();
  const engagementIds = new Set();
  try {
    const r = await query(
      `SELECT entity_type, entity_id
         FROM content.artifact_entity_links
        WHERE artifact_id = $1
          AND link_status IN ('auto','confirmed')`,
      [artifactId],
    );
    for (const row of r.rows) {
      if (row.entity_type === 'project') projectIds.add(row.entity_id);
      if (row.entity_type === 'engagement') engagementIds.add(row.entity_id);
    }
  } catch (err) {
    log.warn(`loadArtifactContext failed: ${err.message}`);
  }
  return { projectIds, engagementIds };
}

async function insertContact({ query, ownerOrgId, email, name }) {
  try {
    // email_address is UNIQUE org-wide; ON CONFLICT covers a concurrent insert
    // race (two workers, same new email). RETURNING on conflict needs the
    // DO UPDATE no-op so we always get the id back.
    const r = await query(
      `INSERT INTO signal.contacts (email_address, name, owner_org_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (email_address) DO UPDATE SET email_address = EXCLUDED.email_address
       RETURNING id, owner_org_id`,
      [email, name || null, ownerOrgId],
    );
    const row = r.rows[0];
    // Defensive tenancy guard: if the conflict resolved to a contact owned by a
    // DIFFERENT org (email exists cross-org), do NOT link it under this org.
    if (row && row.owner_org_id && row.owner_org_id !== ownerOrgId) {
      log.warn(`contact ${email} exists under a different org; not linking cross-tenant`);
      return null;
    }
    return row?.id || null;
  } catch (err) {
    log.warn(`insertContact failed for ${email}: ${err.message}`);
    return null;
  }
}

async function writeLink({ query, artifactId, ownerOrgId, entityType, entityId, confidence, status }) {
  await query(
    `INSERT INTO content.artifact_entity_links
       (artifact_id, entity_type, entity_id, confidence, link_status, owner_org_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (artifact_id, entity_type, entity_id) DO NOTHING`,
    [artifactId, entityType, entityId, Number(confidence).toFixed(3), status, ownerOrgId],
  );
}

async function writeFact({ query, artifactId, documentId, ownerOrgId, entityType, entityId, fact, confidence, summary }) {
  const text = (fact && String(fact).trim()) || '';
  if (!text) return;
  const hash = provenanceHash({ entityType, entityId, fact: text, documentId });
  const r = await query(
    `INSERT INTO content.derived_facts
       (entity_type, entity_id, fact, artifact_id, document_id, span, confidence, provenance_hash, owner_org_id)
     VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, $8)
     ON CONFLICT (owner_org_id, provenance_hash) DO NOTHING
     RETURNING id`,
    [entityType, entityId, text, artifactId, documentId || null, Number(confidence).toFixed(3), hash, ownerOrgId],
  );
  if (r.rows.length > 0 && summary) summary.facts++;
}
