import 'dotenv/config';
import { hostname } from 'os';
import { createHash } from 'crypto';
import { initializeDatabase, close, query } from './db.js';
import { startCommandPoller } from './runtime/command-poller.js';
import { orchestratorLoop, startPolling } from './agents/orchestrator.js';

import { strategistLoop } from './agents/strategist.js';
import { intakeLoop } from './agents/executor-intake.js';
import { triageLoop } from './agents/executor-triage.js';
import { responderLoop } from './agents/executor-responder.js';
import { reviewerLoop } from './agents/reviewer.js';
import { architectLoop } from './agents/architect.js';
import { ticketLoop } from './agents/executor-ticket.js';
import { coderLoop } from './agents/executor-coder.js';
import { researchLoop } from './agents/executor-research.js';
import { redesignLoop } from './agents/executor-redesign.js';
import { blueprintLoop } from './agents/executor-blueprint.js';
import { workshopLoop } from './agents/claw-workshop/index.js';
import { writerLoop } from '../../agents/executor-writer/index.js';
import { atomizerLoop } from '../../agents/content-atomizer/index.js';
import { contractLoop } from '../../agents/executor-contract/index.js';
import { testerLoop } from '../../agents/tester/index.js';
import { assertModelArmorProductionReady } from '../../lib/runtime/governance/model-armor-preflight.js';
import { assertRequiredEnvReady } from '../../lib/runtime/governance/required-env-preflight.js';
import { beginDrain, drainTimeoutMs } from '../../lib/runtime/lifecycle.js';
import * as pgListener from '../../lib/runtime/pg-listener.js';
import { initPgNotify, unsubscribeAll } from './runtime/event-bus.js';
import { startApiServer, warmApiCache, startCacheInvalidationListener } from './api.js';
import { loadDemoEmails } from './demo.js';
import { Reaper } from './runtime/reaper.js';
import { runTier2Audit } from './audit/tier2-ai-auditor.js';
import { consolidateChatMemories } from './runtime/chat-memory-consolidation.js';
import { runTier3Audit } from './audit/tier3-cross-model.js';
import { checkDeadManSwitch } from './runtime/dead-man-switch.js';
import { syncLlmExpenses } from './finance/financial-script.js';
import { checkCircuitBreaker } from './runtime/exploration-monitor.js';
import { runExplorationCycle } from './runtime/self-improve-scanner.js';
import { publishAllProofs } from './runtime/merkle-publisher.js';
import { runReconciliation, createHashCheckpoint, verifyToolRegistry } from './runtime/infrastructure.js';
import { initSlackApp, startSlack, stopSlack } from './slack/client.js';
import { registerSlackListeners } from './slack/listener.js';
import { initTelegramBot, startTelegram, stopTelegram } from './telegram/client.js';
import { registerTelegramListeners } from './telegram/listener.js';
import { pollCaptureSources } from './drive/watcher.js';
import { pollTldvTranscripts } from './tldv/poller.js';
import { pollCalendarEvents } from './calendar/poller.js';
import { pollResearchSources } from './research/research-source-poller.js';
import { registerAdapter, setSignalEmitter } from './adapters/registry.js';
import { registerCapability } from '../../lib/runtime/capability-registry.js';
import { embedText, generateDraftEmbeddings, hasEmbeddingProvider } from './voice/embeddings.js';
import { updateIssueStateByName, addBotComment } from './linear/client.js';
import { createEmailAdapter } from './adapters/email-adapter.js';
import { createOutlookAdapter } from './adapters/outlook-adapter.js';
import { createSlackAdapter } from './adapters/slack-adapter.js';
import { createWebhookAdapter } from './adapters/webhook-adapter.js';
import { createTelegramAdapter } from './adapters/telegram-adapter.js';
// Channel implementations injected into adapters at registration time.
// Per CG-1 (cross-layer imports): lib/adapters/* no longer imports product
// channel modules directly — the product wires implementations here.
import { fetchEmailBody } from './gmail/client.js';
import { createGmailDraft, sendApprovedDraft } from './gmail/sender.js';
import { fetchOutlookBody } from './outlook/client.js';
import { createOutlookDraft, sendApprovedOutlookDraft } from './outlook/sender.js';
import { sendSlackDraft } from './slack/sender.js';
import { sendTelegramDraft } from './telegram/sender.js';
import { FlowEngine } from '../../lib/runtime/flow-engine.js';
import { FlowToolRegistry } from '../../lib/runtime/tool-registry.js';
import { tools as flowToolCatalog } from '../tools/registry.js';
import { attachFlowWrappers } from './flow-wrappers/index.js';
import { measureProductValue } from './value/value-measurement.js';
import { runPhase1MetricsCollection } from './runtime/phase1-metrics.js';
import { refreshTrustScores } from './runtime/trust-scores.js';
import { expireStaleIntents } from './runtime/intent-manager.js';
import { reconcileGitHubIssues } from './github/issue-monitor.js';
import { checkSpecDrift } from './runtime/spec-drift-detector.js';
import { runTierResolution } from '../../lib/runtime/tier-resolution.js';
import { ServiceScheduler, setSchedulerInstance } from './runtime/schedule-service.js';
import { initGraph, closeGraph } from './graph/client.js';
import { ensureSchema } from './graph/schema.js';
import { seedGraph } from './graph/seed.js';
import { seedSpecGraph } from './graph/spec-seed.js';
import { startGraphSync, stopGraphSync } from './graph/sync.js';
import { runRelationshipInferrer } from './graph/relationship-inferrer.js';
import { startIntentExecutor, stopIntentExecutor } from './runtime/intent-executor.js';
import { extractPatterns, startPatternListener, stopPatternListener } from './graph/pattern-extractor.js';
import { onAnyEvent } from './runtime/event-bus.js';
import { extractTranscriptActions } from './transcripts/action-extractor.js';
import { maybeSendWeeklyRecaps } from './signal/weekly-recap.js';
import { wireLinearV2 } from './linear/v2-wiring.js';
import { startArtifactEnrichmentWorker } from '../../lib/runtime/signals/artifact-enrichment-worker.js';
import { startGeneratedArtifactWorker } from '../../lib/runtime/signals/generated-artifact-worker.js';

import { getConfig } from '../../lib/config/loader.js';
const agentsConfig = getConfig('agents');
const DEMO_MODE = process.argv.includes('--demo') || process.env.DEMO_MODE === '1';

// OSS zero-config demo boot: DEMO_MODE implies single-provider Anthropic-only
// LLM resolution (lib/llm/provider.js's LLM_SINGLE_PROVIDER overlay), so a
// fresh clone with only ANTHROPIC_API_KEY + DEMO_MODE=1 can run the whole org
// without OPENROUTER_API_KEY. Only defaults when unset — stays overridable,
// and lib/ itself never reads DEMO_MODE (kept product-agnostic).
if (DEMO_MODE && !process.env.LLM_SINGLE_PROVIDER) {
  process.env.LLM_SINGLE_PROVIDER = 'anthropic';
}

// PROCESS_ROLE: run a subset of the system in a single process.
// Values: 'ingestion' | 'agents' | 'api' | 'full' (default)
// Deploy as one process now; split into 3 Railway services when volume demands it.
const PROCESS_ROLE = process.env.PROCESS_ROLE || 'full';
const runIngestion = PROCESS_ROLE === 'full' || PROCESS_ROLE === 'ingestion';
const runAgents = PROCESS_ROLE === 'full' || PROCESS_ROLE === 'agents';
const runApi = PROCESS_ROLE === 'full' || PROCESS_ROLE === 'api';

// Per-process memo for the daily-digest scheduler so the hourly tick fires the
// digest at most once per UTC day instead of every hour during the morning
// window. Reset on process restart, which is fine — the worst case after a
// boot is one duplicate digest in the same day, not the per-hour spam we had.
let lastDailyDigestUtcDate = null;

/**
 * AutoBot Inbox: AI inbox management system.
 * Entry point: starts all agent loops + Gmail polling.
 *
 * No Express. No framework. Just Postgres + agent event loops.
 * P4: Boring infrastructure.
 */

const agentRegistry = {
  orchestrator: orchestratorLoop,
  strategist: strategistLoop,
  'executor-intake': intakeLoop,
  'executor-triage': triageLoop,
  'executor-responder': responderLoop,
  reviewer: reviewerLoop,
  architect: architectLoop,
  'executor-ticket': ticketLoop,
  'executor-coder': coderLoop,
  'executor-research': researchLoop,
  'executor-redesign': redesignLoop,
  'executor-blueprint': blueprintLoop,
  'claw-workshop': workshopLoop,
  'executor-writer': writerLoop,
  'content-atomizer': atomizerLoop,
  'executor-contract': contractLoop,
  // Tester verifies completed work against withheld scenarios (verification
  // spine). Uses spawnCLI → belongs with the CLI agents topologically (the M1:
  // AGENTS_ENABLED=executor-coder,executor-redesign,tester).
  tester: testerLoop,
};

// AGENTS_ENABLED env var: comma-separated list of agent IDs to run (overrides agents.json enabled flag).
// Split topology: Railway runs all enabled agents (everything except executor-coder + executor-redesign).
// Jamie's M1 runs ONLY the CLI agents: AGENTS_ENABLED=executor-redesign,executor-coder
// Both executor-coder and executor-redesign use spawnCLI() which requires Claude CLI (flat-rate sub).
const agentsEnabledOverride = process.env.AGENTS_ENABLED
  ? new Set(process.env.AGENTS_ENABLED.split(',').map(s => s.trim()))
  : null;

const agents = Object.entries(agentRegistry)
  .filter(([id]) => {
    const cfg = agentsConfig.agents[id];
    if (!cfg) return false;
    if (agentsEnabledOverride) return agentsEnabledOverride.has(id);
    return cfg.enabled !== false;
  })
  .map(([, loop]) => loop);

if (agents.length === 0) {
  console.warn('[startup] WARNING: No agents enabled in config/agents.json');
}

async function main() {
  console.log('AutoBot Inbox v0.1.0');
  console.log('====================\n');

  if (DEMO_MODE) {
    console.log('** DEMO MODE — using synthetic emails, no Gmail required **\n');
  }

  // Verify environment (Plan 030 / #474). Fail-fast on missing REQUIRED keys in
  // production; warn (never hard-fail) in dev/test so local + CI boot is never
  // broken. Demo mode uses synthetic data + PGlite, so REQUIRED keys don't
  // apply. Values are never logged — only key names.
  try {
    assertRequiredEnvReady({ demoMode: DEMO_MODE });
  } catch (err) {
    console.error(err.message);
    console.error('Copy .env.example to .env and fill in values.');
    process.exit(1);
  }
  // Preserve the historical dev/demo hard-stop on the single baseline LLM key so
  // a local non-demo boot without ANTHROPIC_API_KEY still fails clearly (the
  // preflight only WARNS in non-production).
  if (!DEMO_MODE && !process.env.ANTHROPIC_API_KEY && process.env.NODE_ENV !== 'production') {
    console.error('Missing required env var: ANTHROPIC_API_KEY');
    console.error('Copy .env.example to .env and fill in values.');
    process.exit(1);
  }

  // G8 production preflight (P1/P2): when this process runs agents in
  // production, refuse to boot if prompt-injection blocking (Model Armor) is
  // not actually armed. Fail-fast BEFORE any agent loop starts. No-op in
  // dev/test and in agent-less (api/ingestion-only) roles.
  assertModelArmorProductionReady({ agentsEnabled: runAgents });

  // Initialize PGlite (creates DB + runs migrations on first launch)
  try {
    const isNew = await initializeDatabase();
    console.log(isNew ? 'Database created and initialized' : 'Database connected');
  } catch (err) {
    console.error(`Database initialization failed: ${err.message}`);
    process.exit(1);
  }

  // Phase 1 (DB connection-exhaustion fix): start the single shared LISTEN
  // client AFTER the DB is up and BEFORE any subsystem registers its channels
  // (startGraphSync, initPgNotify, startPatternListener below). subscribe()
  // buffers registrations and a late subscribe() issues its own LISTEN, so the
  // exact order is not load-bearing — but starting it here guarantees the
  // client is connected before the first notification can fire. No-op in
  // PGlite/dev mode (no DATABASE_URL).
  await pgListener.start();

  // Sync agent config hashes — runtime computes real SHA-256, DB must match
  await syncConfigHashes();

  // Initialize agent JWT keys (STAQPRO-263 — agent-side identity).
  // Without this, _issueToken in lib/runtime/agent-loop.js fails on every
  // agent boot ("JWT keys not initialized") and withAgentScope falls through
  // to the plain-string path. Under REQUIRE_AGENT_JWT=true the next tick
  // throws and the agent is dead. runner.js (satellite) already calls this;
  // index.js (full process / production primary) had been missing it.
  try {
    const { initializeJwtKeys } = await import('./runtime/agent-jwt.js');
    await initializeJwtKeys();
  } catch (err) {
    if (process.env.REQUIRE_AGENT_JWT === 'true') {
      console.error(`[startup] Agent JWT initialization failed: ${err.message}`);
      process.exit(1);
    }
    console.warn(`[startup] Agent JWT initialization skipped: ${err.message}`);
  }

  // Initialize board JWT keys (separate keypair for external client auth)
  try {
    const { initializeBoardJwtKeys } = await import('./runtime/board-jwt.js');
    await initializeBoardJwtKeys();
  } catch (err) {
    console.warn(`[startup] Board JWT initialization skipped: ${err.message}`);
  }

  // Initialize customer JWT keys (OPT-37: separate keypair for external,
  // non-board customer principals — their own agent systems plugging in).
  try {
    const { initializeCustomerJwtKeys } = await import('./runtime/customer-jwt.js');
    await initializeCustomerJwtKeys();
  } catch (err) {
    console.warn(`[startup] Customer JWT initialization skipped: ${err.message}`);
  }

  // Ensure today's budget exists
  await ensureDailyBudget();

  // Release any reservations leaked by previous process lifetimes (Railway
  // redeploys, OOMs, etc.) — at startup nothing is in flight, so any
  // reserved_usd > 0 is unambiguously stale.
  const { releaseStaleReservations } = await import('./runtime/startup.js');
  await releaseStaleReservations();

  // Log deploy event for metric 12 (promotion-to-production lag)
  await logDeployEvent();

  // Knowledge graph (graceful — disabled if NEO4J_URI not set)
  await initGraph();
  await ensureSchema();
  await seedGraph();
  try {
    await seedSpecGraph();
  } catch (err) {
    // spec/ directory may not exist in Railway container — non-fatal
    console.warn(`[startup] Spec graph seeding skipped: ${err.message}`);
  }
  startGraphSync();

  console.log(`[startup] PROCESS_ROLE=${PROCESS_ROLE} (ingestion=${runIngestion}, agents=${runAgents}, api=${runApi})`);

  // Register contract-service capabilities (Plan 037: invert lib/signatures +
  // lib/engagements coupling to lib/contracts/*). The product owns the import
  // path so lib/* never names lib/contracts/*; after the follow-up relocation
  // only these paths change. Registered for EVERY role — signing (executeSign)
  // and engagement DOCX export run under the API role, not just agents/ingestion.
  // Lazy dynamic-import wrappers keep boot light (pdf-render cold-boots Chromium
  // on first call only, never at startup).
  registerCapability('contracts/pdf-render', {
    renderContractPdf: (args) =>
      import('../../lib/contracts/pdf-render.js').then((m) => m.renderContractPdf(args)),
  });
  registerCapability('contracts/spawn-work-items', {
    spawnWorkItemsForRequest: (args) =>
      import('../../lib/contracts/spawn-work-items.js').then((m) => m.spawnWorkItemsForRequest(args)),
  });
  registerCapability('contracts/brand-profile', {
    loadBrandProfileForEngagement: (id) =>
      import('../../lib/contracts/brand-profile.js').then((m) => m.loadBrandProfileForEngagement(id)),
    loadDefaultBrandProfile: () =>
      import('../../lib/contracts/brand-profile.js').then((m) => m.loadDefaultBrandProfile()),
  });

  // Register channel adapters (used by context-loader to fetch bodies + build prompt context)
  // Needed by both ingestion and agents roles
  if (runIngestion || runAgents) {
    registerAdapter('gmail', createEmailAdapter({ fetchEmailBody, createGmailDraft, sendApprovedDraft }));
    registerAdapter('outlook', createOutlookAdapter({ fetchOutlookBody, createOutlookDraft, sendApprovedOutlookDraft }));
    registerAdapter('slack', createSlackAdapter({ sendSlackDraft }));
    registerAdapter('webhook', createWebhookAdapter());
    registerAdapter('telegram', createTelegramAdapter({ sendTelegramDraft }));

    // Register lib/runtime capabilities (CG-1: lib/* never imports product modules)
    registerCapability('voice/embeddings', { embedText });
    registerCapability('linear/client', { updateIssueStateByName, addBotComment });

    // Wire the flow engine to adapter signals. Adapters call emitAdapterSignal()
    // with a signal type + payload; this emitter persists to agent_graph.signals
    // and fires any matching flow_definitions. Failure is isolated — signal
    // emission never breaks the hot path of the adapter that produced it.
    const flowRegistry = new FlowToolRegistry(flowToolCatalog);
    attachFlowWrappers(flowRegistry);
    const flowEngine = new FlowEngine({ db: { query }, toolRegistry: flowRegistry });
    setSignalEmitter(async (signalType, payload, sourceAdapter) => {
      try {
        const signal = await flowEngine.createSignal(signalType, payload, sourceAdapter);
        flowEngine.onSignal(signal).catch(err => {
          console.error(`[flow-engine] onSignal(${signalType}) failed:`, err.message);
        });
        return signal;
      } catch (err) {
        console.error(`[flow-engine] createSignal(${signalType}) failed:`, err.message);
        return null;
      }
    });
    console.log('[startup] Flow engine wired as signal emitter');
  }

  // --- Ingestion: Slack, Telegram, Gmail, Drive polling ---
  let pollTimer;
  let driveTimeoutTimer;
  let driveIntervalTimer;

  if (runIngestion) {
    // Start Slack if configured
    const slackAccounts = await query(
      `SELECT id, label FROM inbox.accounts WHERE channel = 'slack' AND is_active = true`
    );
    if (process.env.SLACK_BOT_TOKEN) {
      try {
        const slackApp = await initSlackApp();
        const slackAccountId = slackAccounts.rows[0]?.id || 'default-slack';
        if (slackAccounts.rows.length === 0) {
          console.warn('[slack] SLACK_BOT_TOKEN set but no active Slack account in inbox.accounts — messages will use fallback ID');
        } else if (slackAccounts.rows.length > 1) {
          console.warn(`[slack] ${slackAccounts.rows.length} active Slack accounts found — using first: ${slackAccounts.rows[0].label || slackAccountId}`);
        }
        registerSlackListeners(slackApp, slackAccountId);
        await startSlack();
        console.log(`[slack] Connected (account: ${slackAccounts.rows[0]?.label || slackAccountId}, mode: socket)`);
      } catch (err) {
        console.error(`[slack] Init failed: ${err.message}`);
        console.error('[slack] Check: SLACK_BOT_TOKEN valid? SLACK_APP_TOKEN set? Socket Mode enabled in Slack app settings?');
      }
    } else if (slackAccounts.rows.length > 0) {
      console.warn(`[slack] ${slackAccounts.rows.length} active Slack account(s) in DB but SLACK_BOT_TOKEN not set — Slack channel disabled`);
      console.warn('[slack] To enable: set SLACK_BOT_TOKEN and SLACK_APP_TOKEN in .env');
    }

    // Start Telegram if configured
    if (process.env.TELEGRAM_BOT_TOKEN) {
      if (!process.env.TELEGRAM_BOARD_USER_IDS) {
        console.warn('[telegram] TELEGRAM_BOT_TOKEN set but TELEGRAM_BOARD_USER_IDS is empty — all messages will be ignored');
      }
      try {
        const bot = await initTelegramBot();
        const telegramAccounts = await query(
          `SELECT id, label FROM inbox.accounts WHERE channel = 'telegram' AND is_active = true`
        );
        const telegramAccountId = telegramAccounts.rows[0]?.id || 'default-telegram';
        registerTelegramListeners(bot, telegramAccountId);
        await startTelegram();
        console.log(`[telegram] Connected (account: ${telegramAccounts.rows[0]?.label || telegramAccountId}, mode: polling)`);
      } catch (err) {
        console.error(`[telegram] Init failed: ${err.message}`);
      }
    }

    // Start Gmail polling or demo mode
    if (DEMO_MODE) {
      await loadDemoEmails();
    } else {
      try {
        const pollInterval = parseInt(process.env.GMAIL_POLL_INTERVAL || '60', 10) * 1000;
        pollTimer = await startPolling(pollInterval);
        console.log(`Gmail polling started (${pollInterval / 1000}s interval)`);
      } catch (err) {
        console.error(`[gmail] Polling failed to start: ${err.message}`);
        console.error('[gmail] Check GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN, or run with DEMO_MODE=1 to skip Gmail');
      }
    }

    // Start Drive capture-source polling (DB-driven, content.capture_sources)
    if (!DEMO_MODE) {
      const driveInterval = parseInt(process.env.DRIVE_POLL_INTERVAL || '300', 10) * 1000;
      // OPT-98 / ADR-016: the DB-driven capture-source watcher
      // (content.capture_sources → typed artifacts) is the only Drive ingestion
      // path; there is no env gate — enabled sources are the poll set.
      // Capture-source errors are isolated per-source inside pollCaptureSources.
      const driveTick = () => {
        pollCaptureSources().catch(err => console.error(`[capture] Poll error: ${err.message}`));
      };
      driveTimeoutTimer = setTimeout(() => {
        driveTick();
        driveIntervalTimer = setInterval(driveTick, driveInterval);
      }, 15_000);
      console.log(`Drive + capture-source polling scheduled (${driveInterval / 1000}s interval, 15s startup delay)`);

      // TLDv API polling (direct transcript fetch, replaces brain-rag cron)
      if (process.env.TLDV_API_KEY) {
        const tldvInterval = parseInt(process.env.TLDV_POLL_INTERVAL_MS || '300000', 10); // 5 min default
        setTimeout(() => {
          pollTldvTranscripts().catch(err => console.error(`[tldv] Poll error: ${err.message}`));
          setInterval(() => {
            pollTldvTranscripts().catch(err => console.error(`[tldv] Poll error: ${err.message}`));
          }, tldvInterval);
        }, 20_000);
        console.log(`TLDv polling scheduled (${tldvInterval / 1000}s interval, 20s startup delay)`);
      } else {
        console.log('TLDv polling skipped (TLDV_API_KEY not set)');
      }

      // STAQPRO-327: Google Calendar polling. Mirrors TLDv's pattern —
      // 5 min interval, 25s startup delay. Service-account auth reuses
      // GOOGLE_SERVICE_ACCOUNT_KEY from Drive (calendar.readonly scope is
      // added at the client level, not the SA default scope list — see
      // src/drive/service-auth.js getCalendarClient).
      //
      // OPT-126: ALWAYS armed. The old CALENDAR_ACCOUNT_EMAIL gate predated
      // mig 114 (DB-driven watches) — a deploy without that env var silently
      // killed polling for every watch (the "watches stale" banner class).
      // The poller reads inbox.calendar_watches itself; zero active watches
      // is a cheap no-op tick.
      {
        const calendarInterval = parseInt(process.env.CALENDAR_POLL_INTERVAL_MS || '300000', 10);
        setTimeout(() => {
          pollCalendarEvents().catch(err => console.error(`[calendar] Poll error: ${err.message}`));
          setInterval(() => {
            pollCalendarEvents().catch(err => console.error(`[calendar] Poll error: ${err.message}`));
          }, calendarInterval);
        }, 25_000);
        console.log(`Calendar polling scheduled (${calendarInterval / 1000}s interval, 25s startup delay; watches from inbox.calendar_watches)`);
      }

      // Draft embedding sweep (STAQPRO-301) — backfills
      // agent_graph.action_proposals.embedding so the v_phase1_metrics M3
      // voice-similarity metric has draft-side vectors to cosine against
      // voice.sent_emails. Reuses the same Voyage pipeline (voyage-3.5-lite,
      // 1024-dim) as the sent-email side so the cosine math is valid.
      if (hasEmbeddingProvider()) {
        const draftEmbedInterval = parseInt(process.env.DRAFT_EMBED_INTERVAL_MS || '300000', 10); // 5 min default
        setTimeout(() => {
          generateDraftEmbeddings(50).catch(err => console.error(`[draft-embed] Sweep error: ${err.message}`));
          setInterval(() => {
            generateDraftEmbeddings(50).catch(err => console.error(`[draft-embed] Sweep error: ${err.message}`));
          }, draftEmbedInterval);
        }, 25_000); // staggered from drive (15s) and tldv (20s) so startup load is spread
        console.log(`Draft embedding sweep scheduled (${draftEmbedInterval / 1000}s interval, 25s startup delay)`);
      } else {
        console.log('Draft embedding sweep skipped (no VOYAGE_API_KEY / OPENAI_API_KEY)');
      }
    }
  } else {
    console.log('[startup] Ingestion disabled (PROCESS_ROLE is not ingestion/full)');
  }

  // --- API server ---
  let apiServer;
  if (runApi) {
    await initPgNotify(); // receive pg_notify from M1 executors (cross-process cache invalidation)
    startCacheInvalidationListener(); // invalidate pipeline/status cache on state changes
    const apiPort = parseInt(process.env.PORT || process.env.API_PORT || '3001', 10);
    apiServer = startApiServer(apiPort);
    await warmApiCache();
  } else {
    console.log('[startup] API server disabled (PROCESS_ROLE is not api/full)');
  }

  // --- Agent loops ---
  if (runAgents) {
    for (let i = 0; i < agents.length; i++) {
      const agent = agents[i];
      const delay = i * 2000;
      setTimeout(() => {
        agent.start().catch(err => {
          console.error(`[${agent.agentId}] Fatal error:`, err.message);
        });
      }, delay);
    }

    const agentNames = agents.map(a => a.agentId).join(', ');
    console.log(`\n${agents.length} agents started (${agentNames}). Use CLI (npm run cli) for board operations.\n`);

    // STAQPRO-290 Phase 2 — accept restart commands from /runners.
    // RUNNER_ID is set on Railway; falls back to hostname() in any other env.
    const runnerId = process.env.RUNNER_ID || hostname().split('.')[0].toLowerCase();
    startCommandPoller(runnerId, agents);
  } else {
    console.log('[startup] Agent loops disabled (PROCESS_ROLE is not agents/full)');
  }

  // Phase 2-4 periodic services — managed by ServiceScheduler (DB-backed visibility)
  const scheduler = new ServiceScheduler();
  setSchedulerInstance(scheduler);

  // Reaper + periodic services run wherever agent loops run. AGENTS_ENABLED gates
  // *which* agents start — not whether this is a primary instance. Railway sets
  // AGENTS_ENABLED on the production primary to scope the agent set, and earlier
  // versions of this code falsely classified that as a satellite runner, silently
  // disabling the reaper (STAQPRO-282). M1 satellite runners use src/runner.js and
  // never reach this code path.
  const isPrimaryInstance = runAgents;
  const reaper = new Reaper();
  // ADR-017 D10: share-grant expiry sweep (active → expired when expires_at passes).
  const { ShareGrantsSweep } = await import('../../lib/runtime/share-grants-sweep.js');
  const shareGrantsSweep = new ShareGrantsSweep();
  if (isPrimaryInstance) {
    reaper.start();
    shareGrantsSweep.start();
  } else {
    console.log('[startup] Periodic services skipped (PROCESS_ROLE does not include agents)');
  }

  if (isPrimaryInstance) {
    // Architect daily briefing — schedule task creation for 6 AM daily
    scheduler.register('architect-daily', async () => {
      const { createWorkItem } = await import('./runtime/state-machine.js');
      const existing = await query(
        `SELECT 1 FROM agent_graph.work_items
         WHERE assigned_to = 'architect' AND created_at >= CURRENT_DATE
         LIMIT 1`
      );
      if (existing.rows.length > 0) return;
      await createWorkItem({
        type: 'task',
        title: `Daily briefing: ${new Date().toISOString().slice(0, 10)}`,
        description: 'Generate daily pipeline analysis, briefing, and email digest',
        createdBy: 'orchestrator',
        assignedTo: 'architect',
        priority: 0,
        metadata: { trigger: 'daily_schedule' },
      });
      console.log('[architect-daily] Created daily briefing task');
    }, 60 * 60_000, { delayMs: 30_000 });

    // STAQPRO-522 — nightly tier-resolution: deterministic SQL promotions of
    // signal.contacts.tier from calendar + email signals. Boot-time delay of
    // 60s clears the backlog without waiting overnight after deployment.
    scheduler.register('tier-resolution', runTierResolution, 24 * 60 * 60_000, { delayMs: 60_000 });

    scheduler.register('tier2-audit', runTier2Audit, 24 * 60 * 60_000, { delayMs: 5 * 60_000, critical: true });
    scheduler.register('dead-man-switch', checkDeadManSwitch, 24 * 60 * 60_000, { delayMs: 60_000, critical: true });
    scheduler.register('finance-sync', () => syncLlmExpenses(new Date()), 6 * 60 * 60_000, { delayMs: 2 * 60_000 });
    scheduler.register('exploration-monitor', checkCircuitBreaker, 60 * 60_000, { delayMs: 3 * 60_000 });

    // Chat overhaul P5 — nightly consolidation of board-member chat memories
    // (chat:* buckets in agent_memories). Lives on THIS scheduler only — the
    // M1 runner boots via lib/runtime/state/startup.js and never registers it.
    scheduler.register('chat-memory-consolidate', consolidateChatMemories, 24 * 60 * 60_000, { delayMs: 15 * 60_000 });

    // STAQPRO-553: actually RUN the exploration domains on a schedule. Previously
    // only 'exploration-monitor' (the explore/exploit ratio circuit-breaker) was
    // registered — nothing scheduled the cycle that executes enabled domains and
    // records runs, so /runs → Explorer showed 0 runs/7d for every domain despite
    // them being toggled on. runExplorationCycle() internally honors quiet hours,
    // per-cycle/daily budgets, the circuit breaker, and the per-domain enabled flag
    // (agent_graph.exploration_queue), and calls recordDomainRun()/exploration_log,
    // so per-domain enablement is governed by the DB toggle the panel already drives.
    //
    // The cycle spends LLM budget, so it is opt-in via EXPLORATION_ENABLED (default
    // off) — flip it on once in Railway to start the loop. The existing POST
    // /api/cron/explorer endpoint remains as a manual trigger. The architect config
    // can override the cadence via agents.architect.exploration.cycleIntervalMs.
    const explorationEnabled = process.env.EXPLORATION_ENABLED === 'true';
    if (explorationEnabled) {
      const explorationCfg = agentsConfig.agents?.architect?.exploration || {};
      const cycleIntervalMs = explorationCfg.cycleIntervalMs ?? 4 * 60 * 60_000;
      scheduler.register(
        'exploration-cycle',
        () => runExplorationCycle(explorationCfg),
        cycleIntervalMs,
        { delayMs: 6 * 60_000 },
      );
      console.log(`[startup] exploration-cycle scheduled (every ${Math.round(cycleIntervalMs / 60_000)}m)`);
    } else {
      console.log('[startup] exploration-cycle NOT scheduled (set EXPLORATION_ENABLED=true to enable)');
    }
    scheduler.register('merkle-publisher', publishAllProofs, 24 * 60 * 60_000, { delayMs: 10 * 60_000, critical: true });
    scheduler.register('relationship-inferrer', () => runRelationshipInferrer({ query }), 60 * 60_000, { delayMs: 4 * 60_000 });
    scheduler.register('reconciliation', runReconciliation, 5 * 60_000, { delayMs: 45_000, critical: true });
    scheduler.register('hash-checkpoint', createHashCheckpoint, 60 * 60_000, { delayMs: 2 * 60_000, critical: true });
    scheduler.register('tool-verify', verifyToolRegistry, 24 * 60 * 60_000, { delayMs: 5_000, critical: true });
    scheduler.register('tier3-audit', runTier3Audit, 7 * 24 * 60 * 60_000, { delayMs: 15 * 60_000, critical: true });
    scheduler.register('value-measurement', async () => {
      const result = await measureProductValue('autobot-inbox', new Date());
      if (result) {
        console.log(`[value-measurement] Shadow mode: value_ratio=${result.value_ratio}, net_value=${result.net_value}`);
      } else {
        console.log('[value-measurement] Shadow mode: no data (schema may not be ready)');
      }
    }, 24 * 60 * 60_000, { delayMs: 15 * 60_000 });
    scheduler.register('phase1-metrics', runPhase1MetricsCollection, 60 * 60_000, { delayMs: 5 * 60_000 });
    // OPT-82 (P5): recompute the per-agent trust-score MV hourly. Observe-only —
    // exposes the score, does not graduate autonomy. delay 6m to land after metrics.
    scheduler.register('trust-score-refresh', refreshTrustScores, 60 * 60_000, { delayMs: 6 * 60_000 });
    scheduler.register('intent-expiry', expireStaleIntents, 60 * 60_000, { delayMs: 60_000 });
    startIntentExecutor();
    scheduler.register('github-reconciliation', reconcileGitHubIssues, 12 * 60 * 60_000, { delayMs: 10 * 60_000 });
    scheduler.register('spec-drift-detector', checkSpecDrift, 24 * 60 * 60_000, { delayMs: 20 * 60_000 });

    // Uptime + TLS-cert-expiry monitor (STAQPRO-606). Probes public surfaces
    // (board.staqs.io, API health) hourly; alerts the board on a down surface
    // OR a cert within ~21 days of expiring — the latter catches a blocked
    // Railway/Cloudflare auto-renewal ~30 days before it 525s (the 2026-06-02
    // board outage). Override surfaces via MONITOR_TARGETS, threshold via
    // MONITOR_CERT_WARN_DAYS.
    scheduler.register('uptime-cert-monitor', async () => {
      const { runUptimeCertMonitor } = await import('./monitoring/uptime-cert-monitor.js');
      const { notifyBoard } = await import('./telegram/sender.js');
      const r = await runUptimeCertMonitor({ notify: notifyBoard });
      if (r.alerts.length) {
        console.warn(`[uptime-cert-monitor] ${r.alerts.length} alert(s): ${r.alerts.join(' | ')}`);
      } else {
        console.log(`[uptime-cert-monitor] all green: ${r.summary.map(s => `${s.name}=${s.status}/${s.certDays}d`).join(' ')}`);
      }
    }, 60 * 60_000, { delayMs: 6 * 60_000 });

    // Weekly action-item recap — hourly tick, internal gate fires only Monday >= configured hour.
    // Idempotency is enforced by inbox.weekly_recaps_sent UNIQUE(week_start, recipient_email).
    scheduler.register('weekly-recap', maybeSendWeeklyRecaps, 60 * 60_000, { delayMs: 2 * 60_000 });

    // Canary: detect pipeline death — messages arriving but no drafts being created (Liotta review)
    scheduler.register('pipeline-canary', async () => {
      const result = await query(`
        SELECT
          (SELECT COUNT(*) FROM inbox.messages WHERE received_at > now() - interval '24 hours') AS messages_24h,
          (SELECT COUNT(*) FROM agent_graph.action_proposals WHERE action_type = 'email_draft' AND created_at > now() - interval '24 hours') AS drafts_24h,
          (SELECT COUNT(*) FROM inbox.messages WHERE received_at > now() - interval '24 hours' AND triage_category IN ('action_required', 'needs_response')) AS actionable_24h
      `);
      const { drafts_24h, actionable_24h } = result.rows[0] || {};
      if (Number(actionable_24h) > 3 && Number(drafts_24h) === 0) {
        console.error(`[pipeline-canary] ALERT: ${actionable_24h} actionable emails in 24h but 0 drafts — pipeline may be dead`);
        try {
          const { notifyBoard } = await import('./telegram/sender.js');
          await notifyBoard(`Pipeline canary: ${actionable_24h} actionable emails in 24h but 0 drafts created. Pipeline may be broken.`);
        } catch { /* telegram not configured */ }
      }
    }, 6 * 60 * 60_000, { delayMs: 30 * 60_000 });

    // Daily digest: Telegram summary of what happened in the last 24h.
    // Scheduler ticks hourly (`60 * 60_000` below) — the in-handler guards
    // (a) restrict sends to a 3-hour UTC window (~ET morning) and
    // (b) memoize on UTC date so we send AT MOST ONCE per day, not three.
    scheduler.register('daily-digest', async () => {
      // getUTCHours (plural). The previous getUTCHour?.() typo silently fell
      // through to local time — harmless on Railway (UTC) but wrong on M1 (PT).
      const now = new Date();
      const hour = now.getUTCHours();
      if (hour < 12 || hour > 14) return; // ~ ET 7–9 AM

      const today = now.toISOString().slice(0, 10);
      if (lastDailyDigestUtcDate === today) return;
      lastDailyDigestUtcDate = today;

      const stats = await query(`
        SELECT
          (SELECT COUNT(*) FROM inbox.messages WHERE received_at > now() - interval '24 hours') AS emails_received,
          (SELECT COUNT(*) FROM inbox.messages WHERE archived_at > now() - interval '24 hours') AS emails_archived,
          (SELECT COUNT(*) FROM agent_graph.action_proposals WHERE action_type = 'email_draft' AND created_at > now() - interval '24 hours') AS drafts_created,
          (SELECT COUNT(*) FROM agent_graph.action_proposals WHERE board_action IS NOT NULL AND acted_at > now() - interval '24 hours') AS drafts_acted,
          (SELECT COUNT(*) FROM inbox.signals WHERE created_at > now() - interval '24 hours' AND resolved = false) AS signals_unresolved,
          (SELECT COUNT(*) FROM agent_graph.work_items WHERE created_at > now() - interval '24 hours') AS tasks_total,
          (SELECT COUNT(*) FROM agent_graph.work_items WHERE status = 'completed' AND created_at > now() - interval '24 hours') AS tasks_completed,
          (SELECT COALESCE(SUM(cost_usd), 0) FROM agent_graph.state_transitions WHERE created_at > now() - interval '24 hours') AS cost_24h
      `);
      const s = stats.rows[0] || {};

      let wikiHighSignalLines = [];
      try {
        const wikiHigh = await query(`
          SELECT title,
                 metadata->>'signal_confidence' AS conf,
                 metadata->>'signal_actionability' AS act
          FROM content.documents
          WHERE source = 'wiki-compiled'
            AND updated_at > now() - interval '24 hours'
            AND (
              metadata->>'signal_actionability' IN ('actionable-upgrade', 'research-followup')
              OR metadata->>'signal_confidence' = 'high'
            )
          ORDER BY updated_at DESC
          LIMIT 8
        `);
        wikiHighSignalLines = wikiHigh.rows.map(
          (r) => `• ${r.title} (${r.conf || '?'} conf · ${r.act || '?'})`
        );
      } catch (err) {
        console.warn(`[daily-digest] wiki signal query skipped: ${err.message}`);
      }

      const msg = [
        'Daily Digest',
        '',
        `Emails: ${s.emails_received} received, ${s.emails_archived} auto-archived`,
        `Drafts: ${s.drafts_created} created, ${s.drafts_acted} reviewed`,
        `Signals: ${s.signals_unresolved} unresolved`,
        `Tasks: ${s.tasks_completed}/${s.tasks_total} completed`,
        `Cost: $${Number(s.cost_24h || 0).toFixed(2)}`,
        ...(wikiHighSignalLines.length
          ? ['', 'Wiki — high-signal compiles (24h):', ...wikiHighSignalLines]
          : []),
        '',
        'Review: board.staqs.io/today · board.staqs.io/pipeline',
      ].join('\n');

      try {
        const { notifyBoard } = await import('./telegram/sender.js');
        await notifyBoard(msg);
        console.log('[daily-digest] Sent to board via Telegram');
      } catch { /* telegram not configured */ }

      const slackDigestChannel = (process.env.SLACK_DIGEST_CHANNEL || '').trim();
      if (slackDigestChannel && process.env.SLACK_BOT_TOKEN) {
        try {
          const { initSlackApp, sendMessage } = await import('./slack/client.js');
          await initSlackApp();
          await sendMessage(slackDigestChannel, msg);
          console.log('[daily-digest] Sent to board via Slack');
        } catch (err) {
          console.warn(`[daily-digest] Slack skipped: ${err.message}`);
        }
      }
    }, 60 * 60_000, { delayMs: 5 * 60_000 });

    scheduler.register('project-cleanup', async () => {
      const { cleanupProjectWorkspace } = await import('../../agents/claw-campaigner/campaign-workspace.js');
      const { query } = await import('./db.js');
      const expired = await query(
        `SELECT id FROM agent_graph.campaigns
         WHERE campaign_mode = 'project'
           AND cleanup_at IS NOT NULL
           AND cleanup_at < now()
           AND (metadata->>'cleaned_up')::boolean IS NOT TRUE
         LIMIT 5`
      );
      for (const row of expired.rows) {
        try {
          await cleanupProjectWorkspace(row.id);
          console.log(`[project-cleanup] Cleaned up expired project campaign ${row.id}`);
        } catch (err) {
          console.warn(`[project-cleanup] Failed to clean ${row.id}: ${err.message}`);
        }
      }
    }, 24 * 60 * 60_000, { delayMs: 30 * 60_000 }); // Daily, 30min startup delay

    scheduler.register('pattern-extractor', extractPatterns, 24 * 60 * 60_000, { delayMs: 15 * 60_000 });
    startPatternListener();

    // --- Signal→action bridge reconciler (ADR-008 Phase 1) ---------------------
    // SAFE-BY-DEFAULT, TWO INDEPENDENT GATES. This loop performs autonomous action
    // in production, so going live requires BOTH switches flipped (each via Railway
    // env / config edit — never a code deploy):
    //   1. SIGNAL_BRIDGE_ENABLED=true (env)  — schedules this interval at all.
    //      When unset/false the interval is NOT registered: zero overhead, zero
    //      behavior change. This is the master on/off switch.
    //   2. signal-routing.json "dryRun": false (config) — lets the bridge actually
    //      create work_items / human_tasks. While dryRun=true (the shipped default)
    //      the reconciler computes routing + liveness and stamps metadata but
    //      creates nothing. runBridgeReconciler() reads dryRun from config itself.
    // Flip order to go live: enable the env flag first (observe dry-run summaries in
    // logs), then flip dryRun=false in config once the board has reviewed the report.
    // Interval is configurable via signal-routing.json "reconcileIntervalMs"
    // (default 300000 = 5 min). The scheduler wraps the tick in error tracking and
    // is torn down by scheduler.stopAll() on shutdown, so no separate cleanup is
    // needed; the inner try/catch additionally guarantees a thrown summary/logging
    // path can never crash the runtime.
    if (process.env.SIGNAL_BRIDGE_ENABLED === 'true') {
      const { runBridgeReconciler } = await import('./runtime/signal-action-reconciler.js');
      let bridgeIntervalMs = 300_000; // 5 min default
      try {
        const { getConfig } = await import('../../lib/config/loader.js');
        const cfg = getConfig('signal-routing');
        if (Number.isFinite(cfg?.reconcileIntervalMs)) {
          bridgeIntervalMs = cfg.reconcileIntervalMs;
        }
      } catch (err) {
        console.warn(`[signal-bridge] Config load failed, using ${bridgeIntervalMs}ms default: ${err.message}`);
      }
      scheduler.register(
        'signal-action-bridge',
        async () => {
          try {
            // dryRun + limit + perRunCostCapUsd are read from signal-routing.json
            // inside runBridgeReconciler; we deliberately pass no overrides so the
            // config remains the single source of truth for the live/dry-run gate.
            const summary = await runBridgeReconciler({ query });
            console.log(
              `[signal-bridge] reconcile pass: dryRun=${summary.dryRun} scanned=${summary.scanned} ` +
              `byDecision=${JSON.stringify(summary.byDecision)} byClass=${JSON.stringify(summary.byClass)} ` +
              `estCostUsd=${summary.estCostUsd.toFixed(4)} capHit=${summary.capHit}`
            );
          } catch (err) {
            console.error(`[signal-bridge] reconcile pass failed: ${err.message}`);
          }
        },
        bridgeIntervalMs,
        { delayMs: 30_000 }
      );
      console.log(`[signal-bridge] Reconciler scheduled (SIGNAL_BRIDGE_ENABLED=true, ${bridgeIntervalMs / 1000}s interval, 30s startup delay). dryRun gate read from signal-routing.json per pass.`);
    } else {
      console.log('[signal-bridge] Reconciler NOT scheduled (SIGNAL_BRIDGE_ENABLED unset/false) — no overhead, no behavior change.');
    }

    if (runIngestion) {
      const feedInterval = parseInt(process.env.FEED_POLL_INTERVAL_MS || '900000', 10);
      scheduler.register(
        'rd-feed-poller',
        async () => {
          const r = await pollResearchSources({ maxItems: 20 });
          if (r.ingested > 0 || r.errors > 0 || r.wiki_compiled != null) {
            const wc = r.wiki_compiled != null ? ` wiki_compiled=${r.wiki_compiled}` : '';
            console.log(
              `[rd-feed-poller] subscriptions=${r.subscriptions} ingested=${r.ingested} scanned=${r.scanned} skipped=${r.skipped} errors=${r.errors}${wc}`
            );
          }
        },
        feedInterval,
        { delayMs: 25_000 }
      );
    }

    // Transcript action extractor: listen for completed tl;dv triage work items.
    // The unsubscribe handle is discarded — the listener is intentionally
    // process-lifetime: there is no shutdown path that would call it.
    onAnyEvent(async (payload) => {
      if (payload.event_type !== 'state_changed') return;
      try {
        const wiResult = await query(
          `SELECT id, metadata FROM agent_graph.work_items
           WHERE id = $1 AND status = 'completed'
             AND metadata->>'webhook_source' = 'tldv'`,
          [payload.work_item_id]
        );
        const wi = wiResult.rows[0];
        if (wi?.metadata?.email_id) {
          await extractTranscriptActions(wi.metadata.email_id);
        }
      } catch (err) {
        console.warn(`[transcript-listener] Error: ${err.message}`);
      }
    });

    console.log('Periodic services scheduled (reaper, architect-daily, tier-resolution, tier2-audit, tier3-audit, dead-man-switch, finance-sync, exploration-monitor, merkle-publisher, reconciliation, hash-checkpoint, tool-verify, value-measurement, phase1-metrics, intent-expiry, intent-executor, github-reconciliation, spec-drift-detector, pattern-extractor, pattern-listener, transcript-action-extractor, rd-feed-poller, uptime-cert-monitor)');
  }

  // --- v0.2 Linear workers (enrichment, push, reconciliation, team-cache) ---
  // PRD: docs/internal/prds/meeting-actions-to-kanban-v0.2-tech-spec.md
  // Gated on LINEAR_API_KEY + LINEAR_TEAM_ID — degrades cleanly otherwise.
  // Only runs in the primary instance (where the agent loops + scheduler live).
  // The api.js layer picks up the same linearClient through process state so
  // operator endpoints (workflow-states, reconcile, team-cache) share the
  // adapter rather than building their own.
  let linearV2 = { stop: async () => {}, linearClient: null };
  if (isPrimaryInstance) {
    try {
      linearV2 = await wireLinearV2({ query });
      if (linearV2.linearClient) {
        const { setLinearClient } = await import('./api.js');
        if (typeof setLinearClient === 'function') {
          setLinearClient(linearV2.linearClient);
        }
      }
    } catch (err) {
      console.warn(`[linear-v2] Wiring failed: ${err.message}`);
    }
  }

  // --- OPT-93: artifact enrichment worker (capture → enriched contacts/projects) ---
  // Feature 004 item 2 — the #1-priority layer. Consumes content.enrichment_queue
  // (producer + pg_notify('capture_ingested') trigger shipped in OPT-92/mig 154).
  // Capture enrichment is CORE — boot it ALWAYS (NOT gated on Linear env, unlike
  // wireLinearV2), only on the primary instance (where the queue producer +
  // scheduler live) and disable-able via ARTIFACT_ENRICHMENT_ENABLED=false.
  let artifactEnrichmentWorker = { stop: async () => {} };
  if (isPrimaryInstance && process.env.ARTIFACT_ENRICHMENT_ENABLED !== 'false') {
    try {
      artifactEnrichmentWorker = await startArtifactEnrichmentWorker({ query });
      console.log('[artifact-enrich] Worker started (capture_ingested → enrich contacts/projects)');
    } catch (err) {
      console.warn(`[artifact-enrich] Worker start failed: ${err.message}`);
    }
  }

  // --- OPT-99: generated-artifact worker (generated proposals/contracts → artifact registry) ---
  // Feature 005 item 4. Consumes pg_notify('artifact_register') emitted by
  // recordGeneratedProposal + draftContractFromApprovedProposal. Generation
  // never blocks on this worker — the notify is fire-and-forget (P3).
  let generatedArtifactWorker = { stop: async () => {} };
  if (isPrimaryInstance && process.env.GENERATED_ARTIFACT_WORKER_ENABLED !== 'false') {
    try {
      generatedArtifactWorker = await startGeneratedArtifactWorker({ query });
      console.log('[generated-artifact] Worker started (artifact_register → artifact registry)');
    } catch (err) {
      console.warn(`[generated-artifact] Worker start failed: ${err.message}`);
    }
  }

  // Fix 17: Graceful shutdown with double-shutdown guard
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return; // prevent re-entrant shutdown
    shuttingDown = true;
    console.log(`\n${signal} received. Shutting down...`);

    // Begin graceful drain: campaign loops abort their in-flight iteration and
    // pause+checkpoint at the next boundary instead of being killed mid-run.
    beginDrain();
    // Hard ceiling / SIGKILL fallback: if drain hangs (a blocked DB call, a stuck
    // worker), force-exit so the supervisor (launchd KeepAlive) can restart cleanly
    // instead of leaving a zombie.
    setTimeout(() => {
      console.error(`[shutdown] drain exceeded DRAIN_TIMEOUT_MS (${drainTimeoutMs()}ms) — forcing exit`);
      process.exit(1);
    }, drainTimeoutMs()).unref();

    if (pollTimer) clearInterval(pollTimer);
    if (driveTimeoutTimer) clearTimeout(driveTimeoutTimer);
    if (driveIntervalTimer) clearInterval(driveIntervalTimer);

    // Stop periodic services
    reaper.stop();
    scheduler.stopAll();

    for (const agent of agents) {
      agent.stop();
    }

    unsubscribeAll();

    // Stop intent executor + pattern listener + graph sync and Neo4j
    stopIntentExecutor();
    stopPatternListener();
    stopGraphSync();
    await closeGraph();

    // Stop v0.2 Linear workers (no-op when LINEAR_* env was missing)
    try {
      await linearV2.stop();
    } catch (err) {
      console.warn(`[linear-v2] shutdown error: ${err.message}`);
    }

    // Stop the artifact enrichment worker (no-op when disabled / non-primary).
    try {
      await artifactEnrichmentWorker.stop();
    } catch (err) {
      console.warn(`[artifact-enrich] shutdown error: ${err.message}`);
    }

    // Stop the generated-artifact worker (OPT-99).
    try {
      await generatedArtifactWorker.stop();
    } catch (err) {
      console.warn(`[generated-artifact] shutdown error: ${err.message}`);
    }

    // Stop Slack and Telegram if running
    await stopSlack();
    await stopTelegram();

    // Close API server
    if (apiServer) apiServer.close();

    // Wait a moment for loops to finish
    await new Promise(resolve => setTimeout(resolve, 2000));
    // Phase 1: stop the shared LISTEN client (UNLISTEN *, destroy, clear
    // reconnect/watchdog timers) BEFORE ending the pool. The subsystem
    // stop*() calls above have already detached their handlers.
    await pgListener.stop();
    await close();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

/**
 * Sync agent config hashes into the DB.
 * The AgentLoop computes SHA-256 from the MERGED config (disk + DB overrides) and
 * guardCheck compares against this row. We MUST hash the same merged config here —
 * hashing the plain disk `agents.json` disagrees for any agent with a DB override
 * (e.g. the orchestrator/reviewer model overrides) and blocks every task with
 * 'config_hash_mismatch'. If the merged load fails (transient DB error at boot),
 * skip silently — AgentLoop.start() writes the authoritative per-agent hash anyway.
 */
async function syncConfigHashes() {
  let merged;
  try {
    const { loadMergedConfig } = await import('../../lib/runtime/config-loader.js');
    merged = await loadMergedConfig();
  } catch (err) {
    console.warn(`[config] syncConfigHashes skipped — merged config load failed: ${err.message}`);
    return;
  }
  for (const [agentId, config] of Object.entries(merged.agents)) {
    const hash = createHash('sha256')
      .update(JSON.stringify(config))
      .digest('hex')
      .slice(0, 16);

    const result = await query(
      `UPDATE agent_graph.agent_configs SET config_hash = $1 WHERE id = $2 AND config_hash != $1`,
      [hash, agentId]
    );
    if (result.rowCount > 0) {
      console.log(`[config] Updated ${agentId} config_hash → ${hash}`);
    }
  }
}

async function logDeployEvent() {
  try {
    const { execFileSync } = await import('child_process');
    let gitSha = null;
    try {
      gitSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    } catch {}
    await query(
      `INSERT INTO agent_graph.deploy_events (event_type, git_sha, metadata)
       VALUES ('pipeline_start', $1, $2)`,
      [gitSha, JSON.stringify({ node_version: process.version, pid: process.pid })]
    );
    console.log(`Deploy event logged (pipeline_start, ${gitSha || 'no-git'})`);
  } catch (err) {
    // Table may not exist yet (pre-migration) — non-fatal
    console.warn(`[deploy-event] Skip: ${err.message}`);
  }
}

async function ensureDailyBudget() {
  const dailyBudget = parseFloat(process.env.DAILY_BUDGET_USD || '20');

  const existing = await query(
    `SELECT id FROM agent_graph.budgets WHERE scope = 'daily' AND period_start = CURRENT_DATE`
  );

  if (existing.rows.length === 0) {
    await query(
      `INSERT INTO agent_graph.budgets (scope, scope_id, allocated_usd, period_start, period_end)
       VALUES ('daily', 'default', $1, CURRENT_DATE, CURRENT_DATE)`,
      [dailyBudget]
    );
    console.log(`Daily budget created: $${dailyBudget}`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
