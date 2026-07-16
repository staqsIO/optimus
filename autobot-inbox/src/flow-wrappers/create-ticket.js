/**
 * Flow wrapper for executor-ticket (create_ticket).
 *
 * Input:  { emailBody, from, subject, targetRepo }
 * Output: { title, description, severity, category, linearUrl, githubUrl }
 *
 * Pipeline context the handler reads:
 *   context.email                 → from_address, from_name, subject,
 *                                   received_at, channel, id
 *   context.emailBody
 *   context.workItem.metadata     → { channel, webhook_source, attachments }
 *
 * Defaults when flow input is missing context:
 *   - targetRepo required — wrapper errors if absent.
 *   - webhook_source = 'flow' (surfaces origin in the ticket body)
 *   - attachments = []
 *
 * External system behaviour:
 *   - LINEAR_API_KEY / LINEAR_TEAM_ID absent → handler skips Linear, produces
 *     GitHub-only result (handler already degrades gracefully).
 *   - GITHUB_TOKEN absent → handler skips GitHub, produces Linear-only result.
 *   - Both absent → returns structured ticket with nulls for linearUrl/githubUrl.
 *
 * Repo selection caveat:
 *   The handler's own repo-resolution logic queries signal.contact_projects +
 *   signal.contacts for the sender to build a candidate list. For flow-driven
 *   invocations the sender typically has no contact record, so the handler
 *   falls back to the LLM's selection or the DEFAULT_REPO_OWNER/NAME env
 *   defaults. The wrapper passes `targetRepo` through work_item.metadata as a
 *   hint; the actual repo used is reflected in the output.
 *
 * Post-run extraction: action_proposals row with action_type='ticket_create',
 * plus work_item.metadata.ticket_result.
 */

import { withAgentScope } from '../../../lib/db.js';
import { ticketLoop } from '../agents/executor-ticket.js';
import {
  createSyntheticWorkItem,
  buildSyntheticEmail,
  markSyntheticComplete,
  markSyntheticFailed,
} from './context-builder.js';

export default async function createTicketWrapper(input = {}) {
  const { emailBody = '', from = '', subject = '', targetRepo = null, metadata: extraMetadata = null } = input;

  if (!targetRepo) {
    return { success: false, reason: 'create_ticket requires `targetRepo`' };
  }
  if (!targetRepo.includes('/')) {
    return { success: false, reason: `Invalid targetRepo "${targetRepo}" — expected "owner/repo" format` };
  }
  if (!emailBody && !subject) {
    return { success: false, reason: 'create_ticket requires at least `emailBody` or `subject`' };
  }

  // STAQPRO-612: thread caller-supplied provenance (e.g. { source_meeting_id,
  // origin }) onto the synthetic work_item so it lands in work_items.metadata.
  // Spread last so callers cannot clobber the wrapper's own routing keys.
  const workItem = await createSyntheticWorkItem({
    type: 'ticket_create',
    title: `Flow: create ticket from ${from || 'unknown sender'}`,
    assignedTo: 'executor-ticket',
    metadata: {
      ...(extraMetadata && typeof extraMetadata === 'object' ? extraMetadata : {}),
      channel: 'email',
      webhook_source: 'flow',
      attachments: [],
      target_repo_hint: targetRepo,
    },
  });

  const context = {
    tier: 'Q1',
    agentId: 'executor-ticket',
    workItemId: workItem.id,
    workItem,
    email: buildSyntheticEmail({ from, subject, emailBody, channel: 'email' }),
    emailBody,
  };

  const task = {
    work_item_id: workItem.id,
    event_type: 'task_assigned',
    event_data: {},
    metadata: { source: 'flow' },
  };

  let result;
  try {
    result = await ticketLoop.handler(task, context, ticketLoop);
  } catch (err) {
    await markSyntheticFailed(workItem.id, err.message, 'executor-ticket');
    return { success: false, reason: `Ticket handler error: ${err.message}` };
  }

  if (!result?.success) {
    await markSyntheticFailed(workItem.id, result?.reason, 'executor-ticket');
    return { success: false, reason: result?.reason, costUsd: result?.costUsd };
  }

  // Read back the proposal + ticket_result metadata.
  // STAQPRO-524: action_proposals + work_items are FORCE'd by migration 126;
  // SELECTs must run under the same agent scope used at INSERT time
  // ('executor-ticket' from createSyntheticWorkItem above).
  const ticketScope = await withAgentScope('executor-ticket');
  let propR, wiR;
  try {
    [propR, wiR] = await Promise.all([
      ticketScope(
        `SELECT id, body, linear_issue_url, github_issue_url, target_repo
         FROM agent_graph.action_proposals
         WHERE work_item_id = $1 AND action_type = 'ticket_create'
         ORDER BY version DESC LIMIT 1`,
        [workItem.id],
      ),
      ticketScope(`SELECT metadata FROM agent_graph.work_items WHERE id = $1`, [workItem.id]),
    ]);
  } finally {
    await ticketScope.release();
  }
  const proposal = propR.rows[0];
  let metadata = wiR.rows[0]?.metadata || {};
  if (typeof metadata === 'string') {
    try { metadata = JSON.parse(metadata); } catch { metadata = {}; }
  }
  const ticketResult = metadata.ticket_result || {};

  await markSyntheticComplete(workItem.id, 'executor-ticket');

  return {
    title: ticketResult.title || null,
    description: proposal?.body || null,
    severity: ticketResult.severity || null,
    category: ticketResult.category || null,
    linearUrl: ticketResult.linear_url || proposal?.linear_issue_url || null,
    githubUrl: ticketResult.github_issue_url || proposal?.github_issue_url || null,
    targetRepo: ticketResult.target_repo || proposal?.target_repo || null,
    proposalId: proposal?.id || null,
    workItemId: workItem.id,
    costUsd: result.costUsd || 0,
  };
}
