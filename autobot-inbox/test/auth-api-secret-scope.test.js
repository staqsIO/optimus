/**
 * OPT-148 / ADR-019 — api_secret carries NO board-human identity.
 *
 * The shared INBOX_API_SECRET is an infrastructure secret with no human behind
 * it. Before this fix, resolveAuth() promoted the client-supplied `x-board-user`
 * header into `req.auth.github_username`, so any secret holder could (a) pass
 * the ~8 `role:'board' && github_username` write gates as any board member and
 * (b) reach resolveImpersonationEmail() to impersonate that member's Google
 * Drive via domain-wide delegation.
 *
 * This suite asserts:
 *   (a) the api_secret mint yields github_username:null even when x-board-user
 *       is present (identity is NOT derived from the header);
 *   (b) resolveImpersonationEmail rejects an api_secret principal (source!=='jwt')
 *       even if a github_username were somehow set → 403;
 *   (c) resolveImpersonationEmail accepts a verified board-JWT principal
 *       (source:'jwt', active board member) → returns the server-derived email;
 *   (d) the operational source==='api_secret' path (document-access.js
 *       documentsReadableFilter) still treats api_secret as ops tooling.
 *
 * Runs on the default PGlite test DB (no real Postgres required).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';
import { resolveAuth, resolveImpersonationEmail } from '../src/api.js';
import { documentsReadableFilter } from '../src/api-routes/document-access.js';

const API_SECRET = 'test-opt148-shared-secret';
const DELEGATED_DOMAIN = 'staqs.io';
// A board member seeded for the impersonation test. github_username is unique
// per run to avoid collisions with setup-db's default board_members seeds.
const JWT_MEMBER = {
  github_username: 'opt148_jwt_member',
  email: `opt148.jwt.member@${DELEGATED_DOMAIN}`,
};

describe('OPT-148: api_secret carries no board-human identity', () => {
  let query;
  let prevApiSecret;
  let prevDomains;

  before(async () => {
    ({ query } = await getDb());

    // requireLegacyAuth() reads process.env.API_SECRET; resolveImpersonationEmail
    // validates the email domain against WORKSPACE_DELEGATED_DOMAINS.
    prevApiSecret = process.env.API_SECRET;
    prevDomains = process.env.WORKSPACE_DELEGATED_DOMAINS;
    process.env.API_SECRET = API_SECRET;
    process.env.WORKSPACE_DELEGATED_DOMAINS = DELEGATED_DOMAIN;

    // Seed the active board member resolveImpersonationEmail will look up (c).
    await query(
      `INSERT INTO agent_graph.board_members (github_username, display_name, email, role, is_active)
       VALUES ($1, $2, $3, 'admin', true)
       ON CONFLICT (github_username) DO UPDATE
         SET email = EXCLUDED.email, is_active = true`,
      [JWT_MEMBER.github_username, 'OPT-148 JWT Member', JWT_MEMBER.email],
    );
  });

  after(() => {
    if (prevApiSecret === undefined) delete process.env.API_SECRET;
    else process.env.API_SECRET = prevApiSecret;
    if (prevDomains === undefined) delete process.env.WORKSPACE_DELEGATED_DOMAINS;
    else process.env.WORKSPACE_DELEGATED_DOMAINS = prevDomains;
  });

  it('(a) api_secret mint never derives github_username from x-board-user', async () => {
    const req = {
      headers: {
        authorization: `Bearer ${API_SECRET}`,
        'x-board-user': 'ecgang', // a real board member username — must be IGNORED
      },
    };

    const ok = await resolveAuth(req);
    assert.equal(ok, true, 'api_secret Bearer should authenticate');
    assert.equal(req.auth.role, 'board', 'role stays board (ops tooling tier)');
    assert.equal(req.auth.source, 'api_secret', 'source is api_secret');
    assert.equal(
      req.auth.github_username,
      null,
      'github_username MUST be null — identity is NOT taken from x-board-user',
    );
  });

  it('(b) resolveImpersonationEmail rejects an api_secret principal (403)', async () => {
    // Even if a github_username were somehow attached to an api_secret caller,
    // the source!=='jwt' guard must reject it — DWD Drive is JWT-only.
    const req = {
      headers: {},
      auth: {
        sub: 'legacy',
        role: 'board',
        source: 'api_secret',
        github_username: JWT_MEMBER.github_username, // forced — must still be rejected
      },
    };

    await assert.rejects(
      () => resolveImpersonationEmail(req),
      (err) => {
        assert.equal(err.statusCode, 403, 'api_secret → 403, never reaches Drive');
        return true;
      },
    );
  });

  it('(c) resolveImpersonationEmail accepts a verified board-JWT principal', async () => {
    const req = {
      headers: {},
      auth: {
        sub: JWT_MEMBER.github_username,
        role: 'board',
        source: 'jwt', // signature-verified board JWT (set by resolveAuth JWT branch)
        github_username: JWT_MEMBER.github_username,
      },
    };

    const email = await resolveImpersonationEmail(req);
    assert.equal(
      email,
      JWT_MEMBER.email,
      'email is server-derived from board_members for the verified board JWT',
    );
  });

  it('(d) operational api_secret path still treated as ops tooling (document-access)', () => {
    // documentsReadableFilter: api_secret is operational tooling → unrestricted
    // (restrict:false), distinct from a board HUMAN (which would be restrict:true).
    const opsReq = {
      auth: { sub: 'legacy', role: 'board', source: 'api_secret', github_username: null },
    };
    const opsFilter = documentsReadableFilter(opsReq);
    assert.deepEqual(
      opsFilter,
      { restrict: false, memberId: null },
      'api_secret remains ops tooling (unrestricted), unaffected by the null github_username',
    );

    // Contrast: a board human (source:'jwt' with sub) is owner-restricted.
    const humanReq = {
      auth: { sub: 'member-uuid', role: 'board', source: 'jwt', github_username: 'ecgang' },
    };
    const humanFilter = documentsReadableFilter(humanReq);
    assert.deepEqual(
      humanFilter,
      { restrict: true, memberId: 'member-uuid' },
      'board human is owner-restricted (proves the two paths are distinct)',
    );
  });
});
