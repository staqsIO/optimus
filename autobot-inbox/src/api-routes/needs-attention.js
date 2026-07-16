/**
 * Needs-attention API — surfaces retry-exhausted work items to the board.
 *
 * Real-time delivery happens via the existing /api/events SSE channel
 * (the SQL trigger in sql/087-needs-attention-trigger.sql emits on
 * 'autobot_events' with event_type='needs_attention'). These REST routes
 * exist for catch-up on (re)connect and for the board's "acknowledge"
 * action — pg_notify alone loses events when the LISTEN session drops.
 *
 * GET  /api/needs-attention?since=<iso>  — unacked rows since cutoff (default 30 min)
 * POST /api/needs-attention/:id/ack      — mark a row acknowledged
 */

import { query } from '../db.js';

function requireBoard(req) {
  if (!req.auth || req.auth.role !== 'board') {
    const e = new Error('Board role required');
    e.statusCode = 403;
    throw e;
  }
}

export function registerNeedsAttentionRoutes(routes) {
  routes.set('GET /api/needs-attention', async (req) => {
    requireBoard(req);

    const url = new URL(req.url, 'http://localhost');
    const sinceParam = url.searchParams.get('since');
    const since = sinceParam ? new Date(sinceParam) : new Date(Date.now() - 30 * 60 * 1000);
    if (Number.isNaN(since.getTime())) {
      throw Object.assign(new Error('Invalid since parameter'), { statusCode: 400 });
    }

    const result = await query(
      `SELECT id, signature, work_item_id, agent_id, payload, created_at
       FROM agent_graph.needs_attention_log
       WHERE acknowledged_at IS NULL AND created_at >= $1
       ORDER BY created_at DESC
       LIMIT 200`,
      [since.toISOString()]
    );

    // Group by signature so the dashboard can render one card per cluster
    // with a count, instead of N cards for the same root-cause failure.
    const bySignature = new Map();
    for (const row of result.rows) {
      const existing = bySignature.get(row.signature);
      if (existing) {
        existing.count += 1;
        existing.ids.push(row.id);
        if (new Date(row.created_at) > new Date(existing.last_seen)) {
          existing.last_seen = row.created_at;
        }
      } else {
        bySignature.set(row.signature, {
          signature: row.signature,
          agent_id: row.agent_id,
          sample_work_item_id: row.work_item_id,
          payload: row.payload,
          count: 1,
          first_seen: row.created_at,
          last_seen: row.created_at,
          ids: [row.id],
        });
      }
    }

    return {
      since: since.toISOString(),
      total: result.rows.length,
      clusters: Array.from(bySignature.values()),
    };
  });

  routes.set('POST /api/needs-attention/:id/ack', async (req) => {
    requireBoard(req);

    const url = new URL(req.url, 'http://localhost');
    const idStr = url.pathname.split('/api/needs-attention/')[1]?.split('/ack')[0];
    if (!idStr) {
      throw Object.assign(new Error('Missing log id'), { statusCode: 400 });
    }
    const id = parseInt(idStr, 10);
    if (Number.isNaN(id)) {
      throw Object.assign(new Error('Invalid log id'), { statusCode: 400 });
    }

    const ackedBy = req.auth?.github_username || 'unknown';
    const result = await query(
      `UPDATE agent_graph.needs_attention_log
       SET acknowledged_at = now(), acknowledged_by = $2
       WHERE id = $1 AND acknowledged_at IS NULL
       RETURNING id`,
      [id, ackedBy]
    );

    if (result.rows.length === 0) {
      throw Object.assign(new Error('Not found or already acknowledged'), { statusCode: 404 });
    }

    return { ok: true, id, acknowledged_by: ackedBy };
  });

  // Convenience: ack an entire cluster by signature in one call.
  routes.set('POST /api/needs-attention/ack-cluster', async (req, body) => {
    requireBoard(req);
    const signature = body?.signature;
    if (!signature || typeof signature !== 'string') {
      throw Object.assign(new Error('signature required'), { statusCode: 400 });
    }
    const ackedBy = req.auth?.github_username || 'unknown';
    const result = await query(
      `UPDATE agent_graph.needs_attention_log
       SET acknowledged_at = now(), acknowledged_by = $2
       WHERE signature = $1 AND acknowledged_at IS NULL`,
      [signature, ackedBy]
    );
    return { ok: true, signature, acknowledged_count: result.rowCount };
  });
}
