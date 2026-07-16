/**
 * :Meeting knowledge-graph node creation (Plan 041).
 *
 * Closes the capture→enrich→graph gap: Calendar/TLDv meetings were ingested and
 * classified but never became first-class graph nodes. These tests pin:
 *   - the merge-key contract (node id == the stable source_meeting_id) and the
 *     STOP guard (no key → no node),
 *   - that the classifier wires node creation into the ingest path for EVERY
 *     meeting (informational too), with participant emails extracted,
 *   - idempotency at the merge-key level (re-ingest passes the same key),
 *   - the read path (getRecentMeetings) offline contract + toInteger Float guard.
 *
 * Neo4j is not available in unit-test CI, so the graph-write assertions run
 * offline against the short-circuit (mergeMeeting/getRecentMeetings return null/[]
 * when no driver is configured) and against an injected spy on the classifier.
 * The real node-count idempotency check is gated behind NEO4J_URI (plan 024's
 * real-infra lane) and skips cleanly in CI.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleMeetingReceived } from '../../lib/runtime/meeting-classifier.js';
import { mergeMeeting } from '../../lib/graph/meeting-sync.js';
import { getRecentMeetings } from '../../lib/graph/queries.js';

const MEETING_ID = 'cal:meeting-041-test';
const DOC_ID = 'doc-041-test';

// Fake pg query: returns a transcript for loadTranscript's SELECT, empty otherwise.
function fakeQuery({ participants = ['a@acme.com', 'b@gmail.com'] } = {}) {
  return async (sql) => {
    if (/FROM content\.documents/.test(sql)) {
      return {
        rows: [{
          raw_text: 'We synced on the project.',
          title: 'Sync with Acme',
          metadata: { participants },
        }],
      };
    }
    return { rows: [], rowCount: 0 };
  };
}

// Classifier deps with a spy on mergeMeeting; classification is informational so
// the handler returns right after the (branch-independent) node upsert.
function spyDeps() {
  const calls = [];
  const deps = {
    classify: async () => ({ category: 'informational', confidence: 0.9 }),
    extract: async () => ({ entities: [] }),
    matchEngagement: async () => null,
    mergeMeeting: async (args) => {
      calls.push(args);
      return { id: args.sourceMeetingId, participantsLinked: 0 };
    },
  };
  return { deps, calls };
}

function makeSignal(overrides = {}) {
  return {
    signal_type: 'meeting.received',
    payload: {
      document_id: DOC_ID,
      source_meeting_id: MEETING_ID,
      transcript_source: 'tldv',
      title: 'Sync',
      origin: 'meeting',
      ...overrides,
    },
  };
}

describe('Plan 041 — :Meeting node merge helper', () => {
  it('mergeMeeting refuses when no stable merge key is supplied (STOP guard)', async () => {
    const result = await mergeMeeting({ sourceMeetingId: '', title: 'x' });
    assert.equal(result, null, 'no source_meeting_id → null (never create an un-mergeable node)');
  });

  it('mergeMeeting returns null when the graph is offline (best-effort)', async () => {
    // NEO4J_URI is unset in CI → isGraphAvailable() is false → short-circuit.
    const result = await mergeMeeting({ sourceMeetingId: MEETING_ID, title: 'Sync' });
    assert.equal(result, null, 'graph offline → null, does not throw');
  });

  it('getRecentMeetings returns [] when the graph is offline', async () => {
    const meetings = await getRecentMeetings();
    assert.deepEqual(meetings, [], 'offline → empty array, does not throw');
  });

  it('getRecentMeetings LIMIT is toInteger()-wrapped (JS number → Neo4j Float gotcha)', () => {
    // Static-shape guard (mirrors STAQPRO-326 test convention): the read query
    // must coerce the limit or Neo4j rejects the Float as a non-Integer.
    assert.match(getRecentMeetings.toString(), /toInteger\(\$limit\)/);
  });
});

describe('Plan 041 — classifier wires node creation into the ingest path', () => {
  it('creates the :Meeting node for an informational meeting (not just action-bearing)', async () => {
    const { deps, calls } = spyDeps();
    const outcome = await handleMeetingReceived(makeSignal(), { query: fakeQuery(), deps });

    assert.equal(outcome.status, 'informational');
    assert.equal(calls.length, 1, 'mergeMeeting runs before the classification branch');
    const arg = calls[0];
    assert.equal(arg.sourceMeetingId, MEETING_ID, 'node id == stable source_meeting_id merge key');
    assert.equal(arg.documentId, DOC_ID);
    assert.equal(arg.source, 'tldv');
    assert.deepEqual(
      [...arg.participantEmails].sort(),
      ['a@acme.com', 'b@gmail.com'],
      'participant emails extracted from transcript metadata (free-mail kept)',
    );
  });

  it('is idempotent at the merge-key level: re-ingest passes the same key', async () => {
    const { deps, calls } = spyDeps();
    const signal = makeSignal();
    await handleMeetingReceived(signal, { query: fakeQuery(), deps });
    await handleMeetingReceived(signal, { query: fakeQuery(), deps });

    assert.equal(calls.length, 2);
    assert.equal(calls[0].sourceMeetingId, calls[1].sourceMeetingId,
      'same meeting → same merge key both times → MERGE dedups to one node');
  });

  it('does not break classification when the graph node upsert throws', async () => {
    const { deps } = spyDeps();
    deps.mergeMeeting = async () => { throw new Error('neo4j down'); };
    const outcome = await handleMeetingReceived(makeSignal(), { query: fakeQuery(), deps });
    assert.equal(outcome.status, 'informational', 'best-effort: graph failure never blocks the classifier');
  });
});

// Real-infra lane (plan 024): actual node creation + count-level idempotency.
// Skipped cleanly in CI where Neo4j is unavailable.
const LIVE_SKIP = process.env.NEO4J_URI ? false : 'NEO4J_URI not set (no live Neo4j)';
describe('Plan 041 — live graph node creation + idempotency', { skip: LIVE_SKIP }, () => {
  it('re-merging the same meeting keeps exactly one node and is readable', async () => {
    const { initGraph, runCypher, closeGraph } = await import('../../lib/graph/client.js');
    await initGraph();
    const id = `cal:plan041-live-${Date.now()}`;
    try {
      await mergeMeeting({ sourceMeetingId: id, title: 'Live Test', source: 'tldv', documentId: 'live-doc' });
      await mergeMeeting({ sourceMeetingId: id, title: 'Live Test (edited)', source: 'tldv', documentId: 'live-doc' });

      const countRecs = await runCypher('MATCH (m:Meeting {id: $id}) RETURN count(m) AS c', { id }, { readOnly: true });
      const count = countRecs?.[0]?.get('c')?.toNumber?.() ?? Number(countRecs?.[0]?.get('c'));
      assert.equal(count, 1, 're-ingest updates, never duplicates');

      const meetings = await getRecentMeetings(50);
      assert.ok(meetings.some((m) => m.id === id), 'context read surfaces the meeting node');
    } finally {
      await runCypher('MATCH (m:Meeting {id: $id}) DETACH DELETE m', { id });
      await closeGraph();
    }
  });
});
