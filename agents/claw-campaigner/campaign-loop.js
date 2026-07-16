/**
 * Campaign Iteration Loop (ADR-021)
 *
 * Core autoresearch-inspired loop for stateless AND stateful campaigns:
 *   1. Pre-checks (halt, budget, deadline, plateau)
 *   2. Create iteration work_item (for guardCheck + audit chain)
 *   3. Plan strategy (LLM reads history of attempts)
 *   4. Execute strategy
 *   5. Measure against success_criteria + content_policy
 *   6. Decide: keep/discard/stop
 *   7. Log to campaign_iterations (append-only)
 *   8. Commit/release budget
 *
 * The board approves the envelope. The loop runs autonomously inside it.
 */

import { execFile } from 'child_process';
import { query } from '../../lib/db.js';
import { resolveLoopDeadline, isWallBudgetExceeded } from '../../lib/runtime/campaign/wall-budget.js';
import { isDraining, registerAbort } from '../../lib/runtime/lifecycle.js';
import { runExecutor } from '../../lib/runtime/executor-adapter.js';
import { createWorkItem, transitionState } from '../../lib/runtime/state-machine.js';
import { guardCheck } from '../../lib/runtime/guard-check.js';
import { publishEvent, startActivityStep, completeActivityStep } from '../../lib/runtime/infrastructure.js';
import { reserveBudget, releaseBudget, commitSpend, estimateIterationCost } from './campaign-budget.js';
import { evaluateSuccessCriteria, evaluateBuildOutput, evaluateStatefulOutput, evaluateContentPolicy } from './campaign-scorer.js';
import { preIterationChecks } from './circuit-breaker.js';
import { getIterationHistory, getCampaignContext, buildStrategyPrompt, parseStrategyResponse } from './strategy-planner.js';
import { createWorkspace, commitImprovement, resetRegression, getCumulativeDiff, readGoal, cleanupWorkspace, pushBranch, createProjectWorkspace, cleanupProjectWorkspace } from './campaign-workspace.js';
import { deployProject } from './project-deploy.js';
import { getGitHubToken } from '../../autobot-inbox/src/github/app-auth.js';
import { recordCampaignIteration, recordCampaignOutcome, recordWinningStrategy } from '../../lib/graph/claw-learning.js';
import { requirePermission, logCapabilityInvocation } from '../../lib/runtime/permissions.js';
import { createCliEventLogger } from '../../lib/runtime/cli-event-logger.js';
import { awaitHumanInput } from '../../lib/hitl/index.js';
import { notifyBoard, notifyCreator } from '../../autobot-inbox/src/telegram/sender.js';
import { createChildLogger } from '../../lib/logger.js';

const log = createChildLogger({ agent: 'campaigner' });

const BUILD_GOAL_PATTERN = /\b(build|create|generate|implement|develop|design|code|site|app|page|landing|website|dashboard|api|component)\b/i;

// ============================================================
// Error classification + retry helpers
// ============================================================

const TRANSIENT_PATTERNS = [
  { pattern: /rate.?limit|429|too many requests/i, category: 'rate_limit' },
  { pattern: /timeout|ETIMEDOUT|ESOCKETTIMEDOUT|AbortError/i, category: 'timeout' },
  { pattern: /ECONNREFUSED|ECONNRESET|EPIPE|EHOSTUNREACH|ENOTFOUND/i, category: 'network' },
  { pattern: /JSON|Unexpected token|Unexpected end/i, category: 'json_parse' },
  { pattern: /service.?busy|overloaded|503|502|504/i, category: 'service_busy' },
  { pattern: /stall.?detect|watchdog/i, category: 'stall' },
];

const FATAL_PATTERNS = [
  { pattern: /guard.?check.?fail/i, category: 'guard_check' },
  { pattern: /budget.?exceed|budget_exceeded|stop_budget/i, category: 'budget' },
  { pattern: /campaign.?cancel/i, category: 'cancelled' },
  { pattern: /max.?iteration/i, category: 'max_iterations' },
];

/**
 * Classify an error as transient (retryable) or fatal (stop campaign).
 * Returns { transient: boolean, category: string }
 */
function classifyError(err) {
  const msg = err?.message || String(err);

  for (const { pattern, category } of FATAL_PATTERNS) {
    if (pattern.test(msg)) return { transient: false, category };
  }
  for (const { pattern, category } of TRANSIENT_PATTERNS) {
    if (pattern.test(msg)) return { transient: true, category };
  }

  // AbortError from iteration timeout is transient (already handled upstream, but classify for completeness)
  if (err?.name === 'AbortError') return { transient: true, category: 'timeout' };

  return { transient: false, category: 'unknown' };
}

/** Exponential backoff with jitter: 30s, 60s, 120s base + up to 25% jitter */
function retryDelayMs(attempt) {
  const base = 30_000 * Math.pow(2, attempt); // 30s, 60s, 120s
  const jitter = Math.random() * base * 0.25;
  return base + jitter;
}

const MAX_RETRIES = 3;
// Runaway backstop only — the REAL bound on a long run is the wall-clock budget
// (loopDeadlineAt) computed per-campaign below. Lifted from 50 (~4hr at 5min/iter)
// so an 18hr unattended run isn't cut short. Override via CAMPAIGN_MAX_ITERATIONS.
const MAX_ITERATIONS = parseInt(process.env.CAMPAIGN_MAX_ITERATIONS || '2000', 10);
// Default wall-clock budget; override per-campaign via metadata.wall_budget or
// globally via CAMPAIGN_WALL_BUDGET (e.g. '18 hours', '90 minutes').
const DEFAULT_WALL_BUDGET = process.env.CAMPAIGN_WALL_BUDGET || '18 hours';

/**
 * Run the full campaign loop until completion or stop condition.
 *
 * @param {string} campaignId
 * @param {Object} agentConfig - Agent config from agents.json
 * @param {Object} modelsConfig - Model pricing from agents.json
 * @param {AbortSignal} [signal] - External abort signal (e.g., from runner shutdown)
 */
export async function runCampaignLoop(campaignId, agentConfig, modelsConfig, signal = null) {
  const configHash = agentConfig.configHash || 'claw-campaigner-v1';
  const agentId = 'claw-campaigner';

  // Load campaign
  const campaign = await getCampaignContext(campaignId);
  if (!campaign) {
    log.error(` Campaign ${campaignId} not found`);
    return;
  }

  // Get the campaign's work_item_id for parent linkage
  const campaignRow = await query(
    `SELECT work_item_id, iteration_time_budget, constraints, campaign_mode, workspace_path, metadata, resumed_at
     FROM agent_graph.campaigns WHERE id = $1`,
    [campaignId]
  );
  const campaignWorkItemId = campaignRow.rows[0]?.work_item_id;
  const iterationTimeBudgetMs = parseIntervalToMs(campaignRow.rows[0]?.iteration_time_budget || '5 minutes');
  const constraints = typeof campaignRow.rows[0]?.constraints === 'string'
    ? JSON.parse(campaignRow.rows[0].constraints)
    : campaignRow.rows[0]?.constraints || {};
  // resumed_at: when set, only consider iterations created after this timestamp
  // (P3: campaign_iterations is append-only, can't delete/update old rows)
  const resumedAt = campaignRow.rows[0]?.resumed_at || null;
  const campaignMode = campaignRow.rows[0]?.campaign_mode;
  const isStateful = campaignMode === 'stateful';
  const isProject = campaignMode === 'project';
  let workspacePath = campaignRow.rows[0]?.workspace_path;
  const campaignMeta = typeof campaignRow.rows[0]?.metadata === 'string'
    ? JSON.parse(campaignRow.rows[0].metadata)
    : campaignRow.rows[0]?.metadata || {};

  // Stateless build campaigns produce output as text (no repo writes).
  // Stateful and project campaigns get file tools. Only pure stateless get text-only.
  const isBuildCampaign = !isStateful && !isProject && (
    campaignMeta.campaign_type === 'build' ||
    BUILD_GOAL_PATTERN.test(campaign.goal_description || '')
  );

  // Content campaigns dispatch to executor-writer instead of running a generic LLM loop
  const isContentCampaign = campaignMeta.content_type === 'blog' || campaignMeta.content_type === 'linkedin';
  // Contract campaigns dispatch to executor-contract
  const isContractCampaign = campaignMeta.content_type === 'contract';

  log.info(` Starting campaign loop: ${campaignId}`);
  log.info(`   Mode: ${isContractCampaign ? 'contract (executor-contract pipeline)' : isContentCampaign ? 'content (executor-writer pipeline)' : isProject ? 'project (fresh repo + deploy)' : isStateful ? 'stateful (git worktree)' : isBuildCampaign ? 'build (text output, no tools)' : 'stateless'}`);
  log.info(`   Goal: ${campaign.goal_description?.slice(0, 100)}...`);
  log.info(`   Budget: $${parseFloat(campaign.remaining_usd).toFixed(2)} remaining`);
  log.info(`   Iterations: ${campaign.completed_iterations}/${campaign.max_iterations}`);

  // Phase C: Initialize git worktree for stateful campaigns
  const isPlaceholderPath = (p) => !p || p.startsWith('/tmp/optimus-provisioning-');
  if (isStateful && isPlaceholderPath(workspacePath)) {
    const successCriteria = typeof campaign.success_criteria === 'string'
      ? JSON.parse(campaign.success_criteria) : campaign.success_criteria;
    workspacePath = await createWorkspace(campaignId, campaign.goal_description, successCriteria);
    log.info(`   Workspace: ${workspacePath}`);
  }

  // Project mode: fresh GitHub repo + local clone (not a worktree)
  if (isProject && isPlaceholderPath(workspacePath)) {
    workspacePath = await createProjectWorkspace(campaignId, campaign.goal_description);
    log.info(`   Project workspace: ${workspacePath}`);
  }

  // Update campaign status to running
  await query(
    `UPDATE agent_graph.campaigns SET campaign_status = 'running', started_at = COALESCE(started_at, now()), updated_at = now() WHERE id = $1`,
    [campaignId]
  );

  await publishEvent('campaign_started', `Campaign started: ${campaign.goal_description?.slice(0, 80)}`, agentId, campaignWorkItemId, { campaign_id: campaignId }).catch(() => {});
  notifyBoard(`🚀 Campaign started: "${campaign.goal_description?.slice(0, 80)}"\nID: ${campaignId}`).catch(() => {});

  let iterationNumber = campaign.completed_iterations;

  // Check for checkpoint from a previous crash — resume from last completed iteration
  const checkpoint = campaignMeta?.checkpoint_iteration;
  if (checkpoint && checkpoint > 0) {
    log.info(`   Resuming from checkpoint: iteration ${checkpoint}, best score ${campaignMeta.checkpoint_best_score || 0}`);
    iterationNumber = checkpoint;
    // The completed_iterations counter should already be correct from the DB
    // but if it was reset by resume, use the checkpoint
    if (campaign.completed_iterations < checkpoint) {
      await query(
        `UPDATE agent_graph.campaigns SET completed_iterations = $2, updated_at = now() WHERE id = $1`,
        [campaignId, checkpoint]
      );
    }
  }

  // Wall-clock budget — the real bound on a long unattended run. Persist
  // loop_deadline_at on first start so a crash+restart RESUMES the same deadline
  // instead of granting a fresh budget each time (Phase 2 durability).
  const wallBudgetMs = parseIntervalToMs(campaignMeta?.wall_budget || DEFAULT_WALL_BUDGET);
  const { deadlineAt: loopDeadlineAt, isNew: deadlineIsNew } = resolveLoopDeadline({
    existingDeadlineIso: campaignMeta?.loop_deadline_at || null,
    wallBudgetMs,
    now: Date.now(),
  });
  if (deadlineIsNew) {
    await query(
      `UPDATE agent_graph.campaigns
          SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('loop_deadline_at', $2::text),
              updated_at = now()
        WHERE id = $1`,
      [campaignId, new Date(loopDeadlineAt).toISOString()]
    ).catch(err => log.warn(` Could not persist loop_deadline_at: ${err.message}`));
    log.info(`   Wall-clock budget: ${campaignMeta?.wall_budget || DEFAULT_WALL_BUDGET} (deadline ${new Date(loopDeadlineAt).toISOString()})`);
  } else {
    log.info(`   Resuming with existing wall-clock deadline ${new Date(loopDeadlineAt).toISOString()}`);
  }

  let consecutiveFailures = 0;

  while (true) {
    // Wall-clock budget is the real bound on a long run; MAX_ITERATIONS is a
    // runaway backstop. Check the deadline FIRST so an 18hr run stops on time
    // rather than at an arbitrary iteration count.
    if (isWallBudgetExceeded(loopDeadlineAt, Date.now())) {
      log.warn(` Campaign ${campaignId} reached wall-clock budget — stopping gracefully`);
      await stopCampaign(campaignId, 'stop_wall_budget', campaignWorkItemId, agentId, configHash, resumedAt);
      return;
    }
    if (iterationNumber >= MAX_ITERATIONS) {
      log.warn(` Campaign ${campaignId} hit MAX_ITERATIONS backstop (${MAX_ITERATIONS}) — stopping`);
      await stopCampaign(campaignId, 'stop_max_iterations', campaignWorkItemId, agentId, configHash, resumedAt);
      return;
    }

    // External abort (runner shutdown) or process drain (SIGTERM) — pause
    // gracefully so the next start resumes from the checkpoint, rather than
    // being killed mid-run.
    if (signal?.aborted || isDraining()) {
      log.info(` Campaign ${campaignId} — ${signal?.aborted ? 'external abort' : 'draining'}`);
      await pauseCampaign(campaignId, signal?.aborted ? 'external_abort' : 'draining');
      return;
    }

    // Write heartbeat (fire-and-forget — 1ms, non-critical)
    query(`UPDATE agent_graph.campaigns SET last_heartbeat_at = now() WHERE id = $1`, [campaignId]).catch(() => {});

    iterationNumber++;
    log.info(` ── Iteration #${iterationNumber} starting ──`);

    // --- STEP 1: Pre-iteration checks ---
    const checks = await preIterationChecks(campaignId);
    if (!checks.canContinue) {
      await stopCampaign(campaignId, checks.stopReason, campaignWorkItemId, agentId, configHash, resumedAt);
      return;
    }
    const pivotRequired = checks.pivotRequired || false;
    if (pivotRequired) {
      log.info(`   Pivot required (pivot #${checks.pivotCount}) — strategy planner will try a fundamentally different approach`);
    }

    // --- STEP 2: Reserve budget ---
    const estimatedCost = estimateIterationCost(
      agentConfig.model, 8000, 2000, modelsConfig
    );
    const budgetOk = await reserveBudget(campaignId, estimatedCost);
    if (!budgetOk) {
      await stopCampaign(campaignId, 'stop_budget', campaignWorkItemId, agentId, configHash, resumedAt);
      return;
    }

    let iterationWorkItemId = null;
    let iterationCost = 0;
    const iterationStart = Date.now();
    let iterationStepId = null; // root activity step for this iteration

    try {
      // --- STEP 3: Create iteration work_item (for guardCheck + audit) ---
      const iterationItem = await createWorkItem({
        type: 'subtask',
        title: `Campaign ${campaignId} iteration #${iterationNumber}`,
        description: `Autonomous campaign iteration`,
        createdBy: agentId,
        parentId: campaignWorkItemId,
        assignedTo: agentId,
        priority: 0,
        metadata: {
          campaign_id: campaignId,
          iteration_number: iterationNumber,
          source: 'campaign_loop',
        },
      });
      iterationWorkItemId = iterationItem.id;

      // Open the root activity step for this iteration
      iterationStepId = await startActivityStep(
        campaignWorkItemId,
        `Campaign iteration #${iterationNumber}`,
        { type: 'campaign_iteration', agentId, campaignId, iterationNumber }
      );

      // --- STEP 4: guardCheck on the iteration work_item ---
      const guard = await guardCheck({
        action: 'campaign_iteration',
        agentId,
        configHash,
        taskId: iterationWorkItemId,
        estimatedCostUsd: estimatedCost,
      });

      if (!guard.allowed) {
        log.warn(` Guard check failed for iteration #${iterationNumber}: ${guard.reason}`);
        await transitionState({ workItemId: iterationWorkItemId, toState: 'blocked', agentId, configHash, reason: guard.reason });
        await releaseBudget(campaignId, estimatedCost);
        await logIteration(campaignId, iterationWorkItemId, iterationNumber, {}, null, null, 'stop_error', 0, Date.now() - iterationStart, `Guard check failed: ${guard.reason}`);
        await completeActivityStep(iterationStepId, { status: 'failed', metadata: { reason: `Guard check failed: ${guard.reason}` } });
        await stopCampaign(campaignId, 'stop_error', campaignWorkItemId, agentId, configHash, resumedAt);
        return;
      }

      // Transition to in_progress
      await transitionState({ workItemId: iterationWorkItemId, toState: 'in_progress', agentId, configHash, reason: 'Starting campaign iteration' });

      // --- STEP 5: Set up iteration timeout (JS-enforced) ---
      const iterationController = new AbortController();
      // A process drain aborts the in-flight iteration so it ends fast (instead of
      // running its full time budget); the loop then pauses+checkpoints at the
      // next boundary. Unregistered when the iteration settles (clearTimeout below).
      const unregisterDrainAbort = registerAbort(iterationController);
      const timeout = setTimeout(() => iterationController.abort(), iterationTimeBudgetMs);

      try {
        // --- STEP 6: Plan strategy ---
        const history = await getIterationHistory(campaignId, 20, resumedAt);

        // Phase C: Add workspace context for stateful campaigns
        let workspaceContext = '';
        if ((isStateful || isProject) && workspacePath) {
          const goalMd = await readGoal(workspacePath);
          const diff = await getCumulativeDiff(workspacePath);
          workspaceContext = goalMd ? `\nWORKSPACE GOAL:\n${goalMd}\n` : '';
          workspaceContext += diff ? `\nCUMULATIVE CHANGES (git diff --stat):\n${diff}\n` : '';
        }

        // Feed deploy errors back to strategy planner so it can fix the build
        const freshMeta = await refreshMeta(campaignId);
        if (freshMeta?.deploy_error) {
          workspaceContext += `\nDEPLOY BUILD ERROR (MUST FIX):\n${freshMeta.deploy_error}\n\nThe previous iteration's code failed to build on Vercel. You MUST fix the build errors before anything else.\n`;
        }

        const strategyPrompt = (await buildStrategyPrompt(campaign, history, { pivotRequired })) + workspaceContext;
        log.info(`   Planning strategy (${history.length} prior iterations)...`);

        // ADR-017: permission check for subprocess:claude_cli before spawning CLI
        await requirePermission(agentId, 'subprocess', 'claude_cli');

        const planStepId = await startActivityStep(
          campaignWorkItemId, 'Planning strategy',
          { type: 'planning', agentId, campaignId, iterationNumber, parentStepId: iterationStepId }
        );
        const cliConfig = agentConfig.claudeCode || {};
        const planEventLogger = createCliEventLogger({
          parentStepId: planStepId,
          workItemId: campaignWorkItemId,
          campaignId,
          iterationNumber,
          agentId,
        });
        const planResult = await runExecutor({
          prompt: strategyPrompt,
          systemPrompt: 'You are a campaign strategy planner. Respond with JSON only.',
          model: cliConfig.model || 'sonnet',
          maxTurns: 3,
          maxBudgetUsd: 0.50,
          permissionMode: 'bypassPermissions',
          allowedTools: [],  // pure reasoning — no tools needed
          workDir: workspacePath || process.cwd(),
          label: `campaign-plan-${campaignId}-${iterationNumber}`,
          agentTag: 'claw-campaigner',
          timeoutMs: iterationTimeBudgetMs,
          streamEvents: true,
          onEvent: planEventLogger,
        });
        log.info(` Plan CLI completed (${planResult.numTurns} turns, $${(planResult.costUsd || 0).toFixed(4)}, ${Math.round((planResult.durationMs || 0) / 1000)}s)`);
        if (planResult.result) {
          log.info(` Plan output: ${planResult.result.slice(0, 500)}${planResult.result.length > 500 ? '...' : ''}`);
        }
        if (planResult.isError) {
          log.error(` Plan error: ${planResult.error}`);
          throw new Error(`Plan step failed: ${planResult.error}`);
        }
        const planCost = planResult.costUsd || 0;
        iterationCost += planCost;
        await completeActivityStep(planStepId, { metadata: {
          cost_usd: planCost,
          num_turns: planResult.numTurns || 0,
          duration_ms: planResult.durationMs || 0,
          model: cliConfig.model || 'sonnet',
          is_error: planResult.isError || false,
        } });

        // Heartbeat after plan step (fire-and-forget)
        query(`UPDATE agent_graph.campaigns SET last_heartbeat_at = now() WHERE id = $1`, [campaignId]).catch(() => {});

        const planText = planResult.result || '';
        const { strategy, rationale } = parseStrategyResponse(planText);

        // --- HITL: pause if strategy requests operator clarification ---
        let hitlContext = '';
        if (strategy.hitl_question) {
          log.info(` HITL requested: "${strategy.hitl_question}"`);
          notifyCreator(campaignId, `⏸️ Campaign needs your input!\n\nQ: "${strategy.hitl_question}"\n\nRespond at board.staqs.io/campaigns/${campaignId}`).catch(() => {});
          const hitlAnswer = await awaitHumanInput(campaignId, strategy.hitl_question, agentId);
          log.info(` HITL answered: "${hitlAnswer.slice(0, 100)}"`);
          hitlContext = `\n\nOPERATOR CLARIFICATION:\nQ: ${strategy.hitl_question}\nA: ${hitlAnswer}`;
          // Resume campaign (awaitHumanInput leaves status=running after respond API fires)
        }

        // --- STEP 7: Execute strategy ---
        log.info(`   Executing strategy: ${rationale?.slice(0, 100) || 'no rationale'}...`);

        const execStepId = await startActivityStep(
          campaignWorkItemId, isContentCampaign ? 'Generating content' : 'Executing strategy',
          { type: isContentCampaign ? 'content_generation' : 'strategy_execution', agentId, campaignId, iterationNumber, parentStepId: iterationStepId }
        );

        let execResult;
        const streamedTextChunks = [];

        if (isContentCampaign) {
          // --- Content campaign: dispatch to executor-writer via work item ---
          log.info(`   Content mode: dispatching to executor-writer (${campaignMeta.content_type})`);

          // Create a work item for executor-writer
          const contentWorkItem = await query(
            `INSERT INTO agent_graph.work_items
               (type, title, status, assigned_to, priority, created_by, metadata)
             VALUES ('task', $2, 'assigned', 'executor-writer', 5, 'claw-campaigner', $1)
             RETURNING id`,
            [
              JSON.stringify({
                topic: campaignMeta.topic || campaign.goal_description,
                content_type: campaignMeta.content_type || 'blog',
                author: campaignMeta.author || 'UMB Advisors',
                target_audience: campaignMeta.target_audience || 'Growth-stage company operators and founders',
                seo_keywords: campaignMeta.seo_keywords || [],
                tone: campaignMeta.tone || 'Calm experienced operator, thinking in public',
                campaign_id: campaignId,
                topic_id: campaignMeta.topic_id || null,
              }),
              'Content: ' + (campaignMeta.topic || campaign.goal_description || '').slice(0, 80),
            ]
          );
          const contentWorkItemId = contentWorkItem.rows[0].id;
          log.info(`   Created content work item: ${contentWorkItemId}`);

          // Create task event so executor-writer's AgentLoop can claim it
          await query(
            `INSERT INTO agent_graph.task_events (event_type, work_item_id, target_agent_id, priority, event_data)
             VALUES ('task_assigned', $1, 'executor-writer', 5, $2)`,
            [contentWorkItemId, JSON.stringify({ campaign_id: campaignId })]
          );

          // Notify executor-writer via pg_notify
          await query(`SELECT pg_notify('agent_wake', $1)`, [JSON.stringify({
            agent: 'executor-writer', work_item_id: contentWorkItemId,
          })]);

          // Poll for completion (executor-writer will process it via AgentLoop)
          const pollStart = Date.now();
          const pollTimeoutMs = iterationTimeBudgetMs || 300000; // 5 min default
          let contentResult = null;

          while (Date.now() - pollStart < pollTimeoutMs) {
            const check = await query(
              `SELECT status, metadata FROM agent_graph.work_items WHERE id = $1`,
              [contentWorkItemId]
            );
            const item = check.rows[0];
            if (!item) break;

            if (item.status === 'completed') {
              const meta = typeof item.metadata === 'string' ? JSON.parse(item.metadata) : item.metadata;
              contentResult = meta?.content_result || {};
              break;
            }
            if (item.status === 'failed' || item.status === 'cancelled') {
              throw new Error(`Content generation failed (status: ${item.status})`);
            }

            // Poll every 5 seconds
            await new Promise(r => setTimeout(r, 5000));
          }

          if (!contentResult) {
            throw new Error('Content generation timed out');
          }

          // Map content result to execResult shape for scoring pipeline
          execResult = {
            result: contentResult.pr_url
              ? `Blog post generated: "${campaignMeta.topic || campaign.goal_description}" (${contentResult.word_count} words, ${contentResult.reading_time_min} min read). PR: ${contentResult.pr_url}. Gates ${contentResult.gates_passed ? 'passed' : 'failed: ' + (contentResult.failed_gates || []).join(', ')}. Cost: $${(contentResult.cost_usd || 0).toFixed(4)}.`
              : `Content draft generated: ${contentResult.word_count || 0} words. Draft ID: ${contentResult.draft_id || 'unknown'}.`,
            costUsd: contentResult.cost_usd || 0,
            numTurns: 5, // 5-phase pipeline
            durationMs: Date.now() - pollStart,
            isError: false,
            error: null,
          };

          log.info(` Content pipeline completed ($${(execResult.costUsd || 0).toFixed(4)}, ${Math.round((execResult.durationMs || 0) / 1000)}s)`);
        } else if (isContractCampaign) {
          // --- Contract campaign: dispatch to executor-contract via work item ---
          log.info(`   Contract mode: dispatching to executor-contract`);

          const contractWorkItem = await query(
            `INSERT INTO agent_graph.work_items
               (type, title, status, assigned_to, priority, created_by, metadata)
             VALUES ('task', $2, 'assigned', 'executor-contract', 5, 'claw-campaigner', $1)
             RETURNING id`,
            [
              JSON.stringify({
                client_name: campaignMeta.client_name || campaign.goal_description,
                topic: campaignMeta.topic || campaign.goal_description,
                content_type: 'contract',
                signer_name: campaignMeta.signer_name || null,
                signer_email: campaignMeta.signer_email || null,
                signer_title: campaignMeta.signer_title || null,
                scope_notes: campaignMeta.scope_notes || null,
                budget_range: campaignMeta.budget_range || null,
                duration: campaignMeta.duration || null,
                campaign_id: campaignId,
              }),
              'Contract: ' + (campaignMeta.client_name || campaign.goal_description || '').slice(0, 80),
            ]
          );
          const contractWorkItemId = contractWorkItem.rows[0].id;
          log.info(`   Created contract work item: ${contractWorkItemId}`);

          await query(
            `INSERT INTO agent_graph.task_events (event_type, work_item_id, target_agent_id, priority, event_data)
             VALUES ('task_assigned', $1, 'executor-contract', 5, $2)`,
            [contractWorkItemId, JSON.stringify({ campaign_id: campaignId })]
          );

          await query(`SELECT pg_notify('agent_wake', $1)`, [JSON.stringify({
            agent: 'executor-contract', work_item_id: contractWorkItemId,
          })]);

          // Poll for completion
          const pollStart = Date.now();
          const pollTimeoutMs = iterationTimeBudgetMs || 300000;
          let contractResult = null;

          while (Date.now() - pollStart < pollTimeoutMs) {
            const check = await query(
              `SELECT status, metadata FROM agent_graph.work_items WHERE id = $1`,
              [contractWorkItemId]
            );
            const item = check.rows[0];
            if (!item) break;

            if (item.status === 'completed') {
              const meta = typeof item.metadata === 'string' ? JSON.parse(item.metadata) : item.metadata;
              contractResult = meta || {};
              break;
            }
            if (item.status === 'failed' || item.status === 'cancelled') {
              throw new Error(`Contract generation failed (status: ${item.status})`);
            }

            await new Promise(r => setTimeout(r, 5000));
          }

          if (!contractResult) {
            throw new Error('Contract generation timed out');
          }

          execResult = {
            result: `Contract generated for "${campaignMeta.client_name || 'client'}". Draft ready for review.`,
            costUsd: contractResult.cost_usd || 0,
            numTurns: 1,
            durationMs: Date.now() - pollStart,
            isError: false,
            error: null,
          };

          log.info(` Contract pipeline completed ($${(execResult.costUsd || 0).toFixed(4)}, ${Math.round((execResult.durationMs || 0) / 1000)}s)`);
        } else {
          // --- Standard campaign: direct LLM execution ---
          const executePrompt = buildExecutionPrompt(campaign, strategy, constraints, hitlContext);

          const execEventLoggerBase = createCliEventLogger({
            parentStepId: execStepId,
            workItemId: campaignWorkItemId,
            campaignId,
            iterationNumber,
            agentId,
          });
          const execEventLogger = (event) => {
            if (event.type === 'content_block_delta' && event.delta?.text) {
              streamedTextChunks.push(event.delta.text);
            } else if (event.type === 'assistant' && event.message?.content) {
              for (const block of event.message.content) {
                if (block.type === 'text' && block.text) streamedTextChunks.push(block.text);
              }
            }
            return execEventLoggerBase(event);
          };
          const execTools = isBuildCampaign ? [] : (cliConfig.allowedTools || [
            'Read', 'Edit', 'Write', 'Glob', 'Grep',
            'Bash(git *)', 'Bash(npm *)', 'Bash(node *)',
            'Bash(ls *)', 'Bash(pwd)',
          ]);
          if (isBuildCampaign) {
            log.info(`   Build mode: tools disabled — output will be text-only`);
          }

          execResult = await runExecutor({
            prompt: executePrompt,
            model: cliConfig.model || 'sonnet',
            maxTurns: isBuildCampaign ? 15 : (cliConfig.maxTurns || 30),
            maxBudgetUsd: cliConfig.maxBudgetUsd || 2.00,
            permissionMode: 'bypassPermissions',
            appendSystemPrompt: (isStateful || isProject),
            allowedTools: execTools,
            workDir: workspacePath || process.cwd(),
            label: `campaign-exec-${campaignId}-${iterationNumber}`,
            agentTag: 'claw-campaigner',
            timeoutMs: iterationTimeBudgetMs,
            streamEvents: true,
            onEvent: execEventLogger,
          });
          log.info(` Exec CLI completed (${execResult.numTurns} turns, $${(execResult.costUsd || 0).toFixed(4)}, ${Math.round((execResult.durationMs || 0) / 1000)}s)`);
        }
        if (execResult.result) {
          const preview = execResult.result.slice(0, 800);
          log.info(` Exec output:\n${preview}${execResult.result.length > 800 ? '\n  ... (truncated)' : ''}`);
        }
        if (execResult.isError) {
          log.error(` Exec error: ${execResult.error}`);
          throw new Error(`Execute step failed: ${execResult.error}`);
        }
        const execCost = execResult.costUsd || 0;
        iterationCost += execCost;
        await completeActivityStep(execStepId, { metadata: {
          cost_usd: execCost,
          num_turns: execResult.numTurns || 0,
          duration_ms: execResult.durationMs || 0,
          model: cliConfig.model || 'sonnet',
          is_error: execResult.isError || false,
        } });

        // Heartbeat after execute step (fire-and-forget)
        query(`UPDATE agent_graph.campaigns SET last_heartbeat_at = now() WHERE id = $1`, [campaignId]).catch(() => {});

        // Use parsed result, or fall back to accumulated stream text if result is empty
        // (stream-json summary line sometimes has empty result when content was streamed)
        let executeText = execResult.result || streamedTextChunks.join('') || '';

        // --- STEP 8: Measure against success criteria ---
        if (typeof executeText !== 'string') {
          console.warn(`[campaigner] executeText is ${typeof executeText}, normalizing to string`);
          executeText = typeof executeText === 'object' ? JSON.stringify(executeText, null, 2) : String(executeText || '');
        }
        console.log(`[campaigner]   Scoring input: ${typeof executeText}, ${executeText?.length || 0} chars`);
        log.info(`   Measuring quality...`);
        const measureStepId = await startActivityStep(
          campaignWorkItemId, 'Measuring quality',
          { type: 'quality_check', agentId, campaignId, iterationNumber, parentStepId: iterationStepId }
        );
        // Stateful/project campaigns: score git changes (committed + uncommitted) + CLI text
        let measureResult;
        if ((isStateful || isProject) && workspacePath) {
          const diff = await getCumulativeDiff(workspacePath, 500);
          // Also check uncommitted changes (CLI may write files without committing)
          let statusText = '';
          try {
            const { execFile: execFileCb } = await import('child_process');
            statusText = await new Promise((res, rej) => {
              execFileCb('git', ['status', '--porcelain'], { cwd: workspacePath, timeout: 5000 }, (err, out) => err ? rej(err) : res(out));
            });
          } catch { /* non-critical */ }
          measureResult = evaluateStatefulOutput(diff, executeText, statusText);
        } else {
          measureResult = await measureIteration(executeText, campaign, strategy, isBuildCampaign);
        }
        const qualityScore = measureResult.score;
        await completeActivityStep(measureStepId, { metadata: { quality_score: qualityScore } });

        // --- STEP 9: Check content policy ---
        const contentPolicy = constraints.content_policy || {};
        const policyResult = evaluateContentPolicy(executeText, contentPolicy);

        if (!policyResult.compliant) {
          // Content policy violation → automatic discard
          log.info(` Iteration #${iterationNumber} — content policy violation: ${policyResult.violations.join(', ')}`);
          await logIteration(campaignId, iterationWorkItemId, iterationNumber, strategy, qualityScore, measureResult.details, 'discard', iterationCost, Date.now() - iterationStart, null, `Content policy: ${policyResult.violations.join(', ')}`, null, policyResult, executeText);
          await transitionState({ workItemId: iterationWorkItemId, toState: 'completed', agentId, configHash, reason: 'Discarded: content policy violation', costUsd: iterationCost });
          await commitSpend(campaignId, estimatedCost, iterationCost);
          await completeActivityStep(iterationStepId, { status: 'failed', metadata: { decision: 'discard', reason: 'content_policy', violations: policyResult.violations } });
          continue;
        }

        // --- STEP 10: Decide: keep / discard / stop_success ---
        // measureIteration now returns constraint-based pass/fail directly
        let decision;
        let failureAnalysis = null;
        let strategyAdjustment = null;
        let gitCommitHash = null;

        if (measureResult.passed) {
          decision = 'stop_success';
          if ((isStateful || isProject) && workspacePath) {
            gitCommitHash = await commitImprovement(workspacePath, iterationNumber, qualityScore);
          }
          log.info(` ✓ Campaign ${campaignId} succeeded at iteration #${iterationNumber} (score: ${qualityScore})`);
        } else if (qualityScore > (getLastBestScore(history) || 0)) {
          decision = 'keep';
          if ((isStateful || isProject) && workspacePath) {
            gitCommitHash = await commitImprovement(workspacePath, iterationNumber, qualityScore);
          }
          log.info(` ↑ Iteration #${iterationNumber} kept (score: ${qualityScore})${gitCommitHash ? ` [${gitCommitHash}]` : ''}`);
        } else {
          decision = 'discard';
          if ((isStateful || isProject) && workspacePath) {
            await resetRegression(workspacePath);
          }
          failureAnalysis = `Score ${qualityScore} did not improve over best ${getLastBestScore(history)}`;
          strategyAdjustment = rationale;
          log.info(` ↓ Iteration #${iterationNumber} discarded (score: ${qualityScore})`);
        }

        const decisionStepId = await startActivityStep(
          campaignWorkItemId, `Decision: ${decision}`,
          { type: 'decision', agentId, campaignId, iterationNumber, parentStepId: iterationStepId,
            metadata: { quality_score: qualityScore, decision } }
        );
        await completeActivityStep(decisionStepId, { metadata: { quality_score: qualityScore, git_commit: gitCommitHash } });

        // --- Project mode: push + deploy on kept/success iterations ---
        if (isProject && gitCommitHash && workspacePath) {
          try {
            // Refresh GitHub token on the remote (creation token may have expired)
            const meta = await refreshMeta(campaignId);
            const repoName = meta?.github_repo || campaignMeta.github_repo;
            log.info(` Project push+deploy: repo=${repoName || 'NOT FOUND'}, workspace=${workspacePath}`);
            if (repoName) {
              const freshToken = await getGitHubToken();
              const pushUrl = `https://x-access-token:${freshToken}@github.com/${repoName}.git`;
              // CLI with bypassPermissions may nuke .git (e.g. npx create-next-app .)
              // Recover: re-init git, add all files, commit, set remote, push
              const { existsSync } = await import('fs');
              if (!existsSync(`${workspacePath}/.git`)) {
                log.warn(` .git missing — CLI likely reinitialized the project. Recovering...`);
                await gitExecLocal(['init'], workspacePath);
                await gitExecLocal(['checkout', '-b', 'main'], workspacePath);
                await gitExecLocal(['add', '-A'], workspacePath);
                await gitExecLocal(['commit', '-m', 'Campaign build output'], workspacePath);
              }
              try { await gitExecLocal(['remote', 'remove', 'origin'], workspacePath); } catch { }
              await gitExecLocal(['remote', 'add', 'origin', pushUrl], workspacePath);
              await gitExecLocal(['push', 'origin', 'main', '--force'], workspacePath);
              log.info(` Pushed to project repo ${repoName}`);

              // Deploy: detect framework → route to Vercel (frontend) or Railway (backend)
              log.info(` Starting deploy for ${repoName}...`);
              const deployResult = await deployProject(campaignId, repoName, workspacePath);
              if (deployResult?.url) {
                log.info(` Deploy live: ${deployResult.url}`);
                notifyCreator(campaignId, `🚀 Preview live: ${deployResult.url}\nCampaign: ${campaignId.slice(0, 8)}`).catch(() => {});
              } else if (deployResult?.error) {
                log.error(` Build failed: ${deployResult.error.slice(0, 200)}`);
                // Store error in metadata so next iteration's strategy planner sees it
                await query(
                  `UPDATE agent_graph.campaigns SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('deploy_error', $2::text), updated_at = now() WHERE id = $1`,
                  [campaignId, deployResult.error.slice(0, 2000)]
                ).catch(() => {});
              }
            } else {
              log.warn(` No github_repo in metadata — cannot push or deploy`);
            }
          } catch (deployErr) {
            log.warn(` Project push/deploy failed (non-blocking): ${deployErr.message}`);
            if (deployErr.stack) log.warn(`   ${deployErr.stack.split('\n')[1]?.trim()}`);
          }
        }

        // --- STEP 11: Log iteration ---
        await logIteration(
          campaignId, iterationWorkItemId, iterationNumber,
          strategy, qualityScore, measureResult.details,
          decision, iterationCost, Date.now() - iterationStart,
          failureAnalysis, strategyAdjustment, gitCommitHash, policyResult, executeText,
          measureResult.failureReasons
        );

        // --- STEP 12: Complete work item + commit budget ---
        await transitionState({ workItemId: iterationWorkItemId, toState: 'completed', agentId, configHash, reason: `Decision: ${decision}`, costUsd: iterationCost });
        await commitSpend(campaignId, estimatedCost, iterationCost);

        const iterStatus = decision === 'stop_success' || decision === 'keep' ? 'completed' : 'failed';
        await completeActivityStep(iterationStepId, {
          status: iterStatus,
          metadata: { decision, quality_score: qualityScore, cost_usd: iterationCost },
        });

        // Checkpoint: persist iteration state so crash recovery resumes here
        const bestScoreForCheckpoint = Math.max(qualityScore || 0, getLastBestScore(history) || 0);
        await query(
          `UPDATE agent_graph.campaigns
           SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
             'checkpoint_iteration', $2::int,
             'checkpoint_best_score', $3::float,
             'checkpoint_best_hash', $4::text,
             'checkpoint_at', now()::text
           ), updated_at = now()
           WHERE id = $1`,
          [campaignId, iterationNumber, bestScoreForCheckpoint, gitCommitHash || '']
        );

        const elapsed = Math.round((Date.now() - iterationStart) / 1000);
        log.info(` ── Iteration #${iterationNumber} done: ${decision} | score=${qualityScore} | $${iterationCost.toFixed(3)} | ${elapsed}s ──`);

        // Successful iteration — reset consecutive failure counter
        consecutiveFailures = 0;

        // Publish event
        await publishEvent('campaign_iteration', `Campaign ${campaignId} iteration #${iterationNumber}: ${decision} (score: ${qualityScore})`, agentId, campaignWorkItemId, { campaign_id: campaignId, iteration: iterationNumber, decision, score: qualityScore }).catch(() => {});

        // Record to Neo4j knowledge graph (non-blocking)
        recordCampaignIteration(campaignId, iterationNumber, strategy, decision, qualityScore, failureAnalysis).catch(() => {});

        // Stop on success
        if (decision === 'stop_success') {
          // CRITICAL: Update campaign status IMMEDIATELY before any cleanup
          // that might throw. This prevents the runaway loop where recovery
          // reclaims a 'running' campaign after post-success cleanup fails.
          await query(
            `UPDATE agent_graph.campaigns SET campaign_status = 'succeeded', completed_at = now(), updated_at = now() WHERE id = $1`,
            [campaignId]
          );
          // Now run full cleanup (push branch, promote, notify, etc.) — safe to fail
          // skipStatusUpdate: status already set above to prevent runaway recovery loop
          try {
            await stopCampaign(campaignId, 'stop_success', campaignWorkItemId, agentId, configHash, resumedAt, { skipStatusUpdate: true });
          } catch (stopErr) {
            log.error(` Post-success cleanup failed (campaign already marked succeeded): ${stopErr?.message || stopErr}`);
          }
          return;
        }

      } finally {
        clearTimeout(timeout);
        unregisterDrainAbort();
      }

    } catch (err) {
      const { transient, category } = classifyError(err);
      // Log with stack trace to diagnose empty-message errors
      log.error(` Iteration #${iterationNumber} error (${category}, ${transient ? 'transient' : 'fatal'}):`, err?.message || String(err));
      if (err?.stack) log.error(` Stack: ${err.stack.split('\n').slice(0, 3).join(' | ')}`);

      // Defensive: wrap all error-handling in try/catch so that a failure
      // in error cleanup doesn't prevent stopCampaign from running (runaway loop fix)
      try {
        await logIteration(campaignId, iterationWorkItemId, iterationNumber, {}, null, null, 'stop_error', iterationCost, Date.now() - iterationStart, `[${category}] ${err?.message || String(err)}`);
      } catch (logErr) { log.warn(` Failed to log error iteration: ${logErr?.message}`); }

      try {
        if (iterationWorkItemId) {
          await transitionState({ workItemId: iterationWorkItemId, toState: 'failed', agentId, configHash, reason: `Error [${category}]: ${err?.message || 'unknown'}`, costUsd: iterationCost }).catch(() => {});
        }
        await completeActivityStep(iterationStepId, { status: 'failed', metadata: { error: err?.message, error_category: category, transient } });
      } catch (cleanupErr) { log.warn(` Failed to cleanup work item: ${cleanupErr?.message}`); }

      // Release budget reservation
      try { await releaseBudget(campaignId, estimatedCost); } catch (budgetErr) { log.warn(` Failed to release budget: ${budgetErr?.message}`); }

      // Increment consecutive failure counter
      consecutiveFailures++;

      // Error budget: 3 consecutive failures → pause campaign
      if (consecutiveFailures >= 3) {
        log.error(` Campaign ${campaignId} — 3 consecutive failures, pausing`);
        await pauseCampaign(campaignId, `3 consecutive failures (last: ${category})`);
        await publishEvent('campaign_paused', `Campaign ${campaignId} paused: 3 consecutive failures`, agentId, campaignWorkItemId, { campaign_id: campaignId, reason: '3_consecutive_failures', last_error_category: category }).catch(() => {});
        notifyCreator(campaignId, `⚠️ Campaign paused — 3 consecutive failures (${category})\nID: ${campaignId}\nCheck: board.staqs.io/campaigns/${campaignId}`).catch(() => {});
        return;
      }

      // Transient errors: retry with exponential backoff
      if (transient) {
        const retryAttempt = consecutiveFailures; // 1-based since we just incremented
        if (retryAttempt <= MAX_RETRIES) {
          const delayMs = retryDelayMs(retryAttempt - 1);
          const delaySec = Math.round(delayMs / 1000);
          log.info(` Transient error (${category}), retrying in ${delaySec}s (attempt ${retryAttempt}/${MAX_RETRIES})`);

          // Wait with abort support
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, delayMs);
            if (signal) {
              const onAbort = () => { clearTimeout(timer); resolve(); };
              signal.addEventListener('abort', onAbort, { once: true });
            }
          });

          continue; // retry the iteration
        }
        // Exceeded max retries for transient errors — fall through to fatal handling
        log.error(` Transient error (${category}) exceeded ${MAX_RETRIES} retries`);
      }

      // AbortError (iteration timeout) — continue to next iteration (legacy behavior preserved)
      if (err.name === 'AbortError') {
        log.info(` Iteration #${iterationNumber} timed out — trying next`);
        continue;
      }

      // Fatal error — stop the campaign
      await stopCampaign(campaignId, 'stop_error', campaignWorkItemId, agentId, configHash, resumedAt).catch(stopErr => {
        log.error(` stopCampaign also failed: ${stopErr?.message || stopErr}`);
      });
      return;
    }
  }
}

// ============================================================
// Helper functions
// ============================================================

async function logIteration(campaignId, workItemId, iterationNumber, strategy, qualityScore, qualityDetails, decision, costUsd, durationMs, failureAnalysis = null, strategyAdjustment = null, gitCommitHash = null, contentPolicyResult = null, actionTaken = null, failureReasons = null) {
  // Embed failure_reasons into quality_details JSONB so they're available in iteration history
  const enrichedDetails = { ...(qualityDetails || {}), failure_reasons: failureReasons || [] };
  await query(
    `INSERT INTO agent_graph.campaign_iterations
     (campaign_id, work_item_id, iteration_number, strategy_used, quality_score, quality_details,
      decision, cost_usd, duration_ms, failure_analysis, strategy_adjustment, git_commit_hash, content_policy_result, action_taken)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (campaign_id, iteration_number) DO UPDATE SET
      work_item_id = EXCLUDED.work_item_id, strategy_used = EXCLUDED.strategy_used,
      quality_score = EXCLUDED.quality_score, quality_details = EXCLUDED.quality_details,
      decision = EXCLUDED.decision, cost_usd = EXCLUDED.cost_usd, duration_ms = EXCLUDED.duration_ms,
      failure_analysis = EXCLUDED.failure_analysis, strategy_adjustment = EXCLUDED.strategy_adjustment,
      git_commit_hash = EXCLUDED.git_commit_hash, content_policy_result = EXCLUDED.content_policy_result,
      action_taken = EXCLUDED.action_taken`,
    [campaignId, workItemId, iterationNumber, JSON.stringify(strategy), qualityScore, JSON.stringify(enrichedDetails),
     decision, costUsd, durationMs, failureAnalysis, strategyAdjustment, gitCommitHash, JSON.stringify(contentPolicyResult || {}), actionTaken]
  );
}

async function stopCampaign(campaignId, reason, workItemId, agentId, configHash, resumedAt = null, { skipStatusUpdate = false } = {}) {
  const statusMap = {
    stop_success: 'succeeded',
    stop_wall_budget: 'succeeded', // reached its allotted time budget — graceful, keep workspace
    stop_budget: 'failed',
    stop_deadline: 'failed',
    stop_max_iterations: 'failed',
    stop_plateau: 'plateau_paused',
    stop_halt: 'paused',
    stop_error: 'failed',
  };
  const status = statusMap[reason] || 'failed';

  // Skip when caller already set status (e.g. success path sets it early to prevent runaway recovery)
  if (!skipStatusUpdate) {
    await query(
      `UPDATE agent_graph.campaigns SET campaign_status = $1, completed_at = now(), updated_at = now() WHERE id = $2`,
      [status, campaignId]
    );
  }

  // Clear checkpoint from metadata so it doesn't confuse future resumes
  await query(
    `UPDATE agent_graph.campaigns
     SET metadata = metadata - 'checkpoint_iteration' - 'checkpoint_best_score' - 'checkpoint_best_hash' - 'checkpoint_at'
     WHERE id = $1`,
    [campaignId]
  ).catch((err) => log.warn(` Failed to clear checkpoint for ${campaignId}: ${err?.message}`));

  // Load workspace info for all terminal/paused states (needed for push + cleanup)
  const wsResult = await query(
    `SELECT workspace_path, metadata, campaign_mode FROM agent_graph.campaigns WHERE id = $1`,
    [campaignId]
  );
  const wsRow = wsResult.rows[0];

  // Push stateful campaign branch to GitHub BEFORE cleanup
  if (wsRow?.workspace_path && (status === 'succeeded' || status === 'plateau_paused')) {
    if (wsRow.campaign_mode === 'project') {
      // Project mode: refresh token, push, then deploy to Vercel/Railway
      try {
        const meta = typeof wsRow.metadata === 'string' ? JSON.parse(wsRow.metadata) : wsRow.metadata || {};
        const repoName = meta.github_repo;
        if (repoName) {
          const freshToken = await getGitHubToken();
          const pushUrl = `https://x-access-token:${freshToken}@github.com/${repoName}.git`;
          // CLI with bypassPermissions may nuke .git — recover
          const { existsSync } = await import('fs');
          if (!existsSync(`${wsRow.workspace_path}/.git`)) {
            log.warn(` .git missing in stopCampaign — recovering...`);
            await gitExecLocal(['init'], wsRow.workspace_path);
            await gitExecLocal(['checkout', '-b', 'main'], wsRow.workspace_path);
            await gitExecLocal(['add', '-A'], wsRow.workspace_path);
            await gitExecLocal(['commit', '-m', 'Campaign build output'], wsRow.workspace_path);
          }
          try { await gitExecLocal(['remote', 'remove', 'origin'], wsRow.workspace_path); } catch { /* may not exist */ }
          await gitExecLocal(['remote', 'add', 'origin', pushUrl], wsRow.workspace_path);
          await gitExecLocal(['push', 'origin', 'main', '--force'], wsRow.workspace_path);
          log.info(` Pushed project repo ${repoName} for campaign ${campaignId}`);

          // Deploy to Vercel (frontend) or Railway (backend)
          log.info(` Deploying ${repoName}...`);
          const deployResult = await deployProject(campaignId, repoName, wsRow.workspace_path);
          if (deployResult?.url) {
            log.info(` Deploy live: ${deployResult.url}`);
            notifyCreator(campaignId, `🚀 Preview live: ${deployResult.url}\nCampaign: ${campaignId.slice(0, 8)}`).catch(() => {});
          } else if (deployResult?.error) {
            log.error(` Deploy build failed: ${deployResult.error.slice(0, 200)}`);
            // Store build error so iterations can read it and fix the code
            await query(
              `UPDATE agent_graph.campaigns SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('deploy_error', $2::text), updated_at = now() WHERE id = $1`,
              [campaignId, deployResult.error.slice(0, 2000)]
            ).catch(() => {});
            notifyCreator(campaignId, `❌ Build failed — needs code fix\n${deployResult.error.slice(0, 200)}`).catch(() => {});
          }
        } else {
          log.warn(` No github_repo in metadata — skipping push/deploy`);
        }
      } catch (err) {
        log.warn(` Project push/deploy failed for ${campaignId}: ${err.message}`);
      }
    } else {
      // Stateful mode: push campaign branch
      try {
        const branch = await pushBranch(campaignId);
        log.info(` Pushed branch ${branch} to origin for campaign ${campaignId}`);
      } catch (err) {
        log.warn(` Branch push failed for ${campaignId}: ${err.message}`);
      }
    }
  }

  // Clean up workspace for terminal stateful campaigns
  // Skip cleanup when promotion.type='pr' on success — PR needs the branch
  if (status === 'succeeded' || status === 'failed' || status === 'cancelled') {
    // wsRow already loaded above

    // Project mode: set 7-day cleanup timer instead of immediate cleanup
    if (wsRow?.campaign_mode === 'project') {
      await query(
        `UPDATE agent_graph.campaigns SET cleanup_at = now() + INTERVAL '7 days', updated_at = now() WHERE id = $1`,
        [campaignId]
      );
      log.info(` Project campaign ${campaignId} — cleanup scheduled in 7 days`);
    } else if (wsRow?.workspace_path) {
      const meta = typeof wsRow.metadata === 'string' ? JSON.parse(wsRow.metadata) : wsRow.metadata || {};
      const skipCleanup = status === 'succeeded' && meta.promotion?.type === 'pr';
      if (skipCleanup) {
        log.info(` Skipping workspace cleanup for ${campaignId} — PR promotion pending`);
      } else {
        try {
          await cleanupWorkspace(campaignId);
          log.info(` Cleaned up workspace for campaign ${campaignId}`);
        } catch (err) {
          log.warn(` Workspace cleanup failed for ${campaignId}: ${err.message}`);
        }
      }
    }
  }

  // Transition the campaign work_item
  const toState = status === 'succeeded' ? 'completed' : status.includes('paused') ? 'blocked' : 'failed';
  await transitionState({ workItemId, toState, agentId, configHash, reason: `Campaign ${reason}` }).catch(() => {});

  const eventType = status === 'succeeded' ? 'campaign_completed' : status.includes('paused') ? 'campaign_paused' : 'campaign_failed';

  // Enrich failure events with last iteration context for board notifications
  const eventMeta = { campaign_id: campaignId, reason, status };
  if (status === 'failed' || status.includes('paused')) {
    try {
      const lastIter = await query(
        `SELECT iteration_number, quality_score, decision, failure_analysis, strategy_adjustment, duration_ms
         FROM agent_graph.campaign_iterations
         WHERE campaign_id = $1 AND ($2::timestamptz IS NULL OR created_at > $2)
         ORDER BY iteration_number DESC LIMIT 1`,
        [campaignId, resumedAt]
      );
      const campaignInfo = await query(
        `SELECT goal_description, completed_iterations, max_iterations, spent_usd
         FROM agent_graph.campaigns WHERE id = $1`,
        [campaignId]
      );
      if (lastIter.rows[0]) {
        eventMeta.last_iteration = lastIter.rows[0];
      }
      if (campaignInfo.rows[0]) {
        eventMeta.goal = campaignInfo.rows[0].goal_description?.slice(0, 200);
        eventMeta.iterations = `${campaignInfo.rows[0].completed_iterations}/${campaignInfo.rows[0].max_iterations}`;
        eventMeta.spent = campaignInfo.rows[0].spent_usd;
      }
    } catch { /* non-critical enrichment */ }
  }
  await publishEvent(eventType, `Campaign ${campaignId}: ${reason}`, agentId, workItemId, eventMeta).catch(() => {});

  // Record outcome to Neo4j (non-blocking)
  if (status === 'succeeded' || status === 'failed' || status === 'cancelled') {
    try {
      const stats = await query(
        `SELECT completed_iterations, spent_usd,
                (SELECT MAX(quality_score) FROM agent_graph.campaign_iterations ci
                 WHERE ci.campaign_id = $1 AND ci.decision = 'keep'
                   AND ($2::timestamptz IS NULL OR ci.created_at > $2)) AS best_score
         FROM agent_graph.campaigns WHERE id = $1`,
        [campaignId, resumedAt]
      );
      const row = stats.rows[0];
      if (row) {
        recordCampaignOutcome(campaignId, status, row.completed_iterations, parseFloat(row.spent_usd), row.best_score ? parseFloat(row.best_score) : null).catch(() => {});

        // Record winning strategy for cross-campaign learning
        if (status === 'succeeded') {
          const winningIter = await query(
            `SELECT strategy_used, quality_score FROM agent_graph.campaign_iterations
             WHERE campaign_id = $1 AND decision = 'stop_success'
               AND ($2::timestamptz IS NULL OR created_at > $2)
             ORDER BY iteration_number DESC LIMIT 1`,
            [campaignId, resumedAt]
          );
          const winning = winningIter.rows[0];
          if (winning) {
            const goalResult = await query(`SELECT goal_description FROM agent_graph.campaigns WHERE id = $1`, [campaignId]);
            const goalDesc = goalResult.rows[0]?.goal_description || '';
            recordWinningStrategy(campaignId, goalDesc, winning.strategy_used, row.completed_iterations, parseFloat(winning.quality_score)).catch(() => {});
          }
        }
      }
    } catch { /* non-critical */ }
  }

  // Campaign promotion (P1: only if configured)
  if (status === 'succeeded') {
    try {
      const { promote } = await import('../../autobot-inbox/src/runtime/campaign-promoter.js');
      await promote(campaignId, agentId);
    } catch (err) {
      log.error(` Promotion failed for ${campaignId}:`, err.message);
      await publishEvent('campaign_promotion_failed', err.message, agentId, workItemId, { campaign_id: campaignId }).catch(() => {});
    }
  }


  log.info(` Campaign ${campaignId} stopped: ${reason} → ${status}`);

  // Log preview URL so operators can see the output
  const apiBase = process.env.API_BASE_URL || 'https://preview.staqs.io';
  log.info(` Preview: ${apiBase}/api/campaigns/${campaignId}/preview`);

  // Notify creator of terminal campaign status
  const emoji = status === 'succeeded' ? '✅' : status.includes('paused') ? '⏸️' : '❌';
  notifyCreator(campaignId, `${emoji} Campaign ${status}: "${reason}"\nID: ${campaignId}\nPreview: board.staqs.io/campaigns/${campaignId}`).catch(() => {});
}

// awaitHumanInput is imported from lib/hitl/index.js (line 30)

async function pauseCampaign(campaignId, reason) {
  await query(
    `UPDATE agent_graph.campaigns SET campaign_status = 'paused', updated_at = now() WHERE id = $1`,
    [campaignId]
  );
  log.info(` Campaign ${campaignId} paused: ${reason}`);
}

function buildExecutionPrompt(campaign, strategy, constraints, hitlContext = '') {
  const goal = campaign.goal_description || '';
  const mode = campaign.campaign_mode || 'stateless';
  const isStatefulOrProject = mode === 'stateful' || mode === 'project';
  const isCodeProject = BUILD_GOAL_PATTERN.test(goal);

  // Mode-specific instructions: stateful/project = use tools + commit.
  // Stateless build = output as fenced code blocks (text only).
  let modeInstructions = '';

  if (isStatefulOrProject) {
    // Stateful/project: CLI has Write/Edit/Bash tools in a git worktree
    modeInstructions = `

WORKSPACE: You are working in a git worktree. You have full file tools available.

CRITICAL — HOW TO WORK:
1. Use the Read tool to read existing files
2. Use the Write tool to create new files or the Edit tool to modify existing files
3. After making changes, commit your work: Bash(git add -A && git commit -m "description of changes")
4. NEVER output code as markdown text. ALWAYS use Write/Edit tools to create files.
5. Your output text should be a brief summary of what you did — the actual work is in the files.

If the goal is to write documentation, write it to a .md file using Write.
If the goal is to write code, write it to the appropriate source files using Write/Edit.
The scorer evaluates your git changes, not your text output.`;
  } else if (isCodeProject) {
    // Stateless build: no file tools, output as fenced code blocks
    modeInstructions = `

OUTPUT FORMAT: You MUST output all files using fenced code blocks with explicit filenames.
Use this exact format for EVERY file:

\`\`\`tsx filename="app/page.tsx"
// file contents here
\`\`\`

Rules:
- Every code block MUST have a filename attribute
- Use realistic file paths (e.g., app/page.tsx, src/index.ts, styles/main.css)
- Include a package.json if the project needs dependencies
- Include a README.md with setup instructions
- Do NOT put code outside of fenced blocks`;
  }

  return `Execute the following campaign strategy.

GOAL: ${goal}

STRATEGY: ${JSON.stringify(strategy)}

CONSTRAINTS: ${JSON.stringify(constraints)}
${modeInstructions}${hitlContext}

Produce a result that can be measured against these success criteria:
${JSON.stringify(campaign.success_criteria, null, 2)}

CRITICAL OUTPUT RULES:
- Do NOT include quality scores, confidence ratings, self-assessments, or task completion summaries.
- Do NOT wrap deliverables in execution reports or meta-commentary.
- Output ONLY the deliverable content.

Respond with your execution output.`;
}

async function measureIteration(output, campaign, strategy, isBuildCampaign = false) {
  // Constraint-based measurement — no self-reported metrics
  const successCriteria = typeof campaign.success_criteria === 'string'
    ? JSON.parse(campaign.success_criteria)
    : campaign.success_criteria || [];

  // Build campaigns use a specialized scorer that evaluates code blocks directly,
  // skipping self-assessment and envelope checks that penalize narrative wrapping.
  const scored = isBuildCampaign
    ? evaluateBuildOutput(output, successCriteria, { expectedFormat: strategy?.output_format })
    : evaluateSuccessCriteria(output, successCriteria, { expectedFormat: strategy?.output_format });

  return { score: scored.score, passed: scored.passed, details: scored.details, raw: scored.raw, failureReasons: scored.failureReasons || [] };
}

function getLastBestScore(history) {
  if (!history || history.length === 0) return 0;
  return history
    .filter(h => h.quality_score != null && (h.decision === 'keep' || h.decision === 'stop_success'))
    .reduce((best, h) => Math.max(best, parseFloat(h.quality_score)), 0);
}

/** Simple git exec for project workspaces (not using campaign-workspace.js's REPO_ROOT default). */
function gitExecLocal(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args[0]} failed: ${stderr || stdout || err.message}`));
      else resolve(stdout);
    });
  });
}

/** Re-read campaign metadata from DB (for when metadata was updated by another function). */
async function refreshMeta(campaignId) {
  const result = await query(
    `SELECT metadata FROM agent_graph.campaigns WHERE id = $1`,
    [campaignId]
  );
  const raw = result.rows[0]?.metadata;
  return typeof raw === 'string' ? JSON.parse(raw) : raw || {};
}

function parseIntervalToMs(interval) {
  if (typeof interval === 'number') return interval;
  const str = String(interval);
  const match = str.match(/(\d+)\s*(minute|min|second|sec|hour|hr|ms)/i);
  if (!match) return 300_000; // 5 min default
  const value = parseInt(match[1]);
  const unit = match[2].toLowerCase();
  if (unit.startsWith('ms')) return value;
  if (unit.startsWith('sec')) return value * 1000;
  if (unit.startsWith('min')) return value * 60_000;
  if (unit.startsWith('hour') || unit.startsWith('hr')) return value * 3_600_000;
  return 300_000;
}
