#!/usr/bin/env node
// verify-tenancy-live.mjs — ADR-012 / STAQPRO-588 post-deploy HTTP tenancy gate.
//
// WHY THIS EXISTS: the data-layer exit gate (test/tenancy-leak.e2e.test.js) was
// GREEN the entire time GET /api/signals was leaking cross-tenant in prod — it
// validated the SQL↔JS predicate, not the SERVED route. A route-collision
// (api-routes/flows.js re-registered an unscoped GET /api/signals that shadowed
// the scoped handler via last-writer-wins) only surfaces when you probe the
// running build over HTTP as the victim principal. This script is that probe.
//
// It calls the deployed API as different board identities (legacy Bearer
// API_SECRET + x-board-user header) and asserts the tenant boundary holds:
//   1. bare secret (no x-board-user)  → ZERO rows           (deny-by-default)
//   2. a non-owning org's member       → ZERO Staqs-owned rows (no cross-tenant read)
//   3. the owning member (control)     → > 0 rows            (not globally broken)
//   4. victim ∩ control row-id overlap → 0                  (truly disjoint)
//
// Usage:
//   API_SECRET=... node scripts/verify-tenancy-live.mjs [baseUrl]
//   (baseUrl defaults to $SMOKE_BASE_URL or https://preview.staqs.io)
//
// Exit 0 = boundary holds. Exit 1 = LEAK or unreachable. No PII is printed —
// only counts and owner_org_id tallies.

const BASE = process.argv[2] || process.env.SMOKE_BASE_URL || 'https://preview.staqs.io';
const SECRET = process.env.API_SECRET;
// Staqs production org id (the tenant whose rows must never leak to others).
const STAQS_ORG = process.env.STAQS_ORG_ID || '7c164445-43f2-4802-a7d3-5cab06611e99';
// Board github_usernames: a non-owning org member (victim) + the owning member (control).
const VICTIM = process.env.TENANCY_VICTIM_USER || 'ConsultingFuture4200'; // Dustin / consulting-futures
const CONTROL = process.env.TENANCY_CONTROL_USER || 'ecgang';             // Eric / staqs (owner)

if (!SECRET) {
  console.error('FATAL: API_SECRET env var is required.');
  process.exit(1);
}

async function getSignals(user) {
  const headers = { Authorization: `Bearer ${SECRET}` };
  if (user) headers['x-board-user'] = user;
  const res = await fetch(`${BASE}/api/signals?_cb=${Math.random()}`, { headers });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { return { status: res.status, rows: null, raw: text.slice(0, 120) }; }
  const rows = Array.isArray(json) ? json : json?.signals || [];
  return {
    status: res.status,
    rows,
    ids: rows.map((r) => r.id),
    staqsRows: rows.filter((r) => r.owner_org_id === STAQS_ORG).length,
  };
}

// STAQPRO-596: /api/today/* read content.documents. Use a wide window so the
// owning org reliably has rows regardless of which calendar day this runs on.
const NOW = new Date();
const WINDOW_START = new Date(NOW.getTime() - 35 * 24 * 3600 * 1000).toISOString();
const WINDOW_END = new Date(NOW.getTime() + 1 * 24 * 3600 * 1000).toISOString();

async function getToday(route, key, user, extra = '') {
  const headers = { Authorization: `Bearer ${SECRET}` };
  if (user) headers['x-board-user'] = user;
  const url = `${BASE}/api/today/${route}?start_iso=${WINDOW_START}&end_iso=${WINDOW_END}${extra}&_cb=${Math.random()}`;
  const res = await fetch(url, { headers });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { return { status: res.status, rows: null, raw: text.slice(0, 120) }; }
  const rows = Array.isArray(json) ? json : json?.[key] || [];
  return { status: res.status, rows };
}

const getTodayMeetings = (user, extra) => getToday('meetings', 'meetings', user, extra);
const getTodayAttendees = (user) => getToday('meeting-attendees', 'attendees', user);

const fails = [];
function check(cond, msg) {
  console.log(`${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) fails.push(msg);
}

const r = await Promise.all([getSignals(VICTIM), getSignals(CONTROL), getSignals(null)]);
const [victim, control, bare] = r;

console.log(`base=${BASE}`);
console.log(`  victim  (${VICTIM}):  status=${victim.status} count=${victim.rows?.length ?? '?'} staqs_rows=${victim.staqsRows ?? '?'}`);
console.log(`  control (${CONTROL}): status=${control.status} count=${control.rows?.length ?? '?'} staqs_rows=${control.staqsRows ?? '?'}`);
console.log(`  bare    (no header):  status=${bare.status} count=${bare.rows?.length ?? '?'}`);

if ([victim, control, bare].some((x) => x.rows === null)) {
  console.error('FATAL: /api/signals did not return JSON (deploy may still be propagating).');
  process.exit(1);
}

const overlap = victim.ids.filter((id) => control.ids.includes(id)).length;

check(bare.rows.length === 0, 'GET /api/signals with a bare secret (no x-board-user) returns ZERO rows (deny-by-default)');
check(victim.staqsRows === 0, `victim (${VICTIM}) sees ZERO Staqs-owned signals (no cross-tenant read)`);
check(control.rows.length > 0, `control (${CONTROL}) sees its own signals (scoping is not globally broken)`);
check(overlap === 0, `victim ∩ control row-id overlap is 0 (got ${overlap})`);

// ── STAQPRO-596: /api/today/meetings + /api/today/meeting-attendees ──────────
// victim passes all=1 too — it must NOT widen for a non-admin (org-scope holds
// AND the all=1 bypass is admin-only). control uses the attendees route as the
// "not globally broken" signal (no per-viewer email filter on that route).
const [mBare, mVictim, aBare, aVictim, aControl] = await Promise.all([
  getTodayMeetings(null),
  getTodayMeetings(VICTIM, '&all=1'),
  getTodayAttendees(null),
  getTodayAttendees(VICTIM),
  getTodayAttendees(CONTROL),
]);

console.log(`  today/meetings   bare:   status=${mBare.status} count=${mBare.rows?.length ?? '?'}`);
console.log(`  today/meetings   victim(all=1): status=${mVictim.status} count=${mVictim.rows?.length ?? '?'}`);
console.log(`  today/attendees  bare:   status=${aBare.status} count=${aBare.rows?.length ?? '?'}`);
console.log(`  today/attendees  victim: status=${aVictim.status} count=${aVictim.rows?.length ?? '?'}`);
console.log(`  today/attendees  control:status=${aControl.status} count=${aControl.rows?.length ?? '?'}`);

if ([mBare, mVictim, aBare, aVictim, aControl].some((x) => x.rows === null)) {
  console.error('FATAL: /api/today/* did not return JSON (deploy may still be propagating).');
  process.exit(1);
}

check(mBare.rows.length === 0, 'GET /api/today/meetings with a bare secret returns ZERO rows (deny-by-default)');
check(mVictim.rows.length === 0, `victim (${VICTIM}) sees ZERO meetings even with all=1 (org-scope + all=1 is admin-only)`);
check(aBare.rows.length === 0, 'GET /api/today/meeting-attendees with a bare secret returns ZERO rows (deny-by-default)');
check(aVictim.rows.length === 0, `victim (${VICTIM}) sees ZERO meeting-attendees (no cross-tenant read)`);
check(aControl.rows.length > 0, `control (${CONTROL}) sees its own org's meeting-attendees (scoping is not globally broken)`);

if (fails.length) {
  console.error(`\n❌ TENANCY LEAK — ${fails.length} assertion(s) failed on ${BASE}`);
  process.exit(1);
}
console.log('\n✅ Tenancy boundary holds on /api/signals and /api/today/*.');
process.exit(0);
