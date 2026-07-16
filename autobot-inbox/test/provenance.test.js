/**
 * OPT-2 — GET /api/provenance/:source_meeting_id
 *
 * Verifies the meeting→signal→task→ticket chain assembly and the fail-closed
 * tenancy gate. The handler is registered into a routes Map (mirroring
 * src/api.js) and invoked directly; withViewer is faked per-test.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';
import { registerProvenanceRoutes } from '../src/api-routes/provenance.js';

const MEETING = 'mtg-prov-opt2-1';
const ROUTE_KEY = 'GET /api/provenance/:source_meeting_id';

function handlerWith(withViewer) {
  const routes = new Map();
  registerProvenanceRoutes(routes, withViewer ? { withViewer } : {});
  return routes.get(ROUTE_KEY);
}

function req(meetingId) {
  return { url: `/api/provenance/${encodeURIComponent(meetingId)}`, headers: {} };
}

describe('GET /api/provenance/:source_meeting_id (OPT-2)', () => {
  let query;

  before(async () => {
    ({ query } = await getDb());
    await query(`DELETE FROM inbox.human_tasks WHERE id LIKE 'htm-prov-%'`);
    await query(`DELETE FROM agent_graph.signals WHERE source_meeting_id = $1`, [MEETING]);

    // One meeting-origin signal + two derived cards (one carries a Linear ticket).
    await query(
      `INSERT INTO agent_graph.signals (signal_type, source_adapter, payload, source_meeting_id, origin)
       VALUES ('meeting.received', 'calendar', '{}'::jsonb, $1, 'meeting')`,
      [MEETING],
    );
    await query(
      `INSERT INTO inbox.human_tasks (id, title, status, signal_meeting_id, origin, linear_issue_id)
       VALUES
         ('htm-prov-1', 'Send revised proposal', 'inbox', $1, 'meeting', 'STAQPRO-999'),
         ('htm-prov-2', 'Schedule follow-up',    'inbox', $1, 'meeting', NULL)`,
      [MEETING],
    );
  });

  it('assembles the chain for an authorized viewer (admin bypass)', async () => {
    const handler = handlerWith(async () => ({ principal: { adminBypass: true } }));
    const res = await handler(req(MEETING));

    assert.equal(res.meeting_id, MEETING);
    assert.equal(res.visible, true);

    // Both derived cards appear under tasks.
    const taskIds = res.tasks.map((t) => t.id).sort();
    assert.deepEqual(taskIds, ['htm-prov-1', 'htm-prov-2']);

    // Only the card with a Linear issue is a ticket.
    assert.equal(res.tickets.length, 1);
    assert.equal(res.tickets[0].id, 'htm-prov-1');
    assert.equal(res.tickets[0].linear_issue_id, 'STAQPRO-999');

    // The meeting-origin signal is surfaced (transitively gated).
    assert.equal(res.signals.length, 1);
    assert.equal(res.signals[0].source_meeting_id, MEETING);
    assert.equal(res.signals[0].origin, 'meeting');

    // Conceptual-but-unwired arms degrade to empty (design §6).
    assert.deepEqual(res.engagements, []);
    assert.deepEqual(res.drafts, []);
  });

  it('fails closed for an unauthenticated viewer (no principal → no chain)', async () => {
    const handler = handlerWith(undefined); // withViewer absent → principal null → visibleClause FALSE
    const res = await handler(req(MEETING));

    assert.equal(res.visible, false);
    assert.deepEqual(res.tasks, []);
    assert.deepEqual(res.tickets, []);
    assert.deepEqual(res.signals, []); // never returned unscoped when the org gate is closed
  });

  it('returns an empty, non-visible chain for an unknown meeting id', async () => {
    const handler = handlerWith(async () => ({ principal: { adminBypass: true } }));
    const res = await handler(req('mtg-does-not-exist'));
    assert.equal(res.visible, false);
    assert.deepEqual(res.signals, []);
  });
});
