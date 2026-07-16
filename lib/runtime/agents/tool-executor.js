/**
 * Tool Execution Wrapper (Claude Code Architecture Audit — Change 2).
 *
 * Central executeTool() function that all agent handlers call instead of
 * invoking tools directly. Runs pre/post hooks, tracks denials with TTL,
 * and prevents retrying denied operations.
 *
 * Inspired by Claude Code's tool execution framework with denial tracking.
 *
 * P1: Deny by default — denied tools are cached to prevent wasted retries.
 * P2: Infrastructure enforces — hooks run automatically, not at call sites.
 * P3: Transparency — all invocations logged via post-hooks.
 *
 * Post-review fixes applied:
 *   - 60s TTL on denial cache (Linus: permissions can change at runtime)
 *   - Per-task denial tracking via workItemId scoping (Linus: multi-process correctness)
 *   - Size-bounded cache with LRU eviction (Linus: no unbounded growth)
 */

import { runPreHooks, runPostHooks } from '../hooks.js';

const DENIAL_TTL_MS = 60_000;  // 60s — long enough to prevent retry storms, short enough to respect permission changes
const MAX_DENIAL_CACHE_SIZE = 500;  // Prevent unbounded growth

/**
 * Denial cache: tracks recently denied tool calls to prevent retry storms.
 * Key: `${agentId}:${toolName}` (or `${agentId}:${toolName}:${workItemId}` when scoped)
 * Value: { reason, deniedAt }
 *
 * Entries expire after DENIAL_TTL_MS. Cache is bounded to MAX_DENIAL_CACHE_SIZE entries.
 */
const denialCache = new Map();

/**
 * Check if a tool call was recently denied (within TTL).
 * Expired entries are cleaned up lazily.
 */
function isDenied(cacheKey) {
  const entry = denialCache.get(cacheKey);
  if (!entry) return null;

  if (Date.now() - entry.deniedAt > DENIAL_TTL_MS) {
    denialCache.delete(cacheKey);
    return null;
  }

  return entry;
}

/**
 * Record a denial in the cache. Evicts oldest entry if at capacity.
 */
function recordDenial(cacheKey, reason) {
  // LRU eviction: remove oldest entry if at capacity
  if (denialCache.size >= MAX_DENIAL_CACHE_SIZE) {
    const oldestKey = denialCache.keys().next().value;
    denialCache.delete(oldestKey);
  }

  denialCache.set(cacheKey, { reason, deniedAt: Date.now() });
}

/**
 * Execute a tool through the hook pipeline with denial tracking.
 *
 * @param {Object} opts
 * @param {string} opts.agentId - Agent invoking the tool
 * @param {string} opts.toolName - Tool identifier (e.g., 'gmail:send', 'linear:create')
 * @param {string} opts.resourceType - 'tool' | 'adapter' | 'api_client' | 'subprocess'
 * @param {string} opts.resourceName - Resource name for permission checks
 * @param {Object} opts.input - Tool input parameters
 * @param {string} [opts.workItemId] - Current work item (scopes denial tracking)
 * @param {function} opts.execute - The actual tool execution function: async (input) => result
 * @returns {Promise<{success: boolean, data?: *, denied?: boolean, reason?: string, durationMs?: number}>}
 */
export async function executeTool({
  agentId,
  toolName,
  resourceType = 'tool',
  resourceName,
  input,
  workItemId = null,
  execute,
}) {
  // Build cache key — scoped to work item when available for per-task tracking
  const cacheKey = workItemId
    ? `${agentId}:${toolName}:${workItemId}`
    : `${agentId}:${toolName}`;

  // Check denial cache first — prevents retry storms (saves LLM tokens)
  const cached = isDenied(cacheKey);
  if (cached) {
    return { success: false, denied: true, reason: `Previously denied (${cached.reason})`, cached: true };
  }

  // Build hook context
  const hookCtx = { agentId, toolName, resourceType, resourceName: resourceName || toolName, input, workItemId };

  // Run pre-hooks (permission check, budget check, etc.)
  const preResult = await runPreHooks(hookCtx);
  if (!preResult.allowed) {
    recordDenial(cacheKey, preResult.reason);
    return { success: false, denied: true, reason: preResult.reason, hook: preResult.hook };
  }

  // Execute the tool
  const start = Date.now();
  let result;
  let error;
  try {
    result = await execute(input);
  } catch (err) {
    error = err;
  }
  const durationMs = Date.now() - start;

  // Run post-hooks (audit logging, metrics, etc.)
  await runPostHooks({
    ...hookCtx,
    success: !error,
    durationMs,
    errorMessage: error?.message || null,
    result: error ? null : result,
  });

  if (error) {
    return { success: false, reason: error.message, durationMs };
  }

  return { success: true, data: result, durationMs };
}

/**
 * Clear expired entries from the denial cache.
 * Called periodically or on-demand for cache hygiene.
 */
export function cleanDenialCache() {
  const now = Date.now();
  for (const [key, entry] of denialCache) {
    if (now - entry.deniedAt > DENIAL_TTL_MS) {
      denialCache.delete(key);
    }
  }
}

/**
 * Get denial cache stats (for diagnostics).
 */
export function getDenialCacheStats() {
  return { size: denialCache.size, maxSize: MAX_DENIAL_CACHE_SIZE, ttlMs: DENIAL_TTL_MS };
}

/**
 * Clear denial cache (for testing).
 */
export function _clearDenialCache() {
  denialCache.clear();
}
