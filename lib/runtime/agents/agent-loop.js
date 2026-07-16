import { createHash } from 'crypto';
import { hostname } from 'os';
import { createLLMClient, callProvider, computeCost as sharedComputeCost, assertRequiredProvider } from '../../llm/provider.js';
import { query, withAgentScope, isCircuitOpen } from '../../db.js';
import { reservationEstimateToRelease } from '../budget-commit.js';
import { issueAgentToken } from '../agent-jwt.js';
import { claimAndStart, transitionState } from '../state-machine.js';
import { loadContext } from '../context-loader.js';
import { resolveReentry, shouldGenerateScenarios } from '../verification/verification-gate.js';
import { subscribe, isHalted, emit } from '../event-bus.js';
import { publishEvent, startActivityStep, completeActivityStep } from '../infrastructure.js';
import { canHandle as canHandleTemplate, execute as executeTemplate } from '../template-handler.js';
import { sanitizeOutput } from '../output-sanitizer.js';
import { registerPreHook, registerPostHook } from '../hooks.js';
import { executeTool, cleanDenialCache } from '../tool-executor.js';
import { checkPermission, logCapabilityInvocation } from '../permissions.js';
import { classifyAction, getAutonomyLevel } from '../auto-classifier.js';
import { buildTickContext } from '../tick-context.js';
import { saveMemory } from '../agent-memory.js';
import { SessionCostTracker } from '../cost-tracker.js';
import { getCapability, hasCapability } from '../capability-registry.js';
import { G8QuarantineError } from '../errors.js';
import { detectSignals, isEnabled as isSignalDetectorEnabled } from '../signal-detector.js';

// ── Built-in hooks (Claude Code pattern: structural enforcement) ──────────
// P2: Infrastructure enforces. These run on EVERY tool invocation regardless
// of whether the handler remembers to call checkPermission().

registerPreHook('*', async (ctx) => {
  const allowed = await checkPermission(ctx.agentId, ctx.resourceType, ctx.resourceName);
  return allowed
    ? { allowed: true }
    : { allowed: false, reason: `Permission denied: ${ctx.agentId} lacks grant for ${ctx.resourceType}:${ctx.resourceName}` };
}, 'permission_check');

registerPostHook('*', async (ctx) => {
  logCapabilityInvocation({
    agentId: ctx.agentId,
    resourceType: ctx.resourceType,
    resourceName: ctx.resourceName,
    success: ctx.success,
    durationMs: ctx.durationMs,
    errorMessage: ctx.errorMessage,
    workItemId: ctx.workItemId,
    resultSummary: ctx.success ? 'ok' : (ctx.errorMessage || 'failed'),
  });
}, 'audit_log');

// Config: disk defaults merged with DB overrides (survives Railway deploys).
// Initial load is synchronous from disk only; async merge happens in start().
import { loadMergedConfig, clearConfigCache } from '../config-loader.js';
import { createLogger } from '../../logger.js';
import { getConfig } from '../../config/loader.js';
const log = createLogger('runtime/agent-loop');

let agentsConfig = getConfig('agents');

/**
 * Agent loop: the raw event loop from spec §4.
 *
 * Each agent runs as:
 *   while (running) {
 *     1. Check halt
 *     2. Claim + guard + transition(in_progress) — ATOMIC (Fix 4)
 *     3. Load context (tiered)
 *     4. Execute (LLM call with timeout — Fix 12)
 *     5. Transition state (completed/failed)
 *     6. Sleep or wait for event
 *   }
 *
 * No framework. No orchestration library. Just Postgres + an event loop.
 *
 * RLS enforcement (P2, Gap 5):
 *   Before handler execution, a dedicated DB connection with agent context
 *   is acquired via withAgentScope(). Available to handlers as agent.scopedQuery.
 *   Handlers should prefer agent.scopedQuery over the global query() import
 *   for any queries where RLS enforcement matters.
 */

export class AgentLoop {
  constructor(agentId, handler) {
    this.agentId = agentId;
    this.handler = handler;
    this.running = false;
    this.scopedQuery = null; // Set during handler execution
    this.runnerId = process.env.RUNNER_ID || hostname().split('.')[0].toLowerCase() || 'unknown';
    this.machineName = hostname();
    this.config = agentsConfig.agents[agentId];
    this.modelConfig = agentsConfig.models[this.config.model];
    this._llm = null; // Lazy-init on first use — avoids throwing on missing API keys at import time
    this.configHash = createHash('sha256')
      .update(JSON.stringify(this.config))
      .digest('hex')
      .slice(0, 16);
    this._wakeUp = null;
    this._unsubscribe = null;
    this._lastAuditAt = null;
    this._lastHeartbeatAt = null;  // throttle heartbeat writes to ~10s
    this._lastTickAt = null;       // STAQPRO-351: detect silent agent death
    this.TICK_GAP_WARN_MS = 120_000; // 2 min
    this._currentStepId = null;    // root activity step for the current tick
    this._currentWorkItemId = null; // work_item_id for the current tick
    this._lastDenialCleanup = null; // throttle denial cache cleanup
    // ADR-018 / STAQPRO-263: short-lived JWT for cryptographic agent identity.
    // Issued at start(), refreshed before TTL expiry, passed to withAgentScope().
    this._token = null;
    this._tokenRefreshTimer = null;
  }

  /**
   * Issue (or re-issue) the agent's JWT.
   * Tokens are 15-min TTL; refresh interval is 12 min for a 3-min safety buffer.
   * Failure here is logged but does not block tick execution — withAgentScope
   * falls back to the plain-agentId path (with a warning) until enforcement
   * mode (REQUIRE_AGENT_JWT=true) is enabled.
   */
  _issueToken() {
    try {
      // issueAgentToken returns { token, expiresAt }; we only need the string.
      const issued = issueAgentToken(this.agentId, this.config);
      this._token = issued?.token ?? null;
    } catch (err) {
      this._token = null;
      log.warn(`[${this.agentId}] JWT issuance failed: ${err.message} (falling back to plain agentId)`);
    }
  }

  /**
   * Execute a tool through the hook pipeline (Claude Code pattern).
   * Runs pre-hooks (permission, budget), executes, runs post-hooks (audit).
   * Tracks denials to prevent retry storms.
   *
   * @param {string} toolName - Tool identifier (e.g., 'gmail:send')
   * @param {Object} input - Tool input parameters
   * @param {function} execute - async (input) => result
   * @param {Object} [opts] - Additional options
   * @param {string} [opts.resourceType] - 'tool' | 'adapter' | 'api_client' | 'subprocess'
   * @param {string} [opts.resourceName] - Resource name for permission checks
   * @returns {Promise<{success: boolean, data?: *, denied?: boolean, reason?: string}>}
   */
  async execTool(toolName, input, execute, opts = {}) {
    return executeTool({
      agentId: this.agentId,
      toolName,
      resourceType: opts.resourceType || 'tool',
      resourceName: opts.resourceName || toolName.split(':')[0],
      input,
      workItemId: this._currentWorkItemId,
      execute,
    });
  }

  /** Lazy LLM client — defers API key validation to first actual call. */
  get llm() {
    if (!this._llm) {
      this._llm = createLLMClient(this.config.model, agentsConfig.models);
      assertRequiredProvider(this._llm, this.config.requireProvider, this.agentId, this.config.model);
    }
    return this._llm;
  }

  async start(opts = {}) {
    this.running = true;
    if (opts.runnerId) this.runnerId = opts.runnerId;

    // Load merged config (disk + DB overrides) before starting
    try {
      agentsConfig = await loadMergedConfig();
      this.config = agentsConfig.agents[this.agentId];
      this.modelConfig = agentsConfig.models[this.config.model];
      this._llm = null; // Reset LLM client to pick up model changes
      this.configHash = createHash('sha256')
        .update(JSON.stringify(this.config))
        .digest('hex')
        .slice(0, 16);
    } catch (err) {
      log.warn(`[${this.agentId}] Merged config load failed, using disk:`, err.message);
    }

    log.info(`[${this.agentId}] Starting agent loop (model: ${this.config.model})`);

    // STAQPRO-263 / ADR-018: issue agent JWT and schedule refresh.
    // First issuance happens here so the very first tick uses a verified token.
    // Refresh interval: 12 min (TOKEN_TTL_SECONDS in agent-jwt.js is 15 min).
    this._issueToken();
    if (this._tokenRefreshTimer) clearInterval(this._tokenRefreshTimer);
    this._tokenRefreshTimer = setInterval(() => this._issueToken(), 12 * 60 * 1000);
    if (this._tokenRefreshTimer.unref) this._tokenRefreshTimer.unref();

    // Eagerly resolve the LLM client so requireProvider mismatches fail at
    // startup instead of waiting for the first callLLM(). Skip if the agent
    // has llmEnabled:false (e.g. utility agents that never call an LLM).
    if (this.config.llmEnabled !== false) {
      try {
        // Touching the getter triggers createLLMClient + requireProvider check
        void this.llm;
      } catch (err) {
        log.error(`[${this.agentId}] Refusing to start: ${err.message}`);
        throw err;
      }
    }

    // Sync config hash to DB so guardCheck() doesn't mismatch (B4 fix)
    await query(
      `UPDATE agent_graph.agent_configs SET config_hash = $1, updated_at = now() WHERE id = $2`,
      [this.configHash, this.agentId]
    ).catch(err => log.warn(`[${this.agentId}] Config hash sync failed:`, err.message));

    // Subscribe to in-process events for instant wake-up
    this._unsubscribe = await subscribe(this.agentId, () => {
      if (this._wakeUp) this._wakeUp();
    });

    // Initial heartbeat on startup
    await this._writeHeartbeat('idle', true);

    while (this.running) {
      // STAQPRO-351: surface silent loop death in Railway logs.
      // If ticks stop firing but `this.running` stays true (e.g. the previous
      // tick deadlocked on a hung query), this never logs either — but if the
      // loop is still spinning yet ticks are taking forever (e.g. wakes were
      // dropped and we're stuck in sleep()), this fires on the next iteration.
      const now = Date.now();
      if (this._lastTickAt && now - this._lastTickAt > this.TICK_GAP_WARN_MS) {
        log.warn(`[${this.agentId}] tick gap detected: ${now - this._lastTickAt}ms since last tick`);
      }
      this._lastTickAt = now;
      try {
        await this.tick();
      } catch (err) {
        log.error(`[${this.agentId}] Loop error: type=${typeof err} msg=${err?.message} str=${String(err)}`);
        if (err?.stack) log.error(`[${this.agentId}] Stack:`, err.stack);
        else console.error(`[${this.agentId}] RAW ERROR:`, err);
        // Back off on error
        await this.sleep(5000);
      }
    }

    log.info(`[${this.agentId}] Agent loop stopped`);
  }

  async tick() {
    // Daemon mode: tick-based proactive execution (Claude Code KAIROS pattern).
    // Agent receives state snapshot and decides whether to act — no claim from queue.
    if (this.config.daemon) {
      return this.daemonTick();
    }

    // Heartbeat — throttled to every 10s
    await this._writeHeartbeat('idle');

    // Denial cache hygiene — clean expired entries every 30s
    if (!this._lastDenialCleanup || Date.now() - this._lastDenialCleanup > 30_000) {
      this._lastDenialCleanup = Date.now();
      cleanDenialCache();
    }

    // 1. Check halt — fail-closed
    if (await isHalted()) {
      log.info(`[${this.agentId}] System halted. Sleeping...`);
      await this.sleep(10000);
      return;
    }

    // Tier 1 audit: centralized with global lock + 5-min interval inside runTier1Audit()
    // Only one agent loop runs it at a time; others get { skipped: true } instantly.
    try {
      const { runTier1Audit } = await import('../../audit/tier1-deterministic.js');
      const auditResult = await runTier1Audit();
      if (auditResult.findingsCount > 0) {
        const critical = auditResult.findings.filter(f => f.severity === 'critical');
        if (critical.length > 0) {
          log.warn(`[${this.agentId}] Tier1 CRITICAL: ${critical.map(f => f.description).join('; ')}`);
        }
      }
    } catch (err) {
      // Non-fatal: audit failures should not block agent processing
      log.warn(`[${this.agentId}] Tier1 audit error:`, err.message);
    }

    // 2. Atomic claim + guard + transition(in_progress) — Fix 4
    const claimed = await claimAndStart({
      agentId: this.agentId,
      configHash: this.configHash,
      estimatedCostUsd: this.estimateCost(),
      runnerId: this.runnerId, // fleet routing: pull unrouted + this-runner work
    });

    if (!claimed) {
      // No work — sleep until event wakes us. Agents wake instantly via
      // subscribe() when new work arrives, so this is just the max idle time.
      // 3s fallback keeps p99 dispatch latency under 2s target (metric 3).
      await this.sleep(3000);
      return;
    }

    const { task, preCheck } = claimed;
    const _claimTs = Date.now(); // Timing anchor for retrospector
    log.info(`[${this.agentId}] Claimed task: ${task.event_type} (${task.work_item_id})`);

    // Update heartbeat to processing (force write)
    await this._writeHeartbeat('processing', true);

    // 3. Load context (tiered)
    let context;
    try {
      context = await loadContext(this.agentId, task.work_item_id, task.event_data || {});
    } catch (err) {
      if (err instanceof G8QuarantineError) {
        // G8 block-mode quarantine: short-circuit to a clean cancel.
        // Cancelled (not failed) so it doesn't burn the 3-retry budget — the
        // quarantine flag persists on the work item for board review.
        log.warn(`[${this.agentId}] G8 quarantine on ${task.work_item_id}: ${err.message}`);
        await transitionState({
          workItemId: task.work_item_id,
          toState: 'cancelled',
          agentId: this.agentId,
          configHash: this.configHash,
          reason: `g8_quarantine: ${err.detail.contentType} confidence=${err.detail.confidence}`,
        }).catch(tErr => log.error(`[${this.agentId}] Quarantine transition failed: ${tErr.message}`));
        return;
      }
      throw err;
    }

    // --- Verification spine: claim-time hooks (flag-gated; no-op when off) ---
    try {
      const reentry = resolveReentry(context?.workItem);
      if (reentry.abort === 'failed') {
        // A verification fix re-entered with no failure mode — never re-run blind
        // (it would "pass on luck"). Fail it for board review. (Linus blocker.)
        log.warn(`[${this.agentId}] verification fix ${task.work_item_id} has no failure mode — failing (no blind re-run)`);
        await transitionState({
          workItemId: task.work_item_id,
          toState: 'failed',
          agentId: this.agentId,
          configHash: this.configHash,
          reason: 'verification fix re-entered without a failure mode',
        }).catch(tErr => log.error(`[${this.agentId}] reentry-fail transition error: ${tErr.message}`));
        return;
      }
      if (reentry.fixInstruction && context?.workItem) {
        // Inject the failure mode so the implementer fixes the right thing.
        context.fixInstruction = reentry.fixInstruction;
        context.workItem.description =
          `FIX THIS (verification failed): ${reentry.fixInstruction}\n\n${context.workItem.description || ''}`;
      } else if (shouldGenerateScenarios(context?.workItem, this.agentId)) {
        // Generate acceptance scenarios for verify-eligible work at claim time: the
        // implementer sees the visible (happy-path) set; the tester later checks the
        // withheld (edge-case) set. Heavy dep → dynamic import. Non-fatal on error.
        try {
          const { generateScenarios } = await import('../verification/scenario-factory.js');
          const intent = `${context.workItem.title || ''}\n${context.workItem.description || ''}`.trim();
          const { visible } = await generateScenarios({
            workItemId: task.work_item_id,
            intent,
            dataClassification: context.workItem.data_classification,
          });
          context.workItem.acceptance_criteria = {
            generated_by: 'scenario-factory',
            scenarios: visible.map((s) => ({ given: s.given, when: s.when, then: s.then })),
          };
        } catch (facErr) {
          log.warn(`[${this.agentId}] scenario factory failed for ${task.work_item_id}: ${facErr.message}`);
        }
      }
    } catch (vErr) {
      log.warn(`[${this.agentId}] verification claim-hook error: ${vErr.message}`);
    }

    // Open the root activity step for this task.
    // If a parent_activity_step_id was set by the agent that created this work item,
    // attach under it — this produces cross-agent step hierarchy.
    const parentActivityStepId = context?.workItem?.metadata?.parent_activity_step_id ?? null;
    this._currentWorkItemId = task.work_item_id;
    this._currentStepId = await startActivityStep(
      task.work_item_id,
      `${this.agentId}: ${task.event_type}`,
      { type: 'task_execution', agentId: this.agentId, parentStepId: parentActivityStepId }
    );

    // Routing class enforcement: DETERMINISTIC tasks skip LLM entirely
    const routingClass = context?.workItem?.routing_class || task.event_data?.routing_class || null;
    if (routingClass === 'DETERMINISTIC' && canHandleTemplate(context?.workItem || task)) {
      log.info(`[${this.agentId}] DETERMINISTIC task — using template handler (no LLM)`);
      const templateResult = executeTemplate(context?.workItem || task, context);

      // Record routing_class_actual for misclassification tracking
      await query(
        `UPDATE agent_graph.work_items SET routing_class_actual = 'DETERMINISTIC' WHERE id = $1`,
        [task.work_item_id]
      ).catch(err => log.warn(`[${this.agentId}] routing_class_actual update failed:`, err.message));

      await completeActivityStep(this._currentStepId, { metadata: { template: true, routing_class: 'DETERMINISTIC' } });
      this._currentStepId = null;
      this._currentWorkItemId = null;

      if (templateResult.success) {
        await transitionState({
          workItemId: task.work_item_id,
          toState: 'completed',
          agentId: this.agentId,
          configHash: this.configHash,
          reason: templateResult.reason,
          costUsd: 0,
          guardrailChecks: { pre: preCheck, post: { passed: true, reason: 'template-deterministic', checks: [] } },
        });
        log.info(`[${this.agentId}] Task ${task.work_item_id} → completed (DETERMINISTIC template, $0)`);
      } else {
        log.warn(`[${this.agentId}] Template handler failed, falling through to LLM: ${templateResult.reason}`);
        // Fall through — don't return, let normal LLM execution handle it
        // Reset activity step for LLM path
        this._currentStepId = await startActivityStep(
          task.work_item_id,
          `${this.agentId}: ${task.event_type} (LLM fallback)`,
          { type: 'task_execution', agentId: this.agentId, parentStepId: parentActivityStepId }
        );
      }
      if (templateResult.success) return;
    }

    // LIGHTWEIGHT routing: reduce maxTokens for lighter tasks
    const lightweightOverride = routingClass === 'LIGHTWEIGHT' ? { maxTokens: Math.min(this.config.maxTokens, 1024) } : {};

    // G9: Auto-classifier — YOLO permission check (Claude Code pattern).
    // Runs POST-CLAIM, PRE-EXECUTION (NOT inside guardCheck() transaction).
    // Decision table handles 90% of cases at O(1); LLM fallback for ambiguous.
    // L0 = all review (current default). L1+ = graduated auto-allow.
    //
    // No outer try/catch: classifyAction() handles its own errors internally
    // and returns {decision: 'review'} on failure (fail-closed, P1).
    // An outer catch would swallow that and make it fail-open. (Neo review fix #2)
    const autonomyLevel = await getAutonomyLevel();
    if (autonomyLevel !== 'L0') {
      const classification = await classifyAction({
        agentId: this.agentId,
        task,
        autonomyLevel,
        // Only pass structured agent-controlled fields — no user content (Neo review fix #4)
        context: { eventType: task.event_type, workItemId: task.work_item_id },
      });

      if (classification.decision === 'deny') {
        log.warn(`[${this.agentId}] G9 DENIED: ${classification.reason}`);
        await completeActivityStep(this._currentStepId, { status: 'failed', metadata: { g9_denied: true, reason: classification.reason } });
        this._currentStepId = null;
        this._currentWorkItemId = null;
        await transitionState({
          workItemId: task.work_item_id,
          toState: 'failed',
          agentId: this.agentId,
          configHash: this.configHash,
          reason: `G9 auto-classifier denied: ${classification.reason}`,
        });
        return;
      }

      if (classification.decision === 'review') {
        // Route to reviewer agent instead of executing directly
        log.info(`[${this.agentId}] G9 REVIEW: ${classification.reason} — routing to reviewer`);
        // Mark for review but don't block (log-only in Phase 1)
      }
    }

    // 4. Execute — delegate to agent-specific handler
    // P2: Acquire dedicated connection with RLS agent context before handler runs.
    // All handler query() calls should use this.scopedQuery when available.
    // STAQPRO-263 / ADR-018: pass the JWT (preferred) so withAgentScope can
    // verify identity cryptographically; fall back to plain agentId if the
    // token couldn't be issued (warning logged downstream).
    let result;
    const estimatedCost = this.estimateCost();
    const scopedQuery = await withAgentScope(this._token || this.agentId);
    this.scopedQuery = scopedQuery;
    // Store account context for budget tracking in callLLM (multi-account support)
    this._currentAccountId = context?.accountId || null;
    this._lightweightOverride = lightweightOverride;
    // Track whether commit_budget was called (via callLLM) so we don't
    // release an already-committed reservation on failure.
    this._budgetCommitted = false;
    try {
      result = await this.handler(task, context, this);
    } catch (err) {
      log.error(`[${this.agentId}] Execution error:`, err.message);
      await completeActivityStep(this._currentStepId, { status: 'failed', metadata: { error: err.message } });
      this._currentStepId = null;
      this._currentWorkItemId = null;
      // Release budget reservation on failure — but only if commit_budget
      // hasn't already converted the reservation to actual spend.
      if (!this._budgetCommitted) {
        await query(`SELECT agent_graph.release_budget($1, $2)`, [estimatedCost, context?.accountId || null])
          .catch(releaseErr => log.error(`[${this.agentId}] Budget release failed:`, releaseErr.message));
      }
      if (task.event_type !== 'state_changed') {
        await this._handleExecutionFailure(task, err);
      } else {
        log.error(`[${this.agentId}] Event ${task.event_type} handler failed: ${err.message}`);
      }
      return;
    } finally {
      // STAQPRO-307: release is now async (COMMITs the per-scope tx).
      // Awaiting ensures the tx finishes before the next tick acquires
      // a fresh scope.
      await scopedQuery.release();
      this.scopedQuery = null;
      this._lightweightOverride = null;
    }

    // 5. Check handler result — default to failure (B6 fix: undefined must not succeed)
    let succeeded = result?.success === true;

    // 6. Post-execution guard checks (spec §4 step 6)
    let postCheck = result?.postCheck || {};
    if (succeeded) {
      postCheck = await this.postExecutionChecks(task, result);

      // Record actual routing class for LLM-executed tasks
      const actualRouting = routingClass || 'FULL';
      await query(
        `UPDATE agent_graph.work_items SET routing_class_actual = $1 WHERE id = $2`,
        [actualRouting, task.work_item_id]
      ).catch(err => log.warn(`[${this.agentId}] routing_class_actual update failed:`, err.message));

      if (!postCheck.passed) {
        log.warn(`[${this.agentId}] Post-execution check failed: ${postCheck.reason}`);
        succeeded = false;
      }
    }

    if (!succeeded) {
      const failReason = result?.reason || postCheck?.reason || 'Handler returned failure';
      await completeActivityStep(this._currentStepId, { status: 'failed', metadata: { reason: failReason } });
      this._currentStepId = null;
      this._currentWorkItemId = null;
      // Release budget reservation on handler failure — but only if commit_budget
      // hasn't already converted the reservation to actual spend.
      if (!this._budgetCommitted) {
        await query(`SELECT agent_graph.release_budget($1, $2)`, [estimatedCost, context?.accountId || null])
          .catch(releaseErr => log.error(`[${this.agentId}] Budget release failed:`, releaseErr.message));
      }

      if (task.event_type !== 'state_changed') {
        await this._handleExecutionFailure(task, new Error(failReason));
      } else {
        log.info(`[${this.agentId}] Event ${task.event_type} (${task.work_item_id}) → failed (event-only, no transition)`);
      }
      return;
    }

    // Extract decision context from handler result for activity step enrichment.
    // This surfaces what the agent actually DECIDED in the Runs graph and Activity feed,
    // not just the mechanical event type (task_assigned, state_changed, etc.).
    const decisionContext = this._extractDecisionContext(result, task);

    // Skip state transition for event-only events. For these, work_item_id does
    // NOT refer to a work item this agent owns and just completed:
    //  - state_changed: refers to the original (already completed/failed) task.
    //  - task_routing (A-prime, ADR-008): refers to the bridge's autonomous
    //    work_item, which the orchestrator just ASSIGNED to an executor — it must
    //    stay in created/assigned so the executor can claim it. Transitioning it
    //    to completed here would strand the obligation.
    // The event is already marked processed via task_events.processed_at.
    if (task.event_type === 'state_changed' || task.event_type === 'task_routing') {
      await completeActivityStep(this._currentStepId, { metadata: decisionContext });
      this._currentStepId = null;
      this._currentWorkItemId = null;
      log.info(`[${this.agentId}] Event ${task.event_type} (${task.work_item_id}) → completed (event-only, no transition)`);

      // Close the signal→action loop (ADR-008, Stream B reverse edge): if this
      // terminal work_item was bridge-spawned (metadata.source_signal_id), resolve
      // the source obligation + move its board card. resolveSignalForWorkItem
      // no-ops for non-bridge items and derives the terminal state from the row.
      // Best-effort — never block the orchestrator loop. Dynamic import keeps the
      // hot path cheap (mirrors the retrospector pattern below). Only for
      // state_changed: task_routing fires BEFORE the executor runs, so there is no
      // terminal state to resolve yet (the eventual completion arrives as its own
      // state_changed event and is resolved then).
      if (task.event_type === 'state_changed') {
        try {
          const { resolveSignalForWorkItem } = await import('../signal-resolver.js');
          await resolveSignalForWorkItem({ query, workItemId: task.work_item_id });
        } catch (resolveErr) {
          log.warn(`[${this.agentId}] signal-resolver failed for ${task.work_item_id}: ${resolveErr.message}`);
        }
      }
    } else {
      const transitioned = await transitionState({
        workItemId: task.work_item_id,
        toState: 'completed',
        agentId: this.agentId,
        configHash: this.configHash,
        reason: result?.reason || 'Task completed',
        costUsd: result?.costUsd || 0,
        guardrailChecks: { pre: preCheck, post: postCheck },
      });
      await completeActivityStep(this._currentStepId, transitioned
        ? { metadata: decisionContext }
        : { status: 'failed', metadata: { reason: 'state transition failed', ...decisionContext } });
      this._currentStepId = null;
      this._currentWorkItemId = null;
      log.info(`[${this.agentId}] Task ${task.work_item_id} → completed (${transitioned ? 'ok' : 'FAILED'})`);

      // Broadcast completion for cross-concern subscribers (e.g., Telegram push-back)
      if (transitioned) {
        await emit({
          eventType: 'task_completed',
          workItemId: task.work_item_id,
          targetAgentId: '*',
          priority: 0,
          eventData: { agent: this.agentId },
        }).catch(() => {}); // non-critical

        // Retrospective: auto-assess task outcome (fire-and-forget, P2 enforced via G11)
        // Hermes-inspired feedback loop, built natively. Decision table handles 90% at $0 cost.
        try {
          const { retrospect } = await import('../retrospector.js');
          retrospect({
            agentId: this.agentId,
            workItemId: task.work_item_id,
            success: !!transitioned,
            durationMs: Date.now() - _claimTs,
            result,
            eventType: task.event_type,
            costUsd: result?.costUsd || 0,
            retryCount: task.metadata?.retry_count || 0,
          }).catch(() => {}); // non-fatal, never block pipeline
        } catch {
          // retrospector.js may not exist (graceful degradation)
        }

        // Reflection: higher-tier agents learn from outcomes (Step 3)
        // P2 CONSTRAINT (Linus review): _reflectionContext may contain Neo4j graph data.
        // Graph data is advisory only — NEVER use for enforcement decisions.
        // When injecting into LLM prompts, cap at ~500 chars and use summaries, not raw records.
        try {
          if (typeof this.handler.reflect === 'function') {
            await this.handler.reflect(this, { workItemId: task.work_item_id, result, costUsd: result?.costUsd });
          }
        } catch (reflectErr) {
          // Non-fatal: reflection failure should not block pipeline
          log.warn(`[${this.agentId}] Reflection error:`, reflectErr.message);
        }

        // Agent memory: save explicit learnings (Claude Code memdir pattern).
        // Only saves when handlers explicitly return a `memory` field — not every
        // completion reason, which would fill memory with low-signal event logs.
        // Handlers with genuine learnings opt in:
        //   return { success: true, memory: { type: 'pattern', content: 'When X, do Y' } }
        // (Neo review fix #3: quality gate on memory saves)
        if (result?.memory && result.memory.content) {
          saveMemory({
            agentId: this.agentId,
            type: result.memory.type || 'pattern',
            content: result.memory.content.slice(0, 500),
            workItemId: task.work_item_id,
            metadata: { costUsd: result?.costUsd, eventType: task.event_type, ...(result.memory.metadata || {}) },
          }).catch(() => {}); // non-fatal, fire-and-forget
        }

        // Post-completion Linear sync: safety net for board-dispatched tasks
        // whose handlers don't have built-in Linear integration.
        // executor-coder handles its own Linear updates (lines 292-314),
        // so this only fires for other agents with board_command metadata.
        await this._syncLinearOnCompletion(task).catch(err => {
          log.warn(`[${this.agentId}] Linear post-completion sync error:`, err.message);
        });

        // gbrain B1: signal detector — ambient capture on every agent message.
        // Runs OUTSIDE the main handler's scopedQuery (which was released in the
        // `finally` block on line ~511 — see the `scopedQuery.release()` call).
        // Acquires its own short-lived scope so RLS context (app.agent_id,
        // app.org) is set for any inbox.signals / signal.contacts writes that
        // future migrations may guard with policies.
        //
        // P1 (Deny by default): gated by SIGNAL_DETECTOR_ENABLED env. Default OFF.
        // Non-blocking contract: any failure logs at warn-level and does NOT
        // propagate to the agent tick. The tick is already `transitioned=true`
        // by the time we reach this point, so detector errors cannot rewind
        // task completion.
        if (isSignalDetectorEnabled()) {
          try {
            // Source the message: handlers may opt-in by returning
            //   { detectorPayload: { messageId, body, classification } }
            // Fall back to context.email (the canonical incoming-message shape
            // for inbox flows). This avoids dispatching the detector on tasks
            // that have no semantic message attached (e.g. internal directives).
            const payload = result?.detectorPayload || null;
            const fallbackEmail = context?.email || null;
            const messageId = payload?.messageId || fallbackEmail?.id || null;
            const body = payload?.body
              || fallbackEmail?.snippet
              || fallbackEmail?.body
              || null;
            const hints = {
              classification: payload?.classification
                || fallbackEmail?.triage_category
                || null,
            };

            if (messageId && body) {
              // Tenant resolution: prefer the email's owner_id (already a UUID),
              // fall back to looking up the account → owner_id mapping. Match the
              // pattern from agents/executor-{responder,contract,writer}/index.js.
              let ownerId = fallbackEmail?.owner_id || null;
              const accountId = fallbackEmail?.account_id
                || context?.accountId
                || context?.workItem?.metadata?.account_id
                || null;
              if (!ownerId && accountId) {
                try {
                  const r = await query(
                    `SELECT owner_id FROM inbox.accounts WHERE id = $1`,
                    [accountId],
                  );
                  ownerId = r.rows[0]?.owner_id || null;
                } catch {
                  // ownerId stays null — detector still runs, writes carry
                  // owner_id=null in metadata which is honest.
                }
              }

              const detectorScope = await withAgentScope(this._token || this.agentId);
              try {
                await detectSignals({
                  message: body,
                  workItem: context?.workItem || { id: task.work_item_id },
                  messageId,
                  agentId: this.agentId,
                  ownerId,
                  scopedQuery: detectorScope,
                  hints,
                });
              } finally {
                await detectorScope.release().catch(() => {});
              }
            }
          } catch (sdErr) {
            // Non-fatal — the tick is already completed. Log loudly so a
            // misbehaving detector surfaces in observability without
            // affecting the agent's primary contract.
            log.warn(`[${this.agentId}] signal-detector error (non-fatal): ${sdErr.message}`);
          }
        }
      }
    }
  }

  /**
   * Daemon tick: proactive execution mode (Claude Code KAIROS pattern).
   * Receives a state snapshot and decides whether to act.
   * Budget-capped per tick to prevent runaway spending.
   */
  async daemonTick() {
    await this._writeHeartbeat('idle');

    // Respect daemon tick interval
    const tickInterval = this.config.daemon?.tickIntervalMs || 300_000; // 5 min default
    if (this._lastDaemonTickAt && Date.now() - this._lastDaemonTickAt < tickInterval) {
      await this.sleep(Math.min(tickInterval / 2, 10_000));
      return;
    }
    this._lastDaemonTickAt = Date.now();

    // Check halt
    if (await isHalted()) {
      await this.sleep(10000);
      return;
    }

    // Build tick context (parallel queries — all independent)
    const tickCtx = await buildTickContext(this.agentId, {
      lastActionAt: this._lastDaemonActionAt,
    });

    // No alerts and no idle threshold exceeded — sleep
    const idleThreshold = this.config.daemon?.idleThresholdMs || 3600_000; // 1 hour default
    if (tickCtx.alerts.length === 0 && tickCtx.timeSinceLastAction && tickCtx.timeSinceLastAction < idleThreshold) {
      // Log tick decision (fire-and-forget)
      this._logDaemonTick('skipped', tickCtx.alerts.length);
      await this.sleep(tickInterval);
      return;
    }

    // Budget enforcement: SessionCostTracker with hard cutoff (Neo review fix #1)
    const tickBudget = this.config.daemon?.tickBudgetUsd || 0.05;
    const costTracker = new SessionCostTracker(this.agentId);

    // Ask the agent handler what to do with this context
    await this._writeHeartbeat('processing', true);

    const stepId = await startActivityStep(
      null, // No work item for daemon ticks
      `${this.agentId}: daemon tick`,
      { type: 'daemon_tick', agentId: this.agentId }
    );

    try {
      // Inject cost tracker so handler can check budget
      tickCtx._costTracker = costTracker;
      tickCtx._tickBudgetUsd = tickBudget;

      const result = await this.handler(
        { event_type: 'daemon_tick', event_data: tickCtx, work_item_id: null },
        tickCtx,
        this,
      );

      // Track cost from handler result
      if (result?.costUsd) await costTracker.add(result.costUsd);

      // Enforce budget cap — log violation for governance visibility
      if (!costTracker.checkBudget(tickBudget)) {
        log.warn(`[${this.agentId}] Daemon tick exceeded budget: $${costTracker.totals().costUsd.toFixed(4)} > $${tickBudget}`);
        await publishEvent(
          'budget_exceeded',
          `Daemon tick exceeded per-tick budget ($${costTracker.totals().costUsd.toFixed(4)} > $${tickBudget})`,
          this.agentId,
          null,
          { costUsd: costTracker.totals().costUsd, budgetUsd: tickBudget },
        ).catch(() => {});
      }

      if (result?.acted) {
        this._lastDaemonActionAt = Date.now();
        this._logDaemonTick('acted', tickCtx.alerts.length);
      } else {
        this._logDaemonTick('deferred', tickCtx.alerts.length);
      }

      await completeActivityStep(stepId, {
        metadata: { acted: result?.acted || false, alerts: tickCtx.alerts.length, costUsd: costTracker.totals().costUsd },
      });
    } catch (err) {
      log.error(`[${this.agentId}] Daemon tick error: ${err.message}`);
      await completeActivityStep(stepId, { status: 'failed', metadata: { error: err.message } });
    }

    await this.sleep(tickInterval);
  }

  /** Log daemon tick decision (fire-and-forget). */
  _logDaemonTick(decision, alertCount) {
    query(
      `INSERT INTO agent_graph.daemon_ticks (agent_id, decision, alert_count)
       VALUES ($1, $2, $3)`,
      [this.agentId, decision, alertCount]
    ).catch(() => {}); // table may not exist yet
  }

  /**
   * Handle execution failure with retry logic (spec §11: retry up to 3 times).
   * If retry_count < MAX_RETRIES, transition failed -> assigned and re-queue.
   * Otherwise mark terminal failed and publish an infrastructure_error event.
   */
  async _handleExecutionFailure(task, err) {
    const MAX_EXECUTION_RETRIES = 3;
    const errMsg = (err.message || 'Unknown error').slice(0, 500);

    // Check current retry state — bail if work item disappeared
    const retryResult = await query(
      `SELECT retry_count FROM agent_graph.work_items WHERE id = $1`,
      [task.work_item_id]
    );
    if (!retryResult.rows[0]) {
      log.error(`[${this.agentId}] Work item ${task.work_item_id} disappeared during failure handling`);
      return;
    }
    const retryCount = retryResult.rows[0].retry_count ?? 0;

    // Step 1: Transition in_progress -> failed (always required)
    const failedOk = await transitionState({
      workItemId: task.work_item_id,
      toState: 'failed',
      agentId: this.agentId,
      configHash: this.configHash,
      reason: retryCount < MAX_EXECUTION_RETRIES
        ? `Execution error (retry ${retryCount + 1}/${MAX_EXECUTION_RETRIES}): ${errMsg}`
        : `Execution error (retries exhausted): ${errMsg}`,
    });

    if (!failedOk) {
      log.error(`[${this.agentId}] Failed to transition ${task.work_item_id} to failed state`);
      return;
    }

    if (retryCount < MAX_EXECUTION_RETRIES) {
      // Step 2: Retry — transition failed -> assigned and re-queue
      try {
        const assignedOk = await transitionState({
          workItemId: task.work_item_id,
          toState: 'assigned',
          agentId: this.agentId,
          configHash: this.configHash,
          reason: `Auto-retry ${retryCount + 1}/${MAX_EXECUTION_RETRIES}`,
        });

        if (!assignedOk) {
          log.error(`[${this.agentId}] Failed to re-assign ${task.work_item_id} for retry`);
          return;
        }

        // Increment retry count + emit re-queue event
        await query(
          `UPDATE agent_graph.work_items SET retry_count = retry_count + 1 WHERE id = $1`,
          [task.work_item_id]
        );

        await emit({
          eventType: 'task_assigned',
          workItemId: task.work_item_id,
          targetAgentId: this.agentId,
          priority: 0,
          eventData: { retry: retryCount + 1, reason: 'execution_retry', error: errMsg },
        });

        log.info(`[${this.agentId}] Task ${task.work_item_id} failed → auto-retry ${retryCount + 1}/${MAX_EXECUTION_RETRIES}`);
      } catch (retryErr) {
        // Retry mechanism itself failed — task stays in failed state (not orphaned)
        log.error(`[${this.agentId}] Retry mechanism failed for ${task.work_item_id}: ${retryErr.message}`);
      }
    } else {
      // Terminal failure — publish event for governance feed visibility
      await publishEvent(
        'infrastructure_error',
        `Task failed after ${MAX_EXECUTION_RETRIES} retries: ${errMsg}`,
        this.agentId,
        task.work_item_id,
        { error: errMsg, retries_exhausted: MAX_EXECUTION_RETRIES, agent: this.agentId },
      ).catch(pubErr => log.error(`[${this.agentId}] Failed to publish failure event:`, pubErr.message));

      log.error(`[${this.agentId}] Task ${task.work_item_id} failed permanently after ${MAX_EXECUTION_RETRIES} retries: ${errMsg}`);
    }
  }

  /**
   * Call the LLM provider and track the invocation.
   * Fix 12: AbortController with 120s timeout.
   * Fix 13: Deterministic idempotency key.
   * ADR-020: Multi-provider support via provider abstraction.
   */
  async callLLM(systemPrompt, userMessage, opts = {}) {
    const taskId = opts.taskId || 'unknown';

    // Per-call model override — built on demand for handlers that need a
    // different model for specific kinds of work (e.g. triage swapping to
    // Opus on long meeting transcripts where Sonnet over-consolidates).
    // Falls back to the agent's configured default model.
    const useOverride = opts.modelOverride && opts.modelOverride !== this.config.model;
    const llmClient = useOverride
      ? createLLMClient(opts.modelOverride, agentsConfig.models)
      : this.llm;
    const modelKey = useOverride ? opts.modelOverride : this.config.model;
    const modelConfig = useOverride ? agentsConfig.models[opts.modelOverride] : this.modelConfig;

    // Idempotency key includes the model so that re-running with a different
    // model (e.g. webhook override) doesn't dedup against the original entry.
    const idempotencyKey = opts.idempotencyKey || `${this.agentId}-${taskId}-${llmClient.provider}-${this.configHash}-${modelKey}`;

    // Fix 12: abort after 120 seconds
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);

    const llmStepId = await startActivityStep(
      this._currentWorkItemId,
      `LLM call (${modelKey})`,
      { type: 'llm_call', agentId: this.agentId, parentStepId: this._currentStepId }
    );

    const start = Date.now();
    let response;
    try {
      response = await callProvider(llmClient, {
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
        maxTokens: opts.maxTokens || this._lightweightOverride?.maxTokens || this.config.maxTokens,
        temperature: opts.temperature ?? this.config.temperature,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    const latencyMs = Date.now() - start;

    const { inputTokens, outputTokens, text: responseText, stopReason } = response;
    const costUsd = sharedComputeCost(inputTokens, outputTokens, modelConfig);

    // Track invocation
    const promptHash = createHash('sha256').update(systemPrompt + userMessage).digest('hex').slice(0, 16);
    const responseHash = createHash('sha256').update(responseText).digest('hex').slice(0, 16);

    const llmAccountId = opts.accountId || this._currentAccountId || null;
    await query(
      `INSERT INTO agent_graph.llm_invocations
       (agent_id, task_id, model, input_tokens, output_tokens, cost_usd, prompt_hash, response_hash, latency_ms, idempotency_key, account_id, provider)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [this.agentId, taskId, modelKey, inputTokens, outputTokens, costUsd, promptHash, responseHash, latencyMs, idempotencyKey, llmAccountId, llmClient.provider]
    );

    // Convert budget reservation to actual spend (spec S5: atomic budget, account-aware).
    // spent_usd accumulates the real costUsd on EVERY call, but the reservation
    // (estimated portion) must be released only ONCE per task — a handler that
    // calls callLLM more than once would otherwise decrement reserved_usd
    // repeatedly for a reservation that was only made once. Guard the estimate
    // on _budgetCommitted; commit_budget(0, actual, acct) decrements reserved by
    // 0 (no SQL change needed).
    const estimatedToRelease = reservationEstimateToRelease(
      this._budgetCommitted,
      opts.estimatedCostUsd || this.estimateCost()
    );
    await query(
      `SELECT agent_graph.commit_budget($1, $2, $3)`,
      [estimatedToRelease, costUsd, llmAccountId]
    );
    // Mark reservation as committed so tick() doesn't double-release on failure
    // and so subsequent callLLM invocations in the same task don't re-release it.
    this._budgetCommitted = true;

    await completeActivityStep(llmStepId, {
      metadata: { input_tokens: inputTokens, output_tokens: outputTokens, cost_usd: costUsd, latency_ms: latencyMs },
    });

    return {
      text: responseText,
      inputTokens,
      outputTokens,
      costUsd,
      latencyMs,
      stopReason,
    };
  }

  computeCost(inputTokens, outputTokens) {
    return sharedComputeCost(inputTokens, outputTokens, this.modelConfig);
  }

  estimateCost() {
    // Subscription agents (claudeCode/spawnCLI) have no marginal per-token cost —
    // skip budget reservation so G1 doesn't block flat-rate work.
    if (this.config.claudeCode) return 0;

    // API agents: conservative estimate for guard check
    const mc = this.modelConfig;
    return (4000 * mc.inputCostPer1M / 1_000_000) +
           (2000 * mc.outputCostPer1M / 1_000_000);
  }

  /**
   * Post-execution guard checks (spec §4 step 6).
   * Validates agent output before allowing state transition to completed.
   */
  async postExecutionChecks(task, result) {
    const checks = [];

    // Check: handler returned a valid result shape
    if (typeof result !== 'object' || result === null) {
      return { passed: false, reason: 'Handler returned non-object result', checks };
    }

    // Check: if agent created subtasks, verify they were assigned to valid agents
    if (result._createdSubtasks) {
      for (const subtask of result._createdSubtasks) {
        const validAgents = Object.keys(agentsConfig.agents);
        if (subtask.assignedTo && !validAgents.includes(subtask.assignedTo)) {
          checks.push({ check: 'can_assign_to', passed: false, detail: `Invalid agent: ${subtask.assignedTo}` });
        }
      }
    }

    // Check: verify work item hasn't been quarantined during execution
    const workItemResult = await query(
      `SELECT output_quarantined, acceptance_criteria FROM agent_graph.work_items WHERE id = $1`,
      [task.work_item_id]
    ).catch(() => ({ rows: [] }));

    if (workItemResult.rows[0]?.output_quarantined) {
      checks.push({ check: 'quarantine', passed: false, detail: 'Output quarantined during execution' });
    }

    // Completeness check removed — keyword frequency matching on JSON-serialized
    // results was governance theater (e.g., passes if "email" appears enough times).
    // TODO: Replace with LLM-based completeness check behind a feature flag.

    // Output sanitization: strip diligence theater (Figma findings defense)
    // This is cleanup, not rejection — sanitized output replaces the original.
    if (result.result && typeof result.result === 'string') {
      const sanitization = sanitizeOutput(result.result, task.event_type);
      if (sanitization.strippedContent.length > 0) {
        log.info(`[${this.agentId}] Output sanitized: stripped ${sanitization.strippedContent.length} lines (${sanitization.patterns.join(', ')})`);
        result.result = sanitization.sanitized;
        checks.push({
          check: 'output_sanitization',
          passed: true, // Sanitization is cleanup, not failure
          detail: `Stripped ${sanitization.strippedContent.length} theater lines`,
          sanitization: {
            strippedContent: sanitization.strippedContent,
            patterns: sanitization.patterns,
            version: sanitization.version,
          },
        });
      }
    }

    const failedChecks = checks.filter(c => !c.passed);
    return {
      passed: failedChecks.length === 0,
      reason: failedChecks.length > 0 ? failedChecks.map(c => c.detail).join('; ') : 'all post-checks passed',
      checks,
    };
  }

  /**
   * Extract decision context from a handler result for activity step enrichment.
   * Surfaces what the agent DECIDED — not just what happened mechanically.
   *
   * Each agent returns different fields. This method normalizes them into a
   * structured `decision` object that the Board can render meaningfully:
   *
   *   orchestrator: { action: 'routed', target: 'executor-intake', method: 'deterministic' }
   *   executor-intake: { action: 'classified', classification: 'noise', confidence: 0.95 }
   *   executor-responder: { action: 'drafted', draft_id: '...', tone_score: 0.87 }
   *   reviewer: { action: 'reviewed', verdict: 'approved' }
   *   executor-ticket: { action: 'created_ticket', linear_url: '...', github_url: '...' }
   */
  _extractDecisionContext(result, task) {
    if (!result || typeof result !== 'object') return {};

    const ctx = {};

    // Core decision summary — always include reason and cost
    if (result.reason) ctx.reason = result.reason.slice(0, 500);
    if (result.costUsd) ctx.cost_usd = result.costUsd;

    // Routing decisions (orchestrator)
    if (result.routing_method) ctx.routing_method = result.routing_method;
    if (result._createdSubtasks?.length) {
      ctx.routed_to = result._createdSubtasks.map(s => s.assignedTo).filter(Boolean);
    }

    // Classification (executor-intake, executor-triage)
    if (result.classification) ctx.classification = result.classification;
    if (result.triage_result) ctx.triage_result = result.triage_result;
    if (result.complexity) ctx.complexity = result.complexity;
    if (result.confidence != null) ctx.confidence = result.confidence;
    if (result.recommended_action) ctx.recommended_action = result.recommended_action;

    // Draft output (executor-responder)
    if (result.draft_id) ctx.draft_id = result.draft_id;
    if (result.tone_score != null) ctx.tone_score = result.tone_score;
    if (result.draft_intent) ctx.draft_intent = result.draft_intent;

    // Review verdict (reviewer)
    if (result.verdict) ctx.verdict = result.verdict;
    if (result.reviewer_verdict) ctx.verdict = result.reviewer_verdict;

    // Ticket creation (executor-ticket)
    if (result.ticket_result) {
      ctx.ticket = {
        linear_url: result.ticket_result.linear_url,
        github_url: result.ticket_result.github_issue_url,
        title: result.ticket_result.title,
        category: result.ticket_result.category,
      };
    }
    if (result.linear_url) ctx.linear_url = result.linear_url;
    if (result.github_pr_url) ctx.github_pr_url = result.github_pr_url;

    // Archive action (orchestrator auto-archive)
    if (result.archived) ctx.action = 'archived';
    if (result.auto_archived) ctx.action = 'auto_archived';

    // Summarize as a one-line decision for quick display
    ctx.summary = this._summarizeDecision(ctx, task);

    return Object.keys(ctx).length > 1 ? ctx : {}; // Don't store empty context
  }

  /** One-line human-readable summary of what happened. */
  _summarizeDecision(ctx, task) {
    if (ctx.verdict) return `Verdict: ${ctx.verdict}`;
    if (ctx.classification) return `Classified: ${ctx.classification}${ctx.confidence ? ` (${Math.round(ctx.confidence * 100)}%)` : ''}`;
    if (ctx.triage_result?.category) return `Triaged: ${ctx.triage_result.category}`;
    if (ctx.routed_to?.length) return `Routed → ${ctx.routed_to.join(', ')}`;
    if (ctx.draft_id) return `Draft created${ctx.tone_score ? ` (tone: ${ctx.tone_score})` : ''}`;
    if (ctx.ticket) return `Ticket: ${ctx.ticket.title || 'created'}`;
    if (ctx.action === 'auto_archived' || ctx.action === 'archived') return 'Auto-archived (noise)';
    if (ctx.github_pr_url) return `PR created`;
    if (ctx.reason) return ctx.reason.slice(0, 100);
    return null;
  }

  /**
   * Post-completion Linear sync for board-dispatched tasks.
   * Only fires if:
   *   1. The work item has metadata.linear_issue_id
   *   2. The work item source is 'board_command'
   *   3. The current agent is NOT executor-coder (which handles its own Linear sync)
   */
  async _syncLinearOnCompletion(task) {
    // executor-coder handles its own Linear updates
    if (this.agentId === 'executor-coder') return;

    const workItemResult = await query(
      `SELECT metadata FROM agent_graph.work_items WHERE id = $1`,
      [task.work_item_id]
    );
    const metadata = workItemResult.rows[0]?.metadata;
    if (!metadata?.linear_issue_id || metadata?.source !== 'board_command') return;
    if (!hasCapability('linear/client')) return;

    const { updateIssueStateByName, addBotComment } = getCapability('linear/client');

    // Move to "Delivered" (team-aware)
    await updateIssueStateByName(metadata.linear_issue_id, 'Delivered');
    await addBotComment(metadata.linear_issue_id,
      `**Task completed by ${this.agentId}.**\n\n` +
      `_Processed via Optimus agent pipeline._`
    );

    log.info(`[${this.agentId}] Linear issue ${metadata.linear_issue_id} → Delivered`);
  }

  /**
   * Write heartbeat to DB (throttled to every 30s, fire-and-forget).
   * Non-blocking: never holds a connection while the agent loop waits.
   * Was 10s + awaited — caused pool starvation when Supabase was slow (30-55s per INSERT).
   */
  async _writeHeartbeat(status, force = false) {
    const now = Date.now();
    if (!force && this._lastHeartbeatAt && now - this._lastHeartbeatAt < 30_000) return;
    if (isCircuitOpen()) return;
    this._lastHeartbeatAt = now;
    // Fire-and-forget — never await heartbeats
    query(
      `INSERT INTO agent_graph.agent_heartbeats
         (agent_id, runner_id, heartbeat_at, status, pid, machine_name)
       VALUES ($1, $2, now(), $3, $4, $5)
       ON CONFLICT (agent_id, runner_id) DO UPDATE
         SET heartbeat_at = now(), status = $3, pid = $4, machine_name = $5`,
      [this.agentId, this.runnerId, status, String(process.pid), this.machineName]
    ).catch(err => {
      if (!this._heartbeatWarned) {
        log.warn(`[${this.agentId}] Heartbeat write failed:`, err.message);
        this._heartbeatWarned = true;
      }
    });
  }

  // STAQPRO-351: race-safe sleep.
  // Previous version assigned `resolve` to `this._wakeUp` and never cleared the
  // timer when waked, so each sleep leaked a dangling setTimeout + dangling
  // resolver. Under churn (event wakes + new sleep), stale references could
  // clobber a live _wakeUp, making subsequent wakes no-ops → silent ticks.
  sleep(ms) {
    return new Promise((resolve) => {
      let timer;
      const wake = () => {
        clearTimeout(timer);
        if (this._wakeUp === wake) this._wakeUp = null;
        resolve();
      };
      timer = setTimeout(() => {
        if (this._wakeUp === wake) this._wakeUp = null;
        resolve();
      }, ms);
      this._wakeUp = wake;
    });
  }

  async stop() {
    this.running = false;
    await this._writeHeartbeat('stopped', true);
    if (this._wakeUp) this._wakeUp();
    if (this._unsubscribe) this._unsubscribe();
    if (this._tokenRefreshTimer) {
      clearInterval(this._tokenRefreshTimer);
      this._tokenRefreshTimer = null;
    }
  }
}
