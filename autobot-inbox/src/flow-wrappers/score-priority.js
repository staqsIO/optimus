/**
 * Flow wrapper for strategist (score_priority).
 *
 * Input:  { emailBody, from, subject, triageCategory }
 * Output: { priorityScore, urgency, recommendation, responseGuidance, flags }
 *
 * Pipeline context the handler reads and how it's fulfilled:
 *   context.email                 → fabricated (triage_category required; handler
 *                                   skips fyi/noise)
 *   context.emailBody             → from input.emailBody
 *   context.contact               → resolved from signal.contacts by email (null ok)
 *   context.signals               → fetched if email_id is known; else []
 *   context.workItem.metadata     → { source:'flow', sender_register }
 *
 * Defaults when flow input is missing context:
 *   - triageCategory = 'needs_response' (anything other than fyi/noise so the
 *     handler doesn't early-return)
 *   - sender_register = { register:'casual', formality: 0.2 }
 *
 * Post-run extraction: the handler persists strategy_result on
 * work_item.metadata and writes a row to agent_graph.strategic_decisions.
 * We read work_item.metadata back and return the strategy_result shape,
 * mapped to the tool's output_schema.
 */

import { withAgentScope } from '../../../lib/db.js';
import { strategistLoop } from '../agents/strategist.js';
import {
  createSyntheticWorkItem,
  buildSyntheticEmail,
  resolveContact,
  loadSignalsForMessage,
  markSyntheticComplete,
  markSyntheticFailed,
} from './context-builder.js';

const DEFAULT_SENDER_REGISTER = { register: 'casual', formality: 0.2 };

export default async function scorePriorityWrapper(input = {}) {
  const {
    emailBody = '',
    from = '',
    subject = '',
    triageCategory = 'needs_response',
    emailId = null,
  } = input;

  if (['fyi', 'noise'].includes(triageCategory)) {
    return {
      priorityScore: 0,
      urgency: 'routine',
      recommendation: 'proceed',
      responseGuidance: null,
      flags: [],
      reason: `Skipped: triage_category=${triageCategory}`,
    };
  }

  const [contact, signals] = await Promise.all([
    resolveContact(from),
    loadSignalsForMessage(emailId),
  ]);

  const workItem = await createSyntheticWorkItem({
    type: 'priority_score',
    title: `Flow: score priority for ${from || 'unknown sender'}`,
    assignedTo: 'strategist',
    metadata: { sender_register: DEFAULT_SENDER_REGISTER },
  });

  const context = {
    tier: 'Q3',
    agentId: 'strategist',
    workItemId: workItem.id,
    workItem,
    email: buildSyntheticEmail({ from, subject, emailBody, triageCategory, emailId }),
    emailBody,
    contact,
    signals,
  };

  const task = {
    work_item_id: workItem.id,
    event_type: 'task_assigned',
    event_data: {},
    metadata: { source: 'flow' },
  };

  let result;
  try {
    result = await strategistLoop.handler(task, context, strategistLoop);
  } catch (err) {
    await markSyntheticFailed(workItem.id, err.message, 'strategist');
    return { success: false, reason: `Strategist handler error: ${err.message}` };
  }

  if (!result?.success) {
    await markSyntheticFailed(workItem.id, result?.reason, 'strategist');
    return { success: false, reason: result?.reason, costUsd: result?.costUsd };
  }

  // Pull the strategy_result stored on work_item.metadata.
  // STAQPRO-524: work_items is FORCE'd; read under the same agent scope.
  const strategistScope = await withAgentScope('strategist');
  let wiR;
  try {
    wiR = await strategistScope(
      `SELECT metadata FROM agent_graph.work_items WHERE id = $1`,
      [workItem.id],
    );
  } finally {
    await strategistScope.release();
  }
  let metadata = wiR.rows[0]?.metadata || {};
  if (typeof metadata === 'string') {
    try { metadata = JSON.parse(metadata); } catch { metadata = {}; }
  }
  const strategy = metadata.strategy_result || {};

  await markSyntheticComplete(workItem.id, 'strategist');

  return {
    priorityScore: strategy.priorityScore ?? null,
    urgency: strategy.urgency ?? null,
    recommendation: strategy.recommendation ?? null,
    responseGuidance: strategy.responseGuidance ?? null,
    flags: strategy.flags ?? [],
    workItemId: workItem.id,
    costUsd: result.costUsd || 0,
  };
}
