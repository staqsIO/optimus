import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tokenCostUsd, recordSpend, dailySpendUsd } from '../../lib/llm/record-spend.js';

describe('tokenCostUsd', () => {
  it('prices gpt-4o-mini per agents.json (0.15 in / 0.60 out per 1M)', () => {
    assert.equal(tokenCostUsd('gpt-4o-mini', 1_000_000, 0), 0.15);
    assert.equal(tokenCostUsd('gpt-4o-mini', 0, 1_000_000), 0.6);
    assert.ok(Math.abs(tokenCostUsd('gpt-4o-mini', 500_000, 500_000) - 0.375) < 1e-9);
  });

  it('bills embeddings on input only (output cost 0)', () => {
    assert.equal(tokenCostUsd('text-embedding-3-small', 1_000_000, 0), 0.02);
    assert.equal(tokenCostUsd('text-embedding-3-small', 0, 1_000_000), 0);
  });

  it('returns 0 for unknown models (no silent mispricing)', () => {
    assert.equal(tokenCostUsd('some-unlisted-model', 1_000_000, 1_000_000), 0);
  });

  it('treats missing/garbage token counts as 0', () => {
    assert.equal(tokenCostUsd('gpt-4o-mini'), 0);
    assert.equal(tokenCostUsd('gpt-4o-mini', undefined, null), 0);
  });
});

describe('recordSpend cost math + graceful failure', () => {
  it('returns computed cost (tokens + surcharge) and does not throw on invalid input', async () => {
    // Missing agentId fails the precondition BEFORE any DB call, so this needs no DB.
    const r = await recordSpend({
      agentId: '',
      model: 'gpt-4o-mini',
      inputTokens: 1_000_000,
      outputTokens: 0,
      surchargeUsd: 0.025,
      kind: 'web_search',
    });
    assert.equal(r.recorded, false);
    assert.ok(Math.abs(r.costUsd - (0.15 + 0.025)) < 1e-9, `expected 0.175, got ${r.costUsd}`);
  });

  it('honors a pre-computed costUsd over token derivation, plus surcharge', async () => {
    const r = await recordSpend({
      agentId: '', // force the no-DB path
      model: 'gpt-4o-mini',
      costUsd: 1.0,
      surchargeUsd: 0.5,
    });
    assert.equal(r.recorded, false);
    assert.ok(Math.abs(r.costUsd - 1.5) < 1e-9);
  });
});

describe('dailySpendUsd', () => {
  it('is exported and returns a number (0 on any DB error, fail-safe)', async () => {
    const v = await dailySpendUsd('definitely-not-an-agent');
    assert.equal(typeof v, 'number');
  });
});
