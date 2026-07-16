/**
 * Signal → human_tasks promoter.
 *
 * PRD: autobot-inbox/docs/internal/prds/meeting-actions-to-kanban.md §3 + §4
 *
 * Consumes a row from inbox.signals (typically just after executor-triage
 * inserts it) and either:
 *
 *   - inserts an inbox.human_tasks row in column 'inbox' (auto-promote)
 *   - inserts an inbox.human_tasks row in column 'proposed' (mid-confidence)
 *   - leaves the signal in place and stamps relevance_skipped=true on its
 *     metadata so /meetings can show "X actions filtered out"
 *
 * The promoter is a Stage-2-sibling of executor-triage (see
 * .docs/signal-pipeline-architecture.md). It reads inbox.signals; it does
 * not introduce a new ingestion path.
 */

import { gate } from '../human-task-relevance.js';

const PROMOTABLE_TYPES = new Set([
  'action_item',
  'commitment',
  'request',
  'decision',
]);

const TASK_TYPE_MAP = {
  action_item: 'action',
  commitment: 'action',
  request: 'request',
  decision: 'decision_followup',
};

// PRD §3 — decisions are records, not work. They land done-from-creation
// on a dedicated lane unless the board explicitly promotes them.
const DECISION_INIT_STATUS = 'done';

const TITLE_CAP = 200;

/**
 * Extract the obligor (the person who took the action) from a meeting
 * signal's content. The meeting prompt enforces third-person format:
 *
 *   "<Name> to <verb>"
 *   "<Name> committed to <verb>"
 *   "<Name> asked <other> to <verb>"  (obligor is <other>)
 *
 * Returns null when no recognised pattern is found.
 *
 * @param {string|null} content
 * @returns {string|null}
 */
export function extractObligor(content) {
  if (!content || typeof content !== 'string') return null;
  const trimmed = content.trim();
  if (!trimmed) return null;

  // Use the first line only — never span newlines (a multi-paragraph
  // signal would otherwise drag content across the "to" pivot).
  const firstLine = trimmed.split(/\r?\n/, 1)[0].trim();
  if (!firstLine) return null;

  // Name token: starts with an uppercase letter (incl. Unicode like "José",
  // "Müller"), then any letters/digits/apostrophes/hyphens.
  const N = `[\\p{Lu}][\\p{L}\\p{N}'-]*`;
  // Inter-word separator: spaces/tabs only — no newlines.
  const W = `(?:[ \\t]+${N})*`;

  // "X asked Y to <verb>" — obligor is Y. First so it doesn't get clipped.
  const asked = firstLine.match(new RegExp(`^(${N}${W})[ \\t]+asked[ \\t]+(${N}${W})[ \\t]+to\\b`, 'u'));
  if (asked) return asked[2];

  // "X committed to <verb>"
  const committed = firstLine.match(new RegExp(`^(${N}${W})[ \\t]+committed[ \\t]+to\\b`, 'u'));
  if (committed) return committed[1];

  // "X to <verb>" — the most common shape.
  const direct = firstLine.match(new RegExp(`^(${N}${W})[ \\t]+to\\b`, 'u'));
  if (direct) return direct[1];

  return null;
}

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}

/**
 * Pull a one-line title out of the signal content. Strip trailing
 * punctuation so the card reads cleanly.
 */
function titleFromContent(content) {
  const firstLine = String(content || '').split('\n')[0].trim();
  return truncate(firstLine, TITLE_CAP);
}

/**
 * Promote (or refuse to promote) a single signal.
 *
 * @param {Object} opts
 * @param {Function} opts.query - pg-style query function bound to a connection
 * @param {string} opts.signalId - inbox.signals.id to promote
 * @param {Array} opts.knownPeople - [{id, display_name|name, aliases}]
 * @param {Array} [opts.projects] - [{id, name, domain}]
 * @param {Object} [opts.meta] - optional override for {speakers, obligor}
 * @returns {Promise<{
 *   decision: 'auto'|'propose'|'skip'|'already_promoted'|'not_applicable',
 *   reason?: string,
 *   task_id: string|null,
 *   score: number|null,
 *   signals: object|null,
 * }>}
 */
export async function promoteSignal({
  query,
  signalId,
  knownPeople = [],
  projects = [],
  meta: explicitMeta = {},
}) {
  if (!query || !signalId) {
    throw new Error('promoteSignal requires { query, signalId }');
  }

  // 1. Idempotence — if we already promoted this signal, return the row.
  const existing = await query(
    `SELECT id, status, relevance_score
       FROM inbox.human_tasks
      WHERE signal_id = $1
        AND deleted_at IS NULL
      LIMIT 1`,
    [signalId],
  );
  if (existing.rows.length > 0) {
    return {
      decision: 'already_promoted',
      task_id: existing.rows[0].id,
      score: existing.rows[0].relevance_score ?? null,
      signals: null,
    };
  }

  // 2. Load the signal + its parent message.
  // inbox.messages.labels carries source tags ("webhook:tldv", etc.).
  // The promoter only needs channel to decide promotability; speaker
  // context arrives via the explicit `meta` argument (executor-triage
  // already has the pass2_topics structure in hand when it inserts the
  // signal, so passing it through is cheaper than re-reading).
  const sigQ = await query(
    `SELECT s.id, s.message_id, s.signal_type, s.content, s.confidence,
            s.direction, s.domain, s.due_date,
            m.channel AS msg_channel,
            m.labels  AS msg_labels
       FROM inbox.signals s
       JOIN inbox.messages m ON m.id = s.message_id
      WHERE s.id = $1`,
    [signalId],
  );
  if (sigQ.rows.length === 0) {
    return { decision: 'not_applicable', reason: 'signal_not_found', task_id: null, score: null, signals: null };
  }
  const sig = sigQ.rows[0];

  // 3. Filter — promote obligations from ANY channel (ADR-008 Stream A:
  //    extend coverage to email). Previously short-circuited to meeting-only
  //    (msg_channel === 'webhook'); email obligations are now promoted through
  //    the SAME relevance gate. The gate's knownPeople aliases (loaded from
  //    signal.contacts by the live promoter) are what keep email precision —
  //    without them every email obligation scores 0 and is skipped.
  if (!PROMOTABLE_TYPES.has(sig.signal_type)) {
    return { decision: 'not_applicable', reason: 'unpromotable_type', task_id: null, score: null, signals: null };
  }

  // 4. Build relevance context.
  const obligor = explicitMeta.obligor ?? extractObligor(sig.content);
  const speakers = Array.isArray(explicitMeta.speakers) ? explicitMeta.speakers : [];

  const gateOut = gate({
    obligor,
    speakers,
    knownPeople,
    domain: sig.domain || undefined,
    projects,
    llmRelevant: explicitMeta.llmRelevant ?? null,
  });

  // 5. Skip — stamp the signal so /meetings can render "Y filtered out".
  if (gateOut.decision === 'skip') {
    await query(
      `UPDATE inbox.signals
          SET metadata = COALESCE(metadata, '{}'::jsonb)
                        || jsonb_build_object(
                             'relevance_skipped', true,
                             'relevance_score', $2::numeric,
                             'relevance_signals', $3::jsonb,
                             'relevance_skipped_at', to_jsonb(now())
                           )
        WHERE id = $1`,
      [signalId, gateOut.score, JSON.stringify(gateOut.signals)],
    );
    return {
      decision: 'skip',
      task_id: null,
      score: gateOut.score,
      signals: gateOut.signals,
    };
  }

  // 6. Promote — insert the human_tasks row.
  const title = titleFromContent(sig.content);
  const taskType = TASK_TYPE_MAP[sig.signal_type] || 'action';
  // Decisions land done-from-creation. Auto/propose lane assignment otherwise
  // comes from the gate.
  const status =
    sig.signal_type === 'decision'
      ? DECISION_INIT_STATUS
      : gateOut.column /* 'inbox' or 'proposed' */;

  // Assignee label: the obligor string, if recognised. Resolution to a
  // contact_id is done by the enrichment pass — promoter only records
  // what the prompt extracted.
  const assigneeLabel = obligor || null;

  const dueDate = sig.due_date ? sig.due_date.toISOString().slice(0, 10) : null;

  const insertResult = await query(
    `INSERT INTO inbox.human_tasks
       (signal_id, message_id, source_quote, source_ts,
        title, description, due_date,
        task_type,
        assignee_label,
        status,
        relevance_score, extraction_confidence,
        enrichment_status,
        created_by)
     VALUES
       ($1, $2, $3, $4,
        $5, $6, $7,
        $8,
        $9,
        $10,
        $11, $12,
        'pending',
        'meeting_pipeline')
     RETURNING id`,
    [
      signalId,
      sig.message_id,
      sig.content, // source_quote = verbatim
      explicitMeta.source_ts ?? null,
      title,
      null, // description filled by enrichment
      dueDate,
      taskType,
      assigneeLabel,
      status,
      gateOut.score,
      sig.confidence ?? null,
    ],
  );

  const taskId = insertResult.rows[0].id;

  // PRD §6 / AD-1 / FR-1 — wake the enrichment worker. Underscored channel
  // name (PRD's dotted form fails LISTEN parsing without double-quoting,
  // and PGlite's listen() doesn't quote). Fire only on real promotions:
  // skip/not_applicable/already_promoted have no new row to enrich.
  try {
    await query(
      `SELECT pg_notify('human_task_enrichment_pending', $1)`,
      [taskId],
    );
  } catch (err) {
    // Non-fatal — the worker polls as a backstop. The insert already
    // committed; failing the whole promotion on a notify miss would be
    // worse than a slightly delayed enrichment pass. Log so we can spot
    // a NOTIFY infra outage in audit instead of silent degradation.
    console.warn('[promoter] pg_notify failed:', err.message);
  }

  return {
    decision: gateOut.decision, // 'auto' or 'propose'
    task_id: taskId,
    score: gateOut.score,
    signals: gateOut.signals,
  };
}

