import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

/**
 * STAQPRO-321: signal.domain has a CHECK allowlist
 * ('general' | 'financial' | 'legal' | 'scheduling'). Sources that supply
 * anything outside that set used to throw inside the ingester's try-catch
 * and the signal got silently dropped (Linear webhook → "0 signal(s)
 * ingested"). normalizeDomain() coerces unknown values to NULL so the row
 * still lands.
 *
 * These tests pin the normalization contract AND the end-to-end behavior
 * — a Linear-style payload now produces ≥1 signal row regardless of the
 * domain value supplied.
 */
describe('STAQPRO-321 — signal domain normalization', () => {
  let queryFn;
  let ingestAsSignal;
  let normalizeDomain;
  let resetWarnings;
  const RUN = `321-${Date.now()}`;

  before(async () => {
    delete process.env.DATABASE_URL;
    process.env.NODE_ENV = 'test';
    process.env.SQL_DIR = new URL('../sql', import.meta.url).pathname;
    process.env.PGLITE_DATA_DIR = new URL('../data/pglite-signal-domain', import.meta.url).pathname;
    const db = await import('../src/db.js');
    queryFn = db.query;
    await db.initializeDatabase();
    const mod = await import('../src/webhooks/signal-ingester.js');
    ingestAsSignal = mod.ingestAsSignal;
    normalizeDomain = mod.normalizeDomain;
    resetWarnings = mod._resetDomainWarningsForTest;
    resetWarnings();
  });

  describe('normalizeDomain (pure)', () => {
    it('passes through allowed values', () => {
      assert.equal(normalizeDomain('general'), 'general');
      assert.equal(normalizeDomain('financial'), 'financial');
      assert.equal(normalizeDomain('legal'), 'legal');
      assert.equal(normalizeDomain('scheduling'), 'scheduling');
    });

    it('lowercases + trims before matching', () => {
      assert.equal(normalizeDomain('  GENERAL  '), 'general');
      assert.equal(normalizeDomain('Legal'), 'legal');
    });

    it('coerces null/undefined/empty to null', () => {
      assert.equal(normalizeDomain(null), null);
      assert.equal(normalizeDomain(undefined), null);
      assert.equal(normalizeDomain(''), null);
    });

    it('coerces unknown values to null', () => {
      assert.equal(normalizeDomain('staqs internal projects'), null);
      assert.equal(normalizeDomain('engineering'), null);
      assert.equal(normalizeDomain('umb advisors mailbox'), null);
    });
  });

  describe('ingestAsSignal end-to-end', () => {
    it('Linear-style payload with team-name domain inserts cleanly', async () => {
      const providerMsgId = `linear_${RUN}_team-name`;
      const result = await ingestAsSignal({
        source: 'linear',
        title: 'STAQPRO-999: test issue',
        snippet: 'Test issue snippet',
        from: 'Test User',
        signals: [{
          signal_type: 'request',
          content: 'STAQPRO-999: test issue [Medium] — Staqs Internal Projects',
          confidence: 0.8,
          direction: 'inbound',
          // The constraint-violating value that caused silent drops.
          domain: 'Staqs Internal Projects',
        }],
        metadata: { linear_team: 'Staqs Internal Projects' },
        providerMsgId,
      });
      assert.ok(result, 'ingestAsSignal must return a result, not null');
      assert.equal(result.signalIds?.length, 1, 'exactly one signal row created');

      const r = await queryFn(
        `SELECT domain FROM inbox.signals WHERE message_id = $1`,
        [result.messageId],
      );
      assert.equal(r.rows.length, 1);
      assert.equal(r.rows[0].domain, null, 'invalid domain coerced to NULL by ingester');
    });

    it('allowed domain values pass through to the row', async () => {
      const providerMsgId = `linear_${RUN}_allowed`;
      const result = await ingestAsSignal({
        source: 'linear',
        title: 'Test allowed',
        snippet: 'snip',
        from: 'tester',
        signals: [{
          signal_type: 'request',
          content: 'test content',
          domain: 'financial',
        }],
        providerMsgId,
      });
      const r = await queryFn(
        `SELECT domain FROM inbox.signals WHERE message_id = $1`,
        [result.messageId],
      );
      assert.equal(r.rows[0].domain, 'financial');
    });

    it('null domain stays null', async () => {
      const providerMsgId = `linear_${RUN}_null`;
      const result = await ingestAsSignal({
        source: 'linear',
        title: 'Test null',
        snippet: 'snip',
        from: 'tester',
        signals: [{
          signal_type: 'request',
          content: 'test content',
          // no domain
        }],
        providerMsgId,
      });
      const r = await queryFn(
        `SELECT domain FROM inbox.signals WHERE message_id = $1`,
        [result.messageId],
      );
      assert.equal(r.rows[0].domain, null);
    });
  });
});
