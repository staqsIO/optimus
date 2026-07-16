import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { getDb } from './helpers/setup-db.js';
import { Reaper } from '../../lib/runtime/state/reaper.js';

/**
 * Phase 2.2 — dead-runner reclaim. A runner can die mid-iteration having just
 * bumped updated_at, so the 5-min updated_at timeout is too slow. The reaper now
 * also reclaims in_progress items whose assigned agent's LATEST heartbeat is
 * stale — but ONLY if the agent has a heartbeat history (MAX IS NULL → excluded),
 * so a fresh system never mass-reclaims.
 */
describe('reaper — dead-runner reclaim', () => {
  let query;
  const AGENT = 'executor-coder'; // exists in agent_configs (FK target)
  const PFX = 'reaper-dr-';

  before(async () => { ({ query } = await getDb()); });

  beforeEach(async () => {
    await query(`DELETE FROM agent_graph.work_items WHERE id LIKE $1`, [`${PFX}%`]);
    await query(`DELETE FROM agent_graph.agent_heartbeats WHERE agent_id = $1`, [AGENT]);
  });

  async function seedInProgress(id, updatedAgoSec) {
    await query(
      `INSERT INTO agent_graph.work_items (id, type, title, status, created_by, assigned_to, updated_at)
       VALUES ($1,'task','t','in_progress','orchestrator',$2, now() - ($3 || ' seconds')::interval)`,
      [id, AGENT, String(updatedAgoSec)]
    );
  }
  async function seedHeartbeat(agoSec) {
    await query(
      `INSERT INTO agent_graph.agent_heartbeats (agent_id, runner_id, heartbeat_at, status)
       VALUES ($1,'r1', now() - ($2 || ' seconds')::interval, 'processing')`,
      [AGENT, String(agoSec)]
    );
  }
  const statusOf = async (id) => (await query(`SELECT status FROM agent_graph.work_items WHERE id=$1`, [id])).rows[0]?.status;

  it('reclaims an in_progress item with recent updated_at but a STALE heartbeat', async () => {
    const id = `${PFX}dead`;
    await seedInProgress(id, 90);   // 90s: well under the 5-min updated_at timeout
    await seedHeartbeat(5 * 60);    // 5 min: older than the 4-min claim TTL → runner dead
    await new Reaper().sweep();
    assert.notEqual(await statusOf(id), 'in_progress', 'stale-heartbeat item must be reclaimed');
  });

  it('does NOT reclaim when the heartbeat is fresh', async () => {
    const id = `${PFX}alive`;
    await seedInProgress(id, 90);
    await seedHeartbeat(10);         // 10s: alive
    await new Reaper().sweep();
    assert.equal(await statusOf(id), 'in_progress', 'fresh-heartbeat item must be left alone');
  });

  it('does NOT mass-reclaim when the agent has NO heartbeat history', async () => {
    const id = `${PFX}nohb`;
    await seedInProgress(id, 90);    // no heartbeat row at all → MAX IS NULL → excluded
    await new Reaper().sweep();
    assert.equal(await statusOf(id), 'in_progress', 'no-history agent must fall through to the 5-min timeout, not reclaim');
  });
});
