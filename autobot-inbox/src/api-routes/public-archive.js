import { query } from '../db.js';
import { pickPublicEventMetadata, containsPublicUnsafePii } from '../../../lib/runtime/state/infrastructure.js';

/**
 * Public Event Archive API routes (SPEC §8: "public event archive from day one").
 *
 * These endpoints are read-only, unauthenticated, and expose only the
 * autobot_public.event_log table. No internal state, no PII, no email content.
 *
 * The `metadata` JSONB column is NOT returned verbatim. It is projected down to
 * an explicit allow-list (PUBLIC_EVENT_METADATA_KEYS, defined in
 * lib/runtime/state/infrastructure.js) so an unexpected key written by any
 * current/future publishEvent caller can never leak to this unauthenticated
 * endpoint (P1, deny-by-default). Edit the allow-list there — not here — when
 * adding a genuinely public-safe field.
 *
 * The `summary` column, unlike `metadata`, is legitimate free-text prose (e.g.
 * "split 3 identities from contact a to new contact b") — it is not projected
 * through an allow-list, but any summary that is email- or phone-shaped is
 * withheld (issue #546, "the #496 bug class one layer down": nothing
 * structurally prevented a future publishEvent caller from putting PII into
 * summary).
 *
 * GET /api/public/events       — paginated event log
 * GET /api/public/events/feed  — recent events (last 24h, for dashboards)
 * GET /api/public/merkle       — latest merkle proof roots for verification
 */
const PUBLIC_SUMMARY_WITHHELD = '[summary withheld: failed public-safety check]';

// Deny-by-default: on any doubt, withhold the whole summary rather than try to
// redact just the PII-shaped substring.
function redactPublicSummary(summary) {
  if (typeof summary === 'string' && summary.length > 0 && containsPublicUnsafePii(summary)) {
    return PUBLIC_SUMMARY_WITHHELD;
  }
  return summary;
}

export function registerPublicArchiveRoutes(routes) {
  // GET /api/public/events — paginated public event archive
  // Query params: ?limit=50&offset=0&type=draft_approved&since=2026-01-01
  routes.set('GET /api/public/events', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);
    const eventType = url.searchParams.get('type');
    const since = url.searchParams.get('since');

    const conditions = [];
    const params = [];

    if (eventType) {
      params.push(eventType);
      conditions.push(`event_type = $${params.length}`);
    }
    if (since) {
      params.push(since);
      conditions.push(`created_at >= $${params.length}::timestamptz`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Count total for pagination
    const countResult = await query(
      `SELECT COUNT(*) AS total FROM autobot_public.event_log ${where}`,
      params
    );
    const total = parseInt(countResult.rows[0]?.total || '0', 10);

    // Fetch page — omit agent_id from public view (internal identifier)
    params.push(limit, offset);
    const result = await query(
      `SELECT id, event_type, summary, work_item_id, metadata, created_at
       FROM autobot_public.event_log
       ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    // Project metadata to the public allow-list — never return the raw column.
    // Withhold any summary that looks like it carries PII (issue #546).
    const events = result.rows.map((row) => ({
      ...row,
      summary: redactPublicSummary(row.summary),
      metadata: pickPublicEventMetadata(row.metadata),
    }));

    return {
      events,
      pagination: { total, limit, offset, has_more: offset + limit < total },
    };
  });

  // GET /api/public/events/feed — last 24h of events (lightweight for live dashboards)
  routes.set('GET /api/public/events/feed', async () => {
    const result = await query(
      `SELECT id, event_type, summary, created_at
       FROM autobot_public.event_log
       WHERE created_at >= now() - interval '24 hours'
       ORDER BY created_at DESC
       LIMIT 100`
    );

    // Withhold any summary that looks like it carries PII (issue #546) — same
    // treatment as the /events endpoint above.
    const events = result.rows.map((row) => ({ ...row, summary: redactPublicSummary(row.summary) }));

    return { events, period: '24h' };
  });

  // GET /api/public/merkle — latest merkle proof roots for each ledger type
  routes.set('GET /api/public/merkle', async () => {
    try {
      const result = await query(
        `SELECT DISTINCT ON (proof_type)
           proof_type, merkle_root, record_count, period_start, period_end, created_at
         FROM agent_graph.merkle_proofs
         ORDER BY proof_type, created_at DESC`
      );

      return { proofs: result.rows };
    } catch (err) {
      if (err.message?.includes('does not exist')) {
        return { proofs: [], note: 'Merkle proofs table not yet created' };
      }
      throw err;
    }
  });

  // GET /api/public/stats — aggregate transparency stats
  routes.set('GET /api/public/stats', async () => {
    const result = await query(
      `SELECT
         COUNT(*) AS total_events,
         COUNT(DISTINCT event_type) AS event_types,
         MIN(created_at) AS first_event,
         MAX(created_at) AS latest_event,
         COUNT(*) FILTER (WHERE created_at >= now() - interval '24 hours') AS events_24h,
         COUNT(*) FILTER (WHERE created_at >= now() - interval '7 days') AS events_7d
       FROM autobot_public.event_log`
    );

    return result.rows[0] || {};
  });
}
