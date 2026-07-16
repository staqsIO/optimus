/**
 * Unit tests for the responder's draft-eligibility gates.
 *
 * Two policies interact here:
 *
 *  1. Tier-based opt-in (voice-loop-tuning, 2026-05-07). The predicate sits
 *     early in handler() — before any LLM/voice-profile work — and returns
 *     `{ success: true, skipped: true, ... }` for senders whose
 *     `signal.contacts.tier` is not in {inner_circle, active}.
 *     Audit motivation: 130 of 134 production drafts had no board action;
 *     ~70% came from non-draftable tiers (newsletter, inbound_only,
 *     automated, unknown, no contact record).
 *
 *  2. OPT-161 needs-response policy (feature 010 US-2, board decision Q1,
 *     Eric 2026-06-14). When enabled (the default), a triage verdict of
 *     needs_response/action_required bypasses the tier gate so the Drafts
 *     surface isn't starved of genuine first-contact correspondents. The
 *     RESPONDER_NEEDS_RESPONSE_POLICY env flag makes this instantly
 *     revertible: set it to 'false' to restore the legacy tier-only gate.
 *
 * These tests assert the interaction of both: the tier gate holds when the
 * policy is OFF, and is bypassed for needs_response messages when it's ON.
 */

import { describe, it, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';

import { responderLoop, isNeedsResponsePolicyEnabled } from '../src/agents/executor-responder.js';

let query;

before(async () => {
  ({ query } = await getDb());
});

beforeEach(async () => {
  // Clean signal.contacts so each test starts from a known state
  await query(`DELETE FROM signal.contacts`).catch(() => {});
});

// The handler() tier-gate tests below exercise the LEGACY tier-only gate,
// which requires the OPT-161 policy to be OFF. Default each test to OFF, and
// let the OPT-161 section opt back in explicitly. Restore env after each test.
let _savedPolicyEnv;
beforeEach(() => {
  _savedPolicyEnv = process.env.RESPONDER_NEEDS_RESPONSE_POLICY;
  process.env.RESPONDER_NEEDS_RESPONSE_POLICY = 'false';
});
afterEach(() => {
  if (_savedPolicyEnv === undefined) delete process.env.RESPONDER_NEEDS_RESPONSE_POLICY;
  else process.env.RESPONDER_NEEDS_RESPONSE_POLICY = _savedPolicyEnv;
});

// Helper: seed a contact with the given tier. contact_type defaults to 'unknown'.
async function seedContact(email, tier) {
  await query(
    `INSERT INTO signal.contacts (email_address, name, tier)
     VALUES ($1, 'Test', $2)
     ON CONFLICT (email_address) DO UPDATE SET tier = EXCLUDED.tier`,
    [email, tier]
  );
}

// Helper: minimal task/context shape the handler accepts.
// triageCategory defaults to 'needs_response' (matches the common live case).
function buildTaskAndContext(fromAddress, triageCategory = 'needs_response') {
  const task = { id: 'wi-test', work_item_id: 'wi-test' };
  const context = {
    email: {
      id: 'msg-test',
      from_address: fromAddress,
      from_name: 'Test Sender',
      subject: 'hello',
      account_id: 'acct-test',
      channel: 'email',
      triage_category: triageCategory,
    },
    emailBody: 'Hi, can we chat?',
    workItem: { id: 'wi-test', metadata: {} },
    promptContext: {},
  };
  return { task, context };
}

// True when the handler got past the tier opt-in predicate — either it
// returned a non-opt-in result, or it threw downstream (voice/LLM machinery
// isn't wired in PGlite). Either way proves the predicate did not short-circuit.
function assertNotSkippedByOptIn(result, err, label) {
  if (result) {
    const reason = result.reason || '';
    const skipped = result.skipped === true;
    assert.ok(
      !skipped || !/not draftable|opt-in predicate/.test(reason),
      `${label} should not be skipped by opt-in. Got: ${reason}`
    );
  } else {
    assert.ok(err, `${label}: expected either a result or a throw`);
    assert.doesNotMatch(
      String(err.message),
      /not draftable|opt-in predicate/,
      `${label}: unexpected opt-in skip: ${err.message}`
    );
  }
}

async function runHandler(task, context) {
  let result, err;
  try {
    result = await responderLoop.handler(task, context, { config_hash: 'test' });
  } catch (e) {
    err = e;
  }
  return { result, err };
}

describe('executor-responder tier-based opt-in (legacy policy OFF)', () => {
  for (const tier of ['automated', 'newsletter', 'inbound_only', 'unknown']) {
    it(`skips drafting for sender with tier='${tier}'`, async () => {
      const fromAddress = `someone+${tier}@example.com`;
      await seedContact(fromAddress, tier);

      const { task, context } = buildTaskAndContext(fromAddress);
      const result = await responderLoop.handler(task, context, { config_hash: 'test' });

      assert.equal(result.success, true, 'should not fail the task');
      assert.equal(result.skipped, true, 'should mark as skipped');
      assert.match(result.reason, /not draftable|opt-in/, `unexpected reason: ${result.reason}`);
      assert.equal(result.metadata?.sender_tier, tier);
      assert.equal(result.metadata?.opt_in, false);
    });
  }

  it('skips when sender has no contact record (treated as unknown)', async () => {
    // Don't seed a contact — sender is brand new
    const { task, context } = buildTaskAndContext('brandnew@example.com');
    const result = await responderLoop.handler(task, context, { config_hash: 'test' });

    assert.equal(result.success, true);
    assert.equal(result.skipped, true);
    assert.equal(result.metadata?.sender_tier, 'unknown');
  });

  for (const tier of ['inner_circle', 'active']) {
    it(`does NOT skip on tier='${tier}' (proceeds past opt-in predicate)`, async () => {
      const fromAddress = `friend+${tier}@example.com`;
      await seedContact(fromAddress, tier);

      const { task, context } = buildTaskAndContext(fromAddress);
      const { result, err } = await runHandler(task, context);
      assertNotSkippedByOptIn(result, err, `tier='${tier}'`);
    });
  }
});

describe('executor-responder OPT-161 needs-response policy', () => {
  it('isNeedsResponsePolicyEnabled defaults ON when env is unset', () => {
    delete process.env.RESPONDER_NEEDS_RESPONSE_POLICY;
    assert.equal(isNeedsResponsePolicyEnabled(), true);
  });

  for (const off of ['false', 'off', '0', 'no', 'FALSE', 'Off']) {
    it(`isNeedsResponsePolicyEnabled OFF for env='${off}'`, () => {
      process.env.RESPONDER_NEEDS_RESPONSE_POLICY = off;
      assert.equal(isNeedsResponsePolicyEnabled(), false);
    });
  }

  for (const on of ['true', '1', 'on', 'yes', 'anything']) {
    it(`isNeedsResponsePolicyEnabled ON for env='${on}'`, () => {
      process.env.RESPONDER_NEEDS_RESPONSE_POLICY = on;
      assert.equal(isNeedsResponsePolicyEnabled(), true);
    });
  }

  // (a) Flag ON: an unknown-tier sender whose message needs_response now gets
  // past the tier gate (the bypass) instead of being skipped.
  it('flag ON: unknown-tier + needs_response bypasses the tier gate', async () => {
    process.env.RESPONDER_NEEDS_RESPONSE_POLICY = 'true';
    const fromAddress = 'newcontact@example.com';
    await seedContact(fromAddress, 'unknown');

    const { task, context } = buildTaskAndContext(fromAddress, 'needs_response');
    const { result, err } = await runHandler(task, context);
    assertNotSkippedByOptIn(result, err, 'flag ON unknown-tier needs_response');
  });

  it('flag ON: no-contact-record + action_required bypasses the tier gate', async () => {
    process.env.RESPONDER_NEEDS_RESPONSE_POLICY = 'true';
    // Don't seed a contact — brand-new sender, resolves to tier 'unknown'.
    const { task, context } = buildTaskAndContext('firsttime@example.com', 'action_required');
    const { result, err } = await runHandler(task, context);
    assertNotSkippedByOptIn(result, err, 'flag ON no-record action_required');
  });

  // (b) Flag OFF: the old tier-gate behavior still holds — unknown tier is
  // skipped even though triage says needs_response.
  it('flag OFF: unknown-tier + needs_response is still skipped (legacy gate)', async () => {
    process.env.RESPONDER_NEEDS_RESPONSE_POLICY = 'false';
    const fromAddress = 'newcontact-off@example.com';
    await seedContact(fromAddress, 'unknown');

    const { task, context } = buildTaskAndContext(fromAddress, 'needs_response');
    const result = await responderLoop.handler(task, context, { config_hash: 'test' });

    assert.equal(result.success, true);
    assert.equal(result.skipped, true);
    assert.match(result.reason, /not draftable|opt-in/, `unexpected reason: ${result.reason}`);
    assert.equal(result.metadata?.sender_tier, 'unknown');
    assert.equal(result.metadata?.opt_in, false);
  });

  // (c) Flag ON but the message is NOT marked needs_response: the bypass does
  // NOT apply, so the tier gate still skips an unknown-tier sender. Prevents
  // the policy from drafting for non-actionable mail.
  it('flag ON: unknown-tier WITHOUT needs_response is still skipped by tier gate', async () => {
    process.env.RESPONDER_NEEDS_RESPONSE_POLICY = 'true';
    const fromAddress = 'fyi-sender@example.com';
    await seedContact(fromAddress, 'unknown');

    // triage_category that is neither needs_response nor action_required
    const { task, context } = buildTaskAndContext(fromAddress, 'fyi');
    const result = await responderLoop.handler(task, context, { config_hash: 'test' });

    assert.equal(result.success, true);
    assert.equal(result.skipped, true);
    assert.match(result.reason, /not draftable|opt-in/, `unexpected reason: ${result.reason}`);
    assert.equal(result.metadata?.sender_tier, 'unknown');
    assert.equal(result.metadata?.opt_in, false);
  });
});
