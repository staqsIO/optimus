/**
 * AI autofill enrichment for human_tasks.
 *
 * PRD: autobot-inbox/docs/internal/prds/meeting-actions-to-kanban.md §6
 *
 * One batched LLM call per promoted task. The caller passes an `llm`
 * function — the enrichment module is provider-agnostic and never imports
 * the LLM SDK directly. That keeps the tests trivially fast (no network)
 * and lets the API layer reuse the org-level callLLM.
 *
 * The returned `patch` is an object the API layer feeds into UPDATE
 * inbox.human_tasks. Every value is *validated*: hallucinated contact ids
 * or unknown priority/size values are dropped, never silently written.
 */

const VALID_PRIORITY = new Set(['urgent', 'high', 'normal', 'low']);
const VALID_SIZE = new Set(['quick', 'small', 'medium', 'large']);
const VALID_TASK_TYPE = new Set(['action', 'decision_followup', 'request', 'blocker']);
const MAX_TAGS = 3;
const DESCRIPTION_CAP = 1000;

function clamp01(x) {
  const n = typeof x === 'number' ? x : Number.parseFloat(x);
  if (!Number.isFinite(n)) return null;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function pickFirstLine(s) {
  if (typeof s !== 'string') return null;
  const first = s.split(/\r?\n/, 1)[0].trim();
  return first || null;
}

function normalizeTags(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const t of raw) {
    if (typeof t !== 'string') continue;
    const tag = t.trim().toLowerCase();
    if (!tag) continue;
    if (out.includes(tag)) continue;
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/**
 * Build the user message for the enrichment LLM call. Exposed for tests
 * (and so a tooling layer can audit prompts before sending).
 *
 * @param {Object} opts
 * @param {Object} opts.task
 * @param {Array} opts.contacts
 * @param {Array} opts.projects
 * @param {Array} [opts.engagements]
 * @returns {string}
 */
export function buildEnrichmentPrompt({ task, contacts, projects, engagements = [] }) {
  const contactList = contacts
    .map((c) => `  ${c.id}: ${c.name || c.display_name} <${c.email_address || ''}>`)
    .join('\n');
  const projectList = projects
    .map((p) => `  ${p.id}: ${p.name}`)
    .join('\n');
  const engagementList = engagements
    .map((e) => `  ${e.id}: ${e.name}`)
    .join('\n');

  return [
    `Enrich a human task with the following content:`,
    ``,
    `TITLE: ${task.title}`,
    `QUOTE: ${task.source_quote || task.title}`,
    `CURRENT ASSIGNEE LABEL: ${task.assignee_label || '(none)'}`,
    ``,
    `KNOWN CONTACTS (use these ids ONLY — do NOT invent uuids):`,
    contactList || '  (none)',
    ``,
    `ACTIVE PROJECTS:`,
    projectList || '  (none)',
    ``,
    `ACTIVE ENGAGEMENTS:`,
    engagementList || '  (none)',
    ``,
    `Return a JSON object with any subset of these fields:`,
    `  assignee_contact_id   : one of the ids above, or null`,
    `  assignee_confidence   : 0.0–1.0`,
    `  task_type             : one of [action, decision_followup, request, blocker]`,
    `  priority              : one of [urgent, high, normal, low]`,
    `  size                  : one of [quick, small, medium, large]`,
    `  project_id            : one of the project ids above, or null`,
    `  engagement_id         : one of the engagement ids above, or null`,
    `  tags                  : array of 0–3 short lowercase tags`,
    `  next_action_hint      : 1 line — the literal first concrete step`,
    `  description           : 1–2 sentences of context (not a duplicate of TITLE)`,
    `  extraction_confidence : 0.0–1.0 self-rating`,
    `  related_contact_ids   : array of ids from the contact list`,
    ``,
    `DO NOT include: status, due_date, snoozed_until.`,
    `If unsure of any field, OMIT it. Never invent values.`,
  ].join('\n');
}

/**
 * @param {Object} opts
 * @param {Object} opts.task                       - the human_tasks row
 * @param {Array}  opts.contacts                   - allow-list for assignee/related ids
 * @param {Array}  opts.projects                   - allow-list for project_id
 * @param {Array}  [opts.engagements]              - allow-list for engagement_id
 * @param {(prompt: string) => Promise<string>} opts.llm - injectable LLM call
 * @returns {Promise<object>} patch object (every field optional)
 */
export async function enrichTask({ task, contacts, projects, engagements = [], llm }) {
  if (typeof llm !== 'function') {
    throw new Error('enrichTask requires { llm } as a function');
  }

  const prompt = buildEnrichmentPrompt({ task, contacts, projects, engagements });

  let raw;
  try {
    raw = await llm(prompt);
  } catch {
    return {}; // fail safe
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

  const validContactIds = new Set(contacts.map((c) => c.id));
  const validProjectIds = new Set(projects.map((p) => p.id));
  const validEngagementIds = new Set(engagements.map((e) => e.id));
  const patch = {};

  // assignee_contact_id — must be in the allow-list, else null
  if ('assignee_contact_id' in parsed) {
    patch.assignee_contact_id =
      typeof parsed.assignee_contact_id === 'string'
        && validContactIds.has(parsed.assignee_contact_id)
        ? parsed.assignee_contact_id
        : null;
  }

  if ('assignee_confidence' in parsed) {
    const v = clamp01(parsed.assignee_confidence);
    if (v !== null) patch.assignee_confidence = v;
  }

  if ('task_type' in parsed) {
    patch.task_type = VALID_TASK_TYPE.has(parsed.task_type) ? parsed.task_type : null;
  }

  if ('priority' in parsed) {
    patch.priority = VALID_PRIORITY.has(parsed.priority) ? parsed.priority : 'normal';
  }

  if ('size' in parsed) {
    patch.size = VALID_SIZE.has(parsed.size) ? parsed.size : null;
  }

  if ('project_id' in parsed) {
    patch.project_id =
      typeof parsed.project_id === 'string' && validProjectIds.has(parsed.project_id)
        ? parsed.project_id
        : null;
  }

  if ('engagement_id' in parsed) {
    patch.engagement_id =
      typeof parsed.engagement_id === 'string' && validEngagementIds.has(parsed.engagement_id)
        ? parsed.engagement_id
        : null;
  }

  if ('tags' in parsed) {
    const tags = normalizeTags(parsed.tags);
    if (tags !== null) patch.tags = tags;
  }

  if ('next_action_hint' in parsed) {
    const v = pickFirstLine(parsed.next_action_hint);
    if (v !== null) patch.next_action_hint = v;
  }

  if ('description' in parsed && typeof parsed.description === 'string') {
    const trimmed = parsed.description.trim();
    if (trimmed) {
      patch.description = trimmed.length > DESCRIPTION_CAP
        ? `${trimmed.slice(0, DESCRIPTION_CAP - 1).trimEnd()}…`
        : trimmed;
    }
  }

  if ('extraction_confidence' in parsed) {
    const v = clamp01(parsed.extraction_confidence);
    if (v !== null) patch.extraction_confidence = v;
  }

  if ('related_contact_ids' in parsed && Array.isArray(parsed.related_contact_ids)) {
    patch.related_contact_ids = parsed.related_contact_ids
      .filter((id) => typeof id === 'string' && validContactIds.has(id));
  }

  // Deliberately ignore: status, due_date, snoozed_until.
  return patch;
}
