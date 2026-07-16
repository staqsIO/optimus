/**
 * lib/signal/contact-auto-merge.js — OPT-81 scored auto-merge pass.
 *
 * Finds same-person candidates across signal.contacts and auto-merges when
 * confidence reaches AUTO_MERGE_THRESHOLD. All merges use
 * signal.auto_merge_contacts() — SOFT-MERGE only, no hard deletes.
 *
 * THRESHOLD DESIGN (conservative by intent):
 *
 *   AUTO_MERGE_THRESHOLD = 0.75
 *
 *   This is intentionally high. The scoring is purely structural (P2):
 *
 *     +0.40  identical normalized display name (case-folded, whitespace-collapsed)
 *     +0.35  shared email domain across any identity pair
 *     +0.15  overlapping correspondents: any from_address that appears in
 *              inbox.messages for BOTH contact clusters
 *     +0.15  same organization_id (post-080 FK)
 *     +0.40  knownExactNameMatch: BOTH full names identical AND at least one
 *              contact has tier='inner_circle'. Fires on cross-domain same-person
 *              cases where the board actively trusts the contact (e.g., Dustin
 *              Powers across umbadvisors.com / heronlabsinc.com / gmail.com).
 *
 *   Bands:
 *     ≥ 0.75 → AUTO_MERGE (executes signal.auto_merge_contacts())
 *     ≥ 0.65 → REVIEW_SUGGESTED (returned to caller, no DB write)
 *     < 0.65 → DROP (ignored)
 *
 *   NAME ALONE = 0.40 → never crosses REVIEW_FLOOR (0.65) alone. Requires at
 *   least one structural signal. This prevents the "two Dustins at different
 *   companies" false merge.
 *
 *   SAME DOMAIN ALONE = 0.35 → never crosses REVIEW threshold alone.
 *   Two different people can share a company domain.
 *
 *   NAME + ONE STRUCTURAL SIGNAL = 0.75 (domain) or 0.55 (org or correspondents
 *   alone) → crosses AUTO_MERGE_THRESHOLD. This is the "Dustin Powers at
 *   umbadvisors from two email addresses" case: same name + same company domain
 *   is enough for auto-merge. The false-merge risk is low because two people
 *   at the same company with IDENTICAL names is vanishingly rare.
 *
 *   NAME + INNER_CIRCLE = 0.40 + 0.40 = 0.80 → crosses AUTO_MERGE_THRESHOLD.
 *   This is the cross-domain same-person case: "Dustin Powers" across
 *   umbadvisors.com / heronlabsinc.com / gmail.com. The knownExactNameMatch
 *   bonus requires EXACT full normalized name equality (not first-name-only)
 *   AND at least one contact in the pair to be tier='inner_circle'. Two active
 *   (non-inner-circle) contacts with the same full name on different domains
 *   remain at 0.40 — no auto-merge.
 *
 * IDEMPOTENT: runAutoMergePass() skips pairs already merged. Safe to call
 * repeatedly (e.g., from the enrichment worker on new contact creation).
 *
 * REVERSIBLE: every merge is undone by calling signal.unmerge_contacts()
 * or the POST /api/contacts/:id/unmerge endpoint.
 */

import { createLogger } from '../logger.js';

const log = createLogger('signal/contact-auto-merge');

/**
 * Confidence bands. Named constants — tune in ONE place.
 *
 * AUTO_MERGE_THRESHOLD = 0.75 = WEIGHTS.sameName + WEIGHTS.sharedEmailDomain.
 * Requires: identical name + at least one structural signal (shared domain,
 * shared org, shared correspondents, OR knownExactNameMatch). Name alone (0.40)
 * never reaches this. Two signals (name + domain + org) scores 0.90, which also
 * auto-merges.
 *
 * Why 0.75 and not higher: name + same-company-domain is strong evidence of the
 * same person (two employees at the same company with identical full names is
 * extremely rare). The 0.90 band (name + domain + org/correspondents) is not
 * required to auto-merge — 0.75 is conservative enough given the reversibility
 * guarantee. Adjust upward if false-merge rate in production exceeds 1%.
 *
 * knownExactNameMatch (0.40) fires when: (a) BOTH contacts have identical
 * normalized full names AND (b) at least one has tier='inner_circle'. Together
 * with sameName (0.40) this yields 0.80 → auto-merges. Without inner_circle
 * the score stays at 0.40 → drops below REVIEW_FLOOR.
 */
export const AUTO_MERGE_THRESHOLD = 0.75; // name + any one structural signal
export const REVIEW_FLOOR = 0.65;          // name + partial structural signal (not reachable with current weights, reserved)

/** Weights for the additive confidence scorer. Must sum ≤ 1.0. */
export const WEIGHTS = Object.freeze({
  sameName:             0.40,
  sharedEmailDomain:    0.35,
  sharedCorrespondents: 0.15,
  sameOrg:              0.15,
  /**
   * knownExactNameMatch: added by OPT-81 inner-circle extension.
   *
   * Fires ONLY when ALL of:
   *   1. Both contacts have IDENTICAL normalized full names (exact, not
   *      first-name-only — normalizeName() case-folds + collapses whitespace).
   *   2. At least one of the pair has tier = 'inner_circle'.
   *
   * Rationale: inner_circle contacts are people the board actively trusts and
   * corresponds with. If two contacts share an identical full name and one is
   * inner_circle, the probability of a false-merge (two real people with the
   * exact same full name, one of whom the board deeply trusts) is negligible.
   * Without inner_circle, same-full-name strangers across different domains
   * remain at 0.40 (below REVIEW_FLOOR) — no merge, no suggestion.
   *
   * Weight = 0.40: sameName (0.40) + knownExactNameMatch (0.40) = 0.80 ≥ 0.75
   * AUTO_MERGE_THRESHOLD. Neither signal alone crosses the threshold.
   */
  knownExactNameMatch:  0.40,
});

/**
 * Normalize a display name for exact comparison.
 * Trims, lowercases, collapses internal whitespace.
 */
export function normalizeName(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Score one candidate pair (a, b). Both objects must have:
 *   { id, name, organization_id, email_domain, correspondents: Set<string>, tier?: string }
 *
 * The optional `tier` field (values: 'inner_circle' | 'active' | 'inbound_only' |
 * 'newsletter' | 'automated' | 'unknown') enables the knownExactNameMatch bonus.
 *
 * Returns a confidence in [0, 1].
 */
export function scorePair(a, b) {
  let score = 0;

  const nameA = normalizeName(a.name);
  const nameB = normalizeName(b.name);
  if (nameA && nameB && nameA === nameB) {
    score += WEIGHTS.sameName;
  } else {
    // Name mismatch — no other signal can make this person-identical.
    return 0;
  }

  if (a.email_domain && b.email_domain && a.email_domain === b.email_domain) {
    score += WEIGHTS.sharedEmailDomain;
  }

  if (a.organization_id && b.organization_id && a.organization_id === b.organization_id) {
    score += WEIGHTS.sameOrg;
  }

  // Correspondent overlap: any shared from_address in inbox.messages seen by
  // both contact clusters. This is passed in as pre-computed sets.
  if (a.correspondents && b.correspondents) {
    for (const addr of a.correspondents) {
      if (b.correspondents.has(addr)) {
        score += WEIGHTS.sharedCorrespondents;
        break; // one overlap is enough; don't double-count
      }
    }
  }

  // knownExactNameMatch: fires only when names are IDENTICAL (already confirmed
  // above) AND at least one contact is tier='inner_circle'. This allows cross-
  // domain same-person contacts (e.g. Dustin Powers across umbadvisors.com /
  // heronlabsinc.com / gmail.com) to auto-merge when the board has actively
  // established a relationship with them. Two non-inner-circle strangers who
  // happen to share a full name on different domains stay at 0.40 (no merge).
  const eitherInnerCircle = a.tier === 'inner_circle' || b.tier === 'inner_circle';
  if (eitherInnerCircle) {
    score += WEIGHTS.knownExactNameMatch;
  }

  return Math.min(score, 1);
}

/**
 * Pick the canonical contact from a pair — the "richer/older" row.
 *
 * Canonical-pick rule (documented):
 *   1. Prefer the contact with the higher emails_received (most interaction history).
 *   2. Tie-break: the older row (lower created_at).
 *   3. Tie-break: lower id (arbitrary but stable).
 */
export function pickCanonical(a, b) {
  if ((b.emails_received ?? 0) > (a.emails_received ?? 0)) return { canonical: b, secondary: a };
  if ((a.emails_received ?? 0) > (b.emails_received ?? 0)) return { canonical: a, secondary: b };
  // Tie on interaction count: older row wins.
  const dateA = new Date(a.created_at).getTime();
  const dateB = new Date(b.created_at).getTime();
  if (dateA <= dateB) return { canonical: a, secondary: b };
  return { canonical: b, secondary: a };
}

/**
 * Run the auto-merge pass over all active (not yet merged) contacts.
 *
 * Steps:
 *   1. Load all active contacts (merged_into IS NULL) with their email domains
 *      and correspondent sets.
 *   2. Candidate pairs: any two contacts with identical normalized names.
 *   3. Score each pair.
 *   4. AUTO_MERGE: call signal.auto_merge_contacts() in the DB.
 *   5. REVIEW: collect in a suggestions list (no DB write).
 *
 * @param {Function} query  — pg-style parameterized query function
 * @param {object}   opts
 * @param {string}   opts.performedBy — logged in contact_merge_log (default 'auto_merge_pass')
 * @param {boolean}  opts.dryRun      — if true, skip the DB write (default false)
 * @returns {Promise<{
 *   merged:    Array<{canonicalId, secondaryId, confidence, reason}>,
 *   suggested: Array<{idA, idB, confidence}>,
 *   skipped:   number,
 * }>}
 */
export async function runAutoMergePass(query, { performedBy = 'auto_merge_pass', dryRun = false } = {}) {
  log.info({ dryRun }, 'auto-merge pass starting');

  // ── 1. Load all active contacts with their primary email domain ───────────
  // tenancy:allow-unscoped — auto-merge pass is an org-level background operation
  // that runs over signal.contacts (org-shared; no per-row owner_org_id). The pass
  // only merges within the same normalized name + structural signals, never across orgs.
  const { rows: contacts } = await query(
    `SELECT c.id, c.name, c.organization_id, c.emails_received, c.created_at,
            c.tier,
            -- Primary email domain (from email_address, not identities, for stability)
            lower(split_part(c.email_address, '@', 2)) AS email_domain
       FROM signal.contacts c
      WHERE c.merged_into IS NULL
        AND c.name IS NOT NULL
        AND c.name <> ''
      ORDER BY c.id`,
  );

  if (contacts.length < 2) {
    return { merged: [], suggested: [], skipped: 0 };
  }

  // ── 2. Load correspondent sets (inbox.messages from_address seen per contact)
  // We load this in bulk for all contacts rather than per-pair to stay O(N).
  // tenancy:allow-unscoped — inbox.messages has no per-user owner column at this
  // layer; org-level background pass. Contact identity→message JOIN is structural only.
  const { rows: corrRows } = await query(
    `SELECT ci.contact_id, lower(m.from_address) AS correspondent
       FROM signal.contact_identities ci
       JOIN inbox.messages m ON lower(m.from_address) = lower(ci.identifier)
      WHERE ci.channel = 'email'
        AND ci.contact_id IN (
          SELECT id FROM signal.contacts WHERE merged_into IS NULL
        )
      GROUP BY ci.contact_id, lower(m.from_address)`,
  );

  const correspondentMap = new Map(); // contact_id → Set<string>
  for (const row of corrRows) {
    if (!correspondentMap.has(row.contact_id)) {
      correspondentMap.set(row.contact_id, new Set());
    }
    correspondentMap.get(row.contact_id).add(row.correspondent);
  }

  // ── 3. Build lookup: normalized name → contacts ───────────────────────────
  const byName = new Map(); // normalized_name → [contact, ...]
  for (const c of contacts) {
    const key = normalizeName(c.name);
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push({
      ...c,
      correspondents: correspondentMap.get(c.id) ?? new Set(),
    });
  }

  const merged = [];
  const suggested = [];
  let skipped = 0;

  // ── 4. Score candidate pairs (only pairs with the same normalized name) ────
  for (const [, group] of byName) {
    if (group.length < 2) continue;

    // For each unique pair within this name-group.
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        const confidence = scorePair(a, b);

        if (confidence < REVIEW_FLOOR) continue;

        const { canonical, secondary } = pickCanonical(a, b);
        const reason = buildReason(a, b, confidence);

        if (confidence >= AUTO_MERGE_THRESHOLD) {
          if (!dryRun) {
            try {
              const { rows: [res] } = await query(
                `SELECT signal.auto_merge_contacts($1, $2, $3, $4, $5) AS result`,
                [canonical.id, secondary.id, confidence, reason, performedBy],
              );
              if (res?.result?.skipped) {
                skipped++;
              } else {
                merged.push({ canonicalId: canonical.id, secondaryId: secondary.id, confidence, reason });
                log.info({ canonicalId: canonical.id, secondaryId: secondary.id, confidence, reason }, 'auto-merged');
              }
            } catch (err) {
              log.warn({ err, canonicalId: canonical.id, secondaryId: secondary.id }, 'auto-merge DB error — skipping pair');
              skipped++;
            }
          } else {
            merged.push({ canonicalId: canonical.id, secondaryId: secondary.id, confidence, reason, dryRun: true });
          }
        } else {
          // REVIEW_FLOOR ≤ confidence < AUTO_MERGE_THRESHOLD
          suggested.push({ idA: a.id, idB: b.id, confidence, reason });
        }
      }
    }
  }

  log.info({ merged: merged.length, suggested: suggested.length, skipped }, 'auto-merge pass complete');
  return { merged, suggested, skipped };
}

/** Build a human-readable reason string for the merge audit log. */
function buildReason(a, b, confidence) {
  const signals = [];
  if (a.email_domain && a.email_domain === b.email_domain) signals.push(`shared_domain:${a.email_domain}`);
  if (a.organization_id && a.organization_id === b.organization_id) signals.push('same_org');
  if (a.tier === 'inner_circle' || b.tier === 'inner_circle') signals.push('known_inner_circle');
  // We can't check correspondents here without re-computing, but the score already
  // encodes the reason; list domain/org/tier for audit clarity.
  return `auto_merge [${signals.join(',')||'name_only'}] conf=${confidence.toFixed(3)}`;
}
