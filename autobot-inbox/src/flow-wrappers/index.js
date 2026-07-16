/**
 * Flow wrapper registry.
 *
 * Two dispatch paths live under a single registry.dispatchToAgent override:
 *
 *   1. Pipeline wrappers — agentId is a pipeline agent name (e.g., 'executor-intake').
 *      Wrappers build a synthetic work_item / email / context, then invoke the
 *      pipeline agent handler. Each wrapper returns data shaped to the tool's
 *      output_schema declared in autobot-inbox/tools/registry.js.
 *
 *   2. Flow-native agents — agentId starts with the `flow:` prefix
 *      (e.g., 'flow:summarize'). These go through the shared declarative
 *      runner in flow-agents/shared/runner.js. No work_item, no DB side effects.
 *
 * Bootstrap:
 *   import { attachFlowWrappers } from './flow-wrappers/index.js';
 *   const registry = new FlowToolRegistry(existingToolCatalog);
 *   attachFlowWrappers(registry);
 *
 * After attach, FlowToolRegistry.dispatchToAgent(agentId, payload, config)
 * routes by agentId prefix. Unknown agentIds throw.
 */

import composeReplyWrapper from './compose-reply.js';
import scorePriorityWrapper from './score-priority.js';
import classifyMessageWrapper from './classify-message.js';
import createTicketWrapper from './create-ticket.js';
import researchAnalyzeWrapper from './research-analyze.js';

import { FLOW_AGENT_PREFIX, dispatchFlowAgent, getFlowAgent } from '../../agents/flow-agents/index.js';

/** Map from the agentId declared on each `dispatch_mode:'agent'` tool. */
export const wrappers = {
  'executor-responder': composeReplyWrapper,
  'strategist':         scorePriorityWrapper,
  'executor-intake':    classifyMessageWrapper,
  'executor-ticket':    createTicketWrapper,
  'executor-research':  researchAnalyzeWrapper,
};

/**
 * Override FlowToolRegistry.dispatchToAgent so flow steps that declare
 * dispatch_mode:'agent' actually reach the right wrapper or flow-agent.
 */
export function attachFlowWrappers(registry) {
  registry.dispatchToAgent = async function (agentId, payload, _config) {
    // Flow-native agents are prefixed. Route those through the shared runner.
    if (typeof agentId === 'string' && agentId.startsWith(FLOW_AGENT_PREFIX)) {
      if (!getFlowAgent(agentId)) {
        throw new Error(`Unknown flow-agent: "${agentId}" (not registered in flow-agents/index.js)`);
      }
      return dispatchFlowAgent(agentId, payload || {});
    }

    // Pipeline-agent wrappers (backward-compatible path).
    const wrapper = wrappers[agentId];
    if (!wrapper) {
      throw new Error(`No flow wrapper registered for agent "${agentId}"`);
    }
    return wrapper(payload || {});
  };
  return registry;
}
