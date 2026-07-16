/**
 * Relevance gate for promoting meeting signals to inbox.human_tasks.
 *
 * PRD: autobot-inbox/docs/internal/prds/meeting-actions-to-kanban.md §4
 *
 *   "The single highest-leverage piece of this PRD. Cheap to get wrong,
 *    expensive in board-attention if we promote 30 vendor action items per
 *    week."
 *
 * Pure function. Caller passes a normalized context object; receives back
 * a {score, signals, matched} triple that the caller logs *with the
 * promote/skip decision* (so every Skip / Not-for-me click can be replayed
 * to retune the weights).
 *
 * Default weights match PRD §4:
 *
 *   obligor matches a known person  : 0.5
 *   speaker is a known person       : 0.2
 *   domain matches an active project: 0.2
 *   LLM tiebreak "is this ours?"    : 0.1
 *
 * Thresholds (PRD §4):
 *
 *   score >= 0.6  → auto-promote (status='inbox')
 *   0.3..0.6      → propose      (status='proposed' + "Is this ours?" UI)
 *   < 0.3         → skip         (logged on signal, no human_tasks row)
 */

export const RELEVANCE_AUTO_THRESHOLD = 0.6;
export const RELEVANCE_PROPOSE_THRESHOLD = 0.3;

export const WEIGHTS = Object.freeze({
  obligor: 0.5,
  speaker: 0.2,
  domain: 0.2,
  llm: 0.1,
});

function clamp01(x) {
  if (typeof x !== 'number' || Number.isNaN(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/**
 * Strict alias match. Each known person carries their own list of accepted
 * aliases (first name, full name, github handle). Case-insensitive equality
 * against that list — no token-substring or last-name lifts. Those would
 * collide on common surnames ("Gang"→Eric, "Pro"→StaqsPro Team Lead).
 *
 * Callers seed the aliases. Adding a new short form is a config change,
 * not a fuzzy-match rule change.
 */
function aliasMatch(candidate, aliases) {
  if (!candidate) return false;
  const c = String(candidate).trim().toLowerCase();
  if (!c) return false;
  for (const a of aliases || []) {
    if (a == null) continue;
    const al = String(a).trim().toLowerCase();
    if (al && c === al) return true;
  }
  return false;
}

function findKnownPerson(name, knownPeople) {
  if (!name) return null;
  for (const person of knownPeople || []) {
    if (aliasMatch(name, person.aliases || [person.name || person.display_name])) {
      return person;
    }
  }
  return null;
}

/**
 * @typedef {Object} RelevanceContext
 * @property {string|null} obligor
 *   Display name of the person who took the action (e.g. "Eric to update X" → "Eric").
 * @property {string[]} speakers
 *   Display names of substantive participants in the meeting.
 * @property {Array<{id: string, display_name?: string, name?: string, aliases?: string[]}>} knownPeople
 *   Board members + tracked contacts.
 * @property {string} [domain]
 *   Signal domain ('general' | 'financial' | 'legal' | 'scheduling').
 * @property {Array<{id: string, name: string, domain?: string}>} [projects]
 *   Active Optimus projects.
 * @property {boolean|null} [llmRelevant]
 *   Optional LLM tiebreaker output. null = skipped.
 */

/**
 * @param {RelevanceContext} ctx
 * @returns {{ score: number, signals: object, matched: object }}
 */
export function scoreRelevance(ctx) {
  const obligorMatch = findKnownPerson(ctx.obligor, ctx.knownPeople);

  let speakerMatch = null;
  for (const sp of ctx.speakers || []) {
    const m = findKnownPerson(sp, ctx.knownPeople);
    if (m) {
      speakerMatch = m;
      break;
    }
  }

  // Domain matches an active project. Both sides must be explicit — a
  // project with no `domain` field never matches, so projects must opt in
  // to a domain band to influence the score. (Otherwise every project
  // silently matches 'general' signals, hiding obligor recalibrations.)
  let domainMatched = false;
  const signalDomain = ctx.domain;
  if (signalDomain && (ctx.projects || []).length > 0) {
    for (const p of ctx.projects) {
      if (p.domain && p.domain === signalDomain) {
        domainMatched = true;
        break;
      }
    }
  }

  const llmRelevant = ctx.llmRelevant === true;

  let score = 0;
  if (obligorMatch) score += WEIGHTS.obligor;
  if (speakerMatch) score += WEIGHTS.speaker;
  if (domainMatched) score += WEIGHTS.domain;
  if (llmRelevant) score += WEIGHTS.llm;

  return {
    score: clamp01(score),
    signals: {
      obligor_known: !!obligorMatch,
      speaker_known: !!speakerMatch,
      domain_matched: domainMatched,
      llm_relevant: ctx.llmRelevant === null ? null : llmRelevant,
    },
    matched: {
      obligor: obligorMatch?.id || null,
      speaker: speakerMatch?.id || null,
    },
  };
}

/**
 * Convert a numeric score to the three-way decision the promoter acts on.
 *
 * @param {number} score
 * @returns {{ decision: 'auto'|'propose'|'skip', column: 'inbox'|'proposed'|null, score: number }}
 */
export function decideFromScore(score) {
  const s = clamp01(score);
  if (s >= RELEVANCE_AUTO_THRESHOLD) {
    return { decision: 'auto', column: 'inbox', score: s };
  }
  if (s >= RELEVANCE_PROPOSE_THRESHOLD) {
    return { decision: 'propose', column: 'proposed', score: s };
  }
  return { decision: 'skip', column: null, score: s };
}

/**
 * Convenience: score + decide in one call.
 *
 * @param {RelevanceContext} ctx
 */
export function gate(ctx) {
  const r = scoreRelevance(ctx);
  const d = decideFromScore(r.score);
  return { ...d, signals: r.signals, matched: r.matched };
}
