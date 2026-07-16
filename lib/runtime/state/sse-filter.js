// lib/runtime/state/sse-filter.js — Phase-2 tenancy (live read-leak, Commit B).
//
// The per-org delivery decision for the SSE /api/events forwarder, factored out
// as a PURE function so it is unit-testable without a live SSE socket or DB.
//
// Deny-by-default (SPEC §0 P1): an event is delivered to a client ONLY if the
// client's principal is allowed to see its owning org. The previous behavior
// broadcast every autobot_events payload to every connected board client.
//
// Decision (mirrors lib/tenancy/scope.js visibleClause semantics):
//   * principal.adminBypass (verified agent JWT only)  → deliver everything.
//   * event.owner_org_id present AND ∈ readOrgIds       → deliver.
//   * event.owner_org_id present but NOT in readOrgIds  → drop (cross-tenant).
//   * event.owner_org_id absent (org-less) → deliver ONLY if the event_type is
//     an explicit control/system signal (CONTROL_EVENT_TYPES). Any other
//     org-less event is dropped (fail-closed) — a missed emitter that forgets to
//     stamp org fails safe (no leak) and is visible via the debug log in api.js.
//
// CONTROL_EVENT_TYPES: the org-less signals emitted today that carry NO tenant
// payload, enumerated from the real emitters in lib/runtime/state/event-bus.js
// and lib/runtime/infrastructure.js (publishEvent):
//   - halt_signal     (emitHalt → emit, workItemId 'system')  — kill-switch fan-out
//   - halt_triggered  (emitHalt → publishEvent, workItemId null)
//   - halt_cleared    (clearHalt → publishEvent, workItemId null)
//   - connected       (SSE connect frame — synthetic, no org)
//   - heartbeat       (SSE heartbeat frame — synthetic, scoped separately)
// These are global operational/system events (the board MUST see a system-wide
// halt regardless of org). Tenant-bearing events (needs_attention, state
// changes) are NOT in this set: they carry work_item_id and are now org-stamped.
export const CONTROL_EVENT_TYPES = new Set([
  'halt_signal',
  'halt_triggered',
  'halt_cleared',
  'connected',
  'heartbeat',
]);

/** Normalize the event type field (emitters use either camel or snake case). */
export function eventTypeOf(event) {
  return event?.eventType || event?.event_type || 'unknown';
}

/**
 * Decide whether to deliver `event` to the SSE client identified by `principal`.
 * Pure: no I/O. Returns { deliver: boolean, unknownOrgless: boolean } so the
 * caller can log the first unknown org-less drop (visibility for missed stamps).
 *
 * @param {{adminBypass?: boolean, readOrgIds?: string[]}} principal
 * @param {object} event  the pg_notify('autobot_events') payload
 * @returns {{deliver: boolean, unknownOrgless: boolean}}
 */
export function shouldDeliverEvent(principal, event) {
  // adminBypass (verified agent JWT only — never user-controllable, see
  // lib/tenancy/scope.js header) sees everything.
  if (principal?.adminBypass) {
    return { deliver: true, unknownOrgless: false };
  }

  const ownerOrgId = event?.owner_org_id ?? null;

  // Tenant-bearing event: deliver iff the org is in the principal's read set.
  if (ownerOrgId) {
    const readOrgIds = principal?.readOrgIds || [];
    return { deliver: readOrgIds.includes(ownerOrgId), unknownOrgless: false };
  }

  // Org-less event: deliver only if it is an allow-listed control/system signal.
  const type = eventTypeOf(event);
  if (CONTROL_EVENT_TYPES.has(type)) {
    return { deliver: true, unknownOrgless: false };
  }

  // Org-less AND not control → fail closed (drop), and flag it so the caller can
  // log the first occurrence (a missed org stamp shows up as a dropped event,
  // never as a leak).
  return { deliver: false, unknownOrgless: true };
}
