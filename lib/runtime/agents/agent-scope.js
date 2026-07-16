import { withAgentScope } from '../../db.js';
import { issueAgentToken } from '../agent-jwt.js';
import { getConfig } from '../../config/loader.js';
import { createLogger } from '../../logger.js';

const log = createLogger('runtime/agents/agent-scope');

// 15-min TTL / 12-min refresh discipline, matching agent-loop.js's
// _issueToken/_tokenRefreshTimer: reuse a cached token until ~3 minutes
// before it expires, then mint a fresh one.
const REFRESH_BUFFER_MS = 3 * 60 * 1000;

/** agentId -> { token, expiresAt } */
const tokenCache = new Map();

// Lazily loaded and cached: agent-loop.js reads agents.json eagerly at
// module scope, but this module is imported from contexts (unit tests, CLI)
// that may not have a full product config wired up, so the load is deferred
// to first use and tolerant of failure — a missing/unreadable config just
// means every agentId resolves to an empty config (TIER_MAP falls back to
// 'executor' in issueAgentToken).
let agentsConfig;

function resolveAgentConfig(agentId) {
  if (agentsConfig === undefined) {
    try {
      agentsConfig = getConfig('agents');
    } catch (err) {
      log.warn(`[OPT-166] agent-scope: failed to load agents config (${err.message}); agent tiers will default to 'executor'`);
      agentsConfig = null;
    }
  }
  return agentsConfig?.agents?.[agentId] || {};
}

async function getOrIssueToken(agentId) {
  const cached = tokenCache.get(agentId);
  if (cached && cached.expiresAt - Date.now() > REFRESH_BUFFER_MS) {
    return cached.token;
  }
  const agentConfig = resolveAgentConfig(agentId);
  const issued = issueAgentToken(agentId, agentConfig);
  tokenCache.set(agentId, issued);
  return issued.token;
}

/**
 * Open an agent-scoped DB session for a plain agentId string, minting (and
 * caching) a short-lived JWT so withAgentScope() succeeds under
 * REQUIRE_AGENT_JWT=true.
 *
 * OPT-166: `withAgentScope(plainAgentIdString)` throws once REQUIRE_AGENT_JWT
 * is enforced in production (lib/db.js resolveAgentIdentity) — only
 * lib/runtime/agents/agent-loop.js mints real tokens today. Several
 * flow-wrappers and api-routes/blueprint.js still call withAgentScope with a
 * bare agent id and no surrounding catch, so they hard-throw on live paths.
 * openAgentScope() is a drop-in replacement for those call sites:
 * `withAgentScope('executor-responder')` becomes
 * `openAgentScope('executor-responder')`.
 *
 * Non-enforcement fallback: if issueAgentToken() throws — most commonly
 * "JWT keys not initialized" in tests/CLI/PGlite contexts where
 * initializeJwtKeys() was never called — this logs a warning and falls back
 * to withAgentScope(agentId, opts) with the plain id, mirroring
 * agent-loop.js's _issueToken fallback. With enforcement off that still
 * works (with its own warning from withAgentScope); with enforcement on it
 * throws exactly as it did before this helper existed, which is the correct
 * fail-closed behavior. The withAgentScope() call itself is never wrapped in
 * try/catch here — its errors always propagate to the caller.
 *
 * @param {string} agentId - agent identifier from agents.json (e.g. 'executor-responder')
 * @param {object} [opts] - forwarded to withAgentScope (role, user, orgIds)
 */
export async function openAgentScope(agentId, opts = {}) {
  let token;
  try {
    token = await getOrIssueToken(agentId);
  } catch (err) {
    log.warn(`[OPT-166] openAgentScope: JWT issuance failed for "${agentId}" (${err.message}); falling back to plain agentId`);
    return withAgentScope(agentId, opts);
  }
  return withAgentScope(token, opts);
}

/**
 * Test-only accessor into the token cache — mirrors the `_...ForTest` idiom
 * in agent-jwt.js (`_issueLegacyTokenForTest`, `_signClaimsForTest`). Not for
 * production use.
 */
export function _peekCachedTokenForTest(agentId) {
  return tokenCache.get(agentId);
}
