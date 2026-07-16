/**
 * Flow-tool registry — maps tool id to its declarative definition.
 * Add new flow-tools here when creating them.
 *
 * See flow-tools/README.md for the 5-minute recipe.
 */

import jsonPick from './json_pick/index.js';
import conditionCheck from './condition_check/index.js';
import htmlToText from './html_to_text/index.js';
import listFilter from './list_filter/index.js';

import { runFlowTool } from './shared/runner.js';

export const flowTools = {
  json_pick: jsonPick,
  condition_check: conditionCheck,
  html_to_text: htmlToText,
  list_filter: listFilter,
};

/** Look up a definition by id. */
export function getFlowTool(id) {
  return flowTools[id] || null;
}

/**
 * Thin handler wrapper suitable for direct use in tool registry entries.
 * Usage:
 *   { handler: makeFlowToolHandler('json_pick') }
 */
export function makeFlowToolHandler(id) {
  const definition = flowTools[id];
  if (!definition) {
    throw new Error(`Unknown flow-tool: "${id}"`);
  }
  return (params) => runFlowTool({ definition, input: params || {} });
}
