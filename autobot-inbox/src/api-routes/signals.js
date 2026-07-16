// api-routes/signals.js — signals feed, resolution, email archive, feedback, briefings.
//
// Extracted verbatim from api.js (OPT-139, plan 003). Pure move, no behavior change.
// Injected deps mirror registerCampaignRoutes(routes, cachedQuery, _cache, { withViewer }):
//   - cachedQuery + _cache: the api.js response-cache closure + Map (cache busting on writes)
//   - withViewer: tenant principal resolver for the scoped /api/signals/briefings read
// query + visibleClause are direct imports. The two POST /api/emails/{archive,unarchive}
// handlers live here (not an emails module) because they are signal-resolution operations
// and sat contiguously inside this block; moving the run verbatim avoids splitting it.
import { query } from '../db.js';
import { visibleClause } from '../../../lib/tenancy/scope.js';

export function registerSignalsRoutes(routes, cachedQuery, _cache, { withViewer } = {}) {
  // TODO(opt-166-p3): mixed principal — every handler below EXCEPT
  // GET /api/signals/briefings has NO auth/principal check of any kind today
  // (bare query(), no requireBoard, no withViewer/visibleClause). There is no
  // evidence these are board-only; withBoardScope(req.auth) throws for any
  // non-board caller (including unauthenticated/agent-JWT), so wrapping would
  // risk breaking a currently-succeeding caller — not INERT. Left unwrapped
  // pending per-route reachability confirmation (mirrors the flows.js
  // POST /api/signals precedent flagged by the same matrix).
  //
  // GET /api/signals/briefings — resolves `principal` via withViewer() and
  // fails OPEN to an empty {latest:null,history:[]} for unresolved callers
  // (no throw). Its own comment block documents that "explicit internal
  // (agent-JWT) callers" legitimately receive rows here (adminBypass path),
  // so withBoardScope(req.auth) — which throws for role !== 'board' — would
  // break that documented agent path. Left unwrapped.
  // GET /api/signals/feed — signals grouped by message with draft status + contact info
  routes.set('GET /api/signals/feed', async () => {
    const result = await cachedQuery('signals_feed', async () => {
      const feed = await query(`
        SELECT
          m.id AS message_id,
          m.from_address, m.from_name, m.subject, m.snippet,
          m.triage_category, m.priority_score, m.received_at,
          m.channel, a.label AS account_label,
          CASE WHEN m.channel = 'webhook' THEN
            (SELECT SUBSTRING(l FROM 'webhook:(.+)') FROM UNNEST(m.labels) l WHERE l LIKE 'webhook:%' LIMIT 1)
          END AS webhook_source,
          json_agg(json_build_object(
            'id', s.id, 'signal_type', s.signal_type,
            'content', s.content, 'confidence', s.confidence,
            'due_date', s.due_date, 'resolved', s.resolved
          ) ORDER BY s.due_date ASC NULLS LAST) AS signals,
          CASE
            WHEN bool_or(s.resolved) THEN 'resolved'
            WHEN EXISTS (SELECT 1 FROM agent_graph.action_proposals ap2
              WHERE ap2.message_id = m.id
              AND (ap2.send_state IN ('delivered','cancelled') OR ap2.action_type = 'ticket_create'))
            THEN 'actioned'
            WHEN EXISTS (SELECT 1 FROM agent_graph.action_proposals ap2
              WHERE ap2.message_id = m.id AND ap2.send_state = 'pending')
            THEN 'in_progress'
            ELSE 'open'
          END AS computed_status,
          ap_agg.actions,
          c.name AS contact_name, c.contact_type,
          c.is_vip
        FROM inbox.signals s
        JOIN inbox.messages m ON m.id = s.message_id
        LEFT JOIN inbox.accounts a ON a.id = m.account_id
        LEFT JOIN LATERAL (
          SELECT jsonb_agg(jsonb_build_object(
            'id', ap.id, 'action_type', ap.action_type,
            'send_state', ap.send_state,
            'reviewer_verdict', ap.reviewer_verdict,
            'board_action', ap.board_action,
            'tone_score', ap.tone_score,
            'email_summary', ap.email_summary,
            'draft_intent', ap.draft_intent,
            'linear_issue_url', ap.linear_issue_url,
            'github_issue_url', ap.github_issue_url,
            'github_issue_number', ap.github_issue_number,
            'github_pr_number', ap.github_pr_number,
            'github_pr_url', ap.github_pr_url,
            'target_repo', ap.target_repo,
            'created_at', ap.created_at
          ) ORDER BY ap.created_at DESC) AS actions
          FROM agent_graph.action_proposals ap
          WHERE ap.message_id = m.id
        ) ap_agg ON true
        LEFT JOIN signal.contacts c ON lower(c.email_address) = lower(m.from_address)
        WHERE s.resolved = false
        GROUP BY m.id, m.from_address, m.from_name, m.subject, m.snippet,
                 m.triage_category, m.priority_score, m.received_at,
                 m.channel, m.labels, a.label,
                 ap_agg.actions,
                 c.name, c.contact_type, c.is_vip
        ORDER BY c.is_vip DESC NULLS LAST,
                 m.priority_score DESC NULLS LAST,
                 m.received_at DESC
      `);
      return { feed: feed.rows };
    }, 15_000);
    return result || { feed: [] };
  });

  // POST /api/signals/resolve — mark signals as resolved
  routes.set('POST /api/signals/resolve', async (_req, body) => {
    _cache.delete('signals_feed');
    _cache.delete('signals');
    _cache.delete('today');

    const { id, ids, messageId } = body;
    if (messageId) {
      const r = await query(
        `UPDATE inbox.signals SET resolved = true, resolved_at = now() WHERE message_id = $1 AND resolved = false`,
        [messageId]
      );
      return { ok: true, resolved: r.rowCount };
    }
    const idList = ids || (id ? [id] : []);
    if (idList.length === 0) return { ok: false, error: 'Provide id, ids, or messageId' };
    const r = await query(
      `UPDATE inbox.signals SET resolved = true, resolved_at = now() WHERE id = ANY($1) AND resolved = false`,
      [idList]
    );
    return { ok: true, resolved: r.rowCount };
  });

  // POST /api/signals/unresolve — undo signal resolution (5s undo window)
  routes.set('POST /api/signals/unresolve', async (_req, body) => {
    _cache.delete('signals_feed');
    _cache.delete('signals');
    _cache.delete('today');

    const { id, ids, messageId } = body;
    if (messageId) {
      const r = await query(
        `UPDATE inbox.signals SET resolved = false, resolved_at = NULL WHERE message_id = $1 AND resolved = true`,
        [messageId]
      );
      return { ok: true, unresolved: r.rowCount };
    }
    const idList = ids || (id ? [id] : []);
    if (idList.length === 0) return { ok: false, error: 'Provide id, ids, or messageId' };
    const r = await query(
      `UPDATE inbox.signals SET resolved = false, resolved_at = NULL WHERE id = ANY($1) AND resolved = true`,
      [idList]
    );
    return { ok: true, unresolved: r.rowCount };
  });

  // POST /api/emails/archive — archive message + resolve all signals
  routes.set('POST /api/emails/archive', async (_req, body) => {
    _cache.delete('signals_feed');
    _cache.delete('signals');
    _cache.delete('today');

    const { messageId } = body;
    if (!messageId) return { ok: false, error: 'Provide messageId' };

    const archiveResult = await query(
      `UPDATE inbox.messages SET archived_at = now() WHERE id = $1 AND archived_at IS NULL`,
      [messageId]
    );
    const resolveResult = await query(
      `UPDATE inbox.signals SET resolved = true, resolved_at = now(),
         metadata = COALESCE(metadata, '{}'::jsonb) || '{"resolution_reason":"manual_archive"}'::jsonb
       WHERE message_id = $1 AND resolved = false`,
      [messageId]
    );
    return { ok: true, archived: archiveResult.rowCount, resolved: resolveResult.rowCount };
  });

  // POST /api/emails/unarchive — undo archive + unresolve signals resolved by archive
  routes.set('POST /api/emails/unarchive', async (_req, body) => {
    _cache.delete('signals_feed');
    _cache.delete('signals');
    _cache.delete('today');

    const { messageId } = body;
    if (!messageId) return { ok: false, error: 'Provide messageId' };

    await query(
      `UPDATE inbox.messages SET archived_at = NULL WHERE id = $1`,
      [messageId]
    );
    const unresolveResult = await query(
      `UPDATE inbox.signals SET resolved = false, resolved_at = NULL,
         metadata = metadata - 'resolution_reason'
       WHERE message_id = $1 AND resolved = true AND metadata->>'resolution_reason' = 'manual_archive'`,
      [messageId]
    );
    return { ok: true, unresolved: unresolveResult.rowCount };
  });

  // POST /api/signals/feedback — record signal accuracy feedback (ADR-014, D4 append-only)
  routes.set('POST /api/signals/feedback', async (_req, body) => {
    const { signalId, verdict, correction, source } = body;
    if (!signalId || !verdict) return { ok: false, error: 'Provide signalId and verdict' };
    if (!['correct', 'incorrect', 'partial'].includes(verdict)) {
      return { ok: false, error: 'verdict must be correct, incorrect, or partial' };
    }
    await query(
      `INSERT INTO signal.feedback (signal_id, verdict, correction, source)
       VALUES ($1, $2, $3, $4)`,
      [signalId, verdict, correction ? JSON.stringify(correction) : null, source || 'dashboard']
    );
    return { ok: true };
  });

  // GET /api/signals/feedback/metrics — signal accuracy metrics for v1.0 tracking
  routes.set('GET /api/signals/feedback/metrics', async () => {
    const result = await cachedQuery('feedback_metrics', async () => {
      const metrics = await query(`SELECT * FROM signal.v_feedback_metrics`);
      return metrics.rows[0] || {};
    }, 60_000);
    return result || {};
  });

  // GET /api/signals/briefings — daily briefing archive (latest + browsable history)
  //
  // STAQPRO-534: surfaces the existing-but-invisible signal.briefings rows. The architect
  // agent persists ONE org-wide briefing per date (account_id IS NULL; ON CONFLICT
  // (briefing_date) means per-account briefings are never written). The body therefore has
  // no per-owner column — it is org-shared relationship/summary data exactly like
  // signal.contacts in GET /api/signals.
  //
  // Scoping (mirrors the contacts block above, STAQPRO-531 discipline): only identified
  // board members or explicit internal (agent-JWT) callers receive rows; an unidentified/
  // unresolved caller (bare shared secret, no x-board-user) gets an EMPTY list, never global.
  // Read-only — no generation logic here; the architect agent owns briefing creation.
  routes.set('GET /api/signals/briefings', async (req) => {
    // STAQPRO-588 (ADR-012 M-C): briefings carry owner_user_id/owner_org_id (migration
    // 134). Scope by the tenancy predicate instead of the plain "is a viewer" gate.
    // Cache is keyed by the principal scope so scoped briefings never leak across buckets.
    const { principal } = await withViewer(req);
    if (!principal) {
      return { latest: null, history: [] };
    }
    // Cache the max set under a per-principal key and slice per request, so a range of
    // ?limit= values never fans out into many cache buckets.
    const BRIEFINGS_MAX = 90;
    const url = new URL(req.url, 'http://localhost');
    const rawLimit = parseInt(url.searchParams.get('limit') ?? '', 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), BRIEFINGS_MAX) : 30;
    const scopeKey = principal.adminBypass
      ? 'admin'
      : `u:${principal.userId ?? '_'}|o:${(principal.readOrgIds || []).slice().sort().join(',')}`;
    const all = await cachedQuery(`signal_briefings:${scopeKey}`, async () => {
      // $1 = BRIEFINGS_MAX (LIMIT); visibleClause params start at $2.
      const v = visibleClause(principal, { ownerOrgCol: 'owner_org_id', startIndex: 2 });
      const briefings = await query(
        `SELECT id, briefing_date, summary, action_items, signals, trending_topics,
                vip_activity, emails_received, emails_triaged, drafts_created,
                drafts_approved, drafts_edited, cost_usd, generated_by, created_at
           FROM signal.briefings
          WHERE ${v.sql}
          ORDER BY briefing_date DESC, created_at DESC
          LIMIT $1`,
        [BRIEFINGS_MAX, ...v.params]
      );
      return briefings.rows;
    }, 15_000);
    const rows = (all || []).slice(0, limit);
    return { latest: rows[0] || null, history: rows.slice(1) };
  });
}
