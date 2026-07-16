import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

/**
 * STAQPRO-356 / ADR-007 §4: capability receipt envelope.
 *
 * These tests pin the round-trip invariant (sign → serialize → verify)
 * and the canonicalization properties that make signatures deterministic
 * across implementations. No DB, no I/O — pure crypto.
 */
describe('STAQPRO-356 — capability-receipt', () => {
  let signReceipt;
  let verifyReceipt;
  let canonicalize;
  let resetKeys;

  before(async () => {
    delete process.env.CAPABILITY_RECEIPT_KEY_PEM;
    delete process.env.OPTIMUS_ORG_ID;
    const mod = await import('../../lib/audit/capability-receipt.js');
    ({ signReceipt, verifyReceipt, canonicalize, _resetForTest: resetKeys } = mod);
    resetKeys();
  });

  const minimalReceipt = () => ({
    receipt_version: '1',
    origin_org: 'self',
    grant_id: '00000000-0000-0000-0000-000000000001',
    agent_sub: 'agent:executor-research',
    agent_tier: 'executor',
    action: 'rag_query',
    document_ids: ['doc-1', 'doc-2'],
    classification_ceiling: 1,
    issued_at: '2026-05-15T00:00:00Z',
    transition_hash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  });

  describe('canonicalize (RFC 8785 JCS)', () => {
    it('sorts object keys recursively', () => {
      const got = canonicalize({ b: 2, a: 1, c: { y: 2, x: 1 } });
      assert.equal(got, '{"a":1,"b":2,"c":{"x":1,"y":2}}');
    });

    it('produces identical output regardless of input key order', () => {
      const a = canonicalize({ x: 1, y: { b: 2, a: 1 } });
      const b = canonicalize({ y: { a: 1, b: 2 }, x: 1 });
      assert.equal(a, b);
    });

    it('preserves array element order', () => {
      assert.equal(canonicalize([3, 1, 2]), '[3,1,2]');
    });

    it('handles null and primitives', () => {
      assert.equal(canonicalize(null), 'null');
      assert.equal(canonicalize(42), '42');
      assert.equal(canonicalize('hello'), '"hello"');
      assert.equal(canonicalize(true), 'true');
    });
  });

  describe('signReceipt / verifyReceipt round-trip', () => {
    it('signs and verifies a valid receipt', () => {
      const signed = signReceipt(minimalReceipt());
      assert.ok(signed.signature?.startsWith('ed25519:'), 'signature must be ed25519: prefixed');
      assert.equal(verifyReceipt(signed), true, 'round-trip must verify');
    });

    it('signature changes when any field changes (tamper detection)', () => {
      const signed = signReceipt(minimalReceipt());
      const tampered = { ...signed, action: 'admin_override' };
      assert.equal(verifyReceipt(tampered), false, 'tampered receipt must NOT verify');
    });

    it('signature is stable across key-order permutations of the same logical receipt', () => {
      const r1 = minimalReceipt();
      const r2 = {
        // Same fields, opposite order.
        transition_hash: r1.transition_hash,
        issued_at: r1.issued_at,
        classification_ceiling: r1.classification_ceiling,
        document_ids: [...r1.document_ids],
        action: r1.action,
        agent_tier: r1.agent_tier,
        agent_sub: r1.agent_sub,
        grant_id: r1.grant_id,
        origin_org: r1.origin_org,
        receipt_version: r1.receipt_version,
      };
      const s1 = signReceipt(r1);
      const s2 = signReceipt(r2);
      assert.equal(s1.signature, s2.signature, 'canonicalization must produce identical signatures');
    });

    it('refuses to re-sign an already-signed receipt', () => {
      const signed = signReceipt(minimalReceipt());
      assert.throws(() => signReceipt(signed), /already has a signature/);
    });

    it('rejects malformed envelopes', () => {
      assert.throws(() => signReceipt({ ...minimalReceipt(), receipt_version: '2' }), /Unsupported receipt_version/);
      assert.throws(() => signReceipt({ ...minimalReceipt(), transition_hash: 'md5:abc' }), /sha256:/);
      assert.throws(() => signReceipt({ ...minimalReceipt(), classification_ceiling: 7 }), /classification_ceiling/);
      assert.throws(() => signReceipt({ ...minimalReceipt(), action: '' }), /missing required string field: action/);
    });

    it('verifyReceipt requires an ed25519: signature prefix', () => {
      const r = minimalReceipt();
      assert.throws(() => verifyReceipt({ ...r, signature: 'rsa:not-ed25519' }), /ed25519:/);
      assert.throws(() => verifyReceipt(r), /signature/);
    });

    it('throws structured error for remote origin (deferred path)', () => {
      const signed = signReceipt(minimalReceipt());
      // Pretend the receipt came from a different org by editing origin_org
      // after signing. (Sig will mismatch anyway, but the origin check fires
      // first.)
      const remote = { ...signed, origin_org: 'umb-advisors' };
      try {
        verifyReceipt(remote);
        assert.fail('expected throw');
      } catch (err) {
        assert.equal(err.code, 'REMOTE_ORIGIN_NOT_IMPLEMENTED');
        assert.equal(err.origin_org, 'umb-advisors');
      }
    });
  });
});
