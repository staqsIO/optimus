/**
 * Chunk-load failure recovery (STAQPRO-544).
 *
 * Next.js code-splits each route into hashed JS chunks. After a deploy mid-session,
 * the browser still references the OLD chunk hashes, which no longer exist on the
 * server — the dynamic import rejects with a `ChunkLoadError` and the affected route
 * renders a dead error boundary that `reset()` cannot fix (the chunk is simply gone).
 *
 * The cure is a one-time hard reload: fetching the page fresh pulls the new HTML +
 * the new chunk manifest, after which the route loads normally. We guard the reload
 * with sessionStorage so a genuinely-broken build can't trap the user in a reload loop.
 */

const RELOAD_GUARD_KEY = "optimus:chunk-reload-attempted";

let reloadedThisLifetime = false;

/**
 * Detects a stale-chunk / build-skew failure. Next.js sets `error.name === "ChunkLoadError"`,
 * but production minification and some browsers only surface the message, so we match both.
 */
export function isChunkLoadError(error: unknown): boolean {
  if (!error) return false;
  const err = error as { name?: string; message?: string };
  const name = err.name ?? "";
  const message = err.message ?? "";
  return (
    name === "ChunkLoadError" ||
    /Loading chunk [\w-]+ failed/i.test(message) ||
    /Loading CSS chunk [\w-]+ failed/i.test(message) ||
    /ChunkLoadError/i.test(message) ||
    // Firefox/Safari dynamic-import failures after a deploy
    /failed to fetch dynamically imported module/i.test(message) ||
    /error loading dynamically imported module/i.test(message) ||
    /importing a module script failed/i.test(message)
  );
}

/**
 * If `error` is a chunk-load failure and we have not already tried, perform a single
 * hard reload and return true (caller should render a neutral "Reloading…" state).
 * Returns false when it's not a chunk error, when we've already reloaded once, or
 * when running on the server (no window).
 */
export function recoverFromChunkError(error: unknown): boolean {
  if (typeof window === "undefined") return false;
  if (!isChunkLoadError(error)) return false;

  let alreadyAttempted = false;
  try {
    alreadyAttempted = window.sessionStorage.getItem(RELOAD_GUARD_KEY) === "1";
  } catch {
    // sessionStorage can throw (private mode / disabled storage). Fall back to a
    // module-scoped flag so we still reload at most once per page lifetime.
    alreadyAttempted = reloadedThisLifetime;
  }

  if (alreadyAttempted) return false;

  try {
    window.sessionStorage.setItem(RELOAD_GUARD_KEY, "1");
  } catch {
    // ignore — module-scoped flag below still bounds us to one reload
  }
  reloadedThisLifetime = true;

  // Hard reload bypasses the in-memory router cache and fetches the fresh chunk manifest.
  window.location.reload();
  return true;
}

/**
 * Clears the reload guard. Call once the app has successfully mounted so a LATER
 * deploy in the same tab session can recover again. Safe to call on every mount.
 */
export function clearChunkReloadGuard(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(RELOAD_GUARD_KEY);
  } catch {
    // ignore
  }
  reloadedThisLifetime = false;
}
