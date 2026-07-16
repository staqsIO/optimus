// Lane bucketing for the /board view.
// ADR-003 fixes the lane ids and ordering as the route/API contract.
// ADR-004 mandates pure-function tests under node:test — hence plain .js
// with JSDoc types instead of .ts (no TS runner needed for tests).

/**
 * @typedef {'needs_you' | 'created' | 'assigned' | 'in_progress' | 'review' | 'completed'} LaneId
 */

/**
 * @typedef {Object} LaneDef
 * @property {LaneId} id
 * @property {string} title
 * @property {'human' | 'flow'} emphasis
 */

/**
 * @typedef {Object} WorkItemCard
 * @property {'work_item'} kind
 * @property {string} id
 * @property {'directive' | 'workstream'} type
 * @property {string} title
 * @property {'created' | 'assigned' | 'in_progress' | 'review' | 'completed'} status
 * @property {string | null} assigned_to
 * @property {string} created_by
 * @property {string} created_at
 * @property {string} updated_at
 */

/**
 * @typedef {Object} ProposalCard
 * @property {'proposal'} kind
 * @property {string} id
 * @property {string} title
 * @property {string} action_type
 * @property {string | null} work_item_id
 * @property {string} created_at
 */

/**
 * @typedef {Object} AttentionCard
 * @property {'attention'} kind
 * @property {string} id
 * @property {string} title
 * @property {string} signature
 * @property {string | null} work_item_id
 * @property {string} created_at
 */

/**
 * @typedef {Object} HumanTaskCard
 *   Promoted meeting signal — see PRD meeting-actions-to-kanban §11.2.
 *   Lives on any of the 6 lanes (mapping at the API layer).
 * @property {'human_task'} kind
 * @property {string} id
 * @property {string} title
 * @property {string} status
 *   inbox | proposed | todo | in_progress | blocked | later | review | done
 *   (skipped/not_for_us never reach the board)
 * @property {'urgent'|'high'|'normal'|'low'} priority
 * @property {string | null} task_type
 * @property {string | null} due_date
 * @property {string | null} assignee_contact_id
 * @property {string | null} assignee_label
 * @property {number | null} assignee_confidence
 * @property {string[]} tags
 * @property {string | null} next_action_hint
 * @property {string | null} source_quote
 * @property {{trigger: string, since: string, hint: string} | null} needs_human
 * @property {string} created_at
 * @property {string} updated_at
 */

/**
 * @typedef {ProposalCard | AttentionCard | HumanTaskCard} NeedsYouCard
 */

/**
 * @typedef {WorkItemCard | NeedsYouCard | HumanTaskCard} Card
 */

/**
 * @typedef {Object} BoardData
 * @property {Object} lanes
 * @property {NeedsYouCard[]} [lanes.needs_you]
 * @property {(WorkItemCard | HumanTaskCard)[]} [lanes.created]
 * @property {(WorkItemCard | HumanTaskCard)[]} [lanes.assigned]
 * @property {(WorkItemCard | HumanTaskCard)[]} [lanes.in_progress]
 * @property {(WorkItemCard | HumanTaskCard)[]} [lanes.review]
 * @property {(WorkItemCard | HumanTaskCard)[]} [lanes.completed]
 */

/**
 * @typedef {Object} Lane
 * @property {LaneId} id
 * @property {string} title
 * @property {'human' | 'flow'} emphasis
 * @property {Card[]} cards
 */

// Display order is part of the route contract (ADR-003). Do not reorder.
/** @type {ReadonlyArray<LaneDef>} */
const LANE_DEFS = Object.freeze([
  { id: 'needs_you', title: 'Needs you', emphasis: 'human' },
  { id: 'created', title: 'Created', emphasis: 'flow' },
  { id: 'assigned', title: 'Assigned', emphasis: 'flow' },
  { id: 'in_progress', title: 'In progress', emphasis: 'flow' },
  { id: 'review', title: 'Review', emphasis: 'flow' },
  { id: 'completed', title: 'Completed', emphasis: 'flow' },
]);

/**
 * Pure: does not mutate `data`; cards pass through by reference.
 * Missing or non-array lane buckets are coerced to `[]` so callers can rely
 * on every LaneId being present (ADR-003 stable lane set).
 *
 * @param {BoardData | null | undefined} data
 * @returns {Lane[]}
 */
export function computeLanes(data) {
  const lanes = (data && data.lanes) || {};
  return LANE_DEFS.map((def) => {
    const source = lanes[def.id];
    return {
      id: def.id,
      title: def.title,
      emphasis: def.emphasis,
      cards: Array.isArray(source) ? source.slice() : [],
    };
  });
}
