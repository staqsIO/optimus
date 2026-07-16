/**
 * Definition-of-Ready contract for human-authored work requests (Hub Wedge B).
 *
 * The thesis: non-technical team members contribute at outcome + acceptance-criteria
 * altitude. The criteria they write ARE the contract the governed agent teams are
 * graded against — simultaneously the request, the spec, the test oracle, and the
 * provenance anchor. Code stays in the terminal; this is the on-ramp around it.
 *
 * P1 (deny by default): a request is rejected unless it carries a real outcome,
 *   >= MIN_CRITERIA checkable acceptance criteria, and >= 1 explicit out-of-scope item.
 * P2 (infrastructure enforces): this runs at the intake route, never as a prompt.
 *   "I want a thing" is non-submittable by validation, not by an agent's good manners.
 *
 * Pure module — no DB, no imports — so it is trivially unit-testable and reusable at
 * both the create boundary (raw input) and the approve boundary (stored contract).
 */

export const MIN_CRITERIA = 3;
export const MAX_CRITERIA = 7;
export const MIN_CRITERION_LEN = 10;
// Upper bounds — availability guard so a giant string can't be parked in Postgres.
export const MAX_TITLE_LEN = 200;
export const MAX_OUTCOME_LEN = 2000;
export const MAX_CRITERION_LEN = 500;
export const MAX_SCOPE_LEN = 500;
export const MIN_OUTCOME_LEN = 10;

// A criterion that is pure vibes — rejected when the WHOLE criterion is just this.
// Not an exhaustive NLP check; a deliberate, cheap guard against the most common
// non-checkable submissions ("make it nice", "should be fast").
const VAGUE_ONLY =
  /^(it should be |should be |make it |i want it )?(easy|nice|good|great|better|fast|clean|simple|intuitive|user[- ]friendly|modern|polished|seamless|cool|pretty|slick)\.?$/i;

function asTrimmedStrings(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter(Boolean);
}

/**
 * Validate raw authoring input from the intake surface.
 *
 * @param {Object} input
 * @param {string} input.title
 * @param {string} input.outcome - what should be true when this is done (the author's words)
 * @param {string[]} input.acceptanceCriteria - 3-7 concrete pass/fail conditions
 * @param {string[]} input.outOfScope - >= 1 explicit non-goal
 * @param {string} [input.pattern] - confirmed existing pattern, or "new" (anti architecture-invention)
 * @returns {{ ok: true, normalized: Object } | { ok: false, errors: string[] }}
 */
export function validateAuthoredRequest(input = {}) {
  const errors = [];
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  const outcome = typeof input.outcome === 'string' ? input.outcome.trim() : '';
  const criteria = asTrimmedStrings(input.acceptanceCriteria);
  const outOfScope = asTrimmedStrings(input.outOfScope);
  const pattern = typeof input.pattern === 'string' ? input.pattern.trim() : '';

  if (title.length < 3) {
    errors.push('title is required (min 3 chars)');
  } else if (title.length > MAX_TITLE_LEN) {
    errors.push(`title is too long (max ${MAX_TITLE_LEN} chars)`);
  }
  if (outcome.length < MIN_OUTCOME_LEN) {
    errors.push(
      `outcome statement is required (min ${MIN_OUTCOME_LEN} chars) — describe what should be true when this is done`
    );
  } else if (outcome.length > MAX_OUTCOME_LEN) {
    errors.push(`outcome is too long (max ${MAX_OUTCOME_LEN} chars)`);
  }

  if (criteria.length < MIN_CRITERIA) {
    errors.push(
      `at least ${MIN_CRITERIA} acceptance criteria required (got ${criteria.length}) — each a binary pass/fail check`
    );
  }
  if (criteria.length > MAX_CRITERIA) {
    errors.push(
      `at most ${MAX_CRITERIA} acceptance criteria (got ${criteria.length}) — split this into separate requests`
    );
  }
  criteria.forEach((c, i) => {
    if (c.length < MIN_CRITERION_LEN) {
      errors.push(`criterion ${i + 1} is too short — state a concrete, observable pass/fail condition`);
    } else if (c.length > MAX_CRITERION_LEN) {
      errors.push(`criterion ${i + 1} is too long (max ${MAX_CRITERION_LEN} chars)`);
    } else if (VAGUE_ONLY.test(c)) {
      errors.push(`criterion ${i + 1} ("${c}") is not checkable — state a binary, observable condition`);
    }
  });

  if (outOfScope.length < 1) {
    errors.push('at least one explicit out-of-scope item required — name something this is NOT');
  } else if (outOfScope.some((s) => s.length > MAX_SCOPE_LEN)) {
    errors.push(`each out-of-scope item must be under ${MAX_SCOPE_LEN} chars`);
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    normalized: { title, outcome, criteria, outOfScope, pattern: pattern || null },
  };
}

/**
 * Build the acceptance_criteria JSONB contract stored on the work_item.
 * The author's words ARE the contract. `result` per criterion starts null and is
 * marked pass/fail later (at the review transition) — that is the reconciliation.
 *
 * @param {Object} normalized - output of validateAuthoredRequest().normalized
 * @param {string} authoredBy - the authoring identity (lower-cased sub)
 * @param {string} [authoredAt] - ISO timestamp (injected for determinism in tests)
 */
export function buildContract(normalized, authoredBy, authoredAt = new Date().toISOString()) {
  return {
    outcome: normalized.outcome,
    criteria: normalized.criteria.map((text) => ({ text, result: null })),
    out_of_scope: normalized.outOfScope,
    authored_by: authoredBy,
    pattern: normalized.pattern,
    authored_at: authoredAt,
  };
}

/**
 * Defense-in-depth: confirm a stored acceptance_criteria JSONB is a complete
 * human-authored contract. Used at the approve -> work_item boundary so a
 * criteria-less or tampered intent cannot become governed work even if it
 * somehow reached the approval queue. Agent-originated intents (no contract)
 * are out of scope here — the caller only invokes this for human-authored work.
 *
 * @param {*} ac - the stored acceptance_criteria value (parsed JSONB)
 * @returns {boolean}
 */
export function isCompleteContract(ac) {
  if (!ac || typeof ac !== 'object' || Array.isArray(ac)) return false;
  if (typeof ac.outcome !== 'string' || ac.outcome.trim().length < MIN_OUTCOME_LEN) return false;
  if (!Array.isArray(ac.criteria) || ac.criteria.length < MIN_CRITERIA) return false;
  if (ac.criteria.length > MAX_CRITERIA) return false;
  const everyCriterionValid = ac.criteria.every(
    (c) => c && typeof c.text === 'string' && c.text.trim().length >= MIN_CRITERION_LEN
  );
  if (!everyCriterionValid) return false;
  if (!Array.isArray(ac.out_of_scope) || ac.out_of_scope.length < 1) return false;
  return true;
}

export const CRITERION_RESULTS = ['pass', 'fail', null];

/**
 * Reconciliation (Hub Wedge C): the work delivered against what the author asked.
 * A contract is reconciled when every authored criterion is marked `pass` — i.e.
 * the board verified the outcome the non-dev described actually holds. This is the
 * metric anchor: "non-dev-authored work_items whose criteria reconcile".
 *
 * @param {*} ac - the stored acceptance_criteria value (parsed JSONB)
 * @returns {boolean}
 */
export function criteriaReconciled(ac) {
  if (!isCompleteContract(ac)) return false;
  return ac.criteria.every((c) => c.result === 'pass');
}
