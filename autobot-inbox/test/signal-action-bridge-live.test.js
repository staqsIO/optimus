/**
 * Integration test — signal→action bridge LIVE path end-to-end.
 *
 * Purpose: flush ALL remaining production bugs in ONE test run rather than
 * via repeated prod deploys. The bridge path has never been exercised
 * end-to-end against a real DB; these tests surface every constraint/FK/
 * schema violation that would hit in production.
 *
 * Test scope (ADR-008 A-prime, "bridge requests, orchestrator assigns"):
 *   bridgeSignal(…, dryRun:false, staleCleanupOnly:false)
 *   → createWorkItem (assigned_to=NULL, created_by='signal-action-bridge')
 *   → gated: INSERT inbox.human_tasks card
 *   → autonomous: emit task_routing event into agent_graph.task_events
 *   → stamp signals.work_item_id + signals.bridged_at
 *
 * Signal-routing config is injected via module mocks so this test works
 * without touching the production config file. The DB is PGlite with ALL
 * migrations applied (001 through 129).
 *
 * IMPORTANT: this test intentionally does NOT fix the bugs it surfaces —
 * the assertions call out the expected end state so failures pinpoint the
 * production bug. Test-only setup (seed rows) is here; prod-code bugs are not.
 */

import { describe, it, before, mock } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';

// ── Fixed seed IDs ────────────────────────────────────────────────────────────
// Use sentinel values to avoid collisions with other test files in the suite.
const ACC           = 'acc-bridge-live-test';
const MSG_AUTONOMOUS = 'msg-bridge-auto-001';
const MSG_GATED      = 'msg-bridge-gated-001';
const SIG_AUTONOMOUS = 'sig-bridge-auto-001';
const SIG_GATED      = 'sig-bridge-gated-001';

// occurred_at must stay inside the staleCleanupOnly 45-day live window. The
// bridge's liveness query uses now()-interval (relative to run time), so this
// seed MUST be relative too — a fixed literal ages out and flips every
// recency-dependent assertion once the run date crosses the 45-day boundary.
// (A hardcoded '2026-05-20T10:00:00Z' did exactly that on 2026-07-04.)
const OCCURRED_AT = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString(); // always 9 days ago

// ── Config stub ───────────────────────────────────────────────────────────────
// Inject config so the test is independent of signal-routing.json on disk.
// This must be done BEFORE importing signal-action-bridge.js.
const LIVE_CONFIG = {
  dryRun: false,          // LIVE — create work_items
  staleCleanupOnly: false, // LIVE — also route live obligations (not just stale cleanup)
  confidenceThreshold: 0.70,
  reviewBandFloor: 0.70,
  reviewBandCeiling: 0.85,
  staleness: { occurredWithinDays: 45, dueWithinDays: 7 },
  notLiveContactTiers: ['automated'], // OPT-154 — config-driven not-live tiers
  eligibleSignalTypes: ['commitment', 'request', 'action_item'],
  batchSize: 25,
  perRunCostCapUsd: 2.5,
  ragSupersedeCheck: false,
};

// Mock lib/config/loader.js BEFORE any dynamic imports of signal-action-bridge.
// node:test --experimental-test-module-mocks supports this pattern.
//
// Strategy: intercept ONLY 'signal-routing' (to inject LIVE_CONFIG) and
// delegate everything else to the real getConfig so guard-check.js, autonomy-
// evaluator.js, etc. can load their configs (gates.json, agents.json, etc.)
// from disk at module-parse time without error.
const realLoader = await import('../../lib/config/loader.js');
mock.module('../../lib/config/loader.js', {
  namedExports: {
    ...realLoader,
    getConfig: (name) => {
      if (name === 'signal-routing') return LIVE_CONFIG;
      return realLoader.getConfig(name);
    },
  },
});

// Dynamic import AFTER mock registration so the mock takes effect.
const { bridgeSignal, isStillLive } = await import('../../lib/runtime/signal-action-bridge.js');

// ── Test suite ────────────────────────────────────────────────────────────────
describe('signal-action-bridge — live path end-to-end', () => {
  let query;

  before(async () => {
    ({ query } = await getDb());

    // ── Seed inbox.accounts (required FK for messages.account_id) ───────────
    await query(
      `INSERT INTO inbox.accounts (id, owner, label, identifier, channel, provider)
       VALUES ($1, 'ecgang', 'bridge-test-account', 'bridge@test', 'email', 'gmail')
       ON CONFLICT DO NOTHING`,
      [ACC],
    );

    // ── Seed inbox.messages (required FK for signals.message_id) ────────────
    // D1: messages table stores metadata only — no body column.
    // Email channel requires provider_msg_id (messages_require_provider_id CHECK).
    // ON CONFLICT DO NOTHING so re-runs are idempotent.
    await query(
      `INSERT INTO inbox.messages
         (id, account_id, channel, provider, provider_msg_id, thread_id,
          message_id, from_address, received_at)
       VALUES ($1, $2, 'email', 'gmail', 'pm-bridge-auto-001', 'th-bridge-auto-001',
               'mid-bridge-auto-001', 'sender@example.com', $3)
       ON CONFLICT DO NOTHING`,
      [MSG_AUTONOMOUS, ACC, OCCURRED_AT],
    );
    await query(
      `INSERT INTO inbox.messages
         (id, account_id, channel, provider, provider_msg_id, thread_id,
          message_id, from_address, received_at)
       VALUES ($1, $2, 'email', 'gmail', 'pm-bridge-gated-001', 'th-bridge-gated-001',
               'mid-bridge-gated-001', 'sender@example.com', $3)
       ON CONFLICT DO NOTHING`,
      [MSG_GATED, ACC, OCCURRED_AT],
    );

    // ── Seed inbox.signals ───────────────────────────────────────────────────
    // msg_channel is NOT a signals column — it is m.channel aliased via the
    // bridge's JOIN to inbox.messages. Seed only actual signals columns.
    // occurred_at is added by migration 127 (backfilled from messages.received_at);
    // seeded directly here for test isolation so the bridge sees a live timestamp.
    //
    // Autonomous case: action_item, inbound, general domain, confidence=0.90
    //   → routeObligation: hasExternalRecipient=false, touchesMoney=false,
    //     touchesLegal=false → klass='autonomous', targetExecutor='executor-ticket'
    //
    // Gated case: commitment, outbound, financial domain, confidence=0.75
    //   → touchesMoney=true (domain='financial') → klass='gated'
    await query(
      `INSERT INTO inbox.signals
         (id, message_id, signal_type, direction, domain,
          confidence, content, resolved, occurred_at)
       VALUES ($1, $2, 'action_item', 'inbound', 'general',
               0.90, 'Dustin to send the Q3 deck by Friday.', false, $3)
       ON CONFLICT DO NOTHING`,
      [SIG_AUTONOMOUS, MSG_AUTONOMOUS, OCCURRED_AT],
    );
    await query(
      `INSERT INTO inbox.signals
         (id, message_id, signal_type, direction, domain,
          confidence, content, resolved, occurred_at)
       VALUES ($1, $2, 'commitment', 'outbound', 'financial',
               0.75, 'Eric to wire $50,000 to vendor account by EOD.', false, $3)
       ON CONFLICT DO NOTHING`,
      [SIG_GATED, MSG_GATED, OCCURRED_AT],
    );

    // The 'signal-action-bridge' agent_config row (created_by FK target) is
    // provided by migration 130, applied by initializeDatabase() above — NOT
    // seeded here. That is deliberate: this test now validates that migration
    // 130 is sufficient for the live path. If 130 is reverted, these tests fail
    // with 23503 (fk_work_items_created_by), which is exactly the regression
    // guard we want.
  });

  // ── Case 1: Autonomous signal (action_item) ────────────────────────────────
  it('autonomous action_item: creates unassigned work_item and task_routing event', async () => {
    const result = await bridgeSignal({
      query,
      signalId: SIG_AUTONOMOUS,
      dryRun: false,
    });

    // ① Decision must be 'created' (not 'dryrun', 'route_suppressed_canary', etc.)
    assert.equal(result.decision, 'created',
      `Expected decision='created', got '${result.decision}' (reason: ${result.reason})`);

    // ② workItemId must be stamped back on the return value
    assert.ok(result.workItemId,
      `bridgeSignal returned no workItemId (decision=${result.decision})`);

    // ③ work_item row exists in DB with correct shape
    const wi = await query(
      `SELECT id, assigned_to, created_by, status, metadata
         FROM agent_graph.work_items
        WHERE id = $1`,
      [result.workItemId],
    );
    assert.equal(wi.rows.length, 1,
      `work_item row not found for id=${result.workItemId}`);

    const row = wi.rows[0];

    // A-prime invariant: bridge NEVER assigns — orchestrator does.
    assert.equal(row.assigned_to, null,
      `work_item.assigned_to must be NULL (bridge has zero assignment authority), got '${row.assigned_to}'`);

    assert.equal(row.created_by, 'signal-action-bridge',
      `work_item.created_by must be 'signal-action-bridge', got '${row.created_by}'`);

    assert.equal(row.status, 'created',
      `work_item.status must be 'created' (unassigned), got '${row.status}'`);

    // metadata.reversibility_class must be 'autonomous' (NOT put in routing_class column)
    const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
    assert.equal(meta?.reversibility_class, 'autonomous',
      `metadata.reversibility_class must be 'autonomous', got '${meta?.reversibility_class}'\n` +
      `Full metadata: ${JSON.stringify(meta)}`);

    // metadata.email_id must link to the originating message so the context-loader
    // (context-loader.js:133) can populate context.email — without it, executor-ticket/
    // executor-responder fail "No email/message context" (the live-routing bug this fixes).
    assert.equal(meta?.email_id, MSG_AUTONOMOUS,
      `metadata.email_id must equal the signal's message_id ('${MSG_AUTONOMOUS}'), got '${meta?.email_id}'. ` +
      `Without it the executor can't load context.email and the autonomous work_item fails.`);

    // routing_class column must NOT contain 'autonomous' (that was the fixed bug)
    const wiRaw = await query(
      `SELECT routing_class FROM agent_graph.work_items WHERE id = $1`,
      [result.workItemId],
    );
    assert.notEqual(wiRaw.rows[0]?.routing_class, 'autonomous',
      `work_items.routing_class must NOT be 'autonomous' — that violates work_items_routing_class_check`);

    // ④ signals.work_item_id stamped + bridged_at set
    const sig = await query(
      `SELECT work_item_id, bridged_at, content_hash
         FROM inbox.signals WHERE id = $1`,
      [SIG_AUTONOMOUS],
    );
    assert.ok(sig.rows[0]?.work_item_id,
      `signals.work_item_id not stamped after bridging`);
    assert.equal(sig.rows[0].work_item_id, result.workItemId,
      `signals.work_item_id=${sig.rows[0].work_item_id} != returned workItemId=${result.workItemId}`);
    assert.ok(sig.rows[0]?.bridged_at,
      `signals.bridged_at must be set after bridging`);
    assert.ok(sig.rows[0]?.content_hash,
      `signals.content_hash must be set after bridging`);

    // ⑤ task_routing event emitted into agent_graph.task_events
    const evt = await query(
      `SELECT event_type, work_item_id, target_agent_id, event_data
         FROM agent_graph.task_events
        WHERE work_item_id = $1
          AND event_type = 'task_routing'
        ORDER BY event_id DESC LIMIT 1`,
      [result.workItemId],
    );
    assert.equal(evt.rows.length, 1,
      `No task_routing event found for work_item ${result.workItemId}. ` +
      `This means emit() failed (likely 23514 check_violation: 'task_routing' not in ` +
      `task_events_event_type_check BEFORE migration 129).`);

    const evtRow = evt.rows[0];
    assert.equal(evtRow.target_agent_id, 'orchestrator',
      `task_routing event target must be 'orchestrator', got '${evtRow.target_agent_id}'`);

    const evtData = typeof evtRow.event_data === 'string'
      ? JSON.parse(evtRow.event_data)
      : evtRow.event_data;
    assert.ok(evtData?.target_executor,
      `task_routing event_data missing target_executor: ${JSON.stringify(evtData)}`);
    assert.equal(evtData.source_signal_id, SIG_AUTONOMOUS,
      `task_routing event_data.source_signal_id must be '${SIG_AUTONOMOUS}', got '${evtData.source_signal_id}'`);

    // ⑥ No inbox.human_tasks row for autonomous case
    const ht = await query(
      `SELECT id FROM inbox.human_tasks WHERE signal_id = $1`,
      [SIG_AUTONOMOUS],
    );
    assert.equal(ht.rows.length, 0,
      `Autonomous signal must NOT create a human_tasks card (got ${ht.rows.length} rows)`);
  });

  // ── Case 2: Gated signal (financial commitment) ────────────────────────────
  it('gated financial commitment: creates unassigned work_item + human_tasks card, no task_routing event', async () => {
    const result = await bridgeSignal({
      query,
      signalId: SIG_GATED,
      dryRun: false,
    });

    // ① Decision must be 'gated'
    assert.equal(result.decision, 'gated',
      `Expected decision='gated', got '${result.decision}' (reason: ${result.reason})`);

    assert.ok(result.workItemId,
      `bridgeSignal returned no workItemId for gated case`);

    // ② work_item exists and is unassigned
    const wi = await query(
      `SELECT assigned_to, metadata FROM agent_graph.work_items WHERE id = $1`,
      [result.workItemId],
    );
    assert.equal(wi.rows.length, 1, `Gated work_item row not found`);
    assert.equal(wi.rows[0].assigned_to, null,
      `Gated work_item.assigned_to must be NULL`);

    const meta = typeof wi.rows[0].metadata === 'string'
      ? JSON.parse(wi.rows[0].metadata)
      : wi.rows[0].metadata;
    assert.equal(meta?.reversibility_class, 'gated',
      `Gated metadata.reversibility_class must be 'gated', got '${meta?.reversibility_class}'`);

    // data_classification must be CONFIDENTIAL for gated
    const wiRaw = await query(
      `SELECT data_classification FROM agent_graph.work_items WHERE id = $1`,
      [result.workItemId],
    );
    assert.equal(wiRaw.rows[0]?.data_classification, 'CONFIDENTIAL',
      `Gated work_item.data_classification must be 'CONFIDENTIAL', got '${wiRaw.rows[0]?.data_classification}'`);

    // ③ signals.work_item_id stamped
    const sig = await query(
      `SELECT work_item_id, bridged_at FROM inbox.signals WHERE id = $1`,
      [SIG_GATED],
    );
    assert.ok(sig.rows[0]?.work_item_id, `signals.work_item_id not stamped for gated case`);
    assert.ok(sig.rows[0]?.bridged_at,   `signals.bridged_at not set for gated case`);

    // ④ inbox.human_tasks card inserted for gated case
    const ht = await query(
      `SELECT id, signal_id, message_id, task_type, status, created_by, next_action_hint
         FROM inbox.human_tasks
        WHERE signal_id = $1`,
      [SIG_GATED],
    );
    assert.equal(ht.rows.length, 1,
      `Gated signal must create exactly 1 human_tasks card, got ${ht.rows.length}`);

    const htRow = ht.rows[0];
    assert.equal(htRow.signal_id,  SIG_GATED,   `human_tasks.signal_id mismatch`);
    assert.equal(htRow.message_id, MSG_GATED,    `human_tasks.message_id mismatch`);
    assert.equal(htRow.status,     'inbox',      `human_tasks.status must be 'inbox'`);
    assert.equal(htRow.created_by, 'signal-action-bridge',
      `human_tasks.created_by must be 'signal-action-bridge', got '${htRow.created_by}'`);
    assert.ok(htRow.next_action_hint?.startsWith('work_item:'),
      `human_tasks.next_action_hint must start with 'work_item:', got '${htRow.next_action_hint}'`);

    // ⑤ NO task_routing event for gated (gated routes via human review, not orchestrator)
    const evt = await query(
      `SELECT event_id FROM agent_graph.task_events
        WHERE work_item_id = $1 AND event_type = 'task_routing'`,
      [result.workItemId],
    );
    assert.equal(evt.rows.length, 0,
      `Gated work_item must NOT emit a task_routing event (got ${evt.rows.length})`);
  });

  // ── Case 3: Idempotency — re-calling bridgeSignal on an already-bridged signal ──
  it('idempotent: re-calling bridgeSignal on an already-bridged signal returns already_bridged', async () => {
    // SIG_AUTONOMOUS was bridged in Case 1 — calling again must be a no-op.
    const result = await bridgeSignal({
      query,
      signalId: SIG_AUTONOMOUS,
      dryRun: false,
    });

    assert.equal(result.decision, 'already_bridged',
      `Second call on an already-bridged signal must return decision='already_bridged', got '${result.decision}'`);

    // Confirm no duplicate work_items were created
    const sig = await query(
      `SELECT work_item_id FROM inbox.signals WHERE id = $1`,
      [SIG_AUTONOMOUS],
    );
    // work_item_id must still be exactly the one from Case 1 (not null, not changed)
    assert.ok(sig.rows[0]?.work_item_id,
      `signals.work_item_id should still be stamped after idempotent re-call`);
  });

  // ── Case 4: dryRun=true short-circuit ──────────────────────────────────────
  it('dryRun=true: stamps metadata but creates no work_item and no human_tasks', async () => {
    // Use a fresh signal for isolation
    const MSG_DRY  = 'msg-bridge-dry-001';
    const SIG_DRY  = 'sig-bridge-dry-001';

    await query(
      `INSERT INTO inbox.messages
         (id, account_id, channel, provider, provider_msg_id, thread_id,
          message_id, from_address, received_at)
       VALUES ($1, $2, 'email', 'gmail', 'pm-bridge-dry-001', 'th-bridge-dry-001',
               'mid-bridge-dry-001', 'x@example.com', $3)
       ON CONFLICT DO NOTHING`,
      [MSG_DRY, ACC, OCCURRED_AT],
    );

    await query(
      `INSERT INTO inbox.signals
         (id, message_id, signal_type, direction, domain,
          confidence, content, resolved, occurred_at)
       VALUES ($1, $2, 'request', 'inbound', 'general',
               0.80, 'Eric to review the contract.', false, $3)
       ON CONFLICT DO NOTHING`,
      [SIG_DRY, MSG_DRY, OCCURRED_AT],
    );

    const result = await bridgeSignal({
      query,
      signalId: SIG_DRY,
      dryRun: true,
    });

    assert.equal(result.decision, 'dryrun',
      `dryRun=true must return decision='dryrun', got '${result.decision}'`);
    assert.equal(result.workItemId, null,
      `dryRun must not produce a workItemId`);

    // No work_item should exist from dryRun
    const wi = await query(
      `SELECT id FROM agent_graph.work_items
        WHERE metadata->>'source_signal_id' = $1`,
      [SIG_DRY],
    );
    assert.equal(wi.rows.length, 0,
      `dryRun must create NO work_items, found ${wi.rows.length}`);

    // signal must have bridge_dryrun metadata stamped
    const sig = await query(
      `SELECT metadata FROM inbox.signals WHERE id = $1`,
      [SIG_DRY],
    );
    const meta = typeof sig.rows[0]?.metadata === 'string'
      ? JSON.parse(sig.rows[0].metadata)
      : sig.rows[0]?.metadata;
    assert.ok(meta?.bridge_dryrun,
      `dryRun must stamp signals.metadata.bridge_dryrun, got: ${JSON.stringify(meta)}`);
  });

  // ── Case 5: OPT-154 — context (automated contact) BEATS recency ─────────────
  // Before OPT-154, inbox.signals.contact_id was never populated, so isStillLive()
  // skipped the contact branch entirely and recency decided everything. This case
  // seeds an 'automated'-tier contact whose email matches the message sender, and
  // a signal with a RECENT occurred_at (so recency ALONE would say LIVE). The
  // sender-address join must resolve the contact and the context-primary branch
  // must short-circuit to not_live:contact_automated — proving context wins.
  it('OPT-154: automated-tier contact => skip not_live:contact_automated even when recency says live', async () => {
    const MSG_AUTO   = 'msg-bridge-opt154-auto-001';
    const SIG_AUTO   = 'sig-bridge-opt154-auto-001';
    const C_AUTOMATED = 'contact-opt154-automated-001';
    const EMAIL_AUTO  = 'no-reply@automation.example.com';

    // Seed an automated-tier contact (no-reply system sender).
    await query(
      `INSERT INTO signal.contacts (id, email_address, name, tier, contact_type)
       VALUES ($1, $2, 'Automation Bot', 'automated', 'service')
       ON CONFLICT (id) DO NOTHING`,
      [C_AUTOMATED, EMAIL_AUTO],
    );

    // Message FROM that automated address. RECENT received/occurred timestamp.
    await query(
      `INSERT INTO inbox.messages
         (id, account_id, channel, provider, provider_msg_id, thread_id,
          message_id, from_address, received_at)
       VALUES ($1, $2, 'email', 'gmail', 'pm-opt154-auto-001', 'th-opt154-auto-001',
               'mid-opt154-auto-001', $3, $4)
       ON CONFLICT DO NOTHING`,
      [MSG_AUTO, ACC, EMAIL_AUTO, OCCURRED_AT],
    );

    // Signal with a RECENT occurred_at — recency alone would route this LIVE.
    await query(
      `INSERT INTO inbox.signals
         (id, message_id, signal_type, direction, domain,
          confidence, content, resolved, occurred_at)
       VALUES ($1, $2, 'action_item', 'inbound', 'general',
               0.90, 'Automated digest: review 5 items.', false, $3)
       ON CONFLICT DO NOTHING`,
      [SIG_AUTO, MSG_AUTO, OCCURRED_AT],
    );

    const result = await bridgeSignal({
      query,
      signalId: SIG_AUTO,
      dryRun: false,
    });

    assert.equal(result.decision, 'skip',
      `Expected decision='skip' for an automated-contact signal, got '${result.decision}' (reason: ${result.reason})`);
    assert.equal(result.reason, 'not_live:contact_automated',
      `Expected reason='not_live:contact_automated' (context beats recency), got '${result.reason}'`);

    // No work_item should be created for a not-live obligation.
    const ht = await query(
      `SELECT id FROM inbox.human_tasks WHERE signal_id = $1`,
      [SIG_AUTO],
    );
    assert.equal(ht.rows.length, 0,
      `not-live signal must NOT create a human_tasks card (got ${ht.rows.length})`);

    // The dead obligation should be resolved with the WHY recorded.
    const sig = await query(
      `SELECT resolved, work_item_id, metadata FROM inbox.signals WHERE id = $1`,
      [SIG_AUTO],
    );
    assert.equal(sig.rows[0]?.resolved, true,
      `not-live signal must be resolved=true`);
    assert.equal(sig.rows[0]?.work_item_id, null,
      `not-live signal must NOT be stamped with a work_item_id`);
    const sigMeta = typeof sig.rows[0]?.metadata === 'string'
      ? JSON.parse(sig.rows[0].metadata)
      : sig.rows[0]?.metadata;
    assert.equal(sigMeta?.resolution_reason, 'not_live:contact_automated',
      `resolution_reason must be 'not_live:contact_automated', got '${sigMeta?.resolution_reason}'`);
  });

  // ── Case 6: OPT-154 — a normal-tier contact is NOT a false positive ─────────
  // A signal from an inbound_only contact (a real human counterparty) with recent
  // occurred_at must still route — the not-live-tier check must not over-fire.
  it('OPT-154: inbound_only contact with recent occurred_at still routes (no false positive)', async () => {
    const MSG_NORMAL  = 'msg-bridge-opt154-normal-001';
    const SIG_NORMAL  = 'sig-bridge-opt154-normal-001';
    const C_NORMAL    = 'contact-opt154-normal-001';
    const EMAIL_NORMAL = 'jane@realcustomer.example.com';

    await query(
      `INSERT INTO signal.contacts (id, email_address, name, tier, contact_type)
       VALUES ($1, $2, 'Jane Real', 'inbound_only', 'prospect')
       ON CONFLICT (id) DO NOTHING`,
      [C_NORMAL, EMAIL_NORMAL],
    );

    await query(
      `INSERT INTO inbox.messages
         (id, account_id, channel, provider, provider_msg_id, thread_id,
          message_id, from_address, received_at)
       VALUES ($1, $2, 'email', 'gmail', 'pm-opt154-normal-001', 'th-opt154-normal-001',
               'mid-opt154-normal-001', $3, $4)
       ON CONFLICT DO NOTHING`,
      [MSG_NORMAL, ACC, EMAIL_NORMAL, OCCURRED_AT],
    );

    // action_item, inbound, general => autonomous route (matches Case 1 shape).
    await query(
      `INSERT INTO inbox.signals
         (id, message_id, signal_type, direction, domain,
          confidence, content, resolved, occurred_at)
       VALUES ($1, $2, 'action_item', 'inbound', 'general',
               0.90, 'Jane to send the signed NDA.', false, $3)
       ON CONFLICT DO NOTHING`,
      [SIG_NORMAL, MSG_NORMAL, OCCURRED_AT],
    );

    const result = await bridgeSignal({
      query,
      signalId: SIG_NORMAL,
      dryRun: false,
    });

    assert.notEqual(result.decision, 'skip',
      `A live inbound_only-contact signal must NOT be skipped, got decision='${result.decision}' (reason: ${result.reason})`);
    assert.equal(result.decision, 'created',
      `Expected autonomous 'created' for inbound_only contact, got '${result.decision}' (reason: ${result.reason})`);
    assert.ok(result.workItemId,
      `live signal must produce a workItemId`);
  });

  // ── Case 7: OPT-154 — direct isStillLive unit test for engagement_archived ──
  // Exercises the context branch in isolation with an injected query stub (no DB),
  // proving the engagement-archived short-circuit still fires once a contact is
  // present. The stub returns no contact row (departed/tier checks fall through),
  // then an archived engagement row.
  it('OPT-154: isStillLive returns engagement_archived via injected query stub', async () => {
    let call = 0;
    const stubQuery = async (sql) => {
      call += 1;
      // 1st query: contact lookup (sig.contact_tier undefined => DB fallback path).
      if (/FROM signal\.contacts/.test(sql)) {
        return { rows: [] }; // no contact row => no tier/departed short-circuit
      }
      // 2nd query: engagement lookup via human_tasks join.
      if (/engagements\.engagements/.test(sql)) {
        return { rows: [{ status: 'archived' }] };
      }
      return { rows: [] };
    };

    const verdict = await isStillLive({
      query: stubQuery,
      sig: {
        id: 'sig-stub-001',
        contact_id: 'contact-stub-001', // present => context branch runs
        occurred_at: OCCURRED_AT,        // recent => recency alone would say live
        due_date: null,
      },
      cfg: LIVE_CONFIG,
    });

    assert.equal(verdict.live, false,
      `archived engagement must yield live=false, got ${JSON.stringify(verdict)}`);
    assert.equal(verdict.reason, 'engagement_archived',
      `reason must be 'engagement_archived', got '${verdict.reason}'`);
    assert.ok(call >= 2, `expected both contact + engagement queries to run, ran ${call}`);
  });

  // ── Case 8: OPT-154 / Linus blocker — case-variant contacts do not fan out ──
  // email_address is UNIQUE on exact case, so two rows can differ only by case
  // ('Sales@x.com' and 'sales@x.com') yet both match lower(from_address). The
  // LATERAL + LIMIT 1 must collapse to exactly one contact so the signal row is
  // not duplicated, and bridging proceeds normally (here: both are inbound_only,
  // so the signal still routes — no spurious skip, no crash from a fanned row).
  it('OPT-154: two case-variant contacts resolve to one (no row fan-out), signal still routes', async () => {
    const MSG_FAN  = 'msg-bridge-opt154-fan-001';
    const SIG_FAN  = 'sig-bridge-opt154-fan-001';
    const C_UPPER  = 'contact-opt154-fan-upper-001';
    const C_LOWER  = 'contact-opt154-fan-lower-001';

    // Two contacts whose emails differ ONLY by case → both match lower().
    await query(
      `INSERT INTO signal.contacts (id, email_address, name, tier, contact_type)
       VALUES ($1, 'Sales@fanout.example.com', 'Sales Upper', 'inbound_only', 'prospect')
       ON CONFLICT (id) DO NOTHING`,
      [C_UPPER],
    );
    await query(
      `INSERT INTO signal.contacts (id, email_address, name, tier, contact_type)
       VALUES ($1, 'sales@fanout.example.com', 'Sales Lower', 'inbound_only', 'prospect')
       ON CONFLICT (id) DO NOTHING`,
      [C_LOWER],
    );

    await query(
      `INSERT INTO inbox.messages
         (id, account_id, channel, provider, provider_msg_id, thread_id,
          message_id, from_address, received_at)
       VALUES ($1, $2, 'email', 'gmail', 'pm-opt154-fan-001', 'th-opt154-fan-001',
               'mid-opt154-fan-001', 'sales@fanout.example.com', $3)
       ON CONFLICT DO NOTHING`,
      [MSG_FAN, ACC, OCCURRED_AT],
    );

    await query(
      `INSERT INTO inbox.signals
         (id, message_id, signal_type, direction, domain,
          confidence, content, resolved, occurred_at)
       VALUES ($1, $2, 'action_item', 'inbound', 'general',
               0.90, 'Sales to follow up on the quote.', false, $3)
       ON CONFLICT DO NOTHING`,
      [SIG_FAN, MSG_FAN, OCCURRED_AT],
    );

    const result = await bridgeSignal({
      query,
      signalId: SIG_FAN,
      dryRun: false,
    });

    // The signal row must not have been duplicated by the join: exactly one
    // work_item is created and the signal routes 'created' (inbound_only, recent).
    assert.equal(result.decision, 'created',
      `case-variant contacts must resolve to one and route 'created', got '${result.decision}' (reason: ${result.reason})`);
    assert.ok(result.workItemId,
      `fan-out case must produce exactly one workItemId`);

    // Confirm a single signal row + a single stamped work_item_id.
    const sig = await query(
      `SELECT work_item_id FROM inbox.signals WHERE id = $1`,
      [SIG_FAN],
    );
    assert.equal(sig.rows.length, 1,
      `expected exactly 1 signal row, got ${sig.rows.length}`);
    assert.equal(sig.rows[0].work_item_id, result.workItemId,
      `signal must be stamped with the single created work_item_id`);
  });
});

// ── OPT-162 Phase 2 (ADR-020): dedicated obligation/tenancy column stamping ─────
// The bridge now ALSO populates the mig-178 columns on the work_item it already
// creates: owner_org_id (from the SOURCE SIGNAL, overriding mig 134's Staqs
// DEFAULT), obligation_type (mapped from signal_type via the shared helper that
// mirrors mig 178's backfill CASE), source_message_id, and viewer_emails (the
// recipient set htViewerFilter uses, for per-viewer Today parity in Phase 3).
// These columns are INERT — nothing reads them until Phase 3 — so stamping them
// must not change routing/volume/behavior (the decision/work_item shape assertions
// above are unchanged).
describe('signal-action-bridge — OPT-162 Phase 2 obligation column stamping', () => {
  let query;

  // A SECOND org so we can prove owner_org_id is copied from the signal, NOT the
  // Staqs DEFAULT that mig 134 stamped on work_items.owner_org_id.
  const ORG2_SLUG = 'opt162-p2-testorg';
  const ACC_P2    = 'acc-opt162-p2';
  const MSG_P2     = 'msg-opt162-p2-001';
  const SIG_P2     = 'sig-opt162-p2-001';
  const P2_TO      = ['recipient-a@example.com', 'recipient-b@example.com'];
  const P2_CC      = ['cc-c@example.com'];
  let org2Id = null;
  let staqsOrgId = null;

  before(async () => {
    ({ query } = await getDb());

    // Resolve the Staqs default org (mig 133 seed) + create a distinct 2nd org.
    const staqs = await query(`SELECT id FROM tenancy.orgs WHERE slug = 'staqs'`);
    staqsOrgId = staqs.rows[0]?.id || null;
    assert.ok(staqsOrgId, 'tenancy.orgs must have a staqs row (mig 133)');

    const org2 = await query(
      `INSERT INTO tenancy.orgs (slug, name) VALUES ($1, 'OPT-162 P2 Test Org')
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [ORG2_SLUG],
    );
    org2Id = org2.rows[0].id;
    assert.ok(org2Id, 'second test org must be created');
    assert.notEqual(org2Id, staqsOrgId, 'second org must differ from Staqs');

    // Account + message (email channel; carries to/cc so viewer_emails derives).
    await query(
      `INSERT INTO inbox.accounts (id, owner, label, identifier, channel, provider)
         VALUES ($1, 'eric', 'OPT-162 P2', 'opt162-p2', 'email', 'gmail')
       ON CONFLICT DO NOTHING`,
      [ACC_P2],
    );
    await query(
      `INSERT INTO inbox.messages
         (id, account_id, channel, provider, provider_msg_id, thread_id,
          message_id, from_address, to_addresses, cc_addresses, received_at)
       VALUES ($1, $2, 'email', 'gmail', 'pm-opt162-p2-001', 'th-opt162-p2-001',
               'mid-opt162-p2-001', 'sender@example.com', $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [MSG_P2, ACC_P2, P2_TO, P2_CC, OCCURRED_AT],
    );

    // Signal: 'request' (eligible + maps to obligation_type 'request'), inbound,
    // general → routes autonomous → 'created'. owner_org_id set to ORG2 so the
    // stamp must OVERRIDE the work_items Staqs DEFAULT.
    await query(
      `INSERT INTO inbox.signals
         (id, message_id, signal_type, direction, domain,
          confidence, content, resolved, occurred_at, owner_org_id)
       VALUES ($1, $2, 'request', 'inbound', 'general',
               0.90, 'Please send the signed NDA back to us.', false, $3, $4)
       ON CONFLICT DO NOTHING`,
      [SIG_P2, MSG_P2, OCCURRED_AT, org2Id],
    );
  });

  it('stamps owner_org_id from the SIGNAL (overriding the Staqs default), plus obligation_type / source_message_id / viewer_emails', async () => {
    const result = await bridgeSignal({ query, signalId: SIG_P2, dryRun: false });

    // INERT invariant: routing/volume unchanged — this still routes 'created'
    // exactly as a request signal did before Phase 2.
    assert.equal(result.decision, 'created',
      `Phase 2 must not change routing: expected 'created', got '${result.decision}' (reason: ${result.reason})`);
    assert.ok(result.workItemId, 'bridge must return a workItemId');

    const wi = await query(
      `SELECT owner_org_id, obligation_type, source_message_id, viewer_emails
         FROM agent_graph.work_items WHERE id = $1`,
      [result.workItemId],
    );
    assert.equal(wi.rows.length, 1, 'work_item row must exist');
    const row = wi.rows[0];

    // owner_org_id = the signal's org, NOT the Staqs DEFAULT (tenancy correctness).
    assert.equal(row.owner_org_id, org2Id,
      `work_item.owner_org_id must equal the signal's org (${org2Id}), got '${row.owner_org_id}'`);
    assert.notEqual(row.owner_org_id, staqsOrgId,
      `work_item.owner_org_id must OVERRIDE the Staqs default (${staqsOrgId})`);

    // obligation_type mapped from signal_type='request' via the shared helper.
    assert.equal(row.obligation_type, 'request',
      `work_item.obligation_type must map 'request'→'request', got '${row.obligation_type}'`);

    // source_message_id denormalized from the signal.
    assert.equal(row.source_message_id, MSG_P2,
      `work_item.source_message_id must equal the signal's message_id ('${MSG_P2}'), got '${row.source_message_id}'`);

    // viewer_emails = the message's to+cc set (htViewerFilter parity). PGlite
    // returns TEXT[] as a JS array.
    const ve = Array.isArray(row.viewer_emails) ? row.viewer_emails : [];
    for (const addr of [...P2_TO, ...P2_CC]) {
      assert.ok(ve.includes(addr),
        `work_item.viewer_emails must include recipient '${addr}', got ${JSON.stringify(ve)}`);
    }
    assert.equal(ve.length, P2_TO.length + P2_CC.length,
      `work_item.viewer_emails must equal exactly the to+cc set, got ${JSON.stringify(ve)}`);
  });

  it('shared obligation_type map matches mig 178 backfill CASE (no drift)', async () => {
    const { OBLIGATION_TYPE_BY_SIGNAL } = await import('../../lib/runtime/signals/obligation-type.js');
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');
    const here = path.dirname(fileURLToPath(import.meta.url));
    const sql = readFileSync(
      path.join(here, '..', 'sql', '178-work-items-obligation-tenancy.sql'),
      'utf8',
    );
    // Parse the CASE arms: WHEN '<signal_type>' THEN '<obligation_type>'
    const caseBlock = sql.slice(sql.indexOf('CASE s.signal_type'), sql.indexOf('END', sql.indexOf('CASE s.signal_type')));
    const fromSql = {};
    for (const m of caseBlock.matchAll(/WHEN\s+'([^']+)'\s+THEN\s+'([^']+)'/g)) {
      fromSql[m[1]] = m[2];
    }
    assert.ok(Object.keys(fromSql).length >= 8,
      `expected to parse the mig-178 CASE arms, got ${JSON.stringify(fromSql)}`);
    // Every SQL arm must be present and identical in the JS map (and vice versa).
    assert.deepEqual(
      OBLIGATION_TYPE_BY_SIGNAL,
      fromSql,
      'JS OBLIGATION_TYPE_BY_SIGNAL must match mig-178 CASE arms exactly (single source of truth)',
    );
  });
});
