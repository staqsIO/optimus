// migration-167-closure-metrics.test.js — OPT-52.
//
// Verifies the agent_graph.autonomous_closure_metrics materialized view (the
// headline governance metric) and its refresh function:
//
//   autonomous_closure_rate = closed loops with ZERO human-task touch / closed loops
//   cost_per_closed_loop     = SUM(state_transitions.cost_usd) / closed loops
//
// Definitions exercised here:
//   - closed loop  = a work_item at status='completed' (cancelled/open excluded)
//   - autonomous   = no LIVE human_task bridges to it via inbox.signals.work_item_id
//   - loop cost    = SUM(state_transitions.cost_usd) for that work_item
//
// TESTING MODEL NOTE: PGlite (getDb()) applies ALL migrations including 167, so
// the MV + refresh fn exist on a fresh DB. The MV is created WITH NO DATA and
// refreshed once at migration time, so we seed rows then call the refresh
// function before asserting.

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';

const ORG = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('migration-167: autonomous_closure_metrics materialized view', () => {
  let query;

  before(async () => {
    ({ query } = await getDb());

    // One email message so signals.message_id FK + channel CHECK are satisfied.
    await query(
      `INSERT INTO inbox.messages (id, thread_id, message_id, provider_msg_id, from_address, received_at)
       VALUES ('m167', 't167', 'gm167', 'pmid167', 'a@example.com', now())`,
    );

    // Three completed loops (A, B, C) + one cancelled (D, must be excluded).
    await query(
      `INSERT INTO agent_graph.work_items (id, type, title, status, created_by, owner_org_id) VALUES
         ('wi167A', 'task', 'A', 'completed', 'tester', $1),
         ('wi167B', 'task', 'B', 'completed', 'tester', $1),
         ('wi167C', 'task', 'C', 'completed', 'tester', $1),
         ('wi167D', 'task', 'D', 'cancelled', 'tester', $1)`,
      [ORG],
    );

    // Costs: A=0.25, B=0.75, C=1.00 (completed); D=9.99 (cancelled → excluded).
    await query(
      `INSERT INTO agent_graph.state_transitions
         (work_item_id, from_state, to_state, agent_id, config_hash, cost_usd) VALUES
         ('wi167A', 'in_progress', 'completed', 'ag', 'h', 0.25),
         ('wi167B', 'in_progress', 'completed', 'ag', 'h', 0.75),
         ('wi167C', 'in_progress', 'completed', 'ag', 'h', 1.00),
         ('wi167D', 'in_progress', 'cancelled', 'ag', 'h', 9.99)`,
    );

    // B is human-touched: a live human_task's signal bridges to wi167B.
    await query(
      `INSERT INTO inbox.signals (id, message_id, signal_type, content, confidence, work_item_id, owner_org_id)
       VALUES ('sig167', 'm167', 'action_item', 'follow up', 0.9, 'wi167B', $1)`,
      [ORG],
    );
    await query(
      `INSERT INTO inbox.human_tasks (id, title, signal_id, owner_org_id)
       VALUES ('ht167', 'do the thing', 'sig167', $1)`,
      [ORG],
    );

    await query('SELECT agent_graph.refresh_autonomous_closure_metrics()');
  });

  it('counts only completed work_items as closed loops', async () => {
    const { rows } = await query(
      `SELECT closed_loops FROM agent_graph.autonomous_closure_metrics WHERE owner_org_id = $1`,
      [ORG],
    );
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].closed_loops), 3); // A, B, C — not the cancelled D
  });

  it('treats a loop with a live bridged human_task as NOT autonomous', async () => {
    const { rows } = await query(
      `SELECT autonomous_loops, human_touched_loops, autonomous_closure_rate
         FROM agent_graph.autonomous_closure_metrics WHERE owner_org_id = $1`,
      [ORG],
    );
    assert.equal(Number(rows[0].autonomous_loops), 2);     // A, C
    assert.equal(Number(rows[0].human_touched_loops), 1);  // B
    assert.equal(Number(rows[0].autonomous_closure_rate), 0.6667);
  });

  it('computes cost_per_closed_loop from completed-loop costs only', async () => {
    const { rows } = await query(
      `SELECT total_loop_cost_usd, cost_per_closed_loop
         FROM agent_graph.autonomous_closure_metrics WHERE owner_org_id = $1`,
      [ORG],
    );
    // 0.25 + 0.75 + 1.00 = 2.00 ; D's 9.99 is excluded (not a closed loop).
    assert.equal(Number(rows[0].total_loop_cost_usd), 2.0);
    assert.equal(Number(rows[0].cost_per_closed_loop), 0.666667); // 2.00 / 3
  });

  it('excludes soft-deleted human_tasks from the human-touch predicate', async () => {
    await query(`UPDATE inbox.human_tasks SET deleted_at = now() WHERE id = 'ht167'`);
    await query('SELECT agent_graph.refresh_autonomous_closure_metrics()');
    const { rows } = await query(
      `SELECT autonomous_loops, autonomous_closure_rate
         FROM agent_graph.autonomous_closure_metrics WHERE owner_org_id = $1`,
      [ORG],
    );
    assert.equal(Number(rows[0].autonomous_loops), 3);          // B now counts as autonomous
    assert.equal(Number(rows[0].autonomous_closure_rate), 1.0); // all 3 autonomous
    // restore for isolation if the suite shares the DB
    await query(`UPDATE inbox.human_tasks SET deleted_at = NULL WHERE id = 'ht167'`);
    await query('SELECT agent_graph.refresh_autonomous_closure_metrics()');
  });
});
