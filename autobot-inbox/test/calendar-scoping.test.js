// OPT-126: per-member calendar scoping (OPT-115 sibling).
//
// Covers the pure ownership gate (mayManageWatch) and the email-scope
// plumbing through the two read cores via their injected queryFn seam.
// Route-level behavior (watch list scoping, 403/404 throws) is exercised
// against prod in the live round-trip — the OPT-115 lesson is that the
// live check is the real test for auth flows; these unit tests pin the
// pure logic and the SQL contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mayManageWatch,
  listCalendarMonthsCore,
  getCalendarDayCore,
} from '../src/api-routes/calendar.js';

const ERIC = { ownerId: 'uuid-eric', emails: ['eric@staqs.io', 'eric@umbadvisors.com'], adminBypass: false };
const AGENT = { ownerId: null, emails: [], adminBypass: true };
const BARE = { ownerId: null, emails: [], adminBypass: false };

test('mayManageWatch: owner email match allows', () => {
  assert.equal(mayManageWatch(ERIC, { account_email: 'eric@staqs.io' }), true);
  assert.equal(mayManageWatch(ERIC, { account_email: 'ERIC@STAQS.IO'.toLowerCase() }), true);
});

test('mayManageWatch: foreign email denies', () => {
  assert.equal(mayManageWatch(ERIC, { account_email: 'dustin@umbadvisors.com' }), false);
});

test('mayManageWatch: adminBypass (agent JWT) always allows', () => {
  assert.equal(mayManageWatch(AGENT, { account_email: 'dustin@umbadvisors.com' }), true);
});

test('mayManageWatch: unidentified / bare-secret viewer denies (fail-closed)', () => {
  assert.equal(mayManageWatch(null, { account_email: 'eric@staqs.io' }), false);
  assert.equal(mayManageWatch(BARE, { account_email: 'eric@staqs.io' }), false);
  assert.equal(mayManageWatch(ERIC, null), false);
});

function captureQueryFn() {
  const calls = [];
  const fn = async (sql, values) => {
    calls.push({ sql, values });
    return { rows: [] };
  };
  return { fn, calls };
}

const PRINCIPAL = null; // visibleClause(null) → FALSE; irrelevant to what we assert here.

test('months core: email scope adds account_email filter with the scope as last param', async () => {
  const { fn, calls } = captureQueryFn();
  const res = await listCalendarMonthsCore(fn, { start: '2026-06-01', end: '2026-06-08' }, PRINCIPAL, ['eric@staqs.io']);
  assert.ok(!res.error, res.error);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /LOWER\(ce\.account_email\) = ANY\(\$\d+::text\[\]\)/);
  assert.deepEqual(calls[0].values.at(-1), ['eric@staqs.io']);
});

test('months core: null scope (legacy/admin) leaves the gcal CTE unfiltered', async () => {
  const { fn, calls } = captureQueryFn();
  await listCalendarMonthsCore(fn, { start: '2026-06-01', end: '2026-06-08' }, PRINCIPAL, null);
  assert.doesNotMatch(calls[0].sql, /account_email\) = ANY/);
});

test('months core: empty scope still parameterizes (→ zero gcal rows, fail-closed)', async () => {
  const { fn, calls } = captureQueryFn();
  await listCalendarMonthsCore(fn, { start: '2026-06-01', end: '2026-06-08' }, PRINCIPAL, []);
  assert.match(calls[0].sql, /LOWER\(ce\.account_email\) = ANY\(\$\d+::text\[\]\)/);
  assert.deepEqual(calls[0].values.at(-1), []);
});

test('day core: email scope filters the calendar_events query and lowercases', async () => {
  const calls = [];
  const fn = async (sql, values) => {
    calls.push({ sql, values });
    return { rows: [] };
  };
  const res = await getCalendarDayCore(fn, { date: '2026-06-11' }, PRINCIPAL, ['Eric@Staqs.io']);
  assert.ok(!res.error, res.error);
  const gcalCall = calls.find((c) => c.sql.includes('inbox.calendar_events'));
  assert.ok(gcalCall, 'expected a calendar_events query');
  assert.match(gcalCall.sql, /LOWER\(ce\.account_email\) = ANY\(\$\d+::text\[\]\)/);
  assert.deepEqual(gcalCall.values.at(-1), ['eric@staqs.io']);
});

test('day core: gcal events expose account_email in meta', async () => {
  const fn = async (sql) => {
    if (sql.includes('inbox.calendar_events')) {
      return {
        rows: [{
          id: 'ev1', account_email: 'eric@staqs.io', gcal_event_id: 'g1',
          title: 'Standup', location: null, hangout_link: null,
          organizer_email: 'eric@staqs.io', attendees: [],
          start_at: '2026-06-11T16:00:00Z', end_at: '2026-06-11T16:30:00Z',
          all_day: false, status: 'confirmed',
        }],
      };
    }
    return { rows: [] };
  };
  const res = await getCalendarDayCore(fn, { date: '2026-06-11' }, PRINCIPAL, ['eric@staqs.io']);
  const gcal = res.events.find((e) => e.kind === 'gcal_event');
  assert.ok(gcal);
  assert.equal(gcal.meta.account_email, 'eric@staqs.io');
});
