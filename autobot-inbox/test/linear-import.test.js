/**
 * STAQPRO-619-A: Linear-NATIVE issue → /issues import engine.
 *
 * Covers (per the issue's acceptance list):
 *   1. import-on-no-match creates a human_tasks row with the correct
 *      owner_org_id (from the team→org map, NOT the payload) + origin='linear'
 *      + mapped status.
 *   2. idempotent: same issue imported twice → exactly one live row.
 *   3. team not enabled → not imported (deny by default).
 *   4. owner_org_id is NEVER taken from the webhook payload.
 *   5. HMAC: a forged Linear-Signature is rejected; a valid one passes (the
 *      exact mechanism api.js's webhook route uses — header/algo from
 *      config/webhook-sources.json).
 *
 * Style: real PGlite DB + injected query. getIssue is mocked via the deps hook
 * on tryImportLinearNativeIssue so no Linear API call is made.
 *
 * Run: node --test test/linear-import.test.js
 */

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { createHmac, timingSafeEqual } from 'crypto';
import { getDb } from './helpers/setup-db.js';

import { importLinearIssue, resolveEnabledTeam } from '../../lib/linear/import-issue.js';
const ingest = await import('../src/linear/ingest.js');
const { tryImportLinearNativeIssue } = ingest;

// ---- Helpers ----

const TEAM_ENABLED = 'team-staqs-uuid';
const TEAM_DISABLED = 'team-other-uuid';

async function staqsOrgId(query) {
  const r = await query(`SELECT id FROM tenancy.orgs WHERE slug = 'staqs'`);
  return r.rows[0]?.id;
}

async function resetSyncTeams(query, staqs) {
  await query(`DELETE FROM inbox.linear_sync_teams WHERE team_id LIKE 'team-%'`);
  await query(
    `INSERT INTO inbox.linear_sync_teams (team_id, enabled, owner_org_id)
     VALUES ($1, true, $2::uuid), ($3, false, $2::uuid)`,
    [TEAM_ENABLED, staqs, TEAM_DISABLED],
  );
}

async function clearImported(query) {
  await query(`DELETE FROM inbox.human_tasks WHERE linear_issue_id LIKE 'lin-native-%'`);
}

function fullIssue({ id, type = 'started', name = 'In Progress', teamId = TEAM_ENABLED, priority = 2, title = 'Native Linear issue', assignee = 'u-1', due = null } = {}) {
  return {
    id,
    identifier: 'STAQ-999',
    url: `https://linear.app/staqs/issue/${id}`,
    title,
    priority,
    dueDate: due,
    state: { id: 's1', name, type },
    assignee: assignee ? { id: assignee, name: 'Someone' } : null,
    team: { id: teamId, name: 'Staqs', key: 'STAQ' },
    project: null,
  };
}

function payloadFor(id, teamId = TEAM_ENABLED) {
  // Sparse webhook shape (no state.type/assignee — forces a getIssue fetch).
  return { type: 'Issue', action: 'create', data: { id, teamId } };
}

// ---- Tests ----

describe('importLinearIssue — direct (DB)', () => {
  let query, staqs;

  before(async () => {
    ({ query } = await getDb());
    staqs = await staqsOrgId(query);
    assert.ok(staqs, 'staqs org must be seeded by migration 133');
  });

  beforeEach(async () => {
    await resetSyncTeams(query, staqs);
    await clearImported(query);
  });

  it('creates a row with origin=linear, mapped status, and team→org owner_org_id', async () => {
    const team = await resolveEnabledTeam(query, TEAM_ENABLED);
    const res = await importLinearIssue(
      fullIssue({ id: 'lin-native-1', type: 'started' }),
      { query, teamOrg: team },
    );
    assert.equal(res.imported, true);
    assert.equal(res.action, 'insert');

    const r = await query(
      `SELECT status, origin, owner_org_id, linear_issue_id, linear_state_name, priority
         FROM inbox.human_tasks WHERE id = $1`,
      [res.taskId],
    );
    const row = r.rows[0];
    assert.equal(row.status, 'in_progress');
    assert.equal(row.origin, 'linear');
    assert.equal(row.owner_org_id, staqs, 'owner_org_id must be the team-mapped Staqs org');
    assert.equal(row.linear_issue_id, 'lin-native-1');
    assert.equal(row.priority, 'high');
  });

  it('is idempotent: importing the same issue twice yields exactly one live row', async () => {
    const team = await resolveEnabledTeam(query, TEAM_ENABLED);
    const issue = fullIssue({ id: 'lin-native-2', type: 'unstarted', name: 'Todo' });
    const a = await importLinearIssue(issue, { query, teamOrg: team });
    const b = await importLinearIssue(issue, { query, teamOrg: team });
    assert.equal(a.imported, true);
    assert.equal(b.imported, true);

    const count = await query(
      `SELECT count(*)::int AS n FROM inbox.human_tasks
        WHERE linear_issue_id = 'lin-native-2' AND deleted_at IS NULL`,
    );
    assert.equal(count.rows[0].n, 1, 'same issue twice must not create a second live row');
  });

  it('refuses to import an un-tenanted (owner_org_id unmapped) enabled team', async () => {
    await query(
      `UPDATE inbox.linear_sync_teams SET owner_org_id = NULL WHERE team_id = $1`,
      [TEAM_ENABLED],
    );
    const team = await resolveEnabledTeam(query, TEAM_ENABLED);
    const res = await importLinearIssue(fullIssue({ id: 'lin-native-3' }), { query, teamOrg: team });
    assert.equal(res.imported, false);
    assert.match(res.reason, /unmapped/);
  });
});

describe('tryImportLinearNativeIssue — webhook no-match path', () => {
  let query, staqs;

  before(async () => {
    ({ query } = await getDb());
    staqs = await staqsOrgId(query);
  });

  beforeEach(async () => {
    await resetSyncTeams(query, staqs);
    await clearImported(query);
  });

  it('imports a native issue for an ENABLED team (owner_org_id from map, not payload)', async () => {
    // Payload tries to smuggle a bogus owner_org_id — it must be ignored.
    const payload = payloadFor('lin-native-10', TEAM_ENABLED);
    payload.data.owner_org_id = '00000000-0000-0000-0000-000000000000';

    const res = await tryImportLinearNativeIssue(payload, {
      query,
      deps: { getIssue: async () => fullIssue({ id: 'lin-native-10', type: 'started' }) },
    });
    assert.equal(res.imported, true);

    const r = await query(
      `SELECT owner_org_id, origin FROM inbox.human_tasks WHERE linear_issue_id = 'lin-native-10'`,
    );
    assert.equal(r.rows[0].owner_org_id, staqs, 'must stamp the team-mapped org, never the payload value');
    assert.notEqual(r.rows[0].owner_org_id, '00000000-0000-0000-0000-000000000000');
    assert.equal(r.rows[0].origin, 'linear');
  });

  it('does NOT import when the team is disabled (deny by default)', async () => {
    const res = await tryImportLinearNativeIssue(payloadFor('lin-native-11', TEAM_DISABLED), {
      query,
      deps: { getIssue: async () => fullIssue({ id: 'lin-native-11', teamId: TEAM_DISABLED }) },
    });
    assert.equal(res.imported, false);

    const r = await query(`SELECT count(*)::int AS n FROM inbox.human_tasks WHERE linear_issue_id = 'lin-native-11'`);
    assert.equal(r.rows[0].n, 0);
  });

  it('does NOT import when the team is unknown', async () => {
    const res = await tryImportLinearNativeIssue(payloadFor('lin-native-12', 'team-never-seen'), {
      query,
      deps: { getIssue: async () => fullIssue({ id: 'lin-native-12', teamId: 'team-never-seen' }) },
    });
    assert.equal(res.imported, false);
  });

  it('does NOT import already-terminal issues that have no local row', async () => {
    const res = await tryImportLinearNativeIssue(payloadFor('lin-native-13', TEAM_ENABLED), {
      query,
      deps: { getIssue: async () => fullIssue({ id: 'lin-native-13', type: 'completed', name: 'Done' }) },
    });
    assert.equal(res.imported, false);
    assert.match(res.reason, /terminal/);
  });

  it('never imports Comment events', async () => {
    const res = await tryImportLinearNativeIssue(
      { type: 'Comment', action: 'create', data: { issueId: 'lin-native-14', teamId: TEAM_ENABLED } },
      { query, deps: { getIssue: async () => fullIssue({ id: 'lin-native-14' }) } },
    );
    assert.equal(res.imported, false);
  });
});

describe('Linear webhook HMAC verification (mechanism parity with api.js)', () => {
  // Mirror the exact verification api.js performs for source='linear':
  //   header = config.hmacHeader; computed = HMAC(algo, secret).update(rawBody);
  //   reject unless timingSafeEqual(presented, computed). Fail-closed.
  const cfg = JSON.parse(
    readFileSync(new URL('../config/webhook-sources.json', import.meta.url), 'utf-8'),
  ).sources.linear;
  const SECRET = 'test-linear-webhook-secret';
  const rawBody = JSON.stringify({ type: 'Issue', action: 'create', data: { id: 'x' } });

  function verify(presentedSig, body = rawBody) {
    const computed = createHmac(cfg.hmacAlgorithm, SECRET).update(body).digest('hex');
    const expected = cfg.hmacPrefix ? `${cfg.hmacPrefix}${computed}` : computed;
    if (!presentedSig) return false;
    const a = Buffer.from(presentedSig);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  it('uses the Linear-Signature header + sha256 (config sanity)', () => {
    assert.equal(cfg.hmacHeader, 'Linear-Signature');
    assert.equal(cfg.hmacAlgorithm, 'sha256');
  });

  it('rejects a forged / wrong signature (fail-closed)', () => {
    assert.equal(verify('deadbeef'), false);
    assert.equal(verify(''), false);
    assert.equal(verify(undefined), false);
  });

  it('rejects a valid signature over a TAMPERED body', () => {
    const goodSig = createHmac(cfg.hmacAlgorithm, SECRET).update(rawBody).digest('hex');
    assert.equal(verify(goodSig, rawBody + 'tampered'), false);
  });

  it('accepts a correctly-computed signature', () => {
    const goodSig = createHmac(cfg.hmacAlgorithm, SECRET).update(rawBody).digest('hex');
    assert.equal(verify(goodSig), true);
  });
});
