/**
 * Fetch with timeout — wraps native fetch with AbortSignal.timeout.
 * Use AbortSignal.any() when external cancellation is also needed.
 */
export async function fetchWithTimeout(url, opts = {}, timeoutMs = 30_000) {
  const { signal, ...rest } = opts;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;
  return fetch(url, { ...rest, signal: combinedSignal });
}
