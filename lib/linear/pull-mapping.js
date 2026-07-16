/**
 * Pure-function mapper: Linear webhook payload → human_tasks UPDATE patch.
 *
 * PRD: autobot-inbox/docs/internal/prds/meeting-actions-to-kanban-v0.2-tech-spec.md
 *      FR-13 (pull), FR-17 (state→status), FR-18 (priority), FR-19 (terminal),
 *      NFR-4 (defensive).
 *
 * Contract:
 *   mapLinearEventToPatch({ payload, mappingFromGuardrail })
 *     → { patch: object, status_changed: boolean, terminal: boolean }
 *
 * The guardrail mapping is { [linearStateId]: human_tasks.status }.
 *
 * - Pure: no I/O, no DB, no Linear API. Only console.warn for unmapped
 *   state ids (per FR-17 observability requirement).
 * - Defensive: null/undefined/no-data payloads return an empty patch.
 * - Append-only friendly: patch is a flat object the caller can splat into
 *   a parameterised UPDATE.
 */

const LINEAR_PRIORITY_TO_PATCH = {
  1: 'urgent',
  2: 'high',
  3: 'normal',
  4: 'low',
};

const TERMINAL_STATUSES = new Set(['done', 'not_for_us']);

/**
 * Translate a Linear webhook payload into a flat patch for inbox.human_tasks.
 *
 * @param {{ payload: object|null|undefined, mappingFromGuardrail: Record<string,string>|null|undefined }} args
 * @returns {{ patch: Record<string, unknown>, status_changed: boolean, terminal: boolean }}
 */
export function mapLinearEventToPatch({ payload, mappingFromGuardrail } = {}) {
  const empty = { patch: {}, status_changed: false, terminal: false };

  if (!payload || typeof payload !== 'object') return empty;
  const { action, type, data } = payload;
  if (!data || typeof data !== 'object') return empty;

  // Comment events never mutate the human_tasks row through the pull mapper.
  if (type === 'Comment') return empty;

  const mapping = (mappingFromGuardrail && typeof mappingFromGuardrail === 'object')
    ? mappingFromGuardrail
    : {};

  const nowIso = new Date().toISOString();

  // ---- Issue remove → terminal not_for_us ---------------------------------
  if (action === 'remove') {
    return {
      patch: {
        status: 'not_for_us',
        linear_last_event_at: nowIso,
      },
      status_changed: true,
      terminal: true,
    };
  }

  // ---- Issue create/update -----------------------------------------------
  // We treat anything that is not 'Comment' / 'remove' as an Issue event.
  // (Linear sends 'Issue' for create/update; create may not carry updatedFrom.)
  const patch = { linear_last_event_at: nowIso };
  let statusChanged = false;
  let terminal = false;

  // -- State change → status (via guardrail mapping)
  const stateObj = data.state && typeof data.state === 'object' ? data.state : null;
  const newStateId = stateObj?.id ?? data.stateId ?? null;
  if (newStateId) {
    patch.linear_state_id = newStateId;
    if (stateObj?.name) patch.linear_state_name = stateObj.name;

    if (Object.prototype.hasOwnProperty.call(mapping, newStateId)) {
      const mappedStatus = mapping[newStateId];
      patch.status = mappedStatus;
      statusChanged = true;
      if (TERMINAL_STATUSES.has(mappedStatus)) terminal = true;
    } else {
      // FR-17: surface the unmapped id but DO NOT set status.
      console.warn(
        `[linear-pull-mapping] state id "${newStateId}" not in guardrail mapping; status omitted from patch`
      );
    }
  }

  // -- Assignee
  if (data.assigneeId !== undefined && data.assigneeId !== null) {
    patch.linear_assignee_id = data.assigneeId;
  }

  // -- Project
  if (data.projectId !== undefined && data.projectId !== null) {
    patch.linear_project_id = data.projectId;
  }

  // -- Title
  if (typeof data.title === 'string') {
    patch.title = data.title;
  }

  // -- Description
  if (typeof data.description === 'string') {
    patch.description = data.description;
  }

  // -- Priority (Linear 1..4 → urgent/high/normal/low; 0 omitted)
  if (typeof data.priority === 'number') {
    const mappedPriority = LINEAR_PRIORITY_TO_PATCH[data.priority];
    if (mappedPriority) patch.priority = mappedPriority;
  }

  return { patch, status_changed: statusChanged, terminal };
}
