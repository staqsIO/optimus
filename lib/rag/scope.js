/**
 * RAG retriever scope validation (STAQPRO tenancy hardening — Worktree 1).
 *
 * Centralises the per-call "who is allowed to see what" decision for every
 * entry point in lib/rag/retriever.js. Before this module existed, each
 * caller passed loose options (`ownerId`, `includeOrgWide`,
 * `sharedDocumentsOnly`) that the retriever forwarded straight into SQL.
 * A caller could silently get org-wide visibility just by omitting
 * `ownerId` — the deny-by-default principle (SPEC §0 P1, P2) was not
 * enforced at the infrastructure boundary.
 *
 * This module is the boundary:
 *
 *   - Callers pass a `scope` argument that is one of two shapes, each of which
 *     MUST also carry `readOrgIds` (the principal's readable tenancy orgs):
 *       { ownerId: <UUID>, readOrgIds: <UUID[]> }
 *       { org: true, agentId: <agent-id>, readOrgIds: <UUID[]> }
 *   - validateScope() rejects everything else.
 *
 * ORG FAIL-CLOSED (Phase-2 tenancy, live read-leak):
 *   `readOrgIds` is the cross-tenant isolation key. It is REQUIRED and
 *   fail-closed: an omitted / empty org list yields an empty filter
 *   (filterOrgIds: []) which makes content.match_chunks return ZERO rows
 *   (migration 135's early-return guard). This is the inverse of the old
 *   transitional `{org:true, __legacy:true}` synthesis, which was fail-OPEN
 *   and had no org concept at all. Absence of a valid org scope is now "see
 *   nothing", never "see everything" (SPEC §0 P1 deny-by-default).
 *
 *   HTTP/board callers derive readOrgIds from the viewer principal
 *   (lib/tenancy/scope.js resolvePrincipal → readOrgIds). Agent/system callers
 *   with no viewer use syntheticPrincipal(STAQS_ORG_ID).readOrgIds.
 *   - getAgentTier() looks up the caller's tier from config/agents.json
 *     (never trust a caller-supplied tier string).
 *   - ORG_SCOPE_ALLOWED_TIERS is the explicit allow-list of tiers that
 *     may request org-wide retrieval.
 *   - scopeToFilterOpts() is the ONLY place the three SQL filter values
 *     (ownerId / includeOrgWide / sharedDocumentsOnly) are derived from
 *     a validated scope. Callers cannot leak past validation by
 *     hand-rolling those values.
 *
 * Why `org: true` and not `scope: 'org'`?
 *   lib/rag/client.js already uses `opts.scope === 'optimus'` as a
 *   conversation-cache key. Reusing the same property name with a
 *   different meaning would collide. `org: true` is unambiguous.
 *
 * Is the legacy `{ ownerId, includeOrgWide, sharedDocumentsOnly }` opts triple
 * still accepted? NO (STAQPRO-570).
 *   It WAS honoured transitionally and soft-degraded a malformed/legacy scope
 *   into a synthesized filter. With two orgs live that soft-degrade is
 *   fail-OPEN: the wrong default before federation. validateScope now HARD-
 *   THROWS RetrieverScopeError on a bare legacy/malformed shape. The only path
 *   that still reaches validateScope via `opts` is the internal parent
 *   passthrough (`opts.__scopeValidatedByParent === true`), where the parent
 *   retrieveContext has already validated a real scope and is plumbing the
 *   normalized filter values + `readOrgIds` to the inner entry points. Every
 *   external caller MUST pass a validated `scope` arg.
 *
 * Forward-compat: wikiPageSearch currently has no per-row owner column
 * on content.wiki_pages (created_by is TEXT, migration 039). Callers
 * still pass a scope so the API is consistent; the validator records a
 * FOLLOWUP-WIKI-OWNER marker but does NOT inject a no-op SQL clause.
 * A subsequent migration adds owner_id UUID to wiki_pages and lights up
 * filtering there too.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { createLogger } from '../logger.js';

/**
 * Module passthrough sentinel (STAQPRO-594). The parent retrieveContext stamps
 * this on the opts it plumbs to the inner entry points (searchChunks /
 * lexicalChunkSearch) to signal "I already validated a real scope" — the Mode-2
 * passthrough. A Symbol, NOT a string key: it cannot be forged from serialized /
 * external input (JSON carries no Symbols), so only an in-process caller holding
 * this exact binding can set it. Closes the P2 gap where any caller passing
 * `{ __scopeValidatedByParent: true }` could forge an internal-validated scope.
 */
export const SCOPE_VALIDATED_BY_PARENT = Symbol('scopeValidatedByParent');

const log = createLogger('rag/scope');

/**
 * Tiers permitted to request `{ org: true }` retrieval. Match the casing
 * used in `autobot-inbox/config/agents.json` exactly.
 *
 * Why these three?
 *   - Strategist: priority scoring across all org context.
 *   - Architect: daily pipeline analysis across all signals.
 *   - Reviewer: gate checks that may need org precedent.
 *
 * Every other tier (Executor, Orchestrator, Utility, External) must
 * resolve to a specific board member via work_item.account_id →
 * inbox.accounts.owner_id and pass `{ ownerId }`.
 */
export const ORG_SCOPE_ALLOWED_TIERS = Object.freeze(['Strategist', 'Architect', 'Reviewer']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(s) {
  return typeof s === 'string' && UUID_RE.test(s);
}

/**
 * Normalize a caller-supplied org list into a clean UUID[] (deduped, validated).
 * Anything non-array / empty / all-invalid → [] (fail-closed). Invalid entries
 * are dropped rather than throwing — a partially-valid list still scopes to its
 * valid orgs, and a fully-invalid one denies (0 rows) rather than leaking.
 *
 * @param {unknown} readOrgIds
 * @returns {string[]}
 */
function normalizeReadOrgIds(readOrgIds) {
  if (!Array.isArray(readOrgIds)) return [];
  const seen = new Set();
  for (const o of readOrgIds) {
    if (isUuid(o)) seen.add(String(o));
  }
  return [...seen];
}

/**
 * Typed error class for scope-validation failures. Carries an
 * `entryPoint` field so callers and logs can pinpoint which retriever
 * function rejected the call.
 */
export class RetrieverScopeError extends Error {
  /**
   * @param {string} message
   * @param {{ entryPoint?: string, reason?: string }} [info]
   */
  constructor(message, info = {}) {
    super(message);
    this.name = 'RetrieverScopeError';
    this.entryPoint = info.entryPoint || 'unknown';
    this.reason = info.reason || 'invalid_scope';
    // No statusCode — this is an infra-level violation, not an HTTP one.
    // HTTP-shaped callers translate (see retrieverScopeFromRequest in
    // autobot-inbox/src/api-routes/document-access.js for the bridge).
  }
}

// ── Agent tier lookup ──────────────────────────────────────────────

let _agentsConfigCache = null;

/**
 * Load (and cache) agents.json. Defensive about location — agents.json
 * is product-coupled (lives in autobot-inbox/config/) and lib/ should
 * not import from autobot-inbox/. We read by path, not import, so the
 * coupling is data-only and easy to break later by injecting a loader.
 *
 * The cache lives for the process lifetime. agents.json is config the
 * runtime reloads on restart anyway — there is no "live edit" path.
 */
function loadAgentsConfig() {
  if (_agentsConfigCache) return _agentsConfigCache;
  // lib/rag/scope.js -> repo root -> autobot-inbox/config/agents.json
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '../../autobot-inbox/config/agents.json'),
    // Test rigs sometimes set this so the runtime picks up a fixture file.
    process.env.AGENTS_CONFIG_PATH,
  ].filter(Boolean);

  let raw = null;
  for (const path of candidates) {
    try {
      raw = readFileSync(path, 'utf8');
      break;
    } catch {
      // try next candidate
    }
  }
  if (!raw) {
    log.warn('agents.json not found — tier lookup will return null for all agents');
    _agentsConfigCache = { agents: {} };
    return _agentsConfigCache;
  }
  try {
    const parsed = JSON.parse(raw);
    // agents.json shape is `{ "agents": { "agent-id": { tier, subTier, ... } } }`
    _agentsConfigCache = parsed.agents ? parsed : { agents: parsed };
  } catch (err) {
    log.warn(`Failed to parse agents.json: ${err.message}`);
    _agentsConfigCache = { agents: {} };
  }
  return _agentsConfigCache;
}

/**
 * Resolve the tier of an agent by id, using the local agents.json
 * registry. Returns null when the agent is unknown — callers MUST
 * treat that as "deny" rather than "default to executor".
 *
 * @param {string} agentId
 * @returns {string | null}
 */
export function getAgentTier(agentId) {
  if (!agentId || typeof agentId !== 'string') return null;
  const cfg = loadAgentsConfig();
  return cfg.agents?.[agentId]?.tier ?? null;
}

// ── Validation ─────────────────────────────────────────────────────

/**
 * Sole entry point for scope validation. Returns a normalized scope
 * object on success; throws RetrieverScopeError on any invalid shape.
 *
 * Modes:
 *   1. New shape: caller passes `scope` arg — strict validation.
 *   2. Internal passthrough: the parent retrieveContext re-enters the inner
 *      entry points with `scope` undefined but `opts.__scopeValidatedByParent
 *      === true` and the already-validated filter values stamped on `opts`.
 *      This is an implementation detail, not a public shape — we re-derive its
 *      org gate and proceed without a throw.
 *   3. Legacy shape OR nothing: a bare legacy opts triple
 *      (`opts.ownerId` / `opts.includeOrgWide` / `opts.sharedDocumentsOnly`)
 *      with no validated scope, OR no scope and no opts at all, both THROW.
 *      STAQPRO-570 flipped the old legacy soft-degrade to a hard-throw: with
 *      two orgs live, synthesizing a filter from loose opts is fail-open. This
 *      is the deny-by-default boundary (SPEC §0 P1).
 *
 * @param {{ entryPoint: string, scope?: unknown, opts?: Record<string, unknown> }} args
 * @returns {{ ownerId: string | null, org: boolean, agentId: string | null, readOrgIds: string[] }}
 */
export function validateScope({ entryPoint, scope, opts }) {
  if (!entryPoint || typeof entryPoint !== 'string') {
    // Programming error — never reachable from callers, only from us.
    throw new RetrieverScopeError('validateScope requires entryPoint', { reason: 'misuse' });
  }

  // ── Mode 1: explicit new-shape scope ────────────────────────────
  if (scope !== undefined && scope !== null) {
    if (typeof scope !== 'object' || Array.isArray(scope)) {
      throw new RetrieverScopeError('scope must be an object', { entryPoint, reason: 'shape' });
    }
    // ORG dimension is mandatory + fail-closed. Resolve it FIRST so every
    // exit from this branch carries a (possibly empty) org set.
    const readOrgIds = normalizeReadOrgIds(scope.readOrgIds);
    // ADR-017 v1: group memberships are an additional principal axis used by
    // share_grants with target_type='group'. Preserved unchanged through scope
    // validation; default [] is fail-closed (no group target ever matches).
    const readGroupIds = Array.isArray(scope.readGroupIds)
      ? scope.readGroupIds.filter((g) => typeof g === 'string' && g.length > 0)
      : [];
    if (readOrgIds.length === 0) {
      // Visible-but-safe: an empty org set yields zero rows downstream. Warn so
      // a missed caller surfaces in logs instead of silently returning nothing.
      log.warn(
        `[${entryPoint}] scope has no readable orgs (readOrgIds empty/missing) — RAG will fail closed (0 rows)`
      );
    }
    const hasOwner = scope.ownerId !== undefined && scope.ownerId !== null;
    const hasOrg = scope.org === true;
    if (!hasOwner && !hasOrg) {
      throw new RetrieverScopeError('scope missing ownerId or org:true', {
        entryPoint,
        reason: 'missing',
      });
    }
    if (hasOwner && hasOrg) {
      throw new RetrieverScopeError('scope ambiguous: pass ownerId OR org:true, not both', {
        entryPoint,
        reason: 'ambiguous',
      });
    }
    if (hasOwner) {
      if (!isUuid(scope.ownerId)) {
        throw new RetrieverScopeError('scope.ownerId must be a UUID', {
          entryPoint,
          reason: 'bad_uuid',
        });
      }
      return { ownerId: String(scope.ownerId), org: false, agentId: null, readOrgIds, readGroupIds };
    }
    // org:true — tier-gated
    if (!scope.agentId || typeof scope.agentId !== 'string') {
      throw new RetrieverScopeError('scope.org=true requires agentId', {
        entryPoint,
        reason: 'missing_agent',
      });
    }
    const tier = getAgentTier(scope.agentId);
    if (!ORG_SCOPE_ALLOWED_TIERS.includes(tier)) {
      throw new RetrieverScopeError(
        `agent "${scope.agentId}" (tier=${tier ?? 'unknown'}) not allowed org-wide scope`,
        { entryPoint, reason: 'tier_forbidden' }
      );
    }
    return { ownerId: null, org: true, agentId: scope.agentId, readOrgIds, readGroupIds };
  }

  // ── Mode 2: internal parent passthrough (NOT a public escape hatch) ──
  // STAQPRO-570: the legacy `{ ownerId, includeOrgWide, sharedDocumentsOnly }`
  // opts triple is no longer accepted from external callers. With two orgs in
  // play, soft-degrading a legacy/malformed scope to a synthesized filter is
  // fail-OPEN — exactly the wrong default before federation (SPEC §0 P1
  // deny-by-default). The ONLY caller still allowed to reach validateScope via
  // `opts` is the parent retrieveContext, which has ALREADY validated a real
  // scope and stamped `__scopeValidatedByParent: true` while plumbing the
  // normalized filter values down to the inner entry points (searchChunks /
  // lexicalChunkSearch). That passthrough is an implementation detail, not a
  // legacy shape — re-derive its org gate and proceed without a throw.
  if (opts && opts[SCOPE_VALIDATED_BY_PARENT] === true) {
    const readOrgIds = normalizeReadOrgIds(opts.readOrgIds);
    if (opts.ownerId && isUuid(opts.ownerId)) {
      return { ownerId: String(opts.ownerId), org: false, agentId: null, readOrgIds, __legacy: true };
    }
    // No ownerId on the passthrough: org-scoped to the parent's readOrgIds
    // (empty → 0 rows). The per-user owner gate is left open (filter_owner_id
    // NULL → TRUE in SQL); the org gate still bounds the result set.
    return { ownerId: null, org: true, agentId: null, readOrgIds, __legacy: true };
  }

  // ── Mode 3: legacy shape OR nothing supplied → HARD-THROW (fail-closed) ──
  // STAQPRO-570: a caller that passed the deprecated opts triple (or any other
  // opts shape) without a validated `scope` argument is rejected outright. The
  // old soft-degrade synthesized an org filter from loose opts and let the call
  // proceed; with multi-tenancy live that is a fail-open read-leak vector. The
  // window to flip this closes before federation, so it closes here.
  const hasLegacyFlag = opts && (
    opts.ownerId !== undefined
    || opts.includeOrgWide !== undefined
    || opts.sharedDocumentsOnly !== undefined
  );
  if (hasLegacyFlag) {
    throw new RetrieverScopeError(
      `legacy scope shape (ownerId/includeOrgWide/sharedDocumentsOnly) is no longer accepted — `
      + `pass a validated scope arg ({ ownerId, readOrgIds } or { org:true, agentId, readOrgIds })`,
      { entryPoint, reason: 'legacy_shape' }
    );
  }
  throw new RetrieverScopeError('scope arg required (no scope, no legacy opts)', {
    entryPoint,
    reason: 'missing',
  });
}

/**
 * Translate a validated scope into the SQL filter parameters
 * lib/rag/retriever.js feeds into match_chunks / lexicalChunkSearch.
 * THIS IS THE ONLY PLACE these values are produced from a scope —
 * callers cannot bypass validation by hand-constructing them.
 *
 * `filterOrgIds` is the cross-tenant isolation key threaded into
 * content.match_chunks(filter_org_ids) (migration 135). An empty array makes
 * match_chunks return 0 rows (fail-closed). The per-USER `ownerId` /
 * `includeOrgWide` values are intra-org narrowing only — they do NOT, on their
 * own, bound tenant visibility.
 *
 * @param {{ ownerId: string | null, org: boolean, agentId: string | null, readOrgIds?: string[], __legacy?: boolean }} normalizedScope
 * @returns {{ ownerId: string | null, includeOrgWide: boolean, sharedDocumentsOnly: boolean, filterOrgIds: string[], filterGroupIds: string[] }}
 */
export function scopeToFilterOpts(normalizedScope) {
  // readOrgIds is the tenant gate. Default to [] (fail-closed) if a caller
  // somehow reached here without it — match_chunks then returns 0 rows.
  const filterOrgIds = normalizeReadOrgIds(normalizedScope?.readOrgIds);
  // ADR-017: readGroupIds is the share_grants target-group principal set.
  // Default [] (no group memberships) — match_chunks ignores the group target
  // arm when this is empty.
  const filterGroupIds = Array.isArray(normalizedScope?.readGroupIds)
    ? normalizedScope.readGroupIds.filter((g) => typeof g === 'string' && g.length > 0)
    : [];

  if (normalizedScope.ownerId) {
    // Personal scope: that member's documents plus the org-shared
    // corpus (owner_id IS NULL). This matches the existing behaviour
    // of includeOrgWide=true with an ownerId set; we make it explicit
    // and non-overridable from outside.
    return {
      ownerId: normalizedScope.ownerId,
      includeOrgWide: true,
      sharedDocumentsOnly: false,
      filterOrgIds,
      filterGroupIds,
    };
  }
  if (normalizedScope.org) {
    // Org-wide scope: no per-member restriction WITHIN the readable orgs. The
    // tier gate ran in validateScope; the org gate (filterOrgIds) still bounds
    // visibility to the principal's tenancy orgs.
    return {
      ownerId: null,
      includeOrgWide: true,
      sharedDocumentsOnly: false,
      filterOrgIds,
      filterGroupIds,
    };
  }
  // Defensive: validateScope should never produce this.
  throw new RetrieverScopeError('scopeToFilterOpts received invalid normalized scope', {
    reason: 'shape',
  });
}

/**
 * Test-only: reset the agents.json cache so a test fixture can swap it.
 * Not exported on a "public" surface — flagged in the name.
 * @internal
 */
export function __resetAgentsConfigCacheForTests() {
  _agentsConfigCache = null;
}
