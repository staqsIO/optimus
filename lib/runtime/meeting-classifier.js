/**
 * Meeting → work classifier (STAQPRO-612).
 *
 * Feature spec: spec/features/003-meeting-to-work.md
 *
 * Subscribes to `meeting.received` signals. For each one it:
 *   1. loads the transcript doc (content.documents) by document_id,
 *   2. classifies informational vs action-bearing (classify_text flow-native),
 *   3. INFORMATIONAL → KB-only: zero tickets/tasks (the doc is already in the
 *      KB; over-delegation/noise-tickets is the failure mode we guard against),
 *   4. ACTION-BEARING → extracts action items (extract_entities flow-native),
 *   5. for each action: computes a stable dedup_key and skips it if a live card
 *      already exists (idempotency — covers classifier re-runs AND ambient
 *      signal-detector overlap when both stamp the same key), then creates a
 *      board task (inbox.human_tasks) stamped with signal_meeting_id, dedup_key,
 *      origin='meeting'. The board task is the PRIMARY output,
 *   6. on an EDITED transcript re-run for the same source_meeting_id, supersedes
 *      (soft-deletes) prior open derived cards before creating new ones,
 *   7. best-effort engagement association: maps the meeting to an existing
 *      engagement and stamps engagement_id when confident.
 *
 * Linear mirror — DEFAULT OFF (echo-loop guard). The classifier NEVER creates a
 * Linear issue inline via create-ticket. A dormant Linear↔human_tasks sync
 * substrate exists (push worker + routeHumanTaskWebhook + linear_issue_id /
 * push_status columns); inbound webhooks dedup on linear_issue_id. Creating an
 * issue without stamping that id back re-imports it as a duplicate. So when the
 * mirror is explicitly enabled (ctx.mirrorToLinear === true) we only set
 * push_status='pending' on the card and let the existing push worker create the
 * issue AND stamp linear_issue_id. Proper Optimus→Linear classifier wiring is a
 * SEPARATE ticket, activated with the mirror substrate.
 *
 * Design: flow_definitions steps are linear/templated and cannot branch, so the
 * classifier is a dedicated HANDLER module (not a pure flow_definition). It is
 * wired into FlowEngine.onSignal via the engine's `signalHandlers` map, so a
 * `meeting.received` signal invokes it inline on the same path as flows.
 *
 * The classify/extract/org-match calls are injected (see buildDefaultDeps) so
 * they are cleanly swappable — Carlos owns prompt/routing tuning after this.
 */

import { createLogger } from '../logger.js';
import { computeDedupKey } from './meeting-identity.js';
import { mergeMeeting } from '../graph/meeting-sync.js';

const log = createLogger('runtime/meeting-classifier');

const CLASSIFY_CATEGORIES = ['informational', 'action-bearing'];

// Entity types we ask the extractor for. Each maps to a human_tasks task_type.
const ACTION_ENTITY_TYPES = ['action_item', 'decision', 'follow_up', 'commitment'];

const ENTITY_TO_TASK_TYPE = {
  action_item: 'action',
  commitment: 'action',
  follow_up: 'action',
  decision: 'decision_followup',
  request: 'request',
};

const ORIGIN_MEETING = 'meeting';

/**
 * Production dependency defaults. Lazily imported so unit tests can inject
 * fakes without dragging in the LLM/Linear stack (and so PGlite-incompatible
 * paths like signatures/auth never load in tests).
 */
async function buildDefaultDeps() {
  const [{ getFlowAgent }, { runFlowAgent }] = await Promise.all([
    import('../../autobot-inbox/agents/flow-agents/index.js'),
    import('../../autobot-inbox/agents/flow-agents/shared/runner.js'),
  ]);

  const classify = async ({ text, context }) => {
    const def = getFlowAgent('flow:classify_text');
    const { output } = await runFlowAgent({
      definition: def,
      input: { text, categories: CLASSIFY_CATEGORIES, context: context || '' },
    });
    return output; // { category, confidence, rationale }
  };

  const extract = async ({ text, context }) => {
    const def = getFlowAgent('flow:extract_entities');
    const { output } = await runFlowAgent({
      definition: def,
      input: { text, entityTypes: ACTION_ENTITY_TYPES, context: context || '' },
    });
    return output; // { entities: [{ type, value, snippet }] }
  };

  // Best-effort engagement match. matchOrganization is currently a private fn in
  // auto-build.js (not exported) → resolves to null gracefully until it (or an
  // equivalent) is exported; the classifier never blocks on it.
  const matchEngagement = async ({ clientName, domains }) => {
    try {
      const mod = await import('../engagements/auto-build.js');
      if (typeof mod.matchOrganization === 'function') {
        return await mod.matchOrganization(clientName, domains);
      }
    } catch (err) {
      log.warn(`engagement match unavailable: ${err.message}`);
    }
    return null;
  };

  // NOTE (STAQPRO-612 echo-loop guard): there is intentionally NO createTicket
  // dep. The classifier does not create Linear issues inline — when the Linear
  // mirror is enabled it hands cards to the push worker via push_status='pending'
  // (see insertTask), which creates the issue AND stamps linear_issue_id back so
  // the inbound webhook dedups. Inline create-ticket would double-import.
  // mergeMeeting (Plan 041): upsert the :Meeting graph node. Injectable so tests
  // can assert the merge-key contract without a live Neo4j. Best-effort at the
  // call site — a graph failure never blocks classification.
  return { classify, extract, matchEngagement, mergeMeeting };
}

/**
 * Load the transcript text + envelope for a document.
 * @returns {Promise<{text: string, title: string, metadata: object}|null>}
 */
async function loadTranscript(query, documentId) {
  const { rows } = await query(
    `SELECT raw_text, title, metadata FROM content.documents WHERE id = $1 LIMIT 1`,
    [documentId],
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  let metadata = row.metadata || {};
  if (typeof metadata === 'string') {
    try { metadata = JSON.parse(metadata); } catch { metadata = {}; }
  }
  return { text: row.raw_text || '', title: row.title || '', metadata };
}

/** Pull a concise action string from an extracted entity. */
function actionTextOf(entity) {
  if (!entity) return '';
  return String(entity.value || entity.snippet || '').trim();
}

/**
 * Insert a board task. Idempotent via dedup_key's partial-unique index
 * (migration 151): ON CONFLICT DO NOTHING → a duplicate is a no-op.
 *
 * @returns {Promise<{taskId: string|null, created: boolean}>}
 */
async function insertTask(query, {
  title, taskType, sourceMeetingId, dedupKey, engagementId, ownerOrgId, mirrorToLinear = false,
}) {
  // Columns are static identifiers; all values are parameterized (P1/P2).
  const cols = ['title', 'task_type', 'status', 'signal_meeting_id', 'origin', 'dedup_key', 'created_by'];
  const vals = [title, taskType, 'inbox', sourceMeetingId, ORIGIN_MEETING, dedupKey, 'meeting_classifier'];
  if (engagementId) { cols.push('engagement_id'); vals.push(engagementId); }
  if (ownerOrgId) { cols.push('owner_org_id'); vals.push(ownerOrgId); }
  // STAQPRO-612 (echo-loop guard): we NEVER call create-ticket inline. When the
  // Linear mirror is explicitly enabled we hand the card to the existing push
  // worker (lib/runtime/signals/human-task-push-worker.js) by stamping
  // push_status='pending'; the worker creates the Linear issue AND stamps
  // linear_issue_id back on THIS row, so an inbound Linear webhook
  // (routeHumanTaskWebhook) dedups on linear_issue_id instead of re-importing a
  // duplicate. Default OFF — Optimus→Linear creation for the classifier is wired
  // when the mirror substrate is activated (separate ticket).
  if (mirrorToLinear) { cols.push('push_status'); vals.push('pending'); }

  // owner_org_id is stamped (appended to `cols` above) WHEN the caller resolved
  // one from the meeting.received payload's writer principal. When null
  // (agent-runtime, single-org) the column DEFAULT (Staqs) applies —
  // single-org-correct until mig-145 drops it (STAQPRO-593/611 pattern). The
  // SQL-comment annotation below satisfies the M-D insert ratchet.
  const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ');
  const { rows } = await query(
    `INSERT INTO inbox.human_tasks (${cols.join(', ')}) -- tenancy:allow-unstamped (owner_org_id appended to cols when resolved; else DEFAULT Staqs)
     VALUES (${placeholders})
     ON CONFLICT (dedup_key) WHERE dedup_key IS NOT NULL AND deleted_at IS NULL
     DO NOTHING
     RETURNING id`,
    vals,
  );
  return { taskId: rows[0]?.id ?? null, created: rows.length > 0 };
}

/**
 * Supersede (soft-delete) prior open derived cards for a meeting before a
 * re-run creates fresh ones. Open = not already terminal/deleted. Idempotent.
 * @returns {Promise<number>} count superseded.
 */
async function supersedePriorTasks(query, sourceMeetingId) {
  // Only supersede the classifier's OWN prior cards (created_by='meeting_classifier').
  // Cards from other actors (e.g. the ambient signal-detector) are left intact so
  // the dedup_key partial-unique index still catches a same-action overlap rather
  // than the supersede sweep silently clearing them and letting a fresh duplicate in.
  const { rowCount } = await query(
    `UPDATE inbox.human_tasks
        SET deleted_at = now(), updated_at = now()
      WHERE signal_meeting_id = $1
        AND origin = $2
        AND created_by = 'meeting_classifier'
        AND deleted_at IS NULL
        AND status NOT IN ('done', 'skipped', 'not_for_us')`,
    [sourceMeetingId, ORIGIN_MEETING],
  );
  return rowCount || 0;
}

/**
 * Handle one `meeting.received` signal. Wired into FlowEngine.onSignal.
 *
 * @param {Object} signal - agent_graph.signals row. payload carries
 *   { document_id, source_meeting_id, transcript_source, title }.
 * @param {Object} ctx
 * @param {Function} ctx.query - pg-style query fn bound to a connection.
 * @param {Object}  [ctx.deps] - injected { classify, extract, matchEngagement }
 *   for tests; production defaults are lazily built.
 * @param {boolean} [ctx.mirrorToLinear=false] - opt-in Linear mirror. When true,
 *   action/decision cards are stamped push_status='pending' for the push worker
 *   (never created inline). Default OFF — board task is always the primary output.
 * @returns {Promise<Object>} structured outcome.
 */
export async function handleMeetingReceived(signal, ctx = {}) {
  const query = ctx.query;
  if (typeof query !== 'function') {
    throw new Error('handleMeetingReceived: ctx.query is required');
  }
  const deps = ctx.deps || (await buildDefaultDeps());

  const payload = signal?.payload || {};
  const documentId = payload.document_id;
  const sourceMeetingId = payload.source_meeting_id;

  if (!documentId || !sourceMeetingId) {
    log.warn('meeting.received missing document_id or source_meeting_id — skipping');
    return { status: 'skipped', reason: 'missing_provenance', tasks: [] };
  }

  const doc = await loadTranscript(query, documentId);
  if (!doc || !doc.text.trim()) {
    log.warn(`transcript not found / empty for document ${documentId}`);
    return { status: 'skipped', reason: 'no_transcript', tasks: [] };
  }

  const ownerOrgId = payload.owner_org_id || null;
  const contextLine = doc.title || payload.title || '';

  // Plan 041: make the meeting a first-class :Meeting graph node BEFORE the
  // informational/action-bearing branch, so EVERY ingested meeting — not just
  // action-bearing ones — reaches the knowledge graph and agent context
  // (context-loader reads :Meeting nodes). Idempotent on source_meeting_id
  // (re-ingest / edited transcript updates the node, never duplicates).
  // Best-effort: a graph failure must never block classification.
  if (typeof deps.mergeMeeting === 'function') {
    try {
      const meetingResult = await deps.mergeMeeting({
        sourceMeetingId,
        title: contextLine,
        source: payload.transcript_source || null,
        documentId,
        startTime: doc.metadata?.start_time || doc.metadata?.startTime || null,
        participantEmails: collectParticipantEmails(doc.metadata),
        ownerOrgId,
      });
      if (meetingResult) {
        log.info(
          `meeting ${sourceMeetingId} → :Meeting node ` +
          `(${meetingResult.participantsLinked} participant edge(s))`,
        );
      }
    } catch (err) {
      log.warn(`meeting graph-node upsert skipped for ${sourceMeetingId}: ${err.message}`);
    }
  }

  // 2. Classify informational vs action-bearing.
  const classification = await deps.classify({ text: doc.text, context: contextLine });
  const category = String(classification?.category || '').toLowerCase();

  if (category !== 'action-bearing') {
    // 3. Informational → KB-only, zero tickets. The doc is already ingested.
    log.info(`meeting ${sourceMeetingId} classified informational — KB-only, 0 tasks`);
    return {
      status: 'informational',
      category,
      confidence: classification?.confidence ?? null,
      tasks: [],
    };
  }

  // 6. Edited-transcript supersede: clear prior open derived cards first so a
  //    re-run does not leave stale duplicates. Idempotent on first run (0 rows).
  const superseded = await supersedePriorTasks(query, sourceMeetingId);

  // 4. Extract action items.
  const extraction = await deps.extract({ text: doc.text, context: contextLine });
  const entities = Array.isArray(extraction?.entities) ? extraction.entities : [];

  // 7. Best-effort engagement association.
  let engagementId = null;
  try {
    const participantDomains = collectDomains(doc.metadata);
    const clientName = doc.metadata?.organization || doc.metadata?.org || contextLine;
    if (clientName || participantDomains.length) {
      engagementId = await deps.matchEngagement({ clientName, domains: participantDomains });
    }
  } catch (err) {
    log.warn(`engagement association skipped: ${err.message}`);
  }

  // Linear mirror: DEFAULT OFF (echo-loop guard). When enabled we do NOT call
  // create-ticket inline — we stamp push_status='pending' and let the existing
  // push worker create the Linear issue + stamp linear_issue_id back, so the
  // inbound webhook dedups instead of re-importing. See insertTask + the steering
  // note. ctx.mirrorToLinear must be explicitly true to opt in.
  const mirrorToLinear = ctx.mirrorToLinear === true;

  const tasks = [];
  const seen = new Set();

  for (const entity of entities) {
    const text = actionTextOf(entity);
    if (!text) continue;

    const dedupKey = computeDedupKey(sourceMeetingId, text);
    if (!dedupKey || seen.has(dedupKey)) continue; // in-batch dupe guard
    seen.add(dedupKey);

    const taskType = ENTITY_TO_TASK_TYPE[entity.type] || 'action';
    // Only true action/decision items mirror; follow-ups (and anything else)
    // stay board-only. Keyed on the EXTRACTED entity type, not the collapsed
    // task_type (follow_up also maps to task_type 'action').
    const mirrorThis = mirrorToLinear
      && (entity.type === 'action_item' || entity.type === 'commitment' || entity.type === 'decision');

    let inserted;
    try {
      inserted = await insertTask(query, {
        title: text.slice(0, 280),
        taskType,
        sourceMeetingId,
        dedupKey,
        engagementId,
        ownerOrgId,
        mirrorToLinear: mirrorThis,
      });
    } catch (err) {
      log.warn(`task insert failed for "${text.slice(0, 60)}": ${err.message}`);
      continue;
    }

    if (!inserted.created) {
      // dedup_key collided with a live card — idempotent no-op.
      tasks.push({ dedup_key: dedupKey, task_id: inserted.taskId, created: false, type: entity.type });
      continue;
    }
    tasks.push({
      dedup_key: dedupKey, task_id: inserted.taskId, created: true,
      type: entity.type, queued_for_linear: mirrorThis,
    });
  }

  const queuedForLinear = tasks.filter(t => t.queued_for_linear).length;
  log.info(
    `meeting ${sourceMeetingId} action-bearing: ${tasks.filter(t => t.created).length} new tasks, ` +
    `${queuedForLinear} queued for Linear push, ${superseded} superseded`,
  );

  return {
    status: 'action-bearing',
    category,
    confidence: classification?.confidence ?? null,
    engagement_id: engagementId,
    superseded,
    queued_for_linear: queuedForLinear,
    tasks,
  };
}

/**
 * Pull lowercased participant emails out of a doc metadata blob (best-effort).
 * Unlike collectDomains this keeps free-mail addresses (a meeting participant is
 * often on gmail) — the emails are used to link :Person nodes by email (Plan 041).
 */
function collectParticipantEmails(metadata) {
  const emails = new Set();
  const pools = [metadata?.participants, metadata?.invitees, metadata?.attendees].filter(Array.isArray);
  for (const pool of pools) {
    for (const p of pool) {
      const email = typeof p === 'string' ? p : (p?.email || '');
      const norm = String(email).toLowerCase().trim();
      if (norm.includes('@')) emails.add(norm);
    }
  }
  return [...emails];
}

/** Pull lowercased email domains out of a doc metadata blob (best-effort). */
function collectDomains(metadata) {
  const domains = new Set();
  const FREE_MAIL = new Set([
    'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com',
    'yahoo.com', 'icloud.com', 'me.com', 'proton.me',
  ]);
  const pools = [metadata?.participants, metadata?.invitees, metadata?.attendees].filter(Array.isArray);
  for (const pool of pools) {
    for (const p of pool) {
      const email = typeof p === 'string' ? p : (p?.email || '');
      const at = String(email).toLowerCase().split('@')[1];
      if (at && !FREE_MAIL.has(at)) domains.add(at);
    }
  }
  return [...domains];
}

/**
 * Factory for FlowEngine's signalHandlers map. The engine calls the handler
 * with (signal, { depth, query }); we bind the connection + injected deps.
 *
 * @param {Object} opts
 * @param {Function} opts.query
 * @param {Object}  [opts.deps]
 * @param {boolean} [opts.mirrorToLinear=false] - opt-in Linear mirror (default OFF).
 */
export function makeMeetingClassifierHandler({ query, deps, mirrorToLinear = false } = {}) {
  return (signal, engineCtx = {}) =>
    handleMeetingReceived(signal, {
      query: query || engineCtx.query,
      deps,
      mirrorToLinear,
    });
}

export const MEETING_RECEIVED_SIGNAL = 'meeting.received';
