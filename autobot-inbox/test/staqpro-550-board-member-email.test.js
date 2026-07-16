/**
 * STAQPRO-550 — /api/board-member must return the canonical work email.
 *
 * The NextAuth jwt callback backfills session.user.email from this field when
 * GitHub withholds the account's primary email (private email → profile.email
 * is null). /today meeting-attendee matching keys on the viewer email, so the
 * board-member lookup is the only source of a stable, canonical email for those
 * accounts.
 *
 * Mirrors the seed-and-clean sentinel pattern of board-endpoint.test.js:
 * unique `staqpro550-*` github_username so cleanup is surgical against the
 * shared PGlite singleton.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';
import { getBoardMember } from '../src/api.js';

describe('GET /api/board-member — STAQPRO-550 email field', () => {
  let query;

  const USERNAME = 'staqpro550-tester';
  const EMAIL = 'staqpro550@staqs.io';

  function mockReq(username) {
    const qs = username === undefined ? '' : `?username=${encodeURIComponent(username)}`;
    return { url: `/api/board-member${qs}`, headers: {} };
  }

  before(async () => {
    ({ query } = await getDb());
    await query(`DELETE FROM agent_graph.board_members WHERE github_username = $1`, [USERNAME]);
    await query(
      `INSERT INTO agent_graph.board_members (github_username, display_name, email, role)
       VALUES ($1, 'STAQPRO550 Tester', $2, 'member')`,
      [USERNAME, EMAIL]
    );
  });

  after(async () => {
    await query(`DELETE FROM agent_graph.board_members WHERE github_username = $1`, [USERNAME]);
  });

  it('returns the canonical work email for a known board member', async () => {
    const res = await getBoardMember(mockReq(USERNAME));
    assert.equal(res.email, EMAIL, 'email field must carry the board member work email');
    assert.equal(res.display_name, 'STAQPRO550 Tester');
    assert.equal(res.role, 'member');
    assert.ok(res.id, 'id must be present so the jwt callback enriches the token');
  });

  it('returns an error (no email) for an unknown username', async () => {
    const res = await getBoardMember(mockReq('staqpro550-nobody-here'));
    assert.equal(res.error, 'not_found');
    assert.equal(res.email, undefined);
  });

  it('requires the username parameter', async () => {
    const res = await getBoardMember(mockReq());
    assert.equal(res.error, 'username parameter required');
  });
});
