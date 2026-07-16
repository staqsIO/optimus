/**
 * OPT-7 — Cross-source meeting dedup + source-preference switch.
 *
 * Verifies the two core invariants for the same meeting arriving via TLDV AND
 * Google Meet/Gemini (Drive):
 *   1. DEDUP: two separate createArtifact() calls for the same canonical meeting
 *      collapse to EXACTLY ONE content.meetings row — one canonical KB record.
 *   2. PREFERENCE: only the preferred source's transcript is selected as
 *      primary_transcript_id; switching the source-preference re-picks atomically.
 *
 * Three scenarios:
 *   A. Calendar-anchored: calendarEventId present — `cal:<id>` key wins, both
 *      captures upsert onto the same row regardless of time jitter.
 *   B. Ad-hoc fallback: no calendarEventId — `mtg:<hash>` key from
 *      15-min-rounded start window + sorted participant emails + normalized title.
 *      Tolerates clock-skew between TLDV and Meet up to 14m59s.
 *   C. Source-preference flip: org sets tldv-first → TLDV becomes primary; set
 *      drive-first → Gemini becomes primary; clears → system default (drive).
 *
 * Offline on PGlite — no LLM, no network.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';

const { createArtifact } = await import('../../lib/content/create-artifact.js');
const { resolveSourcePrecedence, setSourcePrecedence, SYSTEM_DEFAULT_PRECEDENCE } =
  await import('../../lib/content/meeting-prefs.js');

// Fixed org / user IDs — isolated from meeting-source-prefs.test.js (different CAL ids).
const DEDUP_ORG  = 'dddddddd-7777-7777-7777-777777777777';
const DEDUP_USER = 'eeeeeeee-8888-8888-8888-888888888888';

let query;

before(async () => {
  ({ query } = await getDb());
  // Seed the org so owner_org_id FKs resolve and source-prefs can be written.
  // tenancy.orgs has (id, slug, name) — no cross-schema FK needed on board_members.
  await query(
    `INSERT INTO tenancy.orgs (id, slug, name) VALUES ($1, 'dedup-org', 'DedupOrg')
     ON CONFLICT (id) DO NOTHING`,
    [DEDUP_ORG]
  );
  // board_members uses (id, github_username, display_name, role) — no org_id column.
  await query(
    `INSERT INTO agent_graph.board_members (id, github_username, display_name, role)
     VALUES ($1, 'dedup-user', 'Dedup User', 'member')
     ON CONFLICT (id) DO NOTHING`,
    [DEDUP_USER]
  );
});

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Count active content.meetings rows with the given fingerprint. */
async function countMeetingRows(fingerprint) {
  const res = await query(
    `SELECT count(*)::int AS n FROM content.meetings WHERE meeting_fingerprint = $1 AND status = 'active'`,
    [fingerprint]
  );
  return res.rows[0].n;
}

/** Return primary_transcript_id + both artifact ids for a meeting row. */
async function meetingState(meetingId) {
  const res = await query(
    `SELECT primary_transcript_id FROM content.meetings WHERE id = $1`,
    [meetingId]
  );
  return res.rows[0] ?? null;
}

// ─── Scenario A: calendar-anchored dedup ─────────────────────────────────────

describe('OPT-7 — Scenario A: calendar-anchored double-capture → 1 canonical row', () => {
  const CAL_ID = 'cal-opt7-a1a1a1';

  it('TLDV capture creates the meeting row (cal: fingerprint)', async () => {
    const tldv = await createArtifact({
      raw: 'tldv verbatim transcript of the Allbirds call',
      kind: 'transcript',
      title: 'Allbirds Kickoff',
      source_system: 'tldv',
      ownerOrgId: DEDUP_ORG,
      meeting: {
        calendarEventId: CAL_ID,
        title: 'Allbirds Kickoff',
        startTime: '2026-06-10T14:01:00Z',   // TLDV clock
        participantEmails: ['alice@staqs.io', 'bob@allbirds.com'],
      },
    });
    assert.ok(tldv.meetingId, 'tldv createArtifact must link to a meeting row');
    assert.equal(tldv.meetingFingerprint, `cal:${CAL_ID}`);
    assert.equal(await countMeetingRows(`cal:${CAL_ID}`), 1, 'exactly one meeting row after first capture');
  });

  it('Meet/Gemini (drive) capture of SAME meeting upserts — no new row', async () => {
    // Simulates the Gemini Notes Drive file arriving 7 minutes later with
    // the same calendar event id but a different source_system.
    const drive = await createArtifact({
      raw: 'gemini curated summary of the Allbirds call',
      kind: 'transcript',
      title: 'Allbirds Kickoff',  // same title, different source
      source_system: 'drive',
      ownerOrgId: DEDUP_ORG,
      meeting: {
        calendarEventId: CAL_ID,
        title: 'Allbirds Kickoff',
        startTime: '2026-06-10T14:08:00Z',   // Meet clock (+7 min — still same calendar event)
        participantEmails: ['alice@staqs.io', 'bob@allbirds.com'],
      },
    });
    assert.ok(drive.meetingId, 'drive createArtifact must link to a meeting row');
    // Same fingerprint → same row.
    assert.equal(drive.meetingFingerprint, `cal:${CAL_ID}`);
    assert.equal(
      await countMeetingRows(`cal:${CAL_ID}`),
      1,
      'DEDUP INVARIANT: TLDV + Meet/Gemini double-capture of the same calendar event → exactly 1 content.meetings row'
    );
  });

  it('both captures link to the same meeting row with a primary transcript set', async () => {
    // Note: createArtifact deduplicates on identity_key = sha256(ownerId|title) by design
    // (OPT-97): two transcripts with the same title collapse to one artifact row, which
    // is correct — the artifact IS the canonical KB record for this content, and
    // content.meetings.primary_transcript_id points to it.
    // The dedup count of 1 meeting row (checked above) is the key OPT-7 invariant.
    const res = await query(
      `SELECT id, primary_transcript_id FROM content.meetings WHERE meeting_fingerprint = $1 AND status = 'active'`,
      [`cal:${CAL_ID}`]
    );
    assert.equal(res.rows.length, 1, 'exactly one canonical meeting row');
    assert.ok(
      res.rows[0].primary_transcript_id,
      'SOURCE-PREFERENCE INVARIANT: canonical meeting row must have a primary_transcript_id set (system default applied)'
    );
  });
});

// ─── Scenario B: ad-hoc fallback (no calendar event id) ──────────────────────

describe('OPT-7 — Scenario B: ad-hoc fallback key (15-min window + participants + title)', () => {
  // No calendarEventId — the mtg: hash must match across TLDV and Meet captures
  // as long as they fall in the same 15-minute window.

  it('TLDV + Meet captures within the same 15-min window collapse to ONE row', async () => {
    // TLDV arrives at 10:01 and Meet at 10:13 — both round to the 10:00 window.
    const sharedParticipants = ['carol@staqs.io', 'dave@formul8.ai'];
    const sharedTitle = 'Q3 Planning Session';

    const tldv = await createArtifact({
      raw: 'tldv transcript of the q3 planning session',
      kind: 'transcript',
      title: sharedTitle,
      source_system: 'tldv',
      ownerOrgId: DEDUP_ORG,
      meeting: {
        // No calendarEventId → ad-hoc path
        title: sharedTitle,
        startTime: '2026-06-11T10:01:00Z',   // TLDV: 10:01 → rounds to 10:00 window
        participantEmails: sharedParticipants,
      },
    });

    const drive = await createArtifact({
      raw: 'gemini notes for the q3 planning session',
      kind: 'transcript',
      title: sharedTitle,
      source_system: 'drive',
      ownerOrgId: DEDUP_ORG,
      meeting: {
        // No calendarEventId → ad-hoc path
        title: sharedTitle,
        startTime: '2026-06-11T10:13:00Z',   // Meet: 10:13 → also rounds to 10:00 window
        participantEmails: sharedParticipants, // same sorted set → same hash
      },
    });

    assert.ok(tldv.meetingId, 'tldv must link to a meeting row');
    assert.ok(drive.meetingId, 'drive must link to a meeting row');

    // Both must land on the SAME mtg: fingerprint.
    assert.equal(
      tldv.meetingFingerprint,
      drive.meetingFingerprint,
      'AD-HOC FALLBACK INVARIANT: same 15-min window + sorted participants + title → identical mtg: hash'
    );
    assert.ok(tldv.meetingFingerprint.startsWith('mtg:'), 'fingerprint must use mtg: prefix');

    // And that fingerprint must map to exactly one active meeting row.
    assert.equal(
      await countMeetingRows(tldv.meetingFingerprint),
      1,
      'DEDUP INVARIANT: ad-hoc TLDV+Meet double-capture → exactly 1 content.meetings row'
    );
  });

  it('captures in DIFFERENT 15-min windows produce separate rows (no false dedup)', async () => {
    // Same title + participants but 20 minutes apart → different windows → different rows.
    const participants = ['eve@staqs.io'];
    const title = 'Distinct Meeting';

    const early = await createArtifact({
      raw: 'early meeting transcript',
      kind: 'transcript',
      title,
      source_system: 'tldv',
      ownerOrgId: DEDUP_ORG,
      meeting: { title, startTime: '2026-06-11T11:00:00Z', participantEmails: participants },
    });
    const late = await createArtifact({
      raw: 'late meeting transcript',
      kind: 'transcript',
      title,
      source_system: 'drive',
      ownerOrgId: DEDUP_ORG,
      meeting: { title, startTime: '2026-06-11T11:20:00Z', participantEmails: participants },
    });

    assert.notEqual(
      early.meetingFingerprint,
      late.meetingFingerprint,
      'Captures 20min apart → different 15-min windows → different fingerprints (no false dedup)'
    );
  });
});

// ─── Scenario C: source-preference switch ────────────────────────────────────

describe('OPT-7 — Scenario C: source-preference switch honored', () => {
  const CAL_ID_C = 'cal-opt7-pref-c2c2';

  // NOTE on artifact identity (OPT-97): createArtifact deduplicates on
  // identity_key = sha256(ownerId | title). Two transcripts with the SAME title
  // collapse to ONE artifact regardless of source_system (intentional — source_system
  // is pure row metadata, not a dedup axis). To produce two DISTINCT artifact rows
  // for source-preference testing, we use source-disambiguated titles.
  // The meeting row is shared (same cal: fingerprint) but each source gets its own
  // artifact, and primary_transcript_id flips between them as the pref changes.
  let tldvArtifactId, driveArtifactId, meetingId;

  before(async () => {
    // Use source-disambiguated titles to produce two distinct artifact rows.
    const tldvResult = await createArtifact({
      raw: 'tldv verbatim: product roadmap review verbatim transcript with full dialogue',
      kind: 'transcript',
      title: 'Product Roadmap Review [tldv]',  // source-disambiguated title
      source_system: 'tldv',
      ownerOrgId: DEDUP_ORG,
      meeting: {
        calendarEventId: CAL_ID_C,
        title: 'Product Roadmap Review',
        startTime: '2026-06-12T15:00:00Z',
        participantEmails: ['frank@staqs.io'],
      },
    });
    const driveResult = await createArtifact({
      raw: 'gemini summary: product roadmap review — 3 action items curated',
      kind: 'transcript',
      title: 'Product Roadmap Review [drive]',  // source-disambiguated title
      source_system: 'drive',
      ownerOrgId: DEDUP_ORG,
      meeting: {
        calendarEventId: CAL_ID_C,
        title: 'Product Roadmap Review',
        startTime: '2026-06-12T15:05:00Z',
        participantEmails: ['frank@staqs.io'],
      },
    });

    meetingId = tldvResult.meetingId;
    tldvArtifactId  = tldvResult.artifactId;
    driveArtifactId = driveResult.artifactId;

    // Confirm dedup: both resolved to the same meeting row.
    assert.equal(driveResult.meetingId, meetingId, 'Both captures must share one meeting row');
    // Confirm distinct artifacts (different titles → different identity_key).
    assert.notEqual(tldvArtifactId, driveArtifactId, 'Source-disambiguated titles must produce distinct artifact rows');
  });

  it('system default: Gemini (drive) is primary [drive > tldv]', async () => {
    // No org pref set yet → system default applies.
    const prec = await resolveSourcePrecedence(query, DEDUP_ORG, null);
    assert.deepEqual(prec.precedence, [...SYSTEM_DEFAULT_PRECEDENCE], 'system default precedence');

    const state = await meetingState(meetingId);
    assert.equal(
      state.primary_transcript_id,
      driveArtifactId,
      'PREFERENCE: system default (drive>tldv) → Gemini/drive is primary'
    );
  });

  it('org-default flip to tldv-first: TLDV becomes primary', async () => {
    // Board sets org preference to tldv-first.
    const res = await setSourcePrecedence({
      ownerOrgId: DEDUP_ORG,
      ownerId: null,       // org-level default
      precedence: ['tldv', 'drive', 'mcp'],
      updatedBy: DEDUP_USER,
    });
    assert.equal(res.ok, true);
    assert.ok(res.recomputed >= 1, 're-pick must run over affected meetings');

    const state = await meetingState(meetingId);
    assert.equal(
      state.primary_transcript_id,
      tldvArtifactId,
      'PREFERENCE: org default tldv>drive → TLDV is now primary'
    );

    const prec = await resolveSourcePrecedence(query, DEDUP_ORG, null);
    assert.equal(prec.source, 'org', 'resolution source must be org');
  });

  it('flip back to drive-first: Gemini/drive becomes primary again', async () => {
    const res = await setSourcePrecedence({
      ownerOrgId: DEDUP_ORG,
      ownerId: null,
      precedence: ['drive', 'tldv', 'mcp'],
      updatedBy: DEDUP_USER,
    });
    assert.equal(res.ok, true);

    const state = await meetingState(meetingId);
    assert.equal(
      state.primary_transcript_id,
      driveArtifactId,
      'PREFERENCE: flip back to drive>tldv → Gemini/drive is primary again'
    );
  });

  it('clearing org pref reverts to system default (drive)', async () => {
    const res = await setSourcePrecedence({
      ownerOrgId: DEDUP_ORG,
      ownerId: null,
      precedence: null,  // clear
      updatedBy: DEDUP_USER,
    });
    assert.equal(res.ok, true);

    const prec = await resolveSourcePrecedence(query, DEDUP_ORG, null);
    assert.equal(prec.source, 'system', 'source reverts to system after clear');
    assert.deepEqual(prec.precedence, [...SYSTEM_DEFAULT_PRECEDENCE]);

    // After revert, the primary is still drive (system default = drive-first).
    const state = await meetingState(meetingId);
    assert.equal(
      state.primary_transcript_id,
      driveArtifactId,
      'After clear, system default applies: Gemini/drive is primary'
    );
  });
});
