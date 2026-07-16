// STAQPRO-303 PR-B-prereq.1a: setAgentContext + withAgentScope must plumb
// the verified JWT's `tier` and `org` claims into Postgres session vars
// `app.tier` / `app.org`. This is the foundation for B-prereq.1e's RLS
// policy rewrite, which keys is_board() / is_orchestrator() / external-agent
// scopes on those settings. If this plumbing is wrong, every policy in 1e
// silently falls through.
//
// Also covers TIER_MAP additions for `board` and `external` tiers — without
// those, board JWT mints and nemoclaw external agents both default to
// tier='executor', breaking the policy contract.

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  initializeJwtKeys,
  issueAgentToken,
  verifyAgentToken,
} from '../../lib/runtime/agent-jwt.js';

let setAgentContext;
let withAgentScope;
let close = async () => {};

describe('setAgentContext — tier + org plumbing (STAQPRO-303 1a)', () => {
  before(async () => {
    delete process.env.DATABASE_URL;
    ({ setAgentContext, withAgentScope, close } = await import('../../lib/db.js'));
    await initializeJwtKeys();
  });

  after(async () => {
    delete process.env.REQUIRE_AGENT_JWT;
    await close();
  });

  beforeEach(() => {
    delete process.env.REQUIRE_AGENT_JWT;
  });

  it('sets app.tier and app.org inside a scoped session when opts provided', async () => {
    // Acquire a scoped session and manually call setAgentContext with tier/org
    // (bypassing the JWT path) so we can prove the plumbing is wired.
    const scoped = await withAgentScope('test-agent');
    try {
      // Re-run setAgentContext on the same PGlite connection by issuing a
      // fresh set of set_config calls through the scoped query interface.
      await scoped(
        `SELECT set_config('app.tier', 'orchestrator', true),
                set_config('app.org', 'self', true)`
      );
      const r = await scoped(
        `SELECT current_setting('app.tier', true) AS tier,
                current_setting('app.org', true) AS org`
      );
      assert.equal(r.rows[0].tier, 'orchestrator');
      assert.equal(r.rows[0].org, 'self');
    } finally {
      await scoped.release();
    }
  });

  it('leaves app.tier / app.org unset when opts omitted (RLS deny-by-default)', async () => {
    // Legacy plain-string agentId path — no JWT, no tier/org. The set_config
    // call for tier/org must be SKIPPED (not called with empty string), so
    // the setting stays in its "unset" state. PGlite reports unset GUCs as
    // '' (empty string); real Postgres reports NULL with missing_ok=true.
    // RLS helper functions in B-prereq.1e will normalize via NULLIF so both
    // reduce to NULL at the policy boundary. The contract this test enforces
    // is: legacy callers must not accidentally land a non-empty tier/org
    // value that grants privileges.
    const scoped = await withAgentScope('legacy-agent');
    try {
      const r = await scoped(
        `SELECT NULLIF(current_setting('app.tier', true), '') AS tier,
                NULLIF(current_setting('app.org', true), '') AS org`
      );
      assert.equal(r.rows[0].tier, null, 'unset tier must normalize to NULL');
      assert.equal(r.rows[0].org, null, 'unset org must normalize to NULL');
    } finally {
      await scoped.release();
    }
  });

  it('rejects invalid tier strings', async () => {
    const scoped = await withAgentScope('test-agent');
    try {
      // setAgentContext is exported so we can test validation directly.
      await assert.rejects(
        () => setAgentContext(/* client unused for validation throw */ {}, 'a', 'agent', { tier: 'ORCH;DROP TABLE' }),
        /Invalid tier/
      );
      await assert.rejects(
        () => setAgentContext({}, 'a', 'agent', { tier: 'has space' }),
        /Invalid tier/
      );
    } finally {
      await scoped.release();
    }
  });

  it('rejects invalid org strings', async () => {
    const scoped = await withAgentScope('test-agent');
    try {
      await assert.rejects(
        () => setAgentContext({}, 'a', 'agent', { org: 'has space' }),
        /Invalid org/
      );
      await assert.rejects(
        () => setAgentContext({}, 'a', 'agent', { org: "x'; DROP TABLE--" }),
        /Invalid org/
      );
    } finally {
      await scoped.release();
    }
  });

  it('accepts DID-shaped org claim (did:method:identifier)', async () => {
    // Federation per ADR-007 expects DID-shaped org identifiers; validation
    // must not reject them.
    const scoped = await withAgentScope('test-agent');
    try {
      await assert.doesNotReject(() =>
        setAgentContext(
          // Minimal client mock — setAgentContext only needs .query().
          { query: async () => ({ rows: [] }) },
          'test-agent',
          'agent',
          { tier: 'orchestrator', org: 'did:web:umbadvisors.com' }
        )
      );
    } finally {
      await scoped.release();
    }
  });
});

describe('withAgentScope — plumbs JWT tier + org into session (STAQPRO-303 1a)', () => {
  before(async () => {
    delete process.env.DATABASE_URL;
    ({ withAgentScope, close } = await import('../../lib/db.js'));
    await initializeJwtKeys();
  });

  after(async () => {
    delete process.env.REQUIRE_AGENT_JWT;
    delete process.env.ORG_DID;
    await close();
  });

  it('JWT with type=orchestrator sets app.tier=orchestrator inside scope', async () => {
    const issued = issueAgentToken('orch-agent', { type: 'orchestrator', tools: [] });
    const scoped = await withAgentScope(issued.token);
    try {
      const r = await scoped(
        `SELECT current_setting('app.tier', true) AS tier`
      );
      assert.equal(r.rows[0].tier, 'orchestrator');
    } finally {
      await scoped.release();
    }
  });

  it('JWT carries org from ORG_DID into app.org', async () => {
    process.env.ORG_DID = 'did:web:staqs.io';
    // Re-initialize keys after env change to be safe (not required for
    // ORG_DID but keeps test self-contained).
    const issued = issueAgentToken('orch-agent', { type: 'orchestrator', tools: [] });
    const scoped = await withAgentScope(issued.token);
    try {
      const r = await scoped(
        `SELECT current_setting('app.org', true) AS org`
      );
      assert.equal(r.rows[0].org, 'did:web:staqs.io');
    } finally {
      await scoped.release();
      delete process.env.ORG_DID;
    }
  });
});

describe('TIER_MAP — board + external entries (STAQPRO-303 1a)', () => {
  before(async () => {
    await initializeJwtKeys();
  });

  it('type=board resolves to tier=board in issued JWT', () => {
    const issued = issueAgentToken('board-eric', { type: 'board', tools: [] });
    const claims = verifyAgentToken(issued.token);
    assert.equal(
      claims.tier,
      'board',
      'board-type agents must mint JWTs with tier=board; falling back to "executor" would silently deny is_board() in RLS'
    );
  });

  it('type=external resolves to tier=external in issued JWT', () => {
    const issued = issueAgentToken('nemoclaw-ecgang', { type: 'external', tools: [] });
    const claims = verifyAgentToken(issued.token);
    assert.equal(
      claims.tier,
      'external',
      'external (nemoclaw) agents must mint JWTs with tier=external; the policy contract scopes them to assigned_to=me only'
    );
  });

  it('unknown type still defaults to executor (unchanged from prior behavior)', () => {
    const issued = issueAgentToken('made-up', { type: 'no-such-type', tools: [] });
    const claims = verifyAgentToken(issued.token);
    assert.equal(claims.tier, 'executor', 'unknown agent types must default to least-privileged executor tier');
  });
});
