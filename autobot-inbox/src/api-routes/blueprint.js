import { createHash } from 'crypto';
import { query } from '../db.js';
import { openAgentScope } from '../runtime/agent-scope.js';
import { publishEvent } from '../runtime/infrastructure.js';
import { emit } from '../runtime/event-bus.js';

/**
 * Blueprint API routes.
 *
 * POST /api/blueprint/submit       — submit a project blueprint for analysis
 * GET  /api/blueprint/status/:id   — poll job status
 * POST /api/blueprint/notify       — save email for completion notification
 * GET  /api/blueprint/view/:id     — serve generated blueprint HTML
 *
 * Public endpoints — no auth required (rate-limited instead).
 */

const MAX_PER_IP_24H = 3;
const MAX_GLOBAL_24H = 10;

export function registerBlueprintRoutes(routes) {
  // POST /api/blueprint/submit
  routes.set('POST /api/blueprint/submit', async (req, body) => {
    const { description, audience, budget, timeline, hasSpec, siteUrl, email } = body || {};

    if (!description || typeof description !== 'string' || description.trim().length < 10) {
      const err = new Error('Missing or too short description (minimum 10 characters)');
      err.statusCode = 400;
      throw err;
    }

    if (description.trim().length > 100000) {
      const err = new Error('Description too long (maximum 100,000 characters)');
      err.statusCode = 400;
      throw err;
    }

    const requesterIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
      || req.socket?.remoteAddress
      || 'unknown';

    // STAQPRO-524 follow-up: agent_graph.work_items is FORCE'd by migration
    // 126. This route is PUBLIC (no auth), but every touch of that table —
    // the rate-limit/dedup reads below AND the INSERT — needs an
    // `app.agent_id` so current_agent_id() is non-NULL and the rows stay
    // visible once RLS is enforced (today, under bypass, this is a no-op).
    // Scope to the executor-blueprint agent — that's the row's assignee and
    // the natural identity for these checks and the follow-up GET handlers
    // below. `created_by='board'` remains for audit lineage. One scoped
    // connection covers the whole handler (OPT-166 P3-B3).
    const scopedQuery = await openAgentScope('executor-blueprint');
    let result;
    try {
      // Rate limit: per-IP (3/24h)
      const ipCountResult = await scopedQuery(
        `SELECT COUNT(*) AS cnt FROM agent_graph.work_items
         WHERE type = 'task' AND metadata ? 'blueprint_description'
           AND metadata->>'requester_ip' = $1
           AND created_at > now() - interval '24 hours'`,
        [requesterIp]
      );
      if (parseInt(ipCountResult.rows[0].cnt, 10) >= MAX_PER_IP_24H) {
        const err = new Error('Rate limit: maximum 3 blueprints per 24 hours');
        err.statusCode = 429;
        throw err;
      }

      // Rate limit: global (10/24h)
      const globalCountResult = await scopedQuery(
        `SELECT COUNT(*) AS cnt FROM agent_graph.work_items
         WHERE type = 'task' AND metadata ? 'blueprint_description'
           AND created_at > now() - interval '24 hours'`
      );
      if (parseInt(globalCountResult.rows[0].cnt, 10) >= MAX_GLOBAL_24H) {
        const err = new Error('Service busy: daily capacity reached. Try again tomorrow.');
        err.statusCode = 429;
        throw err;
      }

      // Dedup: same description hash within 24h returns existing job
      var descHash = createHash('sha256').update(description.trim().toLowerCase()).digest('hex');
      const existingResult = await scopedQuery(
        `SELECT id, status, metadata FROM agent_graph.work_items
         WHERE type = 'task' AND metadata ? 'blueprint_description'
           AND metadata->>'description_hash' = $1
           AND created_at > now() - interval '24 hours'
           AND status NOT IN ('failed', 'cancelled', 'timed_out')
         ORDER BY created_at DESC LIMIT 1`,
        [descHash]
      );
      if (existingResult.rows.length > 0) {
        const existing = existingResult.rows[0];
        return {
          jobId: existing.id,
          status: existing.status,
          deduplicated: true,
        };
      }

      var metadata = {
        blueprint_description: description.trim(),
        description_hash: descHash,
        audience: audience || null,
        budget: budget || null,
        timeline: timeline || null,
        has_spec: hasSpec || false,
        site_url: siteUrl || null,
        requester_email: email || null,
        requester_ip: requesterIp,
      };

      result = await scopedQuery(
        `INSERT INTO agent_graph.work_items
         (type, title, routing_class, metadata, status, assigned_to, created_by)
         VALUES ('task', $2, 'FULL', $1, 'assigned', 'executor-blueprint', 'board')
         RETURNING id, status, created_at`,
        [JSON.stringify(metadata), `Blueprint: ${description.trim().slice(0, 80)}`]
      );
    } finally {
      await scopedQuery.release();
    }

    const jobId = result.rows[0].id;

    // Emit task event so executor-blueprint agent can claim it
    await emit({
      eventType: 'task_created',
      workItemId: jobId,
      targetAgentId: 'executor-blueprint',
      priority: 0,
      eventData: { blueprint_description: description.trim().slice(0, 200) },
    });

    await publishEvent(
      'blueprint_submitted',
      `Blueprint submitted: ${description.trim().slice(0, 80)}`,
      null, jobId,
      { description: description.trim().slice(0, 200) }
    );

    return {
      jobId,
      status: 'created',
      createdAt: result.rows[0].created_at,
    };
  });

  // GET /api/blueprint/status/:id — poll job status
  routes.set('GET /api/blueprint/status/:id', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/');
    const jobId = parts[parts.length - 1];

    if (!jobId) {
      const err = new Error('Missing job ID');
      err.statusCode = 400;
      throw err;
    }

    // OPT-166 P3-B3: same agent-owned rows as POST /api/blueprint/submit
    // above (assigned_to='executor-blueprint'). Scope to the same identity
    // so this read stays visible once 126-force-rls is live (INERT today).
    const scopedQuery = await openAgentScope('executor-blueprint');
    let result;
    let queueResult;
    try {
      result = await scopedQuery(
        `SELECT id, status, metadata, created_at, updated_at
         FROM agent_graph.work_items
         WHERE id = $1 AND type = 'task' AND metadata ? 'blueprint_description'`,
        [jobId]
      );

      if (result.rows.length === 0) {
        return {
          jobId,
          status: 'failed',
          hasPreview: false,
          error: 'Job not found — it may have been cancelled or expired.',
          createdAt: null,
          updatedAt: null,
        };
      }

      const job = result.rows[0];
      const meta = job.metadata || {};

      const effectiveStatus = meta.html_output ? 'completed' : job.status;

      // Queue position for waiting jobs
      let queuePosition = null;
      if (['created', 'assigned'].includes(job.status) && !meta.html_output) {
        queueResult = await scopedQuery(
          `SELECT COUNT(*) AS cnt FROM agent_graph.work_items
           WHERE type = 'task' AND metadata ? 'blueprint_description'
             AND status IN ('created', 'assigned', 'in_progress')
             AND created_at < $1
             AND id != $2`,
          [job.created_at, jobId]
        );
        queuePosition = parseInt(queueResult.rows[0].cnt, 10) + 1;
      }

      return {
        jobId: job.id,
        status: effectiveStatus,
        hasPreview: !!meta.html_output,
        projectName: meta.project_name || null,
        queuePosition,
        createdAt: job.created_at,
        updatedAt: job.updated_at,
      };
    } finally {
      await scopedQuery.release();
    }
  });

  // POST /api/blueprint/notify — save email for completion notification
  routes.set('POST /api/blueprint/notify', async (req, body) => {
    const { jobId, email } = body || {};
    if (!jobId || !email || typeof email !== 'string' || !email.includes('@')) {
      const err = new Error('Missing jobId or valid email');
      err.statusCode = 400;
      throw err;
    }

    // OPT-166 P3-B3: same agent-owned rows as POST /api/blueprint/submit above.
    const scopedQuery = await openAgentScope('executor-blueprint');
    try {
      await scopedQuery(
        `UPDATE agent_graph.work_items
         SET metadata = metadata || jsonb_build_object('notify_email', $1::text)
         WHERE id = $2 AND type = 'task' AND metadata ? 'blueprint_description'`,
        [email, jobId]
      );
    } finally {
      await scopedQuery.release();
    }

    return { ok: true };
  });

  // GET /api/blueprint/view/:id — serve generated blueprint HTML
  routes.set('GET /api/blueprint/view/:id', async (req, _body, res) => {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/');
    const jobId = parts[parts.length - 1];

    // OPT-166 P3-B3: same agent-owned rows as POST /api/blueprint/submit above.
    const scopedQuery = await openAgentScope('executor-blueprint');
    let result;
    try {
      result = await scopedQuery(
        `SELECT metadata FROM agent_graph.work_items
         WHERE id = $1 AND type = 'task' AND metadata ? 'blueprint_description'
           AND metadata ? 'html_output'`,
        [jobId]
      );
    } finally {
      await scopedQuery.release();
    }

    const htmlOutput = result.rows[0]?.metadata?.html_output;
    if (!htmlOutput) {
      const err = new Error('Blueprint not available yet');
      err.statusCode = 404;
      throw err;
    }

    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'self' 'unsafe-inline' fonts.googleapis.com fonts.gstatic.com; img-src 'self' data: https:; script-src 'none'",
      'Cache-Control': 'public, max-age=3600',
    });
    res.end(htmlOutput);
    return '__sse__';
  });
}
