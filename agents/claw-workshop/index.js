/**
 * Claw Workshop Agent
 *
 * Full-workflow engineering agent: picks up Linear issues labeled "workshop",
 * spawns a single continuous Claude Code session that follows a playbook
 * (plan -> implement -> test -> self-review -> PR).
 *
 * Pattern: cloned from claw-campaigner/index.js but single-pass (no iteration loop).
 * Reuses campaign infrastructure (budget envelopes, campaign_iterations, workspace lifecycle).
 *
 * Governance: G1 (budget), G5 (PR only, never auto-merge).
 * Cannot merge PRs, send external comms, or modify governance config.
 */

import { createHash } from 'crypto';
import { query, withTransaction, setAgentContext, isCircuitOpen } from '../../lib/db.js';
import { subscribe } from '../../lib/runtime/event-bus.js';
import { loadMergedConfig } from '../../lib/runtime/config-loader.js';
import { runWorkshop } from './workshop-runner.js';
import { createChildLogger } from '../../lib/logger.js';

const log = createChildLogger({ agent: 'workshop' });

let config = null;
let modelsConfig = null;
let configHash = null;
let pollTimer = null;
let running = false;
let _lastHeartbeatAt = null;
const activeWorkshops = new Map(); // campaignId -> AbortController

function writeHeartbeat(status, force = false) {
  const now = Date.now();
  if (!force && _lastHeartbeatAt && now - _lastHeartbeatAt < 10_000) return;
  if (isCircuitOpen()) return;
  _lastHeartbeatAt = now;
  query(
    `INSERT INTO agent_graph.agent_heartbeats (agent_id, heartbeat_at, status, pid)
     VALUES ($1, now(), $2, $3)
     ON CONFLICT (agent_id) DO UPDATE
       SET heartbeat_at = now(), status = $2, pid = $3`,
    ['claw-workshop', status, process.pid]
  ).catch(() => {});
}

async function loadConfig() {
  const raw = await loadMergedConfig();
  config = raw.agents['claw-workshop'];
  modelsConfig = raw.models;
  configHash = createHash('sha256')
    .update(JSON.stringify(config))
    .digest('hex')
    .slice(0, 16);
  return config;
}

/**
 * Claim the next approved workshop campaign using SKIP LOCKED.
 * Returns the campaign row or null.
 */
async function claimNextWorkshop() {
  return withTransaction(async (client) => {
    await setAgentContext(client, 'claw-workshop');

    const result = await client.query(
      `SELECT c.id, c.work_item_id, c.goal_description, c.metadata
       FROM agent_graph.campaigns c
       JOIN agent_graph.work_items w ON w.id = c.work_item_id
       WHERE c.campaign_mode = 'workshop'
         AND c.campaign_status = 'approved'
         AND w.status IN ('created', 'assigned')
       ORDER BY w.priority DESC, c.created_at
       FOR UPDATE OF c SKIP LOCKED
       LIMIT 1`
    );

    if (result.rows.length === 0) return null;

    const campaign = result.rows[0];

    // Transition campaign to running
    await client.query(
      `UPDATE agent_graph.campaigns SET campaign_status = 'running', started_at = now(), updated_at = now() WHERE id = $1`,
      [campaign.id]
    );

    // Transition work_item to in_progress
    await client.query(
      `UPDATE agent_graph.work_items SET status = 'in_progress', assigned_to = 'claw-workshop', updated_at = now() WHERE id = $1`,
      [campaign.work_item_id]
    );

    return campaign;
  });
}

/**
 * Poll for approved workshop campaigns and start running them.
 */
async function poll() {
  if (!config?.enabled) return;
  if (isCircuitOpen()) return; // DB unhealthy — skip this poll cycle

  writeHeartbeat(activeWorkshops.size > 0 ? 'processing' : 'idle');

  const maxConcurrent = config.workshop?.maxConcurrentWorkshops || 2;
  if (activeWorkshops.size >= maxConcurrent) return;

  try {
    const campaign = await claimNextWorkshop();
    if (!campaign) return;

    log.info(` Claimed workshop: ${campaign.id} — "${campaign.goal_description?.slice(0, 60)}..."`);

    const controller = new AbortController();
    activeWorkshops.set(campaign.id, controller);

    // Run workshop (non-blocking) — single-pass, not an iteration loop
    runWorkshop(campaign.id, { ...config, configHash }, modelsConfig, controller.signal)
      .catch(err => {
        log.error(` Workshop ${campaign.id} fatal error:`, err.message);
      })
      .finally(() => {
        activeWorkshops.delete(campaign.id);
        log.info(` Workshop ${campaign.id} finished. Active: ${activeWorkshops.size}`);
      });

  } catch (err) {
    log.error(' Poll error:', err.message);
  }
}

/**
 * Workshop agent — compatible with runner.js pattern.
 */
export const workshopLoop = {
  agentId: 'claw-workshop',

  async start() {
    if (running) return;
    running = true;

    await loadConfig();
    if (!config?.enabled) {
      log.info(' Disabled in agents.json — skipping');
      running = false;
      return;
    }

    // Sync config hash to DB
    query(
      `UPDATE agent_graph.agent_configs SET config_hash = $1, updated_at = now() WHERE id = $2`,
      [configHash, 'claw-workshop']
    ).catch(err => log.warn(` Config hash sync failed:`, err.message));

    const pollInterval = config.workshop?.pollIntervalMs || 15_000;
    log.info(` Starting (${pollInterval / 1000}s poll, hash: ${configHash})`);

    // Subscribe to campaign approval events for instant wake-up
    subscribe('campaign_approved', () => {
      if (running) poll();
    });

    // Initial heartbeat + poll after 5s, then on interval
    writeHeartbeat('idle', true);
    setTimeout(() => {
      poll();
      pollTimer = setInterval(poll, pollInterval);
    }, 5000);

    return Promise.resolve();
  },

  stop() {
    running = false;
    writeHeartbeat('stopped', true);
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }

    for (const [id, controller] of activeWorkshops) {
      log.info(` Aborting workshop ${id}`);
      controller.abort();
    }
    activeWorkshops.clear();

    log.info(' Stopped');
  },
};
