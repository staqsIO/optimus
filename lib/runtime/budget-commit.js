/**
 * Budget reservation commit helper (Plan 016).
 *
 * A task reserves budget ONCE (via guardCheck's reserve_budget). callLLM runs
 * `commit_budget(estimated, actual, account)` on EVERY invocation to accrue the
 * real `actual` cost into spent_usd — correct. But the `estimated` portion is
 * the amount to release back from reserved_usd, and the reservation was made
 * only once. A handler that calls callLLM more than once would otherwise pass
 * the estimate on every call, decrementing reserved_usd repeatedly for a single
 * reservation (bounded by the SQL `GREATEST(...,0)` clamp, but still wrong
 * accounting — the reservation is fully released after the first call).
 *
 * Return the estimate to release on the first commit for a task and 0 on every
 * subsequent call, so the reservation is converted to spend exactly once.
 *
 * @param {boolean} alreadyCommitted - whether this task already released its reservation
 * @param {number} estimate - the reserved estimate for this task
 * @returns {number} amount of the reservation to release on this commit
 */
export function reservationEstimateToRelease(alreadyCommitted, estimate) {
  return alreadyCommitted ? 0 : estimate;
}
