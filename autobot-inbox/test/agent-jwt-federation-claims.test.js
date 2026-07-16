// STAQPRO-358 / ADR-018 addendum: verify the federation claim extension on
// agent JWTs. Tokens issued with v2 shape (composite iss + org + aud);
// verifier accepts v1 tokens during rollout, enforces v2 when
// REQUIRE_FEDERATION_CLAIMS=true.

import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  initializeJwtKeys,
  issueAgentToken,
  verifyAgentToken,
  getOrgDid,
  _issueLegacyTokenForTest,
  _signClaimsForTest,
} from '../../lib/runtime/agent-jwt.js';

describe('agent JWT — federation claim extension (STAQPRO-358)', () => {
  before(async () => {
    await initializeJwtKeys();
  });

  afterEach(() => {
    delete process.env.REQUIRE_FEDERATION_CLAIMS;
    delete process.env.ORG_DID;
  });

  describe('issueAgentToken — v2 claim shape', () => {
    it('emits org and aud claims defaulting to "self" when ORG_DID unset', () => {
      delete process.env.ORG_DID;
      const { token } = issueAgentToken('test-agent', { type: 'executor', tools: [] });
      const claims = verifyAgentToken(token);
      assert.equal(claims.org, 'self');
      assert.equal(claims.aud, 'self');
      assert.equal(claims.iss, 'optimus-agent@self');
    });

    it('reflects ORG_DID env var into iss, org, and aud claims', () => {
      process.env.ORG_DID = 'did:web:staqs.io';
      const { token } = issueAgentToken('test-agent', { type: 'executor', tools: [] });
      const claims = verifyAgentToken(token);
      assert.equal(claims.iss, 'optimus-agent@did:web:staqs.io');
      assert.equal(claims.org, 'did:web:staqs.io');
      assert.equal(claims.aud, 'did:web:staqs.io');
    });

    it('getOrgDid() reads env at call time so tests can flip it', () => {
      process.env.ORG_DID = 'did:web:umbadvisors.com';
      assert.equal(getOrgDid(), 'did:web:umbadvisors.com');
      delete process.env.ORG_DID;
      assert.equal(getOrgDid(), 'self');
    });
  });

  describe('verifyAgentToken — v1 backward compatibility', () => {
    it('accepts legacy v1 tokens (iss="optimus-agent", no org/aud) and defaults to "self"', () => {
      const { token } = _issueLegacyTokenForTest('test-agent', { type: 'executor', tools: [] });
      const claims = verifyAgentToken(token);
      assert.equal(claims.iss, 'optimus-agent');
      assert.equal(claims.org, 'self', 'v1 token must default org to "self"');
      assert.equal(claims.aud, 'self', 'v1 token must default aud to "self"');
      assert.equal(claims.sub, 'test-agent');
    });

    it('rejects a token whose iss prefix is not "optimus-agent" (board token leak guard)', () => {
      const now = Math.floor(Date.now() / 1000);
      const token = _signClaimsForTest({
        iss: 'optimus-board@did:web:staqs.io',
        sub: 'test-agent',
        org: 'did:web:staqs.io',
        aud: 'did:web:staqs.io',
        iat: now,
        exp: now + 60,
        jti: 'test',
      });
      assert.throws(
        () => verifyAgentToken(token),
        /Invalid JWT issuer prefix/,
        'board-tier tokens must not be accepted by the agent verifier'
      );
    });

    it('rejects a token with an empty iss claim', () => {
      const now = Math.floor(Date.now() / 1000);
      const token = _signClaimsForTest({
        sub: 'test-agent',
        iat: now,
        exp: now + 60,
        jti: 'test',
      });
      assert.throws(
        () => verifyAgentToken(token),
        /Invalid JWT issuer prefix/,
        'tokens without iss must be rejected'
      );
    });
  });

  describe('always-on consistency check', () => {
    it('rejects a token where iss org suffix and org claim disagree', () => {
      const now = Math.floor(Date.now() / 1000);
      const token = _signClaimsForTest({
        iss: 'optimus-agent@did:web:staqs.io',
        sub: 'test-agent',
        org: 'did:web:umbadvisors.com', // disagrees with iss suffix
        aud: 'did:web:staqs.io',
        iat: now,
        exp: now + 60,
        jti: 'test',
      });
      assert.throws(
        () => verifyAgentToken(token),
        /does not match iss org suffix/,
        'iss-suffix vs org-claim mismatch must be rejected even without enforcement flag'
      );
    });
  });

  describe('verifyAgentToken — strict enforcement (REQUIRE_FEDERATION_CLAIMS=true)', () => {
    it('rejects v1 tokens (missing org claim)', () => {
      const { token } = _issueLegacyTokenForTest('test-agent', { type: 'executor', tools: [] });
      process.env.REQUIRE_FEDERATION_CLAIMS = 'true';
      assert.throws(
        () => verifyAgentToken(token),
        /Missing required `org` claim/,
        'v1 token must be rejected under federation enforcement'
      );
    });

    it('rejects v2 tokens whose aud does not match this process ORG_DID', () => {
      process.env.ORG_DID = 'did:web:staqs.io';
      const { token } = issueAgentToken('test-agent', { type: 'executor', tools: [] });

      // Same process, different ORG_DID — simulates a token issued for Staqs being
      // replayed against UMB.
      process.env.ORG_DID = 'did:web:umbadvisors.com';
      process.env.REQUIRE_FEDERATION_CLAIMS = 'true';

      assert.throws(
        () => verifyAgentToken(token),
        /aud mismatch/,
        'aud=staqs.io must not be accepted when ORG_DID=umbadvisors.com'
      );
    });

    it('accepts v2 tokens whose aud matches this process ORG_DID', () => {
      process.env.ORG_DID = 'did:web:staqs.io';
      const { token } = issueAgentToken('test-agent', { type: 'executor', tools: [] });
      process.env.REQUIRE_FEDERATION_CLAIMS = 'true';

      const claims = verifyAgentToken(token);
      assert.equal(claims.aud, 'did:web:staqs.io');
      assert.equal(claims.org, 'did:web:staqs.io');
    });
  });
});
