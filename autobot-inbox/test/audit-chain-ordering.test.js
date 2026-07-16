/**
 * Regression test for plan 015 (issue #459): the Tier-1 hash-chain auditor must
 * order the chain by `chain_seq` — matching the writer in
 * lib/runtime/state/state-machine.js — NOT by `created_at`.
 *
 * The writer reads prev_hash by `chain_seq DESC` (migration 091 / STAQPRO-273)
 * because under sub-second retry storms `created_at` can be earlier than the
 * commit/chain order. If the auditor orders by `created_at`, it compares a row
 * against the WRONG predecessor and raises a false-positive CRITICAL
 * "Hash chain broken" finding — which escalates as INTEGRITY_FAILURE / CRITICAL.
 *
 * This test runs the REAL runTier1Audit() (not a copy of its query) against a
 * PGlite DB seeded with:
 *   - a retry-storm work item: 3 transitions correctly chained by chain_seq,
 *     but with created_at deliberately out of chain_seq order. A correct auditor
 *     reports ZERO breaks here; the old `ORDER BY created_at` auditor reports one
 *     (a FALSE positive).
 *   - a genuinely tampered work item: a row whose hash_chain_prev does not match
 *     its predecessor's hash_chain_current. A correct auditor MUST still report
 *     exactly ONE break here.
 *
 * With the fix the audit reports exactly 1 hash-chain mismatch (the tamper).
 * If Step 2 is reverted to `ORDER BY created_at`, the storm chain is also
 * flagged and the count becomes 2 — failing the assertion below.
 *
 * Runs on PGlite (no DATABASE_URL required).
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';

let query;
let runTier1Audit;

// 32-byte (64 hex char) sentinels — distinct so mismatches are unambiguous.
const H1 = 'aa'.repeat(32);
const H2 = 'bb'.repeat(32);
const H3 = 'cc'.repeat(32);
const HX1 = 'dd'.repeat(32);
const HX2 = 'ee'.repeat(32);
const WRONG = '11'.repeat(32); // != HX1 → genuine tamper

const AGENT = 'orchestrator';
const CFG = 'testhash';

// Insert one crafted state_transition row with explicit chain_seq / created_at
// and raw hash bytes. prevHex null → genesis (hash_chain_prev stays NULL).
async function insertTransition({ workItemId, chainSeq, secondsAgo, prevHex, currentHex, from, to }) {
  await query(
    `INSERT INTO agent_graph.state_transitions
       (work_item_id, from_state, to_state, agent_id, config_hash,
        hash_chain_prev, hash_chain_current, chain_seq, created_at)
     VALUES ($1, $2, $3, $4, $5,
        ${prevHex ? "decode($6,'hex')" : 'NULL'},
        decode(${prevHex ? '$7' : '$6'},'hex'),
        ${prevHex ? '$8' : '$7'},
        now() - ($${prevHex ? 9 : 8} || ' seconds')::interval)`,
    prevHex
      ? [workItemId, from, to, AGENT, CFG, prevHex, currentHex, chainSeq, String(secondsAgo)]
      : [workItemId, from, to, AGENT, CFG, currentHex, chainSeq, String(secondsAgo)]
  );
}

before(async () => {
  ({ query } = await getDb());
  ({ runTier1Audit } = await import('../../lib/audit/tier1-deterministic.js'));
});

describe('tier1 audit — hash-chain ordering (plan 015 / #459)', () => {
  it('orders by chain_seq: retry-storm chain is NOT a false positive, real tamper IS caught', async () => {
    const stormWi = 'wi-storm-459';
    const tamperWi = 'wi-tamper-459';

    // --- Retry-storm chain (correctly chained by chain_seq, created_at scrambled) ---
    // chain_seq order: A(H1) -> B(H2) -> C(H3), each prev = predecessor's current.
    // created_at order is B(9s ago) -> A(7s ago) -> C(5s ago), i.e. NOT chain_seq order.
    // Ordering by created_at would compare C.prev(H2) against A.current(H1) -> false break.
    await insertTransition({ workItemId: stormWi, chainSeq: 10, secondsAgo: 7, prevHex: null, currentHex: H1, from: 'created', to: 'assigned' });
    await insertTransition({ workItemId: stormWi, chainSeq: 11, secondsAgo: 9, prevHex: H1, currentHex: H2, from: 'assigned', to: 'in_progress' });
    await insertTransition({ workItemId: stormWi, chainSeq: 12, secondsAgo: 5, prevHex: H2, currentHex: H3, from: 'in_progress', to: 'review' });

    // --- Genuine tamper (must be detected under any correct ordering) ---
    // seq 20 genesis -> HX1; seq 21 claims prev=WRONG (!= HX1).
    await insertTransition({ workItemId: tamperWi, chainSeq: 20, secondsAgo: 4, prevHex: null, currentHex: HX1, from: 'created', to: 'assigned' });
    await insertTransition({ workItemId: tamperWi, chainSeq: 21, secondsAgo: 3, prevHex: WRONG, currentHex: HX2, from: 'assigned', to: 'in_progress' });

    const result = await runTier1Audit();
    assert.equal(result.skipped, undefined, 'audit must actually run (not be throttle-skipped)');

    const chainFinding = result.findings.find(
      (f) => f.type === 'security' && f.severity === 'critical' && /Hash chain broken/.test(f.description)
    );

    // The tamper MUST be caught → a critical hash-chain finding exists.
    assert.ok(chainFinding, 'genuine tamper must produce a critical Hash-chain-broken finding');

    // Exactly ONE mismatch: the tamper. The retry-storm chain must NOT be counted.
    // Under the old `ORDER BY created_at` auditor this count is 2 (storm false positive) → test fails.
    const broken = parseInt(/(\d+) mismatches/.exec(chainFinding.description)?.[1] ?? '-1', 10);
    assert.equal(broken, 1, `expected exactly 1 hash-chain mismatch (tamper only), got ${broken} — storm chain was false-flagged`);
  });
});
