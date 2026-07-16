/**
 * Bucket + serialize inbox.human_tasks for /api/board.
 *
 * PRD: docs/internal/prds/meeting-actions-to-kanban.md §11.2
 *
 * The lane contract from ADR-003 is fixed at 6 ids. Human-task statuses
 * map onto those ids; the kind discriminator (`human_task`) drives the
 * visual identification on the board.
 *
 * Kept in its own module so the unit-level integration test can exercise
 * the mapping without dragging the rest of src/api.js (which has a heavy
 * import graph) into the test.
 */

import { computeNeedsHuman } from '../human-task-needs-human.js';

const BUCKET_HUMAN_TASK_LOW_CONF = 0.5;

/**
 * Map a human_tasks row to a board lane id, or null if filtered out.
 * @param {Object} row
 * @returns {'needs_you'|'created'|'assigned'|'in_progress'|'review'|'completed'|null}
 */
export function bucketHumanTask(row) {
  if (!row) return null;
  if (row.status === 'skipped' || row.status === 'not_for_us') return null;

  if (row.status === 'inbox') {
    const needsAttn = !row.assignee_contact_id
      || (typeof row.extraction_confidence === 'number'
          && row.extraction_confidence < BUCKET_HUMAN_TASK_LOW_CONF);
    return needsAttn ? 'needs_you' : 'created';
  }
  if (row.status === 'proposed') return 'needs_you';
  if (row.status === 'todo' || row.status === 'later') return 'assigned';
  if (row.status === 'in_progress' || row.status === 'blocked') return 'in_progress';
  if (row.status === 'review') return 'review';
  if (row.status === 'done') return 'completed';
  return null;
}

/**
 * Serialize a row to the kind='human_task' card shape.
 * @param {Object} row
 * @param {Date} [now=new Date()]
 */
export function toHumanTaskCard(row, now = new Date()) {
  return {
    kind: 'human_task',
    id: row.id,
    title: row.title,
    status: row.status,
    priority: row.priority,
    size: row.size,
    task_type: row.task_type,
    due_date: row.due_date,
    snoozed_until: row.snoozed_until,
    assignee_contact_id: row.assignee_contact_id,
    assignee_label: row.assignee_label,
    assignee_confidence: row.assignee_confidence == null ? null : Number(row.assignee_confidence),
    project_id: row.project_id,
    engagement_id: row.engagement_id,
    tags: row.tags || [],
    next_action_hint: row.next_action_hint,
    source_quote: row.source_quote,
    signal_id: row.signal_id,
    message_id: row.message_id,
    relevance_score: row.relevance_score == null ? null : Number(row.relevance_score),
    extraction_confidence: row.extraction_confidence == null ? null : Number(row.extraction_confidence),
    last_feedback: row.last_feedback,
    created_at: row.created_at,
    updated_at: row.updated_at,
    needs_human: computeNeedsHuman(row, now),
  };
}

/**
 * Given the existing emptyBoardLanes result + an array of human_tasks
 * rows, mutate the lanes object to include human_task cards on the
 * correct lanes.
 *
 * @param {Object} lanes - in/out — mutated
 * @param {Object[]} rows
 * @param {Date} [now]
 */
export function appendHumanTasksToLanes(lanes, rows, now = new Date()) {
  for (const row of rows || []) {
    const lane = bucketHumanTask(row);
    if (lane && lanes[lane]) {
      lanes[lane].push(toHumanTaskCard(row, now));
    }
  }
}
