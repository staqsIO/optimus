/**
 * Communication Gateway coverage — lib/comms/gateway.js (spec §7, "highest-risk
 * component"). Plan 025 establishes the safety net; plan 020 then hardens the
 * gateway (tier-floor + fail-closed) against this exact suite.
 *
 * This suite pins the CURRENT behavior of the release-tier engine:
 *   - classifyRiskTier boundaries (asserted via submitIntent's returned riskTier)
 *   - the auto-send guard (Tier >= 2 never yields status 'approved')
 *   - quorum threshold arithmetic (2/3 releases, 1/3 holds)
 *   - inbound dedup key + rate-limit trip
 *
 * The DB (`query`/`withTransaction`) and phase-manager (`isPhase3Active`) are
 * module-mocked so the gateway is exercised without live infra.
 *
 * Run: cd autobot-inbox && node --experimental-test-module-mocks \
 *        --test --test-force-exit --test-timeout=20000 \
 *        test/comms-gateway.test.js
 */

import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ---- Mutable DB behavior knobs (reset in beforeEach) ----
const db = {
  rateLimitRows: [],   // rows returned for the rate_limits SELECT
  consentRows: [],     // rows returned for the consent_registry SELECT
  disclosureRows: [],  // rows returned for the ai_disclosures SELECT
  insertId: 'intent-1',
  throwOn: null,       // if a query's SQL includes this substring, throw (DB blip)
  quorum: null,        // quorum_approvals state backing SELECT ... FOR UPDATE
  calls: [],           // recorded { sql, params } for assertions
  phase3: false,       // isPhase3Active() return value
};

function resetDb() {
  db.rateLimitRows = [];
  db.consentRows = [];
  db.disclosureRows = [];
  db.insertId = 'intent-1';
  db.throwOn = null;
  db.quorum = null;
  db.calls = [];
  db.phase3 = false;
}

const mockQuery = mock.fn(async (sql, params) => {
  db.calls.push({ sql, params });
  if (db.throwOn && sql.includes(db.throwOn)) throw new Error('db connection lost');
  if (sql.includes('rate_limits') && sql.includes('SELECT')) return { rows: db.rateLimitRows };
  if (sql.includes('consent_registry')) return { rows: db.consentRows };
  if (sql.includes('ai_disclosures')) return { rows: db.disclosureRows };
  if (sql.includes('INSERT INTO autobot_comms.outbound_intents')) return { rows: [{ id: db.insertId }] };
  if (sql.includes('INSERT INTO autobot_comms.inbound_messages')) return { rows: [{ id: 'inbound-1' }] };
  if (sql.includes('UPDATE autobot_comms.outbound_intents')) return { rows: [] };
  return { rows: [] };
});

// submitQuorumVote runs inside withTransaction with SELECT ... FOR UPDATE.
// Persist the written quorum JSON back into db.quorum so successive votes see
// prior votes (mimics the row's evolving quorum_approvals).
const mockWithTransaction = mock.fn(async (fn) => {
  const client = {
    query: async (sql, params) => {
      if (sql.includes('FOR UPDATE')) {
        return { rows: db.quorum ? [{ quorum_approvals: db.quorum }] : [] };
      }
      if (sql.includes('UPDATE autobot_comms.outbound_intents')) {
        db.quorum = JSON.parse(params[0]);
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
  return fn(client);
});

mock.module('../../lib/db.js', {
  namedExports: { query: mockQuery, withTransaction: mockWithTransaction },
});
mock.module('../../lib/runtime/phase-manager.js', {
  namedExports: { isPhase3Active: mock.fn(async () => db.phase3) },
});

const { submitIntent, processInbound, requestQuorumReview, submitQuorumVote } =
  await import('../../lib/comms/gateway.js');

beforeEach(() => resetDb());

// A representative intent; tests override `body`/`intentType`/`riskTier`.
function intent(overrides = {}) {
  return {
    channel: 'email',
    recipient: 'someone@example.com',
    subject: 'Re: your inquiry',
    body: 'Hello there.',
    intentType: 'reply',
    sourceAgent: 'executor-responder',
    sourceTask: 'task-1',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Step 1: classifyRiskTier boundaries (asserted via submitIntent().riskTier)
// ---------------------------------------------------------------------------
describe('classifyRiskTier boundaries (via submitIntent)', () => {
  it('legal/contract language -> Tier 4 (hold for human + counsel)', async () => {
    const r = await submitIntent(intent({ body: 'Please review and sign the attached contract.', intentType: 'reply' }));
    assert.equal(r.riskTier, 4);
    assert.equal(r.tierName, 'Legal/Regulatory');
  });

  it('regulatory/compliance language -> Tier 4', async () => {
    const r = await submitIntent(intent({ body: 'Our regulatory compliance response follows.', intentType: 'reply' }));
    assert.equal(r.riskTier, 4);
  });

  it('public-statement language -> Tier 3 (reputational, human-in-the-loop)', async () => {
    const r = await submitIntent(intent({ body: 'Draft of our press release announcement for launch.', intentType: 'reply' }));
    assert.equal(r.riskTier, 3);
    assert.equal(r.tierName, 'Reputational');
  });

  it('relational reply (intentType send) -> Tier 2', async () => {
    const r = await submitIntent(intent({ body: 'Sounds good, talk soon.', intentType: 'send' }));
    assert.equal(r.riskTier, 2);
  });

  it('operational notification -> Tier 1 (auto-send eligible)', async () => {
    const r = await submitIntent(intent({ body: 'System status update, no action needed.', intentType: 'notification' }));
    assert.equal(r.riskTier, 1);
  });

  it('transactional receipt language -> Tier 0 (auto-send eligible)', async () => {
    const r = await submitIntent(intent({ body: 'Your payment receipt and invoice confirmation.', intentType: 'transactional' }));
    assert.equal(r.riskTier, 0);
  });

  it('unclassifiable content defaults to Tier 2 (conservative)', async () => {
    const r = await submitIntent(intent({ body: 'xyzzy', intentType: 'other' }));
    assert.equal(r.riskTier, 2);
  });
});

// ---------------------------------------------------------------------------
// Step 2: the auto-send guard — Tier >= 2 must never auto-approve
// ---------------------------------------------------------------------------
describe('auto-send guard', () => {
  it('Tier 0 with consent -> approved (auto-send)', async () => {
    const r = await submitIntent(intent({ body: 'Your payment receipt.', intentType: 'transactional' }));
    assert.equal(r.riskTier, 0);
    assert.equal(r.status, 'approved');
  });

  it('Tier 1 with consent -> approved (auto-send)', async () => {
    const r = await submitIntent(intent({ body: 'Nightly status update.', intentType: 'notification' }));
    assert.equal(r.riskTier, 1);
    assert.equal(r.status, 'approved');
  });

  it('Tier 2 (non-phase3) -> logged, never approved', async () => {
    db.phase3 = false;
    const r = await submitIntent(intent({ body: 'Thanks, let us schedule a meeting.', intentType: 'send' }));
    assert.equal(r.riskTier, 2);
    assert.notEqual(r.status, 'approved');
  });

  it('Tier 2 (phase3) -> still not approved (TIER_CONFIG[2].autoSend is false)', async () => {
    // Current behavior: TIER_CONFIG[2].autoSend === false gates the auto-send
    // block, so the tier-2 pending_quorum branch is unreachable and status
    // stays 'logged'. The load-bearing invariant is only that it is NOT approved.
    db.phase3 = true;
    const r = await submitIntent(intent({ body: 'Thanks, let us schedule a meeting.', intentType: 'send' }));
    assert.equal(r.riskTier, 2);
    assert.equal(r.status, 'logged');
    assert.notEqual(r.status, 'approved');
  });

  it('Tier 3 -> never approved (human-in-the-loop)', async () => {
    const r = await submitIntent(intent({ body: 'Marketing campaign announcement copy.', intentType: 'reply' }));
    assert.equal(r.riskTier, 3);
    assert.notEqual(r.status, 'approved');
  });

  it('Tier 4 -> never approved (human + counsel)', async () => {
    const r = await submitIntent(intent({ body: 'The binding contract terms are attached.', intentType: 'reply' }));
    assert.equal(r.riskTier, 4);
    assert.notEqual(r.status, 'approved');
  });
});

// ---------------------------------------------------------------------------
// Step 3: quorum math, inbound dedup, rate-limit trip
// ---------------------------------------------------------------------------
describe('quorum threshold arithmetic', () => {
  it('requestQuorumReview records a pending quorum request', async () => {
    const r = await requestQuorumReview('intent-1', 3, 2);
    assert.equal(r.requested, true);
    assert.equal(r.intentId, 'intent-1');
  });

  it('1/3 approve -> held (approved is null)', async () => {
    db.quorum = { requested: true, quorumSize: 3, quorumThreshold: 2, votes: [], status: 'pending' };
    const r1 = await submitQuorumVote('intent-1', 'agent-a', 'approve');
    assert.equal(r1.voted, true);
    assert.equal(r1.approved, null);
  });

  it('2/3 approve -> released (approved is true)', async () => {
    db.quorum = { requested: true, quorumSize: 3, quorumThreshold: 2, votes: [], status: 'pending' };
    const r1 = await submitQuorumVote('intent-1', 'agent-a', 'approve');
    assert.equal(r1.approved, null); // still held after first
    const r2 = await submitQuorumVote('intent-1', 'agent-b', 'approve');
    assert.equal(r2.voted, true);
    assert.equal(r2.approved, true); // threshold met -> released
  });

  it('2/3 reject -> rejected (approved is false)', async () => {
    db.quorum = { requested: true, quorumSize: 3, quorumThreshold: 2, votes: [], status: 'pending' };
    await submitQuorumVote('intent-1', 'agent-a', 'reject');
    const r2 = await submitQuorumVote('intent-1', 'agent-b', 'reject');
    assert.equal(r2.approved, false);
  });
});

describe('inbound dedup key', () => {
  it('processInbound keys the insert on rawContentHash (the dedup identity)', async () => {
    const hash = 'sha256:deadbeef';
    const r = await processInbound({ channel: 'email', sender: 'x@y.com', rawContentHash: hash, structuredExtraction: { a: 1 } });
    assert.equal(r.processed, true);
    const insert = db.calls.find((c) => c.sql.includes('INSERT INTO autobot_comms.inbound_messages'));
    assert.ok(insert, 'expected an inbound insert');
    // raw_content_hash is param $3 — the key a DB unique index dedups on.
    assert.equal(insert.params[2], hash);
  });

  it('the same rawContentHash yields the same dedup key on repeat submission', async () => {
    const hash = 'sha256:cafef00d';
    await processInbound({ channel: 'email', sender: 'x@y.com', rawContentHash: hash, structuredExtraction: {} });
    await processInbound({ channel: 'email', sender: 'x@y.com', rawContentHash: hash, structuredExtraction: {} });
    const inserts = db.calls.filter((c) => c.sql.includes('INSERT INTO autobot_comms.inbound_messages'));
    assert.equal(inserts.length, 2);
    assert.equal(inserts[0].params[2], inserts[1].params[2]);
  });
});

describe('rate-limit trip', () => {
  it('over the window limit -> submitIntent returns rate_limited with a reason', async () => {
    db.rateLimitRows = [{
      current_count: 100,
      max_messages: 10,
      window_start: new Date().toISOString(), // window not expired
    }];
    const r = await submitIntent(intent({ body: 'Your payment receipt.', intentType: 'transactional' }));
    assert.equal(r.status, 'rate_limited');
    assert.ok(typeof r.reason === 'string' && r.reason.length > 0);
  });

  it('under the limit -> not rate_limited', async () => {
    db.rateLimitRows = [{
      current_count: 1,
      max_messages: 10,
      window_start: new Date().toISOString(),
    }];
    const r = await submitIntent(intent({ body: 'Your payment receipt.', intentType: 'transactional' }));
    assert.notEqual(r.status, 'rate_limited');
  });
});

// ---------------------------------------------------------------------------
// Plan 020: fail-closed + tier-floor hardening.
// Each of these asserts the HARDENED behavior and fails against the pre-020
// (self-tier / fail-open) code.
// ---------------------------------------------------------------------------
describe('risk tier is a floor, not a ceiling (P1)', () => {
  it('caller passing riskTier:0 for a Tier-4 body cannot lower it -> not approved', async () => {
    const r = await submitIntent(intent({
      body: 'Please review and sign the attached contract.', // classifier -> Tier 4
      intentType: 'reply',
      riskTier: 0, // caller attempts to downgrade to auto-send
    }));
    assert.equal(r.riskTier, 4); // floored to the classified tier
    assert.notEqual(r.status, 'approved'); // still held for human + counsel
  });

  it('caller passing riskTier:0 for a Tier-2 body is floored to Tier 2 -> not approved', async () => {
    const r = await submitIntent(intent({
      body: 'Thanks, let us schedule a meeting.', // classifier -> Tier 2
      intentType: 'send',
      riskTier: 0,
    }));
    assert.equal(r.riskTier, 2);
    assert.notEqual(r.status, 'approved');
  });

  it('caller may RAISE the tier above classification', async () => {
    const r = await submitIntent(intent({
      body: 'Your payment receipt.', // classifier -> Tier 0
      intentType: 'transactional',
      riskTier: 3, // caller raises to reputational
    }));
    assert.equal(r.riskTier, 3);
    assert.notEqual(r.status, 'approved');
  });

  it('no caller tier -> classification stands (unchanged)', async () => {
    const r = await submitIntent(intent({ body: 'Your payment receipt.', intentType: 'transactional' }));
    assert.equal(r.riskTier, 0);
    assert.equal(r.status, 'approved');
  });
});

describe('fail-closed gates (P1 deny-by-default)', () => {
  it('checkRateLimit DB error -> treated as rate limited (not fail-open)', async () => {
    db.throwOn = 'rate_limits';
    const r = await submitIntent(intent({ body: 'Your payment receipt.', intentType: 'transactional' }));
    assert.equal(r.status, 'rate_limited');
    assert.ok(typeof r.reason === 'string' && r.reason.length > 0);
  });

  it('checkConsent DB error -> treated as NO consent (not fail-open)', async () => {
    // Tier 0 body that would auto-send WITH consent; a consent-check failure must
    // deny auto-send. Under pre-020 code checkConsent returned true -> 'approved'.
    db.throwOn = 'consent_registry';
    const r = await submitIntent(intent({ body: 'Your payment receipt.', intentType: 'transactional' }));
    assert.equal(r.riskTier, 0);
    assert.notEqual(r.status, 'approved'); // no consent -> not auto-sent
    assert.equal(r.status, 'logged');
  });

  it('getAiDisclosure DB error -> falls back to a safe default disclosure (never released without one, #498)', async () => {
    // Pre-#498 code: getAiDisclosure caught the error and returned null, so
    // `disclosure` was falsy and the message was released with the body
    // UNCHANGED (no disclosure text appended, ai_disclosure_added=false).
    db.throwOn = 'ai_disclosures';
    const r = await submitIntent(intent({ body: 'Your payment receipt.', intentType: 'transactional' }));

    assert.equal(r.aiDisclosureAdded, true); // must never silently omit disclosure

    const insert = db.calls.find((c) => c.sql.includes('INSERT INTO autobot_comms.outbound_intents'));
    assert.ok(insert, 'expected an outbound intent insert');
    const insertedBody = insert.params[3]; // $4 = bodyWithDisclosure
    assert.ok(insertedBody.startsWith('Your payment receipt.'));
    assert.notEqual(insertedBody, 'Your payment receipt.'); // disclosure text was appended
    assert.equal(insert.params[10], true); // $11 = ai_disclosure_added column
  });
});
