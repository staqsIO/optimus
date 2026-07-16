/**
 * OPT-162 Phase 3 (ADR-020) — Today "Open Obligations" union read.
 *
 * Single source of truth for the SQL that the GET /api/today handler runs when
 * the union cutover is enabled (TODAY_OBLIGATIONS_SOURCE === 'union'). Exported
 * here (rather than inlined in api.js) so the tenancy tests exercise the EXACT
 * predicates the handler uses — handler SQL and test SQL cannot drift.
 *
 * It reads agent_graph.obligations_today_v (mig 179), which UNIONs:
 *   - inbox.human_tasks cards NOT linked to a work_item (pre-migration / card-only), and
 *   - agent_graph.work_items with obligation_type set + live status (Phase 2 bridge).
 * The view dedups by construction (the ht leg excludes work_item-linked cards), so
 * a gated obligation present in both stores appears exactly once (the work_item row).
 *
 * TENANCY PARITY with the legacy inbox.human_tasks read (OPT-115/126/STAQPRO-588):
 *
 *   Per-org   — visibleClause(principal, { ownerOrgCol: 'o.owner_org_id' }) AND-ed
 *               in, IDENTICAL to the legacy htOrgFilter. The view exposes ONE unified
 *               owner_org_id (ht.owner_org_id on leg 1, wi.owner_org_id on leg 2), so
 *               one clause scopes both legs the same way. adminBypass → TRUE;
 *               unresolved principal → FALSE → zero rows (fail-closed).
 *
 *   Per-viewer — the legacy htViewerFilter tests (m.to_addresses || m.cc_addresses)
 *               for channel='email' and BYPASSES non-email / no-source-message tasks.
 *               The view emits two UNIFORM columns that reproduce this on both legs:
 *                 is_email_scoped (bool)       — true only when the recipient test applies
 *                 viewer_match_emails (text[]) — the to/cc set to overlap-test
 *               So the viewer predicate below is the EXACT analogue of htViewerFilter:
 *                 (NOT o.is_email_scoped OR o.viewer_match_emails && $emails)
 *               The work_items leg's viewer_match_emails is the bridge-denormalized
 *               viewer_emails (mig 178), stamped to the SAME (to||cc) set api.js uses.
 *
 * Param ordering convention mirrors the legacy handler: the viewer-emails param ($1,
 * when scopeEmails !== null) is pushed FIRST, then the visibleClause org params after,
 * so positional indices stay correct across owe / waiting / stats. Callers pass the
 * same params array to all three queries (exactly as the legacy code does).
 */

/**
 * Live-row predicate on the view, the union-aware equivalent of HT_LIVE_PREDICATE.
 *  - soft-delete: deleted_at IS NULL (ht leg carries it; wi leg is always NULL)
 *  - non-terminal: ht leg via kanban_status; wi leg via work_item_status. The view's
 *    wi leg already filters status NOT IN (terminal) in SQL, and the ht leg here drops
 *    done/skipped/not_for_us — together this matches the legacy non-terminal filter.
 *  - not snoozed: snoozed_until IS NULL OR <= now() (ht-native; wi leg is NULL → passes)
 *  - staleness floor: due_date IS NULL OR >= now() - 7d (BOTH legs)
 */
export const OBLIG_LIVE_PREDICATE = `
  o.deleted_at IS NULL
  AND (o.kanban_status IS NULL OR o.kanban_status NOT IN ('done','skipped','not_for_us'))
  AND (o.snoozed_until IS NULL OR o.snoozed_until <= now())
  AND (o.due_date IS NULL OR o.due_date >= (now() - interval '7 days'))`;

/**
 * Display fields selected from the view + the LEFT JOINed source message + contact,
 * preserving the legacy response contract (from_*, subject, received_at, channel,
 * webhook_source, contact_*). Mirrors HT_BASE_FIELDS in api.js.
 */
export const OBLIG_BASE_FIELDS = `
  o.obligation_id AS id, o.obligation_type AS signal_type, o.title AS content,
  o.confidence, o.due_date,
  o.created_at, o.message_id, NULL::text AS domain,
  m.from_address, m.from_name, m.subject, m.received_at, m.channel,
  CASE WHEN m.channel = 'webhook' THEN
    (SELECT SUBSTRING(l FROM 'webhook:(.+)') FROM UNNEST(m.labels) l WHERE l LIKE 'webhook:%' LIMIT 1)
  END AS webhook_source,
  c.contact_type, c.is_vip, c.tier`;

/**
 * Build the viewer-overlap filter fragment for the view. Returns '' (no filter) when
 * scopeEmails === null (adminBypass global view) — IDENTICAL semantics to the legacy
 * htViewerFilter, which is also empty in that case. When non-null, the emails param
 * MUST already be at $1 (pushed first by the caller).
 *
 * @param {string[]|null} scopeEmails
 * @returns {string} SQL fragment beginning with " AND (...)" or ''
 */
export function obligViewerFilter(scopeEmails) {
  if (scopeEmails === null) return '';
  // Exact analogue of api.js htViewerFilter:
  //   m.id IS NULL OR m.channel != 'email' OR EXISTS(lower(addr) = ANY($1))  [legacy]
  //   NOT is_email_scoped OR viewer_match_emails && lower($1)                [view]
  // Both: bypass non-email / no-message rows; else require to/cc overlap with viewer.
  //
  // CASE-INSENSITIVE on BOTH sides, matching the legacy's defensive lower(addr):
  //   - the view emits viewer_match_emails already LOWERCASED (mig 179, both legs);
  //   - $1 is lowercased here via the subquery, so the && overlap is lower-vs-lower
  //     regardless of the caller's scopeEmails casing.
  // (Linus BLOCKER fix, OPT-162 P3.) The raw `&&` without lower() silently dropped a
  // mixed-case-recipient obligation for a lowercase viewer — a correctness regression
  // vs the legacy. Folding both sides removes that divergence.
  return `
    AND (
      NOT o.is_email_scoped
      OR o.viewer_match_emails && ARRAY(SELECT lower(e) FROM unnest($1::text[]) AS e)
    )`;
}

/**
 * The OWE list query (inbound asks — obligation_type 'request').
 * @param {string} viewerFilter  from obligViewerFilter()
 * @param {string} orgFilter     " AND <visibleClause.sql>"
 */
export function oweQuery(viewerFilter, orgFilter) {
  return `
    SELECT ${OBLIG_BASE_FIELDS}, 'inbound'::text AS direction
    FROM agent_graph.obligations_today_v o
    LEFT JOIN inbox.messages m ON m.id = o.message_id
    LEFT JOIN signal.contacts c ON lower(c.email_address) = lower(m.from_address)
    WHERE ${OBLIG_LIVE_PREDICATE}
      AND o.obligation_type = 'request'${viewerFilter}${orgFilter}
    ORDER BY
      CASE WHEN o.due_date < now() THEN 0 ELSE 1 END,
      o.due_date ASC NULLS LAST,
      o.created_at DESC`;
}

/**
 * The WAITING list query (everything else).
 */
export function waitingQuery(viewerFilter, orgFilter) {
  return `
    SELECT ${OBLIG_BASE_FIELDS}, 'outbound'::text AS direction
    FROM agent_graph.obligations_today_v o
    LEFT JOIN inbox.messages m ON m.id = o.message_id
    LEFT JOIN signal.contacts c ON lower(c.email_address) = lower(m.from_address)
    WHERE ${OBLIG_LIVE_PREDICATE}
      AND (o.obligation_type IS NULL OR o.obligation_type <> 'request')${viewerFilter}${orgFilter}
    ORDER BY o.created_at ASC`;
}

/**
 * The summary stats query — recomputed from the SAME live/scoped population.
 */
export function statsQuery(viewerFilter, orgFilter) {
  const base = `FROM agent_graph.obligations_today_v o LEFT JOIN inbox.messages m ON m.id = o.message_id WHERE ${OBLIG_LIVE_PREDICATE}`;
  return `
    SELECT
      (SELECT COUNT(*) ${base} AND o.obligation_type = 'request'${viewerFilter}${orgFilter}) AS owe_count,
      (SELECT COUNT(*) ${base} AND (o.obligation_type IS NULL OR o.obligation_type <> 'request')${viewerFilter}${orgFilter}) AS waiting_count,
      (SELECT COUNT(*) ${base} AND o.due_date < now()${viewerFilter}${orgFilter}) AS overdue_count,
      (SELECT COUNT(*) ${base} AND o.due_date BETWEEN now() AND now() + interval '7 days'${viewerFilter}${orgFilter}) AS due_this_week`;
}

/**
 * Whether the union cutover is enabled. Default OFF (legacy human_tasks-only read),
 * so the parent can flip it on deliberately after the tenancy review + checkpoint.
 * @returns {boolean}
 */
export function unionSourceEnabled(env = process.env) {
  return env.TODAY_OBLIGATIONS_SOURCE === 'union';
}
