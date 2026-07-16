/**
 * Flow wrapper for executor-intake (classify_message).
 *
 * Input:  { emailBody, from, subject, channel }
 * Output: { classification, confidence, routingClass, domainTags, rationale }
 *
 * Pipeline context the handler reads:
 *   context.email           → labels, subject, from_address (drives Gmail
 *                             label-based fast-paths — unavailable from flows)
 *   context.promptContext   → sender/threading/channel fallback when email is absent
 *   context.workItem        → id for metadata persistence
 *
 * Defaults when flow input is missing context:
 *   - Gmail labels are always empty (flow can't supply them) — the label-based
 *     fast-paths (calendar invites, promotions, social) are therefore skipped.
 *     Classification falls through to deterministic routes, noreply pattern
 *     detection, or the subject heuristic path. This is acceptable: the flow
 *     operator can register a `signal_extract` step before classify_message
 *     if they need label-aware routing.
 *
 * Post-run extraction: the handler writes intake_classification and routing
 * to work_item.metadata. We read them back and map onto the output_schema.
 */

import { openAgentScope } from '../../../lib/runtime/agents/agent-scope.js';
import { intakeLoop } from '../../../agents/executor-intake/index.js';
import {
  createSyntheticWorkItem,
  buildSyntheticEmail,
  buildPromptContext,
  markSyntheticComplete,
  markSyntheticFailed,
} from './context-builder.js';

export default async function classifyMessageWrapper(input = {}) {
  const { emailBody = '', from = '', subject = '', channel = 'email' } = input;

  if (!from && !subject) {
    return { success: false, reason: 'classify_message requires at least `from` or `subject`' };
  }

  const workItem = await createSyntheticWorkItem({
    type: 'classify',
    title: `Flow: classify message from ${from || 'unknown'}`,
    assignedTo: 'executor-intake',
    metadata: {},
  });

  const email = buildSyntheticEmail({ from, subject, emailBody, channel });
  const context = {
    tier: 'Q1',
    agentId: 'executor-intake',
    workItemId: workItem.id,
    workItem,
    email,
    promptContext: buildPromptContext({ from, subject, emailBody, channel }),
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
    result = await intakeLoop.handler(task, context, intakeLoop);
  } catch (err) {
    await markSyntheticFailed(workItem.id, err.message, 'executor-intake');
    return { success: false, reason: `Intake handler error: ${err.message}` };
  }

  if (!result?.success) {
    await markSyntheticFailed(workItem.id, result?.reason, 'executor-intake');
    return { success: false, reason: result?.reason };
  }

  // Pull the persisted classification & routing off the work item.
  // STAQPRO-524: row was inserted under withAgentScope('executor-intake'),
  // so SELECT must run under the same scope to be visible post-FORCE-RLS.
  const intakeScope = await openAgentScope('executor-intake');
  let wiR;
  try {
    wiR = await intakeScope(
      `SELECT metadata FROM agent_graph.work_items WHERE id = $1`,
      [workItem.id],
    );
  } finally {
    await intakeScope.release();
  }
  let metadata = wiR.rows[0]?.metadata || {};
  if (typeof metadata === 'string') {
    try { metadata = JSON.parse(metadata); } catch { metadata = {}; }
  }
  const classification = metadata.intake_classification || {};
  const routing = metadata.routing || {};
  const triage = metadata.triage_result || {};

  await markSyntheticComplete(workItem.id, 'executor-intake');

  return {
    classification: triage.category ?? classification.complexity ?? null,
    confidence: classification.confidence ?? triage.quick_score ?? null,
    routingClass: routing.routing_class ?? classification.complexity ?? null,
    domainTags: classification.domain_tags ?? routing.domain_tags ?? [],
    rationale: classification.rationale ?? null,
    workItemId: workItem.id,
    costUsd: result.metadata?.cost_usd || 0,
  };
}
