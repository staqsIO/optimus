import { query } from '../db.js';
import { pollResearchSources } from '../research/research-source-poller.js';
import { visibleClause } from '../../../lib/tenancy/scope.js';

function requireBoard(req) {
  if (!req.auth || req.auth.role !== 'board') {
    const e = new Error('Board authentication required');
    e.statusCode = 401;
    throw e;
  }
}

export function registerFeedRoutes(routes, { withViewer } = {}) {
  // STAQPRO-608 r2a: content.research_sources carries owner_org_id (migration
  // 149, backfilled via project_id -> agent_graph.projects; NULL-project shared
  // KB rows -> Staqs). The list read scopes on it fail-closed. withViewer is
  // injected by api.js; absent/throwing → null principal → visibleClause emits
  // FALSE → zero rows, never an unscoped read.
  const resolvePrincipalFor = async (req) => {
    if (!withViewer) return null;
    try {
      return (await withViewer(req)).principal;
    } catch {
      return null;
    }
  };

  const listSubscriptions = async (req) => {
    requireBoard(req);
    const url = new URL(req.url, 'http://localhost');
    const projectSlug = url.searchParams.get('project_slug');
    const conditions = [];
    const params = [];
    if (projectSlug) {
      const p = await query(`SELECT id FROM agent_graph.projects WHERE slug = $1`, [projectSlug]);
      if (p.rows.length === 0) {
        const e = new Error('Project not found');
        e.statusCode = 404;
        throw e;
      }
      params.push(p.rows[0].id);
      conditions.push(`fs.project_id::text = $${params.length}::text`);
    }

    // Tenancy scope (fail-closed): owner_org_id ∈ visible orgs.
    const principal = await resolvePrincipalFor(req);
    const v = visibleClause(principal, { ownerOrgCol: 'fs.owner_org_id', startIndex: params.length + 1 });
    conditions.push(v.sql);
    params.push(...v.params);

    const rows = await query(
      `SELECT fs.*, p.slug AS project_slug, p.name AS project_name
       FROM content.research_sources fs
       LEFT JOIN agent_graph.projects p ON p.id::text = fs.project_id::text
       WHERE ${conditions.join(' AND ')}
       ORDER BY fs.created_at DESC`,
      params
    );
    return { subscriptions: rows.rows };
  };

  const upsertSubscription = async (req, body) => {
    requireBoard(req);
    const {
      url,
      topic_query: topicQuery,
      source_mode: sourceModeRaw,
      title,
      project_slug: projectSlug,
      tags,
      poll_interval_ms: pollIntervalMs,
      max_items_per_poll: maxItemsPerPoll,
      is_active: isActive,
    } = body || {};
    const sourceMode = sourceModeRaw === 'topic_search' ? 'topic_search' : 'url_watch';
    if (sourceMode === 'url_watch' && (!url || !/^https?:\/\//i.test(String(url)))) {
      const e = new Error('Valid https URL is required for url_watch mode');
      e.statusCode = 400;
      throw e;
    }
    if (sourceMode === 'topic_search' && (!topicQuery || !String(topicQuery).trim())) {
      const e = new Error('topic_query is required for topic_search mode');
      e.statusCode = 400;
      throw e;
    }
    let projectId = null;
    if (projectSlug) {
      const p = await query(`SELECT id FROM agent_graph.projects WHERE slug = $1`, [projectSlug]);
      if (p.rows.length === 0) {
        const e = new Error('Project not found');
        e.statusCode = 404;
        throw e;
      }
      projectId = p.rows[0].id;
    }
    const actor = req.auth?.github_username || req.headers?.['x-board-user'] || 'unknown';
    const cleanUrl = url ? String(url).trim() : null;
    const cleanQuery = topicQuery ? String(topicQuery).trim() : null;
    const existing = await query(
      `SELECT id FROM content.research_sources
       WHERE COALESCE(project_id, '') = COALESCE($1, '')
         AND source_mode = $2
         AND COALESCE(url, '') = COALESCE($3, '')
         AND COALESCE(topic_query, '') = COALESCE($4, '')
       LIMIT 1`,
      [projectId, sourceMode, cleanUrl, cleanQuery]
    );
    const params = [
      projectId,
      cleanUrl,
      sourceMode,
      cleanQuery,
      title || null,
      JSON.stringify(Array.isArray(tags) ? tags : []),
      pollIntervalMs || null,
      maxItemsPerPoll || null,
      isActive,
      actor,
    ];
    if (existing.rows.length > 0) {
      const updated = await query(
        `UPDATE content.research_sources
         SET title = COALESCE($5, title),
             tags = $6,
             poll_interval_ms = COALESCE($7, poll_interval_ms),
             max_items_per_poll = COALESCE($8, max_items_per_poll),
             is_active = COALESCE($9, is_active),
             updated_by = $10,
             updated_at = now()
         WHERE id = $11
         RETURNING *`,
        [...params, existing.rows[0].id]
      );
      return { subscription: updated.rows[0] };
    }
    const inserted = await query(
      `INSERT INTO content.research_sources
         (project_id, url, source_mode, topic_query, title, tags, poll_interval_ms, max_items_per_poll, is_active, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 900000), COALESCE($8, 20), COALESCE($9, true), $10, $10)
       RETURNING *`,
      params
    );
    return { subscription: inserted.rows[0] };
  };

  const deleteSubscription = async (req) => {
    requireBoard(req);
    const url = new URL(req.url, 'http://localhost');
    const id = url.searchParams.get('id');
    if (!id) {
      const e = new Error('id required');
      e.statusCode = 400;
      throw e;
    }
    const result = await query(
      `DELETE FROM content.research_sources WHERE id = $1 RETURNING id`,
      [id]
    );
    if (result.rows.length === 0) {
      const e = new Error('Subscription not found');
      e.statusCode = 404;
      throw e;
    }
    return { ok: true, id };
  };

  const patchSubscription = async (req, body) => {
    requireBoard(req);
    const id = body?.id;
    if (!id) {
      const e = new Error('id required');
      e.statusCode = 400;
      throw e;
    }
    const actor = req.auth?.github_username || req.headers?.['x-board-user'] || 'unknown';
    const updates = [];
    const params = [id];
    let idx = 2;

    if (body?.title !== undefined) {
      updates.push(`title = $${idx++}`);
      params.push(body.title || null);
    }
    if (body?.tags !== undefined) {
      updates.push(`tags = $${idx++}`);
      params.push(JSON.stringify(Array.isArray(body.tags) ? body.tags : []));
    }
    if (body?.is_active !== undefined) {
      updates.push(`is_active = $${idx++}`);
      params.push(!!body.is_active);
    }
    if (body?.max_items_per_poll !== undefined) {
      updates.push(`max_items_per_poll = $${idx++}`);
      params.push(Math.max(1, Math.min(100, Number(body.max_items_per_poll) || 20)));
    }
    if (body?.poll_interval_ms !== undefined) {
      updates.push(`poll_interval_ms = $${idx++}`);
      params.push(Math.max(60_000, Number(body.poll_interval_ms) || 900_000));
    }
    if (updates.length === 0) return { ok: true, message: 'Nothing to update' };

    const result = await query(
      `UPDATE content.research_sources
       SET ${updates.join(', ')}, updated_by = $${idx}, updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [...params, actor]
    );
    if (result.rows.length === 0) {
      const e = new Error('Subscription not found');
      e.statusCode = 404;
      throw e;
    }
    return { subscription: result.rows[0] };
  };

  const pollSources = async (req, body) => {
    requireBoard(req);
    const id = body?.id || null;
    const projectSlug = body?.project_slug || null;
    const maxItems = Number(body?.max_items || 20);
    let projectId = null;
    if (projectSlug) {
      const p = await query(`SELECT id FROM agent_graph.projects WHERE slug = $1`, [projectSlug]);
      if (p.rows.length === 0) {
        const e = new Error('Project not found');
        e.statusCode = 404;
        throw e;
      }
      projectId = p.rows[0].id;
    }
    const result = await pollResearchSources({
      subscriptionId: id,
      projectId,
      maxItems: Number.isFinite(maxItems) ? Math.max(1, Math.min(100, maxItems)) : 20,
      force: true,
      autoCompileWiki: body?.auto_compile_wiki,
    });
    return result;
  };

  // Backward compatible route names: /api/feeds/* and /api/research-sources/*
  const bases = ['/api/feeds', '/api/research-sources'];
  for (const base of bases) {
    routes.set(`GET ${base}/subscriptions`, listSubscriptions);
    routes.set(`POST ${base}/subscriptions`, upsertSubscription);
    routes.set(`DELETE ${base}/subscriptions`, deleteSubscription);
    routes.set(`PATCH ${base}/subscriptions`, patchSubscription);
    routes.set(`POST ${base}/poll`, pollSources);
  }
}
