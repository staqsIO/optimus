import { query, withBoardScope } from '../db.js';
import { writerOrgId } from '../../../lib/tenancy/owner-stamp.js';
import { visibleClause } from '../../../lib/tenancy/scope.js';

/**
 * Content API routes for the Board Content page (Phase 1.5).
 * Serves content.drafts, content.topics, and content.gate_log.
 */

export function registerContentRoutes(routes, { withViewer } = {}) {
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

  // GET /api/content/drafts — list all content drafts
  routes.set('GET /api/content/drafts', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const contentType = url.searchParams.get('content_type');
    const status = url.searchParams.get('status');
    const limit = parseInt(url.searchParams.get('limit') || '50', 10);

    // STAQPRO-608 (596-class): content.drafts carries owner_org_id (migration
    // 134). Scope fail-closed so one org's drafts never enumerate to another.
    const principal = await resolvePrincipalFor(req);

    const values = [];
    const conditions = [];

    const v = visibleClause(principal, { ownerOrgCol: 'd.owner_org_id', startIndex: values.length + 1 });
    conditions.push(v.sql);
    values.push(...v.params);

    if (contentType) {
      values.push(contentType);
      conditions.push(`d.content_type = $${values.length}`);
    }
    if (status) {
      values.push(status);
      conditions.push(`d.status = $${values.length}`);
    }

    values.push(limit);
    const limitIdx = values.length;

    // OPT-166 P3: content.drafts is RLS-enforced. authed-any route → board
    // gets a scoped session; non-board keeps the legacy pool (INERT pre-flip,
    // RLS fail-closed post-flip). An unconditional wrap would 500 non-board
    // principals. `principal` above still feeds the visibleClause() filter.
    const boardScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
    const scopedQuery = boardScope ?? query;
    let result;
    try {
      result = await scopedQuery(
        `SELECT d.id, d.content_type, d.status, d.title, d.slug, d.author,
                d.word_count, d.reading_time_min, d.tone_score, d.cost_usd,
                d.published_url, d.campaign_id, d.work_item_id,
                d.source_draft_id, d.gate_results,
                d.created_at, d.updated_at, d.published_at
         FROM content.drafts d
         WHERE ${conditions.join(' AND ')}
         ORDER BY d.created_at DESC LIMIT $${limitIdx}`,
        values
      );
    } finally {
      if (boardScope) await boardScope.release();
    }

    return { drafts: result.rows };
  });

  // GET /api/content/drafts/:id — single draft with body + gate log
  routes.set('GET /api/content/drafts/:id', async (req) => {
    const id = new URL(req.url, 'http://localhost').pathname.split('/').pop();

    // OPT-166 P3: content.drafts + content.gate_log are RLS-enforced. Both
    // queries share ONE connection (sequential). authed-any route → board
    // gets a scoped session; non-board keeps the legacy pool (INERT pre-flip,
    // RLS fail-closed post-flip). An unconditional wrap would 500 non-board.
    const boardScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
    const scopedQuery = boardScope ?? query;
    let draftResult, gateResult;
    try {
      draftResult = await scopedQuery(
        `SELECT d.*, d.frontmatter, d.seo_metadata, d.image_assets
         FROM content.drafts d WHERE d.id = $1`,
        [id]
      );
      gateResult = await scopedQuery(
        `SELECT gate_name, passed, details, created_at
         FROM content.gate_log WHERE draft_id = $1
         ORDER BY created_at`,
        [id]
      );
    } finally {
      if (boardScope) await boardScope.release();
    }

    if (!draftResult.rows.length) {
      return { error: 'Draft not found', status: 404 };
    }

    const draft = draftResult.rows[0];
    // Legacy shim: auto-convert {{VAR_NAME}} → [VAR_NAME] for contracts
    // (idempotent: re-running this on already-converted content is a no-op).
    if (draft.content_type === 'contract' && typeof draft.body === 'string' && draft.body.includes('{{')) {
      draft.body = draft.body.replace(/\{\{([A-Z][A-Z0-9_]{1,59})\}\}/g, '[$1]');
    }

    return {
      draft,
      gates: gateResult.rows,
    };
  });

  // POST /api/content/requests — trigger content generation
  routes.set('POST /api/content/requests', async (req, body) => {
    const {
      topic,
      content_type = 'blog',
      author = 'UMB Advisors',
      target_audience = 'Growth-stage company operators and founders',
      seo_keywords = [],
      tone = 'Calm experienced operator, thinking in public',
    } = body || {};

    if (!topic) {
      return { error: 'topic is required', status: 400 };
    }

    const { publishEvent } = await import('../runtime/event-bus.js');

    // Owner-stamp from the caller's org (STAQPRO-593). null → column DEFAULT.
    const principal = await resolvePrincipalFor(req);
    const ownerOrgId = writerOrgId(principal);

    // OPT-166 P3: agent_graph.work_items + agent_graph.campaigns are
    // RLS-enforced. publishEvent below runs AFTER release — no connection is
    // held across it. authed-any route → board gets a scoped session;
    // non-board keeps the legacy pool (INERT pre-flip, RLS fail-closed
    // post-flip). An unconditional wrap would 500 non-board principals.
    const boardScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
    const scopedQuery = boardScope ?? query;
    let workItemId, campaign;
    try {
      const wi = await scopedQuery(
        `INSERT INTO agent_graph.work_items (id, type, title, description, status, priority, assigned_to, created_by, delegation_depth, owner_org_id)
         VALUES (gen_random_uuid(), 'campaign', $1, $2, 'assigned', 5, 'claw-campaigner', 'board', 0, $3)
         RETURNING id`,
        [`Content: ${topic.slice(0, 60)}`, topic, ownerOrgId]
      );
      workItemId = wi.rows[0].id;

      const metadata = { content_type, topic, author, target_audience, seo_keywords, tone };

      const c = await scopedQuery(
        `INSERT INTO agent_graph.campaigns (
          id, work_item_id, goal_description, success_criteria, constraints,
          budget_envelope_usd, max_iterations, iteration_time_budget,
          campaign_status, campaign_mode, created_by, metadata, owner_org_id
        ) VALUES (
          gen_random_uuid(), $1, $2, $3::jsonb, '{}'::jsonb,
          $4, $5, '5 minutes'::interval, 'approved', 'stateless', $6, $7::jsonb, $8
        ) RETURNING id, campaign_status`,
        [
          workItemId,
          content_type === 'linkedin' ? `Write a LinkedIn post about ${topic}` : `Write a blog post about ${topic}`,
          JSON.stringify([{ metric: 'quality_score', operator: '>=', threshold: 0.7 }]),
          10, 1,
          req.auth?.github_username || 'board',
          JSON.stringify(metadata),
          ownerOrgId,
        ]
      );
      campaign = c.rows[0];
    } finally {
      if (boardScope) await boardScope.release();
    }

    await publishEvent('campaign_approved', `Content campaign ${campaign.id} auto-approved`, 'board', null, { campaign_id: campaign.id }).catch(() => {});

    return { ok: true, campaign_id: campaign.id, work_item_id: workItemId, content_type, topic };
  });

  // POST /api/content/drafts/:id/approve
  routes.set('POST /api/content/drafts/:id/approve', async (req) => {
    const parts = new URL(req.url, 'http://localhost').pathname.split('/');
    const id = parts[parts.length - 2]; // /api/content/drafts/:id/approve → id is second-to-last

    // OPT-166 P3: content.drafts is RLS-enforced, but this handler interleaves
    // network calls (LinkedIn API, BoldSign config check) between DB touches —
    // use the FACTORY form of the authed-any conditional pattern so no scoped
    // connection is held open across them. Board → a fresh scoped session per
    // open; non-board → the bare legacy pool with a no-op release (INERT
    // pre-flip, RLS fail-closed post-flip). An unconditional wrap would 500
    // non-board principals.
    const openScope = async () => {
      const bs = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
      if (bs) return bs;
      const q = (...args) => query(...args);
      q.release = async () => {};
      return q;
    };

    let draft;
    {
      const scoped = await openScope();
      try {
        await scoped(`UPDATE content.drafts SET status = 'approved', updated_at = now() WHERE id = $1`, [id]);
        draft = await scoped(`SELECT content_type, body, title, seo_metadata FROM content.drafts WHERE id = $1`, [id]);
      } finally {
        await scoped.release();
      }
    }
    const contentType = draft.rows[0]?.content_type;

    // LinkedIn: auto-publish via API
    if (contentType === 'linkedin') {
      try {
        const { linkedinAdapter, isLinkedInConfigured } = await import('../../../lib/adapters/linkedin-poster.js');
        if (await isLinkedInConfigured()) {
          const postUrl = await linkedinAdapter.executeDraft(id);
          return { ok: true, status: 'published', linkedin_url: postUrl };
        }
      } catch (err) {
        console.warn(`[content] LinkedIn publish failed for ${id}:`, err.message);
        return { ok: true, status: 'approved', linkedin_error: err.message };
      }
    }

    // Contract: send for e-signature via BoldSign
    if (contentType === 'contract') {
      try {
        const { isBoldSignConfigured } = await import('../../../lib/adapters/boldsign.js');
        if (isBoldSignConfigured()) {
          const meta = typeof draft.rows[0]?.seo_metadata === 'string'
            ? JSON.parse(draft.rows[0].seo_metadata)
            : (draft.rows[0]?.seo_metadata || {});

          // For now, store as approved — BoldSign send requires PDF generation
          // which needs puppeteer or similar (Phase 2)
          // Mark ready for manual BoldSign send
          const scoped2 = await openScope();
          try {
            await scoped2(
              `UPDATE content.drafts SET status = 'approved', updated_at = now(),
               seo_metadata = seo_metadata || '{"boldsign_ready": true}'::jsonb
               WHERE id = $1`,
              [id]
            );
          } finally {
            await scoped2.release();
          }

          console.log(`[content] Contract ${id} approved and marked for BoldSign send`);
          return {
            ok: true,
            status: 'approved',
            boldsign_ready: true,
            signer_name: meta.signer_name,
            signer_email: meta.signer_email,
          };
        }
      } catch (err) {
        console.warn(`[content] BoldSign prep failed for ${id}:`, err.message);
        return { ok: true, status: 'approved', boldsign_error: err.message };
      }
    }

    return { ok: true, status: 'approved' };
  });

  // POST /api/content/drafts/:id/body — update draft body (auto-save from editor)
  routes.set('POST /api/content/drafts/:id/body', async (req, body) => {
    const parts = new URL(req.url, 'http://localhost').pathname.split('/');
    const id = parts[parts.length - 2];
    if (!body?.body) {
      const err = new Error('body is required');
      err.statusCode = 400;
      throw err;
    }
    // OPT-166 P3: content.drafts + content.draft_versions are RLS-enforced.
    // Only allow edits on draft/review/approved (not sent/signed). authed-any
    // route → board gets a scoped session; non-board keeps the legacy pool
    // (INERT pre-flip, RLS fail-closed post-flip). An unconditional wrap would
    // 500 non-board principals.
    const boardScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
    const scopedQuery = boardScope ?? query;
    let draft, wordCount, versionRow = null;
    try {
      draft = await scopedQuery(`SELECT status, content_type FROM content.drafts WHERE id = $1`, [id]);
      if (!draft.rows[0]) {
        const err = new Error('Draft not found');
        err.statusCode = 404;
        throw err;
      }
      const locked = ['published', 'rejected'].includes(draft.rows[0].status);
      if (locked) {
        const err = new Error('Cannot edit a draft that has been sent for signature or rejected');
        err.statusCode = 409;
        throw err;
      }
      wordCount = body.body.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
      await scopedQuery(
        `UPDATE content.drafts SET body = $1, word_count = $2, updated_at = now() WHERE id = $3`,
        [body.body, wordCount, id]
      );

      // Snapshot as a draft version — only for contracts, and only if body changed.
      // append_draft_version dedups by hash, so the no-op case (autosave firing after
      // an AI edit that already snapshotted server-side) is free.
      if (draft.rows[0].content_type === 'contract') {
        const boardUser = req.headers['x-board-user'] || 'unknown';
        const result = await scopedQuery(
          `SELECT * FROM content.append_draft_version($1, $2, 'manual', NULL, $3, NULL, NULL)`,
          [id, body.body, boardUser]
        );
        versionRow = result.rows[0] || null;
      }
    } finally {
      if (boardScope) await boardScope.release();
    }
    return {
      ok: true,
      word_count: wordCount,
      version_id: versionRow?.version_id || null,
      version_number: versionRow?.version_number || null,
      deduplicated: versionRow?.deduplicated || false,
    };
  });

  // POST /api/content/drafts/:id/reject
  routes.set('POST /api/content/drafts/:id/reject', async (req) => {
    const parts = new URL(req.url, 'http://localhost').pathname.split('/');
    const id = parts[parts.length - 2];

    // OPT-166 P3: content.drafts is RLS-enforced. authed-any route → board
    // gets a scoped session; non-board keeps the legacy pool (INERT pre-flip,
    // RLS fail-closed post-flip). An unconditional wrap would 500 non-board.
    const boardScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
    const scopedQuery = boardScope ?? query;
    try {
      await scopedQuery(`UPDATE content.drafts SET status = 'rejected', updated_at = now() WHERE id = $1`, [id]);
    } finally {
      if (boardScope) await boardScope.release();
    }
    return { ok: true, status: 'rejected' };
  });
}
