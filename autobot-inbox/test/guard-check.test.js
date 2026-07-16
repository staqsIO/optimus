import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { checkDraftGates, guardCheck } from '../src/runtime/guard-check.js';

// Stub txClient that returns empty rows — avoids PGlite init for unit tests.
// G6 rate-limit check queries action_proposals; without a DB this crashes.
const stubClient = { query: async () => ({ rows: [], rowCount: 0 }) };

describe('checkDraftGates', () => {
  it('passes clean draft', async () => {
    const draft = {
      body: 'Hi John, thanks for reaching out. Let me review this and get back to you.',
      to_addresses: ['john@example.com'],
    };

    const result = await checkDraftGates(draft, null, stubClient);
    assert.ok(result.passed);
  });

  it('flags commitment language (G2)', async () => {
    const draft = {
      body: 'I promise we will deliver the feature by March 15th for $5,000.',
      to_addresses: ['client@example.com'],
    };

    const result = await checkDraftGates(draft);
    assert.equal(result.gates.G2.passed, false);
    assert.ok(result.gates.G2.matches.length > 0);
  });

  it('flags large recipient list (G5)', async () => {
    const draft = {
      body: 'Quick update for the team.',
      to_addresses: ['a@test.com', 'b@test.com', 'c@test.com'],
      cc_addresses: ['d@test.com', 'e@test.com', 'f@test.com'],
    };

    const result = await checkDraftGates(draft);
    assert.equal(result.gates.G5.passed, false);
    assert.ok(result.gates.G5.recipientCount > 5);
  });

  it('flags pricing precedent (G7)', async () => {
    const draft = {
      body: 'Our pricing for this service is $500 per month.',
      to_addresses: ['prospect@example.com'],
    };

    const result = await checkDraftGates(draft);
    assert.equal(result.gates.G7.passed, false);
    assert.ok(result.gates.G7.matches.length > 0);
  });

  it('email_draft runs all gates (backward compat)', async () => {
    const draft = {
      body: 'Quick update for the team.',
      to_addresses: ['a@test.com'],
    };

    const result = await checkDraftGates(draft, null, null, null, 'email_draft');
    for (const gateId of ['G2', 'G3', 'G5', 'G6', 'G7']) {
      assert.equal(result.gates[gateId].skipped, undefined, `${gateId} should not be skipped for email_draft`);
    }
  });

  it('content_post skips G3, G5, G6', async () => {
    const draft = {
      body: 'Excited to share our latest insights on supply chain optimization.',
      to_addresses: [],
    };

    const result = await checkDraftGates(draft, null, null, null, 'content_post');
    for (const gateId of ['G3', 'G5', 'G6']) {
      assert.equal(result.gates[gateId].skipped, true, `${gateId} should be skipped for content_post`);
      assert.equal(result.gates[gateId].passed, true, `${gateId} should auto-pass when skipped`);
    }
  });

  it('content_post still checks G2 (commitment language)', async () => {
    const draft = {
      body: 'I promise we will deliver this feature by next Friday.',
      to_addresses: [],
    };

    const result = await checkDraftGates(draft, null, null, null, 'content_post');
    assert.equal(result.gates.G2.passed, false);
    assert.equal(result.gates.G2.skipped, undefined);
    assert.ok(result.gates.G2.matches.length > 0);
  });

  it('content_post still checks G7 (pricing language)', async () => {
    const draft = {
      body: 'Our pricing for this tier starts at $200 per month.',
      to_addresses: [],
    };

    const result = await checkDraftGates(draft, null, null, null, 'content_post');
    assert.equal(result.gates.G7.passed, false);
    assert.equal(result.gates.G7.skipped, undefined);
    assert.ok(result.gates.G7.matches.length > 0);
  });

  it('unknown actionType skips all type-restricted gates', async () => {
    const draft = {
      body: 'I promise to deliver by Friday for $1000.',
      to_addresses: ['a@test.com'],
    };

    const result = await checkDraftGates(draft, null, null, null, 'slack_message');
    // Gates with explicit applicableTo that excludes slack_message are skipped
    for (const gateId of ['G3', 'G5', 'G6']) {
      assert.equal(result.gates[gateId].skipped, true, `${gateId} should be skipped for unknown type`);
    }
    // G2 and G7 include only email_draft + content_post, so they are also skipped
    assert.equal(result.gates.G2.skipped, true, 'G2 should be skipped for slack_message');
    assert.equal(result.gates.G7.skipped, true, 'G7 should be skipped for slack_message');
    // All gates pass (skipped = auto-pass) — this is the fail-open behavior
    assert.equal(result.passed, true);
  });
});

describe('guardCheck G10 spend cap (STAQPRO-557 — fail closed)', () => {
  // Stub client whose G10 spend query (against agent_graph.llm_invocations)
  // throws, while every other gate's query returns benign empty rows. This
  // simulates a transient DB outage / table mismatch during the spend check.
  const spendErrorClient = {
    query: async (text) => {
      if (typeof text === 'string' && text.includes('llm_invocations')) {
        throw new Error('relation "agent_graph.llm_invocations" does not exist');
      }
      return { rows: [], rowCount: 0 };
    },
  };

  it('BLOCKS the action when the spend check errors (does not fail open)', async () => {
    const result = await guardCheck({
      action: 'llm_call',
      agentId: 'executor-responder',
      estimatedCostUsd: 0,
      client: spendErrorClient,
    });

    // A spend cap that fails open is not a spend cap: the action must be denied.
    assert.equal(result.allowed, false, 'spend-check error must block the action');
    assert.ok(
      result.failedChecks.includes('G10_spend_check_error'),
      `expected G10_spend_check_error in failedChecks, got: ${result.failedChecks.join(', ')}`
    );
  });
});

describe('guardCheck budget scope surfacing (Plan 013 — failed tasks release the reservation they made)', () => {
  // When G1 reserves budget but a LATER gate fails, state-machine.js reads
  // preCheck._campaignId / preCheck._budgetAccountId to credit the reservation
  // back to the pool/account it actually came from. guardCheck must return
  // those fields — not leave them undefined. We force a later failure via the
  // G10 spend-check throw (same pattern as the fail-closed suite above).
  function stubWith(overrides) {
    return {
      query: async (text) => {
        if (typeof text === 'string' && text.includes('llm_invocations')) {
          // Force a downstream (post-reservation) gate failure.
          throw new Error('relation "agent_graph.llm_invocations" does not exist');
        }
        if (typeof text === 'string' && text.includes('reserve_campaign_budget')) {
          return { rows: [{ reserved: true }], rowCount: 1 };
        }
        if (typeof text === 'string' && text.includes('reserve_budget')) {
          return { rows: [{ reserved: true }], rowCount: 1 };
        }
        if (typeof text === 'string' && text.includes('campaign_id')) {
          // Campaign-parent lookup for the task.
          return { rows: overrides.campaignRows ?? [], rowCount: (overrides.campaignRows ?? []).length };
        }
        return { rows: [], rowCount: 0 };
      },
    };
  }

  it('returns _campaignId for a campaign task that reserves then fails a later check (not undefined)', async () => {
    const result = await guardCheck({
      action: 'llm_call',
      agentId: 'executor-responder',
      estimatedCostUsd: 0.5,
      taskId: 'wi-campaign-1',
      client: stubWith({ campaignRows: [{ campaign_id: 'camp-abc' }] }),
    });

    // A later gate failed, so the reservation must be released — against the campaign pool.
    assert.equal(result.allowed, false, 'later gate should have failed');
    assert.equal(result._budgetReserved, 0.5, 'campaign reservation was made');
    assert.equal(result._campaignId, 'camp-abc', '_campaignId must be surfaced, not undefined');
    assert.notEqual(result._campaignId, undefined);
  });

  it('returns _budgetAccountId for an account-scoped operational task (not undefined)', async () => {
    const result = await guardCheck({
      action: 'llm_call',
      agentId: 'executor-responder',
      estimatedCostUsd: 0.5,
      context: { accountId: 'acct-xyz' },
      client: stubWith({}),
    });

    // Operational (non-campaign) path: reservation must release against acct-xyz.
    assert.equal(result.allowed, false, 'later gate should have failed');
    assert.equal(result._budgetReserved, 0.5, 'operational reservation was made');
    assert.equal(result._budgetAccountId, 'acct-xyz', '_budgetAccountId must be surfaced, not undefined');
    assert.equal(result._campaignId, null, 'non-campaign task carries a null campaignId');
  });
});

describe('G2/G7 runtime pattern overlay (G2_PATTERNS_EXTRA / G7_PATTERNS_EXTRA)', () => {
  afterEach(() => {
    delete process.env.G2_PATTERNS_EXTRA;
    delete process.env.G7_PATTERNS_EXTRA;
  });

  it('extra G2 pattern flags a draft the baseline would miss', async () => {
    process.env.G2_PATTERNS_EXTRA = '\\bwidget\\b';
    const draft = { body: 'Our team makes a nice widget for you.', to_addresses: ['client@example.com'] };
    const result = await checkDraftGates(draft);
    assert.equal(result.gates.G2.passed, false);
    assert.ok(result.gates.G2.matches.some(m => /widget/i.test(m)), 'extra pattern matched');
  });

  it('baseline G2 patterns still match when an extra is present', async () => {
    process.env.G2_PATTERNS_EXTRA = '\\bwidget\\b';
    const draft = { body: 'I promise we will deliver by March 15.', to_addresses: ['client@example.com'] };
    const result = await checkDraftGates(draft);
    assert.equal(result.gates.G2.passed, false, 'baseline commitment language still flagged');
    assert.ok(result.gates.G2.matches.length > 0);
  });

  it('extra G7 pattern flags a draft the baseline would miss', async () => {
    process.env.G7_PATTERNS_EXTRA = '\\bSLA\\b';
    const draft = { body: 'Our standard SLA applies here.', to_addresses: ['prospect@example.com'] };
    const result = await checkDraftGates(draft);
    assert.equal(result.gates.G7.passed, false);
    assert.ok(result.gates.G7.matches.some(m => /SLA/i.test(m)), 'extra pattern matched');
  });

  it('multiple newline-delimited extras all apply', async () => {
    process.env.G2_PATTERNS_EXTRA = '\\bwidget\\b\n\\bgizmo\\b';
    const draft = { body: 'We can ship the gizmo next week.', to_addresses: ['client@example.com'] };
    const result = await checkDraftGates(draft);
    assert.equal(result.gates.G2.passed, false);
    assert.ok(result.gates.G2.matches.some(m => /gizmo/i.test(m)), 'second pattern matched');
  });

  it('an invalid regex line is skipped (no crash, other extras stand)', async () => {
    process.env.G2_PATTERNS_EXTRA = '(\n\\bwidget\\b'; // '(' is an invalid regex
    const draft = { body: 'Our team makes a nice widget for you.', to_addresses: ['client@example.com'] };
    const result = await checkDraftGates(draft);
    // The bad line is skipped; the valid extra still applies.
    assert.equal(result.gates.G2.passed, false);
    assert.ok(result.gates.G2.matches.some(m => /widget/i.test(m)));
  });

  it('blank and whitespace-only lines are ignored (baseline stands)', async () => {
    process.env.G2_PATTERNS_EXTRA = '\n   \n';
    const clean = { body: 'Hi John, thanks for reaching out. Let me review and get back to you.', to_addresses: ['john@example.com'] };
    const result = await checkDraftGates(clean);
    assert.equal(result.gates.G2.passed, true, 'clean draft still passes, no throw');

    const flagged = { body: 'I promise we will deliver by March 15.', to_addresses: ['c@example.com'] };
    const result2 = await checkDraftGates(flagged);
    assert.equal(result2.gates.G2.passed, false, 'baseline still active');
  });
});
