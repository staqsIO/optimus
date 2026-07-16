// Pure helpers for rendering board cards.
// Per ADR-004, the testable visual contract lives in a plain .js file so
// node:test can exercise it without RTL.
//
// PRD: docs/internal/prds/meeting-actions-to-kanban.md §7 (UX rules).

const TERMINAL_HUMAN_STATUSES = new Set(['done', 'skipped', 'not_for_us']);

// Action-set for human_task cards. Order matches the PRD button row.
const HUMAN_TASK_ACTIONS = Object.freeze(['done', 'skip', 'later', 'not_for_me']);

/**
 * Compute the initials chip for a card.
 *
 * @param {object} card
 * @returns {{ initials: string|null, glyph: string|null, label: string|null, dashed: boolean }}
 */
export function assigneeChip(card) {
  if (!card) return { initials: '?', glyph: null, label: null, dashed: true };

  if (card.kind === 'work_item') {
    return {
      initials: null,
      glyph: '⌬',
      label: card.assigned_to || 'agent',
      dashed: false,
    };
  }

  // human_task / proposal / attention all carry a label.
  const label = card.assignee_label
    || card.assignee_contact_id /* fallback to id if no human label */
    || null;
  if (!label) {
    return { initials: '?', glyph: null, label: null, dashed: true };
  }

  // Initials: take first + last token's first letter (capitalised, ASCII).
  // Strip punctuation, drop empty tokens.
  const tokens = String(label)
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}]/gu, ''))
    .filter(Boolean);
  let initials;
  if (tokens.length === 0) initials = '?';
  else if (tokens.length === 1) initials = tokens[0][0].toUpperCase();
  else initials = (tokens[0][0] + tokens[tokens.length - 1][0]).toUpperCase();

  return { initials, glyph: null, label, dashed: false };
}

/**
 * Compute the Tailwind class string for the card's left-border accent.
 * Returns *just* the border classes — callers compose with the card shell.
 *
 * @param {object} card
 * @returns {string}
 */
export function cardAccentClass(card) {
  if (!card) return 'border-l-2 border-l-amber-500/30';

  if (card.kind === 'work_item') {
    return 'border-l-2 border-l-blue-500/40';
  }
  if (card.kind === 'human_task') {
    const unassigned = !card.assignee_contact_id && !card.assignee_label;
    return unassigned
      ? 'border-l-2 border-l-amber-400/60 border-dashed'
      : 'border-l-2 border-l-amber-500/40';
  }
  // proposal / attention → human-leaning amber.
  return 'border-l-2 border-l-amber-500/30';
}

/**
 * What action buttons should the card surface?
 *
 * @param {object} card
 * @returns {('done'|'skip'|'later'|'not_for_me')[]}
 */
export function cardActions(card) {
  if (!card || card.kind !== 'human_task') return [];
  if (TERMINAL_HUMAN_STATUSES.has(card.status)) return [];
  return HUMAN_TASK_ACTIONS.slice();
}

/**
 * Pick the single highest-leverage inline question for this card.
 *
 * PRD §7: "At most one inline question per card at a time. If two fields
 * are missing, ask the higher-leverage one first (assignee > due > size)."
 * Proposed-band cards override that with "is_this_ours" first.
 *
 * @param {object} card
 * @returns {{ field: string, options: string[]|null } | null}
 */
export function inlineQuestionFor(card) {
  if (!card || card.kind !== 'human_task') return null;
  if (TERMINAL_HUMAN_STATUSES.has(card.status)) return null;

  if (card.status === 'proposed') {
    return { field: 'is_this_ours', options: ['yes', 'no', 'defer'] };
  }
  if (!card.assignee_contact_id) {
    return { field: 'assignee', options: null /* contact picker */ };
  }
  if (!card.due_date) {
    return { field: 'when', options: ['today', 'this_week', 'next_week', 'no_deadline'] };
  }
  if (!card.size) {
    return { field: 'size', options: ['quick', 'small', 'medium', 'large'] };
  }
  return null;
}

/**
 * Format the needs_human summary as a short human-readable string. Empty
 * when the card has no needs_human payload.
 *
 * @param {object} card
 * @returns {string}
 */
export function formatNeedsHuman(card) {
  const nh = card?.needs_human;
  if (!nh || !nh.trigger) return '';
  const label = nh.trigger.replace(/_/g, ' ');
  return nh.hint ? `${label} — ${nh.hint}` : label;
}

// ---------------------------------------------------------------------------
// v0.2 extensions — lifecycle, Linear chip, sticky-field marker.
//
// PRD: docs/internal/prds/meeting-actions-to-kanban-v0.2-tech-spec.md
//   FR-27 / canonical transition table (lifecycleTransitionsFor)
//   FR-30 (linearChipFor — card body Linear chip)
//   FR-3 + AD-5 (isFieldSticky — operator-edited markers in details panel)
//
// Source of truth for the transitions: the canonical table in the tech spec
// (Task 5). Mirrors `TRANSITIONS` in autobot-inbox/src/api-routes/human-tasks.js
// so the API and the UI agree on the set of allowed verbs.
// ---------------------------------------------------------------------------

const LIFECYCLE_TRANSITIONS = Object.freeze({
  inbox: [
    { verb: 'start', label: 'Start', to_status: 'todo' },
    { verb: 'to_in_progress', label: 'Send to in-progress', to_status: 'in_progress' },
  ],
  todo: [
    { verb: 'start', label: 'Start', to_status: 'in_progress' },
    { verb: 'to_inbox', label: 'Return to inbox', to_status: 'inbox' },
  ],
  later: [
    { verb: 'start', label: 'Start', to_status: 'in_progress' },
    { verb: 'to_inbox', label: 'Return to inbox', to_status: 'inbox' },
  ],
  in_progress: [
    { verb: 'block', label: 'Block', to_status: 'blocked' },
    { verb: 'to_review', label: 'Send to review', to_status: 'review' },
    { verb: 'to_todo', label: 'Return to todo', to_status: 'todo' },
  ],
  blocked: [
    { verb: 'unblock', label: 'Unblock', to_status: 'in_progress' },
    { verb: 'to_todo', label: 'Return to todo', to_status: 'todo' },
  ],
  review: [
    { verb: 'to_in_progress', label: 'Return to in-progress', to_status: 'in_progress' },
  ],
  // proposed: clears via inline `is_this_ours` answer, not via lifecycle.
  // terminal (done/skipped/not_for_us): no transitions.
});

/**
 * Valid lifecycle transitions for a card given its current status.
 *
 * Returns [] for non-human_task kinds, terminal statuses, `proposed`, and
 * unknown statuses. The returned array is a fresh copy (callers may mutate).
 *
 * @param {object} card
 * @returns {{verb:string,label:string,to_status:string}[]}
 */
export function lifecycleTransitionsFor(card) {
  if (!card || card.kind !== 'human_task') return [];
  const entries = LIFECYCLE_TRANSITIONS[card.status];
  if (!entries) return [];
  return entries.map((e) => ({ ...e }));
}

/**
 * Render data for the Linear chip on a card body (FR-30). Returns null when
 * the card has no Linear issue or isn't a human_task.
 *
 * The identifier prefers the human-readable Linear key (e.g. `STA-42`) when
 * we can recover it from the URL — that's what shows up on the chip. We fall
 * back to a short slice of `linear_issue_id` if the URL is unparseable.
 *
 * @param {object} card
 * @returns {{identifier:string,url:string,accent:'linear'} | null}
 */
export function linearChipFor(card) {
  if (!card || card.kind !== 'human_task') return null;
  const id = card.linear_issue_id;
  if (!id || typeof id !== 'string') return null;

  const url = typeof card.linear_issue_url === 'string' ? card.linear_issue_url : null;

  // Prefer the Linear key from the URL (e.g. /issue/STA-42 → STA-42).
  let identifier = null;
  if (url) {
    const match = url.match(/\/issue\/([A-Z0-9]+-\d+)/i);
    if (match) identifier = match[1].toUpperCase();
  }
  if (!identifier) {
    // Fallback: last 6 chars of the opaque id.
    identifier = id.length > 6 ? id.slice(-6) : id;
  }

  return { identifier, url, accent: 'linear' };
}

/**
 * Whether a given field has been manually edited by an operator (FR-3, AD-5).
 *
 * Walks `card.feedback_history` for an entry shaped `{verb:'edited', field}`.
 * Mirrors the canonical sticky-override logic in
 * `lib/runtime/human-task-sticky.js` — the rendering layer asks the same
 * question the enrichment worker does, so the "manually set by X" indicator
 * stays in sync with re-enrichment skips.
 *
 * @param {object} card
 * @param {string} fieldName
 * @returns {boolean}
 */
export function isFieldSticky(card, fieldName) {
  if (!card) return false;
  if (typeof fieldName !== 'string' || fieldName.length === 0) return false;
  const history = card.feedback_history;
  if (!Array.isArray(history)) return false;

  for (const entry of history) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.verb !== 'edited') continue;
    if (entry.field === fieldName) return true;
  }
  return false;
}
