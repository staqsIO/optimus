#!/usr/bin/env node
/**
 * OPT-54 — Federation Receipt Round-Trip Demo (the mind-meld demo)
 *
 * Runs the FULL grant → query round-trip against a live/local Optimus install.
 * Requires: DATABASE_URL and OPTIMUS_ORG_DID in environment (or autobot-inbox/.env).
 *
 * Usage:
 *   cd autobot-inbox
 *   node scripts/federation-roundtrip-demo.mjs
 *
 * What it demonstrates:
 *   1. Org A (STAQS) issues a scoped kg.read capability receipt to itself
 *      (issuer = query endpoint; production variant: issue to Org B's DID).
 *   2. The receipt is signed (RS256 JWS) and persisted; the DB trigger
 *      writes `federation:grant:<jti>` into state_transitions with
 *      config_hash = contract_hash.
 *   3. The receipt is presented to GET /api/federation/query — scope is
 *      enforced server-side (DB row, not JWT claims). A widen attempt is
 *      rejected 403.
 *   4. The query audit row `federation:query:<jti>` is written into
 *      state_transitions with config_hash = contract_hash (SAME value as #2).
 *   5. The script queries both state_transitions chains and verifies they
 *      share the same contract_hash — the cross-org audit join anchor.
 *
 * Environment:
 *   DATABASE_URL       — Postgres connection string (required for live run)
 *   OPTIMUS_ORG_DID    — Issuing org DID (default: did:web:staqs.io)
 *   PUBLIC_BASE_URL    — Base URL for revocable_at (default: https://preview.staqs.io)
 *   FEDERATION_PRIVATE_KEY_PEM — RSA private key PEM (if not already set via env)
 *   FEDERATION_PUBLIC_KEY_PEM  — RSA public key PEM  (if not already set via env)
 *
 * Exit codes: 0 = success, 1 = failure.
 */

import { fileURLToPath } from 'url';
import { resolve, dirname } from 'path';
import { readFileSync, existsSync } from 'fs';
import { generateKeyPairSync, createHash } from 'crypto';

// ─── load .env if present ────────────────────────────────────────────────────
const __dir  = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dir, '../.env');
if (existsSync(envPath)) {
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// ─── setup ───────────────────────────────────────────────────────────────────
const ORG_DID  = process.env.OPTIMUS_ORG_DID ?? 'did:web:staqs.io';
const BASE_URL = process.env.PUBLIC_BASE_URL  ?? 'https://preview.staqs.io';

// Generate ephemeral keypair for the demo (or use env-injected keys).
let privatePem = process.env.FEDERATION_PRIVATE_KEY_PEM;
let publicPem  = process.env.FEDERATION_PUBLIC_KEY_PEM;
if (!privatePem || !publicPem) {
  console.log('[demo] No FEDERATION_*_KEY_PEM in env — generating ephemeral RSA-2048 keypair...');
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  publicPem  = publicKey.export({ type: 'spki',  format: 'pem' });
}

// Inject keys into the JWS module.
const jws = await import('../../lib/federation/capability-receipt-jws.js');
jws._injectKeysForTest(privatePem, publicPem);

// ─── database ─────────────────────────────────────────────────────────────────
const db = await import('../src/db.js');
const query = db.query;

// ─── federation routes ────────────────────────────────────────────────────────
const { registerFederationRoutes } = await import('../src/api-routes/federation.js');
const routes = new Map();
registerFederationRoutes(routes, query, { orgDid: ORG_DID, baseUrl: BASE_URL });

function makeReq({ auth = null, headers = {}, url = '/api/federation/query' } = {}) {
  return { auth, headers, url };
}
function boardReq() {
  return makeReq({
    auth: { role: 'board', github_username: 'ecgang', userId: 'demo-user-id' },
  });
}
function bearerReq(receipt, capability = 'kg.read') {
  return makeReq({
    headers: { authorization: `Bearer ${receipt}` },
    url: `/api/federation/query?capability=${capability}`,
  });
}

async function callRoute(key, req, body = {}) {
  const handler = routes.get(key);
  if (!handler) throw new Error(`Route not registered: ${key}`);
  return handler(req, body);
}

// ─── demo ────────────────────────────────────────────────────────────────────

const CONTRACT_HASH = `sha256:${createHash('sha256').update('OPT-54-mind-meld-demo-contract-v1').digest('hex')}`;

console.log('\n========================================================');
console.log(' OPT-54 Federation Receipt Round-Trip Demo (mind-meld)');
console.log('========================================================');
console.log(`  Org A (issuer/endpoint): ${ORG_DID}`);
console.log(`  Contract hash:           ${CONTRACT_HASH}`);
console.log('');

// ── Step 1: Issue grant ──────────────────────────────────────────────────────
console.log('[1/5] Org A issues a scoped kg.read grant...');
let grant;
try {
  grant = await callRoute('POST /api/federation/grant', boardReq(), {
    audience_org:  ORG_DID,
    scope: {
      capability:  'kg.read',
      filter:      { origin_org: ORG_DID },
      max_results: 10,
      max_calls:   5,
    },
    contract_hash: CONTRACT_HASH,
    ttl:           3600,
  });
  console.log(`    ✓ Grant issued: jti=${grant.jti}`);
  console.log(`    ✓ Expires:      ${grant.expires_at}`);
} catch (err) {
  console.error(`    ✗ Grant failed: ${err.message}`);
  process.exit(1);
}

// ── Step 2: Verify grant audit chain ─────────────────────────────────────────
console.log('[2/5] Verifying grant audit chain in state_transitions...');
const grantAudit = await query(
  `SELECT id, work_item_id, from_state, to_state, config_hash
     FROM agent_graph.state_transitions
    WHERE work_item_id = $1
    ORDER BY created_at ASC`,
  [`federation:grant:${grant.jti}`]
);
if (!grantAudit.rows.length) {
  console.error('    ✗ No grant audit rows found — trigger may not have fired');
  process.exit(1);
}
for (const row of grantAudit.rows) {
  console.log(`    • ${row.from_state} → ${row.to_state}  config_hash=${row.config_hash}`);
}
const grantContractHash = grantAudit.rows[0].config_hash;
console.log(`    ✓ Grant chain config_hash: ${grantContractHash}`);

// ── Step 3: Present receipt to query endpoint ─────────────────────────────────
console.log('[3/5] Presenting receipt to GET /api/federation/query...');
let queryResult;
try {
  queryResult = await callRoute(
    'GET /api/federation/query',
    bearerReq(grant.signed_envelope),
    {}
  );
  console.log(`    ✓ Query served: jti=${queryResult.jti}`);
  console.log(`    ✓ Capability:   ${queryResult.capability}`);
  console.log(`    ✓ Nodes:        ${queryResult.nodes.length} (empty if Neo4j unavailable)`);
  console.log(`    ✓ max_results:  ${queryResult.max_results}`);
} catch (err) {
  console.error(`    ✗ Query failed: ${err.message}`);
  process.exit(1);
}

// ── Step 4: Verify query audit chain ─────────────────────────────────────────
console.log('[4/5] Verifying query audit chain in state_transitions...');
const queryAudit = await query(
  `SELECT id, work_item_id, from_state, to_state, config_hash
     FROM agent_graph.state_transitions
    WHERE work_item_id = $1
    ORDER BY created_at ASC`,
  [`federation:query:${grant.jti}`]
);
if (!queryAudit.rows.length) {
  console.error('    ✗ No query audit rows found');
  process.exit(1);
}
for (const row of queryAudit.rows) {
  console.log(`    • ${row.from_state} → ${row.to_state}  config_hash=${row.config_hash}`);
}
const queryContractHash = queryAudit.rows.find(r => r.to_state === 'served')?.config_hash;
console.log(`    ✓ Query chain config_hash: ${queryContractHash}`);

// ── Step 5: Assert both chains share the same contract_hash ──────────────────
console.log('[5/5] Verifying both chains reference the same contract_hash...');
if (grantContractHash !== CONTRACT_HASH) {
  console.error(`    ✗ Grant chain config_hash mismatch: expected ${CONTRACT_HASH}, got ${grantContractHash}`);
  process.exit(1);
}
if (queryContractHash !== CONTRACT_HASH) {
  console.error(`    ✗ Query chain config_hash mismatch: expected ${CONTRACT_HASH}, got ${queryContractHash}`);
  process.exit(1);
}
console.log(`    ✓ Grant chain config_hash === Query chain config_hash === ${CONTRACT_HASH}`);

// ── Scope enforcement: widen attempt rejected ─────────────────────────────────
console.log('[+] Scope enforcement: audience tries to widen capability...');
try {
  await callRoute('GET /api/federation/query', bearerReq(grant.signed_envelope, 'rag.read'), {});
  console.error('    ✗ Expected 403 but call succeeded');
  process.exit(1);
} catch (err) {
  if (err.statusCode === 403) {
    console.log(`    ✓ Widen attempt rejected with 403 (${err.message})`);
  } else {
    console.error(`    ✗ Unexpected error: ${err.statusCode} ${err.message}`);
    process.exit(1);
  }
}

console.log('');
console.log('========================================================');
console.log(' ROUND-TRIP COMPLETE — mind-meld demo PASSED');
console.log('========================================================');
console.log('');
console.log('  Both audit chains are anchored to the same contract:');
console.log(`  federation:grant:${grant.jti}`);
console.log(`  federation:query:${grant.jti}`);
console.log(`  contract_hash = ${CONTRACT_HASH}`);
console.log('');
console.log('  The cross-org exchange is fully auditable without');
console.log('  re-querying the grants table — join on config_hash.');
console.log('');

process.exit(0);
