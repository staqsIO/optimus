/**
 * Pure mapper: Linear workflow-state → inbox.human_tasks.status (+ /issues lane).
 *
 * STAQPRO-619-A. Used by the import-on-no-match path (importLinearIssue) for
 * Linear-NATIVE issues, where there is no operator-configured guardrail
 * { stateId → status } mapping to lean on (that mapping, in
 * lib/linear/pull-mapping.js, only covers Optimus-ORIGINATED rows whose teams
 * the board has wired up). Import keys off the stable Linear state `type`
 * taxonomy instead, so an unknown team's states still land in a sensible lane.
 *
 * Linear state types (canonical, from the Linear API):
 *   triage | backlog | unstarted | started | completed | canceled
 *
 * MAPPING (type → human_tasks.status):
 *   triage     → inbox       (newly arrived, not yet sorted)
 *   backlog    → inbox       (full mirror imports Backlog; surfaces in inbox lane)
 *   unstarted  → todo        (e.g. "Todo")
 *   started    → in_progress (e.g. "In Progress", "In Development")
 *   completed  → done
 *   canceled   → not_for_us  (terminal, dropped)
 *
 * INVARIANT — Optimus-native statuses are NEVER set from Linear:
 *   'proposed'  (meeting-pipeline "is this ours?" band),
 *   'skipped'   (operator verb),
 *   'later'     (operator snooze),
 *   'review'    (Optimus lifecycle),
 *   'blocked'   (no canonical Linear state TYPE maps to it — a Linear "Blocked"
 *               state has type 'started' or 'unstarted', so it imports as
 *               in_progress/todo; blocked stays an operator/Optimus concept).
 * These can only be reached via the board UI or the Optimus lifecycle, never by
 * importing external Linear data.
 *
 * Pure: no I/O, no DB, no Linear API. Defensive: unknown/missing type → 'inbox'
 * (fail-soft to the safest, non-terminal lane — never silently drops a card and
 * never fabricates a terminal/operator status).
 */

/** human_tasks.status values this mapper is permitted to emit. */
export const IMPORTABLE_STATUSES = Object.freeze([
  'inbox', 'todo', 'in_progress', 'done', 'not_for_us',
]);

/** /issues kanban lane for each importable status (board-facing grouping). */
const STATUS_TO_LANE = Object.freeze({
  inbox:       'inbox',
  todo:        'todo',
  in_progress: 'in_progress',
  done:        'done',
  not_for_us:  'dropped',
});

const TYPE_TO_STATUS = Object.freeze({
  triage:    'inbox',
  backlog:   'inbox',
  unstarted: 'todo',
  started:   'in_progress',
  completed: 'done',
  canceled:  'not_for_us',
});

/** Terminal statuses (no further import-driven transitions expected). */
export const TERMINAL_IMPORT_STATUSES = Object.freeze(['done', 'not_for_us']);

/**
 * Map a Linear workflow state to a human_tasks status + kanban lane.
 *
 * @param {{ type?: string|null, name?: string|null } | null | undefined} state
 *   Linear workflow state object ({ id, name, type }). Only `type` drives the
 *   mapping; `name` is accepted for forward-compatibility/logging but unused.
 * @returns {{ status: string, lane: string, terminal: boolean }}
 */
export function mapLinearStateToStatus(state) {
  const type = state && typeof state === 'object' && typeof state.type === 'string'
    ? state.type.toLowerCase()
    : null;

  // 'cancelled' (British spelling) is not a canonical Linear type, but accept it
  // defensively so a non-standard payload still lands terminal rather than inbox.
  const normalizedType = type === 'cancelled' ? 'canceled' : type;

  const status = (normalizedType && Object.prototype.hasOwnProperty.call(TYPE_TO_STATUS, normalizedType))
    ? TYPE_TO_STATUS[normalizedType]
    : 'inbox'; // fail-soft: unknown/missing type → safest non-terminal lane

  return {
    status,
    lane: STATUS_TO_LANE[status],
    terminal: TERMINAL_IMPORT_STATUSES.includes(status),
  };
}
