/**
 * Relationship strength scoring — Phase 5 of the CRM upgrade.
 *
 * Combines (a) the human-set tier/VIP signal already on signal.contacts
 * with (b) the graph edges the inferrer maintains (THREADED_WITH,
 * PARTICIPATED_WITH, COLLABORATED_ON_PROJECT) into a single 0-100 score
 * per contact. Used by:
 *
 *   - The contact detail page badge ("strength 78 / 100")
 *   - /api/relationship-health (decaying inner-circle contacts)
 *   - Future: strategist priority weighting, responder tone selection
 *
 * Scoring is intentionally simple and deterministic — agents can A/B it
 * with their own weights down the road.
 */

import { runCypher, isGraphAvailable } from './client.js';
import { visibleClause } from '../tenancy/scope.js';

const TIER_BASE = {
  inner_circle: 70,
  active: 45,
  inactive: 8,        // intentional cooldown — score floors out
  inbound_only: 20,
  newsletter: 3,
  automated: 2,
  unknown: 12,
};

const VIP_BONUS = 15;

function logCap(count, cap) {
  if (!count || count <= 0) return 0;
  // log10(1)=0, log10(10)=1, log10(100)=2 — gentle scaling.
  const scaled = Math.log10(Math.max(1, count));
  return Math.min(cap, Math.round(scaled * cap));
}

function recencyBonus(lastAtIso) {
  if (!lastAtIso) return 0;
  const daysAgo = (Date.now() - new Date(lastAtIso).getTime()) / (24 * 60 * 60 * 1000);
  if (!Number.isFinite(daysAgo)) return 0;
  if (daysAgo <= 7) return 15;
  if (daysAgo <= 30) return 8;
  if (daysAgo <= 90) return 3;
  return 0;
}

/**
 * Aggregate edge counts/recency for a single Person from Neo4j.
 * Returns { threadCount, docCount, projectCount, lastAt } or null if the
 * person has no graph node yet.
 */
async function fetchEdgeAggregate(personId) {
  if (!isGraphAvailable()) return null;
  // STAQPRO-326: runCypher returns the records array directly (or null when
  // Neo4j is unavailable / Cypher errored). The previous `result.records`
  // dereference was always undefined and silently returned null here, which
  // zeroed every contact's graph-derived strength bonus in the UI.
  const records = await runCypher(
    `MATCH (p:Person {id: $id})
     OPTIONAL MATCH (p)-[t:THREADED_WITH]-()
     OPTIONAL MATCH (p)-[d:PARTICIPATED_WITH]-()
     OPTIONAL MATCH (p)-[c:COLLABORATED_ON_PROJECT]-()
     RETURN
       coalesce(sum(t.threadCount), 0)        AS threadCount,
       coalesce(sum(d.docCount), 0)           AS docCount,
       coalesce(sum(c.projectCount), 0)       AS projectCount,
       coalesce(
         max(t.lastAt),
         max(d.lastAt),
         max(c.lastAt)
       )                                       AS lastAt`,
    { id: personId },
  );
  if (!records || records.length === 0) return null;
  const row = records[0];
  return {
    threadCount: Number(row.get('threadCount') || 0),
    docCount: Number(row.get('docCount') || 0),
    projectCount: Number(row.get('projectCount') || 0),
    lastAt: row.get('lastAt'),
  };
}

/**
 * Compute the relationship strength score for one contact, given a row
 * from signal.contacts (including tier + is_vip + last_received_at).
 *
 * Returns { score, breakdown } where breakdown explains how the score
 * was assembled — useful for the UI and for debugging "why is X strong?"
 */
export async function scoreContact(contactRow) {
  const tier = contactRow.tier || 'unknown';
  const tierBase = TIER_BASE[tier] ?? TIER_BASE.unknown;
  const vipBonus = contactRow.is_vip ? VIP_BONUS : 0;

  const edges = await fetchEdgeAggregate(contactRow.id);
  const threadBonus = edges ? logCap(edges.threadCount, 25) : 0;
  const docBonus = edges ? logCap(edges.docCount, 12) : 0;
  const projectBonus = edges ? logCap(edges.projectCount, 8) : 0;

  // Recency picks the most-recent of email last_received_at vs graph lastAt.
  const recencyAt =
    edges?.lastAt ||
    contactRow.last_received_at ||
    contactRow.last_sent_at ||
    null;
  const recency = recencyBonus(recencyAt);

  const raw = tierBase + vipBonus + threadBonus + docBonus + projectBonus + recency;
  const score = Math.max(0, Math.min(100, raw));

  return {
    score,
    breakdown: {
      tier,
      tierBase,
      vipBonus,
      threadBonus,
      docBonus,
      projectBonus,
      recency,
      lastAt: recencyAt,
      edges: edges
        ? {
            threadCount: edges.threadCount,
            docCount: edges.docCount,
            projectCount: edges.projectCount,
          }
        : null,
    },
  };
}

/**
 * Find decaying inner-circle / active contacts: high tier or strong
 * historical signal, but no recent interaction. Used by the architect
 * agent's weekly briefing and by /api/relationship-health.
 *
 * Pure Postgres — no Neo4j dependency for this query. (We could enrich
 * with graph aggregates later, but tier alone is strong enough.)
 *
 * STAQPRO-608: signal.contacts carries owner_org_id (mig 134). Reads MUST be
 * tenant-scoped. The `principal` option (from resolvePrincipal /
 * syntheticPrincipal) is threaded into visibleClause(c.owner_org_id):
 *   - HTTP callers pass the request principal; an unresolved viewer is null →
 *     visibleClause emits 'FALSE' → zero rows (fail-closed, never fail-open).
 *   - Agent-runtime callers that legitimately need org-wide reads pass an
 *     explicit principal (e.g. syntheticPrincipal(CURRENT_ORG_ID) or a verified
 *     adminBypass principal) and keep their existing behavior.
 * The default `principal: null` is deliberately fail-closed: a caller that has
 * not been updated to pass a principal reads nothing rather than everything.
 */
export async function findDecayingRelationships(
  queryFn,
  { staleAfterDays = 14, limit = 10, principal = null } = {},
) {
  // $1=staleAfterDays, $2=limit; visibleClause placeholders begin at $3.
  const v = visibleClause(principal, { ownerOrgCol: 'c.owner_org_id', startIndex: 3 });
  const result = await queryFn(
    `SELECT c.id, c.name, c.email_address, c.tier, c.is_vip,
            c.organization_id, o.name AS organization_name,
            c.last_received_at, c.last_sent_at,
            EXTRACT(EPOCH FROM (now() - GREATEST(
              COALESCE(c.last_received_at, '1970-01-01'::timestamptz),
              COALESCE(c.last_sent_at,     '1970-01-01'::timestamptz)
            ))) / 86400.0 AS days_silent
       FROM signal.contacts c
       LEFT JOIN signal.organizations o ON o.id = c.organization_id
      WHERE c.contact_type NOT IN ('service', 'newsletter')
        AND (c.tier IN ('inner_circle', 'active') OR c.is_vip = true)
        AND (c.last_received_at IS NOT NULL OR c.last_sent_at IS NOT NULL)
        AND GREATEST(
              COALESCE(c.last_received_at, '1970-01-01'::timestamptz),
              COALESCE(c.last_sent_at,     '1970-01-01'::timestamptz)
            ) < now() - ($1 || ' days')::interval
        AND ${v.sql}
      ORDER BY days_silent DESC
      LIMIT $2`,
    [staleAfterDays, limit, ...v.params],
  );
  return result.rows.map((r) => ({
    ...r,
    days_silent: Math.round(Number(r.days_silent || 0)),
  }));
}
