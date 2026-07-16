/**
 * lib/runtime/push-prompt.js
 *
 * Push-LLM prompt builder. Pure function — no I/O, no LLM SDK imports.
 *
 * PRD: autobot-inbox/docs/internal/prds/meeting-actions-to-kanban-v0.2-tech-spec.md
 *      §1 FR-5, FR-8, FR-21.
 *
 * Contract:
 *   - When guardrail.prompt_text is non-empty, it is prepended verbatim to
 *     the top of the prompt (FR-21).
 *   - When guardrail.prompt_text is empty/missing, the prompt starts with
 *     the push agent header — no leading section.
 *   - Lists every workflow state / project / member / label from the
 *     team cache (the LLM must only use these ids). Empty lists render
 *     `(none)` so the schema stays legible.
 *   - Specifies the JSON output shape consumed by
 *     `lib/linear/issue-payload.js` (title, description, projectId,
 *     assigneeId, stateId, priority, labelIds, dueDate, skip_reason?).
 */

function fmt(value) {
  if (value === null || value === undefined) return '(none)';
  if (typeof value === 'string') return value.length > 0 ? value : '(none)';
  return String(value);
}

function renderList(items, render) {
  if (!Array.isArray(items) || items.length === 0) return '  (none)';
  return items.map((item) => `  ${render(item)}`).join('\n');
}

export function buildPushPrompt({ task, teamCache, guardrail } = {}) {
  const t = task ?? {};
  const cache = teamCache ?? {};
  const states = Array.isArray(cache.workflow_states) ? cache.workflow_states : [];
  const projects = Array.isArray(cache.projects) ? cache.projects : [];
  const members = Array.isArray(cache.members) ? cache.members : [];
  const labels = Array.isArray(cache.labels) ? cache.labels : [];

  const lines = [];

  // FR-21 — prepend guardrail prompt_text when non-empty.
  const guardrailText = typeof guardrail?.prompt_text === 'string'
    ? guardrail.prompt_text.trim()
    : '';
  if (guardrailText.length > 0) {
    lines.push(guardrailText, '');
  }

  lines.push(
    'You are the Optimus push agent. Decide the Linear issue payload for this task.',
    '',
    'TASK:',
    `  title: ${fmt(t.title)}`,
    `  description: ${fmt(t.description)}`,
    `  source_quote: ${fmt(t.source_quote)}`,
    `  source_ts: ${fmt(t.source_ts)}`,
    `  signal_id: ${fmt(t.signal_id)}`,
    `  message_id: ${fmt(t.message_id)}`,
    `  assignee_label: ${fmt(t.assignee_label)}`,
    `  project_id: ${fmt(t.project_id)}`,
    `  engagement_id: ${fmt(t.engagement_id)}`,
    `  priority: ${fmt(t.priority)}`,
    `  size: ${fmt(t.size)}`,
    `  due_date: ${fmt(t.due_date)}`,
    `  task_type: ${fmt(t.task_type)}`,
    `  next_action_hint: ${fmt(t.next_action_hint)}`,
    '',
    'TEAM STATES (id → name | type):',
    renderList(states, (s) => `${fmt(s?.id)}: ${fmt(s?.name)} | ${fmt(s?.type)}`),
    '',
    'TEAM PROJECTS (id → name):',
    renderList(projects, (p) => `${fmt(p?.id)}: ${fmt(p?.name)}`),
    '',
    'TEAM MEMBERS (id → name):',
    renderList(members, (m) => `${fmt(m?.id)}: ${fmt(m?.name)}`),
    '',
    'TEAM LABELS (id → name):',
    renderList(labels, (l) => `${fmt(l?.id)}: ${fmt(l?.name)}`),
    '',
    'Return a JSON object with these fields:',
    '  title             : ≤80 chars, action-oriented',
    '  description       : Markdown body, 1-2 sentences of context + source quote + footer',
    '  projectId         : one of the project ids above, or null',
    '  assigneeId        : one of the member ids above, or null',
    '  stateId           : REQUIRED - one of the workflow state ids above',
    '  priority          : 0-4 (Linear scale, 0=no priority)',
    '  labelIds          : array of label ids (optimus label will be added automatically)',
    '  dueDate           : ISO date string or null',
    '  skip_reason       : (only if not ready) string explaining why',
    '',
    'DO NOT invent ids. Use only the ids listed above.',
    'If you cannot follow a guardrail rule, set skip_reason explaining why.',
  );

  return lines.join('\n');
}
