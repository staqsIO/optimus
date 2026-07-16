/**
 * Feature 007 — configurable D4 source precedence (per-org + per-user).
 *
 * Deterministic + offline on PGlite. Invariants:
 *   1. SYSTEM DEFAULT (no prefs): drive > tldv > mcp — Gemini wins primary.
 *   2. ORG DEFAULT overrides system for org-shared meetings + members with no
 *      own pref; setting it re-picks existing meetings.
 *   3. USER OVERRIDE wins for that user's personal meetings; an org-shared
 *      meeting never reads a user row.
 *   4. RESOLUTION chain user → org → system, computed per meeting scope.
 *   5. VALIDATION: unknown kinds / dupes / empty rejected (400).
 *   6. CLEAR reverts to the inherited level.
 *   7. API: GET returns the three layers; PATCH gates org-level on a board human.
 *   8. routeKeyFor resolves the registry routes (incl. the exact
 *      source-precedence sub-route winning over /:id).
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';

const { createArtifact } = await import('../../lib/content/create-artifact.js');
const { resolveSourcePrecedence, setSourcePrecedence, validatePrecedence, SYSTEM_DEFAULT_PRECEDENCE } =
  await import('../../lib/content/meeting-prefs.js');
const { registerMeetingRegistryRoutes } = await import('../src/api-routes/meeting-registry.js');
const { routeKeyFor } = await import('../src/api.js');

const UMB_ORG = '11111111-1111-1111-1111-111111111111';
const MEMBER_UMB = 'bbbbbbbb-0000-0000-0000-0000000000b2';
const OTHER_UMB = 'cccccccc-0000-0000-0000-0000000000c3';

let query;
let routes;
const P = (userId, orgs) => ({ userId, readOrgIds: orgs, orgIds: orgs, roles: {}, adminBypass: false });

// Capture both a tldv and a drive transcript for one calendar-anchored meeting in
// a given scope; returns { meetingId, drive, tldv }.
async function captureBoth({ cal, ownerOrgId, ownerId = null, tag }) {
  const drive = await createArtifact({
    raw: `gemini notes ${tag}`, kind: 'transcript', title: `${tag} Sync`,
    source_system: 'drive', ownerOrgId, ownerId,
    meeting: { calendarEventId: cal, title: `${tag} Sync`, startTime: '2026-06-10T17:00:00Z', participantEmails: [], fallbackId: `file-${tag}`, participantsAreAttendees: false },
  });
  const tldv = await createArtifact({
    raw: `tldv verbatim ${tag}`, kind: 'transcript', title: `${tag} Sync`,
    source_system: 'tldv', ownerOrgId, ownerId,
    meeting: { calendarEventId: cal, title: `${tag} Sync`, startTime: '2026-06-10T17:00:00Z', participantEmails: ['eric@staqs.io'], fallbackId: `tldv-${tag}` },
  });
  return { meetingId: drive.meetingId, drive, tldv };
}

async function primaryOf(meetingId) {
  return (await query(`SELECT primary_transcript_id FROM content.meetings WHERE id = $1`, [meetingId]))
    .rows[0].primary_transcript_id;
}

before(async () => {
  ({ query } = await getDb());
  await query(
    `INSERT INTO agent_graph.board_members (id, github_username, display_name, role)
     VALUES ($1,'msp-umb','MSP UMB','member'), ($2,'msp-umb2','MSP UMB2','member')
     ON CONFLICT (id) DO NOTHING`,
    [MEMBER_UMB, OTHER_UMB]
  );
  routes = new Map();
  registerMeetingRegistryRoutes(routes, { withViewer: async (req) => ({ principal: req.__principal }) });
});

describe('validation', () => {
  it('rejects unknown kinds, dupes, and empties; accepts a subset', () => {
    assert.throws(() => validatePrecedence(['drive', 'zoom']), /unknown meeting source/);
    assert.throws(() => validatePrecedence(['drive', 'drive']), /duplicate/);
    assert.throws(() => validatePrecedence([]), /non-empty/);
    assert.deepEqual(validatePrecedence(['tldv', 'drive']), ['tldv', 'drive']);
    assert.deepEqual(validatePrecedence(['tldv']), ['tldv']); // subset OK
  });
});

describe('resolution chain + recompute', () => {
  it('system default picks Gemini (drive) over tldv', async () => {
    const { meetingId, drive } = await captureBoth({ cal: 'gcal-sp-sys', ownerOrgId: UMB_ORG, tag: 'Sys' });
    const r = await resolveSourcePrecedence(query, UMB_ORG, null);
    assert.equal(r.source, 'system');
    assert.deepEqual(r.precedence, [...SYSTEM_DEFAULT_PRECEDENCE]);
    assert.equal(await primaryOf(meetingId), drive.artifactId, 'system default → Gemini primary');
  });

  it('org default flips precedence to tldv and re-picks existing org meetings', async () => {
    const { meetingId, drive, tldv } = await captureBoth({ cal: 'gcal-sp-org', ownerOrgId: UMB_ORG, tag: 'Org' });
    assert.equal(await primaryOf(meetingId), drive.artifactId, 'starts Gemini (system default)');

    const res = await setSourcePrecedence({ ownerOrgId: UMB_ORG, ownerId: null, precedence: ['tldv', 'drive'], updatedBy: MEMBER_UMB });
    assert.equal(res.ok, true);
    assert.ok(res.recomputed >= 1, 'org-default change re-picks existing meetings');

    const r = await resolveSourcePrecedence(query, UMB_ORG, null);
    assert.equal(r.source, 'org');
    assert.equal(await primaryOf(meetingId), tldv.artifactId, 'org default → tldv now primary');
  });

  it('user override wins for that user; org default still applies to a different user', async () => {
    // Org default is tldv>drive (from the previous test, same UMB_ORG).
    const mine = await captureBoth({ cal: 'gcal-sp-mine', ownerOrgId: UMB_ORG, ownerId: MEMBER_UMB, tag: 'Mine' });
    const theirs = await captureBoth({ cal: 'gcal-sp-theirs', ownerOrgId: UMB_ORG, ownerId: OTHER_UMB, tag: 'Theirs' });

    // Under the org default (tldv>drive), both personal meetings start tldv.
    assert.equal(await primaryOf(mine.meetingId), mine.tldv.artifactId);

    // I set a personal override back to Gemini-first.
    const res = await setSourcePrecedence({ ownerOrgId: UMB_ORG, ownerId: MEMBER_UMB, precedence: ['drive', 'tldv'], updatedBy: MEMBER_UMB });
    assert.ok(res.recomputed >= 1);

    assert.equal(await primaryOf(mine.meetingId), mine.drive.artifactId, 'my override → Gemini for MY meeting');
    assert.equal(await primaryOf(theirs.meetingId), theirs.tldv.artifactId, 'other user still on the org default (tldv)');

    const rMine = await resolveSourcePrecedence(query, UMB_ORG, MEMBER_UMB);
    assert.equal(rMine.source, 'user');
    const rTheirs = await resolveSourcePrecedence(query, UMB_ORG, OTHER_UMB);
    assert.equal(rTheirs.source, 'org');
  });

  it('clearing the user override reverts to the org default', async () => {
    const mine = await captureBoth({ cal: 'gcal-sp-revert', ownerOrgId: UMB_ORG, ownerId: MEMBER_UMB, tag: 'Revert' });
    // I currently have a drive-first override → Gemini primary.
    assert.equal(await primaryOf(mine.meetingId), mine.drive.artifactId);
    await setSourcePrecedence({ ownerOrgId: UMB_ORG, ownerId: MEMBER_UMB, precedence: null, updatedBy: MEMBER_UMB });
    const r = await resolveSourcePrecedence(query, UMB_ORG, MEMBER_UMB);
    assert.equal(r.source, 'org', 'reverts to org default after clear');
    assert.equal(await primaryOf(mine.meetingId), mine.tldv.artifactId, 'back to org default (tldv)');
  });
});

describe('API surface', () => {
  it('GET returns the three layers + effective ordering', async () => {
    const handler = routes.get('GET /api/meeting-registry/source-precedence');
    const out = await handler({ url: '/api/meeting-registry/source-precedence', __principal: P(OTHER_UMB, [UMB_ORG]) });
    assert.equal(out.ok, true);
    assert.deepEqual(out.system_default, [...SYSTEM_DEFAULT_PRECEDENCE]);
    assert.deepEqual(out.org, ['tldv', 'drive']);   // set earlier
    assert.equal(out.user, null);                   // OTHER_UMB has none
    assert.deepEqual(out.effective, ['tldv', 'drive']);
  });

  it('PATCH user-level needs only an authed member; org-level needs a board human', async () => {
    const patch = routes.get('PATCH /api/meeting-registry/source-precedence');

    // user scope: a plain member can set their own.
    const u = await patch(
      { url: '/api/meeting-registry/source-precedence', __principal: P(OTHER_UMB, [UMB_ORG]) },
      { scope: 'user', precedence: ['drive', 'tldv'] }
    );
    assert.equal(u.ok, true);
    assert.equal(u.scope, 'user');

    // org scope without board auth → 403.
    await assert.rejects(
      () => patch(
        { url: '/api/meeting-registry/source-precedence', __principal: P(OTHER_UMB, [UMB_ORG]) },
        { scope: 'org', precedence: ['drive', 'tldv'] }
      ),
      /requires a board member/
    );

    // org scope WITH a board human → ok.
    const o = await patch(
      { url: '/api/meeting-registry/source-precedence', auth: { role: 'board', github_username: 'ecgang' }, __principal: P(MEMBER_UMB, [UMB_ORG]) },
      { scope: 'org', precedence: ['drive', 'tldv', 'mcp'] }
    );
    assert.equal(o.ok, true);
  });

  it('PATCH rejects a bad scope and a bad precedence', async () => {
    const patch = routes.get('PATCH /api/meeting-registry/source-precedence');
    await assert.rejects(
      () => patch({ url: '/x', __principal: P(OTHER_UMB, [UMB_ORG]) }, { scope: 'team', precedence: ['drive'] }),
      /scope must be/
    );
    await assert.rejects(
      () => patch({ url: '/x', __principal: P(OTHER_UMB, [UMB_ORG]) }, { scope: 'user', precedence: ['zoom'] }),
      /unknown meeting source/
    );
  });
});

describe('routeKeyFor resolves the registry routes (HTTP reachability)', () => {
  it('exact source-precedence sub-routes win over the :id matcher', () => {
    assert.equal(routeKeyFor('GET', '/api/meeting-registry/source-precedence'), 'GET /api/meeting-registry/source-precedence');
    assert.equal(routeKeyFor('PATCH', '/api/meeting-registry/source-precedence'), 'PATCH /api/meeting-registry/source-precedence');
  });
  it('param routes resolve (the previously-unreachable :id + promote)', () => {
    assert.equal(routeKeyFor('GET', '/api/meeting-registry/abc-123'), 'GET /api/meeting-registry/:id');
    assert.equal(routeKeyFor('POST', '/api/meeting-registry/abc-123/promote'), 'POST /api/meeting-registry/:id/promote');
  });
  it('the bare list is its own exact route', () => {
    assert.equal(routeKeyFor('GET', '/api/meeting-registry'), 'GET /api/meeting-registry');
  });
});
