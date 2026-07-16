import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Linus BLOCKER (PR #488, Plan 013/016): reaper.reclaimOrphanedBudget() reset
 * reserved_usd on EVERY daily budget row using a single global flat rate
 * (in_progress count x $0.01) with no account_id predicate. Per-account rows
 * carry real, per-task reservations; clobbering them zeroes a live reservation
 * and opens an overspend window against budgets_no_overspend:
 *
 *   account allocated=$10; Task A reserves $5 (reserved_usd=$5);
 *   reaper sweeps -> resets reserved_usd to ~$0.00 (0 in-progress);
 *   Task B's reserve check (spent 0 + reserved ~0 + $9.90 <= $10) now passes;
 *   both commit -> spent=$14.90 > allocated=$10 -> CHECK breach.
 *
 * The mitigation restricts the reclaim UPDATE to the GLOBAL row (account_id IS
 * NULL). This test pins that a per-account reserved_usd SURVIVES a sweep. It
 * FAILS against the pre-mitigation query (which would zero the per-account row).
 *
 * Per-account orphan reclaim stays deferred to the schema-column board decision
 * (Plan 016) — over-conservative here (never overspend), never the reverse.
 */
describe('Reaper reclaimOrphanedBudget account scope (PR #488 Linus BLOCKER)', () => {
  let queryFn;
  let Reaper;
  const RUN = `488-${Date.now()}`;
  const ACCOUNT_ID = `acct-${RUN}`;

  before(async () => {
    delete process.env.DATABASE_URL;
    process.env.NODE_ENV = 'test';
    process.env.SQL_DIR = new URL('../sql', import.meta.url).pathname;
    process.env.PGLITE_DATA_DIR = new URL('../data/pglite-reaper-budget', import.meta.url).pathname;
    const db = await import('../src/db.js');
    queryFn = db.query;
    await db.initializeDatabase();
    ({ Reaper } = await import('../../lib/runtime/reaper.js'));
  });

  async function insertBudget({ id, accountId, allocated, reserved }) {
    await queryFn(
      `INSERT INTO agent_graph.budgets
         (id, scope, scope_id, allocated_usd, spent_usd, reserved_usd,
          period_start, period_end, account_id)
       VALUES ($1, 'daily', $2, $3, 0, $4, CURRENT_DATE, CURRENT_DATE, $5)
       ON CONFLICT (id) DO UPDATE SET
         allocated_usd = EXCLUDED.allocated_usd,
         reserved_usd  = EXCLUDED.reserved_usd,
         updated_at    = now()`,
      [id, id, allocated, reserved, accountId],
    );
  }

  async function reservedFor(id) {
    const r = await queryFn(
      `SELECT reserved_usd FROM agent_graph.budgets WHERE id = $1`,
      [id],
    );
    return parseFloat(r.rows[0].reserved_usd);
  }

  it('leaves a per-account reserved_usd untouched by a reclaim sweep (closes the overspend window)', async () => {
    const perAccountId = `budget-acct-${RUN}`;
    const globalId = `budget-global-${RUN}`;

    // Per-account daily row: Task A holds a real $5 reservation against $10.
    await insertBudget({ id: perAccountId, accountId: ACCOUNT_ID, allocated: 10, reserved: 5 });
    // Global daily row (account_id IS NULL): eligible for the flat-rate reclaim.
    await insertBudget({ id: globalId, accountId: null, allocated: 100, reserved: 5 });

    const reaper = new Reaper();
    await reaper.reclaimOrphanedBudget();

    // The per-account live reservation MUST survive — pre-mitigation this was
    // clobbered to ~0, letting Task B pass its reserve check and overspend.
    assert.equal(
      await reservedFor(perAccountId),
      5,
      'per-account reserved_usd must survive the reclaim sweep (no overspend window)',
    );

    // Sanity: the reaper still operates on the global row (no in-progress work
    // items in this hermetic run -> flat rate collapses to 0), proving the
    // predicate narrowed scope rather than disabling the sweep entirely.
    assert.equal(
      await reservedFor(globalId),
      0,
      'global reserved_usd is still reclaimed (in_progress count 0 -> 0)',
    );
  });
});
