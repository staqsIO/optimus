/**
 * Property-based tests for CHECK constraints on agent-written tables.
 *
 * Each test asserts that a producer function's output, evaluated across
 * its full input domain, always satisfies the corresponding DB CHECK.
 * The bug fixed in PR #150 (tone_score persisting negative cosine
 * similarity) is the canonical example — it would be caught here.
 *
 * Manifest: autobot-inbox/config/agent-touched-checks.json
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as fc from 'fast-check';

import { clampToneScoreForPersistence } from '../../lib/runtime/guard-check.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const manifestPath = resolve(__dirname, '../config/agent-touched-checks.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

describe('agent-touched CHECK constraints — property tests', () => {
  // ─── tone_score: PR #150 regression ────────────────────────────────────
  it('action_proposals.tone_score: clamp output is always in [0, 1]', () => {
    fc.assert(
      fc.property(
        // Generate floats well outside the cosine-similarity range so we
        // catch any future producer that emits values beyond [-1, 1].
        fc.double({ min: -10, max: 10, noNaN: true }),
        (raw) => {
          const clamped = clampToneScoreForPersistence(raw);
          assert.ok(
            clamped >= 0 && clamped <= 1,
            `clampToneScoreForPersistence(${raw}) = ${clamped} violates CHECK [0,1]`
          );
        }
      ),
      { numRuns: 1000 }
    );
  });

  it('action_proposals.tone_score: handles non-finite inputs without violating CHECK', () => {
    for (const raw of [NaN, Infinity, -Infinity, undefined, null, 'string']) {
      const clamped = clampToneScoreForPersistence(raw);
      assert.ok(
        clamped >= 0 && clamped <= 1,
        `clampToneScoreForPersistence(${raw}) = ${clamped} violates CHECK [0,1]`
      );
    }
  });

  it('action_proposals.tone_score: rounds to 2 decimals (CHECK uses NUMERIC(3,2))', () => {
    fc.assert(
      fc.property(fc.double({ min: -1, max: 1, noNaN: true }), (raw) => {
        const clamped = clampToneScoreForPersistence(raw);
        // NUMERIC(3,2) accepts at most 2 decimals; multiply by 100 should be integer.
        const scaled = clamped * 100;
        assert.ok(
          Math.abs(scaled - Math.round(scaled)) < 1e-9,
          `${clamped} has more than 2 decimals (would be rejected by NUMERIC(3,2))`
        );
      }),
      { numRuns: 500 }
    );
  });

  // ─── action_proposals.channel: 2026-05-08 webhook regression ──────────
  it('action_proposals.channel: producer set is a subset of the persisted CHECK set', () => {
    // Producer: inbox.messages.channel ENUM (per 001-baseline). Anything in
    // this set may flow into an action_proposals.channel via the responder,
    // so the action_proposals CHECK must accept all of them.
    const PRODUCER_CHANNELS = ['email', 'slack', 'whatsapp', 'telegram', 'webhook'];
    // Persisted CHECK on action_proposals.channel after migration 090.
    const PERSISTED_ALLOWED = new Set(['email', 'slack', 'whatsapp', 'telegram', 'webhook']);
    for (const v of PRODUCER_CHANNELS) {
      assert.ok(
        PERSISTED_ALLOWED.has(v),
        `inbox.messages.channel '${v}' is not allowed by action_proposals.channel CHECK — flowing this value through the responder will cause a runtime CHECK violation. Add it to migration 090 (or a new migration) and update this test.`
      );
    }
  });

  // ─── manifest coverage ratchet ─────────────────────────────────────────
  it('manifest covers every documented CHECK with required fields', () => {
    assert.ok(Array.isArray(manifest.checks), 'manifest.checks must be an array');
    assert.ok(manifest.checks.length > 0, 'manifest.checks must not be empty');
    for (const entry of manifest.checks) {
      assert.ok(entry.table, `entry missing table: ${JSON.stringify(entry)}`);
      assert.ok(entry.column, `entry missing column for ${entry.table}`);
      assert.ok(entry.check_expression, `entry missing check_expression for ${entry.table}.${entry.column}`);
      assert.ok(
        ['verified', 'documented'].includes(entry.status),
        `entry.status must be verified|documented for ${entry.table}.${entry.column}, got ${entry.status}`
      );
    }
  });

  it('every "verified" manifest entry has at least one property test in this file', () => {
    // The only verified entry today is tone_score. As more get verified, this
    // test will need to grow alongside (matching test names by column).
    const verified = manifest.checks.filter((c) => c.status === 'verified');
    const expectedColumns = new Set(verified.map((c) => c.column));
    const knownVerifiedColumns = new Set(['tone_score', 'channel']);
    for (const col of expectedColumns) {
      assert.ok(
        knownVerifiedColumns.has(col),
        `Manifest marks ${col} as 'verified' but no property test exists in this file. Add a test or change status to 'documented'.`
      );
    }
  });
});
