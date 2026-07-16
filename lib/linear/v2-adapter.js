/**
 * Linear v0.2 client adapter.
 *
 * PRD: autobot-inbox/docs/internal/prds/meeting-actions-to-kanban-v0.2-tech-spec.md
 *      (Task 6/7 — v0.2 workers expect an injected client surface)
 *
 * Org-level (lives in lib/) because multiple products and workers — push,
 * reconciliation, team-cache refresher, one-click state creation — all
 * consume the same surface. No SDK import, fetch is injectable, no env
 * read on construction (callers pass apiKey + teamId explicitly so tests
 * never leak prod tokens).
 *
 * Surface (per Task 7):
 *   - createIssue(payload) → { id, identifier, url }
 *   - fetchIssues({ ids }) → [{ id, stateId, stateName, assigneeId,
 *       projectId, title, description, priority, updatedAt }, ...]
 *   - createWorkflowState({ name, color, teamId }) → { id, name, type }
 *   - gql(query, variables) → raw GraphQL data (also exposed as `client`
 *     so team-cache.refreshCache can call client(query, vars) directly)
 *
 * P2 — auth, transport, and error handling are infrastructure; agents
 *      never compose GraphQL strings themselves.
 * P4 — built-in fetch, no SDK, no exotic deps.
 */

const LINEAR_API = 'https://api.linear.app/graphql';

/**
 * Build a Linear client adapter bound to one API key + (default) team.
 *
 * @param {Object}   opts
 * @param {string}   opts.apiKey   — Linear personal/bot API token (required)
 * @param {string}   [opts.teamId] — Default team UUID for issue/state creation
 * @param {Function} [opts.fetch]  — Injectable fetch (defaults to globalThis.fetch)
 * @returns {{
 *   createIssue: Function,
 *   fetchIssues: Function,
 *   createWorkflowState: Function,
 *   gql: Function,
 *   client: Function,
 * }}
 */
export function buildLinearClient({ apiKey, teamId, fetch: fetchImpl } = {}) {
  if (!apiKey || typeof apiKey !== 'string') {
    throw new Error('buildLinearClient requires { apiKey }');
  }

  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new Error('buildLinearClient requires a fetch implementation');
  }

  const defaultTeamId = teamId || null;

  // -------------------------------------------------------------------------
  // gql — raw GraphQL POST. Also exposed as `client` for team-cache.
  // -------------------------------------------------------------------------
  async function gql(query, variables = {}) {
    const res = await doFetch(LINEAR_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: apiKey,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!res.ok) {
      const text = typeof res.text === 'function' ? await res.text() : '';
      throw new Error(`Linear API ${res.status}: ${text}`);
    }

    const json = await res.json();
    if (Array.isArray(json.errors) && json.errors.length > 0) {
      throw new Error(`Linear GraphQL error: ${json.errors[0].message}`);
    }
    return json.data;
  }

  // -------------------------------------------------------------------------
  // createIssue — wraps issueCreate.
  // -------------------------------------------------------------------------
  async function createIssue(payload = {}) {
    const {
      title,
      description,
      projectId,
      assigneeId,
      stateId,
      priority,
      labelIds,
      dueDate,
      teamId: payloadTeamId,
    } = payload;

    if (!title || typeof title !== 'string') {
      throw new Error('createIssue requires { title }');
    }
    const team = payloadTeamId || defaultTeamId;
    if (!team) {
      throw new Error('createIssue requires teamId (payload or adapter default)');
    }

    const input = { title, teamId: team };
    if (description != null) input.description = description;
    if (projectId)  input.projectId  = projectId;
    if (assigneeId) input.assigneeId = assigneeId;
    if (stateId)    input.stateId    = stateId;
    if (priority != null) input.priority = priority;
    if (Array.isArray(labelIds) && labelIds.length > 0) input.labelIds = labelIds;
    if (dueDate) input.dueDate = dueDate;

    const data = await gql(
      `mutation CreateIssue($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue { id identifier url }
        }
      }`,
      { input },
    );

    if (!data?.issueCreate?.success) {
      throw new Error('Linear issueCreate returned success=false');
    }
    const issue = data.issueCreate.issue;
    return { id: issue.id, identifier: issue.identifier, url: issue.url };
  }

  // -------------------------------------------------------------------------
  // fetchIssues — bulk read for reconciliation.
  // Linear's `issues(filter: {id: {in: [...]}})` accepts up to 250 in a
  // single page by default; we set first:500 to be generous and let the
  // caller chunk if needed.
  // -------------------------------------------------------------------------
  async function fetchIssues({ ids } = {}) {
    if (!Array.isArray(ids)) {
      throw new Error('fetchIssues requires { ids: string[] }');
    }
    if (ids.length === 0) return [];

    const data = await gql(
      `query FetchIssues($ids: [ID!]!) {
        issues(filter: { id: { in: $ids } }, first: 500) {
          nodes {
            id
            title
            description
            priority
            updatedAt
            state    { id name }
            assignee { id }
            project  { id }
          }
        }
      }`,
      { ids },
    );

    const nodes = data?.issues?.nodes || [];
    return nodes.map((n) => ({
      id:          n.id,
      stateId:     n.state?.id    ?? null,
      stateName:   n.state?.name  ?? null,
      assigneeId:  n.assignee?.id ?? null,
      projectId:   n.project?.id  ?? null,
      title:       n.title        ?? null,
      description: n.description  ?? null,
      priority:    n.priority     ?? null,
      updatedAt:   n.updatedAt    ?? null,
    }));
  }

  // -------------------------------------------------------------------------
  // createWorkflowState — one-click "Create Ready for Optimus state" (FR-26).
  // -------------------------------------------------------------------------
  async function createWorkflowState({ name, color, teamId: stateTeamId } = {}) {
    if (!name || typeof name !== 'string') {
      throw new Error('createWorkflowState requires { name }');
    }
    const team = stateTeamId || defaultTeamId;
    if (!team) {
      throw new Error('createWorkflowState requires teamId (param or adapter default)');
    }

    const input = { name, teamId: team };
    if (color) input.color = color;

    const data = await gql(
      `mutation CreateState($input: WorkflowStateCreateInput!) {
        workflowStateCreate(input: $input) {
          success
          workflowState { id name type }
        }
      }`,
      { input },
    );

    if (!data?.workflowStateCreate?.success) {
      throw new Error('Linear workflowStateCreate returned success=false');
    }
    const state = data.workflowStateCreate.workflowState;
    return { id: state.id, name: state.name, type: state.type };
  }

  return {
    createIssue,
    fetchIssues,
    createWorkflowState,
    gql,
    // team-cache.refreshCache expects a callable client(query, variables).
    // Expose the same function under both names so consumers can pick either.
    client: gql,
  };
}
