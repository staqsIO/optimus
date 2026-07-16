/**
 * Campaign Promotion Dispatcher (ADR-021 extension).
 *
 * When a campaign succeeds, this module reads metadata.promotion and
 * dispatches to the appropriate promotion handler:
 *   - "pr"       → create a GitHub PR from the workspace diff
 *   - "proposal" → insert an action_proposal for board review
 *   - "chain"    → auto-approve dependent campaigns linked via edges
 *
 * P1: deny by default — if metadata.promotion is absent, nothing happens.
 * P4: boring infrastructure — direct calls, no event bus.
 */

import { query } from '../../../lib/db.js';
import { publishEvent } from '../../../lib/runtime/infrastructure.js';
import { createPR } from '../github/pr-creator.js';
import { execSync } from 'node:child_process';
import { requirePermission, logCapabilityInvocation } from '../../../lib/runtime/permissions.js';
import { createLogger } from '../../../lib/logger.js';
import { getConfig } from '../../../lib/config/loader.js';
const log = createLogger('runtime/campaign-promoter');

// Load github-bot config for opt-in Copilot review
let githubBotConfig = {};
try {
  githubBotConfig = getConfig('github-bot');
} catch { /* config unavailable — no reviewers */ }

const MAX_PROPOSAL_BODY_BYTES = 100_000; // 100KB cap

/**
 * Main entry point — called from stopCampaign() and workshop-runner on success.
 *
 * @param {string} campaignId
 * @param {string} [agentId='claw-campaigner'] - Calling agent's ID for permission checks
 */
export async function promote(campaignId, agentId = 'claw-campaigner') {
  const row = await query(
    `SELECT c.id, c.work_item_id, c.goal_description, c.metadata,
            c.campaign_mode, c.workspace_path
     FROM agent_graph.campaigns c WHERE c.id = $1`,
    [campaignId]
  );
  const campaign = row.rows[0];
  if (!campaign) {
    log.warn(`Campaign ${campaignId} not found`);
    return;
  }

  const metadata = typeof campaign.metadata === 'string'
    ? JSON.parse(campaign.metadata) : campaign.metadata || {};
  const config = metadata.promotion;
  if (!config) return; // P1: no promotion configured

  log.info(`Promoting campaign ${campaignId} (type: ${config.type})`);

  switch (config.type) {
    case 'pr':
      await promoteToPR(campaign, config, agentId);
      break;
    case 'proposal':
      await promoteToProposal(campaign, config);
      break;
    case 'chain':
      await promoteChain(campaign, config);
      break;
    default:
      log.warn(`Unknown promotion type: ${config.type}`);
  }
}

/**
 * Feature 1: Create a GitHub PR from stateful campaign workspace.
 */
async function promoteToPR(campaign, config, agentId) {
  if (!campaign.workspace_path) {
    log.warn(`Cannot create PR — no workspace_path for ${campaign.id}`);
    return;
  }

  // Get best iteration summary for PR body
  const bestIter = await query(
    `SELECT action_taken, quality_score, iteration_number, git_commit_hash
     FROM agent_graph.campaign_iterations
     WHERE campaign_id = $1 AND decision IN ('keep', 'stop_success')
     ORDER BY quality_score DESC NULLS LAST LIMIT 1`,
    [campaign.id]
  );
  const iteration = bestIter.rows[0];

  // Extract changed files from workspace diff against main
  const files = getWorkspaceFiles(campaign.workspace_path);
  if (files.length === 0) {
    log.warn(`No changed files in workspace for ${campaign.id}`);
    return;
  }

  // Parse target repo
  const targetRepo = config.target_repo || 'staqsIO/optimus-private';
  const [owner, repo] = targetRepo.split('/');

  const prTitle = `[campaign] ${campaign.goal_description?.slice(0, 60) || campaign.id}`;
  const prBody = buildPRBody(campaign, iteration);

  // ADR-017: permission check for github PR creation
  await requirePermission(agentId, 'api_client', 'github');

  const startMs = Date.now();
  const requestReviewers = githubBotConfig.copilotReview ? ['copilot'] : [];

  const result = await createPR({
    owner,
    repo,
    baseBranch: 'develop',
    branchPrefix: 'campaign',
    files,
    commitMessage: `campaign(${campaign.id}): ${campaign.goal_description?.slice(0, 60)}`,
    prTitle,
    prBody,
    labels: ['campaign-output'],
    requestReviewers,
  });

  logCapabilityInvocation({
    agentId, resourceType: 'api_client', resourceName: 'github',
    success: true, durationMs: Date.now() - startMs, workItemId: campaign.work_item_id,
    resultSummary: `PR: ${result.prUrl}`,
  });

  log.info(`PR created: ${result.prUrl}`);

  // Insert action_proposal for board visibility
  await query(
    `INSERT INTO agent_graph.action_proposals
     (work_item_id, agent_id, action_type, channel, subject, body, metadata, campaign_id)
     VALUES ($1, 'claw-campaigner', 'code_fix_pr', 'github', $2, $3, $4, $5)`,
    [
      campaign.work_item_id,
      prTitle,
      `PR created: ${result.prUrl}`,
      JSON.stringify({ pr_url: result.prUrl, pr_number: result.prNumber, branch: result.branchName }),
      campaign.id,
    ]
  );

  await publishEvent('campaign_promoted', `Campaign ${campaign.id} → PR #${result.prNumber}`, 'claw-campaigner', campaign.work_item_id, {
    campaign_id: campaign.id, promotion_type: 'pr', pr_url: result.prUrl,
  }).catch(() => {});
}

/**
 * Feature 2: Create an action_proposal from stateless campaign output.
 */
async function promoteToProposal(campaign, config) {
  const bestIter = await query(
    `SELECT action_taken, quality_score
     FROM agent_graph.campaign_iterations
     WHERE campaign_id = $1 AND decision IN ('keep', 'stop_success')
     ORDER BY quality_score DESC NULLS LAST LIMIT 1`,
    [campaign.id]
  );
  const iteration = bestIter.rows[0];
  if (!iteration?.action_taken) {
    log.warn(`No action_taken found for campaign ${campaign.id}`);
    return;
  }

  // Cap body size
  let body = iteration.action_taken;
  if (Buffer.byteLength(body, 'utf8') > MAX_PROPOSAL_BODY_BYTES) {
    body = body.slice(0, MAX_PROPOSAL_BODY_BYTES) + '\n\n[truncated — exceeded 100KB]';
  }

  const actionType = config.proposal_action_type || 'campaign_result';

  await query(
    `INSERT INTO agent_graph.action_proposals
     (work_item_id, agent_id, action_type, channel, subject, body, metadata, campaign_id)
     VALUES ($1, 'claw-campaigner', $2, 'internal', $3, $4, $5, $6)`,
    [
      campaign.work_item_id,
      actionType,
      `Campaign result: ${campaign.goal_description?.slice(0, 80)}`,
      body,
      JSON.stringify({ quality_score: iteration.quality_score }),
      campaign.id,
    ]
  );

  log.info(`Proposal created for campaign ${campaign.id} (type: ${actionType})`);

  await publishEvent('campaign_promoted', `Campaign ${campaign.id} → action_proposal (${actionType})`, 'claw-campaigner', campaign.work_item_id, {
    campaign_id: campaign.id, promotion_type: 'proposal', action_type: actionType,
  }).catch(() => {});
}

/**
 * Feature 3: Auto-approve dependent campaigns linked via edges.
 */
async function promoteChain(campaign, _config) {
  // Find pending_approval campaigns that depend on this campaign's work_item
  const dependents = await query(
    `SELECT c.id, c.goal_description
     FROM agent_graph.campaigns c
     JOIN agent_graph.edges e ON e.to_id = c.work_item_id
     WHERE e.from_id = $1
       AND e.edge_type = 'depends_on'
       AND c.campaign_status = 'pending_approval'`,
    [campaign.work_item_id]
  );

  if (dependents.rows.length === 0) {
    log.info(`No pending dependents for campaign ${campaign.id}`);
    return;
  }

  for (const dep of dependents.rows) {
    await query(
      `UPDATE agent_graph.campaigns SET campaign_status = 'approved', updated_at = now() WHERE id = $1`,
      [dep.id]
    );
    log.info(`Chain-approved campaign ${dep.id}: ${dep.goal_description?.slice(0, 60)}`);
  }

  await publishEvent('campaign_chain_triggered', `Campaign ${campaign.id} chain-approved ${dependents.rows.length} dependent(s)`, 'claw-campaigner', campaign.work_item_id, {
    campaign_id: campaign.id,
    approved_ids: dependents.rows.map(d => d.id),
  }).catch(() => {});
}

// ============================================================
// Helpers
// ============================================================

/**
 * Extract changed files from a git worktree as {path, content} pairs.
 * Compares workspace HEAD against the merge-base with main.
 */
function getWorkspaceFiles(workspacePath) {
  try {
    // Get list of changed files relative to main
    const diffOutput = execSync(
      'git diff --name-only main...HEAD',
      { cwd: workspacePath, encoding: 'utf8', timeout: 10_000 }
    ).trim();

    if (!diffOutput) return [];

    const filePaths = diffOutput.split('\n').filter(Boolean);
    const files = [];

    for (const filePath of filePaths) {
      try {
        const content = execSync(
          `git show HEAD:${filePath}`,
          { cwd: workspacePath, encoding: 'utf8', timeout: 5_000 }
        );
        files.push({ path: filePath, content });
      } catch {
        // File was deleted — skip (createPR only handles creates/updates)
      }
    }

    return files;
  } catch (err) {
    log.warn(`Failed to extract workspace files: ${err.message}`);
    return [];
  }
}

function buildPRBody(campaign, iteration) {
  const apiBase = process.env.API_BASE_URL || 'https://preview.staqs.io';
  const parts = [
    `## Campaign Output`,
    '',
    `**Goal:** ${campaign.goal_description || 'N/A'}`,
    `**Campaign ID:** \`${campaign.id}\``,
    `**Mode:** ${campaign.campaign_mode}`,
  ];

  if (iteration) {
    parts.push(
      '',
      `**Best iteration:** #${iteration.iteration_number} (score: ${iteration.quality_score})`,
    );
    if (iteration.git_commit_hash) {
      parts.push(`**Commit:** \`${iteration.git_commit_hash}\``);
    }
  }

  parts.push(
    '',
    `### Preview & Review`,
    `- [View output](${apiBase}/api/campaigns/${campaign.id}/preview)`,
    `- [Download files](${apiBase}/api/campaigns/${campaign.id}/download)`,
    '',
    `### Deploy Preview`,
    `To test these changes in the Railway preview environment:`,
    '```bash',
    `railway link --environment preview`,
    `railway up  # deploys this branch to preview env`,
    '```',
    '',
    '---',
    '*Auto-generated by campaign promotion system (ADR-021)*',
  );
  return parts.join('\n');
}
