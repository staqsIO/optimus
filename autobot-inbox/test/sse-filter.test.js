// test/sse-filter.test.js — Phase-2 tenancy (live read-leak, Commit B).
//
// Unit tests for the PURE SSE per-org delivery decision (lib/runtime/state/
// sse-filter.js). No DB / no live socket — runs everywhere, including PGlite CI.
//
// Covers the plan's SSE filter acceptance criteria:
//   (a) a Staqs-org event is dropped for a ConsultingFuture principal, delivered
//       to a Staqs principal and to an adminBypass principal;
//   (b) a CONTROL_EVENT_TYPES org-less event is delivered to all; an unknown
//       org-less event is dropped (and flagged unknownOrgless).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldDeliverEvent,
  eventTypeOf,
  CONTROL_EVENT_TYPES,
} from '../../lib/runtime/state/sse-filter.js';

const STAQS = '7c164445-43f2-4802-a7d3-5cab06611e99';
const CONSULTING_FUTURE = '11111111-1111-1111-1111-111111111111';

const staqsPrincipal = { adminBypass: false, readOrgIds: [STAQS] };
const consultingFuturePrincipal = { adminBypass: false, readOrgIds: [CONSULTING_FUTURE] };
const adminPrincipal = { adminBypass: true, readOrgIds: [] };
const unresolvedPrincipal = { adminBypass: false, readOrgIds: [] };

test('(a) Staqs-org event: dropped for ConsultingFuture, delivered for Staqs + admin', () => {
  const event = { event_type: 'needs_attention', work_item_id: 'wi-1', owner_org_id: STAQS };

  assert.equal(shouldDeliverEvent(consultingFuturePrincipal, event).deliver, false,
    'cross-tenant principal must NOT receive a Staqs event');
  assert.equal(shouldDeliverEvent(staqsPrincipal, event).deliver, true,
    'same-org principal must receive the event');
  assert.equal(shouldDeliverEvent(adminPrincipal, event).deliver, true,
    'adminBypass principal must receive every event');
  assert.equal(shouldDeliverEvent(unresolvedPrincipal, event).deliver, false,
    'unresolved/empty principal must receive nothing (fail-closed)');
});

test('(b) control org-less event (halt_signal) delivered to ALL principals', () => {
  // halt_signal carries workItemId "system" → no owner_org_id in payload.
  const event = { event_type: 'halt_signal', work_item_id: 'system' };
  for (const p of [staqsPrincipal, consultingFuturePrincipal, adminPrincipal, unresolvedPrincipal]) {
    const r = shouldDeliverEvent(p, event);
    assert.equal(r.deliver, true, 'system halt must reach every connected board client');
    assert.equal(r.unknownOrgless, false, 'allow-listed control type is not "unknown"');
  }
});

test('(b) unknown org-less event dropped for non-admin and flagged unknownOrgless', () => {
  // An event with no owner_org_id and a non-control type — e.g. a future tenant
  // event whose emitter forgot to stamp org. Must fail closed.
  const event = { event_type: 'mystery_tenant_event', work_item_id: 'wi-9' };

  const cf = shouldDeliverEvent(consultingFuturePrincipal, event);
  assert.equal(cf.deliver, false, 'unknown org-less event must be dropped (fail-closed)');
  assert.equal(cf.unknownOrgless, true, 'drop must be flagged so api.js can debug-log it');

  // adminBypass still sees everything (trusted internal caller).
  assert.equal(shouldDeliverEvent(adminPrincipal, event).deliver, true,
    'adminBypass sees even unknown org-less events');
});

test('org-less control set + eventTypeOf normalization', () => {
  assert.ok(CONTROL_EVENT_TYPES.has('halt_triggered'));
  assert.ok(CONTROL_EVENT_TYPES.has('halt_cleared'));
  assert.ok(!CONTROL_EVENT_TYPES.has('needs_attention'),
    'needs_attention is tenant-bearing and must NOT be control-allow-listed');
  // camelCase + snake_case + missing all resolve.
  assert.equal(eventTypeOf({ eventType: 'halt_signal' }), 'halt_signal');
  assert.equal(eventTypeOf({ event_type: 'needs_attention' }), 'needs_attention');
  assert.equal(eventTypeOf({}), 'unknown');
});

test('camelCase owner key is NOT honored (snake_case is the wire contract)', () => {
  // The payload travels as JSON over pg_notify; the canonical field is
  // owner_org_id. A stray camelCase ownerOrgId must not be treated as scoped —
  // it would be org-less + non-control → dropped. This locks the wire contract.
  const event = { event_type: 'needs_attention', ownerOrgId: STAQS };
  assert.equal(shouldDeliverEvent(staqsPrincipal, event).deliver, false);
});
