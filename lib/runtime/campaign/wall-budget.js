/**
 * Wall-clock budget for long campaign loops (Phase 2 durability).
 *
 * Pure + leaf (no heavy deps) so the resume invariant — a crash+restart must
 * RESUME the same deadline, never grant a fresh budget — is unit-testable.
 */

/**
 * Resolve the loop's absolute deadline.
 *  - If a deadline was already persisted (prior run), reuse it verbatim. This is
 *    the crash-resume invariant: an 18hr budget started 17h ago has 1h left, not 18.
 *  - Otherwise compute now + wallBudgetMs and flag it as new (caller persists).
 *
 * @param {{ existingDeadlineIso: string|null, wallBudgetMs: number, now: number }} args
 * @returns {{ deadlineAt: number, isNew: boolean }}
 */
export function resolveLoopDeadline({ existingDeadlineIso, wallBudgetMs, now }) {
  const parsed = existingDeadlineIso ? new Date(existingDeadlineIso).getTime() : NaN;
  if (!Number.isNaN(parsed)) return { deadlineAt: parsed, isNew: false };
  return { deadlineAt: now + wallBudgetMs, isNew: true };
}

/** Has the wall-clock budget been spent? */
export function isWallBudgetExceeded(deadlineAt, now) {
  return now >= deadlineAt;
}
