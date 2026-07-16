/**
 * Organizations + contact graph endpoints.
 *
 * Phase 3 of the CRM upgrade (ADR-026). Surfaces the data the new schema
 * (signal.organizations, signal.contact_identities) and the Neo4j projection
 * (Phase 2) made possible.
 *
 *   GET  /api/organizations               — list with member counts
 *   GET  /api/organizations/:id           — detail + member contacts + signals
 *   GET  /api/contacts/:id/connections    — top-K Neo4j edges for a person
 */

import { query, withBoardScope } from '../db.js';
import { visibleClause } from '../../../lib/tenancy/scope.js';

function parsePathId(req, position = -1) {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);
  return decodeURIComponent(parts[position < 0 ? parts.length + position : position] || '');
}

export function registerOrganizationsRoutes(routes, { withViewer } = {}) {
  // STAQPRO-608: resolve the tenancy principal. null (withViewer absent or a
  // resolution throw) → visibleClause 'FALSE' → zero rows, never an unscoped read.
  const resolvePrincipalFor = async (req) => {
    if (!withViewer) return null;
    try {
      return (await withViewer(req)).principal;
    } catch {
      return null;
    }
  };

  routes.set('GET /api/organizations', async (req) => {
    // STAQPRO-608 (596-class): signal.organizations carries owner_org_id
    // (migration 134). Scope fail-closed so one org's CRM orgs never enumerate
    // to another. The contacts LEFT JOIN is for counts only; rows are anchored
    // to the already-scoped organization, so no contact can widen the set.
    const principal = await resolvePrincipalFor(req);
    const v = visibleClause(principal, { ownerOrgCol: 'o.owner_org_id', startIndex: 1 });
    // OPT-166 P3: route tier is AUTHED_ANY — non-board principals keep the
    // legacy pool (INERT pre-flip; RLS fail-closed post-flip). Board principals
    // (incl. legacy api_secret, which resolves to role 'board') get a scoped session.
    const boardScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
    const scopedQuery = boardScope ?? query;
    let result;
    try {
      result = await scopedQuery(
        `SELECT o.id, o.name, o.slug, o.primary_domain, o.org_type, o.created_at,
                count(c.id)::int AS contact_count,
                count(c.id) FILTER (WHERE c.tier = 'inner_circle')::int AS inner_circle_count,
                max(c.last_received_at) AS last_activity_at
           FROM signal.organizations o
           LEFT JOIN signal.contacts c ON c.organization_id = o.id
          WHERE ${v.sql}
          GROUP BY o.id
          ORDER BY contact_count DESC, o.name`,
        v.params,
      );
    } finally {
      if (boardScope) await boardScope.release();
    }
    return { organizations: result.rows };
  });

  routes.set('GET /api/organizations/:id', async (req) => {
    const id = parsePathId(req, -1);
    if (!id) throw Object.assign(new Error('id required'), { statusCode: 400 });

    // STAQPRO-608: gate the anchor org fail-closed. A non-visible org returns
    // the same 404 a missing id produces (no cross-tenant enumeration oracle);
    // the sub-queries below are anchored on organization_id = $1 and only run
    // after this passes, so they cannot leak another org's contacts/signals.
    const principal = await resolvePrincipalFor(req);
    const ov = visibleClause(principal, { ownerOrgCol: 'o.owner_org_id', startIndex: 2 });
    // OPT-166 P3: route tier is AUTHED_ANY — non-board principals keep the
    // legacy pool (INERT pre-flip; RLS fail-closed post-flip). Board principals
    // (incl. legacy api_secret, which resolves to role 'board') get a scoped session.
    const boardScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
    const scopedQuery = boardScope ?? query;
    let orgResult, contactsResult, aliasesResult, recentSignalsResult;
    try {
      orgResult = await scopedQuery(
        `SELECT o.*,
                count(c.id)::int AS contact_count,
                max(c.last_received_at) AS last_activity_at
           FROM signal.organizations o
           LEFT JOIN signal.contacts c ON c.organization_id = o.id
          WHERE o.id = $1 AND ${ov.sql}
          GROUP BY o.id`,
        [id, ...ov.params],
      );
      if (orgResult.rows.length === 0) {
        throw Object.assign(new Error('organization not found'), { statusCode: 404 });
      }

      contactsResult = await scopedQuery(
        `SELECT c.id, c.name, c.email_address, c.contact_type, c.tier, c.is_vip,
                c.emails_received, c.emails_sent, c.last_received_at,
                v.relationship_strength
           FROM signal.contacts c
           LEFT JOIN signal.v_contact_strength v ON v.id = c.id
          WHERE c.organization_id = $1
          ORDER BY (c.is_vip)::int DESC, c.last_received_at DESC NULLS LAST`,
        [id],
      );

      aliasesResult = await scopedQuery(
        `SELECT alias, alias_type, created_at
           FROM signal.organization_aliases
          WHERE organization_id = $1
          ORDER BY alias_type, alias`,
        [id],
      );

      recentSignalsResult = await scopedQuery(
        `SELECT s.id, s.signal_type, s.content, s.confidence, s.created_at,
                m.subject, m.channel, m.from_address
           FROM inbox.signals s
           JOIN inbox.messages m ON m.id = s.message_id
          WHERE lower(m.from_address) IN (
            SELECT i.identifier FROM signal.contact_identities i
              JOIN signal.contacts c ON c.id = i.contact_id
             WHERE c.organization_id = $1 AND i.channel = 'email'
          )
          ORDER BY s.created_at DESC LIMIT 25`,
        [id],
      );
    } finally {
      if (boardScope) await boardScope.release();
    }

    return {
      organization: orgResult.rows[0],
      contacts: contactsResult.rows,
      aliases: aliasesResult.rows,
      recentSignals: recentSignalsResult.rows,
    };
  });

  routes.set('GET /api/contacts/:id/connections', async (req) => {
    // Path: /api/contacts/<id>/connections — id is the second-to-last part.
    const id = parsePathId(req, -2);
    if (!id) throw Object.assign(new Error('id required'), { statusCode: 400 });

    const { runCypher, isGraphAvailable } = await import('../../../lib/graph/client.js');
    if (!isGraphAvailable()) {
      return { connections: [], graphAvailable: false };
    }

    // Pull top-K edges by (count desc, recency desc) across the three edge
    // types written by the relationship inferrer. Caller renders edge type
    // as a badge so they can tell why two people are connected.
    const result = await runCypher(
      `MATCH (p:Person {id: $id})-[r:THREADED_WITH|PARTICIPATED_WITH|COLLABORATED_ON_PROJECT]-(other:Person)
       RETURN other.id        AS contact_id,
              other.name      AS name,
              other.email     AS email,
              type(r)         AS edge_type,
              coalesce(r.threadCount, r.docCount, r.projectCount) AS edge_count,
              r.lastAt        AS last_at
       ORDER BY edge_count DESC, last_at DESC
       LIMIT 16`,
      { id },
    );

    // STAQPRO-326: runCypher returns the records array directly (or null on
    // failure / unavailable graph), not a wrapped { records } envelope. The
    // previous `result.records?.map` always evaluated to undefined, fell back
    // to `[]`, and the UI silently rendered every contact as having no
    // graph-derived connections.
    return {
      connections: (result || []).map((row) => ({
        contact_id: row.get('contact_id'),
        name: row.get('name'),
        email: row.get('email'),
        edge_type: row.get('edge_type'),
        edge_count: Number(row.get('edge_count') || 0),
        last_at: row.get('last_at'),
      })),
      graphAvailable: true,
    };
  });
}
