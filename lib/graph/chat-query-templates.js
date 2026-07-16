// graph/chat-query-templates.js — Feature 010-A (OPT-130)
//
// Read-only, *templated* graph queries for board chat (consumed by the
// `query_graph` chat tool, 010-B). Four named templates answer relational
// questions ("who do we know at org X?", "how are A and B connected?") from
// the prod Neo4j people/org graph.
//
// Design principles (SPEC §0):
//  - P1 deny-by-default: only these four named templates exist; there is NO
//    path to run freeform Cypher from chat.
//  - P2 infrastructure enforces, prompts advise: tenancy scoping, the row cap,
//    and bot filtering all happen HERE (Cypher + code), never in the prompt.
//  - P3 transparency: callers attach results as `graph`-kind citations (010-B).
//
// Acceptance criteria implemented here:
//  - AC-3 (tenancy, fail-closed): every node is gated on origin_org ∈ the
//    caller's readable orgs; an empty readable-org set returns zero rows and
//    never even runs a query.
//  - AC-4 (degradation): Neo4j unreachable → a graceful "graph unavailable"
//    result, no throw, no added latency.
//  - AC-5 (bot filter): note-taker bots (tl;dv etc.) never appear in results —
//    filtered both in Cypher (contact_type) and post-hoc (name/email patterns).

import {
  runCypher as defaultRunCypher,
  isGraphAvailable as defaultIsGraphAvailable,
  getOriginOrg,
} from './client.js';
import { CURRENT_ORG_ID } from '../tenancy/scope.js';
import { isNoteTakerBot } from '../rag/participants/normalize.js';
import { createLogger } from '../logger.js';

const log = createLogger('graph/chat-templates');

/** Hard cap on rows returned to the LLM (spec §2.A). */
export const ROW_CAP = 25;

/** contact_type values that are never real people (mirrors relationship-inferrer). */
const BOT_CONTACT_TYPES = ['service', 'newsletter'];

/**
 * neo4j-driver returns integers as Integer objects (to preserve 64-bit range).
 * Collapse to a JS number for the LLM; null/undefined → 0.
 */
function num(v) {
  if (v == null) return 0;
  if (typeof v === 'object' && typeof v.toNumber === 'function') return v.toNumber();
  return Number(v);
}

/**
 * Map the caller's readable org UUIDs → the set of `origin_org` *tokens* that
 * appear on graph nodes.
 *
 * The wrinkle (verified 2026-06-13): this install stamps every node with
 * `getOriginOrg()`, which is `OPTIMUS_ORG_ID || 'self'`. OPTIMUS_ORG_ID is
 * currently UNSET, so nodes carry the literal `'self'` sentinel — while
 * `readOrgIds` are org UUIDs (CURRENT_ORG_ID). A naive `origin_org IN
 * $readOrgIds` would match nothing and the whole feature would be silently
 * dead. This install *represents* CURRENT_ORG_ID, so a caller who can read
 * CURRENT_ORG_ID may read this install's locally-stamped nodes.
 *
 * Forward-compatible: once OPTIMUS_ORG_ID is set to a real org UUID, nodes get
 * stamped with that UUID, `localToken` becomes that UUID, and the mapping
 * collapses to a plain UUID membership check — the `'self'` special-case goes
 * inert because no node carries it.
 */
export function allowedOriginTokens(readOrgIds) {
  const tokens = new Set(readOrgIds);
  if (readOrgIds.includes(CURRENT_ORG_ID)) tokens.add(getOriginOrg());
  return [...tokens];
}

// Tenancy predicate fragment for a node alias. $trusted (org-wide access,
// granted ONLY via the explicit opts.trusted flag — never from caller-shaped
// scope) short-circuits to TRUE, mirroring tenancy.visibleClause(). NULL
// origin_org = org-shared, readable by any resolved caller (OQ-1: follow RAG).
const scoped = (a) =>
  `($trusted OR ${a}.origin_org IS NULL OR ${a}.origin_org IN $allowedOrigins)`;

// Person-is-not-a-bot predicate for a node alias (AC-5, query-layer half).
const notBot = (a) => `(${a}.contact_type IS NULL OR NOT ${a}.contact_type IN $botTypes)`;

// Sum of co-occurrence counts across the three co-attendance edge types. Each
// edge carries exactly one of these props (camelCase, per relationship-inferrer).
const EDGE_WEIGHT =
  'coalesce(r.threadCount,0) + coalesce(r.docCount,0) + coalesce(r.projectCount,0)';
const CO_EDGES = 'THREADED_WITH|PARTICIPATED_WITH|COLLABORATED_ON_PROJECT';

function requireStr(params, key) {
  const v = params?.[key];
  if (typeof v !== 'string' || v.trim() === '') return `missing_or_invalid:${key}`;
  return null;
}

/**
 * Template registry. Each entry: { params:[…], validate(params), cypher, mapRow }.
 * `cypher` is a static, parameterized string — never string-built from input.
 */
const TEMPLATES = {
  // Who someone meets / threads with, weighted by co-occurrence.
  person_connections: {
    params: ['person'],
    validate(p) {
      const e = requireStr(p, 'person');
      return e ? { error: e } : { params: { person: p.person.trim() } };
    },
    cypher: `
      MATCH (p:Person)
      WHERE (p.email = $person OR toLower(p.name) = toLower($person))
        AND ${scoped('p')}
      MATCH (p)-[r:${CO_EDGES}]-(other:Person)
      WHERE ${scoped('other')} AND ${notBot('other')}
      WITH other,
           sum(${EDGE_WEIGHT}) AS weight,
           max(r.lastAt) AS lastAt
      RETURN other.name AS name, other.email AS email, other.tier AS tier,
             weight, lastAt
      ORDER BY weight DESC, lastAt DESC
      LIMIT toInteger($cap)`,
    mapRow: (o) => ({
      name: o.name, email: o.email, tier: o.tier,
      weight: num(o.weight), lastAt: o.lastAt || null,
    }),
  },

  // Known people at an organization (WORKS_AT).
  org_people: {
    params: ['org'],
    validate(p) {
      const e = requireStr(p, 'org');
      return e ? { error: e } : { params: { org: p.org.trim() } };
    },
    cypher: `
      MATCH (o:Organization)
      WHERE (toLower(o.name) = toLower($org)
             OR toLower(coalesce(o.slug,'')) = toLower($org)
             OR toLower(coalesce(o.primary_domain,'')) = toLower($org))
        AND ${scoped('o')}
      MATCH (person:Person)-[:WORKS_AT]->(o)
      WHERE ${scoped('person')} AND ${notBot('person')}
      // Collapse to one row per real person, keyed by email (else name). The
      // live data has BOTH multiple Organization nodes per org name AND
      // duplicate Person identities sharing an email (the same contact split
      // that mislabels nodes) — grouping by the node would still double them,
      // so group by the email/name key and pick one representative. (OPT-135)
      WITH coalesce(person.email, person.name) AS dedupKey,
           collect(person)[0] AS p,
           head(collect(DISTINCT o.name)) AS org
      WHERE dedupKey IS NOT NULL
      RETURN p.name AS name, p.email AS email,
             p.tier AS tier, coalesce(p.is_vip,false) AS isVip, org
      ORDER BY isVip DESC, name
      LIMIT toInteger($cap)`,
    mapRow: (o) => ({
      name: o.name, email: o.email, tier: o.tier,
      isVip: !!o.isVip, org: o.org,
    }),
  },

  // How two people are connected: direct co-attendance + mutual orgs.
  shared_context: {
    params: ['a', 'b'],
    validate(p) {
      const e = requireStr(p, 'a') || requireStr(p, 'b');
      return e ? { error: e } : { params: { a: p.a.trim(), b: p.b.trim() } };
    },
    // Note: if $a or $b resolve to multiple Person nodes (same name, different
    // emails) this can fan out rows; pass an email for an exact match. Verify
    // single-row output for the common case in the live rollout test (Linus MINOR).
    cypher: `
      MATCH (a:Person)
      WHERE (a.email = $a OR toLower(a.name) = toLower($a)) AND ${scoped('a')}
      MATCH (b:Person)
      WHERE (b.email = $b OR toLower(b.name) = toLower($b)) AND ${scoped('b')}
      WITH a, b
      OPTIONAL MATCH (a)-[r:${CO_EDGES}]-(b)
      WITH a, b,
           collect(DISTINCT type(r)) AS rels,
           sum(${EDGE_WEIGHT}) AS weight,
           max(r.lastAt) AS lastAt
      OPTIONAL MATCH (a)-[:WORKS_AT]->(o:Organization)<-[:WORKS_AT]-(b)
      WHERE ${scoped('o')}
      RETURN [x IN rels WHERE x IS NOT NULL] AS connections,
             weight, lastAt, collect(DISTINCT o.name) AS sharedOrgs
      LIMIT toInteger($cap)`,
    mapRow: (o) => ({
      connections: o.connections || [],
      weight: num(o.weight),
      lastAt: o.lastAt || null,
      sharedOrgs: (o.sharedOrgs || []).filter(Boolean),
    }),
  },

  // Co-attendance within a recency window.
  recent_collaborators: {
    params: ['person', 'days'],
    validate(p) {
      const e = requireStr(p, 'person');
      if (e) return { error: e };
      let days = p.days == null ? 30 : Number(p.days);
      if (!Number.isFinite(days) || days < 1) return { error: 'invalid:days' };
      days = Math.min(Math.floor(days), 365);
      return { params: { person: p.person.trim(), days } };
    },
    cypher: `
      MATCH (p:Person)-[r:${CO_EDGES}]-(other:Person)
      WHERE (p.email = $person OR toLower(p.name) = toLower($person))
        AND ${scoped('p')} AND ${scoped('other')} AND ${notBot('other')}
        AND r.lastAt IS NOT NULL
        AND datetime(r.lastAt) >= datetime() - duration({days: toInteger($days)})
      WITH other, max(r.lastAt) AS lastAt, sum(${EDGE_WEIGHT}) AS weight
      RETURN other.name AS name, other.email AS email, lastAt, weight
      ORDER BY lastAt DESC
      LIMIT toInteger($cap)`,
    mapRow: (o) => ({
      name: o.name, email: o.email,
      lastAt: o.lastAt || null, weight: num(o.weight),
    }),
  },
};

/** Names of available templates — for the 010-B tool schema and tests. */
export const GRAPH_TEMPLATE_NAMES = Object.keys(TEMPLATES);

/** Lightweight template introspection for building the chat tool's input schema (010-B). */
export function graphTemplateSpecs() {
  return GRAPH_TEMPLATE_NAMES.map((name) => ({ name, params: TEMPLATES[name].params }));
}

// Defense-in-depth bot filter (AC-5): the Cypher excludes service/newsletter
// contact_type, this catches note-taker bots that slipped in under another type
// by matching name/email patterns (tl;dv, fireflies, otter, …).
function isBotRow(row) {
  try {
    return isNoteTakerBot({ email: row.email || '', name: row.name || '' });
  } catch {
    return false;
  }
}

/**
 * Run a named graph template under the caller's tenancy scope.
 *
 * @param {string} name  one of GRAPH_TEMPLATE_NAMES
 * @param {object} params  template-specific params (validated server-side)
 * @param {{readOrgIds?: string[]}} scope
 *        from resolveChatRetrieverScope(boardUser); fail-closed on empty.
 *        NOTE: tenancy is derived ONLY from scope.readOrgIds. There is no
 *        bypass field on scope — org-wide access is a separate, explicit opt.
 * @param {{runCypher?: Function, isGraphAvailable?: Function, trusted?: boolean}} [opts]
 *        test seams (runCypher/isGraphAvailable) + the trusted flag. `trusted`
 *        grants org-wide reads and is an EXPLICIT option a chat handler never
 *        passes — it is NOT read off the caller-shaped `scope`, so no value that
 *        flows through resolveChatRetrieverScope or a parsed tool-call payload
 *        can spoof it (P2: infrastructure enforces, not the prompt).
 * @returns {Promise<{ok: boolean, available: boolean, rows: Array, degraded?: boolean, reason?: string, error?: string}>}
 */
export async function runGraphTemplate(name, params = {}, scope = {}, opts = {}) {
  const runCypherFn = opts.runCypher || defaultRunCypher;
  const isAvailableFn = opts.isGraphAvailable || defaultIsGraphAvailable;
  const trusted = opts.trusted === true;

  const tmpl = TEMPLATES[name];
  if (!tmpl) return { ok: false, available: true, rows: [], error: 'unknown_template' };

  // AC-4: graph down → graceful empty result, no query, no throw.
  if (!isAvailableFn()) return { ok: true, available: false, rows: [], degraded: true };

  // AC-3: fail-closed tenancy. A trusted (org-wide) caller sees all; every
  // other caller must have ≥1 readable org or we return nothing WITHOUT
  // touching the graph.
  const readOrgIds = Array.isArray(scope.readOrgIds) ? scope.readOrgIds : [];
  if (!trusted && readOrgIds.length === 0) {
    return { ok: true, available: true, rows: [], reason: 'no_org_access' };
  }

  // Server-side param validation (P1/P2) — never trust caller input.
  const validated = tmpl.validate(params);
  if (validated.error) return { ok: false, available: true, rows: [], error: validated.error };

  const cypherParams = {
    ...validated.params,
    allowedOrigins: allowedOriginTokens(readOrgIds),
    trusted,
    botTypes: BOT_CONTACT_TYPES,
    cap: ROW_CAP,
  };

  try {
    const records = await runCypherFn(tmpl.cypher, cypherParams, {
      readOnly: true,
      caller: `chat-template:${name}`,
    });
    // runCypher returns null on unavailability/error → degrade gracefully (AC-4).
    if (!records) return { ok: true, available: false, rows: [], degraded: true };

    const rows = records
      .map((r) => tmpl.mapRow(r.toObject()))
      .filter((row) => !isBotRow(row)) // AC-5 belt-and-suspenders
      .slice(0, ROW_CAP);
    return { ok: true, available: true, rows };
  } catch (err) {
    log.warn({ err: err.message, template: name }, 'graph template failed — degrading');
    return { ok: true, available: false, rows: [], degraded: true };
  }
}
