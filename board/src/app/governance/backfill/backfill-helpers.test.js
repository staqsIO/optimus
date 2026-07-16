// Tests for BackfillPanel pure helpers (FR-B2, ADR-004).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildBackfillFilters,
  summarizeBackfillBuckets,
  formatBackfillBadge,
} from './backfill-helpers.js';

// ---------------------------------------------------------------------------
// buildBackfillFilters
// ---------------------------------------------------------------------------

test('buildBackfillFilters: empty input → defaults', () => {
  const out = buildBackfillFilters({});
  assert.deepEqual(out, { status: [], min_relevance: 0.0, max_age_days: null });
});

test('buildBackfillFilters: no argument at all → defaults', () => {
  const out = buildBackfillFilters();
  assert.deepEqual(out, { status: [], min_relevance: 0.0, max_age_days: null });
});

test('buildBackfillFilters: statuses lowercased + deduped', () => {
  const out = buildBackfillFilters({
    statusInclude: ['PENDING', 'pending', 'In_Progress', 'in_progress', 'NEW'],
  });
  assert.deepEqual(out.status.sort(), ['in_progress', 'new', 'pending'].sort());
});

test('buildBackfillFilters: terminal statuses (done/skipped/not_for_us) are removed', () => {
  const out = buildBackfillFilters({
    statusInclude: ['pending', 'done', 'skipped', 'NOT_FOR_US', 'in_progress'],
  });
  assert.ok(!out.status.includes('done'));
  assert.ok(!out.status.includes('skipped'));
  assert.ok(!out.status.includes('not_for_us'));
  assert.deepEqual(out.status.sort(), ['in_progress', 'pending'].sort());
});

test('buildBackfillFilters: minRelevance clamped to 0..1', () => {
  assert.equal(buildBackfillFilters({ minRelevance: 1.5 }).min_relevance, 1.0);
  assert.equal(buildBackfillFilters({ minRelevance: -0.5 }).min_relevance, 0.0);
  assert.equal(buildBackfillFilters({ minRelevance: 0.42 }).min_relevance, 0.42);
  assert.equal(buildBackfillFilters({ minRelevance: '0.7' }).min_relevance, 0.7);
});

test('buildBackfillFilters: invalid minRelevance → defaults to 0.0', () => {
  assert.equal(buildBackfillFilters({ minRelevance: 'abc' }).min_relevance, 0.0);
  assert.equal(buildBackfillFilters({ minRelevance: NaN }).min_relevance, 0.0);
  assert.equal(buildBackfillFilters({ minRelevance: null }).min_relevance, 0.0);
  assert.equal(buildBackfillFilters({ minRelevance: undefined }).min_relevance, 0.0);
});

test('buildBackfillFilters: maxAgeDays positive int OR null', () => {
  assert.equal(buildBackfillFilters({ maxAgeDays: 7 }).max_age_days, 7);
  assert.equal(buildBackfillFilters({ maxAgeDays: '30' }).max_age_days, 30);
  assert.equal(buildBackfillFilters({ maxAgeDays: 1.9 }).max_age_days, 1);
  assert.equal(buildBackfillFilters({ maxAgeDays: null }).max_age_days, null);
});

test('buildBackfillFilters: invalid maxAgeDays → null', () => {
  assert.equal(buildBackfillFilters({ maxAgeDays: 0 }).max_age_days, null);
  assert.equal(buildBackfillFilters({ maxAgeDays: -5 }).max_age_days, null);
  assert.equal(buildBackfillFilters({ maxAgeDays: 'abc' }).max_age_days, null);
  assert.equal(buildBackfillFilters({ maxAgeDays: NaN }).max_age_days, null);
});

// ---------------------------------------------------------------------------
// summarizeBackfillBuckets
// ---------------------------------------------------------------------------

test('summarizeBackfillBuckets: empty rows → all zeros', () => {
  const out = summarizeBackfillBuckets([]);
  assert.deepEqual(out.byStatus, {});
  assert.deepEqual(out.byRelevanceBand, { high: 0, mid: 0, low: 0 });
  assert.deepEqual(out.byAgeBucket, { '<7d': 0, '7-30d': 0, '>30d': 0 });
});

test('summarizeBackfillBuckets: null/undefined → empty zeros', () => {
  const out = summarizeBackfillBuckets(null);
  assert.deepEqual(out.byStatus, {});
  assert.deepEqual(out.byRelevanceBand, { high: 0, mid: 0, low: 0 });
  assert.deepEqual(out.byAgeBucket, { '<7d': 0, '7-30d': 0, '>30d': 0 });
});

test('summarizeBackfillBuckets: counts by status', () => {
  const rows = [
    { status: 'pending', relevance_score: 0.5, age_days: 1 },
    { status: 'pending', relevance_score: 0.5, age_days: 1 },
    { status: 'in_progress', relevance_score: 0.5, age_days: 1 },
    { status: 'new', relevance_score: 0.5, age_days: 1 },
  ];
  const out = summarizeBackfillBuckets(rows);
  assert.deepEqual(out.byStatus, { pending: 2, in_progress: 1, new: 1 });
});

test('summarizeBackfillBuckets: relevance bands grouped correctly', () => {
  const rows = [
    { status: 'pending', relevance_score: 0.95, age_days: 1 }, // high
    { status: 'pending', relevance_score: 0.8, age_days: 1 },  // high (≥0.8)
    { status: 'pending', relevance_score: 0.7, age_days: 1 },  // mid
    { status: 'pending', relevance_score: 0.6, age_days: 1 },  // mid (≥0.6)
    { status: 'pending', relevance_score: 0.59, age_days: 1 }, // low
    { status: 'pending', relevance_score: 0.0, age_days: 1 },  // low
  ];
  const out = summarizeBackfillBuckets(rows);
  assert.deepEqual(out.byRelevanceBand, { high: 2, mid: 2, low: 2 });
});

test('summarizeBackfillBuckets: age buckets correct', () => {
  const rows = [
    { status: 'pending', relevance_score: 0.5, age_days: 0 },   // <7d
    { status: 'pending', relevance_score: 0.5, age_days: 6 },   // <7d
    { status: 'pending', relevance_score: 0.5, age_days: 7 },   // 7-30d
    { status: 'pending', relevance_score: 0.5, age_days: 30 },  // 7-30d
    { status: 'pending', relevance_score: 0.5, age_days: 31 },  // >30d
    { status: 'pending', relevance_score: 0.5, age_days: 365 }, // >30d
  ];
  const out = summarizeBackfillBuckets(rows);
  assert.deepEqual(out.byAgeBucket, { '<7d': 2, '7-30d': 2, '>30d': 2 });
});

// ---------------------------------------------------------------------------
// formatBackfillBadge
// ---------------------------------------------------------------------------

test('formatBackfillBadge: pending → "Pending: N tasks queued"', () => {
  assert.equal(
    formatBackfillBadge({ state: 'pending', task_count: 5 }),
    'Pending: 5 tasks queued'
  );
});

test('formatBackfillBadge: in_progress → "In progress: N tasks"', () => {
  assert.equal(
    formatBackfillBadge({ state: 'in_progress', task_count: 12 }),
    'In progress: 12 tasks'
  );
});

test('formatBackfillBadge: completed → "Completed: N tasks pushed"', () => {
  assert.equal(
    formatBackfillBadge({ state: 'completed', task_count: 8 }),
    'Completed: 8 tasks pushed'
  );
});

test('formatBackfillBadge: cancelled with task_count > 0 → just "Cancelled"', () => {
  assert.equal(
    formatBackfillBadge({ state: 'cancelled', task_count: 4 }),
    'Cancelled'
  );
  assert.equal(
    formatBackfillBadge({ state: 'cancelled', task_count: 0 }),
    'Cancelled'
  );
});

test('formatBackfillBadge: unknown state → "Unknown"', () => {
  assert.equal(
    formatBackfillBadge({ state: 'mystery', task_count: 1 }),
    'Unknown'
  );
  assert.equal(formatBackfillBadge({}), 'Unknown');
  assert.equal(formatBackfillBadge(null), 'Unknown');
});
