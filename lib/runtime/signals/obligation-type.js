/**
 * Signal-type → obligation-type mapping (OPT-162 / ADR-020).
 *
 * SINGLE SOURCE OF TRUTH for translating an `inbox.signals.signal_type` into the
 * `agent_graph.work_items.obligation_type` domain. This mirrors — exactly — the
 * `CASE s.signal_type` backfill in
 *   autobot-inbox/sql/178-work-items-obligation-tenancy.sql
 * so the runtime stamp (Phase 2) can never drift from the migration backfill
 * (Phase 1). If you change one, change BOTH and update the static guard test in
 *   autobot-inbox/test/signal-action-bridge-live.test.js
 *
 * The target domain is constrained by the work_items.obligation_type CHECK added
 * in mig 178:
 *   'action' | 'request' | 'commitment' | 'deadline' | 'blocker' | 'decision_followup'
 * Any unknown/unmapped signal type maps to NULL ("this work_item is not an
 * obligation"), matching the migration's `ELSE NULL` branch.
 */

// Frozen so the mapping cannot be mutated at runtime. Keys/values are kept
// byte-for-byte identical to mig 178's CASE arms.
export const OBLIGATION_TYPE_BY_SIGNAL = Object.freeze({
  action: 'action',
  action_item: 'action',
  request: 'request',
  commitment: 'commitment',
  deadline: 'deadline',
  approval_needed: 'decision_followup',
  decision_followup: 'decision_followup',
  blocker: 'blocker',
});

/**
 * Map a signal_type to its obligation_type, or null when unmapped.
 * @param {string|null|undefined} signalType
 * @returns {string|null}
 */
export function obligationTypeForSignal(signalType) {
  return OBLIGATION_TYPE_BY_SIGNAL[signalType] ?? null;
}
