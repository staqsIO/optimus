/**
 * Actions API — unified pending action items for the board.
 *
 * GET  /api/actions/pending — 4 parallel queries, merge + urgency-sort
 * GET  /api/actions/count   — lightweight count-only for badge polling
 */

import { query, withBoardScope } from '../db.js';

function requireBoard(req) {
  if (!req.auth || req.auth.role !== 'board') {
    const e = new Error('Board role required');
    e.statusCode = 403;
    throw e;
  }
}

function timeAgo(dateStr) {
  const ms = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export function registerActionRoutes(routes) {
  // GET /api/actions/pending — all pending action items, urgency-sorted
  routes.set('GET /api/actions/pending', async (req) => {
    requireBoard(req);

    // OPT-166 P3-B1: action_proposals + campaigns are FORCE-RLS'd. All 4
    // queries routed through the same scoped client for consistency (the
    // other two tables — campaign_hitl_requests, issue_triage_log — are not
    // enforced today; scoping them is harmless).
    const scopedQuery = await withBoardScope(req.auth);
    try {
      const [hitl, failed, triage, prs] = await Promise.all([
        // 1. HITL requests (urgency 1 — blocks running campaign)
        scopedQuery(`
          SELECT h.id, h.campaign_id, h.agent_id, h.question, h.created_at,
                 c.goal_description AS campaign_goal
          FROM agent_graph.campaign_hitl_requests h
          LEFT JOIN agent_graph.campaigns c ON c.id = h.campaign_id
          WHERE h.status = 'pending'
          ORDER BY h.created_at ASC
        `),

        // 2. Failed campaigns (urgency 2) — only recent (7 days), older ones age out
        scopedQuery(`
          SELECT id, goal_description, campaign_status, completed_iterations,
                 max_iterations, updated_at, created_at
          FROM agent_graph.campaigns
          WHERE campaign_status IN ('failed', 'plateau_paused')
            AND updated_at > now() - interval '7 days'
          ORDER BY updated_at DESC
          LIMIT 50
        `),

        // 3. Triage board_review (urgency 3)
        scopedQuery(`
          SELECT id, source, source_issue_id, source_issue_url, title,
                 clarity_score, scope_estimate, classification, reasoning,
                 created_at
          FROM agent_graph.issue_triage_log
          WHERE decision = 'board_review'
            AND decision_overridden_by IS NULL
          ORDER BY created_at ASC
          LIMIT 50
        `),

        // 4. Open PRs from action_proposals (urgency 4)
        scopedQuery(`
          SELECT id, subject, github_pr_url, github_pr_number, target_repo,
                 campaign_id, send_state, board_action, created_at
          FROM agent_graph.action_proposals
          WHERE action_type = 'code_fix_pr'
            AND github_pr_url IS NOT NULL
            AND send_state NOT IN ('delivered', 'cancelled')
            AND board_action IS NULL
          ORDER BY created_at DESC
          LIMIT 50
        `),
      ]);

      const items = [];

      for (const row of hitl.rows) {
        items.push({
          id: row.id,
          type: 'hitl',
          urgency: 1,
          title: `Campaign needs input: ${(row.campaign_goal || 'Unknown').slice(0, 80)}`,
          subtitle: `Asked ${timeAgo(row.created_at)}`,
          metadata: {
            campaign_id: row.campaign_id,
            question: row.question,
            agent_id: row.agent_id,
          },
          actions: ['respond', 'skip'],
          created_at: row.created_at,
        });
      }

      for (const row of failed.rows) {
        items.push({
          id: row.id,
          type: 'failed_campaign',
          urgency: 2,
          title: `Failed: ${(row.goal_description || 'Unknown').slice(0, 80)}`,
          subtitle: `${row.completed_iterations}/${row.max_iterations} iterations, failed ${timeAgo(row.updated_at)}`,
          metadata: {
            campaign_id: row.id,
            iterations: row.completed_iterations,
            max_iterations: row.max_iterations,
          },
          actions: ['retry', 'cancel'],
          created_at: row.updated_at,
        });
      }

      for (const row of triage.rows) {
        items.push({
          id: row.id,
          type: 'triage_review',
          urgency: 3,
          title: row.title,
          subtitle: `${row.source} ${row.scope_estimate || '?'} — ${timeAgo(row.created_at)}`,
          metadata: {
            source: row.source,
            source_issue_id: row.source_issue_id,
            source_issue_url: row.source_issue_url,
            clarity_score: row.clarity_score,
            scope_estimate: row.scope_estimate,
            classification: row.classification,
            reasoning: row.reasoning,
          },
          actions: ['assign', 'skip'],
          created_at: row.created_at,
        });
      }

      for (const row of prs.rows) {
        items.push({
          id: row.id,
          type: 'open_pr',
          urgency: 4,
          title: row.subject || `PR #${row.github_pr_number}`,
          subtitle: `${row.target_repo} — ${timeAgo(row.created_at)}`,
          metadata: {
            github_pr_url: row.github_pr_url,
            github_pr_number: row.github_pr_number,
            target_repo: row.target_repo,
            campaign_id: row.campaign_id,
            send_state: row.send_state,
          },
          actions: ['view_on_github'],
          created_at: row.created_at,
        });
      }

      // Sort by urgency (ascending), then by created_at (oldest first within same urgency)
      items.sort((a, b) => {
        if (a.urgency !== b.urgency) return a.urgency - b.urgency;
        return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      });

      return {
        items,
        counts: {
          hitl: hitl.rows.length,
          failed: failed.rows.length,
          triage: triage.rows.length,
          prs: prs.rows.length,
          total: items.length,
        },
      };
    } finally {
      await scopedQuery.release();
    }
  });

  // GET /api/actions/count — lightweight count-only for badge
  routes.set('GET /api/actions/count', async (req) => {
    requireBoard(req);

    // OPT-166 P3-B1: same enforced-table surface as /api/actions/pending above.
    const scopedQuery = await withBoardScope(req.auth);
    let hitl, failed, triage, prs;
    try {
      [hitl, failed, triage, prs] = await Promise.all([
        scopedQuery(`SELECT count(*)::int AS n FROM agent_graph.campaign_hitl_requests WHERE status = 'pending'`),
        scopedQuery(`SELECT count(*)::int AS n FROM agent_graph.campaigns WHERE campaign_status IN ('failed', 'plateau_paused') AND updated_at > now() - interval '7 days'`),
        scopedQuery(`
          SELECT count(*)::int AS n FROM agent_graph.issue_triage_log
          WHERE decision = 'board_review' AND decision_overridden_by IS NULL
        `),
        scopedQuery(`
          SELECT count(*)::int AS n FROM agent_graph.action_proposals
          WHERE action_type = 'code_fix_pr'
            AND github_pr_url IS NOT NULL
            AND send_state NOT IN ('delivered', 'cancelled')
            AND board_action IS NULL
        `),
      ]);
    } finally {
      await scopedQuery.release();
    }

    const counts = {
      hitl: hitl.rows[0].n,
      failed: failed.rows[0].n,
      triage: triage.rows[0].n,
      prs: prs.rows[0].n,
    };
    counts.total = counts.hitl + counts.failed + counts.triage + counts.prs;

    return { counts };
  });
}
