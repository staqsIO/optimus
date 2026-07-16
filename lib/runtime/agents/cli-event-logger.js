/**
 * CLI Event Logger — converts Claude Code stream-json events into
 * agent_activity_steps for Board Workstation observability.
 *
 * Design: P3 (transparency by structure — logging is a side effect of operating).
 * Non-blocking: all DB writes are fire-and-forget to avoid slowing the CLI session.
 */

import { startActivityStep, completeActivityStep } from '../infrastructure.js';

/**
 * Create an event logger that converts Claude Code stream-json events
 * into nested activity steps under a parent step.
 *
 * @param {Object} opts
 * @param {string} opts.parentStepId - Parent activity step to nest under
 * @param {string} opts.workItemId - Work item for the campaign/task
 * @param {string} [opts.campaignId] - Campaign ID (if campaign context)
 * @param {number} [opts.iterationNumber] - Iteration number (if campaign context)
 * @param {string} [opts.agentId] - Agent ID for attribution
 * @returns {function} onEvent callback for spawnCLI's streamEvents option
 */
export function createCliEventLogger({ parentStepId, workItemId, campaignId, iterationNumber, agentId }) {
  // Track open steps so we can complete them when new events arrive
  const openSteps = new Map(); // key → stepId
  let currentAssistantStepId = null;

  return async function onEvent(event) {
    try {
      // Assistant message — log model + token usage
      if (event.type === 'assistant' && event.message) {
        // Complete previous assistant step if open
        if (currentAssistantStepId) {
          completeActivityStep(currentAssistantStepId, { status: 'completed' }).catch(() => {});
        }

        const model = event.message.model || 'unknown';
        const usage = event.message.usage || {};
        currentAssistantStepId = await startActivityStep(
          workItemId,
          `LLM: ${model}`,
          {
            type: 'cli_llm_call',
            parentStepId,
            agentId,
            campaignId,
            iterationNumber,
            metadata: {
              model,
              input_tokens: usage.input_tokens,
              output_tokens: usage.output_tokens,
              cache_read_tokens: usage.cache_read_input_tokens,
            },
          }
        );
      }

      // Tool use — log tool name
      if (event.type === 'tool_use' && event.name) {
        const toolName = event.name;
        // Truncate input for storage — just enough for context
        const inputSummary = event.input
          ? JSON.stringify(event.input).slice(0, 200)
          : null;

        const stepId = await startActivityStep(
          workItemId,
          `Tool: ${toolName}`,
          {
            type: 'cli_tool_use',
            parentStepId: currentAssistantStepId || parentStepId,
            agentId,
            campaignId,
            iterationNumber,
            metadata: {
              tool: toolName,
              input_summary: inputSummary,
            },
          }
        );
        openSteps.set(`tool_${toolName}_${Date.now()}`, stepId);
      }

      // Tool result — complete the tool step
      if (event.type === 'tool_result') {
        // Complete the most recent open tool step
        const lastKey = [...openSteps.keys()].pop();
        if (lastKey) {
          const stepId = openSteps.get(lastKey);
          openSteps.delete(lastKey);
          completeActivityStep(stepId, {
            status: event.is_error ? 'failed' : 'completed',
          }).catch(() => {});
        }
      }

      // Subagent — Claude Code spawning a subagent (Agent tool use)
      if (event.type === 'tool_use' && event.name === 'Agent') {
        const subagentType = event.input?.subagent_type || 'general-purpose';
        const desc = event.input?.description || 'subagent';
        await startActivityStep(
          workItemId,
          `Subagent: ${subagentType} — ${desc}`,
          {
            type: 'cli_subagent',
            parentStepId: currentAssistantStepId || parentStepId,
            agentId,
            campaignId,
            iterationNumber,
            metadata: {
              subagent_type: subagentType,
              description: desc,
            },
          }
        );
      }

      // Result — final summary, complete the assistant step
      if (event.type === 'result') {
        if (currentAssistantStepId) {
          completeActivityStep(currentAssistantStepId, {
            status: 'completed',
            metadata: {
              total_cost_usd: event.cost_usd,
              total_turns: event.num_turns,
              total_duration_ms: event.duration_ms,
            },
          }).catch(() => {});
          currentAssistantStepId = null;
        }

        // Complete any remaining open tool steps
        for (const [key, stepId] of openSteps) {
          completeActivityStep(stepId, { status: 'completed' }).catch(() => {});
        }
        openSteps.clear();
      }
    } catch {
      // Non-critical: never let logging errors break the CLI session (P3)
    }
  };
}
