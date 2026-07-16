/**
 * /api/linear/* endpoints — v0.2 tech-spec §4.1.
 *
 *   POST /api/linear/reconcile           — FR-16 manual reconcile trigger
 *   GET  /api/linear/team-cache          — FR-24 read cached metadata
 *   POST /api/linear/team-cache/refresh  — FR-24 force-refresh
 *   POST /api/linear/workflow-states     — FR-26 create one-click Ready-for-Optimus
 *
 * Each endpoint: one happy-path test + one negative (auth) test.
 * Linear client + teamId are injected via getContext per the factory pattern.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';
import {
  makeReconcileLinear,
  makeGetTeamCache,
  makeRefreshTeamCache,
  makeCreateWorkflowState,
} from '../src/api-routes/linear.js';

const BOARD = {
  role: 'board',
  sub: 'isaias',
  github_username: 'cboone',
  scope: ['*'],
};

function boardReq(url, extra = {}) {
  return { url, headers: {}, auth: BOARD, ...extra };
}

function publicReq(url) {
  return { url, headers: {} };
}

const TEAM_ID = 'team-v2-linear-api';

describe('POST /api/linear/reconcile (FR-16)', () => {
  let query;

  before(async () => {
    ({ query } = await getDb());
    await query(`DELETE FROM inbox.human_tasks WHERE id LIKE 'htm-recon-api-%'`);
  });

  it('runs a reconciliation pass and returns processed/divergent counts', async () => {
    const fakeLinearClient = {
      async fetchIssues({ ids }) {
        assert.ok(Array.isArray(ids), 'ids forwarded to client');
        return [];
      },
    };
    const handler = makeReconcileLinear({
      getContext: () => ({ query, linearClient: fakeLinearClient, teamId: TEAM_ID }),
    });
    const res = await handler(boardReq('/api/linear/reconcile'), {});
    assert.equal(res.ok, true);
    assert.equal(typeof res.processed_count, 'number');
    assert.equal(typeof res.divergent_count, 'number');
  });

  it('rejects unauthenticated callers (403)', async () => {
    const handler = makeReconcileLinear({
      getContext: () => ({ query, linearClient: { fetchIssues: async () => [] }, teamId: TEAM_ID }),
    });
    await assert.rejects(
      () => handler(publicReq('/api/linear/reconcile'), {}),
      /board|403/i,
    );
  });
});

describe('GET /api/linear/team-cache (FR-24)', () => {
  let query;

  before(async () => {
    ({ query } = await getDb());
    await query(`DELETE FROM inbox.linear_team_cache WHERE team_id = $1`, [TEAM_ID]);
    await query(
      `INSERT INTO inbox.linear_team_cache
         (team_id, workflow_states, projects, members, labels)
       VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb)`,
      [
        TEAM_ID,
        JSON.stringify([{ id: 's-1', name: 'Todo', type: 'unstarted' }]),
        JSON.stringify([{ id: 'p-1', name: 'Phase 1' }]),
        JSON.stringify([{ id: 'u-1', name: 'Eric' }]),
        JSON.stringify([{ id: 'l-1', name: 'optimus' }]),
      ],
    );
  });

  it('returns the cached metadata payload', async () => {
    const handler = makeGetTeamCache({
      getContext: () => ({ query, teamId: TEAM_ID }),
    });
    const res = await handler(boardReq('/api/linear/team-cache'));
    assert.equal(res.workflow_states[0].name, 'Todo');
    assert.equal(res.projects[0].name, 'Phase 1');
    assert.equal(res.members[0].name, 'Eric');
    assert.equal(res.labels[0].name, 'optimus');
    assert.ok(res.refreshed_at, 'refreshed_at timestamp present');
  });

  it('returns 404 when no cache row for the team', async () => {
    const handler = makeGetTeamCache({
      getContext: () => ({ query, teamId: 'team-not-here' }),
    });
    await assert.rejects(
      () => handler(boardReq('/api/linear/team-cache')),
      /not.found|404|populated/i,
    );
  });
});

describe('POST /api/linear/team-cache/refresh (FR-24)', () => {
  let query;

  before(async () => {
    ({ query } = await getDb());
    await query(`DELETE FROM inbox.linear_team_cache WHERE team_id = $1`, [TEAM_ID]);
  });

  it('refreshes the cache via the injected client and returns the new payload', async () => {
    const linearGqlClient = async (_gqlQuery, vars) => {
      assert.equal(vars.teamId, TEAM_ID);
      return {
        team: {
          id: TEAM_ID,
          states:   { nodes: [{ id: 's-2', name: 'Done', type: 'completed' }] },
          projects: { nodes: [] },
          members:  { nodes: [] },
          labels:   { nodes: [{ id: 'l-2', name: 'urgent' }] },
        },
      };
    };
    const handler = makeRefreshTeamCache({
      getContext: () => ({ query, linearClient: linearGqlClient, teamId: TEAM_ID }),
    });
    const res = await handler(boardReq('/api/linear/team-cache/refresh'), {});
    assert.equal(res.workflow_states[0].name, 'Done');
    assert.equal(res.labels[0].name, 'urgent');
    assert.ok(res.refreshed_at);
  });

  it('returns 412 when LINEAR_TEAM_ID is missing', async () => {
    const handler = makeRefreshTeamCache({
      getContext: () => ({ query, linearClient: async () => ({}), teamId: null }),
    });
    await assert.rejects(
      () => handler(boardReq('/api/linear/team-cache/refresh'), {}),
      /LINEAR_TEAM_ID|configured|412/i,
    );
  });
});

describe('POST /api/linear/workflow-states (FR-26)', () => {
  let query;

  before(async () => {
    ({ query } = await getDb());
    await query(`DELETE FROM inbox.linear_team_cache WHERE team_id = $1`, [TEAM_ID]);
  });

  it('creates a workflow state in Linear and returns it', async () => {
    let createCalls = 0;
    const fakeClient = {
      async createWorkflowState({ name, color, teamId }) {
        createCalls += 1;
        assert.equal(name, 'Ready for Optimus');
        assert.equal(color, '#8b5cf6');
        assert.equal(teamId, TEAM_ID);
        return { id: 'st-new', name, color, teamId };
      },
      // refreshCache will skip when linearClient isn't a function.
    };
    const handler = makeCreateWorkflowState({
      getContext: () => ({ query, linearClient: fakeClient, teamId: TEAM_ID }),
    });
    const res = await handler(
      boardReq('/api/linear/workflow-states'),
      { name: 'Ready for Optimus', color: '#8b5cf6' },
    );
    assert.equal(res.ok, true);
    assert.equal(res.state.id, 'st-new');
    assert.equal(res.state.name, 'Ready for Optimus');
    assert.equal(createCalls, 1);
  });

  it('rejects missing/empty name (400)', async () => {
    const fakeClient = {
      async createWorkflowState() { return { id: 'never' }; },
    };
    const handler = makeCreateWorkflowState({
      getContext: () => ({ query, linearClient: fakeClient, teamId: TEAM_ID }),
    });
    await assert.rejects(
      () => handler(boardReq('/api/linear/workflow-states'), { name: '   ' }),
      /name|400/i,
    );
  });
});
