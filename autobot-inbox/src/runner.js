import 'dotenv/config';
import { hostname } from 'os';
import { randomBytes } from 'crypto';
import { initializeDatabase, close } from './db.js';
import { startCommandPoller } from './runtime/command-poller.js';
import { initializeJwtKeys } from './runtime/agent-jwt.js';
import { assertModelArmorProductionReady } from '../../lib/runtime/governance/model-armor-preflight.js';
import { assertRequiredEnvReady } from '../../lib/runtime/governance/required-env-preflight.js';
import { runnerRequiresModelArmorPreflight } from './runtime/runner-model-armor-scope.js';
import { beginDrain, drainTimeoutMs } from '../../lib/runtime/lifecycle.js';
import * as pgListener from '../../lib/runtime/pg-listener.js';
import { initializeBoardJwtKeys } from './runtime/board-jwt.js';
import { initPgNotify, unsubscribeAll } from './runtime/event-bus.js';
import { stopGraphSync } from './graph/sync.js';
import { stopPatternListener } from './graph/pattern-extractor.js';
import { syncConfigHashes, ensureDailyBudget, releaseStaleReservations, logDeployEvent } from './runtime/startup.js';
import { coderLoop } from './agents/executor-coder.js';
import { researchLoop } from './agents/executor-research.js';
import { campaignerLoop } from './agents/claw-campaigner/index.js';
import { workshopLoop } from './agents/claw-workshop/index.js';
import { redesignLoop } from './agents/executor-redesign.js';
import { blueprintLoop } from './agents/executor-blueprint.js';
import { triageLoop } from './agents/issue-triage/index.js';
import { writerLoop } from '../../agents/executor-writer/index.js';
import { atomizerLoop } from '../../agents/content-atomizer/index.js';
import { contractLoop } from '../../agents/executor-contract/index.js';

/**
 * Optimus Runner: lightweight task worker for remote machines.
 *
 * Connects to the shared Postgres database and runs only the executor-coder
 * agent (or a configurable subset). Skips Gmail, Slack, Telegram, Drive,
 * API server, and all periodic services.
 *
 * Multiple runners can operate simultaneously — task claiming uses
 * SELECT ... FOR UPDATE SKIP LOCKED. Cross-process wake-up via pg_notify.
 *
 * Usage:
 *   npm run runner                         # default: executor-coder only
 *   node src/runner.js --agents executor-coder,executor-ticket
 *   RUNNER_ID=mac-m1 npm run runner        # human-friendly name
 */

// All agents that can run in runner mode
const RUNNER_AGENTS = {
  'executor-coder': coderLoop,
  'executor-redesign': redesignLoop,
  'executor-blueprint': blueprintLoop,
  'executor-research': researchLoop,
  'claw-campaigner': campaignerLoop,
  'claw-workshop': workshopLoop,
  'issue-triage': triageLoop,
  'executor-writer': writerLoop,
  'content-atomizer': atomizerLoop,
  'executor-contract': contractLoop,
};

function parseArgs() {
  const agentsArg = process.argv.find(a => a.startsWith('--agents='));
  const agentNames = agentsArg
    ? agentsArg.split('=')[1].split(',').map(s => s.trim())
    : ['executor-coder', 'claw-campaigner'];

  const invalid = agentNames.filter(n => !RUNNER_AGENTS[n]);
  if (invalid.length > 0) {
    console.error(`Unknown runner agent(s): ${invalid.join(', ')}`);
    console.error(`Available: ${Object.keys(RUNNER_AGENTS).join(', ')}`);
    process.exit(1);
  }

  return agentNames;
}

function generateRunnerId() {
  if (process.env.RUNNER_ID) return process.env.RUNNER_ID;
  const host = hostname().split('.')[0].toLowerCase();
  const suffix = randomBytes(3).toString('hex');
  return `${host}-${process.pid}-${suffix}`;
}

async function main() {
  // Prevent unhandled pg Client errors from crashing the process.
  // EADDRNOTAVAIL happens when macOS sleeps or Docker networking hiccups.
  process.on('uncaughtException', (err) => {
    if (err.code === 'EADDRNOTAVAIL' || err.code === 'ECONNRESET' || err.code === 'EPIPE') {
      console.error(`[runner] Connection error (${err.code}): ${err.message} — will recover`);
      return; // pg pool will create new connections on next query
    }
    console.error('[runner] Uncaught exception:', err);
    process.exit(1);
  });

  // Validate: DATABASE_URL is mandatory for runners (no PGlite)
  if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL is required for runner mode.');
    console.error('The runner connects to the shared Optimus Postgres database.');
    console.error('Copy .env.runner.example to .env and configure DATABASE_URL.');
    process.exit(1);
  }

  const agentNames = parseArgs();

  // Required-env preflight (Plan 030 / #474): in production, refuse to boot when
  // a boot-critical key (LLM provider) is missing; warn (never hard-fail) in
  // dev/test. DATABASE_URL is already enforced above. The runner never runs in
  // demo mode. Values are never logged.
  try {
    assertRequiredEnvReady({ demoMode: false });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  // G8 production preflight (P1/P2): a runner exists to run agent loops, but only
  // SOME of them ingest attacker-controllable external content into an LLM
  // (issue-triage: GitHub/Linear issue text; claw-workshop: Linear comments +
  // Bash/Write/WebFetch tools) — see runnerRequiresModelArmorPreflight()
  // (runtime/runner-model-armor-scope.js) for the full scoping rationale and which
  // agents are in/out. `agentNames.length > 0` was NOT a valid proxy for this:
  // parseArgs() defaults to a non-empty agent list, so that check was always true
  // and would demand Model Armor be armed on the M1 runner even for agents
  // (coder/redesign/blueprint/campaigner/etc.) that never touch untrusted content
  // (GH #495). Scoped correctly here: fail-fast BEFORE connecting the DB or starting
  // any loop, but only when a requested agent actually needs it. No-op in dev/test
  // regardless (see assertModelArmorProductionReady).
  //
  // Disclosure: this preflight is presence-only — it checks that
  // MODEL_ARMOR_MODE=block and MODEL_ARMOR_TEMPLATE are SET, not that the template
  // is valid or that Model Armor actually blocks at runtime. "Preflight passed" !=
  // "G8 verified working"; runtime fail-closed validity is deferred to OPT-106.
  // NOTE: it also does NOT screen the content — the issue-triage/claw-workshop paths
  // have no inline sanitize/screen call at all (separate, more serious pre-existing
  // gap tracked as GH #541); this only guarantees the screening config exists.
  assertModelArmorProductionReady({ agentsEnabled: runnerRequiresModelArmorPreflight(agentNames) });

  const runnerId = generateRunnerId();

  console.log('Optimus Runner');
  console.log('==============');
  console.log(`Runner ID:  ${runnerId}`);
  console.log(`Hostname:   ${hostname()}`);
  console.log(`Platform:   ${process.platform}`);
  console.log(`Agents:     ${agentNames.join(', ')}`);
  console.log(`Node:       ${process.version}`);
  console.log();

  // Initialize database connection
  try {
    await initializeDatabase();
  } catch (err) {
    console.error(`Database connection failed: ${err.message}`);
    console.error('Check DATABASE_URL and ensure the Postgres server is reachable.');
    process.exit(1);
  }

  // Shared startup sequence (same as index.js)
  await syncConfigHashes();
  await initializeJwtKeys();
  await initializeBoardJwtKeys();
  await ensureDailyBudget();
  await releaseStaleReservations();

  // Phase 1 (DB connection-exhaustion fix): start the single shared LISTEN
  // client BEFORE initPgNotify() registers the autobot_events handler on it.
  await pgListener.start();

  // Enable cross-process task wake-up via pg_notify
  await initPgNotify();

  // Log deploy event with runner identity
  await logDeployEvent({
    runner_id: runnerId,
    hostname: hostname(),
    platform: process.platform,
    mode: 'runner',
  });

  // Start selected agents (pass runnerId to agents that support it)
  const agents = agentNames.map(name => RUNNER_AGENTS[name]);
  for (const agent of agents) {
    agent.start({ runnerId }).catch(err => {
      console.error(`[${agent.agentId}] Fatal error:`, err.message);
    });
  }

  console.log(`\n[runner] Online — polling for tasks (${agentNames.join(', ')})\n`);

  // ── Status ticker: periodic heartbeat so operators know the runner is alive ──
  const statusState = { lastError: null, errorCount: 0, suppressedCount: 0 };
  const STATUS_INTERVAL_MS = 60_000; // 1 minute

  setInterval(() => {
    const uptime = Math.floor(process.uptime());
    const mins = Math.floor(uptime / 60);
    const hrs = Math.floor(mins / 60);
    const uptimeStr = hrs > 0 ? `${hrs}h${mins % 60}m` : `${mins}m`;
    const mem = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);

    // Count active campaigns across all agent loops
    const campaigner = RUNNER_AGENTS['claw-campaigner'];
    const activeCampaignCount = campaigner?._getActiveCampaignCount?.() ?? 0;

    const status = activeCampaignCount > 0
      ? `\x1b[32m● processing\x1b[0m (${activeCampaignCount} campaign${activeCampaignCount > 1 ? 's' : ''})`
      : '\x1b[36m○ idle\x1b[0m — waiting for approved campaigns';

    console.log(`[runner] ${status} | uptime ${uptimeStr} | ${mem}MB heap | ${agentNames.join(', ')}`);

    if (statusState.suppressedCount > 0) {
      console.log(`[runner] (${statusState.suppressedCount} repeated error${statusState.suppressedCount > 1 ? 's' : ''} suppressed since last status)`);
      statusState.suppressedCount = 0;
    }
  }, STATUS_INTERVAL_MS);

  // Command poller (STAQPRO-290 Phase 2): drains runner_commands and acts on
  // restart requests issued from /runners. See lib/runtime/command-poller.js.
  startCommandPoller(runnerId, agents);

  // Telegram fanout for retry-exhausted failures (sql/087-needs-attention-trigger.sql).
  // Suppresses repeats: one DM per (signature, agent_id) per 30 min. Threshold:
  // first DM fires at count >= 3 to avoid noise on transient single failures.
  const TELEGRAM_DM_WINDOW_MS = 30 * 60 * 1000;
  const TELEGRAM_DM_THRESHOLD = 3;
  const lastDmAt = new Map();  // key: `${signature}|${agent_id}` -> ms timestamp
  const clusterCount = new Map();  // key: `${signature}|${agent_id}` -> count

  // Listen for config changes via pg_notify — enables dashboard toggle without restart
  const { onAnyEvent } = await import('./runtime/event-bus.js');
  onAnyEvent(async (event) => {
    if (event?.event_type === 'needs_attention' || event?.eventType === 'needs_attention') {
      try {
        const sig = event.reason_signature;
        const agentId = event.agent_id || 'unknown';
        if (!sig) return;
        const key = `${sig}|${agentId}`;
        const count = (clusterCount.get(key) || 0) + 1;
        clusterCount.set(key, count);

        if (count < TELEGRAM_DM_THRESHOLD) return;
        const last = lastDmAt.get(key) || 0;
        if (Date.now() - last < TELEGRAM_DM_WINDOW_MS) return;
        lastDmAt.set(key, Date.now());
        // Reset count after sending so the next DM requires another threshold cluster
        clusterCount.set(key, 0);

        const { notifyBoard } = await import('./telegram/sender.js');
        const text = [
          '⚠️ Retry-exhausted failure cluster',
          `agent: ${agentId}`,
          `signature: ${sig}`,
          `count: ${count} in last 30m`,
          `sample: ${event.work_item_id || '(none)'}`,
          `state: ${event.to_state || 'failed'}`,
          'board.staqs.io/activity',
        ].join('\n');
        await notifyBoard(text);
      } catch (err) {
        console.warn(`[runner] needs_attention DM failed: ${err.message}`);
      }
      return;
    }

    if (event?.type === 'agent_config_changed') {
      console.log('[runner] Agent config changed — checking for enable/disable updates');
      try {
        const { getConfig } = await import('../../lib/config/loader.js');
        const config = getConfig('agents');
        for (const name of Object.keys(RUNNER_AGENTS)) {
          const agentConfig = config.agents[name];
          const loop = RUNNER_AGENTS[name];
          if (!agentConfig) continue;
          const shouldRun = agentConfig.enabled !== false;
          const isRunning = agents.includes(loop);
          if (shouldRun && !isRunning) {
            console.log(`[runner] Starting ${name} (enabled via dashboard)`);
            loop.start().catch(err => console.error(`[${name}] Start error:`, err.message));
            agents.push(loop);
          } else if (!shouldRun && isRunning) {
            console.log(`[runner] Stopping ${name} (disabled via dashboard)`);
            loop.stop();
            agents.splice(agents.indexOf(loop), 1);
          }
        }
      } catch (err) {
        console.warn(`[runner] Config reload failed: ${err.message}`);
      }
    }
  });

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} received. Shutting down runner ${runnerId}...`);

    // Drain: campaign loops abort their in-flight iteration and pause+checkpoint
    // at the next boundary. Hard ceiling forces exit if drain hangs, so launchd
    // KeepAlive can restart cleanly.
    beginDrain();
    setTimeout(() => {
      console.error(`[shutdown] runner ${runnerId} drain exceeded ${drainTimeoutMs()}ms — forcing exit`);
      process.exit(1);
    }, drainTimeoutMs()).unref();

    for (const agent of agents) {
      agent.stop();
    }
    unsubscribeAll();

    // Detach the graph-sync + pattern-extractor handlers BEFORE the drain wait,
    // matching index.js's shutdown sequence. Both are idempotent no-ops when the
    // subscriber was never started (the runner only starts event-bus today), but
    // calling them defends against the pattern-extractor debounce firing
    // extractPatterns() against a draining DB if a future change registers them.
    stopPatternListener();
    stopGraphSync();

    await new Promise(resolve => setTimeout(resolve, 2000));
    // Phase 1: stop the shared LISTEN client before ending the pool.
    await pgListener.stop();
    await close();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
