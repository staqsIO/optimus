/**
 * Sharing API — knowledge-share grants (ADR-017).
 *
 * GET    /api/sharing/grants                 — list incoming + outgoing for the caller
 * POST   /api/sharing/grants                 — create a new grant
 * POST   /api/sharing/grants/:id/accept      — accept a pending grant
 * POST   /api/sharing/grants/:id/decline     — decline a pending grant
 * POST   /api/sharing/grants/:id/revoke      — revoke a pending or active grant
 *
 * Tenancy: every route resolves the caller's principal via withViewer (the
 * standard auth-gate pattern in this codebase). Authorization for the
 * lifecycle ops lives in lib/sharing/grants.js (granter-side vs target-side
 * permissions). The list endpoint is principal-scoped — callers only see
 * grants where they are either the granter or a target principal.
 */

import { query, withBoardScope } from '../db.js';
import {
  createGrant,
  acceptGrant,
  declineGrant,
  revokeGrant,
  listGrantsForCaller,
} from '../../../lib/sharing/grants.js';

function parsePathId(req, position = -2) {
  // For /api/sharing/grants/:id/accept → position = -2 picks :id
  // For /api/sharing/grants/:id        → position = -1
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);
  return decodeURIComponent(parts[position < 0 ? parts.length + position : position] || '');
}

function requireBoardMember(req) {
  if (!req.auth || req.auth.role !== 'board') {
    const e = new Error('Board role required');
    e.statusCode = 403;
    throw e;
  }
  if (!req.auth.id) {
    const e = new Error('Authenticated board member id required');
    e.statusCode = 401;
    throw e;
  }
  return req.auth.id;
}

async function principalFor(req, withViewer) {
  if (!withViewer) return null;
  try { return (await withViewer(req)).principal; } catch { return null; }
}

export function registerSharingRoutes(routes, { withViewer } = {}) {
  // ---------------------------------------------------------------------
  // GET /api/sharing/me — caller's principal snapshot.
  // Returns { user_id, org_memberships: [{org_id, org_name, role}], groups }
  // so the composer / governance UI knows which orgs the caller can admin.
  // ---------------------------------------------------------------------
  routes.set('GET /api/sharing/me', async (req) => {
    requireBoardMember(req);
    const principal = await principalFor(req, withViewer);
    if (!principal?.userId) return { user_id: null, org_memberships: [], groups: [] };
    const [ms, gs] = await Promise.all([
      query(
        `SELECT m.org_id, o.name AS org_name, o.slug AS org_slug, m.role
           FROM tenancy.memberships m
           JOIN tenancy.orgs o ON o.id = m.org_id
          WHERE m.user_id = $1 AND m.is_active = true
          ORDER BY o.name`,
        [principal.userId],
      ),
      query(
        `SELECT g.id, g.name, g.slug, g.org_id
           FROM tenancy.group_memberships gm
           JOIN tenancy.groups g ON g.id = gm.group_id
          WHERE gm.user_id = $1`,
        [principal.userId],
      ),
    ]);
    return {
      user_id: principal.userId,
      org_memberships: ms.rows,
      groups: gs.rows,
    };
  });

  // ---------------------------------------------------------------------
  // GET /api/sharing/pending-count — cheap count for the NavBar badge.
  // Counts pending grants where the caller is on the receiving end (user,
  // group, or org admin). Designed to be polled from the navbar.
  // ---------------------------------------------------------------------
  routes.set('GET /api/sharing/pending-count', async (req) => {
    requireBoardMember(req);
    const principal = await principalFor(req, withViewer);
    if (!principal?.userId) return { count: 0 };
    const orgIds = principal.readOrgIds || [];
    const groupIds = principal.readGroupIds || [];
    const r = await query(
      `SELECT count(*)::int AS n
         FROM tenancy.share_grants
        WHERE status = 'pending'
          AND (
            (target_type = 'user'  AND target_id = $1)
            OR (target_type = 'org'   AND target_id = ANY($2::uuid[]))
            OR (target_type = 'group' AND target_id = ANY($3::uuid[]))
          )`,
      [principal.userId, orgIds, groupIds],
    );
    return { count: r.rows[0]?.n || 0 };
  });

  // ---------------------------------------------------------------------
  // GET /api/sharing/grants — list incoming + outgoing
  // ---------------------------------------------------------------------
  routes.set('GET /api/sharing/grants', async (req) => {
    requireBoardMember(req);
    const principal = await principalFor(req, withViewer);
    if (!principal?.userId) return { grants: [] };
    const grants = await listGrantsForCaller({ principal });

    // Bucket for the UI's three tabs.
    const incoming = [];
    const outgoing = [];
    const pending = [];
    for (const g of grants) {
      const isGranter =
        (g.granter_type === 'user' && g.granter_id === principal.userId)
        || (g.granter_type === 'org' && principal.readOrgIds.includes(g.granter_id));
      const isTarget =
        (g.target_type === 'user' && g.target_id === principal.userId)
        || (g.target_type === 'org' && principal.readOrgIds.includes(g.target_id))
        || (g.target_type === 'group' && (principal.readGroupIds || []).includes(g.target_id));

      if (g.status === 'pending') pending.push({ ...g, direction: isGranter ? 'outgoing' : 'incoming' });
      else if (g.status === 'active') {
        if (isGranter) outgoing.push(g);
        if (isTarget)  incoming.push(g);
      }
    }
    return { grants, incoming, outgoing, pending };
  });

  // ---------------------------------------------------------------------
  // POST /api/sharing/grants — create a new grant
  // ---------------------------------------------------------------------
  routes.set('POST /api/sharing/grants', async (req, body) => {
    const actorId = requireBoardMember(req);
    const principal = await principalFor(req, withViewer);
    if (!principal?.userId) {
      const e = new Error('principal required'); e.statusCode = 401; throw e;
    }

    const {
      granter_type = 'user',
      granter_id,            // optional when granter_type='user' — defaults to actor
      granter_org_id,        // required when granter_type='org'
      target_type,
      target_id,
      scope_type = 'all',
      scope_ref = null,
      expires_at = null,
      metadata = {},
    } = body || {};

    if (!target_type || !target_id) {
      const e = new Error('target_type and target_id are required'); e.statusCode = 400; throw e;
    }

    // v0: only scope='all' is supported in the UI. We allow scope_ref on the
    // API for forward-compat tests, but enforce v0 default for grants without it.
    if (!['all', 'collection', 'document', 'topic'].includes(scope_type)) {
      const e = new Error(`unknown scope_type '${scope_type}'`); e.statusCode = 400; throw e;
    }

    // Resolve granter
    let resolvedGranterId, resolvedGranterOrgId;
    if (granter_type === 'user') {
      resolvedGranterId = granter_id || actorId;
      if (resolvedGranterId !== actorId) {
        // Users cannot share on behalf of others.
        const e = new Error('forbidden — cannot create a grant on behalf of another user');
        e.statusCode = 403; throw e;
      }
      // Pick the actor's org context. If granter_org_id provided, must be a
      // membership; else use the actor's primary org.
      if (granter_org_id) {
        if (!principal.readOrgIds.includes(granter_org_id)) {
          const e = new Error('forbidden — not a member of granter_org_id');
          e.statusCode = 403; throw e;
        }
        resolvedGranterOrgId = granter_org_id;
      } else {
        resolvedGranterOrgId = principal.readOrgIds[0];
        if (!resolvedGranterOrgId) {
          const e = new Error('actor has no readable orgs'); e.statusCode = 400; throw e;
        }
      }
    } else if (granter_type === 'org') {
      if (!granter_id) {
        const e = new Error('granter_id required when granter_type=org'); e.statusCode = 400; throw e;
      }
      // Only org admins can share org-wide knowledge.
      const admin = await query(
        `SELECT 1 FROM tenancy.memberships
          WHERE user_id = $1 AND org_id = $2 AND is_active = true AND role IN ('owner','admin')
          LIMIT 1`,
        [actorId, granter_id],
      );
      if (admin.rows.length === 0) {
        const e = new Error('forbidden — must be owner/admin of granter org');
        e.statusCode = 403; throw e;
      }
      resolvedGranterId = granter_id;
      resolvedGranterOrgId = granter_id;
    } else {
      const e = new Error(`granter_type must be 'user' or 'org' (got '${granter_type}')`);
      e.statusCode = 400; throw e;
    }

    const grant = await createGrant({
      granterType: granter_type,
      granterId: resolvedGranterId,
      granterOrgId: resolvedGranterOrgId,
      targetType: target_type,
      targetId: target_id,
      scopeType: scope_type,
      scopeRef: scope_ref,
      createdBy: actorId,
      expiresAt: expires_at,
      metadata,
    });
    return { grant };
  });

  // ---------------------------------------------------------------------
  // POST /api/sharing/grants/:id/accept
  // ---------------------------------------------------------------------
  routes.set('POST /api/sharing/grants/:id/accept', async (req) => {
    const actorId = requireBoardMember(req);
    const grantId = parsePathId(req, -2);
    if (!grantId) {
      const e = new Error('grant id required'); e.statusCode = 400; throw e;
    }
    try {
      const grant = await acceptGrant({ grantId, actorId });
      return { grant };
    } catch (err) {
      if (/forbidden/i.test(err.message))  { err.statusCode = 403; throw err; }
      if (/not found/i.test(err.message))  { err.statusCode = 404; throw err; }
      if (/cannot accept|raced/i.test(err.message)) { err.statusCode = 409; throw err; }
      throw err;
    }
  });

  // ---------------------------------------------------------------------
  // POST /api/sharing/grants/:id/decline
  // ---------------------------------------------------------------------
  routes.set('POST /api/sharing/grants/:id/decline', async (req) => {
    const actorId = requireBoardMember(req);
    const grantId = parsePathId(req, -2);
    if (!grantId) {
      const e = new Error('grant id required'); e.statusCode = 400; throw e;
    }
    try {
      const grant = await declineGrant({ grantId, actorId });
      return { grant };
    } catch (err) {
      if (/forbidden/i.test(err.message)) { err.statusCode = 403; throw err; }
      if (/not found/i.test(err.message)) { err.statusCode = 404; throw err; }
      if (/cannot decline|raced/i.test(err.message)) { err.statusCode = 409; throw err; }
      throw err;
    }
  });

  // ---------------------------------------------------------------------
  // POST /api/sharing/grants/:id/revoke
  // ---------------------------------------------------------------------
  routes.set('POST /api/sharing/grants/:id/revoke', async (req) => {
    const actorId = requireBoardMember(req);
    const grantId = parsePathId(req, -2);
    if (!grantId) {
      const e = new Error('grant id required'); e.statusCode = 400; throw e;
    }
    try {
      const grant = await revokeGrant({ grantId, actorId });
      return { grant };
    } catch (err) {
      if (/forbidden/i.test(err.message)) { err.statusCode = 403; throw err; }
      if (/not found/i.test(err.message)) { err.statusCode = 404; throw err; }
      if (/cannot revoke|raced/i.test(err.message)) { err.statusCode = 409; throw err; }
      throw err;
    }
  });

  // ---------------------------------------------------------------------
  // POST /api/sharing/principals/resolve — hydrate ids → display info
  // Body: { principals: [{type, id}, ...] }
  // Returns: { principals: [{type, id, name, slug, email}, ...] } (missing
  // ones echo back with name=null so the UI can fall back to the short id).
  // ---------------------------------------------------------------------
  // =====================================================================
  // Collections (ADR-017 v1, §8) — flat document groupings for collection-scope grants
  // =====================================================================
  routes.set('GET /api/sharing/collections', async (req) => {
    const actorId = requireBoardMember(req);
    const principal = await principalFor(req, withViewer);
    if (!principal?.readOrgIds?.length) return { collections: [] };

    // OPT-166 P3-B3: content.documents (enforced) is touched via the
    // doc_count subselect below. Board-only route (requireBoardMember guard
    // throws before any query) → unconditional board scope (INERT pre-flip,
    // RLS-scoped post-flip).
    const scopedQuery = await withBoardScope(req.auth);
    let r;
    try {
      r = await scopedQuery(
        `SELECT c.id, c.slug, c.name, c.description, c.owner_id, c.owner_org_id, c.created_at,
                (SELECT count(*)::int FROM content.documents d WHERE d.collection_id = c.id) AS doc_count
           FROM content.collections c
          WHERE c.owner_org_id = ANY($1::uuid[])
          ORDER BY c.created_at DESC`,
        [principal.readOrgIds],
      );
    } finally {
      await scopedQuery.release();
    }
    return { collections: r.rows };
  });

  routes.set('POST /api/sharing/collections', async (req, body) => {
    const actorId = requireBoardMember(req);
    const principal = await principalFor(req, withViewer);
    const { name, slug, description = null, owner_org_id, personal = false } = body || {};
    if (!name || !slug) {
      const e = new Error('name and slug required'); e.statusCode = 400; throw e;
    }
    const orgId = owner_org_id || principal?.readOrgIds?.[0];
    if (!orgId || !principal?.readOrgIds?.includes(orgId)) {
      const e = new Error('forbidden — not a member of owner_org_id'); e.statusCode = 403; throw e;
    }
    const r = await query(
      `INSERT INTO content.collections (slug, name, description, owner_id, owner_org_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [slug, name, description, personal ? actorId : null, orgId, actorId],
    );
    return { collection: r.rows[0] };
  });

  routes.set('POST /api/sharing/collections/:id/members', async (req, body) => {
    const actorId = requireBoardMember(req);
    const principal = await principalFor(req, withViewer);
    const collectionId = parsePathId(req, -2);
    const documentIds = Array.isArray(body?.document_ids) ? body.document_ids : [];
    if (!collectionId || documentIds.length === 0) {
      const e = new Error('collection id + document_ids required'); e.statusCode = 400; throw e;
    }

    // OPT-166 P3-B3: content.documents is RLS-enforced; content.collections
    // rides the same scoped connection for this handler's lifecycle.
    // Board-only route (requireBoardMember guard throws before any query) →
    // unconditional board scope.
    const scopedQuery = await withBoardScope(req.auth);
    let r;
    try {
      const col = await scopedQuery(`SELECT owner_org_id, owner_id FROM content.collections WHERE id = $1`, [collectionId]);
      if (col.rows.length === 0) { const e = new Error('collection not found'); e.statusCode = 404; throw e; }
      if (!principal?.readOrgIds?.includes(col.rows[0].owner_org_id)) {
        const e = new Error('forbidden'); e.statusCode = 403; throw e;
      }
      // Personal collections — only the owner can add docs.
      if (col.rows[0].owner_id && col.rows[0].owner_id !== actorId) {
        const e = new Error('forbidden — personal collection'); e.statusCode = 403; throw e;
      }
      // Only docs the actor can write may be added — keep it simple: same-org or owner.
      r = await scopedQuery(
        `UPDATE content.documents
            SET collection_id = $1
          WHERE id = ANY($2::uuid[])
            AND (owner_id = $3 OR (owner_id IS NULL AND owner_org_id = $4))
          RETURNING id`,
        [collectionId, documentIds, actorId, col.rows[0].owner_org_id],
      );
    } finally {
      await scopedQuery.release();
    }
    return { added: r.rows.length };
  });

  routes.set('DELETE /api/sharing/collections/:id', async (req) => {
    const actorId = requireBoardMember(req);
    const id = parsePathId(req, -1);
    if (!id) { const e = new Error('id required'); e.statusCode = 400; throw e; }
    const col = await query(`SELECT owner_org_id, owner_id, created_by FROM content.collections WHERE id = $1`, [id]);
    if (col.rows.length === 0) { const e = new Error('not found'); e.statusCode = 404; throw e; }
    const isOwner = col.rows[0].owner_id === actorId || col.rows[0].created_by === actorId;
    const isAdmin = await query(
      `SELECT 1 FROM tenancy.memberships WHERE user_id = $1 AND org_id = $2 AND role IN ('owner','admin') LIMIT 1`,
      [actorId, col.rows[0].owner_org_id],
    );
    if (!isOwner && isAdmin.rows.length === 0) {
      const e = new Error('forbidden'); e.statusCode = 403; throw e;
    }
    await query(`DELETE FROM content.collections WHERE id = $1`, [id]);
    return { deleted: id };
  });

  // =====================================================================
  // Groups (ADR-017 v1, §10) — share targets for users within an org
  // =====================================================================
  routes.set('GET /api/sharing/groups', async (req) => {
    requireBoardMember(req);
    const principal = await principalFor(req, withViewer);
    if (!principal?.readOrgIds?.length) return { groups: [] };
    const r = await query(
      `SELECT g.id, g.slug, g.name, g.description, g.org_id, g.created_at,
              (SELECT count(*)::int FROM tenancy.group_memberships gm WHERE gm.group_id = g.id) AS member_count
         FROM tenancy.groups g
        WHERE g.org_id = ANY($1::uuid[])
        ORDER BY g.created_at DESC`,
      [principal.readOrgIds],
    );
    return { groups: r.rows };
  });

  routes.set('POST /api/sharing/groups', async (req, body) => {
    const actorId = requireBoardMember(req);
    const { name, slug, description = null, org_id } = body || {};
    if (!name || !slug || !org_id) {
      const e = new Error('name, slug, org_id required'); e.statusCode = 400; throw e;
    }
    // Only org admins create groups.
    const admin = await query(
      `SELECT 1 FROM tenancy.memberships WHERE user_id = $1 AND org_id = $2 AND role IN ('owner','admin') LIMIT 1`,
      [actorId, org_id],
    );
    if (admin.rows.length === 0) {
      const e = new Error('forbidden — must be org owner/admin'); e.statusCode = 403; throw e;
    }
    const r = await query(
      `INSERT INTO tenancy.groups (org_id, slug, name, description, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [org_id, slug, name, description, actorId],
    );
    return { group: r.rows[0] };
  });

  routes.set('POST /api/sharing/groups/:id/members', async (req, body) => {
    const actorId = requireBoardMember(req);
    const groupId = parsePathId(req, -2);
    const userIds = Array.isArray(body?.user_ids) ? body.user_ids : [];
    if (!groupId || userIds.length === 0) {
      const e = new Error('group id + user_ids required'); e.statusCode = 400; throw e;
    }
    const g = await query(`SELECT org_id FROM tenancy.groups WHERE id = $1`, [groupId]);
    if (g.rows.length === 0) { const e = new Error('group not found'); e.statusCode = 404; throw e; }
    const admin = await query(
      `SELECT 1 FROM tenancy.memberships WHERE user_id = $1 AND org_id = $2 AND role IN ('owner','admin') LIMIT 1`,
      [actorId, g.rows[0].org_id],
    );
    if (admin.rows.length === 0) {
      const e = new Error('forbidden — must be org owner/admin'); e.statusCode = 403; throw e;
    }
    // Only add users who are members of this org.
    const members = await query(
      `SELECT user_id FROM tenancy.memberships
        WHERE org_id = $1 AND user_id = ANY($2::uuid[]) AND is_active = true`,
      [g.rows[0].org_id, userIds],
    );
    const eligible = members.rows.map((r) => r.user_id);
    for (const uid of eligible) {
      await query(
        `INSERT INTO tenancy.group_memberships (group_id, user_id, added_by)
         VALUES ($1, $2, $3) ON CONFLICT (group_id, user_id) DO NOTHING`,
        [groupId, uid, actorId],
      );
    }
    return { added: eligible.length };
  });

  routes.set('DELETE /api/sharing/groups/:id', async (req) => {
    const actorId = requireBoardMember(req);
    const id = parsePathId(req, -1);
    const g = await query(`SELECT org_id FROM tenancy.groups WHERE id = $1`, [id]);
    if (g.rows.length === 0) { const e = new Error('not found'); e.statusCode = 404; throw e; }
    const admin = await query(
      `SELECT 1 FROM tenancy.memberships WHERE user_id = $1 AND org_id = $2 AND role IN ('owner','admin') LIMIT 1`,
      [actorId, g.rows[0].org_id],
    );
    if (admin.rows.length === 0) { const e = new Error('forbidden'); e.statusCode = 403; throw e; }
    await query(`DELETE FROM tenancy.groups WHERE id = $1`, [id]);
    return { deleted: id };
  });

  // =====================================================================
  // Topics (ADR-017 vN, #11) — knowledge-base topics for document tagging
  // and topic-scope share grants.
  // =====================================================================
  routes.set('GET /api/sharing/topics', async (req) => {
    requireBoardMember(req);
    const principal = await principalFor(req, withViewer);
    if (!principal?.readOrgIds?.length) return { topics: [] };
    const r = await query(
      `SELECT t.id, t.slug, t.name, t.description, t.owner_org_id, t.created_at,
              (SELECT count(*)::int FROM content.document_topics dt WHERE dt.topic_id = t.id) AS doc_count,
              (SELECT count(*)::int FROM content.wiki_page_topics wpt WHERE wpt.topic_id = t.id) AS wiki_count
         FROM content.kb_topics t
        WHERE t.owner_org_id = ANY($1::uuid[])
        ORDER BY t.name`,
      [principal.readOrgIds],
    );
    return { topics: r.rows };
  });

  routes.set('POST /api/sharing/topics', async (req, body) => {
    const actorId = requireBoardMember(req);
    const principal = await principalFor(req, withViewer);
    const { name, slug, description = null, owner_org_id } = body || {};
    if (!name || !slug) {
      const e = new Error('name and slug required'); e.statusCode = 400; throw e;
    }
    const orgId = owner_org_id || principal?.readOrgIds?.[0];
    if (!orgId || !principal?.readOrgIds?.includes(orgId)) {
      const e = new Error('forbidden — not a member of owner_org_id'); e.statusCode = 403; throw e;
    }
    const r = await query(
      `INSERT INTO content.kb_topics (slug, name, description, owner_org_id, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [slug, name, description, orgId, actorId],
    );
    return { topic: r.rows[0] };
  });

  routes.set('POST /api/sharing/topics/:id/assign', async (req, body) => {
    const actorId = requireBoardMember(req);
    const principal = await principalFor(req, withViewer);
    const topicId = parsePathId(req, -2);
    const docIds = Array.isArray(body?.document_ids) ? body.document_ids : [];
    const wikiIds = Array.isArray(body?.wiki_page_ids) ? body.wiki_page_ids : [];
    if (!topicId || (docIds.length === 0 && wikiIds.length === 0)) {
      const e = new Error('topic id + (document_ids or wiki_page_ids) required'); e.statusCode = 400; throw e;
    }

    // OPT-166 P3-B3: content.documents is RLS-enforced (touched via the
    // EXISTS check in the docIds loop below); kb_topics/document_topics/
    // wiki_pages/wiki_page_topics are not, but ride the same scoped
    // connection for this handler's lifecycle.
    // Board-only route (requireBoardMember guard throws before any query) →
    // unconditional board scope.
    const scopedQuery = await withBoardScope(req.auth);
    let added = 0;
    try {
      const t = await scopedQuery(`SELECT owner_org_id FROM content.kb_topics WHERE id = $1`, [topicId]);
      if (t.rows.length === 0) { const e = new Error('topic not found'); e.statusCode = 404; throw e; }
      if (!principal?.readOrgIds?.includes(t.rows[0].owner_org_id)) {
        const e = new Error('forbidden'); e.statusCode = 403; throw e;
      }
      for (const did of docIds) {
        const r = await scopedQuery(
          `INSERT INTO content.document_topics (document_id, topic_id, added_by)
           SELECT $1, $2, $3
            WHERE EXISTS (SELECT 1 FROM content.documents WHERE id = $1
                            AND (owner_id = $3 OR (owner_id IS NULL AND owner_org_id = $4)))
           ON CONFLICT (document_id, topic_id) DO NOTHING
           RETURNING document_id`,
          [did, topicId, actorId, t.rows[0].owner_org_id],
        );
        added += r.rows.length;
      }
      for (const wid of wikiIds) {
        const r = await scopedQuery(
          `INSERT INTO content.wiki_page_topics (wiki_page_id, topic_id, added_by)
           SELECT $1, $2, $3
            WHERE EXISTS (SELECT 1 FROM content.wiki_pages WHERE id = $1
                            AND (owner_id = $3 OR (owner_id IS NULL AND owner_org_id = $4)))
           ON CONFLICT (wiki_page_id, topic_id) DO NOTHING
           RETURNING wiki_page_id`,
          [wid, topicId, actorId, t.rows[0].owner_org_id],
        );
        added += r.rows.length;
      }
    } finally {
      await scopedQuery.release();
    }
    return { added };
  });

  routes.set('DELETE /api/sharing/topics/:id', async (req) => {
    const actorId = requireBoardMember(req);
    const id = parsePathId(req, -1);
    const t = await query(`SELECT owner_org_id, created_by FROM content.kb_topics WHERE id = $1`, [id]);
    if (t.rows.length === 0) { const e = new Error('not found'); e.statusCode = 404; throw e; }
    const isCreator = t.rows[0].created_by === actorId;
    const isAdmin = await query(
      `SELECT 1 FROM tenancy.memberships WHERE user_id = $1 AND org_id = $2 AND role IN ('owner','admin') LIMIT 1`,
      [actorId, t.rows[0].owner_org_id],
    );
    if (!isCreator && isAdmin.rows.length === 0) { const e = new Error('forbidden'); e.statusCode = 403; throw e; }
    await query(`DELETE FROM content.kb_topics WHERE id = $1`, [id]);
    return { deleted: id };
  });

  // =====================================================================
  // Sharing metrics (#12 / governance panel)
  // =====================================================================
  routes.set('GET /api/sharing/metrics', async (req) => {
    requireBoardMember(req);
    const principal = await principalFor(req, withViewer);
    if (!principal?.readOrgIds?.length) {
      return { lifecycle: [], usage: [], top_grants: [], summary: {} };
    }
    const url = new URL(req.url, 'http://localhost');
    const days = Math.max(1, Math.min(90, parseInt(url.searchParams.get('days') || '30', 10)));
    const since = `now() - interval '${days} days'`;

    // Lifecycle counts (per day, per status) — bounded to grants where the
    // caller's orgs are on either side.
    const lifecycle = await query(
      `SELECT date_trunc('day', created_at)::date AS day,
              status,
              count(*)::int AS n
         FROM tenancy.share_grants
        WHERE (granter_org_id = ANY($1::uuid[]) OR target_org_id = ANY($1::uuid[]))
          AND created_at >= ${since}
        GROUP BY 1, 2
        ORDER BY 1 DESC, 2`,
      [principal.readOrgIds],
    );

    // Per-retrieval audit usage (per day) for grants involving caller's orgs.
    let usage = { rows: [] };
    try {
      usage = await query(
        `SELECT d.day::date AS day, sum(d.retrieval_count)::int AS retrievals,
                sum(d.distinct_callers)::int AS callers,
                sum(d.distinct_docs)::int AS docs
           FROM audit.shared_doc_retrievals_daily d
           JOIN tenancy.share_grants g ON g.id = d.grant_id
          WHERE (g.granter_org_id = ANY($1::uuid[]) OR g.target_org_id = ANY($1::uuid[]))
            AND d.day >= ${since}
          GROUP BY 1
          ORDER BY 1 DESC`,
        [principal.readOrgIds],
      );
    } catch (err) {
      // Audit view may be missing on older databases — fall through.
      if (!/relation .* does not exist/i.test(err.message)) throw err;
    }

    // Top grants by retrieval count.
    let topGrants = { rows: [] };
    try {
      topGrants = await query(
        `SELECT g.id, g.granter_type, g.granter_id, g.target_type, g.target_id,
                g.scope_type, g.status,
                sum(d.retrieval_count)::int AS retrievals
           FROM audit.shared_doc_retrievals_daily d
           JOIN tenancy.share_grants g ON g.id = d.grant_id
          WHERE (g.granter_org_id = ANY($1::uuid[]) OR g.target_org_id = ANY($1::uuid[]))
            AND d.day >= ${since}
          GROUP BY g.id
          ORDER BY retrievals DESC
          LIMIT 10`,
        [principal.readOrgIds],
      );
    } catch (err) {
      if (!/relation .* does not exist/i.test(err.message)) throw err;
    }

    // Summary cards.
    const summary = await query(
      `SELECT
         count(*) FILTER (WHERE status = 'active')::int                     AS active_total,
         count(*) FILTER (WHERE status = 'pending')::int                    AS pending_total,
         count(*) FILTER (WHERE status = 'active'
                          AND granter_type='org' AND target_type='org')::int AS org_to_org,
         avg(EXTRACT(EPOCH FROM (accepted_at - created_at))) FILTER (
           WHERE accepted_at IS NOT NULL AND requires_acceptance
             AND created_at >= ${since}
         )::int AS avg_accept_seconds
         FROM tenancy.share_grants
        WHERE (granter_org_id = ANY($1::uuid[]) OR target_org_id = ANY($1::uuid[]))`,
      [principal.readOrgIds],
    );

    return {
      lifecycle: lifecycle.rows,
      usage: usage.rows,
      top_grants: topGrants.rows,
      summary: summary.rows[0] || {},
      window_days: days,
    };
  });

  routes.set('POST /api/sharing/principals/resolve', async (req, body) => {
    requireBoardMember(req);
    const input = Array.isArray(body?.principals) ? body.principals : [];
    if (input.length === 0) return { principals: [] };

    const userIds = input.filter((p) => p.type === 'user').map((p) => p.id);
    const orgIds = input.filter((p) => p.type === 'org').map((p) => p.id);
    const groupIds = input.filter((p) => p.type === 'group').map((p) => p.id);

    const [users, orgs, groups] = await Promise.all([
      userIds.length === 0
        ? Promise.resolve({ rows: [] })
        : query(
            `SELECT id, github_username, display_name, email
               FROM agent_graph.board_members
              WHERE id = ANY($1::uuid[])`,
            [userIds],
          ),
      orgIds.length === 0
        ? Promise.resolve({ rows: [] })
        : query(
            `SELECT id, slug, name FROM tenancy.orgs WHERE id = ANY($1::uuid[])`,
            [orgIds],
          ),
      groupIds.length === 0
        ? Promise.resolve({ rows: [] })
        : query(
            `SELECT id, slug, name FROM tenancy.groups WHERE id = ANY($1::uuid[])`,
            [groupIds],
          ),
    ]);
    const userMap = new Map(users.rows.map((r) => [r.id, r]));
    const orgMap  = new Map(orgs.rows.map((r) => [r.id, r]));
    const groupMap = new Map(groups.rows.map((r) => [r.id, r]));

    const out = input.map((p) => {
      if (p.type === 'user') {
        const u = userMap.get(p.id);
        return {
          type: 'user', id: p.id,
          name: u?.display_name || u?.github_username || null,
          slug: u?.github_username || null,
          email: u?.email || null,
        };
      }
      if (p.type === 'org') {
        const o = orgMap.get(p.id);
        return { type: 'org', id: p.id, name: o?.name || null, slug: o?.slug || null, email: null };
      }
      if (p.type === 'group') {
        const g = groupMap.get(p.id);
        return { type: 'group', id: p.id, name: g?.name || null, slug: g?.slug || null, email: null };
      }
      return { type: p.type, id: p.id, name: null, slug: null, email: null };
    });
    return { principals: out };
  });
}
