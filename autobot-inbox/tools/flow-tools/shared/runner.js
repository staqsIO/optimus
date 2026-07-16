/**
 * Shared runner for flow-native utility tools.
 *
 * Tools are pure functions — deterministic code, no LLM, no DB writes, no
 * network calls. They transform data between agent steps. A tool definition:
 *
 *   { id, inputSchema, outputSchema?, handler }
 *
 * If outputSchema is provided we validate the handler's return. If it's an
 * empty object (i.e., dynamic), we pass through. No defaults on output.
 */

import { createHash } from 'node:crypto';

import { validateInput, validateOutput } from '../../../agents/flow-agents/shared/schema.js';

let _auditWriter = null;
export function setAuditWriter(fn) { _auditWriter = fn; }

function hashParams(obj) {
  return createHash('sha256').update(JSON.stringify(obj || {})).digest('hex').slice(0, 16);
}

/**
 * Run a flow-tool definition against an input.
 *
 * @param {object} params
 * @param {object} params.definition - { id, inputSchema, outputSchema?, handler }
 * @param {object} params.input
 * @returns {Promise<*>} The tool's output (validated if outputSchema is non-empty)
 */
export async function runFlowTool({ definition, input, agentId, workItemId }) {
  if (!definition || !definition.id || typeof definition.handler !== 'function') {
    throw new Error('runFlowTool: definition must include id and handler');
  }
  if (!definition.inputSchema) {
    throw new Error(`flow-tool "${definition.id}" missing inputSchema`);
  }

  const resolvedInput = validateInput(definition.inputSchema, input);
  const startedAt = Date.now();
  let success = false;
  let errorMessage = null;
  let output;

  try {
    output = await definition.handler(resolvedInput);

    const schema = definition.outputSchema;
    if (schema && Object.keys(schema).length > 0) {
      output = validateOutput(schema, output);
    }

    success = true;
    return output;
  } catch (err) {
    errorMessage = err.message;
    throw err;
  } finally {
    const durationMs = Date.now() - startedAt;
    if (_auditWriter) {
      Promise.resolve(_auditWriter({
        agentId: agentId || `flow-tool:${definition.id}`,
        toolName: `flow-tool:${definition.id}`,
        paramsHash: hashParams(input),
        resultSummary: success ? 'ok' : null,
        durationMs,
        success,
        errorMessage,
        workItemId: workItemId || null,
      })).catch(() => {});
    }
  }
}
