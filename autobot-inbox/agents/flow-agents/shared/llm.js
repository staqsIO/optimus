/**
 * Thin wrapper over lib/llm/provider.js for flow-agent calls.
 *
 * Loads model config from autobot-inbox/config/agents.json on first use, reuses
 * the existing createLLMClient + callProvider path. Adds:
 *   - a single retry on transient failure (network/5xx)
 *   - pre-call cost ceiling check (estimate using prompt length + maxTokens budget)
 *   - post-call actual cost calculation
 *
 * Injectable for tests via setLLMImpl().
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLLMClient, callProvider, computeCost } from '../../../../lib/llm/provider.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENTS_JSON_PATH = resolve(__dirname, '../../../config/agents.json');

let _modelsConfig = null;
let _customImpl = null;

function loadModelsConfig() {
  if (_modelsConfig) return _modelsConfig;
  const raw = readFileSync(AGENTS_JSON_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed.models) {
    throw new Error(`agents.json missing "models" section at ${AGENTS_JSON_PATH}`);
  }
  _modelsConfig = parsed.models;
  return _modelsConfig;
}

/** Test hook: replace the underlying LLM call path. */
export function setLLMImpl(impl) {
  _customImpl = impl;
}

/** Test hook: clear the custom impl. */
export function resetLLMImpl() {
  _customImpl = null;
}

/**
 * Rough token estimate: ~4 chars per token. Conservative enough for cost gating.
 * We deliberately do not import a tokenizer — provider costs are the ground
 * truth post-call, and pre-call is only a safety gate.
 */
function estimateTokens(text) {
  return Math.ceil((text?.length || 0) / 4);
}

/**
 * Estimate the maximum cost of a call before making it.
 * Assumes worst case: the model emits `maxTokens` output tokens.
 */
export function estimateMaxCost({ model, prompt, maxTokens }) {
  const models = loadModelsConfig();
  const modelConfig = models[model];
  if (!modelConfig) {
    throw new Error(`Unknown model "${model}" — not present in agents.json models`);
  }
  const inputTokens = estimateTokens(prompt);
  return computeCost(inputTokens, maxTokens, modelConfig);
}

function isTransient(err) {
  if (!err) return false;
  const msg = String(err.message || err);
  if (/(ECONNRESET|ETIMEDOUT|ENOTFOUND|fetch failed)/i.test(msg)) return true;
  const status = err.status || err.statusCode;
  return status >= 500 && status < 600;
}

/**
 * Call the LLM once with a single retry on transient failure.
 *
 * @returns {Promise<{ text: string, inputTokens: number, outputTokens: number, costUsd: number, model: string }>}
 */
export async function callLLM({ model, prompt, system, maxTokens, temperature = 0.2, signal }) {
  if (_customImpl) {
    return _customImpl({ model, prompt, system, maxTokens, temperature, signal });
  }

  const models = loadModelsConfig();
  const llm = createLLMClient(model, models);

  const params = {
    system: system || '',
    messages: [{ role: 'user', content: prompt }],
    maxTokens,
    temperature,
    signal,
  };

  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await callProvider(llm, params);
      const costUsd = computeCost(response.inputTokens, response.outputTokens, llm.modelConfig);
      return {
        text: response.text,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        costUsd,
        model,
      };
    } catch (err) {
      lastErr = err;
      if (!isTransient(err)) throw err;
    }
  }
  throw lastErr;
}
