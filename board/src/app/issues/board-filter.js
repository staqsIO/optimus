// Pure filter logic for the segmented control on /board.
// PRD §7: Mine / Humans / Agents / All, with URL + localStorage persistence,
// affecting card population (not lane structure).

export const BOARD_VIEWS = Object.freeze(['mine', 'humans', 'agents', 'all']);

// Card kind taxonomy:
//   work_item                 → "agent" surface (managed by the agent runtime)
//   human_task, proposal, attention → "human" surface (board action required)
//
// "Mine" narrows the human surface to cards explicitly assigned to the
// signed-in board member's contact id (which the API hands us via the
// session). Proposals and attentions don't carry an assignee, so they
// stay out of "Mine" — board can still see them under "Humans".
const HUMAN_KINDS = new Set(['human_task', 'proposal', 'attention']);

/**
 * @param {object} card
 * @param {string} view - one of BOARD_VIEWS, or anything else (falls back to 'all')
 * @param {string|null} me - the viewer's contact_id, for 'mine'
 * @returns {boolean}
 */
export function matchesFilter(card, view, me) {
  if (!card) return false;
  switch (view) {
    case 'humans':
      return HUMAN_KINDS.has(card.kind);
    case 'agents':
      return card.kind === 'work_item';
    case 'mine':
      return card.kind === 'human_task' && card.assignee_contact_id === me;
    case 'all':
    default:
      return true;
  }
}

/**
 * Apply matchesFilter to every lane. Returns a new lanes object with the
 * same lane ids; lanes that lose all cards return [] (PRD §7: "filters
 * affect population, not lane structure").
 *
 * @param {object} lanes
 * @param {string} view
 * @param {string|null} me
 */
export function filterLanes(lanes, view, me) {
  const out = {};
  for (const [laneId, cards] of Object.entries(lanes || {})) {
    out[laneId] = (cards || []).filter((c) => matchesFilter(c, view, me));
  }
  return out;
}

/**
 * Count cards for each view (used to render the chip badges).
 * @param {object} lanes
 * @param {string|null} me
 * @returns {{mine: number, humans: number, agents: number, all: number}}
 */
export function countByView(lanes, me) {
  const flat = Object.values(lanes || {}).flat();
  const c = { mine: 0, humans: 0, agents: 0, all: flat.length };
  for (const card of flat) {
    if (card.kind === 'work_item') c.agents++;
    else if (HUMAN_KINDS.has(card.kind)) {
      c.humans++;
      if (card.kind === 'human_task' && card.assignee_contact_id === me) c.mine++;
    }
  }
  return c;
}

/**
 * Pick the initial view at mount.
 *
 * Precedence (PRD §7):
 *   URL ?view= > localStorage > role default
 * Unknown values are ignored at every level.
 *
 * @param {{ urlView?: string|null, storedView?: string|null, role?: string }} opts
 * @returns {'mine'|'humans'|'agents'|'all'}
 */
export function resolveInitialView({ urlView, storedView, role }) {
  const isValid = (v) => BOARD_VIEWS.includes(v);
  if (isValid(urlView)) return urlView;
  if (isValid(storedView)) return storedView;
  // Default: humans for board members, all for staff/admin.
  return role === 'board' ? 'humans' : 'all';
}

// ---------------------------------------------------------------------------
// Layout: List ⇄ Board (STAQPRO-618 Slice B1).
//
// Layout is orthogonal to the view filter: it changes how the *same* filtered
// lanes are rendered (Kanban columns vs a vertical grouped list), never which
// cards are populated. Mirrors the view-state precedence exactly:
//   URL ?layout= > localStorage['board:layout'] > 'board'
// Unknown values are ignored at every level.
// ---------------------------------------------------------------------------

export const BOARD_LAYOUTS = Object.freeze(['board', 'list']);

/**
 * Pick the initial layout at mount.
 *
 * Precedence: URL ?layout= > localStorage > default ('board').
 * Unknown values fall through to the next source.
 *
 * @param {{ urlLayout?: string|null, storedLayout?: string|null }} opts
 * @returns {'board'|'list'}
 */
export function resolveInitialLayout({ urlLayout, storedLayout } = {}) {
  const isValid = (v) => BOARD_LAYOUTS.includes(v);
  if (isValid(urlLayout)) return urlLayout;
  if (isValid(storedLayout)) return storedLayout;
  return 'board';
}

// ---------------------------------------------------------------------------
// v0.2 composable filters — FR-32 (project + size + signal_meeting filters
// compose with view), FR-13/FR-14 (Linear-mirrored fields are valid filter
// dimensions; project comes from Linear pull / human enrichment).
//
// Design (AD-8 spirit): each dimension is opt-in. Null/undefined for a
// dimension means "no filter on that axis". A card must match ALL active
// dimensions (AND semantics). Special value '__none__' targets cards where
// the dimension is null/missing — useful for triaging unclassified work.
//
// Only human_task cards carry project_id / size / signal_meeting_id /
// message_id. When any of those filters is active we exclude work_item,
// proposal, attention — those kinds don't have those dimensions and the
// operator's intent is "show me the human tasks that match".
// ---------------------------------------------------------------------------

export const BOARD_SIZES = Object.freeze(['quick', 'small', 'medium', 'large']);

const isActive = (v) => v !== null && v !== undefined && v !== '';

function matchesProject(card, project) {
  if (!isActive(project)) return true;
  const pid = card.project_id ?? null;
  if (project === '__none__') return pid === null;
  return pid === project;
}

function matchesSize(card, size) {
  if (!isActive(size)) return true;
  const s = card.size ?? null;
  if (size === '__none__') return s === null;
  return s === size;
}

function matchesSignalMeeting(card, signalMeetingId) {
  if (!isActive(signalMeetingId)) return true;
  // Human-task cards may carry signal_meeting_id directly, or reference the
  // originating meeting via message_id (the canonical link on legacy rows).
  const sid = card.signal_meeting_id ?? null;
  const mid = card.message_id ?? null;
  return sid === signalMeetingId || mid === signalMeetingId;
}

/**
 * Compose the view filter with the new project/size/signal_meeting_id
 * dimensions. Returns true iff the card matches every active filter.
 *
 * @param {object} card
 * @param {{
 *   view?: string,
 *   project?: string|null,
 *   size?: string|null,
 *   signal_meeting_id?: string|null,
 *   me?: string|null,
 * }} filters
 * @returns {boolean}
 */
export function composeFilter(card, filters = {}) {
  if (!card) return false;
  const { view = 'all', project, size, signal_meeting_id, me = null } = filters;

  // view runs first — keeps the existing semantics intact.
  if (!matchesFilter(card, view, me)) return false;

  const anyHumanTaskFilter =
    isActive(project) || isActive(size) || isActive(signal_meeting_id);

  if (anyHumanTaskFilter) {
    // project / size / signal_meeting_id only apply to human_task cards.
    if (card.kind !== 'human_task') return false;
  }

  if (!matchesProject(card, project)) return false;
  if (!matchesSize(card, size)) return false;
  if (!matchesSignalMeeting(card, signal_meeting_id)) return false;

  return true;
}

/**
 * Apply composeFilter across every lane. Preserves the 6 lane ids (ADR-003).
 *
 * @param {object} lanes
 * @param {{
 *   view?: string,
 *   project?: string|null,
 *   size?: string|null,
 *   signal_meeting_id?: string|null,
 * }} filters
 * @param {string|null} me
 */
export function composeFilterLanes(lanes, filters = {}, me = null) {
  const out = {};
  for (const [laneId, cards] of Object.entries(lanes || {})) {
    out[laneId] = (cards || []).filter((c) => composeFilter(c, { ...filters, me }));
  }
  return out;
}

/**
 * Parse the URL search params used by /board into the filter shape consumed
 * by composeFilter. Unknown / empty values become undefined (= "no filter").
 *
 * @param {{ searchParams: URLSearchParams | { get(name: string): string|null } }} req
 * @returns {{ view: string, project: string|undefined, size: string|undefined, signal_meeting_id: string|undefined }}
 */
export function parseFiltersFromUrl({ searchParams } = {}) {
  const get = (k) => {
    if (!searchParams) return null;
    return typeof searchParams.get === 'function' ? searchParams.get(k) : null;
  };
  const view = BOARD_VIEWS.includes(get('view')) ? get('view') : 'all';
  const rawSize = get('size');
  const size =
    rawSize && (BOARD_SIZES.includes(rawSize) || rawSize === '__none__')
      ? rawSize
      : undefined;
  const project = get('project') || undefined;
  const signal_meeting_id = get('signal_meeting_id') || undefined;
  return { view, project, size, signal_meeting_id };
}
