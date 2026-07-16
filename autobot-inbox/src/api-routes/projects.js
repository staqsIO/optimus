/**
 * Projects API routes.
 *
 * GET  /api/projects              — list all projects
 * GET  /api/projects/:slug        — project detail with stats
 * POST /api/projects              — create a project
 * PATCH /api/projects/:slug       — update project (name, description, instructions, settings)
 * POST /api/projects/:slug/members — add entity to project
 * DELETE /api/projects/:slug/members — remove entity from project
 * GET  /api/projects/:slug/memory — get active project memory
 * POST /api/projects/:slug/memory — write project memory entry
 */

import { query, withBoardScope } from '../db.js';
import { writerOrgId } from '../../../lib/tenancy/owner-stamp.js';
import { visibleClause } from '../../../lib/tenancy/scope.js';
import { createWorkItem } from '../runtime/state-machine.js';
import {
  extractWikilinks,
  parseWikiSignalAssessmentMarkdown,
  toSlug as wikiTargetSlug,
} from '../../../lib/wiki/compiler.js';
import {
  pickResolvedWikiCandidate,
  wikiBacklinkRegexPatterns,
} from '../../../lib/wiki/wikilink-resolve.js';

// Linus: sanitize instructions on write
let sanitize;
async function loadSanitizer() {
  if (!sanitize) {
    const mod = await import('../../lib/runtime/sanitizer.js');
    sanitize = mod.sanitize;
  }
}

function toSlug(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120) || 'page';
}

async function seedProjectWikiTemplate(project, createdBy) {
  const rootContent = [
    `# ${project.name}`,
    '',
    '## Table of Contents',
    '- [[overview]]',
    '- [[decisions]]',
    '- [[meetings]]',
    '- [[contacts]]',
    '- [[processes]]',
    '- [[research]]',
  ].join('\n');
  const overviewContent = [
    `# ${project.name} Overview`,
    '',
    project.description || 'Project summary pending.',
    '',
    '## Goals',
    '- Define goals and scope.',
    '',
    '## Status',
    '- Add current status and blockers.',
  ].join('\n');
  const folderNames = ['decisions', 'meetings', 'contacts', 'processes', 'research'];

  const rootR = await query(
    `INSERT INTO content.wiki_pages (project_id, parent_id, slug, title, content, is_index, created_by, updated_by)
     VALUES ($1, NULL, 'index', $2, $3, true, $4, $4)
     ON CONFLICT (project_id, slug) DO UPDATE SET title = EXCLUDED.title
     RETURNING id`,
    [project.id, `${project.name} Index`, rootContent, createdBy]
  );
  const rootId = rootR.rows[0].id;

  await query(
    `INSERT INTO content.wiki_pages (project_id, parent_id, slug, title, content, is_index, created_by, updated_by)
     VALUES ($1, $2, 'overview', $3, $4, false, $5, $5)
     ON CONFLICT (project_id, slug) DO NOTHING`,
    [project.id, rootId, `${project.name} Overview`, overviewContent, createdBy]
  );

  for (const folder of folderNames) {
    const content = `# ${folder[0].toUpperCase()}${folder.slice(1)}\n\n## Contents\n- Add pages here.`;
    await query(
      `INSERT INTO content.wiki_pages (project_id, parent_id, slug, title, content, is_index, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, true, $6, $6)
       ON CONFLICT (project_id, slug) DO NOTHING`,
      [project.id, rootId, folder, `${project.name} ${folder}`, content, createdBy]
    );
  }
}

async function hasAnyWikiPage(projectId) {
  const r = await query(
    `SELECT 1 FROM content.wiki_pages WHERE project_id::text = $1::text LIMIT 1`,
    [projectId]
  );
  return r.rows.length > 0;
}

export function registerProjectRoutes(routes, { withViewer } = {}) {

  // Resolve the tenancy principal for write routes (STAQPRO-593 owner-stamp).
  // withViewer is injected by api.js; absent/throw → null → column DEFAULT applies.
  const resolvePrincipalFor = async (req) => {
    if (!withViewer) return null;
    try {
      return (await withViewer(req)).principal;
    } catch {
      return null;
    }
  };

  // GET /api/projects — list all projects with entity counts
  routes.set('GET /api/projects', async (req) => {
    // STAQPRO-608 (596-class): agent_graph.projects carries owner_org_id
    // (migration 138). Scope fail-closed so one org's projects never enumerate
    // to another. owner_user_id is intentionally NULL on existing rows (mig 138
    // header) so we scope on the org axis only.
    const principal = await resolvePrincipalFor(req);
    const v = visibleClause(principal, { ownerOrgCol: 'p.owner_org_id', startIndex: 1 });
    const result = await query(`
      SELECT p.*,
        (SELECT count(*) FROM agent_graph.project_memberships pm
         WHERE pm.project_id = p.id AND pm.entity_type = 'chat_session') AS chat_count,
        (SELECT count(*) FROM agent_graph.project_memberships pm
         WHERE pm.project_id = p.id AND pm.entity_type = 'campaign') AS campaign_count,
        (SELECT count(*) FROM agent_graph.project_memberships pm
         WHERE pm.project_id = p.id AND pm.entity_type = 'document') AS document_count,
        (SELECT count(*) FROM agent_graph.project_memberships pm
         WHERE pm.project_id = p.id AND pm.entity_type = 'contact') AS contact_count
      FROM agent_graph.projects p
      WHERE ${v.sql}
      ORDER BY p.updated_at DESC
    `, v.params);
    return { projects: result.rows };
  });

  // GET /api/projects/:slug — project detail
  routes.set('GET /api/projects/detail', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const slug = url.searchParams.get('slug');
    if (!slug) { const e = new Error('slug required'); e.statusCode = 400; throw e; }

    // STAQPRO-608: gate the anchor project fail-closed. A non-visible project
    // returns the same 404 a missing slug produces (no enumeration oracle); the
    // sub-queries below are anchored on project.id and only run after this passes.
    // OPT-166 P3: content.documents (files query below) is RLS-enforced (§1
    // table list) + this route is authed-any — non-board principals keep the
    // legacy pool (INERT pre-flip; RLS fail-closed post-flip); board
    // principals get a scoped session. `principal` is still resolved for the
    // pre-existing visibleClause() filter below (unrelated to scoping).
    const principal = await resolvePrincipalFor(req);
    const boardScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
    const scopedQuery = boardScope ?? query;
    let project, counts, memory, recentMembers, files;
    try {
      const dv = visibleClause(principal, { ownerOrgCol: 'owner_org_id', startIndex: 2 });
      const result = await scopedQuery(
        `SELECT * FROM agent_graph.projects WHERE slug = $1 AND ${dv.sql}`, [slug, ...dv.params]
      );
      if (result.rows.length === 0) { const e = new Error('Project not found'); e.statusCode = 404; throw e; }
      project = result.rows[0];

      // Get membership counts by type
      counts = await scopedQuery(
        `SELECT entity_type, count(*) AS count
         FROM agent_graph.project_memberships WHERE project_id = $1
         GROUP BY entity_type`,
        [project.id]
      );

      // Get active memory
      memory = await scopedQuery(
        `SELECT key, value, written_by, created_at
         FROM agent_graph.project_memory
         WHERE project_id = $1 AND superseded_by IS NULL
         ORDER BY created_at DESC`,
        [project.id]
      );

      // Get recent members (last 10 added)
      recentMembers = await scopedQuery(
        `SELECT pm.entity_type, pm.entity_id, pm.added_by, pm.added_at
         FROM agent_graph.project_memberships pm
         WHERE pm.project_id = $1
         ORDER BY pm.added_at DESC LIMIT 20`,
        [project.id]
      );

      // Get project files (documents linked via memberships).
      // STAQPRO-545: entity_id is TEXT, d.id is UUID. The previous join cast the
      // documents PK to text (d.id::text = pm.entity_id), which disabled
      // content.documents_pkey and sequentially scanned all ~6k docs per row
      // (the 60s load). Cast the SMALL membership side instead (pm.entity_id::uuid)
      // so the planner uses the PK index. Document entity_ids are always UUID
      // strings (entity_id holds content.documents.id), so the cast is safe; the
      // entity_type='document' filter also runs first via the new composite index
      // idx_project_memberships_project_type_added (migration 131).
      // STAQPRO-545: cap the file list. The Staqs project links 6,523 documents;
      // returning every row took ~15s (the dominant chunk of the 60s load) and the
      // board rendered all of them at once. The Documents counter comes from `counts`
      // (above), so the full list isn't needed to show the total. Return the most
      // recent FILE_PAGE_SIZE files plus a fileCount for the UI to indicate "+N more".
      const FILE_PAGE_SIZE = 100;
      files = await scopedQuery(
        `SELECT pm.entity_id AS document_id, d.title AS filename,
                pm.added_at AS uploaded_at, pm.added_by
         FROM agent_graph.project_memberships pm
         LEFT JOIN content.documents d ON d.id = pm.entity_id::uuid
         WHERE pm.project_id = $1 AND pm.entity_type = 'document'
         ORDER BY pm.added_at DESC
         LIMIT $2`,
        [project.id, FILE_PAGE_SIZE]
      );
    } finally {
      if (boardScope) await boardScope.release();
    }

    const countsMap = Object.fromEntries(counts.rows.map(r => [r.entity_type, parseInt(r.count)]));
    return {
      project,
      counts: countsMap,
      memory: memory.rows,
      recentMembers: recentMembers.rows,
      files: files.rows,
      fileCount: countsMap.document || 0,
      filesTruncated: (countsMap.document || 0) > files.rows.length,
    };
  });

  // POST /api/projects — create a project
  routes.set('POST /api/projects', async (req, body) => {
    if (!body?.name || !body?.slug) {
      const e = new Error('name and slug are required'); e.statusCode = 400; throw e;
    }

    // Sanitize slug
    const slug = body.slug.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 50);

    // Sanitize instructions if provided (Linus: sanitize on write)
    let instructions = body.instructions || null;
    if (instructions) {
      await loadSanitizer();
      if (sanitize) instructions = sanitize(instructions);
      if (instructions.length > 4096) instructions = instructions.slice(0, 4096);
    }

    const boardUser = req.headers?.['x-board-user'] || 'unknown';
    // Owner-stamp from the caller's org (STAQPRO-593). null → column DEFAULT.
    const ownerOrgId = writerOrgId(await resolvePrincipalFor(req));
    const result = await query(
      `INSERT INTO agent_graph.projects (slug, name, description, instructions, settings, classification_floor, created_by, owner_org_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        slug,
        body.name,
        body.description || null,
        instructions,
        JSON.stringify(body.settings || {}),
        body.classification_floor || 'INTERNAL',
        boardUser,
        ownerOrgId,
      ]
    );

    const project = result.rows[0];
    await seedProjectWikiTemplate(project, boardUser);
    return { project };
  });

  // POST /api/wiki/backfill-templates — seed default wiki pages for existing projects
  routes.set('POST /api/wiki/backfill-templates', async (req) => {
    const boardUser = req.headers?.['x-board-user'] || 'unknown';
    const projectsR = await query(`SELECT id, slug, name, description FROM agent_graph.projects ORDER BY created_at ASC`);
    let seeded = 0;
    let skipped = 0;
    for (const p of projectsR.rows) {
      const exists = await hasAnyWikiPage(p.id);
      if (exists) {
        skipped++;
        continue;
      }
      await seedProjectWikiTemplate(p, boardUser);
      seeded++;
    }
    return { ok: true, total: projectsR.rows.length, seeded, skipped };
  });

  // PATCH /api/projects/:slug — update project
  routes.set('PATCH /api/projects', async (req, body) => {
    const url = new URL(req.url, 'http://localhost');
    const slug = url.searchParams.get('slug') || body?.slug;
    if (!slug) { const e = new Error('slug required'); e.statusCode = 400; throw e; }

    const updates = [];
    const params = [slug];
    let paramIdx = 2;

    if (body.name) { updates.push(`name = $${paramIdx++}`); params.push(body.name); }
    if (body.description !== undefined) { updates.push(`description = $${paramIdx++}`); params.push(body.description); }
    if (body.instructions !== undefined) {
      let inst = body.instructions;
      if (inst) {
        await loadSanitizer();
        if (sanitize) inst = sanitize(inst);
        if (inst.length > 4096) inst = inst.slice(0, 4096);
      }
      updates.push(`instructions = $${paramIdx++}`);
      params.push(inst);
    }
    if (body.settings) { updates.push(`settings = $${paramIdx++}`); params.push(JSON.stringify(body.settings)); }
    if (body.classification_floor) { updates.push(`classification_floor = $${paramIdx++}`); params.push(body.classification_floor); }

    if (updates.length === 0) { return { ok: true, message: 'Nothing to update' }; }

    updates.push('updated_at = now()');
    const result = await query(
      `UPDATE agent_graph.projects SET ${updates.join(', ')} WHERE slug = $1 RETURNING *`,
      params
    );

    return { project: result.rows[0] };
  });

  // POST /api/projects/:slug/members — add entity to project
  routes.set('POST /api/projects/members', async (req, body) => {
    if (!body?.slug || !body?.entity_type || !body?.entity_id) {
      const e = new Error('slug, entity_type, and entity_id required'); e.statusCode = 400; throw e;
    }

    const project = await query(`SELECT id FROM agent_graph.projects WHERE slug = $1`, [body.slug]);
    if (project.rows.length === 0) { const e = new Error('Project not found'); e.statusCode = 404; throw e; }

    const boardUser = req.headers?.['x-board-user'] || 'unknown';
    await query(
      `INSERT INTO agent_graph.project_memberships (project_id, entity_type, entity_id, added_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (project_id, entity_type, entity_id) DO NOTHING`,
      [project.rows[0].id, body.entity_type, body.entity_id, boardUser]
    );

    return { ok: true };
  });

  // DELETE /api/projects/:slug/members — remove entity from project
  // Accepts params via body OR query string (board proxy sends DELETE without body)
  routes.set('DELETE /api/projects/members', async (req, body) => {
    const url = new URL(req.url, 'http://localhost');
    const slug = body?.slug || url.searchParams.get('slug');
    const entityType = body?.entity_type || url.searchParams.get('entity_type');
    const entityId = body?.entity_id || url.searchParams.get('entity_id');

    if (!slug || !entityType || !entityId) {
      const e = new Error('slug, entity_type, and entity_id required'); e.statusCode = 400; throw e;
    }

    const project = await query(`SELECT id FROM agent_graph.projects WHERE slug = $1`, [slug]);
    if (project.rows.length === 0) { const e = new Error('Project not found'); e.statusCode = 404; throw e; }

    await query(
      `DELETE FROM agent_graph.project_memberships
       WHERE project_id = $1 AND entity_type = $2 AND entity_id = $3`,
      [project.rows[0].id, entityType, entityId]
    );

    return { ok: true };
  });

  // GET /api/projects/:slug/memory — get active memory entries
  routes.set('GET /api/projects/memory', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const slug = url.searchParams.get('slug');
    if (!slug) { const e = new Error('slug required'); e.statusCode = 400; throw e; }

    const project = await query(`SELECT id FROM agent_graph.projects WHERE slug = $1`, [slug]);
    if (project.rows.length === 0) { const e = new Error('Project not found'); e.statusCode = 404; throw e; }

    const result = await query(
      `SELECT * FROM agent_graph.project_memory_active($1)`,
      [project.rows[0].id]
    );

    return { memory: result.rows };
  });

  // POST /api/projects/:slug/memory — write a memory entry (append-only)
  routes.set('POST /api/projects/memory', async (req, body) => {
    if (!body?.slug || !body?.key || !body?.value) {
      const e = new Error('slug, key, and value required'); e.statusCode = 400; throw e;
    }

    const project = await query(`SELECT id FROM agent_graph.projects WHERE slug = $1`, [body.slug]);
    if (project.rows.length === 0) { const e = new Error('Project not found'); e.statusCode = 404; throw e; }

    const boardUser = req.headers?.['x-board-user'] || body.written_by || 'unknown';
    const projectId = project.rows[0].id;

    // Supersede the previous entry for this key (if any)
    const newId = (await query(
      `INSERT INTO agent_graph.project_memory (project_id, key, value, written_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [projectId, body.key, body.value, boardUser]
    )).rows[0].id;

    // Mark old entries as superseded
    await query(
      `UPDATE agent_graph.project_memory
       SET superseded_by = $1
       WHERE project_id = $2 AND key = $3 AND id != $1 AND superseded_by IS NULL`,
      [newId, projectId, body.key]
    );

    return { ok: true, id: newId };
  });

  // ================================================================
  // WIKI PAGES (hierarchical markdown vault)
  // ================================================================

  // GET /api/wiki/pages — flat list of pages (optionally project-scoped, searchable)
  routes.set('GET /api/wiki/pages', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const projectSlug = url.searchParams.get('project_slug');
    const q = (url.searchParams.get('q') || '').trim();

    // OPT-166 P3: content.documents is RLS-enforced (§1 table list) and this route
    // is authed-any (route-tiers.js) — non-board principals keep the legacy
    // pool (INERT pre-flip; RLS fail-closed post-flip); board principals get
    // a scoped session.
    const boardScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
    const scopedQuery = boardScope ?? query;
    let result;
    try {
      let projectId = null;
      if (projectSlug) {
        const projectR = await scopedQuery(`SELECT id FROM agent_graph.projects WHERE slug = $1`, [projectSlug]);
        if (projectR.rows.length === 0) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
        projectId = projectR.rows[0].id;
      }
      const params = [];
      const where = [];
      if (projectId) {
        params.push(projectId);
        where.push(`wp.project_id::text = $${params.length}::text`);
      } else {
        where.push('wp.project_id IS NULL');
      }
      if (q) {
        params.push(`%${q}%`);
        where.push(`(wp.title ILIKE $${params.length} OR wp.content ILIKE $${params.length})`);
      }
      result = await scopedQuery(
        `SELECT wp.id, wp.project_id, wp.parent_id, wp.slug, wp.title, wp.content, wp.classification,
                wp.is_index, wp.compiled_at, wp.source_document_id, wp.created_by, wp.created_at, wp.updated_at,
                sd.updated_at AS source_updated_at,
                CASE
                  WHEN wp.source_document_id IS NOT NULL
                    AND wp.compiled_at IS NOT NULL
                    AND sd.updated_at > wp.compiled_at
                  THEN true
                  ELSE false
                END AS needs_update
         FROM content.wiki_pages wp
         LEFT JOIN content.documents sd ON sd.id::text = wp.source_document_id::text
         WHERE ${where.join(' AND ')}
         ORDER BY wp.is_index DESC, wp.title ASC`,
        params
      );
    } finally {
      if (boardScope) await boardScope.release();
    }
    return { pages: result.rows };
  });

  // GET /api/wiki/tree — hierarchy for sidebar
  routes.set('GET /api/wiki/tree', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const projectSlug = url.searchParams.get('project_slug');
    let projectId = null;
    if (projectSlug) {
      const projectR = await query(`SELECT id FROM agent_graph.projects WHERE slug = $1`, [projectSlug]);
      if (projectR.rows.length === 0) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
      projectId = projectR.rows[0].id;
    }
    const result = await query(
      `SELECT id, parent_id, slug, title, is_index, updated_at
       FROM content.wiki_pages
       WHERE ${projectId ? 'project_id::text = $1::text' : 'project_id IS NULL'}
       ORDER BY is_index DESC, title ASC`,
      projectId ? [projectId] : []
    );
    return { nodes: result.rows };
  });

  // GET /api/wiki/forest — org-wide pages + every project's wiki tree (universal wiki of projects)
  routes.set('GET /api/wiki/forest', async () => {
    const orgR = await query(
      `SELECT id, parent_id, slug, title, is_index, updated_at
       FROM content.wiki_pages
       WHERE project_id IS NULL
       ORDER BY is_index DESC, title ASC`
    );
    const projR = await query(`SELECT id, slug, name FROM agent_graph.projects ORDER BY name ASC`);
    const projects = [];
    for (const p of projR.rows) {
      const nodesR = await query(
        `SELECT id, parent_id, slug, title, is_index, updated_at
         FROM content.wiki_pages
         WHERE project_id::text = $1::text
         ORDER BY is_index DESC, title ASC`,
        [p.id]
      );
      projects.push({
        id: p.id,
        slug: p.slug,
        name: p.name,
        nodes: nodesR.rows,
      });
    }
    return { org_nodes: orgR.rows, projects };
  });

  // GET /api/wiki/page — get single page by id or slug (+ optional project_slug)
  routes.set('GET /api/wiki/page', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const id = url.searchParams.get('id');
    const slug = url.searchParams.get('slug');
    const projectSlug = url.searchParams.get('project_slug');
    if (!id && !slug) throw Object.assign(new Error('id or slug required'), { statusCode: 400 });

    // OPT-166 P3: content.documents is RLS-enforced (§1 table list) and this route
    // is authed-any (route-tiers.js) — non-board principals keep the legacy
    // pool (INERT pre-flip; RLS fail-closed post-flip); board principals get
    // a scoped session.
    const boardScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
    const scopedQuery = boardScope ?? query;
    let result;
    try {
      let projectId = null;
      if (projectSlug) {
        const projectR = await scopedQuery(`SELECT id FROM agent_graph.projects WHERE slug = $1`, [projectSlug]);
        if (projectR.rows.length === 0) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
        projectId = projectR.rows[0].id;
      }
      if (id) {
        result = await scopedQuery(
          `SELECT wp.*, sd.updated_at AS source_updated_at, p.slug AS project_slug, p.name AS project_name,
                  CASE
                    WHEN wp.source_document_id IS NOT NULL
                      AND wp.compiled_at IS NOT NULL
                      AND sd.updated_at > wp.compiled_at
                    THEN true ELSE false END AS needs_update
           FROM content.wiki_pages wp
           LEFT JOIN content.documents sd ON sd.id::text = wp.source_document_id::text
           LEFT JOIN agent_graph.projects p ON p.id::text = wp.project_id::text
           WHERE wp.id = $1`,
          [id]
        );
      } else {
        const where = projectId ? 'wp.project_id::text = $2::text' : 'wp.project_id IS NULL';
        result = await scopedQuery(
          `SELECT wp.*, sd.updated_at AS source_updated_at, p.slug AS project_slug, p.name AS project_name,
                  CASE
                    WHEN wp.source_document_id IS NOT NULL
                      AND wp.compiled_at IS NOT NULL
                      AND sd.updated_at > wp.compiled_at
                    THEN true ELSE false END AS needs_update
           FROM content.wiki_pages wp
           LEFT JOIN content.documents sd ON sd.id::text = wp.source_document_id::text
           LEFT JOIN agent_graph.projects p ON p.id::text = wp.project_id::text
           WHERE wp.slug = $1 AND ${where}
           LIMIT 1`,
          projectId ? [slug, projectId] : [slug]
        );
      }
      if (result.rows.length === 0) throw Object.assign(new Error('Wiki page not found'), { statusCode: 404 });
    } finally {
      if (boardScope) await boardScope.release();
    }
    const page = result.rows[0];
    const signal = parseWikiSignalAssessmentMarkdown(page.content || '');
    return { page, signal };
  });

  // POST /api/wiki/page — create page
  routes.set('POST /api/wiki/page', async (req, body) => {
    const { project_slug: projectSlug, parent_id: parentId, slug, title, content, is_index: isIndex } = body || {};
    if (!slug || !title || !content) throw Object.assign(new Error('slug, title, content required'), { statusCode: 400 });
    let projectId = null;
    if (projectSlug) {
      const projectR = await query(`SELECT id FROM agent_graph.projects WHERE slug = $1`, [projectSlug]);
      if (projectR.rows.length === 0) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
      projectId = projectR.rows[0].id;
    }
    const boardUser = req.headers?.['x-board-user'] || 'unknown';
    const result = await query(
      `INSERT INTO content.wiki_pages (project_id, parent_id, slug, title, content, is_index, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
       RETURNING *`,
      [projectId, parentId || null, toSlug(slug), title, content, !!isIndex, boardUser]
    );
    return { page: result.rows[0] };
  });

  // PATCH /api/wiki/page — edit page content/title
  routes.set('PATCH /api/wiki/page', async (req, body) => {
    const { id, title, content, parent_id: parentId, classification, compiled_at: compiledAt } = body || {};
    if (!id) throw Object.assign(new Error('id required'), { statusCode: 400 });
    const boardUser = req.headers?.['x-board-user'] || 'unknown';
    const updates = [];
    const params = [id];
    let idx = 2;
    if (title !== undefined) { updates.push(`title = $${idx++}`); params.push(title); }
    if (content !== undefined) { updates.push(`content = $${idx++}`); params.push(content); }
    if (parentId !== undefined) { updates.push(`parent_id = $${idx++}`); params.push(parentId); }
    if (classification !== undefined) { updates.push(`classification = $${idx++}`); params.push(classification); }
    if (compiledAt !== undefined) { updates.push(`compiled_at = $${idx++}`); params.push(compiledAt); }
    if (updates.length === 0) return { ok: true, message: 'Nothing to update' };
    const result = await query(
      `UPDATE content.wiki_pages
       SET ${updates.join(', ')}, updated_by = $${idx}, updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [...params, boardUser]
    );
    if (result.rows.length === 0) throw Object.assign(new Error('Wiki page not found'), { statusCode: 404 });
    return { page: result.rows[0] };
  });

  // POST /api/wiki/page/promote — create a work item from a wiki signal/page
  routes.set('POST /api/wiki/page/promote', async (req, body) => {
    const pageId = body?.id;
    const assignedToRaw = String(body?.assigned_to || 'architect').trim();
    const allowedAssignees = new Set(['architect', 'reviewer', 'executor-research', 'orchestrator']);
    const assignedTo = allowedAssignees.has(assignedToRaw) ? assignedToRaw : 'architect';
    if (!pageId) throw Object.assign(new Error('id required'), { statusCode: 400 });

    const pageR = await query(
      `SELECT wp.id, wp.slug, wp.title, wp.content, wp.project_id, p.slug AS project_slug, p.name AS project_name
       FROM content.wiki_pages wp
       LEFT JOIN agent_graph.projects p ON p.id::text = wp.project_id::text
       WHERE wp.id = $1
       LIMIT 1`,
      [pageId]
    );
    if (pageR.rows.length === 0) throw Object.assign(new Error('Wiki page not found'), { statusCode: 404 });
    const page = pageR.rows[0];

    const boardUser = req.headers?.['x-board-user'] || req.auth?.github_username || 'board';
    const item = await createWorkItem({
      type: 'task',
      title: `Wiki signal: ${page.title}`,
      description:
        `Review wiki signal and propose action.\n\n` +
        `Page: ${page.title}\n` +
        `Slug: ${page.slug}\n` +
        `Scope: ${page.project_name || page.project_slug || 'organization'}\n\n` +
        `Objective:\n` +
        `- Assess novelty and confidence.\n` +
        `- Identify concrete Optimus impact.\n` +
        `- Recommend next action (watch-only vs implement).\n`,
      createdBy: boardUser,
      assignedTo,
      priority: 2,
      routingClass: 'FULL',
      metadata: {
        source: 'wiki_promote',
        wiki_page_id: page.id,
        wiki_slug: page.slug,
        wiki_title: page.title,
        wiki_project_slug: page.project_slug || null,
        wiki_project_name: page.project_name || null,
        wiki_excerpt: String(page.content || '').slice(0, 4000),
      },
    });

    return { ok: true, work_item_id: item.id, assigned_to: assignedTo };
  });

  // GET /api/wiki/page/revisions — revision history for one page
  routes.set('GET /api/wiki/page/revisions', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const id = url.searchParams.get('id');
    if (!id) throw Object.assign(new Error('id required'), { statusCode: 400 });
    const rows = await query(
      `SELECT id, wiki_page_id, version, title, content, classification, parent_id, changed_by, change_type, created_at
       FROM content.wiki_page_revisions
       WHERE wiki_page_id = $1
       ORDER BY version DESC`,
      [id]
    );
    return { revisions: rows.rows };
  });

  // GET /api/wiki/page/tasks — work items linked to this wiki page
  routes.set('GET /api/wiki/page/tasks', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const id = url.searchParams.get('id');
    if (!id) throw Object.assign(new Error('id required'), { statusCode: 400 });

    // OPT-166 P3: agent_graph.work_items is RLS-enforced (§1 table list) and this route
    // is authed-any (route-tiers.js) — non-board principals keep the legacy
    // pool (INERT pre-flip; RLS fail-closed post-flip); board principals get
    // a scoped session.
    const boardScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
    const scopedQuery = boardScope ?? query;
    let rows;
    try {
      rows = await scopedQuery(
        `SELECT id, title, status, assigned_to, priority, created_at, updated_at
         FROM agent_graph.work_items
         WHERE metadata->>'wiki_page_id' = $1
         ORDER BY created_at DESC
         LIMIT 50`,
        [id]
      );
    } finally {
      if (boardScope) await boardScope.release();
    }
    return { tasks: rows.rows };
  });

  // GET /api/wiki/page/backlinks — pages that wikilink to this page (by slug)
  routes.set('GET /api/wiki/page/backlinks', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const id = url.searchParams.get('id');
    if (!id) throw Object.assign(new Error('id required'), { statusCode: 400 });
    const pageR = await query(`SELECT id, slug, title FROM content.wiki_pages WHERE id = $1`, [id]);
    if (pageR.rows.length === 0) throw Object.assign(new Error('Wiki page not found'), { statusCode: 404 });
    const { slug } = pageR.rows[0];
    const { exactClose, pipeOpen } = wikiBacklinkRegexPatterns(slug);
    const rows = await query(
      `SELECT wp.id, wp.slug, wp.title, p.slug AS project_slug
       FROM content.wiki_pages wp
       LEFT JOIN agent_graph.projects p ON p.id::text = wp.project_id::text
       WHERE wp.id::text <> $1::text
         AND (wp.content ~* $2 OR wp.content ~* $3)
       ORDER BY p.slug NULLS FIRST, wp.title ASC`,
      [id, exactClose, pipeOpen]
    );
    return { backlinks: rows.rows };
  });

  // GET /api/wiki/page/outlinks — [[wikilinks]] in this page’s body, with optional resolution to wiki_pages
  routes.set('GET /api/wiki/page/outlinks', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const id = url.searchParams.get('id');
    if (!id) throw Object.assign(new Error('id required'), { statusCode: 400 });
    const pageR = await query(
      `SELECT id, slug, title, content, project_id FROM content.wiki_pages WHERE id = $1`,
      [id]
    );
    if (pageR.rows.length === 0) throw Object.assign(new Error('Wiki page not found'), { statusCode: 404 });
    const row = pageR.rows[0];
    const rawTargets = extractWikilinks(row.content || '');
    const order = [];
    const seen = new Set();
    for (const raw of rawTargets) {
      const slugNorm = wikiTargetSlug(raw.trim());
      if (!slugNorm || seen.has(slugNorm)) continue;
      seen.add(slugNorm);
      order.push({ slugNorm, label: raw.trim() });
    }
    if (order.length === 0) return { outlinks: [] };

    const slugList = order.map((o) => o.slugNorm);
    const candR = await query(
      `SELECT wp.id, wp.slug, wp.title, wp.project_id, p.slug AS project_slug
       FROM content.wiki_pages wp
       LEFT JOIN agent_graph.projects p ON p.id::text = wp.project_id::text
       WHERE wp.slug = ANY($1::text[])`,
      [slugList]
    );
    const bySlug = new Map();
    for (const c of candR.rows) {
      const arr = bySlug.get(c.slug) || [];
      arr.push(c);
      bySlug.set(c.slug, arr);
    }
    const outlinks = order.map(({ slugNorm, label }) => {
      const candidates = bySlug.get(slugNorm) || [];
      const pick = pickResolvedWikiCandidate(candidates, row.project_id);
      return {
        slug: slugNorm,
        label,
        resolved: pick
          ? { id: pick.id, title: pick.title, slug: pick.slug, project_slug: pick.project_slug }
          : null,
      };
    });
    return { outlinks };
  });

  // DELETE /api/wiki/page — delete one wiki page (and descendants via FK cascade)
  routes.set('DELETE /api/wiki/page', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const id = url.searchParams.get('id');
    if (!id) throw Object.assign(new Error('id required'), { statusCode: 400 });
    const result = await query(
      `DELETE FROM content.wiki_pages
       WHERE id = $1
       RETURNING id`,
      [id]
    );
    if (result.rows.length === 0) throw Object.assign(new Error('Wiki page not found'), { statusCode: 404 });
    return { ok: true, deleted_id: id };
  });

  // ================================================================
  // WIKI COMPILATION ENDPOINTS
  // ================================================================

  // POST /api/projects/:slug/compile — trigger wiki compilation
  routes.set('POST /api/projects/compile', async (req, body) => {
    const slug = body?.slug;
    let projectId = null;

    // If slug provided, scope to that project. Otherwise compile globally.
    if (slug) {
      const project = await query(`SELECT id FROM agent_graph.projects WHERE slug = $1`, [slug]);
      if (project.rows.length > 0) projectId = project.rows[0].id;
      // If project not found, compile globally (don't error)
    }

    const { compileWiki, compileWikiAllPendingScopes } = await import('../../../lib/wiki/compiler.js');
    const batchSize = body?.maxArticles || 20;
    const maxBatches = body?.allPending ? 50 : 1; // allPending=true processes everything
    const writtenBy = req.headers?.['x-board-user'] || 'wiki-compiler';

    // Aggregate "pending" in the UI includes project-scoped documents, but compileWiki(projectId=null)
    // only sees org-wide rows (no project_memberships). When draining all pending, walk every scope.
    if (body?.allPending && !projectId) {
      const agg = await compileWikiAllPendingScopes({
        maxArticles: batchSize,
        maxBatchesPerScope: maxBatches,
        writtenBy,
      });
      return { compiled: agg.compiled, batches: agg.batches, results: agg.results };
    }

    const results = [];
    let totalCompiled = 0;

    for (let i = 0; i < maxBatches; i++) {
      const result = await compileWiki({
        projectId,
        maxArticles: batchSize,
        writtenBy,
      });
      results.push(result);
      totalCompiled += result?.compiled || 0;
      // Stop if no more pending docs were compiled
      if (!result?.compiled || result.compiled < batchSize) break;
    }

    return { compiled: totalCompiled, batches: results.length, results };
  });

  // GET /api/projects/:slug/wiki — list compiled wiki articles
  routes.set('GET /api/projects/wiki', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const slug = url.searchParams.get('slug');
    if (!slug) { const e = new Error('slug required'); e.statusCode = 400; throw e; }

    // OPT-166 P3: content.documents is RLS-enforced (§1 table list) and this route
    // is authed-any (route-tiers.js) — non-board principals keep the legacy
    // pool (INERT pre-flip; RLS fail-closed post-flip); board principals get
    // a scoped session.
    const boardScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
    const scopedQuery = boardScope ?? query;
    let articles;
    try {
      const project = await scopedQuery(`SELECT id FROM agent_graph.projects WHERE slug = $1`, [slug]);
      if (project.rows.length === 0) { const e = new Error('Project not found'); e.statusCode = 404; throw e; }

      // Get all wiki-compiled articles (globally for now; project scoping in Phase 3).
      // STAQPRO-545: the previous correlated subquery ran the chunk count once per
      // article (163 SubPlan loops on the Staqs project). Collapse it into a single
      // pre-aggregated LEFT JOIN so the count is computed in one index pass.
      articles = await scopedQuery(
        `SELECT d.id, d.title, d.classification, d.compiled_from,
                d.metadata, d.created_at, d.updated_at,
                COALESCE(cc.chunk_count, 0) AS chunk_count
         FROM content.documents d
         LEFT JOIN (
           SELECT c.document_id, count(*) AS chunk_count
           FROM content.chunks c
           GROUP BY c.document_id
         ) cc ON cc.document_id = d.id
         WHERE d.source = 'wiki-compiled'
         ORDER BY d.updated_at DESC`
      );
    } finally {
      if (boardScope) await boardScope.release();
    }

    return {
      articles: articles.rows.map(a => ({
        id: a.id,
        title: a.title,
        classification: a.classification,
        sourceCount: a.compiled_from?.length || 0,
        chunkCount: parseInt(a.chunk_count),
        wikilinks: a.metadata?.wikilinks || [],
        compiledBy: a.metadata?.compiled_by || 'unknown',
        createdAt: a.created_at,
        updatedAt: a.updated_at,
      })),
    };
  });

  // GET /api/projects/:slug/wiki/health — lint report
  routes.set('GET /api/projects/wiki/health', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const slug = url.searchParams.get('slug');
    if (!slug) { const e = new Error('slug required'); e.statusCode = 400; throw e; }

    const project = await query(`SELECT id FROM agent_graph.projects WHERE slug = $1`, [slug]);
    if (project.rows.length === 0) { const e = new Error('Project not found'); e.statusCode = 404; throw e; }

    // STAQPRO-545: wiki health is NOT real-time — a full lint loads every article
    // body and runs in-memory link analysis (~seconds), and this GET fires on every
    // project-detail page load alongside three other wiki queries. Serve the cached
    // report written by POST /wiki/lint (project_memory key 'wiki_health'); only
    // recompute lazily when no cached report exists. The POST endpoint stays the
    // explicit "refresh now" path.
    const cached = await query(
      `SELECT value, created_at FROM agent_graph.project_memory
       WHERE project_id = $1 AND key = 'wiki_health' AND superseded_by IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [project.rows[0].id]
    );
    if (cached.rows.length > 0) {
      const value = cached.rows[0].value;
      const report = typeof value === 'string' ? JSON.parse(value) : value;
      return { ...report, cached: true, cachedAt: cached.rows[0].created_at };
    }

    // No cached report yet — compute once and persist so subsequent loads are cheap.
    const { lintWiki } = await import('../../../lib/wiki/linter.js');
    const report = await lintWiki({ projectId: project.rows[0].id });
    const boardUser = req.headers?.['x-board-user'] || 'wiki-linter';
    try {
      await query(
        `INSERT INTO agent_graph.project_memory (project_id, key, value, written_by)
         VALUES ($1, 'wiki_health', $2, $3)`,
        [project.rows[0].id, JSON.stringify(report), boardUser]
      );
    } catch { /* best-effort cache write; never block the read */ }
    return { ...report, cached: false };
  });

  // POST /api/projects/:slug/wiki/lint — trigger lint run and store in project memory
  routes.set('POST /api/projects/wiki/lint', async (req, body) => {
    const slug = body?.slug;
    if (!slug) { const e = new Error('slug required'); e.statusCode = 400; throw e; }

    const project = await query(`SELECT id FROM agent_graph.projects WHERE slug = $1`, [slug]);
    if (project.rows.length === 0) { const e = new Error('Project not found'); e.statusCode = 404; throw e; }

    const { lintWiki } = await import('../../../lib/wiki/linter.js');
    const report = await lintWiki({ projectId: project.rows[0].id });

    // Store lint report in project memory (append-only)
    const boardUser = req.headers?.['x-board-user'] || 'wiki-linter';
    const newId = (await query(
      `INSERT INTO agent_graph.project_memory (project_id, key, value, written_by)
       VALUES ($1, 'wiki_health', $2, $3)
       RETURNING id`,
      [project.rows[0].id, JSON.stringify(report), boardUser]
    )).rows[0].id;

    // Supersede previous health reports
    await query(
      `UPDATE agent_graph.project_memory
       SET superseded_by = $1
       WHERE project_id = $2 AND key = 'wiki_health' AND id != $1 AND superseded_by IS NULL`,
      [newId, project.rows[0].id]
    );

    return report;
  });

  // GET /api/projects/:slug/wiki/status — compilation status summary
  routes.set('GET /api/projects/wiki/status', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const slug = url.searchParams.get('slug');
    if (!slug) { const e = new Error('slug required'); e.statusCode = 400; throw e; }

    const project = await query(`SELECT id FROM agent_graph.projects WHERE slug = $1`, [slug]);
    if (project.rows.length === 0) { const e = new Error('Project not found'); e.statusCode = 404; throw e; }

    const { getCompileStatus } = await import('../../../lib/wiki/compiler.js');
    const status = await getCompileStatus(project.rows[0].id);

    return status;
  });

  // GET /api/projects/:slug/wiki/graph — graph data for visualization
  routes.set('GET /api/projects/wiki/graph', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const slug = url.searchParams.get('slug');
    if (!slug) { const e = new Error('slug required'); e.statusCode = 400; throw e; }

    // OPT-166 P3: content.documents is RLS-enforced (§1 table list) and this route
    // is authed-any (route-tiers.js) — non-board principals keep the legacy
    // pool (INERT pre-flip; RLS fail-closed post-flip); board principals get
    // a scoped session.
    const boardScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
    const scopedQuery = boardScope ?? query;
    let articles, sourceDocs;
    try {
      // Get all wiki-compiled articles with their metadata
      articles = await scopedQuery(
        `SELECT d.id, d.title, d.classification, d.compiled_from, d.metadata, d.source
         FROM content.documents d
         WHERE d.source = 'wiki-compiled'
         ORDER BY d.title`
      );

      // Get source documents that were compiled from
      const allSourceIds = articles.rows
        .flatMap(a => a.compiled_from || [])
        .filter(Boolean);

      sourceDocs = allSourceIds.length > 0
        ? await scopedQuery(
            `SELECT id, title, classification FROM content.documents WHERE id = ANY($1)`,
            [[...new Set(allSourceIds)]]
          )
        : { rows: [] };
    } finally {
      if (boardScope) await boardScope.release();
    }

    const sourceMap = new Map(sourceDocs.rows.map(d => [d.id, d]));

    // Build nodes
    const nodes = [];
    const nodeIds = new Set();
    const conceptNodes = new Set(); // track wikilink targets that aren't articles

    // Wiki article nodes
    for (const a of articles.rows) {
      nodes.push({
        id: a.id,
        label: a.title,
        type: 'wiki',
        classification: a.classification,
        size: 8 + Math.min(4, (a.compiled_from?.length || 0)),
      });
      nodeIds.add(a.id);
    }

    // Source document nodes
    for (const [id, doc] of sourceMap) {
      if (!nodeIds.has(id)) {
        nodes.push({
          id,
          label: doc.title,
          type: 'source',
          classification: doc.classification,
          size: 5,
        });
        nodeIds.add(id);
      }
    }

    // Build edges
    const edges = [];
    const articleTitleMap = new Map(articles.rows.map(a => [a.title.toLowerCase(), a.id]));

    for (const a of articles.rows) {
      // compiled_from edges
      for (const srcId of (a.compiled_from || [])) {
        if (nodeIds.has(srcId)) {
          edges.push({ source: srcId, target: a.id, type: 'compiled_from' });
        }
      }

      // wikilink edges
      const wikilinks = a.metadata?.wikilinks || [];
      for (const link of wikilinks) {
        const targetId = articleTitleMap.get(link.toLowerCase());
        if (targetId && targetId !== a.id) {
          edges.push({ source: a.id, target: targetId, type: 'wikilink' });
        } else if (!targetId) {
          // Unresolved concept — create a concept node
          const conceptId = `concept:${link.toLowerCase()}`;
          if (!nodeIds.has(conceptId)) {
            nodes.push({ id: conceptId, label: link, type: 'concept', size: 3 });
            nodeIds.add(conceptId);
            conceptNodes.add(conceptId);
          }
          edges.push({ source: a.id, target: conceptId, type: 'wikilink' });
        }
      }
    }

    // Mark orphan wiki articles (no inbound wikilinks)
    const inboundTargets = new Set(edges.filter(e => e.type === 'wikilink').map(e => e.target));
    for (const n of nodes) {
      if (n.type === 'wiki' && !inboundTargets.has(n.id)) {
        // Check if it has outbound links — if not, it's truly orphaned
        const hasOutbound = edges.some(e => e.source === n.id && e.type === 'wikilink');
        if (!hasOutbound) n.type = 'orphan';
      }
    }

    return { nodes, edges };
  });

  // ================================================================
  // GLOBAL WIKI ENDPOINTS (for Knowledge Base page)
  // ================================================================

  // GET /api/wiki/articles — all compiled wiki articles (global, not project-scoped)
  routes.set('GET /api/wiki/articles', async (req) => {
    // OPT-166 P3: content.documents is RLS-enforced (§1 table list) and this route
    // is authed-any (route-tiers.js) — non-board principals keep the legacy
    // pool (INERT pre-flip; RLS fail-closed post-flip); board principals get
    // a scoped session.
    const boardScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
    const scopedQuery = boardScope ?? query;
    let articles;
    try {
      articles = await scopedQuery(
        `SELECT d.id, d.title, d.classification, d.compiled_from,
                d.metadata, d.created_at, d.updated_at,
                (SELECT count(*) FROM content.chunks c WHERE c.document_id = d.id) AS chunk_count
         FROM content.documents d
         WHERE d.source = 'wiki-compiled'
         ORDER BY d.updated_at DESC`
      );
    } finally {
      if (boardScope) await boardScope.release();
    }
    return {
      articles: articles.rows.map(a => ({
        id: a.id,
        title: a.title,
        classification: a.classification,
        sourceCount: a.compiled_from?.length || 0,
        chunkCount: parseInt(a.chunk_count),
        wikilinks: a.metadata?.wikilinks || [],
        compiledBy: a.metadata?.compiled_by || 'unknown',
        createdAt: a.created_at,
        updatedAt: a.updated_at,
      })),
    };
  });

  // GET /api/wiki/graph — global graph data for Knowledge Base visualization
  routes.set('GET /api/wiki/graph', async (req) => {
    // OPT-166 P3: content.documents is RLS-enforced (§1 table list) and this route
    // is authed-any (route-tiers.js) — non-board principals keep the legacy
    // pool (INERT pre-flip; RLS fail-closed post-flip); board principals get
    // a scoped session.
    const boardScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
    const scopedQuery = boardScope ?? query;
    let articles, sourceDocs;
    try {
      articles = await scopedQuery(
        `SELECT d.id, d.title, d.classification, d.compiled_from, d.metadata
         FROM content.documents d WHERE d.source = 'wiki-compiled' ORDER BY d.title`
      );

      const allSourceIds = articles.rows.flatMap(a => a.compiled_from || []).filter(Boolean);
      sourceDocs = allSourceIds.length > 0
        ? await scopedQuery(`SELECT id, title, classification FROM content.documents WHERE id = ANY($1)`, [[...new Set(allSourceIds)]])
        : { rows: [] };
    } finally {
      if (boardScope) await boardScope.release();
    }
    const sourceMap = new Map(sourceDocs.rows.map(d => [d.id, d]));

    const nodes = [];
    const nodeIds = new Set();
    const edges = [];

    for (const a of articles.rows) {
      nodes.push({ id: a.id, label: a.title, type: 'wiki', classification: a.classification, size: 8 + Math.min(4, (a.compiled_from?.length || 0)) });
      nodeIds.add(a.id);
    }
    for (const [id, doc] of sourceMap) {
      if (!nodeIds.has(id)) {
        nodes.push({ id, label: doc.title, type: 'source', classification: doc.classification, size: 5 });
        nodeIds.add(id);
      }
    }

    const articleTitleMap = new Map(articles.rows.map(a => [a.title.toLowerCase(), a.id]));
    for (const a of articles.rows) {
      for (const srcId of (a.compiled_from || [])) {
        if (nodeIds.has(srcId)) edges.push({ source: srcId, target: a.id, type: 'compiled_from' });
      }
      for (const link of (a.metadata?.wikilinks || [])) {
        const targetId = articleTitleMap.get(link.toLowerCase());
        if (targetId && targetId !== a.id) {
          edges.push({ source: a.id, target: targetId, type: 'wikilink' });
        } else if (!targetId) {
          const conceptId = `concept:${link.toLowerCase()}`;
          if (!nodeIds.has(conceptId)) {
            nodes.push({ id: conceptId, label: link, type: 'concept', size: 3 });
            nodeIds.add(conceptId);
          }
          edges.push({ source: a.id, target: conceptId, type: 'wikilink' });
        }
      }
    }

    return { nodes, edges };
  });

  // GET /api/wiki/status — global compilation status
  routes.set('GET /api/wiki/status', async (req) => {
    // OPT-166 P3: content.documents is RLS-enforced (§1 table list) and this route
    // is authed-any (route-tiers.js) — non-board principals keep the legacy
    // pool (INERT pre-flip; RLS fail-closed post-flip); board principals get
    // a scoped session.
    const boardScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
    const scopedQuery = boardScope ?? query;
    let result, counts, wikiResult, split;
    try {
      result = await scopedQuery(
        `SELECT compile_status, count(*) AS count FROM content.documents GROUP BY compile_status`
      );
      counts = Object.fromEntries(result.rows.map(r => [r.compile_status || 'none', parseInt(r.count)]));
      wikiResult = await scopedQuery(`SELECT count(*) FROM content.documents WHERE source = 'wiki-compiled'`);
      split = await scopedQuery(
        `SELECT
           (SELECT COUNT(*)::int FROM content.documents d
            WHERE d.compile_status = 'pending'
              AND d.source != 'wiki-compiled'
              AND NOT EXISTS (
                SELECT 1 FROM agent_graph.project_memberships pm
                WHERE pm.entity_type = 'document' AND pm.entity_id = d.id::text
              )) AS pending_org,
           (SELECT COUNT(*)::int FROM content.documents d
            WHERE d.compile_status = 'pending'
              AND d.source != 'wiki-compiled'
              AND EXISTS (
                SELECT 1 FROM agent_graph.project_memberships pm
                WHERE pm.entity_type = 'document' AND pm.entity_id = d.id::text
              )) AS pending_project`
      );
    } finally {
      if (boardScope) await boardScope.release();
    }
    const po = split.rows[0]?.pending_org;
    const pp = split.rows[0]?.pending_project;
    return {
      pending: counts.pending || 0,
      pending_org: Number(po) || 0,
      pending_project: Number(pp) || 0,
      compiled: counts.compiled || 0,
      wikiArticles: parseInt(wikiResult.rows[0]?.count || '0'),
      none: counts.none || 0,
    };
  });

  // ================================================================
  // FILE UPLOAD TO PROJECTS
  // ================================================================

  // POST /api/projects/:slug/upload — upload file → RAG ingest + project membership
  routes.set('POST /api/projects/upload', async (req, body) => {
    if (!body?.slug || !body?.fileName || !body?.content) {
      const e = new Error('slug, fileName, and content required');
      e.statusCode = 400;
      throw e;
    }

    const project = await query(`SELECT id, classification_floor FROM agent_graph.projects WHERE slug = $1`, [body.slug]);
    if (project.rows.length === 0) { const e = new Error('Project not found'); e.statusCode = 404; throw e; }
    const projectId = project.rows[0].id;
    const classificationFloor = project.rows[0].classification_floor || 'INTERNAL';

    // Determine format from file extension
    const ext = body.fileName.split('.').pop()?.toLowerCase() || 'plain';
    const formatMap = { md: 'obsidian', txt: 'plain', json: 'plain', yaml: 'plain', yml: 'plain' };
    const format = formatMap[ext] || 'plain';

    // Ingest into knowledge base
    const { ingestDocument } = await import('../../../lib/rag/ingest.js');
    const boardUser = req.headers?.['x-board-user'] || 'unknown';
    const result = await ingestDocument({
      source: 'upload',
      sourceId: `project:${body.slug}:${body.fileName}`,
      title: body.fileName.replace(/\.[^.]+$/, ''),
      rawText: body.content,
      format,
      metadata: { project_slug: body.slug, uploaded_by: boardUser, original_filename: body.fileName },
      classification: body.classification || classificationFloor,
      forceUpdate: true, // Re-upload overwrites
    });

    if (!result) {
      const e = new Error('Ingestion failed — file may be empty or too small');
      e.statusCode = 400;
      throw e;
    }

    // Add to project membership
    await query(
      `INSERT INTO agent_graph.project_memberships (project_id, entity_type, entity_id, added_by)
       VALUES ($1, 'document', $2, $3)
       ON CONFLICT (project_id, entity_type, entity_id) DO NOTHING`,
      [projectId, result.documentId, boardUser]
    );

    // Kick a lightweight project-scoped compile pass so wiki pages appear without manual action.
    let compiled = 0;
    try {
      const { compileWiki } = await import('../../../lib/wiki/compiler.js');
      const compileResult = await compileWiki({
        projectId,
        maxArticles: 5,
        writtenBy: boardUser,
      });
      compiled = compileResult?.compiled || 0;
    } catch (err) {
      // Best effort only; upload should still succeed even if compiler is unavailable.
      console.warn('[projects/upload] compile kick failed:', err?.message || err);
    }

    return {
      ok: true,
      documentId: result.documentId,
      chunkCount: result.chunkCount,
      classification: body.classification || classificationFloor,
      wikiCompiled: compiled,
    };
  });
}
