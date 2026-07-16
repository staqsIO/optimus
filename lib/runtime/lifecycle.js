/**
 * Process lifecycle / graceful-drain coordinator (Phase 2 durability).
 *
 * On SIGTERM we want in-flight work to CHECKPOINT and stop, not be killed
 * mid-iteration. This is the small shared signal the agent loops and the
 * campaign loop consult:
 *
 *   beginDrain()      — called once by the shutdown handler. Flips the flag and
 *                       aborts every registered AbortController (so a running
 *                       campaign iteration ends fast instead of running its full
 *                       5-min budget).
 *   isDraining()      — checked at loop/iteration boundaries to exit gracefully.
 *   registerAbort(c)  — a long-running unit registers its AbortController so a
 *                       drain can interrupt it; returns an unregister fn.
 *   drainTimeoutMs()  — hard ceiling the shutdown handler waits before SIGKILL.
 *
 * Leaf module (no deps) so it is unit-testable and importable anywhere without
 * pulling the agent-loop dependency chain.
 */

let _draining = false;
const _controllers = new Set();

export function isDraining() {
  return _draining;
}

export function beginDrain() {
  if (_draining) return;
  _draining = true;
  for (const c of _controllers) {
    try { c.abort(); } catch { /* already aborted / not an AbortController */ }
  }
}

/**
 * Register an AbortController to be aborted when a drain begins. If a drain is
 * already in progress, aborts immediately. Returns an unregister function the
 * caller should invoke when its work completes (so the set doesn't leak).
 */
export function registerAbort(controller) {
  if (!controller || typeof controller.abort !== 'function') return () => {};
  if (_draining) {
    try { controller.abort(); } catch { /* ignore */ }
    return () => {};
  }
  _controllers.add(controller);
  return () => _controllers.delete(controller);
}

export function drainTimeoutMs() {
  const v = parseInt(process.env.DRAIN_TIMEOUT_MS || '', 10);
  return Number.isFinite(v) && v > 0 ? v : 30_000; // 30s default
}

/** Test-only reset. */
export function _resetDrainState() {
  _draining = false;
  _controllers.clear();
}
