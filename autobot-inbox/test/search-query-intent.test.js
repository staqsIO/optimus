import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractOrdinalIntent, parseTemporalRange } from '../src/api-routes/search.js';

describe('extractOrdinalIntent', () => {
  const cases = [
    ['my last meeting', { index: 0 }],
    ['most recent meeting', { index: 0 }],
    ['the latest meeting we had', { index: 0 }],
    ['next to last call', { index: 1 }],
    ['next-to-last meeting', { index: 1 }],
    ['second to last meeting', { index: 1 }],
    ['2nd to last conversation', { index: 1 }],
    ['second most recent meeting', { index: 1 }],
    ['3rd most recent meeting', { index: 2 }],
    ['third to last call', { index: 2 }],
    ['tenth most recent meeting', { index: 9 }],
  ];
  for (const [q, expected] of cases) {
    it(`"${q}" → index ${expected.index}`, () => {
      const r = extractOrdinalIntent(q);
      assert.ok(r, `expected match for "${q}"`);
      assert.equal(r.index, expected.index);
    });
  }

  const nonMatches = [
    'what did we discuss',
    'last week meeting',           // temporal, not ordinal
    'last Monday call',            // temporal, not ordinal
    'random sentence about Glenn',
  ];
  for (const q of nonMatches) {
    it(`"${q}" → no ordinal`, () => {
      assert.equal(extractOrdinalIntent(q), null);
    });
  }
});

describe('parseTemporalRange — relative "N units ago"', () => {
  const now = new Date('2026-04-18T12:00:00Z');
  const tz = 0;

  it('"2 weeks ago" returns a 7-day window', () => {
    const r = parseTemporalRange('meeting 2 weeks ago', now, tz);
    assert.ok(r);
    assert.equal(r.type, 'n_weeks_ago');
    assert.equal(r.label, '2 weeks ago');
    // 14 days before April 18 = April 4; window April 4–11
    assert.equal(r.from, '2026-04-04T00:00:00.000Z');
    assert.equal(r.to, '2026-04-11T00:00:00.000Z');
  });

  it('"3 days ago" returns a single-day window', () => {
    const r = parseTemporalRange('what happened 3 days ago', now, tz);
    assert.ok(r);
    assert.equal(r.type, 'n_days_ago');
    assert.equal(r.from, '2026-04-15T00:00:00.000Z');
    assert.equal(r.to, '2026-04-16T00:00:00.000Z');
  });

  it('"a week ago" maps to 1 week', () => {
    const r = parseTemporalRange('what did we decide a week ago', now, tz);
    assert.ok(r);
    assert.equal(r.type, 'n_weeks_ago');
    assert.equal(r.label, '1 week ago');
  });

  it('"one month ago" returns a calendar-month window', () => {
    const r = parseTemporalRange('the sync one month ago', now, tz);
    assert.ok(r);
    assert.equal(r.type, 'n_months_ago');
    // March 2026
    assert.equal(r.from, '2026-03-01T00:00:00.000Z');
    assert.equal(r.to, '2026-04-01T00:00:00.000Z');
  });

  it('"2 years ago" returns a calendar-year window', () => {
    const r = parseTemporalRange('the launch 2 years ago', now, tz);
    assert.ok(r);
    assert.equal(r.type, 'n_years_ago');
    assert.equal(r.from, '2024-01-01T00:00:00.000Z');
    assert.equal(r.to, '2025-01-01T00:00:00.000Z');
  });
});
