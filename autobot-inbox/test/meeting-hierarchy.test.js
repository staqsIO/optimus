/**
 * Feature 007 — meeting-note hierarchy: identity layer + org/personal dedup.
 *
 * Deterministic + offline on PGlite (setup-db helper). Invariants under test:
 *
 *   1. WITHIN-SCOPE DEDUP: the same call captured via TLDv and Drive (same
 *      calendar_event_id → same `cal:` fingerprint) lands as ONE content.meetings
 *      row with TWO child transcript artifacts; primary picked by D4 precedence
 *      (drive/Gemini > tldv); re-push idempotent.
 *   2. CONFIDENCE TIERS (Q1): doc-owner-only capture → 'weak'; real-attendee
 *      hash → 'derived'; calendar id → 'calendar'; re-capture never downgrades.
 *   3. CROSS-SCOPE (D3): personal + org captures of the same fingerprint are TWO
 *      rows, linked by fingerprint; visible-peer surfaced only under tenancy.
 *   4. PROMOTION: explicit personal→org re-owns artifacts, supersedes personal
 *      with lineage; non-owner gets 403 at the route.
 *   5. RECONCILER (3a): time+title(+attendees) recovers gcal_event_id; below-floor
 *      and ambiguous candidates fail closed.
 *   6. UPGRADE SWEEP (Q1): a 'weak' meeting re-keys to `cal:` when the calendar
 *      arrives (alias kept), or MERGES into an existing cal: peer.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';

const { createArtifact } = await import('../../lib/content/create-artifact.js');
const { upgradeWeakMeetings } = await import('../../lib/content/meetings.js');
const { resolveCalendarEventId, cleanMeetingTitle, titleSimilarity } =
  await import('../../lib/content/calendar-reconciler.js');
const { stripNoteTakerBots, attendeeEmailsOf } = await import('../../lib/rag/participants/normalize.js');
const { registerMeetingRegistryRoutes } = await import('../src/api-routes/meeting-registry.js');

const UMB_ORG = '11111111-1111-1111-1111-111111111111';
const STAQS_ORG = '7c164445-43f2-4802-a7d3-5cab06611e99';
const MEMBER_UMB = 'bbbbbbbb-0000-0000-0000-0000000000b2';
const MEMBER_STAQS = 'aaaaaaaa-0000-0000-0000-0000000000a1';

let query;
let routes;
const P = (userId, orgs) => ({ userId, readOrgIds: orgs, roles: {}, adminBypass: false });

before(async () => {
  ({ query } = await getDb());
  await query(
    `INSERT INTO agent_graph.board_members (id, github_username, display_name, role)
     VALUES ($1,'mh-test-umb','MH UMB','member'), ($2,'mh-test-staqs','MH Staqs','member')
     ON CONFLICT (id) DO NOTHING`,
    [MEMBER_UMB, MEMBER_STAQS]
  );
  routes = new Map();
  registerMeetingRegistryRoutes(routes, {
    withViewer: async (req) => ({ principal: req.__principal }),
  });
});

async function meetingByFingerprint(fp, orgId, ownerId = null) {
  const r = await query(
    `SELECT * FROM content.meetings
      WHERE meeting_fingerprint = $1 AND owner_org_id = $2
        AND COALESCE(owner_id, '00000000-0000-0000-0000-000000000000'::uuid)
          = COALESCE($3::uuid, '00000000-0000-0000-0000-000000000000'::uuid)`,
    [fp, orgId, ownerId]
  );
  return r.rows[0] || null;
}

describe('within-scope dedup + D4 primary precedence', () => {
  const CAL_ID = 'gcal-evt-006-a';
  const FP = `cal:${CAL_ID}`;

  it('TLDv + Drive captures of the same calendar event converge on ONE meeting', async () => {
    // Drive (Gemini) capture first — summarized notes, drive source.
    const drive = await createArtifact({
      raw: 'Gemini notes body for the Q3 sync — summarized.',
      kind: 'transcript',
      title: 'Q3 Sync - 2026/06/01 10:00 PDT - Notes by Gemini',
      source_system: 'drive',
      ownerOrgId: UMB_ORG,
      meeting: { calendarEventId: CAL_ID, title: 'Q3 Sync', startTime: '2026-06-01T17:00:00Z', participantEmails: [], fallbackId: 'file-006a', participantsAreAttendees: false },
    });
    assert.equal(drive.ok, true);
    assert.equal(drive.meetingFingerprint, FP);

    // TLDv capture second — full verbatim transcript, different bytes + title.
    const tldv = await createArtifact({
      raw: '[00:01] Eric: full verbatim transcript of the Q3 sync.',
      kind: 'transcript',
      title: 'Q3 Sync',
      source_system: 'tldv',
      ownerOrgId: UMB_ORG,
      meeting: { calendarEventId: CAL_ID, title: 'Q3 Sync', startTime: '2026-06-01T17:01:30Z', participantEmails: ['eric@staqs.io', 'kyle@umb.com'], fallbackId: 'tldv-006a' },
    });
    assert.equal(tldv.ok, true);
    assert.equal(tldv.meetingId, drive.meetingId, 'both captures share one meeting row');

    const m = await meetingByFingerprint(FP, UMB_ORG);
    assert.ok(m, 'meeting row exists');
    assert.equal(m.fingerprint_confidence, 'calendar');

    const kids = await query(
      `SELECT id, source_system FROM content.artifacts WHERE meeting_id = $1 AND kind = 'transcript'`,
      [m.id]
    );
    assert.equal(kids.rows.length, 2, 'two child transcript artifacts');

    // D4: Gemini-on-Drive outranks tldv for the primary pointer.
    assert.equal(m.primary_transcript_id, drive.artifactId);
  });

  it('re-pushing the same bytes is an idempotent no-op (still one meeting)', async () => {
    const again = await createArtifact({
      raw: '[00:01] Eric: full verbatim transcript of the Q3 sync.',
      kind: 'transcript',
      title: 'Q3 Sync',
      source_system: 'tldv',
      ownerOrgId: UMB_ORG,
      meeting: { calendarEventId: CAL_ID, title: 'Q3 Sync', startTime: '2026-06-01T17:01:30Z', participantEmails: ['eric@staqs.io'], fallbackId: 'tldv-006a' },
    });
    assert.equal(again.deduped, true);
    const rows = await query(
      `SELECT count(*)::int AS n FROM content.meetings WHERE meeting_fingerprint = $1 AND owner_org_id = $2`,
      [FP, UMB_ORG]
    );
    assert.equal(rows.rows[0].n, 1);
  });
});

describe('confidence tiers (Q1)', () => {
  it('doc-owner-only capture → weak; attendee-hash → derived; never downgrades', async () => {
    // Weak: no calendar id, participants are NOT real attendees.
    const weak = await createArtifact({
      raw: 'raw drive drop with no envelope',
      kind: 'transcript',
      title: 'Mystery Sync',
      source_system: 'drive',
      ownerOrgId: UMB_ORG,
      meeting: { title: 'Mystery Sync', startTime: '2026-06-02T17:00:00Z', participantEmails: [], fallbackId: 'file-weak-1', participantsAreAttendees: false },
    });
    let m = (await query(`SELECT * FROM content.meetings WHERE id = $1`, [weak.meetingId])).rows[0];
    assert.equal(m.fingerprint_confidence, 'weak');
    assert.match(m.meeting_fingerprint, /^mtg:/);

    // Derived: same fingerprint inputs can't collide here (emails change the
    // hash) — use a separate meeting with real attendee emails.
    const derived = await createArtifact({
      raw: 'tldv body, no calendar id known',
      kind: 'transcript',
      title: 'Attendee Sync',
      source_system: 'tldv',
      ownerOrgId: UMB_ORG,
      meeting: { title: 'Attendee Sync', startTime: '2026-06-02T18:00:00Z', participantEmails: ['a@x.com', 'b@y.com'], fallbackId: 'tldv-d1' },
    });
    m = (await query(`SELECT * FROM content.meetings WHERE id = $1`, [derived.meetingId])).rows[0];
    assert.equal(m.fingerprint_confidence, 'derived');

    // Re-capture of the derived meeting with a WORSE envelope (weak) must not downgrade.
    await createArtifact({
      raw: 'second capture, worse envelope, same identity inputs',
      kind: 'summary',
      title: 'Attendee Sync notes',
      source_system: 'drive',
      ownerOrgId: UMB_ORG,
      meeting: { title: 'Attendee Sync', startTime: '2026-06-02T18:00:00Z', participantEmails: ['a@x.com', 'b@y.com'], fallbackId: 'file-d1', participantsAreAttendees: false },
    });
    m = (await query(`SELECT * FROM content.meetings WHERE id = $1`, [derived.meetingId])).rows[0];
    assert.equal(m.fingerprint_confidence, 'derived', 'no downgrade on weaker re-capture');
  });
});

describe('cross-scope separation + visible-peer link (D3)', () => {
  const CAL_ID = 'gcal-evt-006-x';
  const FP = `cal:${CAL_ID}`;
  let personal, org;

  before(async () => {
    personal = await createArtifact({
      raw: 'my private prep notes',
      kind: 'transcript',
      title: 'Client Kickoff (personal)',
      source_system: 'mcp',
      ownerOrgId: UMB_ORG,
      ownerId: MEMBER_UMB,
      meeting: { calendarEventId: CAL_ID, title: 'Client Kickoff', startTime: '2026-06-03T17:00:00Z', participantEmails: ['eric@staqs.io'] },
    });
    org = await createArtifact({
      raw: 'org-shared capture of the kickoff',
      kind: 'transcript',
      title: 'Client Kickoff',
      source_system: 'drive',
      ownerOrgId: UMB_ORG,
      meeting: { calendarEventId: CAL_ID, title: 'Client Kickoff', startTime: '2026-06-03T17:00:00Z', participantEmails: [], participantsAreAttendees: false, fallbackId: 'file-kick' },
    });
  });

  it('same fingerprint, different scope → two separate meeting rows', async () => {
    assert.notEqual(personal.meetingId, org.meetingId);
    const rows = await query(
      `SELECT count(*)::int AS n FROM content.meetings WHERE meeting_fingerprint = $1`, [FP]
    );
    assert.equal(rows.rows[0].n, 2);
  });

  it('the member sees both rows + the peer link; a different org sees neither', async () => {
    const handler = routes.get('GET /api/meeting-registry');
    const mine = await handler({ url: '/api/meeting-registry?limit=200', __principal: P(MEMBER_UMB, [UMB_ORG]) });
    const ids = mine.meetings.map((m) => m.id);
    assert.ok(ids.includes(personal.meetingId) && ids.includes(org.meetingId));
    const personalRow = mine.meetings.find((m) => m.id === personal.meetingId);
    assert.equal(personalRow.has_visible_peer, true, 'personal row links to the org peer');

    const other = await handler({ url: '/api/meeting-registry?limit=200', __principal: P(MEMBER_STAQS, [STAQS_ORG]) });
    const otherIds = other.meetings.map((m) => m.id);
    assert.ok(!otherIds.includes(personal.meetingId) && !otherIds.includes(org.meetingId),
      'tenancy isolation: a different org sees neither row');
  });

  it('promotion: non-owner 403; owner promote re-owns artifacts + supersedes with lineage', async () => {
    const promote = routes.get('POST /api/meeting-registry/:id/promote');
    await assert.rejects(
      () => promote({ url: `/api/meeting-registry/${personal.meetingId}/promote`, __principal: P(MEMBER_STAQS, [STAQS_ORG]) }),
      /only the owner/
    );

    const res = await promote({ url: `/api/meeting-registry/${personal.meetingId}/promote`, __principal: P(MEMBER_UMB, [UMB_ORG]) });
    assert.equal(res.ok, true);
    assert.equal(res.orgMeetingId, org.meetingId, 'merged into the existing org-shared peer');
    assert.equal(res.movedArtifacts, 1);

    const p = (await query(`SELECT * FROM content.meetings WHERE id = $1`, [personal.meetingId])).rows[0];
    assert.equal(p.status, 'superseded');
    assert.equal(p.superseded_by, org.meetingId);

    const moved = await query(`SELECT meeting_id, owner_id FROM content.artifacts WHERE id = $1`, [personal.artifactId]);
    assert.equal(moved.rows[0].meeting_id, org.meetingId);
    assert.equal(moved.rows[0].owner_id, null, 'artifact re-owned to org-shared');

    // Second promote → 409 (already superseded).
    await assert.rejects(
      () => promote({ url: `/api/meeting-registry/${personal.meetingId}/promote`, __principal: P(MEMBER_UMB, [UMB_ORG]) }),
      /already_superseded|already org-shared/
    );
  });
});

describe('calendar reconciler (3a)', () => {
  before(async () => {
    await query(
      `INSERT INTO inbox.calendar_events (account_email, gcal_event_id, ical_uid, title, start_at, organizer_email, attendees)
       VALUES
        ('eric@staqs.io', 'gcal-recon-1', 'ical-1', 'Weekly UMB Advisory Sync', '2026-06-05T17:00:00Z', 'eric@staqs.io',
         '[{"email":"eric@staqs.io"},{"email":"kyle@umb.com"}]'::jsonb),
        ('eric@staqs.io', 'gcal-recon-2', 'ical-2', 'Totally Different Planning Meeting', '2026-06-05T17:15:00Z', 'eric@staqs.io', '[]'::jsonb),
        ('eric@staqs.io', 'gcal-ambig-a', null, 'Design Review', '2026-06-06T17:00:00Z', null, '[]'::jsonb),
        ('eric@staqs.io', 'gcal-ambig-b', null, 'Design Review', '2026-06-06T17:10:00Z', null, '[]'::jsonb)
       ON CONFLICT (account_email, gcal_event_id) DO NOTHING`
    );
  });

  it('recovers the event id from time + title (+ attendee overlap)', async () => {
    const rec = await resolveCalendarEventId({
      startTime: '2026-06-05T17:02:00Z',
      title: 'Weekly UMB Advisory Sync - 2026/06/05 10:00 PDT - Notes by Gemini',
      attendeeEmails: ['kyle@umb.com'],
      queryFn: query,
    });
    assert.ok(rec, 'match found');
    assert.equal(rec.calendarEventId, 'gcal-recon-1');
  });

  it('fails closed below the accept floor', async () => {
    const rec = await resolveCalendarEventId({
      startTime: '2026-06-05T17:02:00Z',
      title: 'Unrelated Topic Entirely',
      attendeeEmails: [],
      queryFn: query,
    });
    assert.equal(rec, null);
  });

  it('fails closed on ambiguity (two equally-good candidates)', async () => {
    const rec = await resolveCalendarEventId({
      startTime: '2026-06-06T17:05:00Z',
      title: 'Design Review',
      attendeeEmails: [],
      queryFn: query,
    });
    assert.equal(rec, null, 'two identical-title events in window → no match');
  });

  it('cleanMeetingTitle strips Gemini decoration; titleSimilarity is sane', () => {
    assert.equal(cleanMeetingTitle('Q3 Sync - 2026/06/01 10:00 PDT - Notes by Gemini'), 'Q3 Sync');
    assert.ok(titleSimilarity('Weekly UMB Sync', 'weekly umb sync') > 0.99);
    assert.ok(titleSimilarity('Weekly UMB Sync', 'Unrelated Planning') < 0.2);
  });
});

describe('weak-meeting upgrade sweep (Q1)', () => {
  it('re-keys a weak meeting to cal: when the calendar event arrives (alias kept)', async () => {
    const weak = await createArtifact({
      raw: 'drive drop captured before its calendar event was synced',
      kind: 'transcript',
      title: 'Roadmap Workshop - 2026/06/07 10:00 PDT - Notes by Gemini',
      source_system: 'drive',
      ownerOrgId: UMB_ORG,
      meeting: { title: 'Roadmap Workshop', startTime: '2026-06-07T17:00:00Z', participantEmails: [], fallbackId: 'file-road', participantsAreAttendees: false },
    });
    const before = (await query(`SELECT * FROM content.meetings WHERE id = $1`, [weak.meetingId])).rows[0];
    assert.equal(before.fingerprint_confidence, 'weak');
    const oldFp = before.meeting_fingerprint;

    // The calendar event lands later.
    await query(
      `INSERT INTO inbox.calendar_events (account_email, gcal_event_id, title, start_at, attendees)
       VALUES ('eric@staqs.io', 'gcal-road-1', 'Roadmap Workshop', '2026-06-07T17:00:00Z', '[]'::jsonb)
       ON CONFLICT (account_email, gcal_event_id) DO NOTHING`
    );

    const stats = await upgradeWeakMeetings({ limit: 50, queryFn: query });
    assert.ok(stats.upgraded >= 1, 'at least the roadmap meeting upgraded');

    const after = (await query(`SELECT * FROM content.meetings WHERE id = $1`, [weak.meetingId])).rows[0];
    assert.equal(after.meeting_fingerprint, 'cal:gcal-road-1');
    assert.equal(after.fingerprint_confidence, 'calendar');
    assert.ok((after.fingerprint_aliases || []).includes(oldFp), 'old fingerprint kept as alias');
  });

  it('merges a weak meeting into an existing cal: peer in the same scope', async () => {
    // The cal: row exists first (TLDv knew the calendar id).
    const calArt = await createArtifact({
      raw: 'tldv verbatim of the budget review',
      kind: 'transcript',
      title: 'Budget Review',
      source_system: 'tldv',
      ownerOrgId: UMB_ORG,
      meeting: { calendarEventId: 'gcal-budget-1', title: 'Budget Review', startTime: '2026-06-08T17:00:00Z', participantEmails: ['eric@staqs.io'] },
    });
    // A weak Drive drop of the same call (no calendar id at capture time).
    const weakArt = await createArtifact({
      raw: 'gemini notes of the budget review',
      kind: 'transcript',
      title: 'Budget Review - 2026/06/08 10:00 PDT - Notes by Gemini',
      source_system: 'drive',
      ownerOrgId: UMB_ORG,
      meeting: { title: 'Budget Review', startTime: '2026-06-08T17:00:00Z', participantEmails: [], fallbackId: 'file-budget', participantsAreAttendees: false },
    });
    assert.notEqual(calArt.meetingId, weakArt.meetingId, 'separate before the sweep');

    await query(
      `INSERT INTO inbox.calendar_events (account_email, gcal_event_id, title, start_at, attendees)
       VALUES ('eric@staqs.io', 'gcal-budget-1', 'Budget Review', '2026-06-08T17:00:00Z', '[]'::jsonb)
       ON CONFLICT (account_email, gcal_event_id) DO NOTHING`
    );

    const stats = await upgradeWeakMeetings({ limit: 50, queryFn: query });
    assert.ok(stats.merged >= 1, 'weak row merged into the cal: peer');

    const weakRow = (await query(`SELECT * FROM content.meetings WHERE id = $1`, [weakArt.meetingId])).rows[0];
    assert.equal(weakRow.status, 'superseded');
    assert.equal(weakRow.superseded_by, calArt.meetingId);

    const target = (await query(`SELECT * FROM content.meetings WHERE id = $1`, [calArt.meetingId])).rows[0];
    assert.ok((target.fingerprint_aliases || []).length >= 1, 'old fingerprint aliased onto the target');
    // Both transcripts now hang off the cal: meeting; Gemini-on-Drive (weakArt)
    // outranks the tldv capture for primary (D4).
    const kids = await query(`SELECT id FROM content.artifacts WHERE meeting_id = $1`, [calArt.meetingId]);
    assert.equal(kids.rows.length, 2);
    assert.equal(target.primary_transcript_id, weakArt.artifactId);
  });
});

describe('participant normalizer (3b)', () => {
  it('strips note-taker bots; keeps humans; emails lowercased + sorted', () => {
    const roster = [
      { name: 'Eric', email: 'Eric@Staqs.io' },
      { name: 'tl;dv Notetaker', email: 'tldv@tldv.io' },
      { name: 'Notes by Gemini' },
      { name: 'Kyle', email: 'kyle@umb.com' },
      { name: 'Fireflies.ai Notetaker', email: 'fred@fireflies.ai' },
    ];
    const humans = stripNoteTakerBots(roster);
    assert.deepEqual(humans.map((p) => p.name), ['Eric', 'Kyle']);
    assert.deepEqual(attendeeEmailsOf(roster), ['eric@staqs.io', 'kyle@umb.com']);
  });
});
