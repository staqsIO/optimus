/**
 * Linear GraphQL API client.
 * Thin fetch wrapper — no SDK dependency (P4: boring infrastructure).
 *
 * Requires: LINEAR_API_KEY, LINEAR_TEAM_ID env vars.
 */

import { fetchWithTimeout } from '../../../lib/runtime/fetch-utils.js';

const LINEAR_API = 'https://api.linear.app/graphql';

function getHeaders(token) {
  if (!token) throw new Error('LINEAR_API_KEY not configured');
  return {
    'Content-Type': 'application/json',
    Authorization: token,
  };
}

/**
 * Execute a GraphQL query as the board user (LINEAR_API_KEY).
 */
async function gql(query, variables = {}) {
  const token = process.env.LINEAR_API_KEY;
  if (!token) throw new Error('LINEAR_API_KEY not configured');
  const res = await fetchWithTimeout(LINEAR_API, {
    method: 'POST',
    headers: getHeaders(token),
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Linear API ${res.status}: ${text}`);
  }

  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(`Linear GraphQL error: ${json.errors[0].message}`);
  }
  return json.data;
}

/**
 * Create a Linear issue.
 * @param {Object} params
 * @param {string} params.title
 * @param {string} params.description - Markdown body
 * @param {string} [params.teamId] - Defaults to LINEAR_TEAM_ID env
 * @param {number} [params.priority] - 0=none, 1=urgent, 2=high, 3=medium, 4=low
 * @param {string[]} [params.labelIds] - Linear label UUIDs
 * @returns {Promise<{id: string, identifier: string, url: string, title: string}>}
 */
export async function createIssue({ title, description, teamId, priority, labelIds }) {
  const team = teamId || process.env.LINEAR_TEAM_ID;
  if (!team) throw new Error('LINEAR_TEAM_ID not configured');

  const input = {
    title,
    description,
    teamId: team,
  };
  if (priority != null) input.priority = priority;
  if (labelIds?.length) input.labelIds = labelIds;

  const data = await gql(
    `mutation CreateIssue($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue {
          id
          identifier
          url
          title
        }
      }
    }`,
    { input }
  );

  if (!data.issueCreate.success) {
    throw new Error('Linear issue creation failed');
  }
  return data.issueCreate.issue;
}

/**
 * Fetch full issue details by ID.
 * Used by Linear webhook ingest to get the full issue body (webhook payloads are sparse).
 * @param {string} issueId - Linear issue UUID
 * @returns {Promise<Object>} Full issue with state, labels, team, project
 */
export async function getIssue(issueId) {
  const data = await gql(
    `query GetIssue($id: String!) {
      issue(id: $id) {
        id identifier url title description priority dueDate
        state { id name type }
        assignee { id name }
        delegate { id name }
        labels { nodes { id name } }
        team { id name key }
        project { id name }
      }
    }`,
    { id: issueId }
  );
  return data.issue;
}

/**
 * Update an issue's workflow state.
 * @param {string} issueId - Linear issue UUID
 * @param {string} stateId - Target workflow state UUID
 */
export async function updateIssueState(issueId, stateId) {
  const data = await gql(
    `mutation UpdateState($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) {
        success
        issue { id state { id name } }
      }
    }`,
    { id: issueId, input: { stateId } }
  );
  return data.issueUpdate;
}

/**
 * Update an issue's workflow state by name (team-aware).
 * Looks up the correct state UUID for the issue's team, avoiding cross-team state mismatches.
 * Falls back to updateIssueState with hardcoded ID if lookup fails.
 * @param {string} issueId - Linear issue UUID
 * @param {string} stateName - State name to match (e.g. "In Development", "Internal Review")
 * @param {string} [fallbackStateId] - Optional fallback state UUID if lookup fails
 */
export async function updateIssueStateByName(issueId, stateName, fallbackStateId) {
  try {
    const data = await gql(
      `query GetIssueTeamStates($id: String!) {
        issue(id: $id) {
          team { states { nodes { id name } } }
        }
      }`,
      { id: issueId }
    );
    const states = data.issue?.team?.states?.nodes || [];
    const match = states.find(s => s.name.toLowerCase() === stateName.toLowerCase());
    if (match) {
      return updateIssueState(issueId, match.id);
    }
    console.warn(`[linear] State "${stateName}" not found for issue ${issueId}'s team`);
  } catch (err) {
    console.warn(`[linear] State lookup failed for ${issueId}: ${err.message}`);
  }
  if (fallbackStateId) {
    return updateIssueState(issueId, fallbackStateId);
  }
  return null;
}

/**
 * Add a comment to an issue (e.g. PR link after executor-coder completes).
 * @param {string} issueId - Linear issue UUID
 * @param {string} body - Markdown comment body
 */
export async function addComment(issueId, body) {
  const data = await gql(
    `mutation AddComment($input: CommentCreateInput!) {
      commentCreate(input: $input) {
        success
        comment { id }
      }
    }`,
    { input: { issueId, body } }
  );
  return data.commentCreate;
}

/**
 * Post a comment as the Jamie Bot application.
 * Falls back to addComment (board user) if LINEAR_BOT_TOKEN is not set.
 * @param {string} issueId - Linear issue UUID
 * @param {string} body - Markdown comment body
 */
export async function addBotComment(issueId, body) {
  const botToken = process.env.LINEAR_BOT_TOKEN;
  if (!botToken) {
    console.warn('[linear] LINEAR_BOT_TOKEN not set — falling back to board user for comment');
    return addComment(issueId, body);
  }
  try {
    const res = await fetch(LINEAR_API, {
      method: 'POST',
      headers: getHeaders(botToken),
      body: JSON.stringify({
        query: `mutation AddComment($input: CommentCreateInput!) {
          commentCreate(input: $input) { success comment { id } }
        }`,
        variables: { input: { issueId, body } },
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Linear API ${res.status}: ${text}`);
    }
    const json = await res.json();
    if (json.errors?.length) {
      throw new Error(`Linear GQL error: ${json.errors[0].message}`);
    }
    return json.data.commentCreate;
  } catch (err) {
    console.warn(`[linear] Bot token failed (${err.message}) — falling back to board user`);
    return addComment(issueId, body);
  }
}

/**
 * Fetch recent comments on an issue for conversation context.
 * Used by the /reply command to build conversation history.
 * @param {string} issueId - Linear issue UUID
 * @param {number} [first=10] - Number of comments to fetch (most recent)
 * @returns {Promise<Array<{id: string, body: string, createdAt: string, userName: string}>>}
 */
export async function getIssueComments(issueId, first = 10) {
  const data = await gql(
    `query GetComments($id: String!) {
      issue(id: $id) {
        comments(first: 50) {
          nodes {
            id
            body
            createdAt
            user { name }
          }
        }
      }
    }`,
    { id: issueId }
  );

  const comments = (data.issue?.comments?.nodes || [])
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    .slice(-first);

  return comments.map(c => ({
    id: c.id,
    body: c.body,
    createdAt: c.createdAt,
    userName: c.user?.name || 'Unknown',
  }));
}

/**
 * Find a label by name, or create it if it doesn't exist.
 * Self-healing: works even if the label is deleted and recreated.
 * @param {string} name - Label name (e.g., "auto-fix")
 * @param {string} [teamId] - Team ID (defaults to LINEAR_TEAM_ID)
 * @returns {Promise<string>} Label UUID
 */
export async function getOrCreateLabel(name, teamId) {
  const team = teamId || process.env.LINEAR_TEAM_ID;
  if (!team) throw new Error('LINEAR_TEAM_ID not configured');

  // Try to find existing label
  const data = await gql(
    `query FindLabel($name: String!) {
      issueLabels(filter: { name: { eq: $name } }) {
        nodes { id name }
      }
    }`,
    { name }
  );

  if (data.issueLabels.nodes.length > 0) {
    return data.issueLabels.nodes[0].id;
  }

  // Create if not found
  const createData = await gql(
    `mutation CreateLabel($input: IssueLabelCreateInput!) {
      issueLabelCreate(input: $input) {
        success
        issueLabel { id name }
      }
    }`,
    { input: { name, teamId: team } }
  );

  if (!createData.issueLabelCreate.success) {
    throw new Error(`Failed to create label "${name}"`);
  }
  return createData.issueLabelCreate.issueLabel.id;
}

/**
 * List teams (for setup/validation).
 * @returns {Promise<Array<{id: string, name: string, key: string}>>}
 */
export async function getTeams() {
  const data = await gql(`query { teams { nodes { id name key } } }`);
  return data.teams.nodes;
}

/**
 * List unassigned, non-completed issues for a team.
 * Used by the issue-triage agent to find work.
 *
 * @param {string} teamKey - Team key (e.g., "STAQPRO")
 * @param {number} [limit=20] - Max issues to return
 * @returns {Promise<Array>}
 */
export async function listUnassignedIssues(teamKey, limit = 20) {
  const data = await gql(`
    query UntriagedIssues($teamKey: String!, $first: Int!) {
      issues(
        filter: {
          team: { key: { eq: $teamKey } }
          assignee: { null: true }
          state: { type: { nin: ["completed", "canceled"] } }
        }
        first: $first
        orderBy: createdAt
      ) {
        nodes {
          id identifier url title description priority
          state { id name type }
          labels { nodes { id name } }
          team { id name key }
          project { id name }
          createdAt
        }
      }
    }
  `, { teamKey, first: limit });
  return data.issues?.nodes || [];
}

/**
 * List ALL open issues for a team, ONE page at a time (cursor pagination).
 * STAQPRO-619-A backfill: the caller drives the loop and inserts each page,
 * so a large team never materializes the whole result set in memory and the
 * backfill stays batched (no 602-style storm). Filters out terminal states by
 * default (full mirror of every NON-archived OPEN issue incl. Backlog).
 *
 * Keyed by team UUID (`teamId`) — not key — to match linear_sync_teams.team_id.
 *
 * @param {string} teamId - Linear team UUID (linear_sync_teams.team_id)
 * @param {Object} [opts]
 * @param {boolean} [opts.includeArchived=false] - include archived issues
 * @param {string|null} [opts.after=null] - endCursor from the previous page
 * @param {number} [opts.first=50] - page size (Linear caps at 250)
 * @returns {Promise<{ nodes: Array, pageInfo: { hasNextPage: boolean, endCursor: string|null } }>}
 */
export async function listTeamIssues(teamId, { includeArchived = false, after = null, first = 50 } = {}) {
  if (!teamId) throw new Error('listTeamIssues: teamId required');
  const pageSize = Math.min(Math.max(Number(first) || 50, 1), 250);
  const data = await gql(`
    query TeamOpenIssues($teamId: ID!, $first: Int!, $after: String, $includeArchived: Boolean) {
      issues(
        filter: {
          team: { id: { eq: $teamId } }
          state: { type: { nin: ["completed", "canceled"] } }
        }
        first: $first
        after: $after
        includeArchived: $includeArchived
        orderBy: createdAt
      ) {
        nodes {
          id identifier url title description priority dueDate
          state { id name type }
          assignee { id name }
          team { id name key }
          project { id name }
          createdAt
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `, { teamId, first: pageSize, after, includeArchived });
  return {
    nodes: data.issues?.nodes || [],
    pageInfo: data.issues?.pageInfo || { hasNextPage: false, endCursor: null },
  };
}
