/**
 * OPT-54 — Thin-slice federation receipt round-trip (the mind-meld demo).
 *
 * Exercises grant → query across TWO distinct OPTIMUS_ORG_ID values on ONE
 * PGlite install (Staqs ↔ UMB), asserting:
 *
 *   1. Org A (issuer) grants a scoped capability to Org B (audience) →
 *      signed receipt persisted in federation_grants; DB trigger writes the
 *      grant audit row (`federation:grant:<jti>`) into state_transitions with
 *      config_hash = contract_hash.
 *
 *   2. Org B presents the receipt to the query endpoint →
 *      valid receipt → scoped slice returned; audit row (`federation:query:<jti>`)
 *      written into state_transitions with config_hash = contract_hash (same value).
 *
 *   3. Scope is ISSUER-ENFORCED: a too-broad capability request (audience tries
 *      a different capability) is denied 403.
 *
 *   4. Both state_transitions chains reference the SAME contract_hash, enabling
 *      the cross-org audit join without re-querying the grants table.
 *
 * Fully offline: PGlite (no network), mocked Neo4j, injected ephemeral JWS keys.
 *
 * NB: the query endpoint expects `expectedAudience = orgDid` (the ISSUING org).
 * This means the receipt's `audience` field must equal the ISSUING org's DID
 * (the query endpoint verifies its own receipts — the issuer IS the query
 * endpoint). In a production two-org deploy, Org B would call Org A's endpoint
 * with the receipt Org A signed for it. In this single-install test we model
 * the issuer side: Org A issues a receipt where audience = Org A's orgDid
 * (the endpoint), so verification passes. A separate test variant (scenario B
 * below) verifies that a receipt signed for a different audience is rejected.
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

// Inject the same keypair so sign + verify use the same key.
_injectKeysForTest(privatePem, publicPem);

// ─── org identities ───────────────────────────────────────────────────────────
const STAQS_ORG = 'did:web:staqs.io';   // Org A — the issuer (owns this query endpoint)
const UMB_ORG   = 'did:web:umb.io';     // Org B — the audience (presents receipts)

// Shared contract document hash — anchors both audit chains.
const CONTRACT_HASH = 'sha256:aabbcc0000000000000000000000000000000000000000000000000000001234';

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

function bearerReq(receipt, url = '/api/federation/query?capability=kg.read') {
  return makeReq({ headers: { authorization: `Bearer ${receipt}` }, url });
}

async function callRoute(routes, key, req, body = {}) {
  const handler = routes.get(key);
  if (!handler) throw new Error(`Route not registered: ${key}`);
  return handler(req, body);
}

async function expectError(routes, key, req, body, expectedStatus) {
  try {
    await callRoute(routes, key, req, body);
    assert.fail(`Expected HTTP ${expectedStatus} but call succeeded`);
  } catch (err) {
    assert.equal(
      err.statusCode, expectedStatus,
      `Expected status ${expectedStatus}, got ${err.statusCode ?? '(no statusCode)'}: ${err.message}`
    );
  }
}

// ─── test suite ───────────────────────────────────────────────────────────────
describe('federation round-trip (OPT-54 — mind-meld demo)', () => {
  let query;
  let routes;

  before(async () => {
    ({ query } = await getDb());

    // Verify migration 169 ran.
    const tableCheck = await query(
      `SELECT to_regclass('agent_graph.federation_grants') AS tbl`
    );
    assert.ok(tableCheck.rows[0]?.tbl, 'federation_grants table missing (migration 169 not applied)');

    // Seed a board member so auth stubs are internally consistent.
    await query(
      `INSERT INTO agent_graph.board_members (github_username, display_name, role)
       VALUES ('ecgang', 'Eric OPT-54 Test', 'admin')
       ON CONFLICT (github_username) DO NOTHING`
    );

    // Register routes as STAQS_ORG (the issuer / query endpoint).
    routes = new Map();
    registerFederationRoutes(routes, query, {
      orgDid:  STAQS_ORG,
      baseUrl: 'https://preview.staqs.io',
    });
  });

  after(() => {
    _resetKeysForTest();
  });

  // ── Scenario 1: Org A issues a grant for Org B, then Org B presents the receipt ──

  it('Step 1 — Org A issues a scoped grant to Org B; receipt is signed and persisted', async () => {
    // Org A issues a grant where:
    //   audience = STAQS_ORG (the query endpoint's orgDid) because we're
    //   testing the issuer-side endpoint on a single install.
    //   In production Org A would issue to UMB_ORG, Org B would call Org A's endpoint.
    const body = {
      audience_org:  STAQS_ORG,    // must match orgDid so verifyReceipt passes
      scope: {
        capability:  'kg.read',
        filter:      { origin_org: STAQS_ORG },
        max_results: 20,
        max_calls:   50,
      },
      contract_hash: CONTRACT_HASH,
      ttl:           3600,
    };

    const result = await callRoute(routes, 'POST /api/federation/grant', boardReq(), body);

    assert.ok(result.jti,            'jti missing from grant response');
    assert.ok(result.signed_envelope, 'signed_envelope missing from grant response');
    assert.ok(result.expires_at,      'expires_at missing from grant response');

    // Verify DB persistence.
    const row = await query(
      `SELECT jti::text, issuer_org, audience_org, scope_capability, contract_hash
         FROM agent_graph.federation_grants
        WHERE jti = $1::uuid`,
      [result.jti]
    );
    assert.equal(row.rows.length, 1, 'grant row not persisted');
    assert.equal(row.rows[0].issuer_org,       STAQS_ORG,      'issuer_org mismatch');
    assert.equal(row.rows[0].audience_org,      STAQS_ORG,      'audience_org mismatch');
    assert.equal(row.rows[0].scope_capability,  'kg.read',       'scope_capability mismatch');
    assert.equal(row.rows[0].contract_hash,     CONTRACT_HASH,  'contract_hash not persisted');

    // Verify the DB trigger wrote the GRANT chain entry.
    const grantChain = await query(
      `SELECT config_hash, from_state, to_state
         FROM agent_graph.state_transitions
        WHERE work_item_id = $1
        ORDER BY created_at ASC`,
      [`federation:grant:${result.jti}`]
    );
    assert.ok(grantChain.rows.length >= 1, 'grant audit chain entry missing');
    const issueRow = grantChain.rows.find(r => r.to_state === 'active');
    assert.ok(issueRow, 'expected pending→active audit row from DB trigger');
    assert.equal(
      issueRow.config_hash, CONTRACT_HASH,
      'grant chain config_hash must equal contract_hash (DB trigger anchors)'
    );
  });

  it('Step 2 — Org B presents receipt; query endpoint returns scoped slice', async () => {
    // Issue a fresh grant for this step.
    const grantBody = {
      audience_org:  STAQS_ORG,
      scope: {
        capability:  'kg.read',
        filter:      { origin_org: STAQS_ORG },
        max_results: 10,
        max_calls:   100,
      },
      contract_hash: CONTRACT_HASH,
      ttl:           3600,
    };
    const grant = await callRoute(routes, 'POST /api/federation/grant', boardReq(), grantBody);
    const jti = grant.jti;

    // Present the receipt.
    const result = await callRoute(
      routes,
      'GET /api/federation/query',
      bearerReq(grant.signed_envelope),
      {}
    );

    assert.equal(result.jti,        jti,       'jti in response must match grant jti');
    assert.equal(result.capability, 'kg.read', 'capability must match grant scope');
    assert.ok(Array.isArray(result.nodes), 'nodes must be an array');
    // Neo4j unavailable in test — expect empty slice, not an error.
    assert.equal(result.nodes.length, 0, 'expected 0 nodes (Neo4j unavailable in test)');

    // ── Core assertion: BOTH chains reference the SAME contract_hash ──────────
    const grantChain = await query(
      `SELECT config_hash FROM agent_graph.state_transitions
        WHERE work_item_id = $1 AND to_state = 'active'`,
      [`federation:grant:${jti}`]
    );
    const queryChain = await query(
      `SELECT config_hash FROM agent_graph.state_transitions
        WHERE work_item_id = $1 AND to_state = 'served'`,
      [`federation:query:${jti}`]
    );

    assert.ok(grantChain.rows.length >= 1, 'grant chain entry missing');
    assert.ok(queryChain.rows.length >= 1, 'query chain "served" entry missing');

    const grantContractHash = grantChain.rows[0].config_hash;
    const queryContractHash = queryChain.rows[0].config_hash;

    assert.equal(
      grantContractHash, CONTRACT_HASH,
      'grant chain config_hash must equal contract_hash'
    );
    assert.equal(
      queryContractHash, CONTRACT_HASH,
      'query chain config_hash must equal contract_hash (OPT-54 fix: was jti before)'
    );
    assert.equal(
      grantContractHash, queryContractHash,
      'BOTH audit chains must reference the SAME contract_hash (the mind-meld anchor)'
    );
  });

  // ── Scenario 2: scope enforcement — audience cannot widen capability ──────────

  it('Step 3 — Scope enforcement: audience requesting wrong capability → 403', async () => {
    // Issue a grant scoped to kg.read only.
    const grantBody = {
      audience_org:  STAQS_ORG,
      scope: {
        capability:  'kg.read',
        filter:      { origin_org: STAQS_ORG },
        max_results: 5,
        max_calls:   100,
      },
      contract_hash: CONTRACT_HASH,
      ttl:           3600,
    };
    const grant = await callRoute(routes, 'POST /api/federation/grant', boardReq(), grantBody);

    // Audience tries to request a WIDER capability (rag.read is not in the grant).
    // The URL ?capability= param triggers the capability-mismatch check in the handler.
    const widenAttemptReq = bearerReq(
      grant.signed_envelope,
      '/api/federation/query?capability=rag.read'
    );
    await expectError(routes, 'GET /api/federation/query', widenAttemptReq, {}, 403);
  });

  // ── Scenario 3: two distinct org IDs on one install ──────────────────────────

  it('Step 4 — Two org IDs on one PGlite install; grants are org-scoped', async () => {
    // Issue grant A (issuer=STAQS_ORG, audience=STAQS_ORG — issuer side endpoint)
    const grantA = await callRoute(routes, 'POST /api/federation/grant', boardReq(), {
      audience_org:  STAQS_ORG,
      scope:         { capability: 'kg.read', filter: { origin_org: STAQS_ORG }, max_results: 5, max_calls: 10 },
      contract_hash: CONTRACT_HASH,
      ttl:           3600,
    });

    // Simulate a second "org" route registration (UMB_ORG as orgDid).
    // This proves two org IDs coexist in one DB without collision.
    const umbRoutes = new Map();
    registerFederationRoutes(umbRoutes, query, {
      orgDid:  UMB_ORG,
      baseUrl: 'https://umb.preview.io',
    });

    const UMB_CONTRACT = 'sha256:ccddee0000000000000000000000000000000000000000000000000000005678';
    const grantB = await callRoute(umbRoutes, 'POST /api/federation/grant', boardReq(), {
      audience_org:  UMB_ORG,
      scope:         { capability: 'kg.read', filter: { origin_org: UMB_ORG }, max_results: 3, max_calls: 10 },
      contract_hash: UMB_CONTRACT,
      ttl:           3600,
    });

    assert.notEqual(grantA.jti, grantB.jti, 'two grants must have distinct jtis');

    // Verify both rows exist with their respective issuers.
    const rows = await query(
      `SELECT jti::text, issuer_org, contract_hash
         FROM agent_graph.federation_grants
        WHERE jti IN ($1::uuid, $2::uuid)
        ORDER BY issued_at ASC`,
      [grantA.jti, grantB.jti]
    );
    assert.equal(rows.rows.length, 2, 'both grant rows must exist in the shared DB');

    const rowA = rows.rows.find(r => r.jti === grantA.jti);
    const rowB = rows.rows.find(r => r.jti === grantB.jti);

    assert.equal(rowA.issuer_org,   STAQS_ORG,   'Grant A issuer must be STAQS_ORG');
    assert.equal(rowA.contract_hash, CONTRACT_HASH, 'Grant A contract_hash must match');
    assert.equal(rowB.issuer_org,   UMB_ORG,     'Grant B issuer must be UMB_ORG');
    assert.equal(rowB.contract_hash, UMB_CONTRACT, 'Grant B contract_hash must match');

    // A receipt issued by STAQS_ORG endpoint cannot be verified by UMB_ORG endpoint
    // (wrong audience) — demonstrating org isolation.
    const staqsReceipt = grantA.signed_envelope;
    // UMB endpoint expects audience = UMB_ORG; staqsReceipt audience = STAQS_ORG → reject.
    await expectError(umbRoutes, 'GET /api/federation/query', bearerReq(staqsReceipt), {}, 401);
  });

  // ── Scenario 4: receipt for wrong audience → 401 ─────────────────────────────

  it('Step 5 — Wrong-audience receipt → 401 (cross-org receipt not accepted at wrong endpoint)', async () => {
    // Sign a receipt targeting UMB_ORG as audience.
    // Present it to the STAQS_ORG query endpoint → should be rejected.
    const wrongAudReceipt = signReceipt({
      issuer:       STAQS_ORG,
      audience:     UMB_ORG,      // NOT matching STAQS_ORG orgDid
      subject:      'test-agent',
      scope:        { capability: 'kg.read', max_results: 5, max_calls: 10 },
      contractHash: CONTRACT_HASH,
      ttl:          3600,
    });

    await expectError(
      routes,
      'GET /api/federation/query',
      bearerReq(wrongAudReceipt),
      {},
      401
    );
  });
});
