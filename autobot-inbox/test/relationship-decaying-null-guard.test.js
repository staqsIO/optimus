/**
 * STAQPRO-554 — findDecayingRelationships must exclude contacts with no
 * email history (both last_received_at and last_sent_at NULL) so they no
 * longer surface as bogus "~20604d silent" (epoch-zero) rows.
 *
 * Unit test: inject a mock queryFn that (a) asserts the SQL carries the
 * NULL-history guard and (b) simulates Postgres filtering so a no-history
 * contact never reaches the result set.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findDecayingRelationships } from '../../lib/graph/relationship-strength.js';

// Minimal stand-in rows. Only the no-history contact (both NULL) must be
// dropped by the guard; the stale-but-real contact must survive.
const NOW = Date.now();
const days = (n) => new Date(NOW - n * 86400_000).toISOString();

const ROWS = [
  {
    id: 'real',
    name: 'Real Stale',
    email_address: 'real@staqs.io',
    tier: 'inner_circle',
    is_vip: false,
    last_received_at: days(40),
    last_sent_at: null,
    days_silent: 40,
  },
  {
    id: 'nohist',
    name: 'No History',
    email_address: 'diego@staqs.io',
    tier: 'inner_circle',
    is_vip: false,
    last_received_at: null,
    last_sent_at: null,
    days_silent: 20604,
  },
];

test('SQL includes the NULL last-contact guard clause', async () => {
  let capturedSql = '';
  const queryFn = async (sql) => {
    capturedSql = sql;
    return { rows: [] };
  };
  await findDecayingRelationships(queryFn, { staleAfterDays: 14, limit: 10 });

  const normalized = capturedSql.replace(/\s+/g, ' ');
  assert.match(
    normalized,
    /\(c\.last_received_at IS NOT NULL OR c\.last_sent_at IS NOT NULL\)/,
    'guard clause excluding no-email-history contacts must be present',
  );
  // GREATEST/COALESCE/1970 epoch fallback is retained for surviving rows only.
  assert.match(normalized, /GREATEST\(/, 'GREATEST still used for surviving rows');
});

test('no-history contacts are filtered out (no bogus 20604d row)', async () => {
  // Simulate Postgres applying the guard: drop rows where both dates are NULL.
  const queryFn = async () => ({
    rows: ROWS.filter((r) => r.last_received_at !== null || r.last_sent_at !== null),
  });
  const out = await findDecayingRelationships(queryFn, { staleAfterDays: 14, limit: 10 });

  assert.equal(out.length, 1, 'only the real stale contact survives');
  assert.equal(out[0].id, 'real');
  assert.ok(
    out.every((r) => r.days_silent < 3650),
    'no surviving row shows an absurd (>10yr) silent duration',
  );
});
