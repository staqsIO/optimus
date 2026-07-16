/**
 * lib/linear/issue-payload.js
 *
 * Pure payload builder — turns a human_tasks row + cached Linear team
 * metadata + the current push guardrail + an LLM response into a validated
 * Linear issue payload.
 *
 * PRD: autobot-inbox/docs/internal/prds/meeting-actions-to-kanban-v0.2-tech-spec.md
 *      §1 FR-5..FR-11 (LLM decision pass + payload construction).
 *
 * Contract:
 *   - No I/O, no input mutation (P3 transparency via structure).
 *   - If `llmResponse.skip_reason` is a non-empty string, short-circuit to
 *     `{ skip_reason }` — validation is skipped entirely.
 *   - Otherwise every id from the LLM is validated against the team cache.
 *     Bad ids drop to guardrail.mapping defaults (where defined) or null.
 *     `stateId` is REQUIRED — falls back to mapping.defaultStateId; if
 *     still absent, throws `no valid state for push`.
 *   - The "optimus" label (looked up by name) is always included when
 *     present in the cache; missing-in-cache is logged-and-omitted, never
 *     thrown.
 *   - Title defaults to `task.title`, capped at 80 chars with "…" suffix.
 *   - Description always ends with `Pushed under guardrail v<revision>`
 *     exactly once; LLM-supplied fakes are stripped before append. A
 *     `Source: <message_id> · [<source_ts>]` line is appended when
 *     `task.message_id` is set.
 */

import { createLogger } from '../logger.js';

const log = createLogger('linear/issue-payload');

const TITLE_MAX = 80;
const ELLIPSIS = '…';
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FOOTER_LINE_RE = /^Pushed under guardrail v\d+\s*$/gm;
const VALID_PRIORITIES = new Set([0, 1, 2, 3, 4]);
const DEFAULT_PRIORITY = 3;

export function buildIssuePayload({ task, teamCache, guardrail, llmResponse }) {
  // 1. Skip path — short-circuit before any validation.
  if (typeof llmResponse?.skip_reason === 'string' && llmResponse.skip_reason.length > 0) {
    return { skip_reason: llmResponse.skip_reason };
  }

  const cache = teamCache ?? {};
  const projects = Array.isArray(cache.projects) ? cache.projects : [];
  const members = Array.isArray(cache.members) ? cache.members : [];
  const states = Array.isArray(cache.workflow_states) ? cache.workflow_states : [];
  const labels = Array.isArray(cache.labels) ? cache.labels : [];
  const mapping = guardrail?.mapping ?? {};

  // 2. projectId — keep if in cache, else mapping default, else null.
  const projectId = pickById(projects, llmResponse?.projectId)
    ?? (mapping.defaultProjectId ?? null);

  // 3. assigneeId — keep if in cache, else null. No mapping fallback.
  const assigneeId = pickById(members, llmResponse?.assigneeId) ?? null;

  // 4. stateId — REQUIRED. Cache match → mapping default → throw.
  let stateId = pickById(states, llmResponse?.stateId);
  if (stateId === null) {
    if (typeof mapping.defaultStateId === 'string' && mapping.defaultStateId.length > 0) {
      stateId = mapping.defaultStateId;
    } else {
      throw new Error('no valid state for push');
    }
  }

  // 5. priority — must be integer 0..4, else default 3.
  const priority = VALID_PRIORITIES.has(llmResponse?.priority)
    ? llmResponse.priority
    : DEFAULT_PRIORITY;

  // 6. labelIds — filter to cache, always append optimus (by name), de-dup.
  const rawLabels = Array.isArray(llmResponse?.labelIds) ? llmResponse.labelIds : [];
  const validLabelIds = new Set(labels.map((l) => l.id));
  const labelIds = [];
  const seen = new Set();
  for (const id of rawLabels) {
    if (validLabelIds.has(id) && !seen.has(id)) {
      labelIds.push(id);
      seen.add(id);
    }
  }
  const optimusLabel = labels.find((l) => l?.name === 'optimus');
  if (optimusLabel) {
    if (!seen.has(optimusLabel.id)) {
      labelIds.push(optimusLabel.id);
      seen.add(optimusLabel.id);
    }
  } else {
    log.warn('optimus label missing from team cache — omitting from payload');
  }

  // 7. dueDate — ISO date string only, else null.
  const dueDate = isIsoDate(llmResponse?.dueDate) ? llmResponse.dueDate : null;

  // 8. Title — llmResponse.title || task.title, cap 80 with ellipsis.
  const rawTitle = pickString(llmResponse?.title) ?? pickString(task?.title) ?? '';
  const title = capTitle(rawTitle);

  // 9. Description — base body, strip any guardrail-vN line, append our footer
  //    exactly once, append Source line if message_id set.
  const rawDescription = pickString(llmResponse?.description)
    ?? pickString(task?.description)
    ?? '';
  const description = buildDescription({
    body: rawDescription,
    revision: guardrail?.revision,
    messageId: task?.message_id,
    sourceTs: task?.source_ts,
  });

  return {
    title,
    description,
    projectId,
    assigneeId,
    stateId,
    priority,
    labelIds,
    dueDate,
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function pickById(collection, id) {
  if (typeof id !== 'string' || id.length === 0) return null;
  return collection.some((entry) => entry?.id === id) ? id : null;
}

function pickString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isIsoDate(value) {
  return typeof value === 'string' && ISO_DATE_RE.test(value);
}

function capTitle(title) {
  if (title.length <= TITLE_MAX) return title;
  return title.slice(0, TITLE_MAX - 1) + ELLIPSIS;
}

function buildDescription({ body, revision, messageId, sourceTs }) {
  // Strip any pre-existing footer line — the LLM does not get to spoof it.
  const stripped = body.replace(FOOTER_LINE_RE, '').replace(/\n{3,}/g, '\n\n').trimEnd();

  const footer = `Pushed under guardrail v${revision}`;
  const parts = [];
  if (stripped.length > 0) parts.push(stripped);
  parts.push(footer);

  if (typeof messageId === 'string' && messageId.length > 0) {
    const ts = typeof sourceTs === 'string' && sourceTs.length > 0 ? sourceTs : '';
    parts.push(`Source: ${messageId} · [${ts}]`);
  }

  return parts.join('\n\n');
}
