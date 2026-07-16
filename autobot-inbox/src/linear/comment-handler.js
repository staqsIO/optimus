/**
 * Linear comment-driven agent interaction handler.
 *
 * Processes comments on Linear issues from board members to trigger agent actions.
 * Only recognized commands from authorized board members trigger actions (P1: deny by default).
 * Command parsing is deterministic — no LLM involved (P2: infrastructure enforces).
 * All triggered actions are logged via the task graph (P3: transparency by structure).
 *
 * Supported commands:
 *   /retry [instructions]  — Create a new work item for the issue (with optional context)
 *   /update <instructions> — Append context to an existing active work item
 *   /reply <question>      — Ask a question and get a conversational response posted back
 *   @Jamie [Bot] <question> — Alias for /reply (natural conversational interaction)
 */

import { getIssue, addComment, addBotComment } from './client.js';
import { query } from '../db.js';
import { getConfig } from '../../../lib/config/loader.js';

const config = getConfig('linear-bot');

// Recognized command patterns — deterministic, not LLM-interpreted (P2).
// Order matters: more specific patterns first.
const COMMAND_PATTERNS = [
  { re: /^\/retry(?:\s+([\s\S]+))?$/i,        command: 'retry'  },
  { re: /^\/update\s+([\s\S]+)$/i,             command: 'update' },
  { re: /^\/reply\s+([\s\S]+)$/i,             command: 'reply'  },
  { re: /@jamie(?:\s+bot)?/i, command: 'reply', extractAround: true }, // @Jamie anywhere in comment
];

/**
 * Parse a comment body for recognized commands.
 * Strips quoted reply content (lines starting with ">") before matching.
 * Returns { command, args } or null if no recognized command found.
 */
export function parseCommand(body) {
  const stripped = (body || '')
    .split('\n')
    .filter(line => !line.trimStart().startsWith('>'))
    .join('\n')
    .trim();

  for (const { re, command, extractAround } of COMMAND_PATTERNS) {
    const match = stripped.match(re);
    if (match) {
      if (extractAround) {
        // Strip the @mention and use everything else as args
        const args = stripped.replace(/@jamie(?:\s+bot)?/i, '').replace(/\s+/g, ' ').trim();
        return { command, args: args || '' };
      }
      return { command, args: (match[1] || '').trim() };
    }
  }
  return null;
}

/**
 * Check if a comment author is a board member.
 * P1: deny by default — only explicitly listed members are authorized.
 * Matches on Linear user ID first (preferred), falls back to exact full name.
 */
export function isBoardMember(userName, userId) {
  const boardMembers = config.boardMembers || [];
  const match = boardMembers.some(m => {
    // Prefer ID match when both sides have IDs
    if (userId && m.linearId) {
      return m.linearId === userId;
    }
    // Fall back to exact full name match (case-insensitive)
    const configName = typeof m === 'string' ? m : m.name;
    return configName && configName.toLowerCase() === (userName || '').toLowerCase();
  });
  if (!match && userId) {
    // Log userId so it can be backfilled into linear-bot.json
    console.warn(`[comment-handler] Auth failed: '${userName}' (linearId: ${userId}) not matched. Add this linearId to config/linear-bot.json boardMembers.`);
  }
  return match;
}

/**
 * Check if a comment author is the bot itself (prevent self-reply loops).
 */
export function isBotUser(userName) {
  const botName = config.botUserName || 'Jamie Bot';
  return (userName || '').toLowerCase() === botName.toLowerCase();
}

/**
 * Handle a Linear comment webhook payload.
 * Called from api.js for Comment events.
 *
 * @param {Object} payload - Raw Linear webhook body (type: 'Comment')
 * @param {Function} createWorkItem - state-machine.js createWorkItem
 * @returns {Object} Result with action taken or skipped reason
 */
export async function handleLinearComment(payload, createWorkItem) {
  const { action, data } = payload;

  // Only process comment creates (not updates or deletes)
  if (action !== 'create') {
    return { skipped: true, reason: `Comment action '${action}' ignored — only 'create' processed` };
  }

  const commentBody = data?.body;
  const commentId = data?.id;
  const issueId = data?.issueId || data?.issue?.id;
  const userId = data?.user?.id || data?.userId || null;
  const userName = data?.user?.name || null;

  if (!commentBody || !issueId) {
    return { skipped: true, reason: 'Missing comment body or issueId' };
  }

  // P1: deny by default — ignore bot self-replies to prevent infinite loops
  if (isBotUser(userName)) {
    return { skipped: true, reason: 'Ignoring bot self-reply' };
  }

  // P1: deny by default — only board members can trigger actions (ID preferred, name fallback)
  if (!isBoardMember(userName, userId)) {
    return { skipped: true, reason: `Comment author '${userName}' (${userId}) is not a board member — ignoring` };
  }

  // P2: infrastructure enforces — parse command deterministically
  const parsed = parseCommand(commentBody);
  if (!parsed) {
    return { skipped: true, reason: 'No recognized command in comment' };
  }

  const { command, args } = parsed;

  // Fetch full issue details for context
  let issue;
  try {
    issue = await getIssue(issueId);
  } catch (err) {
    console.error(`[linear-comment] Failed to fetch issue ${issueId}: ${err.message}`);
    return { skipped: true, reason: `Failed to fetch issue: ${err.message}` };
  }

  if (!issue) {
    return { skipped: true, reason: `Issue ${issueId} not found via API` };
  }

  console.log(`[linear-comment] Command '${command}' from '${userName}' on ${issue.identifier}: "${args.slice(0, 100)}"`);

  if (command === 'retry') {
    return handleRetryCommand(issue, commentId, userName, args, createWorkItem);
  }

  if (command === 'update') {
    return handleUpdateCommand(issue, commentId, userName, args);
  }

  if (command === 'reply') {
    return handleReplyCommand(issue, commentId, userName, args, createWorkItem);
  }

  return { skipped: true, reason: `Unknown command: ${command}` };
}

/**
 * /retry — Create a new work item for the issue.
 * Reuses the target agent from the most recent active work item if available,
 * defaulting to executor-coder.
 */
async function handleRetryCommand(issue, commentId, userName, extraContext, createWorkItem) {
  // Find most recent active work item to inherit agent assignment
  const existingResult = await query(
    `SELECT id, assigned_to, metadata FROM agent_graph.work_items
     WHERE metadata->>'linear_issue_id' = $1
       AND status NOT IN ('completed', 'cancelled', 'failed')
     ORDER BY created_at DESC
     LIMIT 1`,
    [issue.id]
  );
  const existingWorkItem = existingResult.rows[0] || null;
  const targetAgent = existingWorkItem?.assigned_to || 'executor-coder';
  const existingMetadata = existingWorkItem?.metadata || {};
  // Prefer existing metadata, fall back to resolving from issue labels
  let targetRepo = existingMetadata.target_repo || null;
  if (!targetRepo) {
    const labels = issue.labels?.nodes || [];
    for (const label of labels) {
      const mapped = config.repoMapping?.[label.name] || config.repoMapping?.[`repo:${label.name}`];
      if (mapped) { targetRepo = mapped; break; }
    }
  }

  // Look up existing PR for this issue so executor-coder can push to the same branch
  let existingPrUrl = null;
  let existingPrNumber = null;
  try {
    const prResult = await query(
      `SELECT github_pr_url, github_pr_number
       FROM agent_graph.action_proposals
       WHERE linear_issue_id = $1
         AND action_type = 'code_fix_pr'
         AND github_pr_url IS NOT NULL
       ORDER BY created_at DESC
       LIMIT 1`,
      [issue.id]
    );
    if (prResult.rows[0]) {
      existingPrUrl = prResult.rows[0].github_pr_url;
      existingPrNumber = prResult.rows[0].github_pr_number;
      console.log(`[linear-comment] Found existing PR #${existingPrNumber} for ${issue.identifier} — will reuse branch`);
    }
  } catch (err) {
    console.warn(`[linear-comment] Failed to look up existing PR: ${err.message}`);
  }

  // Build description with board context prepended
  const boardContext = extraContext
    ? `**Board directive (${userName}):** ${extraContext}\n\n`
    : `**Retry requested by ${userName}.**\n\n`;
  const description = boardContext + (issue.description?.slice(0, 400) || '');

  // Create new action_proposal for the retry
  const proposalResult = await query(
    `INSERT INTO agent_graph.action_proposals
     (action_type, body, linear_issue_id, linear_issue_url, target_repo)
     VALUES ('ticket_create', $1, $2, $3, $4)
     RETURNING id`,
    [buildRetryTicketBody(issue, extraContext, userName), issue.id, issue.url, targetRepo]
  );
  const proposalId = proposalResult.rows[0].id;

  // Create new work item assigned to the target agent
  const workItem = await createWorkItem({
    type: 'task',
    title: `Retry: ${issue.identifier} — ${issue.title}`,
    description,
    createdBy: 'orchestrator',
    assignedTo: targetAgent,
    priority: mapLinearPriority(issue.priority),
    metadata: {
      ticket_proposal_id: proposalId,
      target_repo: targetRepo,
      linear_issue_id: issue.id,
      linear_issue_url: issue.url,
      linear_identifier: issue.identifier,
      linear_comment_id: commentId,
      board_directive: extraContext || null,
      triggered_by: userName,
      source: 'linear-comment',
      command: 'retry',
      existing_pr_url: existingPrUrl,
      existing_pr_number: existingPrNumber,
    },
  });

  console.log(`[linear-comment] Created retry work item ${workItem?.id} for ${issue.identifier} → ${targetAgent}`);

  // Acknowledge the command (best-effort — failure does not block the action)
  try {
    const ack = workItem
      ? `Retry queued (work item \`${workItem.id.slice(0, 8)}\`).`
      : `Retry acknowledged — queueing new work item.`;
    await addBotComment(issue.id, ack);
  } catch (err) {
    console.warn(`[linear-comment] Failed to post retry acknowledgment: ${err.message}`);
  }

  return {
    issueId: issue.id,
    workItemId: workItem?.id,
    proposalId,
    command: 'retry',
    triggeredBy: userName,
  };
}

/**
 * /update — Append board context to an existing active work item.
 * Does not create a new work item; patches the description and metadata of the active one.
 */
async function handleUpdateCommand(issue, commentId, userName, instructions) {
  if (!instructions) {
    return { skipped: true, reason: '/update requires instructions' };
  }

  // Find most recent active work item for this issue
  const result = await query(
    `SELECT id, description, metadata FROM agent_graph.work_items
     WHERE metadata->>'linear_issue_id' = $1
       AND status NOT IN ('completed', 'cancelled', 'failed')
     ORDER BY created_at DESC
     LIMIT 1`,
    [issue.id]
  );

  if (result.rows.length === 0) {
    // No active work item — suggest /retry instead
    try {
      await addComment(
        issue.id,
        `No active work item found for ${issue.identifier}. ` +
          `Use \`/retry ${instructions}\` to start a new task with these instructions.`
      );
    } catch (err) {
      console.warn(`[linear-comment] Failed to post no-active-work-item comment: ${err.message}`);
    }
    return { skipped: true, reason: `No active work item for ${issue.identifier}` };
  }

  const workItemId = result.rows[0].id;
  const existingDescription = result.rows[0].description || '';
  const existingMetadata = result.rows[0].metadata || {};

  // Append board directive to description (capped to 2000 chars to avoid oversized rows)
  const appendedNote = `\n\n**Board update (${userName}):** ${instructions}`;
  const newDescription = (existingDescription + appendedNote).slice(0, 2000);

  // Append to board_directives array (P3: transparency — never overwrite history)
  const existingDirectives = existingMetadata.board_directives || [];
  const newDirective = {
    instructions,
    by: userName,
    comment_id: commentId,
    at: new Date().toISOString(),
  };

  // Patch work item — description update + append directive to history
  await query(
    `UPDATE agent_graph.work_items
     SET description = $1,
         metadata = metadata || $2::jsonb
     WHERE id = $3`,
    [
      newDescription,
      JSON.stringify({
        board_directive: instructions,
        board_directives: [...existingDirectives, newDirective],
      }),
      workItemId,
    ]
  );

  console.log(`[linear-comment] Updated work item ${workItemId} with board directive from ${userName}`);

  // Acknowledge the update (best-effort)
  try {
    await addComment(
      issue.id,
      `Context updated on work item \`${workItemId.slice(0, 8)}\`. ` +
        `The agent will incorporate your instructions.`
    );
  } catch (err) {
    console.warn(`[linear-comment] Failed to post update acknowledgment: ${err.message}`);
  }

  return {
    issueId: issue.id,
    workItemId,
    command: 'update',
    triggeredBy: userName,
  };
}

// Reply dedup: prevent rapid-fire reply triggers on the same issue
const REPLY_COOLDOWN_MS = config.replyCooldownMs || 60_000;
const recentReplies = new Map(); // key: issueId → timestamp

/** Clear the in-memory reply dedup cache. Exported for test isolation. */
export function clearReplyDedupCache() {
  recentReplies.clear();
}

/**
 * /reply — Create a lightweight child work item that posts a conversational response.
 * Uses the reply playbook for a focused, low-budget CLI session.
 * Output is posted as a Linear comment (via workshop-runner's output_type: 'comment' path).
 */
async function handleReplyCommand(issue, commentId, userName, question, createWorkItem) {
  if (!question) {
    return { skipped: true, reason: '/reply requires a question' };
  }

  // Dedup: prevent rapid-fire replies on the same issue
  const now = Date.now();
  const lastReply = recentReplies.get(issue.id);
  if (lastReply && now - lastReply < REPLY_COOLDOWN_MS) {
    const waitSec = Math.ceil((REPLY_COOLDOWN_MS - (now - lastReply)) / 1000);
    try {
      await addBotComment(issue.id, `Reply cooldown active — please wait ${waitSec}s before asking another question.`);
    } catch (_) { /* best-effort */ }
    return { skipped: true, reason: `Reply cooldown: ${waitSec}s remaining` };
  }
  recentReplies.set(issue.id, now);

  // Prune stale entries
  if (recentReplies.size > 50) {
    for (const [k, ts] of recentReplies) {
      if (now - ts > REPLY_COOLDOWN_MS) recentReplies.delete(k);
    }
  }

  // Find the most recent work item to inherit context (repo, agent)
  const existingResult = await query(
    `SELECT id, assigned_to, metadata FROM agent_graph.work_items
     WHERE metadata->>'linear_issue_id' = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [issue.id]
  );
  const parentWorkItem = existingResult.rows[0] || null;
  const targetRepo = parentWorkItem?.metadata?.target_repo || null;

  // Create child work item for the reply
  const workItem = await createWorkItem({
    type: 'subtask',
    title: `Reply: ${issue.identifier} — ${question.slice(0, 60)}`,
    description: `**${userName} asked:** ${question}`,
    createdBy: 'orchestrator',
    assignedTo: 'claw-workshop',
    parentId: parentWorkItem?.id || null,
    priority: 0,
    metadata: {
      target_repo: targetRepo,
      linear_issue_id: issue.id,
      linear_issue_url: issue.url,
      linear_identifier: issue.identifier,
      linear_comment_id: commentId,
      playbook_id: 'reply',
      task_mode: 'reply',
      reply_question: question,
      triggered_by: userName,
      source: 'linear-comment',
      command: 'reply',
    },
  });

  // Create campaign row for the reply (auto-approved, reduced budget)
  const replyBudget = config.replyBudgetUsd || 3;
  if (workItem?.id) {
    await query(
      `INSERT INTO agent_graph.campaigns
       (work_item_id, campaign_mode, campaign_status, goal_description,
        budget_envelope_usd, max_cost_per_iteration, metadata, created_by)
       VALUES ($1, 'workshop', 'approved', $2, $3, $4, $5, 'orchestrator')`,
      [
        workItem.id,
        `Reply to ${userName} on ${issue.identifier}`,
        replyBudget,
        replyBudget,
        JSON.stringify({
          playbook_id: 'reply',
          task_mode: 'reply',
          target_repo: targetRepo,
          linear_issue_id: issue.id,
          linear_issue_url: issue.url,
          linear_identifier: issue.identifier,
          reply_question: question,
          triggered_by: userName,
        }),
      ]
    );
  }

  console.log(`[linear-comment] Created reply work item ${workItem?.id} for ${issue.identifier}`);

  // Acknowledge
  try {
    await addBotComment(issue.id, `Looking into it — I'll reply shortly.`);
  } catch (err) {
    console.warn(`[linear-comment] Failed to post reply acknowledgment: ${err.message}`);
  }

  return {
    issueId: issue.id,
    workItemId: workItem?.id,
    command: 'reply',
    triggeredBy: userName,
  };
}

/**
 * Build ticket body for a retry work item, including board directive context.
 */
function buildRetryTicketBody(issue, boardDirective, userName) {
  const lines = [
    `# ${issue.identifier}: ${issue.title}`,
    '',
    `**Team:** ${issue.team ? `${issue.team.name} (${issue.team.key})` : 'Unknown'}`,
    `**Linear:** ${issue.url}`,
    `**Retry requested by:** ${userName}`,
    '',
  ];

  if (boardDirective) {
    lines.push('## Board Directive', '', boardDirective, '');
  }

  lines.push('## Original Description', '', issue.description || '_No description provided._');
  return lines.join('\n');
}

/**
 * Map Linear priority (0=none, 1=urgent, 2=high, 3=medium, 4=low) to work_item priority.
 */
function mapLinearPriority(linearPriority) {
  switch (linearPriority) {
    case 1: return 3;
    case 2: return 2;
    case 3: return 1;
    case 4: return 0;
    default: return 0;
  }
}
