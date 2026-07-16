/**
 * Shared runner for flow-native agents.
 *
 * Every flow-agent goes through this single execution path. The agent itself
 * is pure config ({ id, inputSchema, outputSchema, model, maxCostUsd, prompt,
 * system?, maxTokens?, temperature? }). If a future agent genuinely needs
 * custom logic, we add an imperative escape hatch then — not now.
 *
 * Contract:
 *   1. Validate+default input against definition.inputSchema
 *   2. Render prompt template with resolved input
 *   3. Pre-call cost estimate; fail if > maxCostUsd
 *   4. Call LLM (with single transient retry from llm.js)
 *   5. If outputSchema expects JSON, parse + validate (retry once with "format as JSON" nudge)
 *   6. Record audit row (tool_invocations) — fire-and-forget
 *   7. Return { output, metadata }
 */

import { createHash } from 'node:crypto';

import { validateInput, validateOutput, schemaExpectsJsonOutput } from './schema.js';
import { render } from './template.js';
import { callLLM, estimateMaxCost } from './llm.js';

/** Optional DB hook — injected by the host app (autobot-inbox) at wire time. */
let _auditWriter = null;
export function setAuditWriter(fn) { _auditWriter = fn; }

function hashParams(obj) {
  return createHash('sha256').update(JSON.stringify(obj || {})).digest('hex').slice(0, 16);
}

function extractJson(text) {
  if (!text) throw new Error('Empty LLM response');
  const trimmed = text.trim();
  // Fast path: already pure JSON
  try {
    return JSON.parse(trimmed);
  } catch {}
  // Strip markdown fences if present
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch {}
  }
  // Fall back: first {...} block
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try { return JSON.parse(trimmed.slice(first, last + 1)); } catch {}
  }
  throw new Error(`Could not parse JSON from LLM response: ${trimmed.slice(0, 200)}`);
}

async function callAndParse({ definition, resolvedInput, prompt, expectJson, retryNudge }) {
  const maxTokens = definition.maxTokens ?? 2048;

  const response = await callLLM({
    model: definition.model,
    prompt: retryNudge ? `${prompt}\n\n${retryNudge}` : prompt,
    system: definition.system || '',
    maxTokens,
    temperature: definition.temperature ?? 0.2,
  });

  if (!expectJson) {
    // Single-string output — pick the sole declared field.
    const fieldName = Object.keys(definition.outputSchema)[0];
    return {
      output: validateOutput(definition.outputSchema, { [fieldName]: response.text.trim() }),
      response,
    };
  }

  const parsed = extractJson(response.text);
  return {
    output: validateOutput(definition.outputSchema, parsed),
    response,
  };
}

/**
 * Run a flow-agent definition against an input.
 *
 * @param {object} params
 * @param {object} params.definition - { id, inputSchema, outputSchema, model, maxCostUsd, prompt, system?, maxTokens?, temperature? }
 * @param {object} params.input      - Flat key-value payload from the flow step
 * @param {string} [params.agentId]  - Invoking agent id for audit (defaults to `flow:<definition.id>`)
 * @param {string} [params.workItemId]
 * @returns {Promise<{ output: object, metadata: { costUsd: number, durationMs: number, model: string, inputTokens: number, outputTokens: number } }>}
 */
export async function runFlowAgent({ definition, input, agentId, workItemId }) {
  if (!definition || !definition.id) {
    throw new Error('runFlowAgent: definition must include an id');
  }
  if (!definition.inputSchema || !definition.outputSchema) {
    throw new Error(`flow-agent "${definition.id}" missing inputSchema or outputSchema`);
  }
  if (typeof definition.maxCostUsd !== 'number' || definition.maxCostUsd <= 0) {
    throw new Error(`flow-agent "${definition.id}" must declare a positive maxCostUsd`);
  }
  if (!definition.prompt) {
    throw new Error(`flow-agent "${definition.id}" missing prompt template`);
  }

  const resolvedInput = validateInput(definition.inputSchema, input);
  const prompt = render(definition.prompt, resolvedInput);

  const estimatedCost = estimateMaxCost({
    model: definition.model,
    prompt,
    maxTokens: definition.maxTokens ?? 2048,
  });
  if (estimatedCost > definition.maxCostUsd) {
    throw new Error(
      `flow-agent "${definition.id}" estimated cost $${estimatedCost.toFixed(4)} exceeds maxCostUsd $${definition.maxCostUsd.toFixed(4)}`
    );
  }

  const expectJson = schemaExpectsJsonOutput(definition.outputSchema);
  const startedAt = Date.now();

  let success = false;
  let errorMessage = null;
  let finalResponse = null;
  let finalOutput = null;

  try {
    try {
      const { output, response } = await callAndParse({
        definition,
        resolvedInput,
        prompt,
        expectJson,
      });
      finalOutput = output;
      finalResponse = response;
    } catch (err) {
      // Retry once with a JSON-format nudge if we expected JSON and parsing/validation failed.
      if (!expectJson) throw err;
      const nudge = 'Return ONLY a JSON object with exactly these fields: '
        + Object.keys(definition.outputSchema).join(', ')
        + '. No prose, no markdown fences.';
      const { output, response } = await callAndParse({
        definition,
        resolvedInput,
        prompt,
        expectJson,
        retryNudge: nudge,
      });
      finalOutput = output;
      finalResponse = response;
    }
    success = true;
  } catch (err) {
    errorMessage = err.message;
    throw err;
  } finally {
    const durationMs = Date.now() - startedAt;

    if (_auditWriter) {
      const costUsd = finalResponse?.costUsd ?? 0;
      // Fire-and-forget: audit failure must not break the flow step.
      Promise.resolve(_auditWriter({
        agentId: agentId || `flow:${definition.id}`,
        toolName: `flow:${definition.id}`,
        paramsHash: hashParams(input),
        resultSummary: success
          ? `ok cost=$${costUsd.toFixed(4)} model=${definition.model}`
          : null,
        durationMs,
        success,
        errorMessage,
        workItemId: workItemId || null,
      })).catch(() => {});
    }
  }

  return {
    output: finalOutput,
    metadata: {
      costUsd: finalResponse.costUsd,
      durationMs: Date.now() - startedAt,
      model: definition.model,
      inputTokens: finalResponse.inputTokens,
      outputTokens: finalResponse.outputTokens,
    },
  };
}
