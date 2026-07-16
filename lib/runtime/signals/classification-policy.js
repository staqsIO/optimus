/**
 * Q-tier → classification level policy (STAQPRO-311).
 *
 * Single source of truth for which classification tier each agent can
 * see when reading from RAG / wiki retrieval. Used by:
 *
 *   - lib/runtime/context-loader.js to pass the right maxLevel into
 *     retrieveContext() based on the calling agent's Q-tier
 *   - lib/rag/retriever.js to convert max-level filter into the SQL
 *     numeric ordinal (matched against content.{documents,chunks,
 *     wiki_pages}.classification_level — added by STAQPRO-310 /
 *     migration 108)
 *
 * The policy is intentionally conservative: even Q4 (architect tier)
 * cannot read RESTRICTED content. RESTRICTED is human-only by design
 * — ~/vault/Memory/ (MEMORY.md credentials topology), board personal
 * notes, anything legal/HR/financial that requires explicit human
 * approval to surface in any agent reasoning loop.
 *
 *   Q1 (executor-intake, executor-triage)         → 0 (PUBLIC only)
 *   Q2 (executor-responder, reviewer)             → 1 (PUBLIC, INTERNAL)
 *   Q3 (strategist)                               → 2 (+ CONFIDENTIAL)
 *   Q4 (architect)                                → 2 (RESTRICTED is human-only)
 *
 * Tier mapping comes from CONTEXT_TIERS in context-loader.js
 * (Q-tier-stratified context loading). If a new agent is added with a
 * tier not enumerated here, the function defaults to Q1 (most
 * restrictive) — deny by default per P1.
 *
 * Refs: STAQPRO-311 Phase 1, plan
 * ~/.claude/plans/let-me-pause-and-magical-codd.md, peer-reviewed by
 * Liotta + Linus + Neo Architect.
 */

export const CLASSIFICATION_LEVELS = Object.freeze({
  PUBLIC: 0,
  INTERNAL: 1,
  CONFIDENTIAL: 2,
  RESTRICTED: 3,
});

const TIER_MAX_LEVEL = Object.freeze({
  Q1: 0, // PUBLIC only — intake/triage handle external content; no need for internal context
  Q2: 1, // PUBLIC + INTERNAL — responder/reviewer, the bulk of draft work
  Q3: 2, // + CONFIDENTIAL   — strategist reasons over client/contract material
  Q4: 2, // + CONFIDENTIAL   — architect can see same as strategist; RESTRICTED is human-only
});

/**
 * Return the max classification level (0-3) an agent at the given
 * Q-tier may retrieve. Unknown tier → 0 (deny by default).
 *
 * @param {string} tier - 'Q1' | 'Q2' | 'Q3' | 'Q4'
 * @returns {number} ordinal 0-3 (0=PUBLIC, 3=RESTRICTED)
 */
export function maxLevelForTier(tier) {
  if (typeof tier === 'string' && Object.prototype.hasOwnProperty.call(TIER_MAX_LEVEL, tier)) {
    return TIER_MAX_LEVEL[tier];
  }
  return 0;
}

/**
 * Convenience: explicit policy lookup. Mostly for tests + callers that
 * want to introspect the full mapping rather than ask one tier at a time.
 */
export const TIER_POLICY = TIER_MAX_LEVEL;
