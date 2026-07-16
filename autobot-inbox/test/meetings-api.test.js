import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

import {
  listMeetingsCore,
  getMeetingCore,
  listTodayMeetingsCore,
  listTodayAttendeesCore,
} from '../src/api-routes/meetings.js';

function makeQuery(rows) {
  return mock.fn(async () => ({ rows, rowCount: rows.length }));
}

const VOICE_MEMO_ROW = {
  message_id: 'msg-vm-1',
  received_at: '2026-05-03T20:15:00Z',
  primary_speaker: 'Mike',
  title: 'Standup notes',
  transcript_snippet: '[Mike]: We should ship the meetings page…',
  labels: ['webhook:voice_memo'],
  source: 'voice_memo',
  work_item_id: 'wi-vm-1',
  work_item_status: 'completed',
  work_item_title: 'Voice Memo: Standup notes',
  tracking_id: 'tr-vm-1',
  transcript_id: 'tx-vm-1',
  audio_url: 'https://cdn.assemblyai.com/upload/abc',
  audio_bytes: '480000',
  recorded_at: '2026-05-03T20:14:00Z',
  recording_name: 'Standup notes',
  extracted_signals: [],
};

const TLDV_ROW = {
  message_id: 'msg-tldv-1',
  received_at: '2026-05-02T18:00:00Z',
  primary_speaker: 'Eric',
  title: 'Customer discovery — Acme',
  transcript_snippet: 'Discussed pricing and timeline…',
  labels: ['webhook:tldv', 'tldv:transcript'],
  source: 'tldv',
  work_item_id: 'wi-tldv-1',
  work_item_status: 'in_progress',
  work_item_title: 'TLDV: Customer discovery — Acme',
  tracking_id: null,
  transcript_id: null,
  audio_url: null,
  audio_bytes: null,
  recorded_at: null,
  recording_name: null,
  extracted_signals: [
    { id: 's1', signal_type: 'commitment', content: 'Send pricing by Fri', confidence: 0.92,
      due_date: '2026-05-09T00:00:00Z', resolved: false, direction: 'outbound', domain: 'general',
      metadata: {}, created_at: '2026-05-02T18:30:00Z' },
  ],
};

const GEMINI_ROW = {
  message_id: 'msg-gem-1',
  received_at: '2026-05-01T16:00:00Z',
  primary_speaker: 'Dustin',
  title: 'Notes by Gemini — Phase 2 Planning',
  transcript_snippet: 'Notes from Phase 2 planning meeting…',
  labels: ['webhook:gemini', 'gemini:transcript'],
  source: 'gemini_meet',
  work_item_id: null,
  work_item_status: null,
  work_item_title: null,
  tracking_id: null,
  transcript_id: null,
  audio_url: null,
  audio_bytes: null,
  recorded_at: null,
  recording_name: null,
  extracted_signals: [],
};

describe('listMeetingsCore', () => {
  it('returns rows with pagination metadata when no filters are applied', async () => {
    const db = makeQuery([VOICE_MEMO_ROW, TLDV_ROW, GEMINI_ROW]);

    const result = await listMeetingsCore(db, {});

    assert.equal(db.mock.callCount(), 1);
    assert.equal(result.meetings.length, 3);
    assert.equal(result.limit, 50);
    assert.equal(result.offset, 0);

    const [, values] = db.mock.calls[0].arguments;
    // Default values: [labelArr, limit=50, offset=0]
    assert.deepEqual(values[0], ['webhook:voice_memo', 'webhook:tldv', 'webhook:gemini']);
    assert.equal(values[1], 50);
    assert.equal(values[2], 0);
  });

  it('filters by source using a single-label match', async () => {
    const db = makeQuery([TLDV_ROW]);

    const result = await listMeetingsCore(db, { source: 'tldv' });

    assert.equal(result.meetings.length, 1);
    assert.equal(result.meetings[0].source, 'tldv');

    const [sql, values] = db.mock.calls[0].arguments;
    assert.equal(values[0], 'webhook:tldv');
    assert.match(sql, /\$1 = ANY\(m\.labels\)/);
  });

  it('ignores an unknown source and falls back to the union filter', async () => {
    const db = makeQuery([]);

    await listMeetingsCore(db, { source: 'zoom' });

    const [, values] = db.mock.calls[0].arguments;
    // Falls back to the labelArr-against-array (&&) filter
    assert.deepEqual(values[0], ['webhook:voice_memo', 'webhook:tldv', 'webhook:gemini']);
  });

  it('clamps limit to 200 and rejects negative offset', async () => {
    const db = makeQuery([]);

    await listMeetingsCore(db, { limit: '500', offset: '-10' });

    const [, values] = db.mock.calls[0].arguments;
    assert.equal(values[1], 200);
    assert.equal(values[2], 0);
  });

  it('handles empty result set', async () => {
    const db = makeQuery([]);

    const result = await listMeetingsCore(db, {});

    assert.equal(result.meetings.length, 0);
  });

  // FR-38: response rows expose a human_task_count derived from
  // inbox.human_tasks (linear-pushed, not soft-deleted) tied to the meeting.
  it('selects human_task_count from inbox.human_tasks', async () => {
    const db = makeQuery([{ ...VOICE_MEMO_ROW, human_task_count: 3 }]);

    const result = await listMeetingsCore(db, {});
    const [sql] = db.mock.calls[0].arguments;

    assert.match(sql, /inbox\.human_tasks/);
    assert.match(sql, /linear_issue_id IS NOT NULL/);
    assert.match(sql, /t\.deleted_at IS NULL/);
    assert.match(sql, /AS human_task_count/);
    assert.equal(result.meetings[0].human_task_count, 3);
  });
});

describe('getMeetingCore', () => {
  it('returns a single meeting by message_id', async () => {
    const db = makeQuery([{ ...VOICE_MEMO_ROW, transcript: '[Mike]: Full transcript here.' }]);

    const result = await getMeetingCore(db, 'msg-vm-1');

    assert.equal(db.mock.callCount(), 1);
    assert.equal(result.meeting.message_id, 'msg-vm-1');
    assert.equal(result.meeting.source, 'voice_memo');

    const [, values] = db.mock.calls[0].arguments;
    assert.equal(values[0], 'msg-vm-1');
    assert.deepEqual(values[1], ['webhook:voice_memo', 'webhook:tldv', 'webhook:gemini']);
  });

  it('returns an error when message_id is missing', async () => {
    const db = makeQuery([]);

    const result = await getMeetingCore(db, '');

    assert.equal(db.mock.callCount(), 0);
    assert.equal(result.error, 'message_id required');
  });

  it("returns 'meeting not found' when no rows match", async () => {
    const db = makeQuery([]);

    const result = await getMeetingCore(db, 'msg-missing');

    assert.equal(result.error, 'meeting not found');
  });
});

describe('listTodayMeetingsCore', () => {
  const WINDOW = {
    start_iso: '2026-05-04T07:00:00Z',
    end_iso: '2026-05-05T07:00:00Z',
  };
  // STAQPRO-596 principals. A non-admin board member is pinned to its OWN
  // verified emails (viewer.emails) and scoped to its org; a verified agent JWT
  // (adminBypass) may pass an explicit email / all=1.
  const ORG_PRINCIPAL = { userId: 'u1', readOrgIds: ['org-1'], roles: { 'org-1': 'member' }, adminBypass: false };
  const VIEWER = { emails: ['Carlos@Staqs.IO'] };
  const ADMIN = { adminBypass: true };

  it('rejects when the date window is missing', async () => {
    const db = makeQuery([]);
    const result = await listTodayMeetingsCore(db, { email: 'a@b.c' }, ADMIN, null);
    assert.equal(db.mock.callCount(), 0);
    assert.equal(result.error, 'start_iso and end_iso required');
  });

  it('pins a non-admin to its own verified emails and ignores a request email (?as= cannot widen)', async () => {
    const db = makeQuery([]);
    // Attacker tries to view as someone else via the request email param.
    await listTodayMeetingsCore(db, { ...WINDOW, email: 'attacker@evil.com' }, ORG_PRINCIPAL, VIEWER);

    const [sql, values] = db.mock.calls[0].arguments;
    assert.equal(values[0], WINDOW.start_iso);
    assert.equal(values[1], WINDOW.end_iso);
    // $3 is the attendee-email allowlist — must be the viewer's OWN emails
    // (lowercased), never the request param.
    assert.deepEqual(values[2], ['carlos@staqs.io']);
    // Org boundary is appended, fail-closed.
    assert.match(sql, /d\.owner_org_id = ANY/);
    assert.match(sql, /jsonb_array_elements/);
    assert.match(sql, /'action_item','commitment','request'/);
    assert.match(sql, /resolved = false/);
  });

  it('fails closed (no DB read) for a non-admin with no resolved viewer identity', async () => {
    const db = makeQuery([]);
    const result = await listTodayMeetingsCore(db, { ...WINDOW }, ORG_PRINCIPAL, { emails: [] });
    assert.equal(db.mock.callCount(), 0);
    assert.deepEqual(result.meetings, []);
  });

  it('fails closed (no DB read) when no principal is resolved at all', async () => {
    const db = makeQuery([]);
    const result = await listTodayMeetingsCore(db, { ...WINDOW }, null, null);
    assert.equal(db.mock.callCount(), 0);
    assert.deepEqual(result.meetings, []);
  });

  it('returns the meetings array with action_items defaulted to []', async () => {
    const row = {
      document_id: 'doc-1', source: 'gemini', source_id: 'src-1', title: 'Round Up Call',
      happened_at: '2026-05-04T17:00:00Z', metadata: {}, message_id: 'msg-1',
      action_items: null, // simulates COALESCE returning NULL when no signals match
    };
    const db = makeQuery([row]);
    const result = await listTodayMeetingsCore(db, WINDOW, ORG_PRINCIPAL, VIEWER);
    assert.equal(result.meetings.length, 1);
    assert.deepEqual(result.meetings[0].action_items, []);
    assert.equal(result.meetings[0].title, 'Round Up Call');
  });

  it('exposes source_meeting_id resolved from the meeting signal (OPT-2 provenance key)', async () => {
    const row = {
      document_id: 'doc-prov', source: 'tldv', source_id: 'src-prov', title: 'UMB x Staqs',
      happened_at: '2026-05-04T17:00:00Z', metadata: {}, message_id: 'msg-p',
      source_meeting_id: 'cal:evt-abc', action_items: null,
    };
    const db = makeQuery([row]);
    const result = await listTodayMeetingsCore(db, WINDOW, ORG_PRINCIPAL, VIEWER);
    // Passes through so the board can open GET /api/provenance/:source_meeting_id.
    assert.equal(result.meetings[0].source_meeting_id, 'cal:evt-abc');
    // Resolved from the meeting.received signal by document_id (exact stamped key).
    const [sql] = db.mock.calls[0].arguments;
    assert.match(sql, /agent_graph\.signals/);
    assert.match(sql, /source_meeting_id/);
    assert.match(sql, /payload->>'document_id'/);
  });

  it('honors all=1 ONLY for a verified admin: skips the email filter and stays org-unbounded (TRUE)', async () => {
    const db = makeQuery([]);
    await listTodayMeetingsCore(db, { ...WINDOW, all: '1' }, ADMIN, null);

    const [sql, values] = db.mock.calls[0].arguments;
    // Admin + all=1 → no participant filter and visibleClause('TRUE') adds no
    // params, so only the window bounds remain.
    assert.equal(values.length, 2);
    assert.equal(values[0], WINDOW.start_iso);
    assert.equal(values[1], WINDOW.end_iso);
    assert.ok(!/jsonb_array_elements\(COALESCE\(d\.participants/i.test(sql.split('jsonb_array_elements')[1] || ''));
  });

  it('ignores all=1 for a non-admin (cannot skip the attendee filter)', async () => {
    const db = makeQuery([]);
    // Non-admin passes all=1 but has no resolved viewer emails → fail closed.
    const result = await listTodayMeetingsCore(db, { ...WINDOW, all: '1' }, ORG_PRINCIPAL, { emails: [] });
    assert.equal(db.mock.callCount(), 0);
    assert.deepEqual(result.meetings, []);
  });

  it('guards the happenedAt cast against legacy JS Date.toString() format', async () => {
    const db = makeQuery([]);
    await listTodayMeetingsCore(db, WINDOW, ADMIN, null);
    const [sql] = db.mock.calls[0].arguments;
    assert.match(sql, /metadata->>'happenedAt' ~ '\^\[0-9\]\{4\}-\[0-9\]\{2\}-\[0-9\]\{2\}'/);
  });

  it('passes through a populated action_items array unchanged', async () => {
    const row = {
      document_id: 'doc-2', source: 'tldv', source_id: 'src-2', title: 'Founders standup',
      happened_at: '2026-05-04T16:00:00Z', metadata: { happenedAt: '2026-05-04T16:00:00Z' },
      message_id: 'msg-2',
      action_items: [
        { id: 's1', signal_type: 'action_item', content: 'Reorganize dev priorities',
          due_date: null, confidence: 0.88, direction: 'outbound', domain: 'general',
          metadata: {}, created_at: '2026-05-04T16:30:00Z' },
      ],
    };
    const db = makeQuery([row]);
    const result = await listTodayMeetingsCore(db, WINDOW, ORG_PRINCIPAL, VIEWER);
    assert.equal(result.meetings[0].action_items.length, 1);
    assert.equal(result.meetings[0].action_items[0].content, 'Reorganize dev priorities');
  });
});

describe('listTodayAttendeesCore', () => {
  const ORG_PRINCIPAL = { userId: 'u1', readOrgIds: ['org-1'], roles: { 'org-1': 'member' }, adminBypass: false };

  it('rejects when the date window is missing', async () => {
    const db = makeQuery([]);
    const result = await listTodayAttendeesCore(db, {}, ORG_PRINCIPAL);
    assert.equal(db.mock.callCount(), 0);
    assert.equal(result.error, 'start_iso and end_iso required');
  });

  it('scopes content.documents by owner org and returns the attendee rows ordered by meeting_count', async () => {
    const rows = [
      { email: 'eric@staqs.io', name: 'Eric Gang', meeting_count: 3 },
      { email: 'dustin@staqs.io', name: 'Dustin Powers', meeting_count: 2 },
    ];
    const db = makeQuery(rows);
    const result = await listTodayAttendeesCore(db, {
      start_iso: '2026-05-04T07:00:00Z',
      end_iso: '2026-05-05T07:00:00Z',
    }, ORG_PRINCIPAL);
    assert.deepEqual(result.attendees, rows);

    const [sql, values] = db.mock.calls[0].arguments;
    assert.equal(values[0], '2026-05-04T07:00:00Z');
    assert.equal(values[1], '2026-05-05T07:00:00Z');
    // $3 is the org allowlist appended by visibleClause (fail-closed boundary).
    assert.deepEqual(values[2], ['org-1']);
    assert.match(sql, /d\.owner_org_id = ANY/);
    assert.match(sql, /LATERAL jsonb_array_elements/i);
    assert.match(sql, /LIMIT 25/);
  });

  it('fails closed (FALSE clause, zero rows) when no principal is resolved', async () => {
    const db = makeQuery([]);
    await listTodayAttendeesCore(db, {
      start_iso: '2026-05-04T07:00:00Z', end_iso: '2026-05-05T07:00:00Z',
    }, null);
    const [sql, values] = db.mock.calls[0].arguments;
    // No org params appended; the boundary degrades to FALSE, not an open read.
    assert.equal(values.length, 2);
    assert.match(sql, /FALSE/);
  });
});
