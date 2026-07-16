/**
 * Issue #545 — DELETE /api/contracts/:id RLS DELETE-policy parity.
 *
 * Today the app pool connects as the Supabase superuser, so RLS is bypassed
 * everywhere and this route "works" by accident. content.drafts,
 * content.send_overrides, and signatures.signature_requests each have RLS
 * ENABLED with only a SELECT policy (no DELETE policy); content.gate_log had
 * no RLS at all. The moment STAQPRO-303 PR-B flips the pool to the
 * non-superuser autobot_agent role, a command with no policy for it is a
 * total deny for that role — every DELETE in this route's multi-statement
 * transaction either no-ops (drafts/send_overrides/signature_requests, deny
 * by default) or, pre-migration-195, succeeds unconditionally on gate_log
 * (unprotected). Net effect pre-195: the audit trail (gate_log) is silently
 * destroyed while the actual draft/override/signature rows silently survive
 * — a false-positive-success partial delete, and the whole route reports
 * `{ ok: true }` regardless. Migration 195 gives gate_log the SAME tenancy
 * DELETE policy as drafts, closing that inconsistency.
 *
 * This suite exercises the REAL, unmodified `DELETE /api/contracts/:id`
 * handler (registerContractRoutes from src/api-routes/contracts.js is
 * imported and invoked directly — nothing here is re-implemented or
 * mocked) against a real Postgres instance with the pool flipped to
 * autobot_agent, matching the exact production call pattern once PR-B
 * lands.
 *
 * CRITICAL FINDING surfaced by this suite (see the first test below): under
 * the real, unmodified call path (no GUC context), content.drafts' own
 * SELECT policy — pre-existing, from migration 190, NOT touched by 195 —
 * is ALSO tenancy-gated. So the handler's opening existence-check SELECT
 * returns 0 rows and it throws "Contract not found" (404) before any DELETE
 * statement runs at all, both before and after migration 195. The original
 * "silently reports ok:true while rows survive" framing does not reproduce
 * once the SELECT-gate is accounted for — the real failure is a 404 on
 * every contract, which is a superset problem (reads are broken too, not
 * just deletes) that migration 195 alone cannot fix. The DELETE-policy
 * parity this migration adds is still necessary and correct (see test 2:
 * with a matching tenancy GUC context supplied, it demonstrably flips this
 * migration from "0 rows deleted" to "rows deleted cleanly") — it is just
 * not sufficient on its own to fix the real call path, which additionally
 * needs this route wired through withAgentScope/withBoardScope.
 *
 * Seeding fixtures: autobot_agent has no INSERT policy on any of these four
 * tables (RLS enabled, INSERT unaddressed — a separate, pre-existing gap;
 * see the "residual risks" note in migration 195). Fixtures are seeded via
 * a second connection as the `limited` role instead: `limited` is the table
 * OWNER (it ran the migrations) and none of these tables ever set FORCE ROW
 * LEVEL SECURITY, so the owner bypasses RLS entirely — the same owner-bypass
 * mechanism migration 195's own verify block relies on implicitly. This
 * mirrors managed-Postgres reality (a migration-runner role owns the
 * tables; the app role does not).
 *
 * Env gating (three separate opt-ins, all required):
 *   DATABASE_URL              — real Postgres, pool connects through it
 *   AUTOBOT_AGENT_DB_PASSWORD — lib/db.js swaps pool userinfo to autobot_agent
 *   LIMITED_DATABASE_URL      — owner-role connection for fixture seeding
 * All three are absent under PGlite (`npm run test:ci`), so this suite
 * SKIPS there with a clear log line rather than passing vacuously.
 *
 * Run: cd autobot-inbox && DATABASE_URL=... AUTOBOT_AGENT_DB_PASSWORD=... \
 *        LIMITED_DATABASE_URL=... node --test --test-force-exit \
 *        test/contracts-delete-rls.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const HAS_REAL_PG = !!process.env.DATABASE_URL;
const HAS_AUTOBOT_AGENT_OPT_IN = !!process.env.AUTOBOT_AGENT_DB_PASSWORD;
const HAS_SEED_CONN = !!process.env.LIMITED_DATABASE_URL;
const RLS_TEST_ENABLED = HAS_REAL_PG && HAS_AUTOBOT_AGENT_OPT_IN && HAS_SEED_CONN;

// Matches content.drafts.owner_org_id's DEFAULT in sql/ (the fixture org
// tenancy.visible() already recognizes in this test environment) so the
// "matching context" scenarios don't depend on a row existing in
// tenancy.orgs — tenancy.visible(NULL, org) only compares against
// app.org_ids, it does not require the org row to exist.
const OWNER_ORG = '8d218b6d-1ed5-4d7b-8645-1a0f057977e4';
const OTHER_ORG = 'aaaaaaaa-0000-0000-0000-000000000000';

let registerContractRoutes;
let withAgentScope;
let close;
let seedPool;

before(async () => {
  if (!RLS_TEST_ENABLED) {
    // eslint-disable-next-line no-console
    console.log(
      '[contracts-delete-rls] SKIPPING — requires DATABASE_URL, ' +
      'AUTOBOT_AGENT_DB_PASSWORD, and LIMITED_DATABASE_URL. PGlite roles ' +
      'are SUPERUSER and would bypass RLS, making this suite vacuous.'
    );
    return;
  }
  ({ registerContractRoutes } = await import('../src/api-routes/contracts.js'));
  ({ withAgentScope, close } = await import('../../lib/db.js'));
  seedPool = new pg.Pool({ connectionString: process.env.LIMITED_DATABASE_URL, max: 2 });
});

after(async () => {
  if (!RLS_TEST_ENABLED) return;
  await seedPool.end();
  await close();
});

function buildDeleteHandler() {
  const routes = new Map();
  registerContractRoutes(routes);
  return routes.get('DELETE /api/contracts/:id');
}

async function seedDraft({ withSendOverride = false, withSignatureRequest = false } = {}) {
  const title = `e2e-545-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const draft = await seedPool.query(
    `INSERT INTO content.drafts (content_type, status, title, body, owner_org_id)
     VALUES ('contract', 'approved', $1, 'body text', $2)
     RETURNING id`,
    [title, OWNER_ORG]
  );
  const draftId = draft.rows[0].id;

  await seedPool.query(
    `INSERT INTO content.gate_log (draft_id, gate_name, passed) VALUES ($1, 'G2', true)`,
    [draftId]
  );

  if (withSendOverride) {
    await seedPool.query(
      `INSERT INTO content.send_overrides (draft_id, overridden_by, override_reason, findings)
       VALUES ($1, 'test-harness', 'seeded for #545 e2e regression test', '[]'::jsonb)`,
      [draftId]
    );
  }

  if (withSignatureRequest) {
    // status='cancelled' — deliberately NOT in the route's active-signing
    // block-list ('pending','in_progress','completed') so this fixture
    // exercises the RLS layer, not the app-level 409 guard.
    await seedPool.query(
      `INSERT INTO signatures.signature_requests
         (draft_id, draft_schema, document_hash, status, expires_at, created_by, title)
       VALUES ($1, 'content', 'deadbeef', 'cancelled', now() + interval '1 day', 'test-harness', 'seed sig request')`,
      [draftId]
    );
  }

  return draftId;
}

async function counts(draftId) {
  const [drafts, gateLog, overrides, sigReqs] = await Promise.all([
    seedPool.query(`SELECT count(*)::int AS c FROM content.drafts WHERE id = $1`, [draftId]),
    seedPool.query(`SELECT count(*)::int AS c FROM content.gate_log WHERE draft_id = $1`, [draftId]),
    seedPool.query(`SELECT count(*)::int AS c FROM content.send_overrides WHERE draft_id = $1`, [draftId]),
    seedPool.query(`SELECT count(*)::int AS c FROM signatures.signature_requests WHERE draft_id = $1`, [draftId]),
  ]);
  return {
    drafts: drafts.rows[0].c,
    gateLog: gateLog.rows[0].c,
    overrides: overrides.rows[0].c,
    sigReqs: sigReqs.rows[0].c,
  };
}

// Owner-bypass cleanup — `limited` owns every table here, so RLS itself is
// never a problem. Child rows first (gate_log_draft_id_fkey /
// send_overrides_draft_id_fkey have no ON DELETE action = RESTRICT) —
// mirrors the real handler's order.
//
// content.send_overrides is intentionally NOT deleted here:
// trg_send_overrides_immutable (BEFORE DELETE OR UPDATE) rejects every
// DELETE against this table regardless of role — including from `limited`,
// the table owner. Owner-bypass only escapes RLS *policies*; it does not
// bypass a BEFORE trigger, which is a separate, unconditional enforcement
// mechanism. This is consistent with the table's actual design (an
// append-only override-justification record, same D4 immutability pattern
// as voice.edit_deltas) — leftover send_overrides fixture rows are harmless
// in the ephemeral test-postgres database (docker container or CI service
// container, both discarded after the run), so we simply leave them.
//
// Consequence: for any draftId seeded WITH a send_overrides row, the final
// `DELETE FROM content.drafts` below will itself hit
// send_overrides_draft_id_fkey (RESTRICT) — the exact same FK the real
// handler would hit. That's expected, not a bug in the harness, so it's
// swallowed here (23503 = foreign_key_violation) rather than re-thrown;
// the orphaned drafts+gate_log+send_overrides trio is equally harmless in
// the ephemeral test database.
async function cleanup(draftId) {
  await seedPool.query(`DELETE FROM content.gate_log WHERE draft_id = $1`, [draftId]);
  await seedPool.query(`DELETE FROM signatures.signature_requests WHERE draft_id = $1`, [draftId]);
  try {
    await seedPool.query(`DELETE FROM content.drafts WHERE id = $1`, [draftId]);
  } catch (err) {
    if (err.code !== '23503') throw err;
  }
}

describe('DELETE /api/contracts/:id — real-Postgres RLS parity (issue #545)', () => {
  it(
    '[real call path, no GUC context] CRITICAL FINDING: the route 404s before it ever reaches the DELETE statements — worse than a silent no-op',
    { skip: !RLS_TEST_ENABLED },
    async () => {
      // This is the exact, unmodified production call shape: contracts.js
      // never wraps this route in withAgentScope/withBoardScope, so no
      // app.user / app.org_ids GUC is ever set. content.drafts' SELECT
      // policy (`tenancy_visible_select_drafts`, pre-existing — migration
      // 190, NOT touched by 195) is tenancy-gated the same way the DELETE
      // policy now is. Once the pool is autobot_agent (not the owner, not a
      // superuser), that SELECT — the handler's own existence check, BEFORE
      // any DELETE statement runs — returns 0 rows for every contract. The
      // handler then throws "Contract not found" (404).
      //
      // This is true BOTH before and after migration 195, because 195 only
      // adds DELETE policies; it does not touch the pre-existing SELECT
      // policy. So the "silent no-op that still reports ok:true" framing in
      // the original issue is, empirically, not what happens once the pool
      // flips: the route fails much earlier and much louder (404 on every
      // contract) — an even more severe manifestation of the same root
      // cause (no GUC context is ever established for this route). See the
      // residual-risks note in migration 195 and the final report for how
      // this changes the fix's priority ordering.
      const draftId = await seedDraft({ withSendOverride: true, withSignatureRequest: true });
      const before = await counts(draftId);
      assert.deepEqual(
        before,
        { drafts: 1, gateLog: 1, overrides: 1, sigReqs: 1 },
        'fixture must seed exactly one row per table'
      );

      const handler = buildDeleteHandler();
      await assert.rejects(
        handler({ url: `/api/contracts/${draftId}`, headers: {} }),
        /Contract not found/,
        'handler must 404 under the real, unmodified call path — the opening ' +
        'SELECT is tenancy-gated and no GUC context is ever established here'
      );

      // Nothing ran — the transaction never opened. Every row survives,
      // including gate_log (this is unaffected by migration 195 either way,
      // since the route never gets past the SELECT).
      const after = await counts(draftId);
      assert.deepEqual(after, before, 'no statement in the DELETE transaction should have executed');

      await cleanup(draftId);
    }
  );

  it(
    '[scoped tenancy context, clean draft] DELETE parity works when a matching principal IS supplied — proves the policy itself is correct',
    { skip: !RLS_TEST_ENABLED },
    async () => {
      const draftId = await seedDraft(); // no send_overrides / signature_requests attached
      // Simulates the GUC context a future fix to contracts.js would need to
      // establish (e.g. wrapping this handler in withAgentScope with a
      // principal derived from the caller's org). This is NOT how the route
      // behaves today — see the previous test for the real call path.
      const scoped = await withAgentScope('e2e-545-test-agent', { orgIds: [OWNER_ORG] });
      try {
        await scoped(`DELETE FROM content.gate_log WHERE draft_id = $1`, [draftId]);
        await scoped(`DELETE FROM content.drafts WHERE id = $1`, [draftId]);
      } finally {
        await scoped.release();
      }

      const after = await counts(draftId);
      assert.deepEqual(
        after,
        { drafts: 0, gateLog: 0, overrides: 0, sigReqs: 0 },
        'with a correctly-scoped tenancy context and no competing FK rows, drafts+gate_log delete cleanly'
      );
    }
  );

  it(
    '[scoped tenancy context, WITH a send_overrides row] CRITICAL: fixing the GUC-plumbing gap alone turns the silent no-op into a hard FK-violation 500',
    { skip: !RLS_TEST_ENABLED },
    async () => {
      const draftId = await seedDraft({ withSendOverride: true });
      const scoped = await withAgentScope('e2e-545-test-agent-2', { orgIds: [OWNER_ORG] });
      try {
        await scoped(`DELETE FROM content.gate_log WHERE draft_id = $1`, [draftId]);
        // content.send_overrides can never be deleted while auth.uid() is
        // always NULL (no JWT-issuing path sets request.jwt.claim.sub
        // anywhere in this codebase) — so send_overrides_draft_id_fkey
        // blocks this DELETE, and the whole transaction that withAgentScope
        // opened rolls back (including the gate_log delete above).
        await assert.rejects(
          scoped(`DELETE FROM content.drafts WHERE id = $1`, [draftId]),
          /send_overrides_draft_id_fkey/,
          'a future GUC-plumbing fix for drafts/gate_log WITHOUT also fixing ' +
          'send_overrides auth.uid() turns today\'s silent no-op into a ' +
          'visible 500 the moment a draft has any send_overrides row'
        );
      } finally {
        await scoped.release(); // rolls back — nothing to clean up beyond the seed
      }

      const after = await counts(draftId);
      assert.deepEqual(
        after,
        { drafts: 1, gateLog: 1, overrides: 1, sigReqs: 0 },
        'the aborted transaction must roll back in full — gate_log survives too, not just drafts'
      );

      await cleanup(draftId);
    }
  );

  it(
    '[negative control] mismatched org context still denies — deny-by-default holds',
    { skip: !RLS_TEST_ENABLED },
    async () => {
      const draftId = await seedDraft();
      const scoped = await withAgentScope('e2e-545-test-agent-3', { orgIds: [OTHER_ORG] });
      try {
        const r = await scoped(`DELETE FROM content.drafts WHERE id = $1`, [draftId]);
        assert.equal(r.rowCount, 0, 'DELETE must no-op under a non-matching org context — the predicate was not loosened');
      } finally {
        await scoped.release();
      }
      await cleanup(draftId);
    }
  );
});

// ---------------------------------------------------------------------------
// Issue #555 — content.drafts UPDATE-policy parity (migration 196).
//
// The DELETE /api/contracts/:id transaction also runs
//   UPDATE content.drafts SET source_draft_id = NULL WHERE source_draft_id = $1
// to detach child drafts before the parent is removed. content.drafts had a
// SELECT policy (190) and a DELETE policy (195) but no UPDATE policy, so once
// the pool flips to autobot_agent that UPDATE 0-row-denies silently. Migration
// 196 adds the UPDATE policy (USING = WITH CHECK = tenancy.visible(NULL,
// owner_org_id)). These tests exercise the policy directly through
// withAgentScope — the same GUC context contracts.js's DELETE txn now opens
// (#562 swapped its wrapper from withBoardScope to withAgentScope so agent
// JWTs don't 500) against real Postgres flipped to autobot_agent. Same env
// gating as the DELETE suite above — SKIP under PGlite.
//
// The send_overrides half of #555 (issue #561 — the override-audit INSERT and
// the request_id backfill UPDATE) IS now covered, in the last describe block of
// this file. Migration 197 gives content.send_overrides INSERT/UPDATE policies
// derived through the parent draft's tenancy predicate (NOT the dead auth.uid()
// SELECT twin from sql/071), so both write paths are testable
// non-tautologically under a real autobot_agent pool.
// ---------------------------------------------------------------------------

// Seeds a parent draft plus a child draft whose source_draft_id points at it,
// both owned by `org`. Returns { parentId, childId }. Seeded via the owner
// `seedPool` (bypasses RLS) — autobot_agent has no INSERT policy on drafts.
async function seedParentChild(org = OWNER_ORG) {
  const tag = `e2e-555-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const parent = await seedPool.query(
    `INSERT INTO content.drafts (content_type, status, title, body, owner_org_id)
     VALUES ('contract', 'approved', $1, 'parent body', $2)
     RETURNING id`,
    [`${tag}-parent`, org]
  );
  const parentId = parent.rows[0].id;
  const child = await seedPool.query(
    `INSERT INTO content.drafts (content_type, status, title, body, owner_org_id, source_draft_id)
     VALUES ('contract', 'approved', $1, 'child body', $2, $3)
     RETURNING id`,
    [`${tag}-child`, org, parentId]
  );
  return { parentId, childId: child.rows[0].id };
}

async function sourceDraftIdOf(childId) {
  const r = await seedPool.query(
    `SELECT source_draft_id FROM content.drafts WHERE id = $1`,
    [childId]
  );
  return r.rows[0]?.source_draft_id ?? null;
}

async function ownerOrgOf(childId) {
  const r = await seedPool.query(
    `SELECT owner_org_id FROM content.drafts WHERE id = $1`,
    [childId]
  );
  return r.rows[0]?.owner_org_id ?? null;
}

// Child first — source_draft_id is a self-reference; deleting the parent while
// the child still points at it could hit the self-FK. Owner-bypass on seedPool.
async function cleanupPair({ parentId, childId }) {
  await seedPool.query(`DELETE FROM content.drafts WHERE id = $1`, [childId]);
  await seedPool.query(`DELETE FROM content.drafts WHERE id = $1`, [parentId]);
}

describe('content.drafts — real-Postgres UPDATE RLS parity (issue #555, mig 196)', () => {
  it(
    '[T1 positive] scoped matching org: the detach UPDATE affects the child row and nulls source_draft_id',
    { skip: !RLS_TEST_ENABLED },
    async () => {
      const pair = await seedParentChild(OWNER_ORG);
      assert.equal(
        await sourceDraftIdOf(pair.childId),
        pair.parentId,
        'fixture: child must start out pointing at the parent'
      );

      // Exactly the statement contracts.js runs inside the DELETE txn,
      // now under the GUC context withAgentScope establishes for it.
      const scoped = await withAgentScope('e2e-555-update-1', { orgIds: [OWNER_ORG] });
      let rowCount;
      try {
        const r = await scoped(
          `UPDATE content.drafts SET source_draft_id = NULL WHERE source_draft_id = $1`,
          [pair.parentId]
        );
        rowCount = r.rowCount;
      } finally {
        await scoped.release();
      }

      assert.ok(
        rowCount >= 1,
        `UPDATE must affect the child row under a matching org context (got rowCount=${rowCount})`
      );
      assert.equal(
        await sourceDraftIdOf(pair.childId),
        null,
        'source_draft_id must be NULL after the detach UPDATE'
      );

      await cleanupPair(pair);
    }
  );

  it(
    '[T2 negative, non-tautological] mismatched org: the SAME UPDATE silently no-ops (0 rows) — reproduces the post-flip bug the policy context fixes',
    { skip: !RLS_TEST_ENABLED },
    async () => {
      const pair = await seedParentChild(OWNER_ORG);

      // Same statement, wrong org in app.org_ids. USING filters the child out,
      // so the UPDATE matches nothing: 0 rows, NO error, the row is untouched
      // — the exact silent no-op that fires in prod once the pool is
      // autobot_agent and no correct context is supplied. T1 proves the same
      // statement DOES affect the row under the right context, so this 0 is a
      // genuine deny, not a vacuous "nothing matched anyway".
      const scoped = await withAgentScope('e2e-555-update-2', { orgIds: [OTHER_ORG] });
      let rowCount;
      try {
        const r = await scoped(
          `UPDATE content.drafts SET source_draft_id = NULL WHERE source_draft_id = $1`,
          [pair.parentId]
        );
        rowCount = r.rowCount;
      } finally {
        await scoped.release();
      }

      assert.equal(rowCount, 0, 'UPDATE must no-op under a non-matching org context');
      assert.equal(
        await sourceDraftIdOf(pair.childId),
        pair.parentId,
        'the child row must be untouched — the predicate was not loosened'
      );

      await cleanupPair(pair);
    }
  );

  it(
    '[T5 WITH CHECK] scoped matching org may not re-home a visible row into an org it cannot see',
    { skip: !RLS_TEST_ENABLED },
    async () => {
      const pair = await seedParentChild(OWNER_ORG);

      // USING passes (child owner is in app.org_ids), but the post-image sets
      // owner_org_id to an org NOT in app.org_ids, so WITH CHECK rejects it.
      // Without a WITH CHECK clause this write would silently succeed and move
      // the row out of the caller's tenancy.
      const scoped = await withAgentScope('e2e-555-update-5', { orgIds: [OWNER_ORG] });
      try {
        await assert.rejects(
          scoped(
            `UPDATE content.drafts SET owner_org_id = $2 WHERE id = $1`,
            [pair.childId, OTHER_ORG]
          ),
          /row-level security/,
          'WITH CHECK must reject an UPDATE whose post-image leaves the caller\'s org scope'
        );
      } finally {
        await scoped.release();
      }

      assert.equal(
        await ownerOrgOf(pair.childId),
        OWNER_ORG,
        'the rejected UPDATE must not have changed owner_org_id'
      );

      await cleanupPair(pair);
    }
  );
});

// ---------------------------------------------------------------------------
// content.send_overrides — real-Postgres INSERT + UPDATE RLS parity (issue
// #561, mig 197). send_overrides carries no owner_org_id; migration 197 derives
// its INSERT (WITH CHECK) and UPDATE (USING + WITH CHECK) visibility through the
// parent draft's tenancy.visible(NULL, owner_org_id) predicate — the same GUC
// context POST /api/contracts/:id/send now opens for each write via
// withAgentScope (#561 handler change). These exercise the policy directly
// against real Postgres flipped to autobot_agent. Same env gating — SKIP under
// PGlite.
//
// Cleanup note: send_overrides is append-only — trg_send_overrides_immutable
// (sql/071) raises on EVERY delete, even from the owner `limited` role, and its
// parent draft cannot be deleted while an override FK-references it
// (send_overrides_draft_id_fkey has no ON DELETE action = RESTRICT). So tests
// that create an override row deliberately leave both it and its parent draft
// behind; unique per-test tags avoid collisions and leftover rows are harmless
// in the ephemeral test-postgres DB (same rationale as the #545 cleanup note
// above, L166-179). Only T2 — whose INSERT is rejected, leaving no override —
// can clean up its parent draft.
// ---------------------------------------------------------------------------

async function seedSendOverrideParent(org = OWNER_ORG) {
  const tag = `e2e-561-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const draft = await seedPool.query(
    `INSERT INTO content.drafts (content_type, status, title, body, owner_org_id)
     VALUES ('contract', 'approved', $1, 'override parent body', $2)
     RETURNING id`,
    [tag, org]
  );
  return draft.rows[0].id;
}

// request_id left NULL so the backfill UPDATE exercises the trigger's one
// allowed NULL → non-NULL transition. Owner-bypass INSERT (autobot_agent has no
// INSERT policy pre-197; the immutability trigger doesn't fire on INSERT).
async function seedOverrideRow(draftId) {
  const r = await seedPool.query(
    `INSERT INTO content.send_overrides (draft_id, overridden_by, override_reason, findings)
     VALUES ($1, 'test-harness', 'seeded for #561 e2e regression test', '[]'::jsonb)
     RETURNING id`,
    [draftId]
  );
  return r.rows[0].id;
}

async function requestIdOf(overrideId) {
  const r = await seedPool.query(
    `SELECT request_id FROM content.send_overrides WHERE id = $1`,
    [overrideId]
  );
  return r.rows[0]?.request_id ?? null;
}

async function overrideCountForDraft(draftId) {
  const r = await seedPool.query(
    `SELECT count(*)::int AS c FROM content.send_overrides WHERE draft_id = $1`,
    [draftId]
  );
  return r.rows[0].c;
}

describe('content.send_overrides — real-Postgres INSERT/UPDATE RLS parity (issue #561, mig 197)', () => {
  it(
    '[T1 positive INSERT] scoped matching org: the override-audit INSERT succeeds through the parent draft',
    { skip: !RLS_TEST_ENABLED },
    async () => {
      const draftId = await seedSendOverrideParent(OWNER_ORG);

      // Exactly the INSERT contracts.js runs, under the GUC context
      // withAgentScope opens for it. WITH CHECK passes because the parent draft
      // is tenancy-visible under OWNER_ORG.
      const scoped = await withAgentScope('e2e-561-insert-1', { orgIds: [OWNER_ORG] });
      let insertedId;
      try {
        const r = await scoped(
          `INSERT INTO content.send_overrides
             (draft_id, overridden_by, override_reason, findings)
           VALUES ($1, $2, $3, $4::jsonb)
           RETURNING id`,
          [draftId, 'e2e-561', 'block override reason exceeding ten chars', '[]']
        );
        insertedId = r.rows[0].id;
      } finally {
        await scoped.release();
      }

      assert.ok(insertedId, 'INSERT must return the new override id under a matching org context');
      assert.equal(
        await overrideCountForDraft(draftId),
        1,
        'exactly one override row must exist for the draft after the scoped INSERT'
      );
    }
  );

  it(
    '[T2 negative INSERT, non-tautological] mismatched org: the SAME INSERT is hard-denied by WITH CHECK',
    { skip: !RLS_TEST_ENABLED },
    async () => {
      const draftId = await seedSendOverrideParent(OWNER_ORG);

      // Same INSERT, wrong org in app.org_ids. The parent draft is not visible
      // under OTHER_ORG (neither the WITH CHECK's explicit tenancy.visible nor
      // the drafts subquery's own SELECT RLS), so WITH CHECK fails: a hard
      // 'new row violates row-level security policy' error — the 500 that would
      // break a cross-org send post-flip. T1 proves the same INSERT SUCCEEDS
      // under the right context, so this rejection is a genuine deny.
      const scoped = await withAgentScope('e2e-561-insert-2', { orgIds: [OTHER_ORG] });
      try {
        await assert.rejects(
          scoped(
            `INSERT INTO content.send_overrides
               (draft_id, overridden_by, override_reason, findings)
             VALUES ($1, $2, $3, $4::jsonb)
             RETURNING id`,
            [draftId, 'e2e-561', 'block override reason exceeding ten chars', '[]']
          ),
          /row-level security/,
          'WITH CHECK must reject an override INSERT whose parent draft is outside the caller\'s org'
        );
      } finally {
        await scoped.release();
      }

      assert.equal(
        await overrideCountForDraft(draftId),
        0,
        'no override row may be written for a draft the caller cannot see'
      );

      // No override row was created, so the parent draft is FK-free and can be
      // cleaned up (unlike T1/T3/T4, whose override rows pin their drafts).
      await seedPool.query(`DELETE FROM content.drafts WHERE id = $1`, [draftId]);
    }
  );

  it(
    '[T3 positive UPDATE] scoped matching org: the request_id backfill affects the row and stamps request_id',
    { skip: !RLS_TEST_ENABLED },
    async () => {
      const draftId = await seedSendOverrideParent(OWNER_ORG);
      const overrideId = await seedOverrideRow(draftId);
      assert.equal(await requestIdOf(overrideId), null, 'fixture: request_id must start NULL');

      // Exactly the backfill contracts.js runs, under the matching GUC context.
      // request_id is a soft reference (no cross-schema FK, D5), so a synthetic
      // uuid is a valid target; the immutability trigger permits this one
      // NULL → non-NULL transition.
      const REQ_ID = '99999999-9999-4999-8999-999999999999';
      const scoped = await withAgentScope('e2e-561-update-3', { orgIds: [OWNER_ORG] });
      let rowCount;
      try {
        const r = await scoped(
          `UPDATE content.send_overrides SET request_id = $1 WHERE id = $2`,
          [REQ_ID, overrideId]
        );
        rowCount = r.rowCount;
      } finally {
        await scoped.release();
      }

      assert.equal(rowCount, 1, 'backfill UPDATE must affect the row under a matching org context');
      assert.equal(
        await requestIdOf(overrideId),
        REQ_ID,
        'request_id must be stamped after the scoped backfill'
      );
    }
  );

  it(
    '[T4 negative UPDATE, non-tautological] mismatched org: the SAME backfill silently no-ops (0 rows)',
    { skip: !RLS_TEST_ENABLED },
    async () => {
      const draftId = await seedSendOverrideParent(OWNER_ORG);
      const overrideId = await seedOverrideRow(draftId);

      // Same backfill, wrong org. USING (draft-join tenancy.visible) filters the
      // row out, so it matches nothing: 0 rows, NO error, request_id stays NULL
      // forever — the exact silent-no-op #561 backfill bug post-flip. T3 proves
      // the same UPDATE DOES affect the row under the right context, so this 0
      // is a genuine deny, not "nothing matched anyway".
      const scoped = await withAgentScope('e2e-561-update-4', { orgIds: [OTHER_ORG] });
      let rowCount;
      try {
        const r = await scoped(
          `UPDATE content.send_overrides SET request_id = $1 WHERE id = $2`,
          ['88888888-8888-4888-8888-888888888888', overrideId]
        );
        rowCount = r.rowCount;
      } finally {
        await scoped.release();
      }

      assert.equal(rowCount, 0, 'backfill UPDATE must no-op under a non-matching org context');
      assert.equal(
        await requestIdOf(overrideId),
        null,
        'request_id must remain NULL — the predicate was not loosened'
      );
    }
  );
});
