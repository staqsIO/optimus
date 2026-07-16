/**
 * Connected-accounts per-viewer scoping (STAQPRO-531 family, inbox.accounts).
 *
 * A board member must only SEE + MANAGE their OWN accounts plus org-SHARED
 * infra (Slack/Telegram bots owned by nobody) — never another member's. This
 * mirrors the /api/today + /api/emails viewer pattern: scope is server-derived
 * from the authed viewer, the client `?owner=` is ignored for non-bypass
 * viewers, and the read cache key folds in the viewer.
 *
 * Cases:
 *   (a) member A sees only own + shared, not member B's
 *   (b) client ?owner=B is ignored for a non-bypass viewer
 *   (c) cache key differs per viewer (A's cached list never returned to B)
 *   (d) mutate on another member's account → 403
 *   (e) mutate on own / shared account → allowed
 *   (f) adminBypass (agent JWT) sees all
 *
 * Runs against PGlite via the shared setup-db helper (same pattern as
 * today-api.test.js). board_members ('ecgang', 'cboone') are seeded by
 * migration 007, so we reuse those real handles as members A and B.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';
import { routes, mayManageAccount, accountsCacheKey } from '../src/api.js';

// Member A = ecgang, Member B = cboone (both seeded by migration 007).
const A = { role: 'board', source: 'github_oauth', github_username: 'ecgang', scope: ['*'] };
const B = { role: 'board', source: 'github_oauth', github_username: 'cboone', scope: ['*'] };
const AGENT = { role: 'board', source: 'agent_jwt', scope: ['*'] };

function reqWith(auth, url = '/api/accounts') {
  return { url, headers: {}, auth };
}

const getAccounts = () => routes.get('GET /api/accounts');
const disconnect = () => routes.get('POST /api/accounts/disconnect');

let query;
let aOwnerId;
let bOwnerId;

// Account ids seeded for this suite.
const A_ACCT = 'acct-scope-A';
const B_ACCT = 'acct-scope-B';
const SHARED_ACCT = 'acct-scope-SHARED';
const HANDLE_ACCT = 'acct-scope-HANDLE'; // owner='isaias', owner_id=NULL edge

before(async () => {
  ({ query } = await getDb());

  const a = await query(`SELECT id FROM agent_graph.board_members WHERE github_username = 'ecgang'`);
  const b = await query(`SELECT id FROM agent_graph.board_members WHERE github_username = 'cboone'`);
  aOwnerId = a.rows[0].id;
  bOwnerId = b.rows[0].id;

  await query(`DELETE FROM inbox.accounts WHERE id LIKE 'acct-scope-%'`);
  await query(
    `INSERT INTO inbox.accounts (id, channel, provider, label, identifier, owner, owner_id)
     VALUES
       ($1, 'email', 'gmail', 'A inbox', 'a@staqs.io', 'ecgang',       $5),
       ($2, 'email', 'gmail', 'B inbox', 'b@staqs.io', 'cboone', $6),
       ($3, 'slack', 'slack', 'Shared bot', 'T-shared', NULL,          NULL),
       ($4, 'email', 'gmail', 'Handle only', 'isa@staqs.io', 'isaias', NULL)`,
    [A_ACCT, B_ACCT, SHARED_ACCT, HANDLE_ACCT, aOwnerId, bOwnerId]
  );
});

describe('GET /api/accounts — per-viewer scope', () => {
  it('(a) member A sees only own + shared, never member B', async () => {
    const res = await getAccounts()(reqWith(A));
    const ids = res.accounts.map((r) => r.id);
    assert.ok(ids.includes(A_ACCT), 'A sees own account');
    assert.ok(ids.includes(SHARED_ACCT), 'A sees shared infra');
    assert.equal(ids.includes(B_ACCT), false, 'A must NOT see B\'s account');
  });

  it('(b) client ?owner=cboone is IGNORED for a non-bypass viewer', async () => {
    const res = await getAccounts()(reqWith(A, '/api/accounts?owner=cboone'));
    const ids = res.accounts.map((r) => r.id);
    assert.equal(ids.includes(B_ACCT), false, '?owner=B must not leak B to A');
    assert.ok(ids.includes(A_ACCT), 'still scoped to A');
  });

  it('(c) cache key differs per viewer — A\'s list is never returned to B', async () => {
    // Prime A's cache bucket, then read as B. A global cache key would return
    // A's cached {accounts:[A,shared]} to B — the exact leak this test guards.
    const aRes = await getAccounts()(reqWith(A));
    assert.ok(aRes.accounts.map((r) => r.id).includes(A_ACCT));

    const bRes = await getAccounts()(reqWith(B));
    const bIds = bRes.accounts.map((r) => r.id);
    assert.ok(bIds.includes(B_ACCT), 'B sees own account');
    assert.ok(bIds.includes(SHARED_ACCT), 'B sees shared infra');
    assert.equal(bIds.includes(A_ACCT), false, 'B must NOT receive A\'s cached account');

    // Direct assertion on the key derivation: distinct viewers → distinct keys.
    assert.notEqual(
      accountsCacheKey({ ownerId: aOwnerId }, 'ecgang'),
      accountsCacheKey({ ownerId: bOwnerId }, 'cboone'),
    );
  });

  it('(f) adminBypass (agent JWT) sees all accounts', async () => {
    const res = await getAccounts()(reqWith(AGENT));
    const ids = res.accounts.map((r) => r.id);
    assert.ok(ids.includes(A_ACCT) && ids.includes(B_ACCT) && ids.includes(SHARED_ACCT),
      'admin sees every account');
    assert.equal(accountsCacheKey({ adminBypass: true }), '__admin__');
  });

  it('fail-closed: unidentified caller (bare api_secret, no x-board-user) sees nothing', async () => {
    const viewer = { ownerId: null, emails: [], adminBypass: false };
    // Simulated unresolved viewer → empty key, and the handler returns [].
    const res = await getAccounts()(reqWith({ role: 'board', source: 'api_secret' }));
    assert.deepEqual(res, { accounts: [] });
    assert.equal(accountsCacheKey(viewer, null), '__none__');
  });
});

describe('mayManageAccount — ownership gate', () => {
  const viewerA = { ownerId: aOwnerId, adminBypass: false };
  const sharedAcct = { owner: null, owner_id: null };
  const myAcct = { owner: 'ecgang', owner_id: aOwnerId };
  const otherAcct = { owner: 'cboone', owner_id: bOwnerId };
  const handleAcct = { owner: 'isaias', owner_id: null };

  it('(e) own account → allowed', () => {
    assert.equal(mayManageAccount(viewerA, 'ecgang', myAcct), true);
  });
  it('(e) shared account → allowed for any identified member', () => {
    assert.equal(mayManageAccount(viewerA, 'ecgang', sharedAcct), true);
  });
  it('(d) another member\'s account → denied', () => {
    assert.equal(mayManageAccount(viewerA, 'ecgang', otherAcct), false);
  });
  it('text-handle match (owner_id NULL) → allowed for that handle only', () => {
    assert.equal(mayManageAccount({ ownerId: null }, 'isaias', handleAcct), true);
    assert.equal(mayManageAccount(viewerA, 'ecgang', handleAcct), false);
  });
  it('(f) adminBypass → always allowed', () => {
    assert.equal(mayManageAccount({ adminBypass: true }, null, otherAcct), true);
  });
  it('unidentified viewer → denied', () => {
    assert.equal(mayManageAccount(null, null, sharedAcct), false);
    assert.equal(mayManageAccount({ ownerId: null, adminBypass: false }, null, sharedAcct), false);
  });
});

describe('POST /api/accounts/disconnect — gated mutation', () => {
  it('(d) member B disconnecting member A\'s account → THROWS 403, no mutation', async () => {
    // Denial THROWS with statusCode 403 — the dispatcher only upgrades HTTP status
    // for thrown errors; a returned { statusCode } object would go out as HTTP 200.
    await assert.rejects(
      () => disconnect()(reqWith(B, '/api/accounts/disconnect'), { accountId: A_ACCT }),
      (err) => err.statusCode === 403 && /another board member/i.test(err.message),
    );
    // A's account stays active — denial returns before any mutation.
    const chk = await query(`SELECT is_active FROM inbox.accounts WHERE id = $1`, [A_ACCT]);
    assert.equal(chk.rows[0].is_active, true, 'target untouched after denied mutate');
  });

  it('non-existent accountId → THROWS 404', async () => {
    await assert.rejects(
      () => disconnect()(reqWith(A, '/api/accounts/disconnect'), { accountId: 'acct-nope-404' }),
      (err) => err.statusCode === 404 && /not found/i.test(err.message),
    );
  });

  it('(e) member A disconnecting their OWN account → allowed', async () => {
    const res = await disconnect()(reqWith(A, '/api/accounts/disconnect'), { accountId: A_ACCT });
    assert.equal(res.ok, true);
    const chk = await query(`SELECT is_active FROM inbox.accounts WHERE id = $1`, [A_ACCT]);
    assert.equal(chk.rows[0].is_active, false, 'own account deactivated');
  });

  it('(e) any identified member disconnecting SHARED infra → allowed', async () => {
    const res = await disconnect()(reqWith(B, '/api/accounts/disconnect'), { accountId: SHARED_ACCT });
    assert.equal(res.ok, true);
  });
});
