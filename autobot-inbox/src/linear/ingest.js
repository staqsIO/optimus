/**
 * Linear webhook → executor-coder pipeline.
 *
 * Triggers when a Linear issue is assigned to Jamie Bot OR labeled "auto-fix":
 * 1. Fetches the full issue (webhook payloads are sparse)
 * 2. Creates an action_proposal with the structured ticket body
 * 3. Creates a work_item assigned directly to executor-coder (skip triage)
 * 4. Updates the Linear issue to "In Development"
 *
 * P1: deny by default — only processes issues matching configured triggers.
 * P4: boring infrastructure — raw SQL, no ORM.
 */

import { getIssue, updateIssueStateByName, addBotComment } from './client.js';
import { getConfig } from '../../../lib/config/loader.js';
import { query } from '../db.js';
import { createIntent } from '../runtime/intent-manager.js';
import { ingestAsSignal } from '../webhooks/signal-ingester.js';
import { classifyIssue } from './issue-classifier.js';
import { mapLinearEventToPatch } from '../../../lib/linear/pull-mapping.js';
import { detectReadyForOptimus } from '../../../lib/linear/ready-for-optimus.js';
import { getStickyFields } from '../../../lib/runtime/human-task-sticky.js';
import { importLinearIssue, resolveEnabledTeam } from '../../../lib/linear/import-issue.js';

const config = getConfig('linear-bot');

// Dedup: prevent duplicate webhook processing for the same issue within a short window.
// Linear sometimes delivers the same event multiple times (retries, label batch ops).
const DEDUP_TTL_MS = 30_000; // 30 seconds
const recentWebhooks = new Map(); // key: `${issueId}:${action}` → timestamp

/** Clear the in-memory dedup cache. Exported for test isolation. */
export function clearDedupCache() {
  recentWebhooks.clear();
}

/**
 * Extract the Linear issue id from a webhook payload, handling both Issue
 * and Comment event shapes (PRD meeting-actions-to-kanban-v0.2-tech-spec.md
 * FR-12, FR-13, AD-9).
 *
 * @param {Object|null|undefined} payload
 * @returns {string|null}
 */
function extractIssueIdFromPayload(payload) {
  if (!payload || !payload.data) return null;
  const data = payload.data;
  if (payload.type === 'Comment') {
    return data.issueId || data.issue?.id || null;
  }
  // Default to Issue-event shape (also covers payloads with no type set).
  return data.id || data.issueId || null;
}

/**
 * Route a Linear webhook to the human-task pull handler if the referenced
 * issue id matches an existing `inbox.human_tasks` row (Optimus-owned task).
 *
 * Contract (PRD meeting-actions-to-kanban-v0.2-tech-spec.md FR-12, FR-13, AD-9):
 *   - Returns `{ matched: true, taskId }` when a non-soft-deleted row exists,
 *     and stamps `linear_last_event_at = now()` on that row.
 *   - Returns `{ matched: false }` otherwise (no row writes).
 *   - Never throws — null/undefined payloads, missing issue ids, and DB
 *     errors all degrade to `{ matched: false }` so the caller can fall
 *     through to the engineering-ticket path.
 *
 * @param {Object|null|undefined} payload  Raw Linear webhook body
 * @param {{ query: Function }} [deps]     Injected db query (defaults to ../db.js)
 * @returns {Promise<{ matched: boolean, taskId?: string }>}
 */
export async function routeHumanTaskWebhook(payload, deps = {}) {
  const q = deps.query || query;

  const issueId = extractIssueIdFromPayload(payload);
  if (!issueId) return { matched: false };

  let row;
  try {
    const result = await q(
      `SELECT id FROM inbox.human_tasks
       WHERE linear_issue_id = $1 AND deleted_at IS NULL
       LIMIT 1`,
      [issueId]
    );
    row = result.rows[0];
  } catch (err) {
    console.error(`[linear-ingest] routeHumanTaskWebhook lookup failed for ${issueId}: ${err.message}`);
    return { matched: false };
  }

  if (!row) return { matched: false };

  try {
    await q(
      `UPDATE inbox.human_tasks
       SET linear_last_event_at = now()
       WHERE id = $1`,
      [row.id]
    );
  } catch (err) {
    console.error(`[linear-ingest] routeHumanTaskWebhook stamp failed for ${row.id}: ${err.message}`);
    // Match still counts — caller must NOT fall through to engineering path.
  }

  return { matched: true, taskId: row.id };
}

/**
 * Extract the Linear team id from a webhook payload. Issue events carry
 * `data.teamId`; some shapes nest it under `data.team.id`.
 *
 * @param {Object|null|undefined} payload
 * @returns {string|null}
 */
function extractTeamIdFromPayload(payload) {
  const data = payload?.data;
  if (!data || typeof data !== 'object') return null;
  return data.teamId || data.team?.id || null;
}

/**
 * STAQPRO-619-A: import a Linear-NATIVE issue (no existing human_tasks row)
 * onto the /issues kanban when its team is board-enabled.
 *
 * Pipeline (deny-by-default, best-effort, never throws):
 *   1. Comment events never import (only Issue events create cards).
 *   2. Resolve the enabled team from the SPARSE payload teamId first — a cheap
 *      deny that avoids a Linear API round-trip for unwatched teams.
 *   3. Fetch the FULL issue (webhook payloads are sparse — no state.type/name,
 *      assignee, dueDate). Skip if the fetch fails or returns nothing.
 *   4. Re-resolve the enabled team from the FULL issue's team.id (authoritative)
 *      so a payload that omitted/forged teamId can't slip past the gate.
 *   5. importLinearIssue stamps owner_org_id from the team→org map (NEVER the
 *      payload) and upserts idempotently.
 *
 * @param {Object} payload  Raw Linear webhook body
 * @param {{ query: Function, deps?: object }} ctx  injected db query (+ test deps)
 * @returns {Promise<{ imported: boolean, taskId?: string, action?: string, reason?: string }>}
 */
export async function tryImportLinearNativeIssue(payload, { query: q = query, deps = {} } = {}) {
  const _getIssue = deps.getIssue || getIssue;
  const _resolveEnabledTeam = deps.resolveEnabledTeam || resolveEnabledTeam;
  const _importLinearIssue = deps.importLinearIssue || importLinearIssue;

  try {
    // 1. Only Issue events create cards. Comments/other types never import.
    if (payload?.type === 'Comment') return { imported: false, reason: 'comment event' };
    const issueId = extractIssueIdFromPayload(payload);
    if (!issueId) return { imported: false, reason: 'no issue id' };

    // 2. Cheap deny from the sparse payload teamId (avoids an API call).
    const sparseTeamId = extractTeamIdFromPayload(payload);
    if (sparseTeamId) {
      const sparseTeam = await _resolveEnabledTeam(q, sparseTeamId);
      if (!sparseTeam) return { imported: false, reason: 'team not enabled (sparse)' };
    }

    // 3. Fetch the full issue (sparse payloads lack state.type/assignee/dueDate).
    let issue;
    try {
      issue = await _getIssue(issueId);
    } catch (err) {
      console.warn(`[linear-import] getIssue failed for ${issueId}: ${err.message}`);
      return { imported: false, reason: 'fetch failed' };
    }
    if (!issue) return { imported: false, reason: 'issue not found' };

    // 3b. Don't import already-terminal issues that have no local row — there is
    // nothing to mirror onto an active board. (Backfill handles open issues; the
    // pull path handles existing rows transitioning to terminal.)
    const stateType = issue.state?.type;
    if (stateType === 'completed' || stateType === 'canceled') {
      return { imported: false, reason: `terminal state (${stateType})` };
    }

    // 4. Authoritative team gate from the FULL issue (payload teamId could lie).
    const authoritativeTeamId = issue.team?.id || sparseTeamId;
    const team = await _resolveEnabledTeam(q, authoritativeTeamId);
    if (!team) return { imported: false, reason: 'team not enabled' };

    // 5. Import — owner_org_id stamped from the team→org map, never the payload.
    return await _importLinearIssue(issue, { query: q, teamOrg: team });
  } catch (err) {
    console.error(`[linear-import] tryImportLinearNativeIssue failed: ${err.message}`);
    return { imported: false, reason: err.message };
  }
}

/**
 * Mirror a Linear webhook event into the matched `inbox.human_tasks` row
 * (pull side of the two-way sync).
 *
 * PRD: docs/internal/prds/meeting-actions-to-kanban-v0.2-tech-spec.md
 *      FR-13, FR-17, FR-18, FR-19, NFR-4; AD-5 sticky overrides.
 *
 * Pipeline:
 *   1. SELECT the current push guardrail (mapping). Missing → warn + return.
 *   2. mapLinearEventToPatch(payload, mapping).
 *   3. If patch is empty (e.g. comment-only event) → return; no UPDATE.
 *   4. Read row's current `feedback_history`, compute sticky fields (AD-5),
 *      drop sticky-overlapping keys from patch (status is never blocked).
 *   5. Single parameterised UPDATE that also appends a `linear_pull` entry
 *      to `feedback_history` via `COALESCE(..., '[]'::jsonb) || jsonb_build_array(...)`.
 *   6. terminal=true → pg_notify('human_task_completed', taskId).
 *   7. UPDATE errors are caught + logged; never thrown uphill.
 *
 * @param {Object} payload                       Raw Linear webhook body
 * @param {{ query: Function, taskId: string }} deps
 * @returns {Promise<void>}
 */
export async function handleHumanTaskWebhook(payload, deps = {}) {
  const q = deps.query;
  const taskId = deps.taskId;
  if (!q || !taskId) return;

  // Wall-clock start (NFR-13 sync_log duration_ms).
  const startMs = Date.now();

  // 1. Current push guardrail.
  let guardrail;
  try {
    const gr = await q(
      `SELECT id, mapping FROM inbox.llm_guardrails
       WHERE kind = 'push' AND is_current = true
       LIMIT 1`
    );
    guardrail = gr.rows[0];
  } catch (err) {
    console.error(`[linear-ingest] handleHumanTaskWebhook guardrail lookup failed: ${err.message}`);
    return;
  }
  if (!guardrail) {
    console.warn('[linear-ingest] handleHumanTaskWebhook: no current push guardrail — skipping pull mirror');
    return;
  }

  // 2. Map payload → patch.
  const mapping = guardrail.mapping && typeof guardrail.mapping === 'object'
    ? guardrail.mapping
    : (typeof guardrail.mapping === 'string' ? safeJsonParse(guardrail.mapping, {}) : {});
  const { patch, terminal } = mapLinearEventToPatch({
    payload,
    mappingFromGuardrail: mapping,
  });

  // 3. Empty patch → no UPDATE (comment events, defensive payloads), but still
  //    run the ready-for-Optimus detector so @optimus comments fire even when
  //    they don't mutate any mirrored field.
  if (!patch || Object.keys(patch).length === 0) {
    await emitReadyForOptimus({ q, taskId, payload, mapping });
    return;
  }

  // 4. Sticky-field filter (AD-5). Status is never blocked.
  let history = [];
  try {
    const r = await q(
      `SELECT feedback_history FROM inbox.human_tasks WHERE id = $1`,
      [taskId]
    );
    history = parseFeedbackHistory(r.rows[0]?.feedback_history);
  } catch (err) {
    console.error(`[linear-ingest] handleHumanTaskWebhook history read failed: ${err.message}`);
    return;
  }

  const sticky = getStickyFields(history);
  const filteredPatch = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key !== 'status' && sticky.has(key)) continue;
    filteredPatch[key] = value;
  }

  if (Object.keys(filteredPatch).length === 0) {
    // All fields filtered out — still run the ready signal (state path may match).
    await emitReadyForOptimus({ q, taskId, payload, mapping });
    return;
  }

  // 5. Build a single parameterised UPDATE that also appends to feedback_history.
  const eventType = `${payload?.type || 'Issue'}.${payload?.action || 'update'}`;
  const appliedFields = Object.keys(filteredPatch);
  const entry = {
    verb: 'linear_pull',
    event_type: eventType,
    fields_changed: appliedFields,
    guardrail_id: guardrail.id,
    at: new Date().toISOString(),
  };

  const setClauses = [];
  const params = [];
  let i = 1;
  for (const [col, val] of Object.entries(filteredPatch)) {
    setClauses.push(`${col} = $${i++}`);
    params.push(val);
  }
  // Append feedback_history entry.
  setClauses.push(
    `feedback_history = COALESCE(feedback_history, '[]'::jsonb) || jsonb_build_array($${i++}::jsonb)`
  );
  params.push(JSON.stringify(entry));
  // WHERE id = $N
  params.push(taskId);
  const sql = `UPDATE inbox.human_tasks SET ${setClauses.join(', ')} WHERE id = $${i}`;

  try {
    await q(sql, params);
  } catch (err) {
    console.error(`[linear-ingest] handleHumanTaskWebhook UPDATE failed for ${taskId}: ${err.message}`);
    // NFR-13: record failed pull in sync_log. Wrapped — sync_log failure
    // must not affect the main pull flow.
    try {
      await q(
        `INSERT INTO inbox.human_task_sync_log
           (task_id, direction, outcome, guardrail_id, error_text, duration_ms)
         VALUES ($1, 'pull', 'failed', $2, $3, $4)`,
        [taskId, guardrail.id, err.message || 'unknown error', Date.now() - startMs],
      );
    } catch (logErr) {
      console.error(`[linear-ingest] handleHumanTaskWebhook sync_log (failed) insert failed for ${taskId}: ${logErr.message}`);
    }
    return; // P3 transparency: never throw uphill.
  }

  // NFR-13: record successful pull in sync_log AFTER human_tasks UPDATE.
  try {
    // Build after_snapshot from the applied patch via jsonb_build_object so
    // values are never interpolated. Keys are validated against an allow-list
    // of known mirrored columns; any unknown key is dropped defensively.
    const ALLOWED_SNAPSHOT_KEYS = new Set([
      'linear_state_id', 'linear_state_name', 'status',
      'linear_assignee_id', 'linear_project_id',
      'title', 'description',
    ]);
    const buildArgs = [];
    const snapParams = [];
    let s = 1;
    for (const [k, v] of Object.entries(filteredPatch)) {
      if (!ALLOWED_SNAPSHOT_KEYS.has(k)) continue;
      // ::text cast lets the driver infer the parameter type even when v is null.
      buildArgs.push(`'${k}', $${s++}::text`);
      snapParams.push(v);
    }
    const snapExpr = buildArgs.length > 0
      ? `jsonb_build_object(${buildArgs.join(', ')})`
      : `'{}'::jsonb`;
    // Trailing params: task_id, guardrail_id, duration_ms
    snapParams.push(taskId, guardrail.id, Date.now() - startMs);
    const taskParam = `$${s++}`;
    const grParam = `$${s++}`;
    const durParam = `$${s++}`;
    await q(
      `INSERT INTO inbox.human_task_sync_log
         (task_id, direction, outcome, guardrail_id, after_snapshot, duration_ms)
       VALUES (${taskParam}, 'pull', 'success', ${grParam}, ${snapExpr}, ${durParam})`,
      snapParams,
    );
  } catch (logErr) {
    console.error(`[linear-ingest] handleHumanTaskWebhook sync_log (success) insert failed for ${taskId}: ${logErr.message}`);
  }

  // 6. Terminal notify.
  if (terminal) {
    try {
      await q(`SELECT pg_notify('human_task_completed', $1)`, [taskId]);
    } catch (err) {
      console.error(`[linear-ingest] handleHumanTaskWebhook pg_notify failed for ${taskId}: ${err.message}`);
    }
  }

  // 7. Ready-for-Optimus signal (FR-15) — runs after the pull patch so the
  //    pg_notify carries a task_id whose mirrored state is already up to date.
  await emitReadyForOptimus({ q, taskId, payload, mapping });
}

/**
 * Emit the `human_task_ready_for_optimus` signal when the detector fires.
 *
 * Appends a `ready_for_optimus` feedback_history entry and pg_notifies
 * `human_task_ready_for_optimus` with `{task_id, comment_text, actor, source}`.
 * Both side-effects are wrapped so a failure in either is logged but never
 * thrown uphill (P3 transparency).
 *
 * @param {{ q: Function, taskId: string, payload: object, mapping: object }} args
 */
async function emitReadyForOptimus({ q, taskId, payload, mapping }) {
  let result;
  try {
    result = detectReadyForOptimus({ payload, mapping });
  } catch (err) {
    console.error(`[linear-ingest] detectReadyForOptimus threw for ${taskId}: ${err.message}`);
    return;
  }
  if (!result || !result.ready) return;

  const entry = {
    verb: 'ready_for_optimus',
    source: result.source,
    actor: result.actor || 'unknown',
    at: new Date().toISOString(),
  };

  try {
    await q(
      `UPDATE inbox.human_tasks
       SET feedback_history = COALESCE(feedback_history, '[]'::jsonb) || jsonb_build_array($1::jsonb)
       WHERE id = $2`,
      [JSON.stringify(entry), taskId]
    );
  } catch (err) {
    console.error(`[linear-ingest] ready_for_optimus history append failed for ${taskId}: ${err.message}`);
  }

  const notifyPayload = {
    task_id: taskId,
    comment_text: result.comment_text,
    actor: result.actor || 'unknown',
    source: result.source,
  };
  try {
    await q(`SELECT pg_notify('human_task_ready_for_optimus', $1)`, [JSON.stringify(notifyPayload)]);
  } catch (err) {
    console.error(`[linear-ingest] ready_for_optimus pg_notify failed for ${taskId}: ${err.message}`);
  }
}

function parseFeedbackHistory(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw == null) return [];
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function safeJsonParse(text, fallback) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function isDuplicateWebhook(issueId, action) {
  const key = `${issueId}:${action}`;
  const now = Date.now();
  const lastSeen = recentWebhooks.get(key);

  // Prune stale entries periodically (every 100 checks)
  if (recentWebhooks.size > 100) {
    for (const [k, ts] of recentWebhooks) {
      if (now - ts > DEDUP_TTL_MS) recentWebhooks.delete(k);
    }
  }

  if (lastSeen && now - lastSeen < DEDUP_TTL_MS) {
    return true;
  }

  recentWebhooks.set(key, now);
  return false;
}

/**
 * Handle a Linear webhook payload. Called from api.js after auth verification.
 * Triggers on: issue assigned to Jamie Bot, OR issue with auto-fix label.
 *
 * @param {Object} payload - Raw Linear webhook body
 * @param {Function} createWorkItem - state-machine.js createWorkItem
 * @returns {Object} Result with issueId, workItemId, proposalId or skipped reason
 */
export async function handleLinearWebhook(payload, createWorkItem) {
  // PRD meeting-actions-to-kanban-v0.2 FR-12, FR-13, AD-9:
  // If the issue id is on a human_tasks row, dispatch to the human-task pull
  // handler and SKIP the engineering-ticket path entirely. This must run
  // before fetch/dedup so Optimus-owned issues never trigger executor-coder.
  const routed = await routeHumanTaskWebhook(payload, { query });
  if (routed.matched) {
    await handleHumanTaskWebhook(payload, { query, taskId: routed.taskId });
    return { routed: 'human_task', taskId: routed.taskId };
  }

  // STAQPRO-619-A: no existing human_tasks row → this is (potentially) a
  // Linear-NATIVE issue. If its team is board-enabled in inbox.linear_sync_teams,
  // mirror it onto the /issues kanban via importLinearIssue. This runs BEFORE the
  // engineering-ticket trigger pre-filters because the import scope is ALL OPEN
  // issues (full mirror), not just bot-assigned/labeled ones. Best-effort: any
  // failure logs and falls through to the legacy path (P3 — never throws uphill).
  const imported = await tryImportLinearNativeIssue(payload, { query });
  if (imported?.imported) {
    return { routed: 'linear_import', taskId: imported.taskId, action: imported.action };
  }

  const { action, data, updatedFrom } = payload;

  // Only process issue creates and updates (not removes)
  if (!data?.id || (action !== 'create' && action !== 'update')) {
    return { skipped: true, reason: `Unsupported action: ${action}` };
  }

  // Dedup: reject duplicate webhooks for the same issue within 30s window
  if (isDuplicateWebhook(data.id, action)) {
    console.log(`[linear-ingest] Dedup: skipping duplicate ${action} for ${data.id}`);
    return { skipped: true, reason: 'Duplicate webhook (within 30s dedup window)' };
  }

  // Pre-filter: skip payloads with no trigger signals to avoid unnecessary API calls (P4)
  // For creates: check if assignee/delegate/labels are present
  // For updates: check if the CHANGE was to assignee/delegate/labels (not just state changes
  // on issues that happen to have a delegate set — those cause re-trigger loops)
  if (action === 'update' && updatedFrom) {
    const triggerFieldChanged = updatedFrom.assigneeId !== undefined
      || updatedFrom.delegateId !== undefined
      || updatedFrom.labelIds !== undefined;
    if (!triggerFieldChanged) {
      return { skipped: true, reason: 'Update did not change assignee/delegate/labels' };
    }
  } else if (action !== 'create') {
    if (!data.assigneeId && !data.delegateId && (!data.labelIds || data.labelIds.length === 0)) {
      return { skipped: true, reason: 'No assignee/delegate or labels in payload' };
    }
  }

  // Fetch full issue details (webhook payload is sparse — no description, no assignee name)
  let issue;
  try {
    issue = await getIssue(data.id);
  } catch (err) {
    console.error(`[linear-ingest] Failed to fetch issue ${data.id}: ${err.message}`);
    return { skipped: true, reason: `Failed to fetch issue: ${err.message}` };
  }

  if (!issue) {
    return { skipped: true, reason: `Issue ${data.id} not found via API` };
  }

  // Skip issues already in terminal states — prevents re-processing completed/canceled work
  const stateType = issue.state?.type;
  if (stateType === 'completed' || stateType === 'canceled') {
    console.log(`[linear-ingest] Skipping ${issue.identifier}: already in terminal state '${issue.state.name}'`);
    return { skipped: true, reason: `Issue ${issue.identifier} is already ${issue.state.name}` };
  }

  // P1: deny by default — check triggers on the fetched issue (not webhook payload)
  const labels = issue.labels?.nodes || [];
  const hasAutoFixLabel = labels.some(l => l.name === config.triggerLabel);
  const isAssignedToBot = config.triggerAssigneeNames?.includes(issue.assignee?.name);
  const isDelegatedToBot = config.triggerAssigneeNames?.includes(issue.delegate?.name);
  const hasWorkshopLabel = labels.some(l => l.name === config.workshopLabel);

  // --- TIER 1a: Workshop label → claw-workshop agent (checked FIRST) ---
  if (hasWorkshopLabel) {
    console.log(`[linear-ingest] Tier 1 triggered by: workshop label`);
    return handleWorkshopTrigger(issue, createWorkItem);
  }

  // --- TIER 1b: Direct work_item (board pre-authorized) ---
  // Auto-fix label or Jamie Bot assignment → existing executor-coder flow
  // BUT skip if playbook:* labels are present — those are workshop-only signals
  const hasPlaybookLabel = labels.some(l => l.name.startsWith(config.playbookLabelPrefix || 'playbook:'));
  if (hasPlaybookLabel) {
    console.log(`[linear-ingest] Skipping executor-coder: playbook label present without workshop label — likely mid-label-toggle`);
    return { skipped: true, reason: 'Playbook label without workshop label — awaiting workshop trigger' };
  }
  if (hasAutoFixLabel || isAssignedToBot || isDelegatedToBot) {
    const triggerReason = isDelegatedToBot ? `delegated to ${issue.delegate.name}` : isAssignedToBot ? `assigned to ${issue.assignee.name}` : 'auto-fix label';
    console.log(`[linear-ingest] Tier 1 triggered by: ${triggerReason}`);
    // Fall through to existing work_item creation below
  } else {
    // --- Not a direct trigger — check if issue is in watched scope ---
    const inWatchedScope = isInWatchedScope(issue);
    if (!inWatchedScope) {
      return { skipped: true, reason: `Not triggered and outside watched scope: team=${issue.team?.name || 'none'}, project=${issue.project?.name || 'none'}` };
    }

    // --- TIER 2: Intent (urgent/high priority in watched scope → board review) ---
    const intentPriorities = config.intentPriorities || [1, 2];
    if (intentPriorities.includes(issue.priority)) {
      return handleLinearIntent(issue);
    }

    // Check for intent-triggering labels
    const matchedIntentLabel = labels.find(l => config.intentLabels?.[l.name]);
    if (matchedIntentLabel) {
      return handleLinearIntentLabel(issue, matchedIntentLabel.name);
    }

    // --- TIER 3: Signal-only (normal/low/none priority in watched scope → briefing) ---
    return handleLinearSignal(issue);
  }

  // Deduplicate: check if we already have a work item for this issue
  // Checks both active AND recently completed items to prevent re-trigger loops
  // (e.g., workshop completes → state change webhook → new work_item → workshop runs again)
  const existing = await query(
    `SELECT id, status FROM agent_graph.work_items
     WHERE metadata->>'linear_issue_id' = $1
       AND (status NOT IN ('completed', 'cancelled', 'failed')
            OR (status = 'completed' AND updated_at > NOW() - INTERVAL '1 hour'))
     LIMIT 1`,
    [data.id]
  );
  if (existing.rows.length > 0) {
    const status = existing.rows[0].status;
    const reason = status === 'completed'
      ? 'Work item recently completed (cooldown — prevents re-trigger loop)'
      : 'Work item already exists';
    console.log(`[linear-ingest] Skipping: ${reason} (${existing.rows[0].id}, status=${status}) for ${data.id}`);
    return { skipped: true, reason, existingWorkItemId: existing.rows[0].id };
  }

  console.log(`[linear-ingest] Processing ${issue.identifier}: ${issue.title}`);

  // Determine target repo from labels, project, or team
  let targetRepo = resolveTargetRepo(issue);

  // If no repo from labels, try LLM classifier
  if (!targetRepo && config.repoDescriptions) {
    try {
      console.log(`[linear-ingest] Classifying repo for executor-coder: ${issue.identifier}`);
      const classification = await classifyIssue(issue, config.repoDescriptions);
      if (classification.target_repo && classification.target_repo !== 'new-repo' && classification.confidence >= 0.8) {
        targetRepo = classification.target_repo;
        console.log(`[linear-ingest] Classifier assigned repo: ${targetRepo} (confidence: ${classification.confidence})`);
      }
    } catch (err) {
      console.warn(`[linear-ingest] Classification failed for executor-coder: ${err.message}`);
    }
  }

  // Fail-fast: no repo resolved — ask user to add a repo label
  if (!targetRepo) {
    console.log(`[linear-ingest] No repo resolved for ${issue.identifier} — requesting label`);
    try {
      const repoOptions = Object.keys(config.repoMapping).map(k => `\`${k}\``).join(', ');
      await addBotComment(issue.id,
        `Could not determine target repository.\n\n` +
        `Please add one of: ${repoOptions}\n\n` +
        `I'll auto-retry when the label is added.`
      );
    } catch (err) {
      console.warn(`[linear-ingest] Failed to post repo-request comment: ${err.message}`);
    }
    return { skipped: true, reason: `No target repo for ${issue.identifier}` };
  }

  // Build structured ticket body (same shape executor-ticket produces)
  const { body: ticketBody, priority: issuePriority } = buildTicketBody(issue);

  // Create action_proposal (ticket_create — same type executor-ticket uses)
  const proposalResult = await query(
    `INSERT INTO agent_graph.action_proposals
     (action_type, body, linear_issue_id, linear_issue_url, target_repo)
     VALUES ('ticket_create', $1, $2, $3, $4)
     RETURNING id`,
    [ticketBody, issue.id, issue.url, targetRepo]
  );
  const proposalId = proposalResult.rows[0].id;

  // Create work item → assigned directly to executor-coder (skip triage)
  const workItem = await createWorkItem({
    type: 'task',
    title: `Auto-fix: ${issue.identifier} — ${issue.title}`,
    description: issue.description?.slice(0, 500) || '',
    createdBy: 'orchestrator',
    assignedTo: 'executor-coder',
    priority: mapLinearPriority(issuePriority),
    metadata: {
      ticket_proposal_id: proposalId,
      target_repo: targetRepo,
      linear_issue_id: issue.id,
      linear_issue_url: issue.url,
      linear_identifier: issue.identifier,
      linear_priority: issuePriority,
      source: 'linear-webhook',
    },
  });

  console.log(`[linear-ingest] Created work item ${workItem?.id} for ${issue.identifier} → ${targetRepo}`);

  // Update Linear issue to "In Development" (best-effort)
  try {
    await updateIssueStateByName(issue.id, 'In Development');
    console.log(`[linear-ingest] Updated ${issue.identifier} to "In Development"`);
  } catch (err) {
    console.warn(`[linear-ingest] Failed to update issue state: ${err.message}`);
  }

  return { issueId: issue.id, workItemId: workItem?.id, proposalId };
}

/**
 * Determine the target GitHub repo from issue labels, project, and team.
 * Priority: repo: label > project mapping > team mapping > null (fail-fast)
 */
function resolveTargetRepo(issue) {
  const labels = issue.labels?.nodes || [];

  // Tier 1: explicit repo label (e.g. "repo:formul8" or just "formul8")
  for (const label of labels) {
    const mapped = config.repoMapping[label.name]
      || config.repoMapping[`repo:${label.name}`];
    if (mapped) return mapped;

    // Tier 1b: fuzzy match — if label is "repo:X", try matching X against known repo names
    // e.g. "repo:autocsr" matches "staqsIO/AutoCSR" without needing an explicit mapping entry
    if (label.name.startsWith('repo:')) {
      const repoHint = label.name.slice(5).toLowerCase();
      const allRepos = Object.values(config.repoMapping)
        .concat(Object.values(config.projectMapping || {}))
        .concat(Object.values(config.teamMapping || {}));
      const fuzzyMatch = [...new Set(allRepos)].find(r =>
        r.toLowerCase().endsWith(`/${repoHint}`) || r.toLowerCase().includes(repoHint)
      );
      if (fuzzyMatch) {
        console.log(`[linear-ingest] Fuzzy repo match: ${label.name} → ${fuzzyMatch}`);
        return fuzzyMatch;
      }
    }
  }

  // Tier 2: project name mapping
  if (issue.project?.name) {
    const mapped = config.projectMapping[issue.project.name];
    if (mapped) return mapped;
  }

  // Tier 3: team name mapping
  if (issue.team?.name) {
    const mapped = config.teamMapping?.[issue.team.name];
    if (mapped) return mapped;
  }

  return config.defaultTargetRepo || null;
}

/**
 * Map Linear priority (0=none, 1=urgent, 2=high, 3=medium, 4=low) to work_item priority.
 * Work items use 0=normal, higher=more urgent.
 */
function mapLinearPriority(linearPriority) {
  switch (linearPriority) {
    case 1: return 3; // urgent
    case 2: return 2; // high
    case 3: return 1; // medium
    case 4: return 0; // low
    default: return 0; // none
  }
}

/**
 * Check if an issue is in the watched scope (P1: deny by default for everything outside).
 */
function isInWatchedScope(issue) {
  const watchedTeams = config.watchedTeams || [];
  const watchedProjects = config.watchedProjects || [];

  const teamMatch = issue.team?.name && watchedTeams.includes(issue.team.name);
  const projectMatch = issue.project?.name && watchedProjects.includes(issue.project.name);

  return teamMatch || projectMatch;
}

/**
 * Tier 2: Create intent for urgent/high priority Linear issues.
 * Zero LLM cost — DB insert only.
 */
async function handleLinearIntent(issue) {
  const priorityName = ['None', 'Urgent', 'High', 'Medium', 'Low'][issue.priority] || 'None';
  const tier = issue.priority === 1 ? 'strategic' : 'tactical';

  const intent = await createIntent({
    agentId: 'orchestrator',
    intentType: 'task',
    decisionTier: tier,
    title: `Linear ${issue.identifier}: ${issue.title} [${priorityName}]`,
    reasoning: `${priorityName}-priority issue in ${issue.team?.name || 'unknown team'}. ${issue.description?.slice(0, 300) || 'No description.'}`,
    proposedAction: {
      type: 'create_work_item',
      payload: {
        type: 'task',
        title: `Linear ${issue.identifier}: ${issue.title}`,
        description: issue.description?.slice(0, 500) || '',
        assigned_to: 'executor-coder',
        priority: mapLinearPriority(issue.priority),
        metadata: {
          linear_issue_id: issue.id,
          linear_issue_url: issue.url,
          linear_identifier: issue.identifier,
          source: 'linear-webhook-intent',
        },
      },
    },
    triggerContext: {
      pattern: `linear_issue_${issue.id}`,
      source: 'linear-webhook',
      linear_issue_id: issue.id,
      linear_identifier: issue.identifier,
      priority: issue.priority,
    },
    budgetPerFire: tier === 'strategic' ? 0.50 : 0.25,
  });

  if (!intent) {
    console.log(`[linear-ingest] Tier 2 dedup: intent already exists for ${issue.identifier}`);
    return { skipped: true, reason: `Intent already exists for ${issue.identifier}` };
  }

  console.log(`[linear-ingest] Tier 2: created intent ${intent.id.slice(0, 8)}... for ${issue.identifier} [${priorityName}]`);
  return { issueId: issue.id, intentId: intent.id, tier: 2 };
}

/**
 * Tier 2: Create intent for Linear issues with special labels (e.g. board-review).
 */
async function handleLinearIntentLabel(issue, labelName) {
  const routing = config.intentLabels[labelName];
  const agent = routing.agent || 'executor-coder';
  const tier = routing.tier || 'tactical';

  const intent = await createIntent({
    agentId: agent,
    intentType: 'task',
    decisionTier: tier,
    title: `Linear ${issue.identifier}: ${issue.title} [${labelName}]`,
    reasoning: `Issue labeled "${labelName}" in ${issue.team?.name || 'unknown team'}. ${issue.description?.slice(0, 300) || 'No description.'}`,
    proposedAction: {
      type: 'create_work_item',
      payload: {
        type: 'task',
        title: `Linear ${issue.identifier}: ${issue.title}`,
        description: issue.description?.slice(0, 500) || '',
        assigned_to: agent,
        priority: mapLinearPriority(issue.priority),
        metadata: {
          linear_issue_id: issue.id,
          linear_issue_url: issue.url,
          linear_identifier: issue.identifier,
          linear_label: labelName,
          source: 'linear-webhook-intent',
        },
      },
    },
    triggerContext: {
      pattern: `linear_issue_${issue.id}`,
      source: 'linear-webhook',
      linear_issue_id: issue.id,
      linear_identifier: issue.identifier,
      linear_label: labelName,
    },
    budgetPerFire: tier === 'strategic' ? 0.50 : 0.25,
  });

  if (!intent) {
    return { skipped: true, reason: `Intent already exists for ${issue.identifier}` };
  }

  console.log(`[linear-ingest] Tier 2: created intent for ${issue.identifier} [label=${labelName}]`);
  return { issueId: issue.id, intentId: intent.id, label: labelName, tier: 2 };
}

/**
 * Tier 3: Signal-only for normal/low priority Linear issues.
 * Zero LLM cost — DB insert only, surfaces in briefing.
 */
async function handleLinearSignal(issue) {
  const priorityName = ['None', 'Urgent', 'High', 'Medium', 'Low'][issue.priority] || 'None';
  const labelNames = (issue.labels?.nodes || []).map(l => l.name);

  const result = await ingestAsSignal({
    source: 'linear',
    title: `${issue.identifier}: ${issue.title}`,
    snippet: issue.description?.slice(0, 2000) || `[${priorityName} priority Linear issue]`,
    from: issue.assignee?.name || issue.creator?.name || 'Linear',
    signals: [{
      signal_type: 'request',
      content: `${issue.identifier}: ${issue.title} [${priorityName}] — ${issue.team?.name || 'unknown team'}`,
      confidence: 0.8,
      direction: 'inbound',
      // STAQPRO-321: don't put Linear team name in signal.domain — the column
      // has a CHECK allowlist ('general'|'financial'|'legal'|'scheduling') and
      // team names don't match it, which was silently dropping every Linear
      // signal. Team is captured in metadata.linear_team below.
      domain: null,
    }],
    metadata: {
      linear_issue_id: issue.id,
      linear_issue_url: issue.url,
      linear_identifier: issue.identifier,
      linear_priority: issue.priority,
      linear_team: issue.team?.name,
      linear_project: issue.project?.name,
      linear_assignee: issue.assignee?.name,
      linear_labels: labelNames,
    },
    labels: [`priority:${priorityName.toLowerCase()}`, ...labelNames.map(l => `linear:${l}`)],
    providerMsgId: `linear_${issue.id}`,
  });

  if (!result) {
    return { skipped: true, reason: `Signal already exists for ${issue.identifier}` };
  }

  console.log(`[linear-ingest] Tier 3: signal created for ${issue.identifier} (msgId=${result.messageId})`);
  return { issueId: issue.id, messageId: result.messageId, tier: 3 };
}

/**
 * Tier 1a: Workshop label → create work_item + campaign for claw-workshop.
 * Auto-approved (board reviews at PR stage, not work creation).
 */
async function handleWorkshopTrigger(issue, createWorkItem) {
  const labels = issue.labels?.nodes || [];

  // Deduplicate — only match workshop-assigned work items (not executor-coder ones
  // that may have been created during a label toggle race)
  const existing = await query(
    `SELECT id FROM agent_graph.work_items
     WHERE metadata->>'linear_issue_id' = $1
       AND assigned_to = 'claw-workshop'
       AND status NOT IN ('completed', 'cancelled', 'failed')
     LIMIT 1`,
    [issue.id]
  );
  if (existing.rows.length > 0) {
    console.log(`[linear-ingest] Skipping duplicate workshop: work item ${existing.rows[0].id} already exists for ${issue.id}`);
    return { skipped: true, reason: 'Work item already exists', existingWorkItemId: existing.rows[0].id };
  }

  // Derive playbook from labels FIRST (some playbooks don't need a target repo)
  const playbookLabelPrefix = config.playbookLabelPrefix || 'playbook:';
  const playbookLabel = labels.find(l => l.name.startsWith(playbookLabelPrefix));
  let playbookId = playbookLabel
    ? playbookLabel.name.slice(playbookLabelPrefix.length)
    : null; // null = needs classification or default

  // Resolve target repo from labels/project/team
  let targetRepo = resolveTargetRepo(issue);

  // If either playbook or repo is missing, use LLM classifier to fill the gaps
  if (!playbookId || !targetRepo) {
    const needsClassification = !playbookId || !targetRepo;
    if (needsClassification && config.repoDescriptions) {
      try {
        console.log(`[linear-ingest] Classifying ${issue.identifier} (missing: ${!playbookId ? 'playbook' : ''} ${!targetRepo ? 'repo' : ''})`);
        const classification = await classifyIssue(issue, config.repoDescriptions);
        console.log(`[linear-ingest] Classification: playbook=${classification.playbook_id}, repo=${classification.target_repo}, confidence=${classification.confidence} — ${classification.reasoning}`);

        // Apply playbook from classifier if not set by label
        if (!playbookId) {
          playbookId = classification.playbook_id;
        }

        // Apply repo from classifier if not set by label/project/team
        if (!targetRepo && classification.target_repo) {
          if (classification.target_repo === 'new-repo') {
            playbookId = 'scaffold-repo';
            targetRepo = 'staqsIO/optimus-private'; // execution context for scaffold
            console.log(`[linear-ingest] Classifier detected new-repo → scaffold-repo playbook`);
          } else if (classification.confidence >= 0.8) {
            targetRepo = classification.target_repo;
            console.log(`[linear-ingest] Classifier assigned repo: ${targetRepo} (confidence: ${classification.confidence})`);
          } else {
            // Low confidence — ask for confirmation
            console.log(`[linear-ingest] Classifier low confidence (${classification.confidence}) — asking for label`);
            try {
              await addBotComment(issue.id,
                `I think this belongs in **${classification.target_repo}** (${classification.reasoning}).\n\n` +
                `Add \`repo:${classification.target_repo.split('/')[1]}\` to confirm, or apply a different \`repo:\` label.`
              );
            } catch (err) {
              console.warn(`[linear-ingest] Failed to post classifier comment: ${err.message}`);
            }
            return { skipped: true, reason: `Low confidence repo classification for ${issue.identifier} — awaiting label` };
          }
        }
      } catch (err) {
        console.warn(`[linear-ingest] Classification failed: ${err.message} — using defaults`);
      }
    }
  }

  // Final fallback for playbook
  if (!playbookId) {
    playbookId = 'implement-feature';
  }

  // Playbooks that create new repos only need an execution context, not a real target
  const REPO_CREATING_PLAYBOOKS = ['scaffold-repo'];
  const isRepoCreating = REPO_CREATING_PLAYBOOKS.includes(playbookId);

  if (!targetRepo && isRepoCreating) {
    // scaffold-repo ignores the cloned repo — use optimus as execution context
    targetRepo = 'staqsIO/optimus-private';
    console.log(`[linear-ingest] Playbook ${playbookId} creates a new repo — using ${targetRepo} as execution context`);
  }
  if (!targetRepo) {
    console.log(`[linear-ingest] No repo resolved for workshop ${issue.identifier} — requesting label`);
    try {
      const repoOptions = Object.keys(config.repoMapping).map(k => `\`${k}\``).join(', ');
      await addBotComment(issue.id,
        `Workshop triggered but no target repo found.\n\nPlease add one of: ${repoOptions}`
      );
    } catch (err) {
      console.warn(`[linear-ingest] Failed to post repo-request comment: ${err.message}`);
    }
    return { skipped: true, reason: `No target repo for workshop ${issue.identifier}` };
  }

  console.log(`[linear-ingest] Workshop: ${issue.identifier} → playbook=${playbookId}, repo=${targetRepo}`);

  // Build ticket body
  const { body: ticketBody, priority: issuePriority } = buildTicketBody(issue);

  // Create action_proposal
  const proposalResult = await query(
    `INSERT INTO agent_graph.action_proposals
     (action_type, body, linear_issue_id, linear_issue_url, target_repo)
     VALUES ('ticket_create', $1, $2, $3, $4)
     RETURNING id`,
    [ticketBody, issue.id, issue.url, targetRepo]
  );
  const proposalId = proposalResult.rows[0].id;

  // Create work_item → assigned to claw-workshop
  const workItem = await createWorkItem({
    type: 'task',
    title: `Workshop: ${issue.identifier} — ${issue.title}`,
    description: issue.description?.slice(0, 500) || '',
    createdBy: 'orchestrator',
    assignedTo: 'claw-workshop',
    priority: mapLinearPriority(issuePriority),
    metadata: {
      ticket_proposal_id: proposalId,
      target_repo: targetRepo,
      linear_issue_id: issue.id,
      linear_issue_url: issue.url,
      linear_identifier: issue.identifier,
      linear_priority: issuePriority,
      playbook_id: playbookId,
      source: 'linear-webhook',
    },
  });

  // Create campaign row — auto-approved
  // Budget from playbook defaults (loaded at execution time; use $15 as safe default)
  const budgetUsd = 15.00;
  await query(
    `INSERT INTO agent_graph.campaigns
     (work_item_id, campaign_mode, campaign_status, goal_description,
      budget_envelope_usd, max_cost_per_iteration, metadata, created_by)
     VALUES ($1, 'workshop', 'approved', $2, $3, $4, $5, 'orchestrator')`,
    [
      workItem?.id,
      `${issue.identifier}: ${issue.title}`,
      budgetUsd,
      budgetUsd, // single-pass, so max_per_iteration = envelope
      JSON.stringify({
        playbook_id: playbookId,
        target_repo: targetRepo,
        linear_issue_id: issue.id,
        linear_issue_url: issue.url,
        linear_identifier: issue.identifier,
      }),
    ]
  );

  console.log(`[linear-ingest] Created workshop campaign for ${issue.identifier} → claw-workshop (playbook=${playbookId})`);

  // Update Linear issue to "In Development" (best-effort)
  try {
    await updateIssueStateByName(issue.id, 'In Development');
    console.log(`[linear-ingest] Updated ${issue.identifier} to "In Development"`);
  } catch (err) {
    console.warn(`[linear-ingest] Failed to update issue state: ${err.message}`);
  }

  return { issueId: issue.id, workItemId: workItem?.id, proposalId, campaignMode: 'workshop', playbookId };
}

/**
 * Build structured ticket body for executor-coder consumption.
 * Same shape that executor-ticket produces so executor-coder can process it uniformly.
 */
function buildTicketBody(issue) {
  const labels = (issue.labels?.nodes || []).map(l => l.name).join(', ');
  const assignee = issue.assignee?.name || 'Unassigned';
  const team = issue.team ? `${issue.team.name} (${issue.team.key})` : 'Unknown team';
  const project = issue.project?.name || 'No project';

  const body = [
    `# ${issue.identifier}: ${issue.title}`,
    '',
    `**Team:** ${team}`,
    `**Project:** ${project}`,
    `**Assignee:** ${assignee}`,
    `**Priority:** ${['None', 'Urgent', 'High', 'Medium', 'Low'][issue.priority] || 'None'}`,
    labels ? `**Labels:** ${labels}` : null,
    `**Linear:** ${issue.url}`,
    '',
    '## Description',
    '',
    issue.description || '_No description provided._',
  ].filter(line => line !== null).join('\n');

  return { body, priority: issue.priority };
}
