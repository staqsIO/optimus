/**
 * Auto-Assigner — creates campaigns from triaged issues.
 *
 * Reuses the pattern from src/linear/ingest.js handleWorkshopTrigger().
 * Creates work_item + campaign, auto-approves for clear issues.
 * Updates source issue status (Linear → "In Development", GitHub → label).
 */

import { query } from '../../lib/db.js';
import { publishEvent } from '../../lib/runtime/infrastructure.js';
import { createChildLogger } from '../../lib/logger.js';

const log = createChildLogger({ agent: 'issue-triage' });

/**
 * Check if runners have capacity for new campaigns.
 *
 * @param {string} mode - 'workshop' or 'stateless'
 * @param {number} maxConcurrent - max concurrent for this mode (default 2)
 * @returns {Promise<{ hasCapacity: boolean, active: number, max: number }>}
 */
export async function checkCapacity(mode, maxConcurrent = 2) {
  const filterMode = mode === 'workshop' ? "= 'workshop'" : "!= 'workshop'";
  const result = await query(
    `SELECT COUNT(*) AS active FROM agent_graph.campaigns
     WHERE campaign_status = 'running' AND campaign_mode ${filterMode}`
  );
  const active = parseInt(result.rows[0]?.active || '0');
  return { hasCapacity: active < maxConcurrent, active, max: maxConcurrent };
}

/**
 * Auto-assign an issue by creating a campaign.
 *
 * @param {Object} issue - Unified issue from issue-fetcher
 * @param {Object} evaluation - Result from triage-evaluator
 * @param {string} triageLogId - ID of the triage_log entry to update
 * @returns {Promise<{ workItemId: string, campaignId: string } | null>}
 */
export async function autoAssignIssue(issue, evaluation, triageLogId) {
  const mode = evaluation.campaign_mode || 'workshop';
  const budget = evaluation.scope_estimate === 'S' ? 5.00 : evaluation.scope_estimate === 'M' ? 10.00 : 20.00;
  const maxIterations = mode === 'workshop' ? 1 : (evaluation.scope_estimate === 'S' ? 5 : 10);

  // Create work item
  const wiResult = await query(
    `INSERT INTO agent_graph.work_items (type, title, description, status, assigned_to, created_by, priority, metadata)
     VALUES ('campaign', $1, $2, 'assigned', $3, 'issue-triage', $4, $5)
     RETURNING id`,
    [
      issue.title,
      issue.description?.slice(0, 2000) || issue.title,
      mode === 'workshop' ? 'claw-workshop' : 'claw-campaigner',
      issue.priority <= 2 ? 2 : 3,
      JSON.stringify({
        source: issue.source,
        source_issue_id: issue.sourceIssueId,
        source_issue_url: issue.sourceIssueUrl,
        target_repo: evaluation.target_repo,
        playbook_id: evaluation.playbook_id,
        triage_log_id: triageLogId,
        auto_triaged: true,
      }),
    ]
  );
  const workItemId = wiResult.rows[0].id;

  // Create campaign (auto-approved)
  const campResult = await query(
    `INSERT INTO agent_graph.campaigns
     (work_item_id, goal_description, campaign_mode, campaign_status,
      budget_envelope_usd, max_iterations, created_by, metadata)
     VALUES ($1, $2, $3, 'approved', $4, $5, 'issue-triage', $6)
     RETURNING id`,
    [
      workItemId,
      issue.title + (issue.description ? '\n\n' + issue.description.slice(0, 1000) : ''),
      mode,
      budget,
      maxIterations,
      JSON.stringify({
        source: issue.source,
        source_issue_id: issue.sourceIssueId,
        source_issue_url: issue.sourceIssueUrl,
        target_repo: evaluation.target_repo,
        playbook_id: evaluation.playbook_id,
        classification: evaluation.classification,
        auto_triaged: true,
        triage_reasoning: evaluation.reasoning,
      }),
    ]
  );
  const campaignId = campResult.rows[0].id;

  // Update triage log with linkage
  await query(
    `UPDATE agent_graph.issue_triage_log SET work_item_id = $1, campaign_id = $2 WHERE id = $3`,
    [workItemId, campaignId, triageLogId]
  );

  // Publish event for instant wake-up
  await publishEvent('campaign_approved', `Auto-triaged: ${issue.title}`, 'issue-triage', workItemId, {
    campaign_id: campaignId,
    source: issue.source,
    source_issue_id: issue.sourceIssueId,
  }).catch(() => {});

  log.info(` Auto-assigned "${issue.title}" → campaign ${campaignId.slice(0, 8)} (${mode})`);
  return { workItemId, campaignId };
}

/**
 * Post a clarification comment on the source issue.
 */
export async function requestClarification(issue, questions, linearClient) {
  const commentBody = [
    `🤖 **Optimus Triage**: This issue needs clarification before it can be worked on.\n`,
    ...questions.map((q, i) => `${i + 1}. ${q}`),
    `\n_Please update the issue with these details and I'll re-evaluate on my next pass._`,
  ].join('\n');

  if (issue.source === 'linear' && linearClient) {
    try {
      await linearClient.addBotComment(issue.sourceIssueId, commentBody);
      log.info(` Posted clarification on Linear issue "${issue.title}"`);
    } catch (err) {
      log.warn(` Failed to comment on Linear: ${err.message}`);
    }
  }
  // GitHub commenting can be added later
}
