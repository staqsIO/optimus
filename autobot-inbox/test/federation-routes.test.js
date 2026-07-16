/**
 * OPT-76 (T1-F) — federation grant/query/revocations endpoints.
 *
 * Fully offline: PGlite (no network), mocked Neo4j, injected ephemeral JWS keys.
 *
 * Scenarios:
 *   1. POST /api/federation/grant  → returns receipt + persists DB row
 *   2. GET  /api/federation/query  → valid receipt → returns scoped KG slice
 *   3. GET  /api/federation/query  → expired receipt → 401
 *   4. GET  /api/federation/query  → wrong-audience receipt → 401
 *   5. GET  /api/federation/query  → revoked receipt → 401 + audit row
 *   6. GET  /api/federation/query  → max_results cap enforced (KG LIMIT)
 *   7. GET  /api/federation/query  → max_calls enforced → 429 after cap
 *   8. GET  /.well-known/federation/revocations.json → lists revoked JTIs
 *   9. POST /api/federation/grant  → non-board caller → 403
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { generateKeyPairSync } from 'node:crypto';
import { getDb } from './helpers/setup-db.js';
import {
  registerFederationRoutes,
  _injectKeysForTest,
} from '../src/api-routes/federation.js';
import {
  _resetKeysForTest,
  signReceipt,
} from '../../lib/federation/capability-receipt-jws.js';

// ─── key setup ────────────────────────────────────────────────────────────────

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const publicPem  = publicKey.export({ type: 'spki',  format: 'pem' });

// Inject the same keypair into the JWS module so sign + verify use the same key.
_injectKeysForTest(privatePem, publicPem);

const ISSUER_ORG  = 'did:web:staqs.io';
const AUDIENCE    = 'did:web:umb.io';
const CONTRACT    = 'sha256:deadbeef0000000000000000000000000000000000000000000000000000cafe';

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeReq({ auth = null, headers = {}, url = '/api/federation/query' } = {}) {
  return { auth, headers, url };
}

function boardReq() {
  // OPT-166 P3-B5: a real board principal's req.auth always carries a string
  // `sub` (api.js attaches sub from the board JWT, or 'legacy' for api_secret).
  // The /grant handler now opens a board-scoped session via withBoardScope, which
  // requires that `sub` — mirror the production shape here.
  return makeReq({ auth: { sub: 'ecgang', role: 'board', github_username: 'ecgang', userId: randomUUID() } });
}

function nonBoardReq() {
  return makeReq({ auth: { role: 'member', github_username: 'someone' } });
}

function bearerReq(receipt, url = '/api/federation/query?capability=kg.read') {
  return makeReq({ headers: { authorization: `Bearer ${receipt}` }, url });
}

/** Call a route handler from the routes Map. */
async function call(routes, key, req, body = {}) {
  const handler = routes.get(key);
  if (!handler) throw new Error(`Route not registered: ${key}`);
  return handler(req, body);
}

/** Expect a route call to throw with statusCode. */
async function expectError(routes, key, req, body, expectedStatus) {
  try {
    await call(routes, key, req, body);
    assert.fail(`Expected error ${expectedStatus} but call succeeded`);
  } catch (err) {
    assert.equal(err.statusCode, expectedStatus, `Expected ${expectedStatus}, got ${err.statusCode}: ${err.message}`);
  }
}

// ─── mock Neo4j (returns empty slice — KG unavailable in test) ───────────────
// runCypher returns null when Neo4j is unavailable; federation/routes.js
// handles null gracefully (empty nodes array). No mocking needed — NEO4J_URI
// is unset in test environment so client.js short-circuits to null.

// ─── test suite ───────────────────────────────────────────────────────────────

describe('federation routes (OPT-76 T1-F)', () => {
  let query;
  let routes;

  before(async () => {
    ({ query } = await getDb());

    // Verify migration 169 ran.
    const tableCheck = await query(
      `SELECT to_regclass('agent_graph.federation_grants') AS tbl`
    );
    assert.ok(tableCheck.rows[0]?.tbl, 'federation_grants table missing (migration 169 not applied)');

    // Seed a board member so the auth stub is internally consistent.
    // Valid roles per migration 014: 'admin', 'member', 'external_agent'.
    await query(
      `INSERT INTO agent_graph.board_members (github_username, display_name, role)
       VALUES ('ecgang-fed-test', 'Eric Fed Test', 'admin')
       ON CONFLICT (github_username) DO NOTHING`
    );

    routes = new Map();
    registerFederationRoutes(routes, query, {
      orgDid:  ISSUER_ORG,
      baseUrl: 'https://preview.staqs.io',
    });
  });

  after(() => {
    _resetKeysForTest();
  });

  // ── 1. grant: happy path ────────────────────────────────────────────────────
  it('POST /api/federation/grant — returns signed receipt + persists row', async () => {
    const body = {
      audience_org:  AUDIENCE,
      scope:         { capability: 'kg.read', filter: { origin_org: ISSUER_ORG }, max_results: 50, max_calls: 10 },
      contract_hash: CONTRACT,
      ttl:           3600,
    };
    const result = await call(routes, 'POST /api/federation/grant', boardReq(), body);

    assert.ok(result.jti, 'jti missing');
    assert.ok(result.signed_envelope, 'signed_envelope missing');
    assert.ok(result.expires_at, 'expires_at missing');

    // Verify it was persisted.
    const row = await query(
      `SELECT * FROM agent_graph.federation_grants WHERE jti = $1::uuid`,
      [result.jti]
    );
    assert.equal(row.rows.length, 1, 'grant row not found in DB');
    assert.equal(row.rows[0].audience_org, AUDIENCE);
    assert.equal(row.rows[0].scope_capability, 'kg.read');
    assert.equal(row.rows[0].max_results, 50);
    assert.equal(row.rows[0].max_calls, 10);
  });

  // ── 2. query: valid receipt → scoped slice ──────────────────────────────────
  it('GET /api/federation/query — valid receipt → 200 with scoped slice', async () => {
    // Issue a fresh grant so jti is in the DB.
    const grantBody = {
      audience_org:  ISSUER_ORG,   // same org = query endpoint accepts it
      scope:         { capability: 'kg.read', filter: { origin_org: ISSUER_ORG }, max_results: 5, max_calls: 100 },
      contract_hash: CONTRACT,
      ttl:           3600,
    };
    const grant = await call(routes, 'POST /api/federation/grant', boardReq(), grantBody);
    const receipt = grant.signed_envelope;

    const result = await call(routes, 'GET /api/federation/query', bearerReq(receipt), {});

    assert.ok('jti' in result, 'jti missing from response');
    assert.equal(result.capability, 'kg.read');
    assert.ok(Array.isArray(result.nodes), 'nodes should be an array (empty if Neo4j unavailable)');
    // Neo4j is unavailable in test — expect empty slice, no error.
    assert.equal(result.nodes.length, 0);
  });

  // ── 3. query: expired receipt → 401 ────────────────────────────────────────
  it('GET /api/federation/query — expired receipt → 401', async () => {
    // Sign a receipt with ttl=-1 (already expired).
    const expiredReceipt = signReceipt({
      issuer:       ISSUER_ORG,
      audience:     ISSUER_ORG,
      subject:      'test-agent',
      scope:        { capability: 'kg.read', max_results: 10, max_calls: 100 },
      contractHash: CONTRACT,
      ttl:          -3600, // already expired
    });

    await expectError(routes, 'GET /api/federation/query', bearerReq(expiredReceipt), {}, 401);
  });

  // ── 4. query: wrong-audience receipt → 401 ─────────────────────────────────
  it('GET /api/federation/query — wrong-audience receipt → 401', async () => {
    // Receipt for a different audience org — verifyReceipt should reject it.
    const wrongAudReceipt = signReceipt({
      issuer:       ISSUER_ORG,
      audience:     'did:web:wrong-org.io',  // not matching ISSUER_ORG
      subject:      'test-agent',
      scope:        { capability: 'kg.read', max_results: 10, max_calls: 100 },
      contractHash: CONTRACT,
      ttl:          3600,
    });

    await expectError(routes, 'GET /api/federation/query', bearerReq(wrongAudReceipt), {}, 401);
  });

  // ── 5. query: revoked receipt → 401 + audit row written ────────────────────
  it('GET /api/federation/query — revoked receipt → 401 + audit row', async () => {
    // Issue a grant then revoke it.
    const grantBody = {
      audience_org:  ISSUER_ORG,
      scope:         { capability: 'kg.read', max_results: 5, max_calls: 100 },
      contract_hash: CONTRACT,
      ttl:           3600,
    };
    const grant = await call(routes, 'POST /api/federation/grant', boardReq(), grantBody);
    const jti = grant.jti;

    // Revoke by setting revoked_at.
    await query(
      `UPDATE agent_graph.federation_grants SET revoked_at = now() WHERE jti = $1::uuid`,
      [jti]
    );

    // verifyReceipt checks revocation list from the DB (via the injected revocationFetcher).
    // The route also does a direct DB check after verify. Either path should reject.
    await expectError(routes, 'GET /api/federation/query', bearerReq(grant.signed_envelope), {}, 401);

    // Confirm audit row was written for this jti.
    const audit = await query(
      `SELECT * FROM agent_graph.state_transitions WHERE work_item_id = $1`,
      [`federation:query:${jti}`]
    );
    assert.ok(audit.rows.length > 0, 'expected audit row for revoked query attempt');
    const rejectedRow = audit.rows.find(r => r.to_state === 'rejected');
    assert.ok(rejectedRow, 'expected a rejected audit row');
  });

  // ── 6. max_results cap enforced ────────────────────────────────────────────
  it('GET /api/federation/query — max_results from DB row is respected', async () => {
    // Issue a grant with max_results=3.
    const grantBody = {
      audience_org:  ISSUER_ORG,
      scope:         { capability: 'kg.read', max_results: 3, max_calls: 100 },
      contract_hash: CONTRACT,
      ttl:           3600,
    };
    const grant = await call(routes, 'POST /api/federation/grant', boardReq(), grantBody);
    const result = await call(routes, 'GET /api/federation/query', bearerReq(grant.signed_envelope), {});

    // max_results cap = min(grant.max_results, 100) = 3.
    assert.equal(result.max_results, 3, 'max_results should be capped at grant value');
    // nodes is empty (Neo4j unavailable), but the cap was applied.
    assert.ok(Array.isArray(result.nodes));
  });

  // ── 7. max_calls enforced → 429 ────────────────────────────────────────────
  it('GET /api/federation/query — max_calls exceeded → 429', async () => {
    // Issue a grant with max_calls=1.
    const grantBody = {
      audience_org:  ISSUER_ORG,
      scope:         { capability: 'kg.read', max_results: 10, max_calls: 1 },
      contract_hash: CONTRACT,
      ttl:           3600,
    };
    const grant = await call(routes, 'POST /api/federation/grant', boardReq(), grantBody);

    // First call should succeed (usage_count 0 → 1, max_calls=1 so 0 < 1 = OK).
    await call(routes, 'GET /api/federation/query', bearerReq(grant.signed_envelope), {});

    // Second call: usage_count=1 >= max_calls=1 → 429.
    await expectError(routes, 'GET /api/federation/query', bearerReq(grant.signed_envelope), {}, 429);
  });

  // ── 8. revocations.json lists revoked JTIs ─────────────────────────────────
  it('GET /.well-known/federation/revocations.json — lists revoked JTIs', async () => {
    // Issue + revoke a grant.
    const grantBody = {
      audience_org:  AUDIENCE,
      scope:         { capability: 'kg.read', max_results: 5, max_calls: 10 },
      contract_hash: CONTRACT,
      ttl:           3600,
    };
    const grant = await call(routes, 'POST /api/federation/grant', boardReq(), grantBody);
    await query(
      `UPDATE agent_graph.federation_grants SET revoked_at = now() WHERE jti = $1::uuid`,
      [grant.jti]
    );

    const result = await call(routes, 'GET /.well-known/federation/revocations.json', makeReq(), {});

    assert.ok(Array.isArray(result.revoked), 'revoked should be an array');
    assert.ok(result.revoked.includes(grant.jti), `expected ${grant.jti} in revoked list`);
    assert.ok(result.issuer, 'issuer missing from response');
    assert.ok(result.fetched_at, 'fetched_at missing from response');
  });

  // ── 9. grant: non-board caller → 403 ───────────────────────────────────────
  it('POST /api/federation/grant — non-board caller → 403', async () => {
    const body = {
      audience_org:  AUDIENCE,
      scope:         { capability: 'kg.read', max_results: 10, max_calls: 100 },
      contract_hash: CONTRACT,
      ttl:           3600,
    };
    await expectError(routes, 'POST /api/federation/grant', nonBoardReq(), body, 403);
  });
});
