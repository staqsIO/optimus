// STAQPRO-263 / ADR-018: withAgentScope must accept JWT and (in enforcement
// mode) reject plain-string agentId. Covers the verification boundary added
// in lib/db.js — agent identity becomes cryptographically verifiable.

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initializeJwtKeys, issueAgentToken } from '../../lib/runtime/agent-jwt.js';

let withAgentScope;
let close = async () => {};

describe('withAgentScope — JWT enforcement (STAQPRO-263)', () => {
  let validToken;

  before(async () => {
    // Use PGlite (no DATABASE_URL) so this runs in CI without a postgres service.
    delete process.env.DATABASE_URL;
    ({ withAgentScope, close } = await import('../../lib/db.js'));
    await initializeJwtKeys();
    const issued = issueAgentToken('test-agent', { tier: 'orchestrator', tools: ['db:read'] });
    validToken = issued.token;
  });

  after(async () => {
    delete process.env.REQUIRE_AGENT_JWT;
    await close();
  });

  beforeEach(() => {
    // Ensure each test starts with enforcement off; tests opt-in explicitly.
    delete process.env.REQUIRE_AGENT_JWT;
  });

  it('accepts a valid JWT and derives agentId from the sub claim', async () => {
    const scoped = await withAgentScope(validToken);
    assert.equal(scoped.agentId, 'test-agent', 'agentId must come from JWT sub claim');
    assert.equal(scoped.identitySource, 'jwt', 'identity source must be reported as jwt');
    await scoped.release();
  });

  it('accepts a plain agentId string with a warning when enforcement is off', async () => {
    const scoped = await withAgentScope('test-agent');
    assert.equal(scoped.agentId, 'test-agent');
    assert.equal(scoped.identitySource, 'string', 'legacy path identity source must be reported as string');
    await scoped.release();
  });

  it('rejects a plain agentId string when REQUIRE_AGENT_JWT=true', async () => {
    process.env.REQUIRE_AGENT_JWT = 'true';
    await assert.rejects(
      () => withAgentScope('test-agent'),
      /REQUIRE_AGENT_JWT/,
      'plain string must be rejected in enforcement mode'
    );
  });

  it('still accepts a valid JWT when REQUIRE_AGENT_JWT=true', async () => {
    process.env.REQUIRE_AGENT_JWT = 'true';
    const scoped = await withAgentScope(validToken);
    assert.equal(scoped.agentId, 'test-agent');
    assert.equal(scoped.identitySource, 'jwt');
    await scoped.release();
  });

  // STAQPRO-307 regression: prove agent context persists across multiple
  // queries on a single scoped session. Before the fix, set_config(..., true)
  // outside an explicit transaction would evaporate after the implicit auto-
  // commit, and the second query would see app.agent_id=NULL. The fix wraps
  // the scoped session in an explicit BEGIN/COMMIT so transaction-local
  // settings persist for the whole session.
  it('agent context persists across multiple queries (STAQPRO-307)', async () => {
    const scoped = await withAgentScope(validToken);
    try {
      const r1 = await scoped(`SELECT current_setting('app.agent_id', true) AS aid`);
      const r2 = await scoped(`SELECT current_setting('app.agent_id', true) AS aid`);
      assert.equal(r1.rows[0].aid, 'test-agent', 'first query must see agent_id');
      assert.equal(r2.rows[0].aid, 'test-agent', 'second query on same scope must STILL see agent_id (regression: pre-fix returned NULL on pgbouncer)');
    } finally {
      await scoped.release();
    }
  });

  it('rejects a tampered JWT signature', async () => {
    // Flip the last 5 chars of the signature segment.
    const tampered = validToken.slice(0, -5) + 'XXXXX';
    await assert.rejects(
      () => withAgentScope(tampered),
      /signature/i,
      'tampered token must fail signature verification'
    );
  });

  it('rejects a malformed JWT-shaped string', async () => {
    // Three parts but middle segment is invalid base64url.
    const malformed = 'aaa.bbb.ccc';
    await assert.rejects(
      () => withAgentScope(malformed),
      /JWT/i,
      'malformed token must throw'
    );
  });
});
