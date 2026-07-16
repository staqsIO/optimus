/**
 * Bounded-concurrency helper for the weekly-recap per-meeting LLM extraction
 * (Plan 031, fix 3). The serial `for` loop over meetings was replaced with a
 * bounded-concurrency map. Two invariants must hold for the recap output to
 * stay byte-identical to the old serial version while respecting LLM rate
 * limits:
 *
 *   (a) results are returned in the SAME order as the input (recap HTML groups
 *       meetings in order), regardless of which extraction resolves first;
 *   (b) no more than `limit` calls are ever in flight at once (rate-limit
 *       safety — not an unbounded fan-out).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapWithConcurrency } from '../src/signal/weekly-recap.js';

// (a) Order is preserved even when later items resolve first.
test('mapWithConcurrency preserves input order despite out-of-order completion', async () => {
  const items = [0, 1, 2, 3, 4, 5];
  // Earlier indices sleep longer, so they resolve AFTER later ones.
  const out = await mapWithConcurrency(items, 3, async (n) => {
    await new Promise((r) => setTimeout(r, (items.length - n) * 5));
    return n * 10;
  });
  assert.deepEqual(out, [0, 10, 20, 30, 40, 50]);
});

// (b) At most `limit` tasks run concurrently.
test('mapWithConcurrency never exceeds the concurrency limit', async () => {
  const limit = 3;
  let inFlight = 0;
  let maxInFlight = 0;
  const items = Array.from({ length: 20 }, (_, i) => i);
  await mapWithConcurrency(items, limit, async (n) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 2));
    inFlight--;
    return n;
  });
  assert.ok(maxInFlight <= limit, `maxInFlight ${maxInFlight} exceeded limit ${limit}`);
  assert.ok(maxInFlight > 1, 'expected some concurrency, not serial execution');
});

// Empty input is a no-op returning an empty array (no meetings that week).
test('mapWithConcurrency handles empty input', async () => {
  const out = await mapWithConcurrency([], 4, async () => {
    throw new Error('fn should not be called for empty input');
  });
  assert.deepEqual(out, []);
});

// Fail-fast (#518): once fn throws, sibling workers must NOT pull new items off
// the queue. The rejection propagates (reject-on-first-error contract), and the
// wasted work is bounded to the in-flight batch, not the whole remaining queue.
// The n===0 throw is synchronous (no await before it), so the rejection
// microtask sets `failed` before any sibling's setTimeout macrotask fires —
// making the "no new items pulled" assertion deterministic.
test('mapWithConcurrency fails fast — a throw stops workers pulling new items', async () => {
  const limit = 3;
  let calls = 0;
  const items = Array.from({ length: 30 }, (_, i) => i);
  await assert.rejects(
    mapWithConcurrency(items, limit, async (n) => {
      calls++;
      if (n === 0) throw new Error('boom');
      await new Promise((r) => setTimeout(r, 5));
      return n;
    }),
    /boom/,
  );
  // Only the initial in-flight batch (<= limit) ever ran; the other 27 items
  // were never pulled after `failed` was set. Without the fail-fast flag this
  // would be 30 (the whole queue drains despite the rejection).
  assert.ok(calls <= limit, `expected <= ${limit} calls after fail-fast, got ${calls}`);
});
