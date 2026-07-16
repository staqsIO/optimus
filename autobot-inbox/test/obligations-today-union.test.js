/**
 * OPT-162 Phase 3 (ADR-020) — Today "Open Obligations" union read + tenancy parity.
 *
 * Exercises the EXACT query builders the GET /api/today handler uses when the union
 * cutover is enabled (src/api-routes/obligations-today.js), run against the shared
 * PGlite singleton with mig 179's agent_graph.obligations_today_v in place. Because
 * the handler imports these same builders, handler SQL and test SQL cannot drift.
 *
 * Proves:
 *   (a) the unioned read returns the SAME human_tasks obligations a viewer saw before
 *       PLUS correctly-scoped work_items obligations;
 *   (b) a gated obligation present in BOTH stores appears ONCE (dedup → the work_item
 *       row wins; the linked card is excluded);
 *   (c) per-viewer recipient scoping holds on the work_items leg (a viewer does NOT
 *       see another viewer's email-scoped work_items obligation);
 *   (d) per-org scoping holds on the work_items leg (org A does not see org B's);
 *   (e) flag OFF (default) → unionSourceEnabled() is false (legacy human_tasks read).
 *
 * Framework-agnostic node:test against PGlite — see test/helpers/setup-db.js.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';
import { visibleClause, syntheticPrincipal } from '../../lib/tenancy/scope.js';
import {
  unionSourceEnabled,
  obligViewerFilter,
  oweQuery,
  waitingQuery,
  statsQuery,
} from '../src/api-routes/obligations-today.js';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';
const ALICE = 'alice@orga.test';
const BOB = 'bob@orga.test';

// Build the (params, orgFilter, viewerFilter) trio exactly the handler builds:
// viewer-emails param at $1 (when scoped), then visibleClause org params after.
function buildScope(principal, scopeEmails) {
  const params = [];
  let viewerFilter = '';
  if (scopeEmails !== null) {
    params.push(scopeEmails);
    viewerFilter = obligViewerFilter(scopeEmails);
  }
  const org = visibleClause(principal, {
    ownerOrgCol: 'o.owner_org_id',
    startIndex: params.length + 1,
  });
  params.push(...org.params);
  return { params, viewerFilter, orgFilter: ` AND ${org.sql}` };
}

async function runOweWaiting(query, principal, scopeEmails) {
  const { params, viewerFilter, orgFilter } = buildScope(principal, scopeEmails);
  const owe = (await query(oweQuery(viewerFilter, orgFilter), params)).rows;
  const waiting = (await query(waitingQuery(viewerFilter, orgFilter), params)).rows;
  return { owe, waiting, all: [...owe, ...waiting] };
}

describe('OPT-162 P3 — obligations_today_v union read + tenancy', () => {
  let query;

  before(async () => {
    ({ query } = await getDb());

    // Clean slate for this suite's fixtures.
    await query(`DELETE FROM inbox.human_tasks WHERE id LIKE 'p3-%'`);
    await query(`DELETE FROM agent_graph.work_items WHERE id LIKE 'p3-%'`);
    await query(`DELETE FROM inbox.messages WHERE id LIKE 'p3-%'`);

    // --- Messages: email-channel sources carrying recipient sets ---------
    // p3-msg-alice addressed to Alice; p3-msg-bob addressed to Bob. Both org A.
    await query(
      `INSERT INTO inbox.messages
         (id, thread_id, message_id, provider_msg_id, from_address,
          to_addresses, cc_addresses, subject, received_at, channel)
       VALUES
         ('p3-msg-alice', 'p3-thr-a', 'p3-mid-a', 'p3-pmid-a', 'ext@x.test',
            ARRAY['${ALICE}'], ARRAY[]::text[], 's', now(), 'email'),
         ('p3-msg-bob',   'p3-thr-b', 'p3-mid-b', 'p3-pmid-b', 'ext@x.test',
            ARRAY['${BOB}'],   ARRAY[]::text[], 's', now(), 'email')`,
    );

    // --- LEG 1: pre-migration human_tasks obligations (org A) ------------
    // p3-ht-legacy:    a card-only obligation NOT linked to any work_item → must appear.
    // p3-ht-gated:     a card LINKED to a QUALIFYING work_item (p3-wi-gated) → DEDUPED
    //                  OUT (the work_item row represents it instead).
    // p3-ht-nullob:    REGRESSION (the prod drop): a card linked to a work_item with
    //                  obligation_type NULL (does NOT qualify for LEG 2) → must STILL
    //                  APPEAR via LEG 1 (it would vanish under the old dedup).
    // p3-ht-orphan:    REGRESSION: a card linked to a DELETED/non-existent work_item
    //                  → must STILL APPEAR via LEG 1.
    await query(
      `INSERT INTO inbox.human_tasks
         (id, title, task_type, status, owner_org_id, message_id, next_action_hint, due_date)
       VALUES
         ('p3-ht-legacy', 'legacy card', 'request', 'inbox', $1, 'p3-msg-alice', NULL, CURRENT_DATE),
         ('p3-ht-gated',  'gated card',  'action',  'inbox', $1, 'p3-msg-alice', 'work_item:p3-wi-gated', CURRENT_DATE),
         ('p3-ht-nullob', 'null-ob card','action',  'inbox', $1, 'p3-msg-alice', 'work_item:p3-wi-nullob', CURRENT_DATE),
         ('p3-ht-orphan', 'orphan card', 'action',  'inbox', $1, 'p3-msg-alice', 'work_item:p3-wi-doesnotexist', CURRENT_DATE)`,
      [ORG_A],
    );

    // --- LEG 2: work_items obligations ----------------------------------
    // LIKE-FOR-LIKE: LEG 2 shows GATED obligations only (metadata.reversibility_class
    // = 'gated' — the set that has a human_task card today). All the GATED fixtures
    // below carry metadata.reversibility_class='gated'.
    // p3-wi-gated:       the work_item the gated card links to (org A, Alice's recipients).
    // p3-wi-alice:       a GATED email-scoped obligation addressed to Alice (org A).
    // p3-wi-bob:         a GATED email-scoped obligation addressed to Bob (org A).
    // p3-wi-orgb:        a GATED obligation in org B (never appears for an org-A viewer).
    // p3-wi-autonomous:  an AUTONOMOUS obligation (no card today) → MUST be excluded.
    // p3-wi-done:        a COMPLETED gated obligation (terminal) → excluded by the view.
    // p3-wi-nonob:       obligation_type NULL (ordinary task-graph work) → excluded.
    const GATED = JSON.stringify({ source: 'signal-action-bridge', reversibility_class: 'gated' });
    const AUTON = JSON.stringify({ source: 'signal-action-bridge', reversibility_class: 'autonomous' });
    await query(
      `INSERT INTO agent_graph.work_items
         (id, type, title, created_by, status, obligation_type, owner_org_id,
          source_message_id, viewer_emails, deadline, metadata)
       VALUES
         ('p3-wi-gated', 'task', 'gated obligation', 'signal-action-bridge', 'created',
            'action', $1, 'p3-msg-alice', ARRAY['${ALICE}'], now(), $3::jsonb),
         ('p3-wi-alice', 'task', 'alice obligation', 'signal-action-bridge', 'created',
            'request', $1, 'p3-msg-alice', ARRAY['${ALICE}'], now(), $3::jsonb),
         ('p3-wi-bob',   'task', 'bob obligation',   'signal-action-bridge', 'created',
            'request', $1, 'p3-msg-bob', ARRAY['${BOB}'], now(), $3::jsonb),
         ('p3-wi-orgb',  'task', 'orgb obligation',  'signal-action-bridge', 'created',
            'request', $2, NULL, NULL, now(), $3::jsonb),
         ('p3-wi-autonomous', 'task', 'autonomous obligation', 'signal-action-bridge', 'created',
            'request', $1, 'p3-msg-alice', ARRAY['${ALICE}'], now(), $4::jsonb),
         ('p3-wi-done',  'task', 'done obligation',  'signal-action-bridge', 'completed',
            'request', $1, NULL, ARRAY['${ALICE}'], now(), $3::jsonb),
         ('p3-wi-nonob', 'task', 'ordinary task',    'orchestrator', 'created',
            NULL, $1, NULL, NULL, now(), '{}'::jsonb),
         -- REGRESSION shape (the prod drop): an ACTION card's linked work_item that
         -- never got obligation_type stamped (deploy-window gap) — does NOT qualify
         -- for LEG 2, so the card p3-ht-nullob must survive via LEG 1.
         ('p3-wi-nullob', 'task', 'unstamped wi',    'signal-action-bridge', 'created',
            NULL, $1, 'p3-msg-alice', ARRAY['${ALICE}'], now(), $3::jsonb)`,
      [ORG_A, ORG_B, GATED, AUTON],
    );
  });

  // (e) Flag default OFF.
  it('flag default OFF → legacy human_tasks read', () => {
    assert.equal(unionSourceEnabled({}), false);
    assert.equal(unionSourceEnabled({ TODAY_OBLIGATIONS_SOURCE: 'human_tasks' }), false);
    assert.equal(unionSourceEnabled({ TODAY_OBLIGATIONS_SOURCE: 'union' }), true);
  });

  // (a) Unioned read returns legacy obligations PLUS scoped work_items, and
  // (b) dedup: the gated card is excluded; its work_item appears once.
  it('admin (unscoped) sees legacy card + work_items, gated deduped to one row', async () => {
    // adminBypass principal, scopeEmails=null → unfiltered (no viewer/org filter).
    const principal = { userId: null, readOrgIds: [], roles: {}, adminBypass: true };
    const { all } = await runOweWaiting(query, principal, null);
    const ids = all.map((r) => r.id).filter((id) => id.startsWith('ht:p3') || id.startsWith('wi:p3'));

    // Legacy card-only obligation present.
    assert.ok(ids.includes('ht:p3-ht-legacy'), 'legacy human_task obligation present');
    // Work_items obligations present.
    assert.ok(ids.includes('wi:p3-wi-gated'), 'gated work_item present');
    assert.ok(ids.includes('wi:p3-wi-alice'), 'alice work_item present');
    // Dedup: the gated CARD must NOT appear (work_item represents it).
    assert.equal(ids.includes('ht:p3-ht-gated'), false, 'gated card deduped out');
    // The gated obligation appears EXACTLY once across the whole result.
    const gatedRows = ids.filter((id) => id === 'wi:p3-wi-gated' || id === 'ht:p3-ht-gated');
    assert.equal(gatedRows.length, 1, 'gated obligation appears exactly once');
    // Terminal + non-obligation work_items excluded.
    assert.equal(ids.includes('wi:p3-wi-done'), false, 'completed obligation excluded');
    assert.equal(ids.includes('wi:p3-wi-nonob'), false, 'non-obligation work_item excluded');
    // LIKE-FOR-LIKE: AUTONOMOUS obligations (no card today) must NOT appear.
    assert.equal(
      ids.includes('wi:p3-wi-autonomous'),
      false,
      'autonomous work_item obligation excluded (like-for-like)',
    );
  });

  // LIKE-FOR-LIKE (Eric, OPT-162 P3): a GATED work_item obligation APPEARS; an
  // AUTONOMOUS one does NOT — the union set == today's Today set (gated/needs-you).
  it('gated work_item appears, autonomous work_item does NOT (like-for-like)', async () => {
    const principal = { userId: null, readOrgIds: [], roles: {}, adminBypass: true };
    const ids = (await runOweWaiting(query, principal, null)).all.map((r) => r.id);
    assert.ok(ids.includes('wi:p3-wi-gated'), 'gated work_item obligation APPEARS');
    assert.ok(ids.includes('wi:p3-wi-alice'), 'gated email-scoped obligation APPEARS');
    assert.equal(
      ids.includes('wi:p3-wi-autonomous'),
      false,
      'autonomous work_item obligation does NOT appear',
    );
  });

  // REGRESSION (the prod drop of 26 live obligations): a card linked to a work_item
  // that does NOT qualify for LEG 2 (NULL obligation_type, or deleted/orphan) must
  // STILL APPEAR via LEG 1. Suppress a card ONLY when its linked work_item genuinely
  // re-surfaces in LEG 2. Net: union set is a SUPERSET-or-equal of the legacy set.
  it('card linked to a NON-qualifying / orphan work_item still appears (no vanish)', async () => {
    const principal = { userId: null, readOrgIds: [], roles: {}, adminBypass: true };
    const ids = (await runOweWaiting(query, principal, null)).all.map((r) => r.id);

    // (a) card → NULL-obligation_type work_item (the exact prod failure) STILL shows.
    assert.ok(ids.includes('ht:p3-ht-nullob'), 'card linked to NULL-obligation_type wi appears via LEG 1');
    // (b) card → deleted/non-existent work_item STILL shows.
    assert.ok(ids.includes('ht:p3-ht-orphan'), 'card linked to orphan wi appears via LEG 1');
    // (c) parity: a card whose work_item DOES qualify is still deduped to one row
    //     (the work_item), not double-counted.
    assert.equal(ids.includes('ht:p3-ht-gated'), false, 'qualifying-link card still deduped out of LEG 1');
    assert.ok(ids.includes('wi:p3-wi-gated'), 'its qualifying work_item appears in LEG 2');
    const gated = ids.filter((id) => id === 'ht:p3-ht-gated' || id === 'wi:p3-wi-gated');
    assert.equal(gated.length, 1, 'qualifying gated obligation appears exactly once (no double)');

    // SUPERSET invariant: every live legacy human_tasks card is reachable in the union
    // either as itself (ht:) OR via its qualifying work_item (wi:). No card vanishes.
    const liveCards = (
      await query(
        `SELECT id, next_action_hint FROM inbox.human_tasks
          WHERE id LIKE 'p3-%' AND deleted_at IS NULL
            AND status NOT IN ('done','skipped','not_for_us')
            AND (due_date IS NULL OR due_date >= now() - interval '7 days')`,
      )
    ).rows;
    for (const card of liveCards) {
      const selfShown = ids.includes(`ht:${card.id}`);
      // If deduped out, its linked work_item MUST be present (the only legal reason).
      const linkedId = (card.next_action_hint || '').replace(/^work_item:/, '');
      const wiShown = linkedId && ids.includes(`wi:${linkedId}`);
      assert.ok(
        selfShown || wiShown,
        `legacy card ${card.id} must appear (self or via work_item) — superset invariant`,
      );
    }
  });

  // (d) Per-org scoping on the work_items leg.
  it('org-A viewer does NOT see org-B work_items obligation', async () => {
    const principal = syntheticPrincipal(ORG_A); // org-A scoped, no admin bypass
    const { all } = await runOweWaiting(query, principal, null);
    const ids = all.map((r) => r.id);
    assert.ok(ids.includes('wi:p3-wi-alice'), 'org-A work_item visible to org-A');
    assert.equal(ids.includes('wi:p3-wi-orgb'), false, 'org-B work_item NOT visible to org-A');
  });

  // (c) Per-viewer recipient scoping on the work_items leg.
  it('Alice does NOT see Bob-addressed work_items obligation (and vice-versa)', async () => {
    const principal = syntheticPrincipal(ORG_A);

    const alice = await runOweWaiting(query, principal, [ALICE]);
    const aliceIds = alice.all.map((r) => r.id);
    assert.ok(aliceIds.includes('wi:p3-wi-alice'), 'Alice sees her own work_item');
    assert.equal(aliceIds.includes('wi:p3-wi-bob'), false, "Alice does NOT see Bob's work_item");
    // The gated work_item (Alice recipients) is visible to Alice.
    assert.ok(aliceIds.includes('wi:p3-wi-gated'), 'Alice sees the gated work_item');

    const bob = await runOweWaiting(query, principal, [BOB]);
    const bobIds = bob.all.map((r) => r.id);
    assert.ok(bobIds.includes('wi:p3-wi-bob'), 'Bob sees his own work_item');
    assert.equal(bobIds.includes('wi:p3-wi-alice'), false, "Bob does NOT see Alice's work_item");
  });

  // (c') A no-recipient / non-email work_item obligation bypasses the viewer filter
  // EXACTLY as htViewerFilter does (is_email_scoped=false → always in-scope within org).
  it('no-recipient work_item obligation is viewer-scope-bypassed (matches htViewerFilter)', async () => {
    await query(
      `INSERT INTO agent_graph.work_items
         (id, type, title, created_by, status, obligation_type, owner_org_id,
          source_message_id, viewer_emails, deadline, metadata)
       VALUES ('p3-wi-norecip', 'task', 'slack obligation', 'signal-action-bridge',
               'created', 'request', $1, NULL, NULL, now(),
               '{"source":"signal-action-bridge","reversibility_class":"gated"}'::jsonb)`,
      [ORG_A],
    );
    const principal = syntheticPrincipal(ORG_A);
    const alice = await runOweWaiting(query, principal, [ALICE]);
    assert.ok(
      alice.all.map((r) => r.id).includes('wi:p3-wi-norecip'),
      'no-recipient obligation is in-scope for Alice (bypass, like htViewerFilter)',
    );
  });

  // (Linus BLOCKER fix) Case-insensitive overlap: a MIXED-CASE recipient address
  // must still match a LOWERCASE viewer email, on BOTH legs — exactly like the
  // legacy htViewerFilter's `lower(addr) = ANY($1)`. Without the end-to-end lower()
  // the work_items leg silently dropped the obligation (correctness regression).
  it('mixed-case recipient matches a lowercase viewer (case-insensitive, both legs)', async () => {
    // wi leg: viewer_emails carries a mixed-case address.
    await query(
      `INSERT INTO agent_graph.work_items
         (id, type, title, created_by, status, obligation_type, owner_org_id,
          source_message_id, viewer_emails, deadline, metadata)
       VALUES ('p3-wi-mixed', 'task', 'mixed-case wi', 'signal-action-bridge',
               'created', 'request', $1, NULL, ARRAY['Alice@OrgA.Test'], now(),
               '{"source":"signal-action-bridge","reversibility_class":"gated"}'::jsonb)`,
      [ORG_A],
    );
    // ht leg: a card-only obligation whose source message has a mixed-case to-address.
    await query(
      `INSERT INTO inbox.messages
         (id, thread_id, message_id, provider_msg_id, from_address,
          to_addresses, cc_addresses, subject, received_at, channel)
       VALUES ('p3-msg-mixed', 'p3-thr-m', 'p3-mid-m', 'p3-pmid-m', 'ext@x.test',
               ARRAY['Alice@OrgA.Test'], ARRAY[]::text[], 's', now(), 'email')`,
    );
    await query(
      `INSERT INTO inbox.human_tasks
         (id, title, task_type, status, owner_org_id, message_id, next_action_hint, due_date)
       VALUES ('p3-ht-mixed', 'mixed-case ht', 'request', 'inbox', $1, 'p3-msg-mixed', NULL, CURRENT_DATE)`,
      [ORG_A],
    );

    // Viewer email is LOWERCASE; recipients are mixed-case.
    const principal = syntheticPrincipal(ORG_A);
    const { all } = await runOweWaiting(query, principal, [ALICE]); // ALICE = 'alice@orga.test'
    const ids = all.map((r) => r.id);
    assert.ok(ids.includes('wi:p3-wi-mixed'), 'mixed-case wi recipient matches lowercase viewer');
    assert.ok(ids.includes('ht:p3-ht-mixed'), 'mixed-case ht recipient matches lowercase viewer');
  });

  // Stats counts match the scoped lists.
  it('stats counts reflect the SAME scoped/deduped population', async () => {
    const principal = syntheticPrincipal(ORG_A);
    const { params, viewerFilter, orgFilter } = buildScope(principal, [ALICE]);
    const stats = (await query(statsQuery(viewerFilter, orgFilter), params)).rows[0];
    const { owe, waiting } = await runOweWaiting(query, principal, [ALICE]);
    assert.equal(Number(stats.owe_count), owe.length, 'owe_count matches owe list');
    assert.equal(Number(stats.waiting_count), waiting.length, 'waiting_count matches waiting list');
  });
});
