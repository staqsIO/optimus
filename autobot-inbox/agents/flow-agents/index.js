/**
 * Flow-agent registry — maps agent id (post `flow:` prefix) to its declarative
 * definition. Add new flow-agents here when creating them.
 *
 * See flow-agents/README.md for the 5-minute recipe.
 */

import summarize from './summarize/index.js';
import classifyText from './classify_text/index.js';
import extractEntities from './extract_entities/index.js';
import rewriteTone from './rewrite_tone/index.js';

import { runFlowAgent } from './shared/runner.js';

export const FLOW_AGENT_PREFIX = 'flow:';

/** id (without prefix) -> definition */
export const flowAgents = {
  summarize,
  classify_text: classifyText,
  extract_entities: extractEntities,
  rewrite_tone: rewriteTone,
};

/** Look up a definition by the full prefixed id (e.g., "flow:summarize"). */
export function getFlowAgent(agentId) {
  if (typeof agentId !== 'string' || !agentId.startsWith(FLOW_AGENT_PREFIX)) return null;
  const key = agentId.slice(FLOW_AGENT_PREFIX.length);
  return flowAgents[key] || null;
}

/**
 * Dispatch a flow-agent call. Thin adapter over runFlowAgent() that unpacks
 * the prefix and returns only the output (to match the flow-step contract
 * used by existing wrappers — the step payload IS the output).
 */
export async function dispatchFlowAgent(agentId, payload) {
  const definition = getFlowAgent(agentId);
  if (!definition) {
    throw new Error(`Unknown flow-agent: "${agentId}" (not registered in flow-agents/index.js)`);
  }
  const { output } = await runFlowAgent({ definition, input: payload || {} });
  return output;
}
