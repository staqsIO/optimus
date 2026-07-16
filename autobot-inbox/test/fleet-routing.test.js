import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { getDb } from './helpers/setup-db.js';
import { Reaper } from '../../lib/runtime/state/reaper.js';

/**
 * Phase 3 (fleet) — runner-aware claim + dead-runner un-route.
 *   - A task event routed to a runner is claimable only by that runner;
 *     unrouted ('NULL') events are claimable by anyone.
 *   - The reaper resets target_runner_id on events pinned to a dead runner so
 *     the work isn't orphaned.
 */
describe('fleet routing — claim_next_task(p_runner_id)', () => {
  let query;
  const AGENT = 'executor-coder';
  const WI = 'fleet-wi-1';

  before(async () => {
    ({ query } = await getDb());
    await query(`DELETE FROM agent_graph.work_items WHERE id=$1`, [WI]);
    await query(
      `INSERT INTO agent_graph.work_items (id, type, title, status, created_by, assigned_to)
       VALUES ($1,'task','t','assigned','orchestrator',$2)`,
      [WI, AGENT]
    );
  });

  async function seedEvent(runnerId) {
    await query(`DELETE FROM agent_graph.task_events WHERE work_item_id=$1`, [WI]);
    await query(
      `INSERT INTO agent_graph.task_events (event_type, work_item_id, target_agent_id, target_runner_id)
       VALUES ('task_assigned', $1, $2, $3)`,
      [WI, AGENT, runnerId]
    );
  }
  const claim = async (runnerId) =>
    (await query(`SELECT * FROM agent_graph.claim_next_task($1, $2)`, [AGENT, runnerId])).rows[0] || null;

  it('event routed to r1 is claimable by r1', async () => {
    await seedEvent('r1');
    assert.ok(await claim('r1'), 'r1 should claim its own routed event');
  });

  it('event routed to r1 is NOT claimable by r2', async () => {
    await seedEvent('r1');
    assert.equal(await claim('r2'), null, 'r2 must not steal r1-routed work');
  });

  it('event routed to r1 is NOT claimable by an unidentified caller (NULL runner)', async () => {
    await seedEvent('r1');
    assert.equal(await claim(null), null);
  });

  it('unrouted (NULL) event is claimable by any runner', async () => {
    await seedEvent(null);
    assert.ok(await claim('any-runner'), 'unrouted work claimable by anyone');
  });

  it('legacy 1-arg claim still resolves (defaulted runner) and claims unrouted work', async () => {
    await seedEvent(null);
    const r = await query(`SELECT * FROM agent_graph.claim_next_task($1)`, [AGENT]);
    assert.ok(r.rows[0], 'claim_next_task($1) must still work via the defaulted param');
  });
});

describe('fleet routing — reaper un-routes a dead runner', () => {
  let query;
  const AGENT = 'executor-coder';
  const WI = 'fleet-dead-wi';

  before(async () => {
    ({ query } = await getDb());
    await query(`DELETE FROM agent_graph.work_items WHERE id=$1`, [WI]);
    await query(
      `INSERT INTO agent_graph.work_items (id, type, title, status, created_by, assigned_to)
       VALUES ($1,'task','t','assigned','orchestrator',$2)`,
      [WI, AGENT]
    );
  });
  beforeEach(async () => {
    await query(`DELETE FROM agent_graph.task_events WHERE work_item_id=$1`, [WI]);
    await query(`DELETE FROM agent_graph.agent_heartbeats WHERE runner_id IN ('deadbox','livebox')`);
  });

  async function seedRoutedEvent(runnerId) {
    await query(
      `INSERT INTO agent_graph.task_events (event_type, work_item_id, target_agent_id, target_runner_id)
       VALUES ('task_assigned', $1, $2, $3)`,
      [WI, AGENT, runnerId]
    );
  }
  async function seedRunnerHeartbeat(runnerId, agoSec) {
    await query(
      `INSERT INTO agent_graph.agent_heartbeats (agent_id, runner_id, heartbeat_at, status)
       VALUES ($1, $2, now() - ($3 || ' seconds')::interval, 'processing')`,
      [AGENT, runnerId, String(agoSec)]
    );
  }
  const targetRunnerOf = async () =>
    (await query(`SELECT target_runner_id FROM agent_graph.task_events WHERE work_item_id=$1`, [WI])).rows[0]?.target_runner_id;

  it('resets target_runner_id when the target runner heartbeat is stale', async () => {
    await seedRoutedEvent('deadbox');
    await seedRunnerHeartbeat('deadbox', 5 * 60); // 5 min stale → dead
    await new Reaper().sweep();
    assert.equal(await targetRunnerOf(), null, 'dead-runner-pinned event must be un-routed');
  });

  it('leaves target_runner_id alone when the runner is alive', async () => {
    await seedRoutedEvent('livebox');
    await seedRunnerHeartbeat('livebox', 10); // fresh
    await new Reaper().sweep();
    assert.equal(await targetRunnerOf(), 'livebox', 'live-runner work stays routed');
  });
});
