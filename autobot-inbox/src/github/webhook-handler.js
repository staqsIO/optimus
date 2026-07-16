/**
 * GitHub Webhook Handler: multi-event routing with three-tier dispatch.
 *
 * Replaces the single-event issue-webhook.js with support for:
 * - issues (existing: auto-fix → work_item, labels → intent)
 * - pull_request (review requests, changes requested → signal)
 * - pull_request_review (submitted reviews → signal)
 * - issue_comment (comments on tracked issues → signal)
 * - check_suite (CI failures → intent for board review)
 *
 * P1: deny by default — only configured repos and event types are processed.
 * P2: infrastructure enforces — routing is config-driven via github-bot.json.
 * P4: boring infrastructure — raw SQL, no ORM.
 */

import { query } from '../db.js';
import { createIntent } from '../runtime/intent-manager.js';
import { ingestAsSignal } from '../webhooks/signal-ingester.js';
import { updateIssueState, addBotComment } from '../linear/client.js';
import { getConfig } from '../../../lib/config/loader.js';

const config = getConfig('github-bot');

// Re-export for backward compat (api.js previously imported from issue-webhook.js)
export { handleGitHubIssueWebhook } from './issue-webhook.js';

/**
 * Main GitHub webhook dispatcher. Routes by x-github-event header.
 *
 * @param {string} eventType - Value of x-github-event header
 * @param {Object} payload - Raw GitHub webhook body
 * @param {Function} createWorkItem - state-machine.js createWorkItem
 * @param {string} deliveryId - X-GitHub-Delivery header (per-delivery UUID).
 *                              Used as the dedup suffix in providerMsgId so
 *                              GitHub retry deliveries collapse against the
 *                              partial unique index on inbox.messages
 *                              (provider_msg_id). Must be present.
 * @returns {Object} Result with identifiers or skipped reason
 */
export async function handleGitHubWebhook(eventType, payload, createWorkItem, deliveryId) {
  // P1: deny by default — delivery ID is required for dedup correctness.
  if (!deliveryId) {
    return { skipped: true, reason: 'Missing X-GitHub-Delivery header' };
  }
  const repoFullName = payload.repository?.full_name;
  if (!repoFullName || !config.repos.includes(repoFullName)) {
    return { skipped: true, reason: `Repo not configured: ${repoFullName}` };
  }

  // Route by event type
  switch (eventType) {
    case 'issues': {
      const { handleGitHubIssueWebhook } = await import('./issue-webhook.js');
      return handleGitHubIssueWebhook(payload, createWorkItem);
    }

    case 'pull_request':
      return handlePullRequestEvent(payload, repoFullName, deliveryId);

    case 'pull_request_review':
      return handlePullRequestReviewEvent(payload, repoFullName, deliveryId);

    case 'issue_comment':
      return handleIssueCommentEvent(payload, repoFullName, deliveryId);

    case 'check_suite':
      return handleCheckSuiteEvent(payload, repoFullName, deliveryId);

    default: {
      // Unknown event type in watched repo → signal-only (generic awareness)
      const eventConfig = config.watchedEvents?.[eventType];
      if (!eventConfig) {
        return { skipped: true, reason: `Unhandled GitHub event: ${eventType}` };
      }
      // Generic signal for any other configured event
      return ingestGenericGitHubSignal(eventType, payload, repoFullName, deliveryId);
    }
  }
}

// Linear bot config for state IDs (loaded lazily to avoid circular deps)
let _linearConfig;
function getLinearConfig() {
  if (!_linearConfig) {
    _linearConfig = getConfig('linear-bot');
  }
  return _linearConfig;
}

/**
 * Handle PR merged → close linked Linear issues.
 * Extracts Linear issue IDs from the PR branch name (e.g., "eric/staqpro-2")
 * or from work_items with matching PR metadata.
 */
async function handlePRMerged(pr, _repoFullName) {
  const deliveredStateId = getLinearConfig().states?.delivered;
  if (!deliveredStateId) {
    console.warn('[github-webhook] No "delivered" state configured in linear-bot.json');
    return { merged: true, linearClosed: false, reason: 'No delivered state configured' };
  }

  // Find work_items linked to this PR (executor-coder stores PR URL in metadata)
  const linked = await query(
    `SELECT id, metadata->>'linear_issue_id' AS linear_issue_id
     FROM agent_graph.work_items
     WHERE metadata->>'github_pr_url' = $1
        OR metadata->>'github_pr_number' = $2`,
    [pr.html_url, String(pr.number)]
  );

  const closedIssues = [];

  for (const row of linked.rows) {
    if (!row.linear_issue_id) continue;
    try {
      await updateIssueState(row.linear_issue_id, deliveredStateId);
      await addBotComment(row.linear_issue_id,
        `PR #${pr.number} merged into \`${pr.base?.ref || 'main'}\`. Moving to Delivered.\n\n` +
        `[View PR](${pr.html_url})`
      );
      closedIssues.push(row.linear_issue_id);
      console.log(`[github-webhook] PR #${pr.number} merged → Linear issue ${row.linear_issue_id} → Delivered`);
    } catch (err) {
      console.warn(`[github-webhook] Failed to close Linear issue ${row.linear_issue_id}: ${err.message}`);
    }
  }

  // Also complete the work_items
  if (linked.rows.length > 0) {
    await query(
      `UPDATE agent_graph.work_items SET status = 'completed'
       WHERE (metadata->>'github_pr_url' = $1 OR metadata->>'github_pr_number' = $2)
         AND status NOT IN ('completed', 'cancelled', 'failed')`,
      [pr.html_url, String(pr.number)]
    );
  }

  // Auto-complete action_proposals for this PR (clears ACTION REQUIRED on board)
  await query(
    `UPDATE agent_graph.action_proposals
     SET send_state = 'delivered', board_action = 'approved', acted_at = now()
     WHERE github_pr_url = $1
       AND send_state NOT IN ('delivered', 'cancelled')`,
    [pr.html_url]
  ).catch(err => console.warn(`[github-webhook] action_proposals update failed: ${err.message}`));

  // Auto-resolve triage items linked to this PR
  await query(
    `UPDATE agent_graph.issue_triage_log
     SET decision_overridden_by = 'auto_merged', decision_overridden_at = now()
     WHERE source_issue_url LIKE $1
       AND decision = 'board_review'
       AND decision_overridden_by IS NULL`,
    [`%/pull/${pr.number}`]
  ).catch(err => console.warn(`[github-webhook] triage cleanup failed: ${err.message}`));

  return { merged: true, prNumber: pr.number, linearClosed: closedIssues.length > 0, closedIssues };
}

/**
 * Handle pull_request events (review requests, changes requested, merged).
 */
async function handlePullRequestEvent(payload, repoFullName, deliveryId) {
  const { action, pull_request: pr } = payload;

  // Special handling: PR merged → close linked Linear issues
  if (action === 'closed' && pr.merged) {
    return handlePRMerged(pr, repoFullName);
  }

  const eventConfig = config.watchedEvents?.pull_request;

  if (!eventConfig || !eventConfig.actions.includes(action)) {
    return { skipped: true, reason: `PR action not watched: ${action}` };
  }

  const signalType = eventConfig.signalType || 'request';
  const reviewer = payload.requested_reviewer?.login || 'unknown';

  const result = await ingestAsSignal({
    source: 'github',
    title: `PR #${pr.number}: ${pr.title} [${action}]`,
    snippet: action === 'review_requested'
      ? `Review requested from ${reviewer} on PR #${pr.number}: ${pr.title}`
      : `Changes requested on PR #${pr.number}: ${pr.title}`,
    from: pr.user?.login || 'GitHub',
    signals: [{
      signal_type: signalType,
      content: `PR #${pr.number} ${action}: ${pr.title} (${repoFullName})`,
      confidence: 0.9,
      direction: 'inbound',
      domain: repoFullName.split('/')[0],
    }],
    metadata: {
      github_pr_number: pr.number,
      github_pr_url: pr.html_url,
      github_repo: repoFullName,
      github_action: action,
      github_reviewer: reviewer,
    },
    labels: ['github:pr', `github:${action}`],
    providerMsgId: `github_pr_${repoFullName}_${pr.number}_${action}_${deliveryId}`,
    // STAQPRO-562: a watched PR action (review_requested / changes_requested)
    // is genuinely actionable — it ties to a PR we own. Passing the PR number
    // as linkedWorkItemId bypasses the machine-notification noise gate so the
    // signal still promotes. Only unlinked push/CI chatter is gated to noise.
    channel: 'github',
    eventType: 'pull_request',
    linkedWorkItemId: `pr:${repoFullName}#${pr.number}`,
  });

  if (!result) {
    return { skipped: true, reason: `Duplicate PR signal for #${pr.number}` };
  }

  console.log(`[github-webhook] PR signal: #${pr.number} ${action} → msgId=${result.messageId}`);
  return { prNumber: pr.number, messageId: result.messageId, tier: 3 };
}

/**
 * Handle pull_request_review events (review submitted).
 */
async function handlePullRequestReviewEvent(payload, repoFullName, deliveryId) {
  const { action, review, pull_request: pr } = payload;
  const eventConfig = config.watchedEvents?.pull_request_review;

  if (!eventConfig || !eventConfig.actions.includes(action)) {
    return { skipped: true, reason: `PR review action not watched: ${action}` };
  }

  const state = review?.state || 'unknown'; // approved, changes_requested, commented

  const result = await ingestAsSignal({
    source: 'github',
    title: `PR #${pr.number} review: ${state} by ${review?.user?.login || 'unknown'}`,
    snippet: review?.body?.slice(0, 2000) || `[${state} review on PR #${pr.number}]`,
    from: review?.user?.login || 'GitHub',
    signals: [{
      signal_type: eventConfig.signalType || 'info',
      content: `PR #${pr.number} ${state} by ${review?.user?.login || 'unknown'}: ${pr.title} (${repoFullName})`,
      confidence: 0.9,
      direction: 'inbound',
      domain: repoFullName.split('/')[0],
    }],
    metadata: {
      github_pr_number: pr.number,
      github_pr_url: pr.html_url,
      github_repo: repoFullName,
      github_review_state: state,
      github_reviewer: review?.user?.login,
    },
    labels: ['github:review', `github:review-${state}`],
    providerMsgId: `github_review_${repoFullName}_${pr.number}_${review?.id || deliveryId}`,
    // STAQPRO-562: a submitted review is actionable and tied to an owned PR —
    // bypass the noise gate via linkedWorkItemId.
    channel: 'github',
    eventType: 'pull_request_review',
    linkedWorkItemId: `pr:${repoFullName}#${pr.number}`,
  });

  if (!result) {
    return { skipped: true, reason: `Duplicate review signal for PR #${pr.number}` };
  }

  console.log(`[github-webhook] Review signal: PR #${pr.number} ${state} → msgId=${result.messageId}`);
  return { prNumber: pr.number, reviewState: state, messageId: result.messageId, tier: 3 };
}

/**
 * Handle issue_comment events (comments on tracked issues).
 */
async function handleIssueCommentEvent(payload, repoFullName, deliveryId) {
  const { action, comment, issue } = payload;
  const eventConfig = config.watchedEvents?.issue_comment;

  if (!eventConfig || !eventConfig.actions.includes(action)) {
    return { skipped: true, reason: `Comment action not watched: ${action}` };
  }

  const result = await ingestAsSignal({
    source: 'github',
    title: `Comment on #${issue.number}: ${issue.title}`,
    snippet: comment?.body?.slice(0, 2000) || '[Empty comment]',
    from: comment?.user?.login || 'GitHub',
    signals: [{
      signal_type: eventConfig.signalType || 'info',
      content: `Comment by ${comment?.user?.login || 'unknown'} on #${issue.number}: ${comment?.body?.slice(0, 300) || ''}`,
      confidence: 0.7,
      direction: 'inbound',
      domain: repoFullName.split('/')[0],
    }],
    metadata: {
      github_issue_number: issue.number,
      github_issue_url: issue.html_url,
      github_comment_id: comment?.id,
      github_repo: repoFullName,
      github_commenter: comment?.user?.login,
    },
    labels: ['github:comment'],
    providerMsgId: `github_comment_${repoFullName}_${comment?.id || deliveryId}`,
    // STAQPRO-562: a comment on a tracked issue is actionable — bypass the
    // noise gate via the issue's linked identifier.
    channel: 'github',
    eventType: 'issue_comment',
    linkedWorkItemId: `issue:${repoFullName}#${issue.number}`,
  });

  if (!result) {
    return { skipped: true, reason: `Duplicate comment signal for #${issue.number}` };
  }

  console.log(`[github-webhook] Comment signal: #${issue.number} → msgId=${result.messageId}`);
  return { issueNumber: issue.number, messageId: result.messageId, tier: 3 };
}

/**
 * Handle check_suite events (CI failures → intent for board review).
 */
async function handleCheckSuiteEvent(payload, repoFullName, deliveryId) {
  const { action, check_suite: suite } = payload;
  const eventConfig = config.watchedEvents?.check_suite;

  if (!eventConfig || !eventConfig.actions.includes(action)) {
    return { skipped: true, reason: `Check suite action not watched: ${action}` };
  }

  // Filter by conclusion (only failures by default)
  const conclusionFilter = eventConfig.conclusionFilter || ['failure'];
  if (!conclusionFilter.includes(suite?.conclusion)) {
    return { skipped: true, reason: `Check suite conclusion=${suite?.conclusion}, not in filter` };
  }

  const branch = suite?.head_branch || 'unknown';
  const sha = suite?.head_sha?.slice(0, 7) || 'unknown';

  // CI failures create intents (Tier 2) — board-visible
  if (eventConfig.createIntent) {
    const intent = await createIntent({
      agentId: 'orchestrator',
      intentType: 'task',
      decisionTier: 'tactical',
      title: `CI failure: ${repoFullName} @ ${branch} (${sha})`,
      reasoning: `Check suite failed on ${branch} branch of ${repoFullName}. Commit ${sha}. ${suite?.pull_requests?.length ? `Associated with ${suite.pull_requests.length} PR(s).` : 'No associated PRs.'}`,
      proposedAction: {
        type: 'create_work_item',
        payload: {
          type: 'task',
          title: `Fix CI: ${repoFullName} @ ${branch}`,
          assigned_to: 'executor-coder',
          priority: 2,
          metadata: {
            github_repo: repoFullName,
            github_branch: branch,
            github_sha: suite?.head_sha,
            github_check_suite_id: suite?.id,
            source: 'github-ci-webhook',
          },
        },
      },
      triggerContext: {
        pattern: `github_ci_${repoFullName}_${suite?.id}`,
        source: 'github-ci-webhook',
        github_repo: repoFullName,
        branch,
        sha: suite?.head_sha,
        conclusion: suite?.conclusion,
      },
      budgetPerFire: 0.25,
    });

    if (!intent) {
      return { skipped: true, reason: `Intent already exists for CI failure on ${branch}` };
    }

    console.log(`[github-webhook] CI failure intent: ${repoFullName} @ ${branch} → ${intent.id.slice(0, 8)}...`);
    return { repo: repoFullName, branch, intentId: intent.id, tier: 2 };
  }

  // Fallback: signal-only
  return ingestGenericGitHubSignal('check_suite', payload, repoFullName, deliveryId);
}

/**
 * Generic signal ingestion for any GitHub event that doesn't have a specific handler.
 */
async function ingestGenericGitHubSignal(eventType, payload, repoFullName, deliveryId) {
  const result = await ingestAsSignal({
    source: 'github',
    title: `GitHub ${eventType}: ${repoFullName}`,
    snippet: `${eventType} event (action: ${payload.action || 'none'}) on ${repoFullName}`,
    from: payload.sender?.login || 'GitHub',
    signals: [{
      signal_type: 'info',
      content: `GitHub ${eventType} on ${repoFullName} (action: ${payload.action || 'none'})`,
      confidence: 0.6,
      direction: 'inbound',
    }],
    metadata: {
      github_event: eventType,
      github_action: payload.action,
      github_repo: repoFullName,
      github_sender: payload.sender?.login,
    },
    labels: [`github:${eventType}`],
    providerMsgId: `github_${eventType}_${repoFullName}_${deliveryId}`,
    // STAQPRO-562: short-circuit channel='github' through the deterministic
    // noise table BEFORE anything promotes it. Generic events (push, status,
    // check_run, workflow_run, …) carry no linked work_item — the gate inside
    // ingestAsSignal classifies them `noise` and never promotes them. Mirrors
    // the email cost_usd:0 fast-path; no model is ever consulted.
    channel: 'github',
    eventType,
    linkedWorkItemId: null,
  });

  return result || { skipped: true, reason: 'Duplicate generic GitHub signal' };
}
