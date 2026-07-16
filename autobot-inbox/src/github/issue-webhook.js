/**
 * GitHub Issue Webhook → intent/work-item pipeline.
 *
 * Mirrors the Linear webhook pattern (src/linear/ingest.js):
 * 1. Filter: only issues.opened, issues.labeled, issues.assigned
 * 2. Match labels against config-driven routing table (config/github-bot.json)
 * 3. auto-fix label → direct work item (board pre-authorized)
 * 4. Other actionable labels → intent for board review
 *
 * P1: deny by default — only configured labels trigger work.
 * P2: infrastructure enforces — routing is config-driven, not hardcoded.
 * Dedup: triggerContext.pattern = 'github_issue_${repo}_${number}' keys into
 *        the uq_agent_intents_pattern_dedup constraint (Linus review fix).
 */

import { query } from '../db.js';
import { createIntent } from '../runtime/intent-manager.js';
import { getConfig } from '../../../lib/config/loader.js';

const config = getConfig('github-bot');

const ACTIONABLE_EVENTS = new Set(['opened', 'labeled', 'assigned']);

/**
 * Handle a GitHub issue webhook payload. Called from api.js after auth verification.
 *
 * @param {Object} payload - Raw GitHub webhook body
 * @param {Function} createWorkItem - state-machine.js createWorkItem
 * @returns {Object} Result with issueNumber/workItemId/intentId or skipped reason
 */
export async function handleGitHubIssueWebhook(payload, createWorkItem) {
  const { action, issue, repository } = payload;

  if (!issue?.number || !ACTIONABLE_EVENTS.has(action)) {
    return { skipped: true, reason: `Unsupported action: ${action}` };
  }

  const repoFullName = repository?.full_name;
  if (!repoFullName || !config.repos.includes(repoFullName)) {
    return { skipped: true, reason: `Repo not configured: ${repoFullName}` };
  }

  const issueLabels = (issue.labels || []).map(l => l.name);
  console.log(`[github-ingest] Issue #${issue.number} action=${action} labels=[${issueLabels.join(',')}]`);

  // P1: Check for auto-fix label → direct work item (board pre-authorized)
  const isAutoFix = issueLabels.some(l => config.autoFixLabels.includes(l));
  if (isAutoFix) {
    return handleAutoFix(issue, repoFullName, createWorkItem);
  }

  // Check for any actionable intent label
  const matchedLabel = issueLabels.find(l => config.intentLabels[l]);
  if (!matchedLabel) {
    return { skipped: true, reason: `No actionable labels on #${issue.number}` };
  }

  // Create intent for board review
  return handleIntentLabel(issue, repoFullName, matchedLabel);
}

/**
 * auto-fix labeled issue → direct work item (skip intent, board pre-authorized).
 * Mirrors Linear auto-fix flow.
 */
async function handleAutoFix(issue, repoFullName, createWorkItem) {
  // Deduplicate: check for existing work item
  const existing = await query(
    `SELECT id FROM agent_graph.work_items
     WHERE metadata->>'github_issue_number' = $1
       AND metadata->>'github_repo' = $2
       AND status NOT IN ('completed', 'cancelled', 'failed')
     LIMIT 1`,
    [String(issue.number), repoFullName]
  );

  if (existing.rows.length > 0) {
    console.log(`[github-ingest] Skipping duplicate: work item ${existing.rows[0].id} exists for #${issue.number}`);
    return { skipped: true, reason: 'Work item already exists', existingWorkItemId: existing.rows[0].id };
  }

  const ticketBody = buildTicketBody(issue, repoFullName);

  // Create action_proposal (same shape as Linear pipeline)
  const proposalResult = await query(
    `INSERT INTO agent_graph.action_proposals
     (action_type, body, target_repo)
     VALUES ('ticket_create', $1, $2)
     RETURNING id`,
    [ticketBody, repoFullName]
  );
  const proposalId = proposalResult.rows[0].id;

  const workItem = await createWorkItem({
    type: 'task',
    title: `Auto-fix: #${issue.number} — ${issue.title}`,
    description: issue.body?.slice(0, 500) || '',
    createdBy: 'orchestrator',
    assignedTo: 'executor-coder',
    priority: 1,
    metadata: {
      ticket_proposal_id: proposalId,
      target_repo: repoFullName,
      github_issue_number: String(issue.number),
      github_issue_url: issue.html_url,
      github_repo: repoFullName,
      source: 'github-issue-webhook',
    },
  });

  console.log(`[github-ingest] Created work item ${workItem?.id} for auto-fix #${issue.number}`);
  return { issueNumber: issue.number, workItemId: workItem?.id, proposalId };
}

/**
 * Actionable label → intent for board review.
 * Uses pattern-based dedup to prevent unbounded duplicates (Linus review fix).
 */
async function handleIntentLabel(issue, repoFullName, matchedLabel) {
  const routing = config.intentLabels[matchedLabel];
  const agent = routing.agent || config.defaultAgent;
  const tier = routing.tier || config.defaultTier;

  const intent = await createIntent({
    agentId: agent,
    intentType: 'task',
    decisionTier: tier,
    title: `GitHub #${issue.number}: ${issue.title}`,
    reasoning: `Issue labeled "${matchedLabel}" in ${repoFullName}. ${issue.body?.slice(0, 300) || 'No description.'}`,
    proposedAction: {
      type: 'create_work_item',
      payload: {
        type: 'task',
        title: `GitHub #${issue.number}: ${issue.title}`,
        description: issue.body?.slice(0, 500) || '',
        assigned_to: agent,
        priority: tier === 'strategic' ? 2 : 1,
        metadata: {
          target_repo: repoFullName,
          github_issue_number: String(issue.number),
          github_issue_url: issue.html_url,
          github_repo: repoFullName,
          github_label: matchedLabel,
          source: 'github-issue-webhook',
        },
      },
    },
    triggerContext: {
      pattern: `github_issue_${repoFullName}_${issue.number}`,
      source: 'github-issue-webhook',
      github_issue_number: issue.number,
      github_repo: repoFullName,
      github_label: matchedLabel,
    },
    budgetPerFire: tier === 'strategic' ? 0.50 : 0.25,
  });

  if (!intent) {
    console.log(`[github-ingest] Dedup: intent already exists for #${issue.number}`);
    return { skipped: true, reason: `Intent already exists for #${issue.number}` };
  }

  console.log(`[github-ingest] Created intent ${intent.id.slice(0, 8)}... for #${issue.number} [${tier}/${matchedLabel}]`);
  return { issueNumber: issue.number, intentId: intent.id, label: matchedLabel };
}

/**
 * Build structured ticket body for executor consumption.
 */
function buildTicketBody(issue, repoFullName) {
  const labels = (issue.labels || []).map(l => l.name).join(', ');
  const assignee = issue.assignee?.login || 'Unassigned';

  return [
    `# #${issue.number}: ${issue.title}`,
    '',
    `**Repo:** ${repoFullName}`,
    `**Assignee:** ${assignee}`,
    labels ? `**Labels:** ${labels}` : null,
    `**GitHub:** ${issue.html_url}`,
    '',
    '## Description',
    '',
    issue.body || '_No description provided._',
  ].filter(line => line !== null).join('\n');
}
