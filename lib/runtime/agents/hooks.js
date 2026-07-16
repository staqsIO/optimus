/**
 * Pre/Post Tool Hook System (Claude Code Architecture Audit — Change 1).
 *
 * Structural guarantee that every tool/capability invocation runs through
 * registered hooks. Inspired by Claude Code's PreToolUse/PostToolUse pattern.
 *
 * P1: Deny by default — pre-hooks can block execution.
 * P2: Infrastructure enforces — hooks run in the runtime, not at call sites.
 * P3: Transparency by structure — post-hooks log all invocations automatically.
 *
 * Usage:
 *   import { registerPreHook, registerPostHook, runPreHooks, runPostHooks } from '../hooks.js';
 *
 *   // Register a hook that matches all tools
 *   registerPreHook('*', async (ctx) => ({ allowed: true }));
 *
 *   // Register a hook that matches specific tools
 *   registerPreHook('gmail:*', async (ctx) => {
 *     // Check rate limits for Gmail operations
 *     return { allowed: true };
 *   });
 */

/**
 * @typedef {Object} HookContext
 * @property {string} agentId - Agent invoking the tool
 * @property {string} toolName - Tool being invoked (e.g., 'gmail:send', 'linear:create')
 * @property {string} resourceType - 'tool' | 'adapter' | 'api_client' | 'subprocess'
 * @property {string} resourceName - Specific resource (e.g., 'gmail', 'linear')
 * @property {Object} input - Tool input parameters
 * @property {string} [workItemId] - Current work item ID
 */

/**
 * @typedef {Object} PreHookResult
 * @property {boolean} allowed - Whether the tool call should proceed
 * @property {string} [reason] - Reason for denial (required if allowed=false)
 */

/**
 * @typedef {Object} PostHookContext
 * @property {string} agentId
 * @property {string} toolName
 * @property {string} resourceType
 * @property {string} resourceName
 * @property {Object} input
 * @property {string} [workItemId]
 * @property {boolean} success - Whether the tool call succeeded
 * @property {number} [durationMs] - Execution duration
 * @property {string} [errorMessage] - Error message if failed
 * @property {*} [result] - Tool result (may be truncated)
 */

import { createLogger } from '../../logger.js';
const log = createLogger('runtime/hooks');
const preHooks = [];   // { pattern: string, fn: async (HookContext) => PreHookResult, name: string }
const postHooks = [];  // { pattern: string, fn: async (PostHookContext) => void, name: string }

/**
 * Match a tool name against a hook pattern.
 * Patterns:
 *   '*'           — matches everything
 *   'gmail:*'     — matches any tool starting with 'gmail:'
 *   'gmail:send'  — exact match
 *
 * @param {string} pattern
 * @param {string} toolName
 * @returns {boolean}
 */
function matchesPattern(pattern, toolName) {
  if (pattern === '*') return true;
  if (pattern.endsWith(':*')) {
    return toolName.startsWith(pattern.slice(0, -1)); // 'gmail:*' → 'gmail:'
  }
  return pattern === toolName;
}

/**
 * Validate a hook pattern at registration time.
 * Valid patterns: '*', 'namespace:*', 'namespace:tool'
 * Rejects malformed patterns to prevent silent no-ops in security-critical code.
 */
function validatePattern(pattern) {
  if (pattern === '*') return;
  if (/^[a-z_][a-z0-9_]*:\*$/.test(pattern)) return; // 'gmail:*'
  if (/^[a-z_][a-z0-9_]*:[a-z_][a-z0-9_]*$/.test(pattern)) return; // 'gmail:send'
  throw new Error(
    `Invalid hook pattern '${pattern}'. Valid: '*', 'namespace:*', or 'namespace:tool'. ` +
    `Got a pattern that would silently match nothing.`
  );
}

/**
 * Register a pre-execution hook. Runs before every matching tool invocation.
 * If any pre-hook returns { allowed: false }, the tool call is blocked.
 *
 * @param {string} pattern - Tool name pattern ('*', 'gmail:*', 'gmail:send')
 * @param {function} fn - async (HookContext) => PreHookResult
 * @param {string} [name] - Hook name for debugging
 */
export function registerPreHook(pattern, fn, name = 'anonymous') {
  validatePattern(pattern);
  preHooks.push({ pattern, fn, name });
}

/**
 * Register a post-execution hook. Runs after every matching tool invocation.
 * Post-hooks are fire-and-forget — failures are logged but don't affect the result.
 *
 * @param {string} pattern - Tool name pattern
 * @param {function} fn - async (PostHookContext) => void
 * @param {string} [name] - Hook name for debugging
 */
export function registerPostHook(pattern, fn, name = 'anonymous') {
  validatePattern(pattern);
  postHooks.push({ pattern, fn, name });
}

/**
 * Run all matching pre-hooks for a tool invocation.
 * Short-circuits on first denial (P1: deny by default).
 *
 * @param {HookContext} ctx
 * @returns {Promise<PreHookResult>}
 */
export async function runPreHooks(ctx) {
  const matching = preHooks.filter(h => matchesPattern(h.pattern, ctx.toolName));

  for (const hook of matching) {
    try {
      const result = await hook.fn(ctx);
      // Treat missing `allowed` as denial (fail-closed, P1).
      // A hook returning {} or forgetting `allowed` denies — this is intentional.
      if (!result.allowed) {
        return { allowed: false, reason: result.reason || `Denied by hook: ${hook.name}`, hook: hook.name };
      }
    } catch (err) {
      // P1: fail-closed — hook errors deny the tool call
      log.error(`Pre-hook '${hook.name}' threw (denying): ${err.message}`);
      return { allowed: false, reason: `Hook error (fail-closed): ${hook.name}: ${err.message}`, hook: hook.name };
    }
  }

  return { allowed: true };
}

/**
 * Run all matching post-hooks for a tool invocation.
 * Post-hooks are fire-and-forget — all run regardless of individual failures.
 *
 * @param {PostHookContext} ctx
 */
export async function runPostHooks(ctx) {
  const matching = postHooks.filter(h => matchesPattern(h.pattern, ctx.toolName));

  const results = await Promise.allSettled(
    matching.map(hook => hook.fn(ctx))
  );

  // Log any post-hook failures (non-fatal — execution already completed)
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'rejected') {
      log.warn(`Post-hook '${matching[i].name}' failed (non-fatal): ${results[i].reason?.message || results[i].reason}`);
    }
  }
}

/**
 * Get registered hook counts (for diagnostics/testing).
 * @returns {{ preHooks: number, postHooks: number }}
 */
export function getHookCounts() {
  return { preHooks: preHooks.length, postHooks: postHooks.length };
}

/**
 * Clear all hooks (for testing only).
 */
export function _clearHooks() {
  preHooks.length = 0;
  postHooks.length = 0;
}
