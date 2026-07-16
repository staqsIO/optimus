/**
 * Flow wrapper for executor-research (research_analyze).
 *
 * Input:  { researchType, content }
 * Output: { summary, gaps, alreadyCovered, notApplicable }
 *
 * Pipeline context the handler reads:
 *   context.workItem.metadata.research_type    → 'deep_research' | 'gap_analysis' | 'url'
 *   context.workItem.metadata.research_content → URL or raw text
 *
 * Defaults when flow input is missing context:
 *   - researchType defaults to 'gap_analysis' (the safer path — no web traversal,
 *     no deep_research delegation).
 *   - content is required (handler returns failure without it).
 *
 * External system behaviour:
 *   - GITHUB_PAT/GITHUB_TOKEN absent → spec/CLAUDE.md context fetch returns null,
 *     handler proceeds with research content alone.
 *   - If researchType='url', handler requires web_fetch permission + makes an
 *     outbound HTTP request (controlled by the agent's permission grants).
 *   - If researchType='deep_research', handler delegates to deepResearchHandler
 *     unchanged — same multi-iteration web research flow as the pipeline.
 *
 * Post-run extraction: the handler writes research_result to work_item.metadata.
 */

import { withAgentScope } from '../../../lib/db.js';
import { researchLoop } from '../agents/executor-research.js';
import {
  createSyntheticWorkItem,
  markSyntheticComplete,
  markSyntheticFailed,
} from './context-builder.js';

export default async function researchAnalyzeWrapper(input = {}) {
  const { researchType = 'gap_analysis', content = '' } = input;

  if (!content) {
    return { success: false, reason: 'research_analyze requires `content`' };
  }

  const workItem = await createSyntheticWorkItem({
    type: 'research',
    title: `Flow: research (${researchType})`,
    assignedTo: 'executor-research',
    metadata: {
      research_type: researchType,
      research_content: content,
    },
  });

  const context = {
    tier: 'Q1',
    agentId: 'executor-research',
    workItemId: workItem.id,
    workItem,
  };

  const task = {
    work_item_id: workItem.id,
    event_type: 'task_assigned',
    event_data: {},
    metadata: { source: 'flow' },
  };

  let result;
  try {
    result = await researchLoop.handler(task, context, researchLoop);
  } catch (err) {
    await markSyntheticFailed(workItem.id, err.message, 'executor-research');
    return { success: false, reason: `Research handler error: ${err.message}` };
  }

  if (!result?.success) {
    await markSyntheticFailed(workItem.id, result?.reason, 'executor-research');
    return { success: false, reason: result?.reason, costUsd: result?.costUsd };
  }

  // Extract research_result from work_item.metadata
  // STAQPRO-524: work_items is FORCE'd; read under the same agent scope.
  const researchScope = await withAgentScope('executor-research');
  let wiR;
  try {
    wiR = await researchScope(
      `SELECT metadata FROM agent_graph.work_items WHERE id = $1`,
      [workItem.id],
    );
  } finally {
    await researchScope.release();
  }
  let metadata = wiR.rows[0]?.metadata || {};
  if (typeof metadata === 'string') {
    try { metadata = JSON.parse(metadata); } catch { metadata = {}; }
  }
  const research = metadata.research_result || {};

  await markSyntheticComplete(workItem.id, 'executor-research');

  return {
    summary: research.summary || null,
    gaps: research.gaps || [],
    alreadyCovered: research.alreadyCovered || [],
    notApplicable: research.notApplicable || [],
    workItemId: workItem.id,
    costUsd: result.costUsd || 0,
  };
}
