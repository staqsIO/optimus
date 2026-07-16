/**
 * Flow wrapper for executor-responder (compose_reply).
 *
 * Input schema (matches autobot-inbox/tools/registry.js compose_reply.parameters):
 *   { emailBody, from, subject, channel }
 *
 * Output schema:
 *   { body, subject, toAddresses, draftIntent, emailSummary }
 *
 * Pipeline context the handler expects and how this wrapper fulfils it:
 *   context.email                 → fabricated via buildSyntheticEmail
 *   context.promptContext         → fabricated via buildPromptContext
 *   context.emailBody             → from input.emailBody
 *   context.workItem.metadata     → { source:'flow', triage_category, strategy_result,
 *                                     sender_register } — defaults documented below
 *   context.voiceAccountId        → null (global voice profile will be used)
 *
 * Defaults when flow input doesn't provide context:
 *   - triage_category = 'needs_response'  (so the "no prior reply history" guard
 *     in executor-responder doesn't skip the draft on first contact)
 *   - strategy_result = null              (handler treats as no strategy guidance)
 *   - sender_register = { register:'casual', formality: 0.2 }  (matches Eric's baseline)
 *
 * Post-run extraction: the handler writes a draft row to agent_graph.action_proposals
 * and stores draft_id on work_item.metadata. We select the draft back and map it
 * onto the tool's output_schema.
 */

import { withAgentScope } from '../../../lib/db.js';
import { responderLoop } from '../agents/executor-responder.js';
import {
  createSyntheticWorkItem,
  buildSyntheticEmail,
  buildPromptContext,
  isNoreplySender,
  markSyntheticComplete,
  markSyntheticFailed,
} from './context-builder.js';

const DEFAULT_SENDER_REGISTER = { register: 'casual', formality: 0.2 };

export default async function composeReplyWrapper(input = {}) {
  const { emailBody = '', from = '', subject = '', channel = 'email' } = input;

  if (!from) {
    return { success: false, reason: 'compose_reply requires `from`' };
  }
  if (isNoreplySender(from)) {
    return { success: false, reason: `Skipped: ${from} is an automated sender` };
  }

  const workItem = await createSyntheticWorkItem({
    type: 'draft_reply',
    title: `Flow: draft reply to ${from}`,
    assignedTo: 'executor-responder',
    metadata: {
      triage_category: 'needs_response',
      sender_register: DEFAULT_SENDER_REGISTER,
      channel,
    },
  });

  const context = {
    tier: 'Q2',
    agentId: 'executor-responder',
    workItemId: workItem.id,
    workItem,
    email: buildSyntheticEmail({ from, subject, emailBody, channel, triageCategory: 'needs_response' }),
    promptContext: buildPromptContext({ from, subject, emailBody, channel }),
    emailBody,
    voiceAccountId: null,
    signals: [],
    drafts: [],
  };

  const task = {
    work_item_id: workItem.id,
    event_type: 'task_assigned',
    event_data: {},
    metadata: { source: 'flow' },
  };

  let result;
  try {
    result = await responderLoop.handler(task, context, responderLoop);
  } catch (err) {
    await markSyntheticFailed(workItem.id, err.message, 'executor-responder');
    return { success: false, reason: `Responder handler error: ${err.message}` };
  }

  if (!result?.success) {
    await markSyntheticFailed(workItem.id, result?.reason, 'executor-responder');
    return { success: false, reason: result?.reason || 'Draft generation failed', costUsd: result?.costUsd };
  }

  // Handler stored the draft id on work_item.metadata; pull the proposal back.
  // Migration 061's BEFORE INSERT trigger auto-stamped source='flow' because
  // the parent work_item has metadata.source='flow' (set by createSyntheticWorkItem),
  // which relaxes the message_id NOT NULL requirement for this draft.
  // STAQPRO-524: action_proposals is FORCE'd by migration 126; SELECT must
  // run under the same agent scope used at INSERT time.
  const responderScope = await withAgentScope('executor-responder');
  let draftR;
  try {
    draftR = await responderScope(
      `SELECT id, body, subject, to_addresses, email_summary, draft_intent
       FROM agent_graph.action_proposals
       WHERE work_item_id = $1 AND action_type = 'email_draft'
       ORDER BY version DESC LIMIT 1`,
      [workItem.id],
    );
  } finally {
    await responderScope.release();
  }
  const draft = draftR.rows[0];

  await markSyntheticComplete(workItem.id, 'executor-responder');

  if (!draft) {
    // Handler returned success but no proposal row — could mean the skip
    // branches (newsletter footer / no reply history). Propagate the reason.
    return {
      success: true,
      reason: result.reason,
      body: null,
      subject: null,
      toAddresses: [],
      draftIntent: null,
      emailSummary: null,
      costUsd: result.costUsd || 0,
      workItemId: workItem.id,
    };
  }

  return {
    body: draft.body,
    subject: draft.subject,
    toAddresses: draft.to_addresses || [],
    draftIntent: draft.draft_intent,
    emailSummary: draft.email_summary,
    draftId: draft.id,
    workItemId: workItem.id,
    costUsd: result.costUsd || 0,
  };
}
