// OPT-166: nine call sites (5 flow-wrappers + api-routes/blueprint.js) called
// withAgentScope('<plain-agentId>') directly with no JWT and no surrounding
// catch, so they hard-throw once REQUIRE_AGENT_JWT=true is enforced in
// production. openAgentScope() (lib/runtime/agents/agent-scope.js) is the
// drop-in replacement: it mints (and caches) a real JWT for the agent, and
// falls back to the plain-id path only when key material isn't available
// (tests/CLI/PGlite contexts that never called initializeJwtKeys()).

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { initializeJwtKeys } from '../../lib/runtime/agent-jwt.js';
import { openAgentScope, _peekCachedTokenForTest } from '../../lib/runtime/agents/agent-scope.js';

let close = async () => {};

describe('openAgentScope — OPT-166 latent plain-string scope helper', () => {
  before(async () => {
    // Use PGlite (no DATABASE_URL) so this runs in CI without a postgres service.
    delete process.env.DATABASE_URL;
    ({ close } = await import('../../lib/db.js'));
  });

  after(async () => {
    delete process.env.REQUIRE_AGENT_JWT;
    await close();
  });

  // (c) MUST run before initializeJwtKeys() is called anywhere in this file/
  // process — lib/runtime/agents/agent-jwt.js has no de-init, so once keys
  // are initialized they stay initialized for the rest of the process.
  it('falls back to the plain-agentId path without throwing when JWT keys are not initialized', async () => {
    const scoped = await openAgentScope('unkeyed-test-agent');
    assert.equal(scoped.agentId, 'unkeyed-test-agent');
    assert.equal(scoped.identitySource, 'string', 'must fall back to the plain-string path, not a JWT');
    await scoped.release();
  });

  describe('with JWT keys initialized', () => {
    before(async () => {
      await initializeJwtKeys();
    });

    // (a) keys initialized → openAgentScope returns a working scoped query
    // whose token withAgentScope accepts.
    it('mints a JWT for a configured agent and returns a working scoped query', async () => {
      const scoped = await openAgentScope('executor-responder');
      assert.equal(scoped.agentId, 'executor-responder', 'agentId must round-trip through the minted JWT sub claim');
      assert.equal(scoped.identitySource, 'jwt', 'openAgentScope must mint and use a real JWT, not the plain-string fallback');
      await scoped.release();
    });

    // Required implementation detail: an agentId with no agents.json entry
    // must still mint (tier falls back to 'executor' via TIER_MAP default).
    it('mints a JWT for an agentId with no agents.json entry (graceful config fallback)', async () => {
      const scoped = await openAgentScope('agent-scope-test-unconfigured');
      assert.equal(scoped.agentId, 'agent-scope-test-unconfigured');
      assert.equal(scoped.identitySource, 'jwt');
      await scoped.release();
    });

    // (b) token caching: two calls within TTL mint once.
    it('caches the minted token across calls within the TTL/refresh window', async () => {
      const scopedFirst = await openAgentScope('strategist');
      await scopedFirst.release();
      const cachedAfterFirst = _peekCachedTokenForTest('strategist');
      assert.ok(cachedAfterFirst, 'token cache must be populated after the first call');

      const scopedSecond = await openAgentScope('strategist');
      await scopedSecond.release();
      const cachedAfterSecond = _peekCachedTokenForTest('strategist');

      assert.equal(
        cachedAfterSecond.token,
        cachedAfterFirst.token,
        'a second call within the TTL/refresh window must reuse the cached token, not mint a new one'
      );
    });
  });
});
