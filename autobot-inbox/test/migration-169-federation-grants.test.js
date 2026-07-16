// migration-169-federation-grants.test.js — OPT-78, T1-D
//
// Verifies that migration 169 applies cleanly and produces the expected schema:
//   - agent_graph.federation_grants table with all required columns
//   - Two indexes: idx_fg_audience_active (partial) + idx_fg_contract_hash
//   - RLS policies exist (ENABLE ROW LEVEL SECURITY, 4 policies)
//   - Hash-chain trigger: INSERT → state_transitions 'pending'→'active'
//   - Revocation UPDATE → state_transitions 'active'→'revoked'
//   - Revoke-then-un-revoke raises an exception (append-only, P3)
//   - state_transitions rows are hash-linked (hash_chain_prev of revoke
//     matches hash_chain_current of issue)
//
// TESTING MODEL: PGlite (getDb()) applies ALL migrations including 169, so the
// table, indexes, trigger, and RLS exist on a fresh DB. The current pool
// connects as superuser, so RLS policies are enabled but NOT enforced yet
// (FORCE is intentionally absent until PR-B / STAQPRO-263). The test only
// verifies policy existence (via pg_policies), not enforcement.

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';

// Stable UUIDs for repeatable test data
const JTI    = '11111111-2222-3333-4444-555555555555';
const ISSUER  = 'did:web:staqs.io';
const AUDIENCE = 'did:web:umbadvisors.com';
const CONTRACT = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ENVELOPE = 'eyJ0eXAiOiJKV1QifQ.e30.sig'; // dummy JWS compact

describe('migration-169: federation_grants table', () => {
  let query;

  before(async () => {
    ({ query } = await getDb());
  });

  // ── Schema existence ────────────────────────────────────────────────────────

  it('federation_grants table exists in agent_graph schema', async () => {
    const { rows } = await query(`
      SELECT to_regclass('agent_graph.federation_grants') AS tbl
    `);
    assert.ok(rows[0].tbl, 'agent_graph.federation_grants must exist after migration 169');
  });

  it('has all required columns with correct types', async () => {
    const { rows } = await query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'agent_graph'
        AND table_name   = 'federation_grants'
      ORDER BY ordinal_position
    `);
    const cols = Object.fromEntries(rows.map(r => [r.column_name, r]));

    // jti: uuid PK
    assert.ok(cols.jti,             'jti column missing');
    assert.equal(cols.jti.data_type, 'uuid');

    // Party columns
    assert.ok(cols.issuer_org,       'issuer_org missing');
    assert.equal(cols.issuer_org.is_nullable, 'NO');

    assert.ok(cols.audience_org,     'audience_org missing');
    assert.equal(cols.audience_org.is_nullable, 'NO');

    assert.ok(cols.subject_agent,    'subject_agent missing');
    assert.equal(cols.subject_agent.data_type, 'uuid');
    assert.equal(cols.subject_agent.is_nullable, 'YES');

    // Scope columns
    assert.ok(cols.scope_capability, 'scope_capability missing');
    assert.equal(cols.scope_capability.is_nullable, 'NO');

    assert.ok(cols.scope_filter,     'scope_filter missing');
    assert.equal(cols.scope_filter.data_type, 'jsonb');
    assert.equal(cols.scope_filter.is_nullable, 'NO');

    assert.ok(cols.max_results,      'max_results missing');
    assert.equal(cols.max_results.is_nullable, 'YES');

    assert.ok(cols.max_calls,        'max_calls missing');
    assert.equal(cols.max_calls.is_nullable, 'YES');

    // Contract
    assert.ok(cols.contract_hash,    'contract_hash missing');
    assert.equal(cols.contract_hash.is_nullable, 'NO');

    assert.ok(cols.signed_envelope,  'signed_envelope missing');
    assert.equal(cols.signed_envelope.is_nullable, 'NO');

    // Lifecycle
    assert.ok(cols.issued_at,        'issued_at missing');
    assert.ok(cols.expires_at,       'expires_at missing');
    assert.equal(cols.expires_at.is_nullable, 'YES');
    assert.ok(cols.revoked_at,       'revoked_at missing');
    assert.equal(cols.revoked_at.is_nullable, 'YES');

    // Provenance
    assert.ok(cols.created_by,       'created_by missing');
    assert.equal(cols.created_by.data_type, 'uuid');
    assert.equal(cols.created_by.is_nullable, 'YES');
  });

  // ── Indexes ─────────────────────────────────────────────────────────────────

  it('has idx_fg_audience_active partial index', async () => {
    const { rows } = await query(`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'agent_graph'
        AND tablename  = 'federation_grants'
        AND indexname  = 'idx_fg_audience_active'
    `);
    assert.equal(rows.length, 1, 'idx_fg_audience_active index missing');
    // Partial index must include the WHERE clause
    assert.ok(
      rows[0].indexdef.includes('revoked_at IS NULL'),
      `Expected partial index on revoked_at IS NULL, got: ${rows[0].indexdef}`,
    );
  });

  it('has idx_fg_contract_hash index', async () => {
    const { rows } = await query(`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'agent_graph'
        AND tablename  = 'federation_grants'
        AND indexname  = 'idx_fg_contract_hash'
    `);
    assert.equal(rows.length, 1, 'idx_fg_contract_hash index missing');
  });

  // ── RLS policies (existence, not enforcement) ────────────────────────────────

  it('RLS is enabled on federation_grants', async () => {
    const { rows } = await query(`
      SELECT relrowsecurity
      FROM pg_class
      JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
      WHERE nspname = 'agent_graph'
        AND relname = 'federation_grants'
    `);
    assert.ok(rows[0].relrowsecurity, 'ENABLE ROW LEVEL SECURITY must be set');
  });

  it('has the four expected RLS policies', async () => {
    const { rows } = await query(`
      SELECT policyname, cmd
      FROM pg_policies
      WHERE schemaname = 'agent_graph'
        AND tablename  = 'federation_grants'
      ORDER BY policyname
    `);
    const policies = Object.fromEntries(rows.map(r => [r.policyname, r.cmd]));
    assert.ok(policies.fg_insert,    'fg_insert policy missing');
    assert.ok(policies.fg_select,    'fg_select policy missing');
    assert.ok(policies.fg_update,    'fg_update policy missing');
    assert.ok(policies.fg_no_delete, 'fg_no_delete policy missing');
  });

  // ── Insert → hash chain ──────────────────────────────────────────────────────

  it('INSERT creates a state_transitions "pending→active" entry', async () => {
    await query(
      `INSERT INTO agent_graph.federation_grants
         (jti, issuer_org, audience_org, scope_capability, scope_filter,
          contract_hash, signed_envelope)
       VALUES ($1, $2, $3, 'rag_query', '{"max_classification": 1}', $4, $5)`,
      [JTI, ISSUER, AUDIENCE, CONTRACT, ENVELOPE],
    );

    const { rows } = await query(
      `SELECT from_state, to_state, agent_id, config_hash,
              hash_chain_prev, hash_chain_current
       FROM agent_graph.state_transitions
       WHERE work_item_id = $1
       ORDER BY created_at ASC`,
      [`federation:grant:${JTI}`],
    );

    assert.equal(rows.length, 1, 'Expected exactly 1 state_transitions row after INSERT');
    assert.equal(rows[0].from_state, 'pending');
    assert.equal(rows[0].to_state,   'active');
    assert.equal(rows[0].config_hash, CONTRACT, 'config_hash must anchor contract_hash');
    assert.ok(rows[0].hash_chain_current, 'hash_chain_current must be set');
    assert.equal(rows[0].hash_chain_prev, null, 'genesis entry has no prev hash');
  });

  // ── Revoke → hash chain ──────────────────────────────────────────────────────

  it('revocation UPDATE appends "active→revoked" transition linked to issue entry', async () => {
    // Revoke the grant inserted in the previous test
    await query(
      `UPDATE agent_graph.federation_grants SET revoked_at = now() WHERE jti = $1`,
      [JTI],
    );

    const { rows } = await query(
      `SELECT from_state, to_state, hash_chain_prev, hash_chain_current
       FROM agent_graph.state_transitions
       WHERE work_item_id = $1
       ORDER BY created_at ASC`,
      [`federation:grant:${JTI}`],
    );

    assert.equal(rows.length, 2, 'Expected 2 state_transitions rows after revocation');

    const issue  = rows[0];
    const revoke = rows[1];

    assert.equal(revoke.from_state, 'active');
    assert.equal(revoke.to_state,   'revoked');

    // Hash chain linkage: revoke.prev must equal issue.current
    assert.deepEqual(
      revoke.hash_chain_prev,
      issue.hash_chain_current,
      'Revocation hash_chain_prev must equal issue hash_chain_current (chain integrity)',
    );
  });

  // ── Append-only: un-revoke is forbidden ─────────────────────────────────────

  it('clearing revoked_at raises an exception (P3 append-only)', async () => {
    await assert.rejects(
      () => query(
        `UPDATE agent_graph.federation_grants SET revoked_at = NULL WHERE jti = $1`,
        [JTI],
      ),
      /revoked_at cannot be cleared/i,
      'Trigger must reject un-revoking a grant',
    );
  });

  // ── Constraint checks ────────────────────────────────────────────────────────

  it('rejects a grant where expires_at <= issued_at', async () => {
    const BAD_JTI = '22222222-3333-4444-5555-666666666666';
    await assert.rejects(
      () => query(
        `INSERT INTO agent_graph.federation_grants
           (jti, issuer_org, audience_org, scope_capability, scope_filter,
            contract_hash, signed_envelope,
            issued_at, expires_at)
         VALUES ($1, $2, $3, 'rag_query', '{}', $4, $5, now(), now() - interval '1 second')`,
        [BAD_JTI, ISSUER, AUDIENCE, CONTRACT, ENVELOPE],
      ),
      /fg_expires_after_issue/,
      'Should reject expires_at <= issued_at',
    );
  });

  it('rejects a grant where revoked_at < issued_at', async () => {
    const BAD_JTI = '33333333-4444-5555-6666-777777777777';
    await assert.rejects(
      () => query(
        `INSERT INTO agent_graph.federation_grants
           (jti, issuer_org, audience_org, scope_capability, scope_filter,
            contract_hash, signed_envelope,
            issued_at, revoked_at)
         VALUES ($1, $2, $3, 'rag_query', '{}', $4, $5, now(), now() - interval '1 second')`,
        [BAD_JTI, ISSUER, AUDIENCE, CONTRACT, ENVELOPE],
      ),
      /fg_revoke_after_issue/,
      'Should reject revoked_at < issued_at',
    );
  });
});
