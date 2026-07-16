/**
 * Workshop Runner — single-pass CLI execution.
 *
 * Unlike the campaigner's iteration loop, workshop execution is a single
 * continuous Claude Code session. The playbook markdown becomes the system
 * prompt; all phases (plan, implement, test, review, ship) are instructions
 * within that prompt.
 *
 * Reuses campaign infrastructure:
 * - campaign-workspace.js for git worktree lifecycle
 * - campaign-budget.js for budget envelopes
 * - campaign_iterations table for audit trail
 * - guard-check.js for pre-execution guardrail check
 *
 * Governance: G1 (budget), G5 (PR only).
 */

import { execFileSync } from 'child_process';
import { query } from '../../lib/db.js';
import { loadPlaybook } from './playbook-loader.js';
import { createWorkspace, cleanupWorkspace } from '../claw-campaigner/campaign-workspace.js';
import { reserveBudget, commitSpend, releaseBudget } from '../claw-campaigner/campaign-budget.js';
import { guardCheck } from '../../lib/runtime/guard-check.js';
import { screenUntrustedContent } from '../../lib/runtime/governance/screen-untrusted-content.js';
import { runExecutor } from '../../lib/runtime/executor-adapter.js';
import { publishEvent, startActivityStep, completeActivityStep } from '../../lib/runtime/infrastructure.js';
import { getGitHubToken } from '../../autobot-inbox/src/github/app-auth.js';
import { redactSecrets } from '../../lib/runtime/log-redactor.js';
import { getIssue } from '../../autobot-inbox/src/linear/client.js';
import { updateIssueState, updateIssueStateByName, addComment, addBotComment, getIssueComments } from '../../autobot-inbox/src/linear/client.js';
import { recordCampaignOutcome } from '../../lib/graph/claw-learning.js';
import { createChildLogger } from '../../lib/logger.js';

const log = createChildLogger({ agent: 'workshop' });
import { requirePermission, logCapabilityInvocation } from '../../lib/runtime/permissions.js';

// P1: deny by default — only explicitly listed env keys pass through
const EXTRA_ENV_KEYS = ['GITHUB_TOKEN', 'LINEAR_API_KEY', 'LINEAR_TEAM_ID'];

/**
 * Run a single workshop execution.
 *
 * @param {string} campaignId - Campaign ID (workshop mode)
 * @param {Object} agentConfig - Agent config from agents.json (with configHash)
 * @param {Object} modelsConfig - Models pricing config
 * @param {AbortSignal} signal - Abort signal for cancellation
 */
export async function runWorkshop(campaignId, agentConfig, modelsConfig, signal) {
  const stepId = await startActivityStep(null, `Workshop execution: ${campaignId}`, {
    type: 'workshop_execution',
    agentId: 'claw-workshop',
  });

  let workspacePath = null;
  let estimatedCost = 0;
  let budgetReserved = false;

  try {
    // 1. Load campaign context
    const campaign = await loadCampaign(campaignId);
    if (!campaign) throw new Error(`Campaign ${campaignId} not found`);

    const metadata = campaign.metadata || {};

    // Auto-detect design tasks via structured metadata only (P2: infra enforces, not free-text heuristics)
    const isDesignTask = metadata.labels?.includes('design') ||
      metadata.linear_labels?.some(l => /design/i.test(l));

    const playbookId = metadata.playbook_id ||
      (isDesignTask ? agentConfig.workshop?.designPlaybook : null) ||
      agentConfig.workshop?.defaultPlaybook ||
      'implement-feature';

    // 2. Load playbook
    const playbook = await loadPlaybook(playbookId);
    log.info(` Loaded playbook: ${playbookId} (budget: $${playbook.meta.default_budget_usd})`);

    // 3. Check for existing PR branch to reuse (retry pushes to same PR)
    let existingBranch = null;
    if (metadata.existing_pr_number && metadata.target_repo) {
      try {
        const ghToken = await getGitHubToken();
        existingBranch = execFileSync('gh', [
          'pr', 'view', String(metadata.existing_pr_number),
          '--repo', metadata.target_repo, '--json', 'headRefName', '--jq', '.headRefName',
        ], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GH_TOKEN: ghToken } }).trim();
        if (existingBranch) {
          log.info(` Reusing existing branch ${existingBranch} from PR #${metadata.existing_pr_number}`);
        }
      } catch (err) {
        log.warn(` Could not resolve PR #${metadata.existing_pr_number} branch: ${redactSecrets(err.message)}`);
      }
    }

    // 3b. Create git worktree (reusing existing branch if available)
    workspacePath = await createWorkspace(
      campaignId,
      campaign.goal_description || 'Workshop task',
      campaign.success_criteria || [],
      undefined, // default worktreeBase
      { existingBranch },
    );
    log.info(` Workspace created at ${workspacePath}`);

    // 4. Build prompt from issue context
    //    For reply tasks, fetch conversation history and build conversational prompt
    let prompt;
    let comments = null;
    if (metadata.task_mode === 'reply' && metadata.linear_issue_id) {
      comments = await getIssueComments(metadata.linear_issue_id, 10);
      prompt = buildReplyPrompt(campaign, metadata, comments);
    } else {
      prompt = await buildPrompt(campaign, metadata);
    }

    // 4b. Screen the FULLY RENDERED prompt (GH #541; Linus V-5/V-6) — the
    // exact byte string that reaches the agentic tool loop — rather than
    // per-field copies. Per-field screening missed the live fullDescription
    // fetched inside buildPrompt() and the raw reply_question in
    // buildReplyPrompt(), and let an attacker split a payload across many
    // sub-20-char comments that individually clear the too-short floor but
    // get reassembled verbatim in the rendered prompt. Screening the final
    // prompt closes all three: claw-workshop grants Write/Bash/network
    // tools, so this fails CLOSED — a confirmed Model Armor match OR a
    // genuine can't-screen result both abort the run (thrown here, handled
    // by the catch block below like any other pre-execution failure).
    const screening = await screenUntrustedContent(prompt, {
      agentId: 'claw-workshop',
      failClosed: true,
    });
    if (screening.decision === 'block') {
      throw new Error(`Blocked by content screening: ${screening.reason}`);
    }

    // 5. Guard check
    // Subscription-billed runners (M1 satellite) don't consume per-token API budget,
    // so G1 cost estimation is zero to avoid blocking on the shared daily ceiling.
    const isSubscriptionBilling = !!process.env.SUBSCRIPTION_BILLING;
    estimatedCost = playbook.meta.default_budget_usd;
    const guardResult = await guardCheck({
      action: 'workshop_execution',
      agentId: 'claw-workshop',
      configHash: agentConfig.configHash,
      estimatedCostUsd: isSubscriptionBilling ? 0 : estimatedCost,
    });

    if (!guardResult.allowed) {
      throw new Error(`Guard check denied: ${guardResult.reason}`);
    }

    // 6. Reserve budget
    budgetReserved = await reserveBudget(campaignId, estimatedCost);
    if (!budgetReserved) {
      throw new Error('Budget reservation failed — envelope exhausted');
    }

    // Check abort before spawning CLI
    if (signal.aborted) throw new Error('Workshop aborted before CLI spawn');

    // 7. Get GitHub token — ADR-017: permission check for api_client:github
    let ghToken;
    try {
      await requirePermission('claw-workshop', 'api_client', 'github');
      ghToken = await getGitHubToken();
    } catch (err) {
      log.warn(` GitHub token unavailable: ${redactSecrets(err.message)} — PR creation may fail`);
    }

    // 8. Spawn CLI — single continuous session
    // ADR-017: permission check for subprocess:claude_cli
    await requirePermission('claw-workshop', 'subprocess', 'claude_cli');
    const cliConfig = agentConfig.claudeCode || {};

    // Merge playbook-specific extra tools with defaults
    const defaultTools = [
      'Read', 'Edit', 'Write', 'Glob', 'Grep',
      'Task', 'Skill', 'ToolSearch',
      'WebSearch', 'WebFetch',
      'Bash(git *)', 'Bash(npm *)', 'Bash(npx *)', 'Bash(node *)',
      'Bash(gh pr *)', 'Bash(gh issue *)',
      'Bash(ls *)', 'Bash(pwd)',
    ];
    const extraTools = typeof playbook.meta.extra_allowed_tools === 'string'
      ? playbook.meta.extra_allowed_tools.split(',').map(t => t.trim()).filter(Boolean)
      : [];
    const allowedTools = cliConfig.allowedTools || [...defaultTools, ...extraTools];

    const result = await runExecutor({
      backend: 'claude',
      prompt,
      systemPrompt: playbook.systemPrompt,
      appendSystemPrompt: false,
      workDir: workspacePath,
      mcpConfig: cliConfig.mcpServers || null,
      // Budget: subscription billing means playbook defaults are safety rails, not cost controls.
      // 5x multiplier ensures agents aren't artificially constrained on subscription plans.
      maxBudgetUsd: cliConfig.maxBudgetUsd || (playbook.meta.default_budget_usd * 5),
      maxTurns: cliConfig.maxTurns || playbook.meta.max_turns,
      timeoutMs: cliConfig.sessionTimeoutMs || playbook.meta.session_timeout_ms || 1_800_000,
      allowedTools,
      model: cliConfig.model || playbook.meta.model || 'sonnet',
      extraEnvKeys: EXTRA_ENV_KEYS,
      extraEnv: ghToken ? { GH_TOKEN: ghToken } : {},
      label: `workshop-${playbookId}`,
      agentTag: 'claw-workshop',
    });

    // Log CLI session details for terminal visibility
    log.info(` CLI completed (${result.numTurns} turns, $${(result.costUsd || 0).toFixed(4)}, ${Math.round((result.durationMs || 0) / 1000)}s, error=${result.isError || false})`);
    if (result.result) {
      const preview = result.result.slice(0, 800);
      log.info(` CLI output:\n${preview}${result.result.length > 800 ? '\n  ... (truncated)' : ''}`);
    }
    if (result.isError) {
      log.error(` CLI error: ${result.error}`);
    }

    // 9. Extract PR info from CLI output and store as action_proposal
    //    This enables branch reuse on /retry (comment-handler looks up action_proposals)
    const resultText = result.result || '';
    const prUrlMatch = resultText.match(/https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/);
    let workshopPrUrl = prUrlMatch ? prUrlMatch[0] : null;
    let workshopPrNumber = prUrlMatch ? parseInt(prUrlMatch[1], 10) : null;

    // Also check if we were reusing an existing PR (from metadata)
    if (!workshopPrUrl && metadata.existing_pr_url) {
      workshopPrUrl = metadata.existing_pr_url;
      workshopPrNumber = metadata.existing_pr_number;
    }

    if (workshopPrUrl && metadata.linear_issue_id) {
      try {
        await query(
          `INSERT INTO agent_graph.action_proposals
           (action_type, work_item_id, body, target_repo,
            github_pr_number, github_pr_url,
            linear_issue_id, linear_issue_url)
           VALUES ('code_fix_pr', $1, $2, $3, $4, $5, $6, $7)`,
          [
            campaign.work_item_id,
            resultText.slice(0, 5000) || `Workshop ${playbookId} completed`,
            metadata.target_repo || null,
            workshopPrNumber,
            workshopPrUrl,
            metadata.linear_issue_id,
            metadata.linear_issue_url || null,
          ]
        );
        log.info(` Stored PR #${workshopPrNumber} in action_proposals for ${metadata.linear_identifier || 'issue'}`);
      } catch (err) {
        log.warn(` Failed to store PR action_proposal: ${err.message}`);
      }
    }

    // 9b. Log result to campaign_iterations (audit trail)
    await logIteration(campaignId, playbookId, result);

    // 10. Commit spend
    await commitSpend(campaignId, estimatedCost, result.costUsd || 0);
    budgetReserved = false; // prevent double-release in catch

    // 11. Transition campaign to succeeded/failed
    const succeeded = !result.isError;
    await transitionCampaign(campaignId, campaign.work_item_id, succeeded, result);

    // 11a. Post output as Linear comment for non-PR playbooks (output_type: 'comment')
    const outputType = playbook.meta.output_type || 'pr';
    if (succeeded && outputType === 'comment' && metadata.linear_issue_id) {
      try {
        const cliOutput = (result.result || '').trim();
        if (cliOutput) {
          // Truncate to Linear's practical comment size (~10k chars)
          const commentBody = cliOutput.length > 10000
            ? cliOutput.slice(0, 9900) + '\n\n---\n*Output truncated (10k char limit)*'
            : cliOutput;
          await addBotComment(metadata.linear_issue_id, commentBody);
          log.info(` Posted ${playbookId} output as Linear comment (${commentBody.length} chars)`);
        } else {
          await addBotComment(metadata.linear_issue_id,
            `Workshop completed (${playbookId}) but produced no output. Check campaign logs for details.`);
        }
      } catch (err) {
        log.warn(` Failed to post output comment: ${err.message}`);
      }
    }

    // 12. Update Linear issue state (best-effort)
    // ADR-017: permission check + audit for api_client:linear
    // UUID is staqsIO workspace "Internal Review" state — will no-op if workspace changes
    // Skip for reply tasks — conversational replies don't need review status,
    // and the state change would re-trigger ingest creating a loop.
    if (succeeded && metadata.linear_issue_id && metadata.task_mode !== 'reply') {
      const linearStartMs = Date.now();
      let linearSuccess = false;
      try {
        await requirePermission('claw-workshop', 'api_client', 'linear');
        await updateIssueStateByName(metadata.linear_issue_id, 'Internal Review');
        linearSuccess = true;
        log.info(` Updated Linear issue to Internal Review`);
      } catch (err) {
        log.warn(` Failed to update Linear state: ${err.message}`);
      } finally {
        logCapabilityInvocation({
          agentId: 'claw-workshop', resourceType: 'api_client', resourceName: 'linear',
          success: linearSuccess, durationMs: Date.now() - linearStartMs,
          errorMessage: linearSuccess ? null : 'failed or denied',
        });
      }
    }

    // 13. Publish event
    await publishEvent(
      succeeded ? 'workshop_succeeded' : 'workshop_failed',
      `Workshop ${campaignId}: ${succeeded ? 'PR created' : 'failed'} (${playbookId})`,
      'claw-workshop',
      campaign.work_item_id,
      {
        campaign_id: campaignId,
        playbook_id: playbookId,
        cost_usd: result.costUsd,
        num_turns: result.numTurns,
        duration_ms: result.durationMs,
        is_error: result.isError,
      },
    );

    // 14. Record to Neo4j learning graph (best-effort)
    await recordCampaignOutcome(campaignId, succeeded ? 'succeeded' : 'failed', 1, result.costUsd || 0, null);

    // 15. Campaign promotion on success (P1: only if configured)
    if (succeeded) {
      try {
        const { promote } = await import('../../autobot-inbox/src/runtime/campaign-promoter.js');
        await promote(campaignId, 'claw-workshop');
      } catch (err) {
        log.error(` Promotion failed for ${campaignId}:`, err.message);
        await publishEvent('campaign_promotion_failed', err.message, 'claw-workshop', campaign.work_item_id, { campaign_id: campaignId }).catch(() => {});
      }
    }

    // 16. Clean up workspace on failure (keep on success for PR branch)
    if (!succeeded) {
      await cleanupWorkspace(campaignId);
    }

    await completeActivityStep(stepId, {
      status: succeeded ? 'completed' : 'failed',
      metadata: { cost_usd: result.costUsd, playbook_id: playbookId },
    });

    log.info(` ${campaignId} ${succeeded ? 'succeeded' : 'failed'} ($${result.costUsd?.toFixed(2) || '0.00'}, ${result.numTurns} turns, ${Math.round((result.durationMs || 0) / 1000)}s)`);

  } catch (err) {
    log.error(` ${campaignId} error:`, redactSecrets(err.message));

    // Release budget if reserved
    if (budgetReserved) {
      await releaseBudget(campaignId, estimatedCost).catch(e =>
        log.warn(` Budget release failed: ${e.message}`)
      );
    }

    // Mark campaign as failed
    try {
      const campaign = await loadCampaign(campaignId);
      if (campaign) {
        await transitionCampaign(campaignId, campaign.work_item_id, false, { error: err.message });
      }
    } catch (e) {
      log.warn(` Failed to transition campaign on error: ${e.message}`);
    }

    // Clean up workspace
    if (workspacePath) {
      await cleanupWorkspace(campaignId).catch(e =>
        log.warn(` Workspace cleanup failed: ${e.message}`)
      );
    }

    await completeActivityStep(stepId, { status: 'failed', metadata: { error: err.message } });
  }
}

/**
 * Load campaign row with all relevant fields.
 */
async function loadCampaign(campaignId) {
  const result = await query(
    `SELECT c.id, c.work_item_id, c.goal_description, c.success_criteria,
            c.metadata, c.campaign_mode, c.campaign_status,
            w.title, w.description, w.metadata AS work_item_metadata
     FROM agent_graph.campaigns c
     JOIN agent_graph.work_items w ON w.id = c.work_item_id
     WHERE c.id = $1`,
    [campaignId]
  );
  return result.rows[0] || null;
}

/**
 * Build the user prompt from issue context.
 * Fetches full Linear issue body when available (work_item.description is truncated to 500 chars).
 */
async function buildPrompt(campaign, metadata) {
  const parts = [
    `# Task: ${campaign.title || campaign.goal_description || 'Workshop task'}`,
    '',
  ];

  if (metadata.linear_identifier) {
    parts.push(`**Linear Issue:** ${metadata.linear_identifier} (${metadata.linear_issue_url || ''})`);
  }

  if (metadata.target_repo) {
    parts.push(`**Target Repo:** ${metadata.target_repo}`);
  }

  parts.push('');

  // Fetch full Linear issue body (work_item.description is truncated)
  let fullDescription = campaign.description;
  if (metadata.linear_issue_id) {
    try {
      const issue = await getIssue(metadata.linear_issue_id);
      if (issue?.description) {
        fullDescription = issue.description;
        log.info(` Fetched full issue body for ${metadata.linear_identifier} (${issue.description.length} chars)`);
      }
    } catch (err) {
      log.warn(` Could not fetch Linear issue ${metadata.linear_issue_id}: ${err.message}`);
    }
  }

  if (fullDescription) {
    parts.push('## Description', '', fullDescription, '');
  }

  if (campaign.goal_description && campaign.goal_description !== fullDescription) {
    parts.push('## Goal', '', campaign.goal_description, '');
  }

  parts.push(
    '## Instructions',
    '',
    'Follow the playbook phases in order. Execute each phase completely before moving to the next.',
    'Your output should be a PR (or a report for investigate playbooks).',
  );

  return parts.join('\n');
}

/**
 * Build prompt for reply tasks — includes conversation history.
 */
function buildReplyPrompt(campaign, metadata, comments) {
  const parts = [
    `# Reply to board member on: ${campaign.title || campaign.goal_description || 'issue'}`,
    '',
  ];

  if (metadata.linear_identifier) {
    parts.push(`**Linear Issue:** ${metadata.linear_identifier} (${metadata.linear_issue_url || ''})`);
  }

  if (metadata.target_repo) {
    parts.push(`**Target Repo:** ${metadata.target_repo}`);
  }

  parts.push('');

  if (campaign.description) {
    parts.push('## Original Issue Description', '', campaign.description, '');
  }

  // Add conversation history
  if (comments?.length) {
    parts.push('## Conversation History', '');
    for (const c of comments) {
      const ts = new Date(c.createdAt).toISOString().slice(0, 16);
      parts.push(`**${c.userName}** (${ts}):`);
      // Cap each comment to prevent context overflow
      parts.push(c.body.slice(0, 1000));
      parts.push('');
    }
  }

  // Highlight the latest question
  if (metadata.reply_question) {
    parts.push('## Your Task', '', `Answer this question/request from **${metadata.triggered_by || 'a board member'}**:`, '', metadata.reply_question, '');
  }

  parts.push(
    '## Instructions',
    '',
    'Read the conversation and the issue. Answer the question thoroughly.',
    'Print your response directly to stdout. It will be posted as a Linear comment.',
    'Do NOT create a PR or modify files. If code changes are needed, suggest creating a new task.',
  );

  return parts.join('\n');
}

/**
 * Log iteration result to campaign_iterations table.
 */
async function logIteration(campaignId, playbookId, result) {
  try {
    await query(
      `INSERT INTO agent_graph.campaign_iterations
       (campaign_id, iteration_number, strategy_used, action_taken, cost_usd, duration_ms, decision)
       VALUES ($1, 1, $2, $3, $4, $5, $6)`,
      [
        campaignId,
        JSON.stringify({ type: 'workshop', playbook: playbookId }),
        result.result?.slice(0, 2000) || '',
        result.costUsd || 0,
        result.durationMs || 0,
        result.isError ? 'stop_error' : 'stop_success',
      ]
    );
  } catch (err) {
    log.warn(` Failed to log iteration: ${err.message}`);
  }
}

/**
 * Transition campaign and work item to terminal state.
 */
async function transitionCampaign(campaignId, workItemId, succeeded, result) {
  const status = succeeded ? 'succeeded' : 'failed';

  await query(
    `UPDATE agent_graph.campaigns
     SET campaign_status = $1, completed_at = now(), updated_at = now()
     WHERE id = $2`,
    [status, campaignId]
  );

  const workItemStatus = succeeded ? 'completed' : 'failed';
  await query(
    `UPDATE agent_graph.work_items SET status = $1, updated_at = now() WHERE id = $2`,
    [workItemStatus, workItemId]
  );
}
