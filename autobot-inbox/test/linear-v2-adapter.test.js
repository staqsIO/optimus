/**
 * lib/linear/v2-adapter.js — buildLinearClient
 *
 * Contract (PRD §Task 6/7, FR-26):
 *   - createIssue(payload)         → { id, identifier, url }
 *   - fetchIssues({ ids })         → reconciliation row shape
 *   - createWorkflowState(input)   → { id, name, type }
 *   - gql / client(query, vars)    → raw GraphQL data; throws on errors
 *   - missing apiKey throws on construction
 *
 * All tests inject a mock fetch — no network.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildLinearClient } from '../../lib/linear/v2-adapter.js';

// ---------------------------------------------------------------------------
// helpers — minimal fetch double that records calls and replays canned bodies
// ---------------------------------------------------------------------------

function mockFetch(responses) {
  // responses: array of { ok?, status?, body } OR a single object
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const calls = [];
  async function fakeFetch(url, init) {
    const parsed = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ url, init, parsed });
    const r = queue.shift() ?? { ok: true, body: {} };
    return {
      ok: r.ok !== false,
      status: r.status ?? 200,
      async json() { return r.body; },
      async text() { return typeof r.body === 'string' ? r.body : JSON.stringify(r.body); },
    };
  }
  fakeFetch.calls = calls;
  return fakeFetch;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe('buildLinearClient — construction', () => {
  it('throws when apiKey is missing', () => {
    assert.throws(
      () => buildLinearClient({ fetch: mockFetch({ body: { data: {} } }) }),
      /apiKey/i,
    );
  });

  it('throws when apiKey is empty string', () => {
    assert.throws(
      () => buildLinearClient({ apiKey: '', fetch: mockFetch({ body: { data: {} } }) }),
      /apiKey/i,
    );
  });

  it('throws when no fetch is available and no global fetch', () => {
    // We can't easily delete globalThis.fetch in modern node, but we can
    // confirm a non-function injection is rejected.
    assert.throws(
      () => buildLinearClient({ apiKey: 'k', fetch: 'not-a-fn' }),
      /fetch/i,
    );
  });
});

// ---------------------------------------------------------------------------
// gql — raw caller
// ---------------------------------------------------------------------------

describe('gql / client', () => {
  it('POSTs to Linear with Authorization header and JSON body', async () => {
    const fetch = mockFetch({ body: { data: { ping: 'pong' } } });
    const c = buildLinearClient({ apiKey: 'lin_xxx', fetch });
    const data = await c.gql('query Ping { ping }', { x: 1 });

    assert.equal(data.ping, 'pong');
    assert.equal(fetch.calls.length, 1);
    const call = fetch.calls[0];
    assert.equal(call.url, 'https://api.linear.app/graphql');
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.headers.Authorization, 'lin_xxx');
    assert.equal(call.init.headers['Content-Type'], 'application/json');
    assert.deepEqual(call.parsed, {
      query: 'query Ping { ping }',
      variables: { x: 1 },
    });
  });

  it('exposes the same function as `client` (team-cache compatibility)', async () => {
    const fetch = mockFetch({ body: { data: { ok: true } } });
    const c = buildLinearClient({ apiKey: 'k', fetch });
    assert.equal(typeof c.client, 'function');
    const data = await c.client('query X { ok }', {});
    assert.equal(data.ok, true);
  });

  it('throws when the API returns errors[]', async () => {
    const fetch = mockFetch({
      body: { errors: [{ message: 'AUTH_FAILED' }] },
    });
    const c = buildLinearClient({ apiKey: 'k', fetch });
    await assert.rejects(
      () => c.gql('query { me { id } }'),
      /AUTH_FAILED/,
    );
  });

  it('throws when HTTP status is not ok', async () => {
    const fetch = mockFetch({ ok: false, status: 500, body: 'boom' });
    const c = buildLinearClient({ apiKey: 'k', fetch });
    await assert.rejects(
      () => c.gql('query { x }'),
      /500/,
    );
  });
});

// ---------------------------------------------------------------------------
// createIssue
// ---------------------------------------------------------------------------

describe('createIssue', () => {
  it('posts issueCreate mutation with mapped variables and returns issue', async () => {
    const fetch = mockFetch({
      body: {
        data: {
          issueCreate: {
            success: true,
            issue: {
              id: 'iss_1',
              identifier: 'STAQ-42',
              url: 'https://linear.app/staqs/issue/STAQ-42',
            },
          },
        },
      },
    });
    const c = buildLinearClient({ apiKey: 'k', teamId: 'team_default', fetch });

    const out = await c.createIssue({
      title: 'Action: send proposal',
      description: 'body',
      projectId: 'proj_1',
      assigneeId: 'usr_1',
      stateId: 'st_1',
      priority: 2,
      labelIds: ['lbl_1', 'lbl_2'],
      dueDate: '2026-06-01',
    });

    assert.deepEqual(out, {
      id: 'iss_1',
      identifier: 'STAQ-42',
      url: 'https://linear.app/staqs/issue/STAQ-42',
    });

    const sent = fetch.calls[0].parsed;
    assert.match(sent.query, /mutation CreateIssue/);
    assert.match(sent.query, /issueCreate\(input: \$input\)/);
    assert.deepEqual(sent.variables, {
      input: {
        title: 'Action: send proposal',
        teamId: 'team_default',
        description: 'body',
        projectId: 'proj_1',
        assigneeId: 'usr_1',
        stateId: 'st_1',
        priority: 2,
        labelIds: ['lbl_1', 'lbl_2'],
        dueDate: '2026-06-01',
      },
    });
  });

  it('omits optional fields when not provided', async () => {
    const fetch = mockFetch({
      body: {
        data: {
          issueCreate: {
            success: true,
            issue: { id: 'i', identifier: 'X-1', url: 'u' },
          },
        },
      },
    });
    const c = buildLinearClient({ apiKey: 'k', teamId: 't', fetch });
    await c.createIssue({ title: 'only title' });

    const input = fetch.calls[0].parsed.variables.input;
    assert.deepEqual(input, { title: 'only title', teamId: 't' });
  });

  it('throws when title missing', async () => {
    const c = buildLinearClient({ apiKey: 'k', teamId: 't', fetch: mockFetch({}) });
    await assert.rejects(() => c.createIssue({}), /title/);
  });

  it('throws when teamId missing (no default, no payload)', async () => {
    const c = buildLinearClient({ apiKey: 'k', fetch: mockFetch({}) });
    await assert.rejects(() => c.createIssue({ title: 't' }), /teamId/);
  });

  it('throws when API returns success=false', async () => {
    const fetch = mockFetch({
      body: { data: { issueCreate: { success: false, issue: null } } },
    });
    const c = buildLinearClient({ apiKey: 'k', teamId: 't', fetch });
    await assert.rejects(() => c.createIssue({ title: 't' }), /success=false/);
  });
});

// ---------------------------------------------------------------------------
// fetchIssues
// ---------------------------------------------------------------------------

describe('fetchIssues', () => {
  it('posts the filter:{id:{in:[...]}} query and parses rows', async () => {
    const fetch = mockFetch({
      body: {
        data: {
          issues: {
            nodes: [
              {
                id: 'i1',
                title: 'T1',
                description: 'd1',
                priority: 1,
                updatedAt: '2026-05-20T00:00:00Z',
                state:    { id: 's1', name: 'In Progress' },
                assignee: { id: 'u1' },
                project:  { id: 'p1' },
              },
              {
                id: 'i2',
                title: 'T2',
                description: null,
                priority: 0,
                updatedAt: '2026-05-21T00:00:00Z',
                state:    { id: 's2', name: 'Done' },
                assignee: null,
                project:  null,
              },
            ],
          },
        },
      },
    });

    const c = buildLinearClient({ apiKey: 'k', fetch });
    const rows = await c.fetchIssues({ ids: ['i1', 'i2'] });

    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], {
      id: 'i1',
      stateId: 's1',
      stateName: 'In Progress',
      assigneeId: 'u1',
      projectId: 'p1',
      title: 'T1',
      description: 'd1',
      priority: 1,
      updatedAt: '2026-05-20T00:00:00Z',
    });
    assert.deepEqual(rows[1], {
      id: 'i2',
      stateId: 's2',
      stateName: 'Done',
      assigneeId: null,
      projectId: null,
      title: 'T2',
      description: null,
      priority: 0,
      updatedAt: '2026-05-21T00:00:00Z',
    });

    const sent = fetch.calls[0].parsed;
    assert.match(sent.query, /query FetchIssues/);
    assert.match(sent.query, /filter:\s*\{\s*id:\s*\{\s*in:\s*\$ids\s*\}\s*\}/);
    assert.deepEqual(sent.variables, { ids: ['i1', 'i2'] });
  });

  it('short-circuits with no network call for empty ids', async () => {
    const fetch = mockFetch([]);
    const c = buildLinearClient({ apiKey: 'k', fetch });
    const rows = await c.fetchIssues({ ids: [] });
    assert.deepEqual(rows, []);
    assert.equal(fetch.calls.length, 0);
  });

  it('throws when ids is not an array', async () => {
    const c = buildLinearClient({ apiKey: 'k', fetch: mockFetch({}) });
    await assert.rejects(() => c.fetchIssues({}), /ids/);
  });
});

// ---------------------------------------------------------------------------
// createWorkflowState
// ---------------------------------------------------------------------------

describe('createWorkflowState', () => {
  it('posts workflowStateCreate mutation and returns the new state', async () => {
    const fetch = mockFetch({
      body: {
        data: {
          workflowStateCreate: {
            success: true,
            workflowState: {
              id: 'st_new',
              name: 'Ready for Optimus',
              type: 'unstarted',
            },
          },
        },
      },
    });
    const c = buildLinearClient({ apiKey: 'k', teamId: 'team_default', fetch });

    const out = await c.createWorkflowState({
      name: 'Ready for Optimus',
      color: '#5E6AD2',
    });

    assert.deepEqual(out, {
      id: 'st_new',
      name: 'Ready for Optimus',
      type: 'unstarted',
    });

    const sent = fetch.calls[0].parsed;
    assert.match(sent.query, /mutation CreateState/);
    assert.match(sent.query, /workflowStateCreate\(input: \$input\)/);
    assert.deepEqual(sent.variables, {
      input: {
        name: 'Ready for Optimus',
        teamId: 'team_default',
        color: '#5E6AD2',
      },
    });
  });

  it('uses explicit teamId param over adapter default', async () => {
    const fetch = mockFetch({
      body: {
        data: {
          workflowStateCreate: {
            success: true,
            workflowState: { id: 'st', name: 'X', type: 'unstarted' },
          },
        },
      },
    });
    const c = buildLinearClient({ apiKey: 'k', teamId: 'team_default', fetch });
    await c.createWorkflowState({ name: 'X', teamId: 'team_override' });

    const input = fetch.calls[0].parsed.variables.input;
    assert.equal(input.teamId, 'team_override');
  });

  it('throws when name missing', async () => {
    const c = buildLinearClient({ apiKey: 'k', teamId: 't', fetch: mockFetch({}) });
    await assert.rejects(() => c.createWorkflowState({}), /name/);
  });

  it('throws when teamId missing (no default, no param)', async () => {
    const c = buildLinearClient({ apiKey: 'k', fetch: mockFetch({}) });
    await assert.rejects(() => c.createWorkflowState({ name: 'X' }), /teamId/);
  });

  it('throws when API returns success=false', async () => {
    const fetch = mockFetch({
      body: {
        data: { workflowStateCreate: { success: false, workflowState: null } },
      },
    });
    const c = buildLinearClient({ apiKey: 'k', teamId: 't', fetch });
    await assert.rejects(
      () => c.createWorkflowState({ name: 'X' }),
      /success=false/,
    );
  });
});
