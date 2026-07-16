// Pure helpers for the Settings → LLM Guardrails state-mapping editor (FR-22, FR-25).
//
// Translates between Linear workflow states + the persisted mapping object
// and the row-shaped view model the editor renders. The suggested defaults
// mirror lib/linear/team-cache.js → bootstrapDefaultMapping so the UI never
// disagrees with the server-side bootstrap.

/**
 * @typedef {Object} WorkflowState
 * @property {string} id
 * @property {string} name
 * @property {string|null} [type]
 * @property {number}  [position]
 */

/**
 * @typedef {Object} MapperRow
 * @property {string} state_id
 * @property {string} state_name
 * @property {string|null} state_type
 * @property {string|null} current_status
 * @property {string} suggested_status
 */

// FR-25: state.type → suggested kanban status. Unknown / null / missing
// types default to 'inbox' (safest landing lane).
const TYPE_DEFAULTS = Object.freeze({
  backlog: 'inbox',
  unstarted: 'todo',
  started: 'in_progress',
  completed: 'done',
  canceled: 'not_for_us',
});

/**
 * @param {string|null|undefined} type
 * @returns {string}
 */
function suggestedFor(type) {
  if (type && Object.prototype.hasOwnProperty.call(TYPE_DEFAULTS, type)) {
    return TYPE_DEFAULTS[type];
  }
  return 'inbox';
}

/**
 * Build the row view-model the mapping editor renders.
 *
 * Sort: by `position` ascending if every state has a numeric position; else
 * by `name` ascending. (Linear teams in the wild are inconsistent — some
 * GraphQL responses omit position on archived states.)
 *
 * @param {WorkflowState[]} workflowStates
 * @param {Record<string,string>} mapping
 * @returns {MapperRow[]}
 */
export function buildMapperRows(workflowStates, mapping) {
  const states = Array.isArray(workflowStates) ? workflowStates : [];
  const map = mapping && typeof mapping === 'object' ? mapping : {};

  const allHavePosition = states.length > 0
    && states.every((s) => typeof s.position === 'number');

  const sorted = [...states].sort((a, b) => {
    if (allHavePosition) return a.position - b.position;
    const an = a.name == null ? '' : String(a.name);
    const bn = b.name == null ? '' : String(b.name);
    return an.localeCompare(bn);
  });

  return sorted.map((s) => ({
    state_id: s.id,
    state_name: s.name,
    state_type: s.type == null ? null : s.type,
    current_status: Object.prototype.hasOwnProperty.call(map, s.id) ? map[s.id] : null,
    suggested_status: suggestedFor(s.type),
  }));
}

/**
 * Collapse rows back into a mapping object. Rows with null/undefined
 * current_status are dropped entirely (key absent, not set to null) so the
 * persisted mapping never carries "unset" sentinels.
 *
 * @param {MapperRow[]} rows
 * @returns {Record<string,string>}
 */
export function mapperRowsToMapping(rows) {
  const out = {};
  if (!Array.isArray(rows)) return out;
  for (const row of rows) {
    if (!row || typeof row.state_id !== 'string') continue;
    if (typeof row.current_status === 'string') {
      out[row.state_id] = row.current_status;
    }
  }
  return out;
}
