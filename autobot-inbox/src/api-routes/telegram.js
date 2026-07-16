/**
 * Telegram observability API — read-only board visibility into the Telegram channel.
 *
 * Data sources:
 *   INBOUND  — inbox.messages WHERE channel='telegram' (set by telegram/listener.js on ingest)
 *   OUTBOUND — agent_graph.action_proposals WHERE channel='telegram' (approved drafts sent via telegram/sender.js)
 *              + autobot_comms.outbound_intents WHERE channel='telegram' (notifyBoard calls logged via logCommsIntent)
 *   STATUS   — bot token presence + TELEGRAM_BOARD_USER_IDS config
 *
 * Routes:
 *   GET /api/telegram/activity?limit=50&since=<iso>
 *   GET /api/telegram/status
 */

import { query, withBoardScope } from '../db.js';

function requireBoard(req) {
  if (!req.auth || req.auth.role !== 'board') {
    const e = new Error('Board role required');
    e.statusCode = 403;
    throw e;
  }
}

export function registerTelegramRoutes(routes) {
  /**
   * GET /api/telegram/activity
   * Returns recent inbound messages + outbound sends, unified into a timeline.
   * Query params:
   *   limit  — max rows (default 50, max 200)
   *   since  — ISO timestamp filter (default 7 days)
   */
  routes.set('GET /api/telegram/activity', async (req) => {
    requireBoard(req);

    const url = new URL(req.url, 'http://localhost');
    const rawLimit = parseInt(url.searchParams.get('limit') || '50', 10);
    const limit = Math.min(isNaN(rawLimit) ? 50 : rawLimit, 200);
    const sinceParam = url.searchParams.get('since');
    const since = sinceParam
      ? new Date(sinceParam)
      : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    if (isNaN(since.getTime())) {
      throw Object.assign(new Error('Invalid since parameter'), { statusCode: 400 });
    }

    // OPT-166 P3-B1: inbox.messages + action_proposals are FORCE-RLS'd.
    // outbound_intents (autobot_comms schema) is not enforced today but is
    // routed through the same scoped client for consistency.
    const scopedQuery = await withBoardScope(req.auth);
    let inboundResult, outboundProposals, outboundIntents;
    try {
      [inboundResult, outboundProposals, outboundIntents] = await Promise.all([
      // Inbound: messages ingested by telegram/listener.js
      // tenancy:allow-unscoped — board-only ops observability (ops-control tier) over the
      // single shared Telegram channel; filtered by channel='telegram', not org-siloed data.
      scopedQuery(
        `SELECT
           id,
           'inbound'           AS direction,
           from_address        AS sender,
           from_name           AS sender_name,
           snippet             AS body,
           thread_id           AS chat_id,
           received_at         AS ts,
           work_item_id
         FROM inbox.messages
         WHERE channel = 'telegram'
           AND received_at >= $1
         ORDER BY received_at DESC
         LIMIT $2`,
        [since.toISOString(), limit]
      ),

      // Outbound: sent drafts (channel='telegram') from action_proposals
      // tenancy:allow-unscoped — board-only ops observability over the shared Telegram channel.
      scopedQuery(
        `SELECT
           ap.id,
           'outbound'                                        AS direction,
           m.from_address                                    AS recipient,
           NULL                                              AS sender_name,
           COALESCE(ap.board_edited_body, ap.body)           AS body,
           m.thread_id                                       AS chat_id,
           COALESCE(ap.updated_at, ap.created_at)           AS ts,
           ap.send_state,
           ap.board_action,
           ap.provider_sent_id                              AS telegram_msg_id
         FROM agent_graph.action_proposals ap
         LEFT JOIN inbox.messages m ON m.id = ap.message_id
         WHERE ap.channel = 'telegram'
           AND COALESCE(ap.updated_at, ap.created_at) >= $1
         ORDER BY COALESCE(ap.updated_at, ap.created_at) DESC
         LIMIT $2`,
        [since.toISOString(), limit]
      ),

      // Outbound notifications (notifyBoard calls): autobot_comms.outbound_intents
      scopedQuery(
        `SELECT
           id,
           'outbound'      AS direction,
           recipient,
           NULL            AS sender_name,
           body,
           NULL            AS chat_id,
           created_at      AS ts,
           status          AS send_state,
           intent_type,
           source_agent
         FROM autobot_comms.outbound_intents
         WHERE channel = 'telegram'
           AND created_at >= $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [since.toISOString(), limit]
      ),
    ]);
    } finally {
      await scopedQuery.release();
    }

    const inbound = inboundResult.rows.map(r => ({ ...r, event_type: 'message' }));
    const sentDrafts = outboundProposals.rows.map(r => ({ ...r, event_type: 'draft_send' }));
    const notifications = outboundIntents.rows.map(r => ({ ...r, event_type: 'notification' }));

    // Merge and sort by ts descending, cap at limit
    const all = [...inbound, ...sentDrafts, ...notifications]
      .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
      .slice(0, limit);

    return {
      since: since.toISOString(),
      limit,
      total: all.length,
      inbound_count: inbound.length,
      outbound_count: sentDrafts.length + notifications.length,
      events: all,
    };
  });

  /**
   * GET /api/telegram/status
   * Returns connection/config status of the Telegram bot.
   * No DB query needed — derives from env.
   */
  routes.set('GET /api/telegram/status', async (req) => {
    requireBoard(req);

    const tokenConfigured = !!process.env.TELEGRAM_BOT_TOKEN;
    const boardUserIds = (process.env.TELEGRAM_BOARD_USER_IDS || '')
      .split(',')
      .map(id => id.trim())
      .filter(Boolean);

    // Check if any telegram accounts are registered
    // tenancy:allow-unscoped — board-only ops status surface (ops-control tier); telegram is a
    // single shared channel, these are aggregate counts/account-status, not org-siloed reads.
    const accountResult = await query(
      `SELECT id, label, identifier, is_active, sync_status, last_sync_at, last_error
       FROM inbox.accounts
       WHERE channel = 'telegram'
       ORDER BY created_at DESC`,
      []
    );

    // OPT-166 P3-B1: inbox.messages + action_proposals (subqueries below) are
    // FORCE-RLS'd; outbound_intents is not enforced but scoped for consistency.
    const scopedQuery = await withBoardScope(req.auth);
    // Recent activity count (last 24h)
    let recentResult;
    try {
      recentResult = await scopedQuery(
        `SELECT
           (SELECT COUNT(*) FROM inbox.messages WHERE channel='telegram' AND received_at >= now() - interval '24 hours') AS inbound_24h,
           (SELECT COUNT(*) FROM agent_graph.action_proposals WHERE channel='telegram' AND updated_at >= now() - interval '24 hours' AND send_state='delivered') AS outbound_24h,
           (SELECT COUNT(*) FROM autobot_comms.outbound_intents WHERE channel='telegram' AND created_at >= now() - interval '24 hours') AS notifications_24h`,
        []
      );
    } finally {
      await scopedQuery.release();
    }

    const counts = recentResult.rows[0] || {};

    return {
      bot_token_configured: tokenConfigured,
      board_user_ids_count: boardUserIds.length,
      board_user_ids_configured: boardUserIds.length > 0,
      accounts: accountResult.rows,
      stats_24h: {
        inbound: parseInt(counts.inbound_24h || '0', 10),
        outbound: parseInt(counts.outbound_24h || '0', 10),
        notifications: parseInt(counts.notifications_24h || '0', 10),
      },
    };
  });
}
