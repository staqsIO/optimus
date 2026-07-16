/**
 * LLM Provider Abstraction (ADR-020)
 *
 * Thin factory + response normalizer for multi-provider LLM support.
 * Four paths:
 *   - "anthropic" (default): Anthropic SDK directly (zero proxy overhead)
 *   - "openrouter": OpenAI SDK with OpenRouter base URL
 *   - "claudeCode": Single-turn `claude -p` CLI subprocess against the user's
 *     Claude Code subscription (CLAUDE_CODE_OAUTH_TOKEN). No tools, no
 *     multi-turn — just routes structured LLM calls to subscription billing.
 *     ANTHROPIC_API_KEY is explicitly denied by spawn-cli.js so usage cannot
 *     accidentally fall back to metered billing.
 *   - "ollama" (DORMANT SEAM — OPT-39): Local/on-prem inference via Ollama's
 *     OpenAI-compatible /v1/chat/completions endpoint. Zero traffic reaches
 *     this path under any current config (no agents.json entry uses it).
 *     De-dormancy trigger: >$1500/mo sustained inference OR a customer
 *     contractually requiring on-prem. Activate by setting provider="ollama"
 *     on a model entry in agents.json and configuring OLLAMA_BASE_URL +
 *     OLLAMA_MODEL in .env.
 *
 * No over-engineering. Factory + normalizer, not a framework.
 */

import Anthropic from '@anthropic-ai/sdk';
import { spawnCLI } from '../runtime/spawn-cli.js';
import { createLogger } from '../logger.js';
const log = createLogger('llm/provider');

let _OpenAI = null;

// Dedupe [llm] remap warnings — one console.warn per distinct modelKey that
// gets remapped by the LLM_SINGLE_PROVIDER overlay, not per call.
const _warnedRemappedKeys = new Set();

// ---------------------------------------------------------------------------
// Tool-call integrity (PR-1 correctness/observability layer)
//
// Cheap models on the OpenRouter/Ollama paths can emit tool_use blocks whose
// arguments are malformed JSON (markdown-fenced, truncated at max_tokens, ...).
// safeParseJSON() used to swallow that and hand back {} — indistinguishable from
// a model that legitimately called a tool with no arguments — so corrupt/empty
// input flowed straight into guardCheck. In a deny-by-default system (P1) that
// is a correctness bug. These markers + counters make the failure loud (P3) and
// repair-eligible. Inert on well-formed responses (the common case) and on the
// Anthropic blocking path (which never calls safeParseJSON).
// ---------------------------------------------------------------------------

/** Marks a tool `input` whose raw arguments failed JSON.parse. */
export const TOOL_PARSE_ERROR = Symbol('optimus.toolInputParseError');
/** Marks a tool `input` still invalid after a single repair retry. */
export const TOOL_VALIDATION_ERROR = Symbol('optimus.toolInputValidationError');

/** True if a normalized tool-call `input` carries either integrity marker. */
export function isToolInputError(input) {
  return !!(input && typeof input === 'object' &&
    (input[TOOL_PARSE_ERROR] || input[TOOL_VALIDATION_ERROR]));
}

// In-process counters. No metrics sink exists in this repo (LLM spend goes to
// agent_graph.llm_invocations); per P4 we do not add one. The durable signal is
// the structured `event: 'tool_call_repair'` log line; these counters let
// tool_call_repair_rate (SLO < 2%) be read/asserted in-process.
const _toolCallStats = {
  toolCallsSeen: 0,       // per individual tool call
  toolCallsMalformed: 0,  // per individual tool call — rate numerator (unit-matched to toolCallsSeen)
  parseFailures: 0,
  repairsTriggered: 0,    // per response/retry event (a multi-call response = 1)
  repairsSucceeded: 0,
  repairsFailed: 0,
};

/**
 * Snapshot of tool-call integrity counters, incl. derived tool_call_repair_rate.
 * The rate is malformed-tool-calls / tool-calls-seen — both per individual call,
 * so a response with two malformed calls reads 2/2, not 1/2 (repairsTriggered is
 * a per-response event count and would mix units in this ratio).
 */
export function getToolCallRepairStats() {
  const { toolCallsSeen, toolCallsMalformed } = _toolCallStats;
  return {
    ..._toolCallStats,
    tool_call_repair_rate: toolCallsSeen > 0 ? toolCallsMalformed / toolCallsSeen : 0,
  };
}

/** Reset counters (test helper). */
export function resetToolCallRepairStats() {
  for (const k of Object.keys(_toolCallStats)) _toolCallStats[k] = 0;
}

/**
 * Lazily load the OpenAI SDK (only when an OpenRouter model is used).
 */
async function getOpenAI() {
  if (!_OpenAI) {
    const mod = await import('openai');
    _OpenAI = mod.default || mod.OpenAI;
  }
  return _OpenAI;
}

// stopReason normalization (Linus blocker #2)
const ANTHROPIC_STOP_MAP = {
  end_turn: 'end_turn',
  max_tokens: 'max_tokens',
  tool_use: 'tool_use',
  stop_sequence: 'end_turn',
};

const OPENAI_STOP_MAP = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  content_filter: 'end_turn',
};

/**
 * Create an LLM client for the given model.
 * Fail-fast: throws at construction time if the required API key is missing.
 *
 * @param {string} modelKey - Key in models config (also the model ID sent to API)
 * @param {object} modelsConfig - The `models` object from agents.json
 * @returns {{ client: object, provider: string, modelId: string, modelConfig: object }}
 */
export function createLLMClient(modelKey, modelsConfig) {
  const modelConfig = modelsConfig[modelKey];
  if (!modelConfig) {
    throw new Error(`Unknown model: ${modelKey}. Add it to agents.json models config.`);
  }

  const provider = modelConfig.provider || 'anthropic';

  // Single-provider overlay (OSS zero-config demo boot). Reads ONLY
  // LLM_SINGLE_PROVIDER / LLM_SINGLE_PROVIDER_MODEL — lib/ stays product-agnostic;
  // DEMO_MODE is never read here (see autobot-inbox/src/index.js for that wiring).
  // Pure no-op when LLM_SINGLE_PROVIDER is unset (prod default, byte-identical).
  const singleProvider = process.env.LLM_SINGLE_PROVIDER;
  if (singleProvider && provider !== singleProvider) {
    let fallbackKey = process.env.LLM_SINGLE_PROVIDER_MODEL;
    if (!fallbackKey) {
      // Default to the CHEAPEST model on the target provider (by inputCostPer1M),
      // not the first-declared one. models config declares Opus first, so a naive
      // find() would silently route the zero-config demo onto the priciest Claude
      // model — the opposite of what a cost-sensitive OSS demo wants. Missing/non-
      // numeric cost sorts last (Infinity); insertion order breaks ties.
      fallbackKey = Object.keys(modelsConfig)
        .filter((key) => (modelsConfig[key].provider || 'anthropic') === singleProvider)
        .reduce((cheapest, key) => {
          if (cheapest === undefined) return key;
          const cost = typeof modelsConfig[key].inputCostPer1M === 'number'
            ? modelsConfig[key].inputCostPer1M : Infinity;
          const best = typeof modelsConfig[cheapest].inputCostPer1M === 'number'
            ? modelsConfig[cheapest].inputCostPer1M : Infinity;
          return cost < best ? key : cheapest;
        }, undefined);
    }
    if (!fallbackKey) {
      throw new Error(
        `LLM_SINGLE_PROVIDER="${singleProvider}" is set but no model in modelsConfig resolves to provider "${singleProvider}" (and LLM_SINGLE_PROVIDER_MODEL is unset). Add a model entry with provider="${singleProvider}" to agents.json, or set LLM_SINGLE_PROVIDER_MODEL to an existing key.`
      );
    }
    if (fallbackKey !== modelKey) {
      if (!_warnedRemappedKeys.has(modelKey)) {
        _warnedRemappedKeys.add(modelKey);
        console.warn(`[llm] LLM_SINGLE_PROVIDER=${singleProvider} → remapping ${modelKey} (${provider}) → ${fallbackKey}`);
      }
      return createLLMClient(fallbackKey, modelsConfig);
    }
  }

  if (provider === 'anthropic') {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error(`ANTHROPIC_API_KEY required for model ${modelKey}`);
    }
    return {
      client: new Anthropic(),
      provider: 'anthropic',
      modelId: modelKey,
      modelConfig,
      // Lazy OpenAI client for openrouter — not needed here
      _openaiClientPromise: null,
    };
  }

  if (provider === 'openrouter') {
    if (!process.env.OPENROUTER_API_KEY) {
      throw new Error(`OPENROUTER_API_KEY required for model ${modelKey}. Set it in .env.`);
    }
    // Return a deferred client — actual SDK loaded lazily on first call
    return {
      client: null, // populated on first callProvider
      provider: 'openrouter',
      modelId: modelKey,
      modelConfig,
      _openaiClientPromise: null,
    };
  }

  if (provider === 'claudeCode') {
    if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      throw new Error(`CLAUDE_CODE_OAUTH_TOKEN required for model ${modelKey}. This provider routes calls to the user's Claude Code subscription via the claude CLI.`);
    }
    if (!modelConfig.cliModel) {
      throw new Error(`Model ${modelKey} (provider=claudeCode) is missing required "cliModel" field (e.g. "sonnet", "haiku").`);
    }
    return {
      client: null, // CLI subprocess — no SDK client
      provider: 'claudeCode',
      modelId: modelKey,
      modelConfig,
    };
  }

  // DORMANT SEAM (OPT-39): ollama — local/on-prem inference.
  // Reachable only when provider="ollama" is explicitly set in agents.json.
  // No existing agent config routes here; this case is inert by default.
  if (provider === 'ollama') {
    // No API key required — Ollama runs unauthenticated on localhost by default.
    // OLLAMA_BASE_URL defaults to http://localhost:11434 if not set.
    return {
      client: null, // populated lazily on first callProvider
      provider: 'ollama',
      modelId: process.env.OLLAMA_MODEL || modelKey,
      modelConfig,
    };
  }

  throw new Error(`Unknown provider "${provider}" for model ${modelKey}. Supported: anthropic, openrouter, claudeCode, ollama.`);
}

/**
 * Ensure the OpenRouter client is initialized (lazy load).
 */
async function ensureOpenRouterClient(llm) {
  if (llm.client) return llm.client;
  const OpenAI = await getOpenAI();
  llm.client = new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY,
    defaultHeaders: {
      'HTTP-Referer': 'https://github.com/staqsIO/optimus',
      'X-Title': 'Optimus',
    },
  });
  return llm.client;
}

/**
 * Ensure the Ollama client is initialized (lazy load).
 *
 * Ollama exposes an OpenAI-compatible /v1/chat/completions endpoint.
 * OLLAMA_BASE_URL defaults to http://localhost:11434.
 * No API key is required (Ollama is unauthenticated by default).
 */
async function ensureOllamaClient(llm) {
  if (llm.client) return llm.client;
  const OpenAI = await getOpenAI();
  const baseURL = (process.env.OLLAMA_BASE_URL || 'http://localhost:11434') + '/v1';
  llm.client = new OpenAI({
    baseURL,
    apiKey: 'ollama', // OpenAI SDK requires a non-empty string; Ollama ignores it
  });
  return llm.client;
}

/**
 * Call the LLM provider and return a normalized response.
 *
 * @param {object} llm - Result from createLLMClient()
 * @param {object} params
 * @param {string} params.system - System prompt
 * @param {Array} params.messages - Messages array
 * @param {number} params.maxTokens
 * @param {number} [params.temperature]
 * @param {Array} [params.tools] - Tool definitions (Anthropic format)
 * @param {AbortSignal} [params.signal] - AbortController signal
 * @returns {Promise<NormalizedResponse>}
 */
export async function callProvider(llm, params) {
  const response = await dispatchProvider(llm, params);
  // Validate tool-call input shape and repair-once before it flows downstream
  // (e.g. into guardCheck). No-op — byte-identical return — when there are no
  // tools, no tool calls, or every tool call is well-formed.
  return repairToolCalls(llm, params, response);
}

/**
 * Raw provider dispatch (no tool-call repair). Kept separate so repairToolCalls
 * can re-invoke exactly one provider round-trip without recursing through the
 * repair layer.
 */
async function dispatchProvider(llm, { system, messages, maxTokens, temperature, tools, toolChoice, signal, reasoningEffort }) {
  if (llm.provider === 'anthropic') {
    return callAnthropic(llm, { system, messages, maxTokens, temperature, tools, toolChoice, signal });
  }
  if (llm.provider === 'openrouter') {
    return callOpenRouter(llm, { system, messages, maxTokens, temperature, tools, signal, reasoningEffort });
  }
  if (llm.provider === 'claudeCode') {
    return callClaudeCodeCLI(llm, { system, messages, maxTokens, temperature, tools, signal });
  }
  if (llm.provider === 'ollama') {
    return callOllama(llm, { system, messages, maxTokens, temperature, tools, signal });
  }
  throw new Error(`Unsupported provider: ${llm.provider}`);
}

/**
 * Streaming variant of callProvider. Async generator that yields:
 *   { type: 'token', delta: string }          — text as it arrives
 *   { type: 'final', response: Normalized }   — exactly one, last; same shape
 *                                               as callProvider's return value
 *                                               (raw.content is reconstructed
 *                                               Anthropic-format blocks so the
 *                                               tool-use loop can push it back
 *                                               into the message array).
 *
 * claudeCode has no streaming API — it falls back to the blocking call and
 * yields the full text as a single token frame.
 *
 * @param {object} llm - Result from createLLMClient()
 * @param {object} params - Same shape as callProvider params
 */
export async function* callProviderStream(llm, { system, messages, maxTokens, temperature, tools, toolChoice, signal, reasoningEffort }) {
  if (llm.provider === 'anthropic') {
    yield* streamAnthropic(llm, { system, messages, maxTokens, temperature, tools, toolChoice, signal });
    return;
  }
  if (llm.provider === 'openrouter') {
    yield* streamOpenRouter(llm, { system, messages, maxTokens, temperature, tools, signal, reasoningEffort });
    return;
  }
  if (llm.provider === 'claudeCode') {
    const response = await callClaudeCodeCLI(llm, { system, messages, maxTokens, temperature, tools, signal });
    if (response.text) yield { type: 'token', delta: response.text };
    yield { type: 'final', response };
    return;
  }
  if (llm.provider === 'ollama') {
    yield* streamOllama(llm, { system, messages, maxTokens, temperature, tools, signal });
    return;
  }
  throw new Error(`Unsupported provider: ${llm.provider}`);
}

/**
 * Anthropic streaming — raw event stream (stream:true), normalized.
 */
async function* streamAnthropic(llm, { system, messages, maxTokens, temperature, tools, toolChoice, signal }) {
  const body = {
    model: llm.modelId,
    max_tokens: maxTokens,
    temperature,
    system,
    messages,
    stream: true,
  };
  if (tools && tools.length > 0) {
    body.tools = tools;
    if (toolChoice) body.tool_choice = toolChoice;
  }

  const stream = await llm.client.messages.create(body, signal ? { signal } : undefined);

  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason = null;
  // index -> in-progress content block (text accumulates, tool input json accumulates)
  const blocks = new Map();

  for await (const ev of stream) {
    if (ev.type === 'message_start') {
      inputTokens = ev.message?.usage?.input_tokens || 0;
    } else if (ev.type === 'content_block_start') {
      const cb = ev.content_block;
      blocks.set(ev.index, cb.type === 'tool_use'
        ? { type: 'tool_use', id: cb.id, name: cb.name, _json: '' }
        : { type: 'text', text: '' });
    } else if (ev.type === 'content_block_delta') {
      const b = blocks.get(ev.index);
      if (ev.delta?.type === 'text_delta') {
        if (b) b.text += ev.delta.text;
        yield { type: 'token', delta: ev.delta.text };
      } else if (ev.delta?.type === 'input_json_delta' && b) {
        b._json += ev.delta.partial_json;
      }
    } else if (ev.type === 'message_delta') {
      if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
      if (ev.usage?.output_tokens != null) outputTokens = ev.usage.output_tokens;
    }
  }

  // Reconstruct Anthropic-format content blocks in stream order.
  const content = [...blocks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, b]) => b.type === 'tool_use'
      ? { type: 'tool_use', id: b.id, name: b.name, input: safeParseJSON(b._json) }
      : { type: 'text', text: b.text });

  const text = content.filter(b => b.type === 'text').map(b => b.text).join('');
  const toolCalls = content.filter(b => b.type === 'tool_use');

  yield {
    type: 'final',
    response: {
      text,
      inputTokens,
      outputTokens,
      stopReason: ANTHROPIC_STOP_MAP[stopReason] || stopReason || 'end_turn',
      toolCalls,
      raw: { content },
    },
  };
}

/**
 * OpenRouter streaming — OpenAI-format chunks (stream:true), normalized.
 * stream_options.include_usage puts token usage on the final chunk.
 */
async function* streamOpenRouter(llm, { system, messages, maxTokens, temperature, tools, signal, reasoningEffort }) {
  const client = await ensureOpenRouterClient(llm);
  const body = buildOpenRouterBody(llm, { system, messages, maxTokens, temperature, tools, reasoningEffort, providerRouting: true });
  body.stream = true;
  body.stream_options = { include_usage: true };

  const stream = await client.chat.completions.create(body, signal ? { signal } : undefined);

  let text = '';
  let finishReason = null;
  let usage = null;
  // index -> accumulating tool call (arguments arrive as string fragments)
  const tcAcc = new Map();
  // Suppress <think> scratchpad from the LIVE token stream (a per-chunk strip
  // leaks it — see createThinkStripper). Consumers only ever see stripped tokens.
  const stripper = createThinkStripper();

  for await (const chunk of stream) {
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta || {};
    if (delta.content) {
      text += delta.content;
      const emit = stripper.push(delta.content);
      if (emit) yield { type: 'token', delta: emit };
    }
    for (const tc of delta.tool_calls || []) {
      const e = tcAcc.get(tc.index) || { id: '', name: '', args: '' };
      if (tc.id) e.id = tc.id;
      if (tc.function?.name) e.name = tc.function.name;
      if (tc.function?.arguments) e.args += tc.function.arguments;
      tcAcc.set(tc.index, e);
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }
  const flushed = stripper.flush();
  if (flushed) yield { type: 'token', delta: flushed };

  const toolCalls = [...tcAcc.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, e]) => ({ type: 'tool_use', id: e.id, name: e.name, input: safeParseJSON(e.args) }));

  const inputTokens = usage?.prompt_tokens || 0;
  const outputTokens = usage?.completion_tokens || 0;
  if (inputTokens === 0 && (text.length > 0 || toolCalls.length > 0)) {
    log.warn(`OpenRouter stream returned 0 input tokens for non-empty response (model: ${llm.modelId}).`);
  }

  // Reconstruct Anthropic-format content so the tool-use loop can push the
  // assistant turn back into the (Anthropic-format) message array. Strip any
  // <think> scratchpad from the assembled text before it reaches consumers —
  // the normalized `text` AND `raw.content` both carry the cleaned value so no
  // downstream reader (chat, RAG, voice corpus) ever sees the scratchpad.
  const cleanText = stripReasoningTags(text);
  const content = [];
  if (cleanText) content.push({ type: 'text', text: cleanText });
  content.push(...toolCalls);

  // Route the final frame through the same fail-closed repair/enforce layer the
  // blocking path uses — streaming previously bypassed it, leaving the original
  // empty-input fail-open path reachable via streaming consumers.
  const finalResponse = await repairToolCalls(
    llm,
    { system, messages, maxTokens, temperature, tools, signal, reasoningEffort },
    {
      text: cleanText,
      inputTokens,
      outputTokens,
      stopReason: OPENAI_STOP_MAP[finishReason] || finishReason || 'end_turn',
      toolCalls,
      raw: { content },
    },
  );
  yield { type: 'final', response: finalResponse };
}

/**
 * Anthropic SDK path — existing behavior, zero overhead.
 */
async function callAnthropic(llm, { system, messages, maxTokens, temperature, tools, toolChoice, signal }) {
  const body = {
    model: llm.modelId,
    max_tokens: maxTokens,
    temperature,
    system,
    messages,
  };
  if (tools && tools.length > 0) {
    body.tools = tools;
    if (toolChoice) body.tool_choice = toolChoice;
  }

  const response = await llm.client.messages.create(body, signal ? { signal } : undefined);

  const text = response.content?.find(b => b.type === 'text')?.text || '';
  const toolCalls = response.content?.filter(b => b.type === 'tool_use') || [];

  return {
    text,
    inputTokens: response.usage?.input_tokens || 0,
    outputTokens: response.usage?.output_tokens || 0,
    stopReason: ANTHROPIC_STOP_MAP[response.stop_reason] || response.stop_reason,
    toolCalls,
    raw: response,
  };
}

/**
 * Convert an Anthropic-format message array to OpenAI format.
 *
 * Plain string content passes through. Content-block arrays (produced by the
 * tool-use loop) need structural conversion:
 *   - assistant tool_use blocks  -> assistant message with tool_calls[]
 *   - user tool_result blocks    -> one role:"tool" message per result
 * Without this, tool round-trips through OpenRouter sent Anthropic block
 * arrays verbatim — the model saw an empty assistant turn followed by opaque
 * JSON, and multi-round tool use silently degraded.
 */
function toOpenAIMessages(system, messages) {
  const openaiMessages = [];
  if (system) {
    openaiMessages.push({ role: 'system', content: system });
  }
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) {
      openaiMessages.push({ role: msg.role, content: msg.content });
      continue;
    }
    if (msg.role === 'assistant') {
      const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
      const toolCalls = msg.content.filter(b => b.type === 'tool_use').map(b => ({
        id: b.id,
        type: 'function',
        function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
      }));
      const m = { role: 'assistant', content: text || null };
      if (toolCalls.length > 0) m.tool_calls = toolCalls;
      openaiMessages.push(m);
      continue;
    }
    // user turn: tool_result blocks become role:"tool" messages; any text
    // blocks become a trailing plain user message.
    let trailingText = '';
    for (const b of msg.content) {
      if (b.type === 'tool_result') {
        openaiMessages.push({
          role: 'tool',
          tool_call_id: b.tool_use_id,
          content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content),
        });
      } else if (b.type === 'text') {
        trailingText += b.text;
      }
    }
    if (trailingText) openaiMessages.push({ role: msg.role, content: trailingText });
  }
  return openaiMessages;
}

/**
 * Build the OpenAI-format request body shared by the blocking and streaming
 * OpenRouter paths.
 *
 * reasoningEffort ("minimal"|"low"|"medium"|"high") maps to OpenRouter's
 * unified reasoning parameter — on thinking models (gemini-2.5-pro etc.) it
 * caps the internal reasoning budget, which dominates time-to-first-token.
 * Only attached when explicitly configured; non-reasoning models ignore it.
 */
export function buildOpenRouterBody(llm, { system, messages, maxTokens, temperature, tools, reasoningEffort, providerRouting = false }) {
  const body = {
    model: llm.modelId,
    max_tokens: maxTokens,
    temperature,
    messages: toOpenAIMessages(system, messages),
  };

  // Deterministic OpenRouter routing (OSS model swap). `require_parameters: true`
  // is the load-bearing reliability lever: it restricts routing to upstreams that
  // actually honor every request parameter — crucially `tools`/function-calling —
  // so we never land on a provider that silently drops the tool schema and emits
  // malformed calls (the failure class the tool-call guardrail layer exists to
  // catch). `allow_fallbacks` defaults to false to pin the tool-call grammar to a
  // single upstream day-to-day; set OPENROUTER_ALLOW_FALLBACKS=true to trade that
  // determinism for uptime resilience across param-supporting upstreams. An
  // explicit per-model upstream ranking can be supplied via llm.providerOrder.
  //
  // OpenRouter-ONLY: this builder is also reused by the Ollama paths purely for
  // Anthropic→OpenAI message/tool conversion. Ollama's /v1/chat/completions does
  // not understand OpenRouter's `provider` routing object and would reject it, so
  // the field is gated behind `providerRouting` (passed true only by the two
  // OpenRouter call sites, never by callOllama/streamOllama).
  if (providerRouting) {
    body.provider = {
      require_parameters: true,
      allow_fallbacks: process.env.OPENROUTER_ALLOW_FALLBACKS === 'true',
    };
    if (Array.isArray(llm.providerOrder) && llm.providerOrder.length > 0) {
      body.provider.order = llm.providerOrder;
    }
  }

  if (reasoningEffort) {
    body.reasoning = { effort: reasoningEffort };
  }

  // Convert tool format: Anthropic {name, input_schema} -> OpenAI {type:"function", function:{name, parameters}}
  if (tools && tools.length > 0) {
    body.tools = tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema,
      },
    }));
  }
  return body;
}

/**
 * Strip model "thinking" blocks from assistant text. Qwen3 and some DeepSeek
 * reasoning models emit `<think>...</think>` scratchpad inline in the content;
 * it is not part of the answer and must never reach consumers, RAG, or the voice
 * corpus. Handles an unterminated trailing `<think>` (streaming cutoff) by
 * dropping everything from it onward. No-op (byte-identical) when the text
 * contains no `<think>` tag, so non-reasoning models are unaffected.
 */
export function stripReasoningTags(text) {
  if (!text || typeof text !== 'string' || !text.includes('<think>')) return text;
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<think>[\s\S]*$/, '')
    .trim();
}

const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';

// Longest non-empty proper prefix of `tag` that is a suffix of `s` — i.e. how
// many trailing chars of `s` might be the start of `tag` continuing in the next
// chunk. Used to hold back a partial tag straddling a token boundary.
function danglingPrefixLen(s, tag) {
  const max = Math.min(s.length, tag.length - 1);
  for (let n = max; n > 0; n--) {
    if (s.slice(s.length - n) === tag.slice(0, n)) return n;
  }
  return 0;
}

/**
 * Stateful streaming counterpart to `stripReasoningTags`. A reasoning model
 * emits `<think>…</think>` scratchpad token-by-token, so a per-chunk regex
 * strip leaks it: the opening tag and its contents stream out before the
 * closing tag ever arrives, and either tag can be split across chunks. This
 * filter tracks whether we are inside a think block across `push()` calls and
 * holds back a trailing partial-tag prefix so a boundary-split `<think>` /
 * `</think>` is still recognized. `push(delta)` returns only the emittable
 * (think-free) text; `flush()` returns any held-back tail once the stream ends
 * (a dangling `<think>` prefix that never completed is literal text; an
 * unclosed think block is dropped). No-op passthrough for non-reasoning models.
 */
export function createThinkStripper() {
  let inside = false;
  let buf = '';

  function process() {
    let out = '';
    for (;;) {
      if (!inside) {
        const i = buf.indexOf(THINK_OPEN);
        if (i === -1) break;
        out += buf.slice(0, i);
        buf = buf.slice(i + THINK_OPEN.length);
        inside = true;
      } else {
        const i = buf.indexOf(THINK_CLOSE);
        if (i === -1) break;
        buf = buf.slice(i + THINK_CLOSE.length);
        inside = false;
      }
    }
    if (!inside) {
      // Emit all but a possible dangling '<think>' prefix at the tail.
      const hold = danglingPrefixLen(buf, THINK_OPEN);
      out += buf.slice(0, buf.length - hold);
      buf = buf.slice(buf.length - hold);
    } else {
      // Inside a think block: drop everything except a possible dangling
      // '</think>' prefix that could complete on the next chunk.
      const hold = danglingPrefixLen(buf, THINK_CLOSE);
      buf = buf.slice(buf.length - hold);
    }
    return out;
  }

  return {
    push(delta) {
      if (!delta) return '';
      buf += delta;
      return process();
    },
    flush() {
      const out = inside ? '' : buf;
      buf = '';
      inside = false;
      return out;
    },
  };
}

/**
 * OpenRouter path — OpenAI SDK with base URL override.
 * Converts Anthropic-format tools to OpenAI format, normalizes response back.
 */
async function callOpenRouter(llm, { system, messages, maxTokens, temperature, tools, signal, reasoningEffort }) {
  const client = await ensureOpenRouterClient(llm);
  const body = buildOpenRouterBody(llm, { system, messages, maxTokens, temperature, tools, reasoningEffort, providerRouting: true });

  const response = await client.chat.completions.create(body, signal ? { signal } : undefined);

  const choice = response.choices?.[0];
  const text = stripReasoningTags(choice?.message?.content || '');
  // Sanitize the scratchpad out of the raw response too — `raw: response` is
  // returned below and a consumer reading raw.choices[].message.content must
  // not see <think> (the streaming paths already reconstruct sanitized raw
  // content). Only the text string is rewritten; tool_calls/other fields stay.
  if (choice?.message && typeof choice.message.content === 'string') {
    choice.message.content = text;
  }

  // Normalize tool calls from OpenAI format back to Anthropic-like shape
  const rawToolCalls = choice?.message?.tool_calls || [];
  const toolCalls = rawToolCalls.map(tc => ({
    type: 'tool_use',
    id: tc.id,
    name: tc.function?.name,
    input: safeParseJSON(tc.function?.arguments),
  }));

  const inputTokens = response.usage?.prompt_tokens || 0;
  const outputTokens = response.usage?.completion_tokens || 0;

  // Token sanity check (Liotta): warn if 0 tokens for non-empty response
  if (inputTokens === 0 && (text.length > 0 || toolCalls.length > 0)) {
    const estimated = Math.ceil(text.length / 4);
    log.warn(`OpenRouter returned 0 input tokens for non-empty response (model: ${llm.modelId}). Estimated ~${estimated} tokens from text length.`);
  }

  return {
    text,
    inputTokens,
    outputTokens,
    stopReason: OPENAI_STOP_MAP[choice?.finish_reason] || choice?.finish_reason || 'end_turn',
    toolCalls,
    raw: response,
  };
}

/**
 * Claude Code CLI path — single-turn, no tools, subscription billing.
 *
 * Uses spawn-cli.js to invoke `claude -p` against the user's Claude Code
 * subscription (CLAUDE_CODE_OAUTH_TOKEN). spawn-cli enforces an env denylist
 * that blocks ANTHROPIC_API_KEY, guaranteeing this path can never fall back
 * to metered API billing.
 *
 * Tradeoffs vs the Anthropic SDK path:
 *   - +500-2000 ms startup overhead per call (CLI subprocess)
 *   - Token counts are unavailable from `claude -p --output-format json`,
 *     so inputTokens/outputTokens are returned as 0
 *   - Tool calling is intentionally disabled (allowedTools=[]) — this provider
 *     is for plain text/JSON generation. Use the agentic claudeCode session
 *     pattern (executor-coder) when tool use is required.
 */
async function callClaudeCodeCLI(llm, { system, messages, maxTokens, temperature, tools, signal }) {
  if (tools && tools.length > 0) {
    throw new Error('claudeCode provider does not support tool calls. Use the agentic claudeCode session pattern (executor-coder) for tool use.');
  }
  if (signal?.aborted) {
    throw new Error('aborted');
  }

  // Flatten messages into a single user prompt — single-turn only.
  // Multi-turn message arrays are unusual for this provider's intended use
  // (structured per-iteration calls in agents like the researcher) but if
  // they appear, concatenate role-tagged for the CLI.
  const prompt = messages.length === 1 && messages[0].role === 'user'
    ? messages[0].content
    : messages.map(m => `[${m.role}] ${m.content}`).join('\n\n');

  // Map maxTokens to a reasonable wall-clock timeout. CLI doesn't honor
  // max_tokens directly, but a soft timeout caps runaway generations.
  // Default: 5 minutes; longer for unusually large maxTokens.
  const timeoutMs = Math.max(60_000, Math.min(600_000, (maxTokens || 4096) * 60));

  const result = await spawnCLI({
    backend: 'claude',
    prompt,
    systemPrompt: system,
    model: llm.modelConfig.cliModel,
    allowedTools: [],          // text/JSON only — no tool use on this path
    maxTurns: 1,               // single turn — pure generation
    maxBudgetUsd: 1.00,        // CLI's own per-call ceiling, separate from G1
    timeoutMs,
    label: `llm:${llm.modelId}`,
    agentTag: 'llm-provider',
  });

  if (result.isError) {
    throw new Error(`claudeCode CLI error: ${result.error || 'unknown'}`);
  }

  // Token counts unavailable from CLI — provide 0 sentinels. computeCost()
  // will return 0 because the model config has zero costs (subscription).
  return {
    text: result.result || '',
    inputTokens: 0,
    outputTokens: 0,
    stopReason: 'end_turn',
    toolCalls: [],
    raw: result,
  };
}

/**
 * Ollama blocking path — OpenAI-compatible /v1/chat/completions.
 *
 * DORMANT SEAM (OPT-39): only reachable when provider="ollama" is explicitly
 * set in agents.json. No current agent config reaches this path.
 *
 * Reuses buildOpenRouterBody (Anthropic→OpenAI message/tool conversion) since
 * Ollama's endpoint is OpenAI-compatible. Token counts come from usage field
 * when the model reports them; some Ollama models omit usage — 0 is returned
 * in that case (same fallback used by OpenRouter path).
 */
async function callOllama(llm, { system, messages, maxTokens, temperature, tools, signal }) {
  const client = await ensureOllamaClient(llm);
  const body = buildOpenRouterBody(llm, { system, messages, maxTokens, temperature, tools });

  const response = await client.chat.completions.create(body, signal ? { signal } : undefined);

  const choice = response.choices?.[0];
  const text = stripReasoningTags(choice?.message?.content || '');
  // Sanitize the scratchpad out of the raw response too — `raw: response` is
  // returned below and a consumer reading raw.choices[].message.content must
  // not see <think> (the streaming paths already reconstruct sanitized raw
  // content). Only the text string is rewritten; tool_calls/other fields stay.
  if (choice?.message && typeof choice.message.content === 'string') {
    choice.message.content = text;
  }

  const rawToolCalls = choice?.message?.tool_calls || [];
  const toolCalls = rawToolCalls.map(tc => ({
    type: 'tool_use',
    id: tc.id,
    name: tc.function?.name,
    input: safeParseJSON(tc.function?.arguments),
  }));

  const inputTokens = response.usage?.prompt_tokens || 0;
  const outputTokens = response.usage?.completion_tokens || 0;

  return {
    text,
    inputTokens,
    outputTokens,
    stopReason: OPENAI_STOP_MAP[choice?.finish_reason] || choice?.finish_reason || 'end_turn',
    toolCalls,
    raw: response,
  };
}

/**
 * Ollama streaming path — OpenAI-format SSE chunks, normalized.
 *
 * DORMANT SEAM (OPT-39). Mirrors streamOpenRouter exactly; Ollama's streaming
 * format is OpenAI-compatible. Some models omit usage on the final chunk —
 * 0 token counts are returned in that case.
 */
async function* streamOllama(llm, { system, messages, maxTokens, temperature, tools, signal }) {
  const client = await ensureOllamaClient(llm);
  const body = buildOpenRouterBody(llm, { system, messages, maxTokens, temperature, tools });
  body.stream = true;
  body.stream_options = { include_usage: true };

  const stream = await client.chat.completions.create(body, signal ? { signal } : undefined);

  let text = '';
  let finishReason = null;
  let usage = null;
  const tcAcc = new Map();
  // Suppress <think> scratchpad from the LIVE token stream (mirrors streamOpenRouter).
  const stripper = createThinkStripper();

  for await (const chunk of stream) {
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta || {};
    if (delta.content) {
      text += delta.content;
      const emit = stripper.push(delta.content);
      if (emit) yield { type: 'token', delta: emit };
    }
    for (const tc of delta.tool_calls || []) {
      const e = tcAcc.get(tc.index) || { id: '', name: '', args: '' };
      if (tc.id) e.id = tc.id;
      if (tc.function?.name) e.name = tc.function.name;
      if (tc.function?.arguments) e.args += tc.function.arguments;
      tcAcc.set(tc.index, e);
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }
  const flushed = stripper.flush();
  if (flushed) yield { type: 'token', delta: flushed };

  const toolCalls = [...tcAcc.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, e]) => ({ type: 'tool_use', id: e.id, name: e.name, input: safeParseJSON(e.args) }));

  const inputTokens = usage?.prompt_tokens || 0;
  const outputTokens = usage?.completion_tokens || 0;

  // Both the normalized `text` and `raw.content` carry the cleaned value so no
  // downstream reader ever sees the scratchpad.
  const content = [];
  const cleanText = stripReasoningTags(text);
  if (cleanText) content.push({ type: 'text', text: cleanText });
  content.push(...toolCalls);

  // Route the final frame through the same fail-closed repair/enforce layer the
  // blocking path uses (streaming previously bypassed it).
  const finalResponse = await repairToolCalls(
    llm,
    { system, messages, maxTokens, temperature, tools, signal },
    {
      text: cleanText,
      inputTokens,
      outputTokens,
      stopReason: OPENAI_STOP_MAP[finishReason] || finishReason || 'end_turn',
      toolCalls,
      raw: { content },
    },
  );
  yield { type: 'final', response: finalResponse };
}

/**
 * Enforce a per-agent provider lock. Fail-closed.
 *
 * Used by agent-loop.js to prevent accidental provider drift — e.g. the
 * researcher agent declares requireProvider="claudeCode" so even if someone
 * edits its model field to a Claude Sonnet API model, startup fails loud
 * instead of silently switching billing from subscription to API.
 *
 * @param {object} llm - Result from createLLMClient()
 * @param {string|undefined} required - Required provider name (or falsy to skip)
 * @param {string} agentId - For error message context
 * @param {string} modelKey - For error message context
 * @throws {Error} if required is set and llm.provider doesn't match
 */
export function assertRequiredProvider(llm, required, agentId, modelKey) {
  if (!required) return;
  if (llm.provider !== required) {
    throw new Error(
      `Agent "${agentId}" requires provider="${required}" but model "${modelKey}" resolved to provider="${llm.provider}". Refusing to run — fix the model entry in agents.json or remove requireProvider from the agent config.`
    );
  }
}

/**
 * Compute cost in USD from token counts and model config.
 *
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @param {object} modelConfig - Must have inputCostPer1M and outputCostPer1M
 * @returns {number} Cost in USD
 */
export function computeCost(inputTokens, outputTokens, modelConfig) {
  if (!modelConfig) return 0;
  return (inputTokens * modelConfig.inputCostPer1M / 1_000_000) +
         (outputTokens * modelConfig.outputCostPer1M / 1_000_000);
}

/**
 * Parse tool-call arguments, failing LOUD on malformed JSON.
 *
 * Success → the parsed value (well-formed happy path, unchanged). JSON.parse
 * failure → log the raw string (truncated) at warn, bump the parse-failure
 * counter, and return an empty object MARKED with TOOL_PARSE_ERROR so the repair
 * layer can distinguish "the model emitted garbage" from "the model deliberately
 * passed {}". Never throws — a marked object keeps every existing consumer (which
 * reads `.input`) crash-safe while making the failure visible and repairable.
 */
function safeParseJSON(str) {
  const raw = str || '{}';
  try {
    return JSON.parse(raw);
  } catch (err) {
    const truncated = raw.length > 500 ? `${raw.slice(0, 500)}…[${raw.length} chars]` : raw;
    _toolCallStats.parseFailures += 1;
    log.warn(
      { event: 'tool_call_repair', stage: 'parse_failure', raw: truncated, error: err.message },
      'Tool-call arguments were not valid JSON — treating as malformed (repair-eligible), not empty {}',
    );
    const marked = {};
    Object.defineProperty(marked, TOOL_PARSE_ERROR, {
      value: { raw: truncated, error: err.message },
      enumerable: false,
    });
    return marked;
  }
}

/**
 * Minimal required-field presence check against a tool's declared JSON schema.
 * No ajv/zod is in the dependency tree (checked root + autobot-inbox package.json)
 * and P4 (boring deps) forbids adding a heavy one for this, so this is a shallow
 * presence check of input_schema.required. Returns the missing required keys
 * ([] = valid / nothing required).
 */
function missingRequiredFields(input, tool) {
  const required = tool?.input_schema?.required;
  if (!Array.isArray(required) || required.length === 0) return [];
  if (!input || typeof input !== 'object') return [...required];
  return required.filter((k) => input[k] === undefined || input[k] === null);
}

/** A tool input must be a non-null, non-array object — tool schemas declare object inputs. */
function isPlainObjectInput(input) {
  return input != null && typeof input === 'object' && !Array.isArray(input);
}

/**
 * A tool call needs repair if its input failed to parse, is not a plain object
 * (a syntactically valid scalar/array/null is still malformed for an object
 * schema — e.g. `null` or `[]`), OR is missing required fields.
 */
function toolCallNeedsRepair(tc, toolsByName) {
  if (isToolInputError(tc.input)) return true;
  const tool = toolsByName.get(tc.name);
  if (tool && !isPlainObjectInput(tc.input)) return true;
  return missingRequiredFields(tc.input, tool).length > 0;
}

/**
 * FAIL-CLOSED enforcement at the provider boundary (P2 — infrastructure enforces,
 * never the consumer). No downstream consumer checks isToolInputError, so marking
 * a bad tool call is not enough; the marked call must be made UNREACHABLE. This
 * strips every integrity-marked tool call from the response and prunes its
 * reconstructed assistant content. If that empties a `tool_use` response, the
 * stopReason is downgraded to 'tool_validation_failed' so every consumer's
 * `stopReason === 'tool_use'` / `toolCalls?.[0]` guard fails closed — the corrupt
 * action silently never fires (logged, never executed, never reaches guardCheck).
 * Mutates the response in place (always a fresh normalized object we own).
 */
function neutralizeBadToolCalls(response) {
  if (!response?.toolCalls?.length) return response;
  const kept = response.toolCalls.filter((tc) => !isToolInputError(tc.input));
  if (kept.length === response.toolCalls.length) return response; // nothing marked
  const dropped = response.toolCalls.length - kept.length;
  const keptIds = new Set(kept.map((tc) => tc.id));
  response.toolCalls = kept;
  if (Array.isArray(response.raw?.content)) {
    response.raw.content = response.raw.content.filter(
      (b) => b?.type !== 'tool_use' || keptIds.has(b.id),
    );
  }
  if (kept.length === 0 && response.stopReason === 'tool_use') {
    response.stopReason = 'tool_validation_failed';
    if (!response.text) {
      response.text = 'Tool call rejected: arguments remained malformed after one repair attempt.';
    }
  }
  log.error(
    { event: 'tool_call_repair', stage: 'neutralized', dropped, stopReason: response.stopReason },
    'Stripped malformed tool call(s) from response — corrupt input cannot reach guardCheck (fail-closed)',
  );
  return response;
}

/**
 * Validate a normalized response's tool calls and, if any are malformed, run a
 * SINGLE repair retry (re-prompt the model once, never more). Returns the first
 * response untouched — byte-identical — when there are no tools, no tool calls,
 * or every tool call is well-formed (the common case → zero behavior change).
 *
 * Provider-agnostic; primarily hardens the OpenRouter/Ollama paths (Anthropic
 * rarely trips it). After one failed retry the offending call's input is MARKED
 * with TOOL_VALIDATION_ERROR and logged at error level rather than passing
 * corrupt/empty input downstream to guardCheck.
 */
async function repairToolCalls(llm, params, response) {
  const tools = params?.tools;
  if (!tools?.length || !response?.toolCalls?.length) return response;

  // Scope repair to the OpenAI-format parse paths (OpenRouter/Ollama) — the only
  // ones that route tool arguments through safeParseJSON and the cheap-model
  // malformation this layer exists to catch. Anthropic (blocking + streaming)
  // and the claudeCode CLI emit structured tool_use directly and are reliably
  // well-formed; skipping them keeps PR-1 an EXACT no-op on those paths (no
  // spurious extra round-trip on a schema-`required` edge) rather than a
  // near-no-op. PR-2's OSS model swap is what makes this layer load-bearing.
  if (llm.provider !== 'openrouter' && llm.provider !== 'ollama') return response;

  const toolsByName = new Map(tools.map((t) => [t.name, t]));
  _toolCallStats.toolCallsSeen += response.toolCalls.length;

  const bad = response.toolCalls.filter((tc) => toolCallNeedsRepair(tc, toolsByName));
  if (bad.length === 0) return response; // happy path — unchanged

  _toolCallStats.toolCallsMalformed += bad.length; // per-call — matches toolCallsSeen units
  _toolCallStats.repairsTriggered += 1;
  log.warn(
    { event: 'tool_call_repair', stage: 'retry', provider: llm.provider, model: llm.modelId,
      tools: bad.map((tc) => tc.name) },
    `Malformed tool-call input from ${llm.provider} — attempting one repair retry`,
  );

  // Re-prompt once. Clone params (never mutate the caller's array). Insert the
  // failed ASSISTANT turn BEFORE the corrective USER turn so (a) roles alternate
  // — every single-turn caller's message list already ends with a user turn, and
  // a second consecutive user turn is rejected by role-strict providers — and
  // (b) the model has an actual attempt to correct (plain text, so it survives
  // any provider's message-format conversion; the corrective turn names the
  // tools + required fields).
  const guidance = bad.map((tc) => {
    const req = toolsByName.get(tc.name)?.input_schema?.required || [];
    return req.length ? `${tc.name} (required: ${req.join(', ')})` : tc.name;
  }).join('; ');
  const repaired = await dispatchProvider(llm, {
    ...params,
    messages: [
      ...params.messages,
      {
        role: 'assistant',
        content: `[Attempted tool call(s): ${bad.map((tc) => tc.name).join(', ')} — arguments were malformed or incomplete.]`,
      },
      {
        role: 'user',
        content:
          'Your previous tool call arguments were malformed or missing required fields. ' +
          `Re-emit the tool call(s) [${guidance}] with complete, valid JSON arguments that ` +
          'include every required field. Respond only with the corrected tool call.',
      },
    ],
  });

  // The retry response REPLACES the original, but the first (failed) round-trip
  // was still billed by the provider. Callers compute + persist cost directly
  // from these fields (board-query.js, agent-chat.js, computeCost → G1/G10 spend
  // caps), so fold the original usage in — otherwise every repair silently
  // underreports spend by the first attempt's tokens. Mutating `repaired` is safe
  // (it is a fresh normalized object we own).
  if (repaired) {
    repaired.inputTokens = (repaired.inputTokens || 0) + (response.inputTokens || 0);
    repaired.outputTokens = (repaired.outputTokens || 0) + (response.outputTokens || 0);
  }

  // Re-validate the retry with the SAME criteria (parse error, non-object shape,
  // missing required). Anything still broken gets a hard, logged error marker.
  const retryToolCalls = repaired?.toolCalls || [];
  const stillBad = [];
  for (const tc of retryToolCalls) {
    if (toolCallNeedsRepair(tc, toolsByName)) {
      const missing = missingRequiredFields(tc.input, toolsByName.get(tc.name));
      const target = isPlainObjectInput(tc.input) ? tc.input : (tc.input = {});
      Object.defineProperty(target, TOOL_VALIDATION_ERROR, {
        value: { missing, provider: llm.provider },
        enumerable: false,
      });
      stillBad.push(tc.name);
    }
  }

  const repairFailed = stillBad.length > 0 || (retryToolCalls.length === 0 && bad.length > 0);
  if (repairFailed) {
    _toolCallStats.repairsFailed += 1;
    log.error(
      { event: 'tool_call_repair', stage: 'failed', provider: llm.provider, model: llm.modelId,
        tools: stillBad, emittedToolCalls: retryToolCalls.length },
      'Tool-call input still malformed after one repair retry — failing closed rather than passing corrupt input to guardCheck',
    );
    // Retry gave up on tool-calling entirely (0 tool calls): mark the response so
    // no consumer mistakes a failed repair for a successful text completion.
    if (retryToolCalls.length === 0 && repaired && repaired.stopReason !== 'tool_validation_failed') {
      repaired.stopReason = 'tool_validation_failed';
    }
    return neutralizeBadToolCalls(repaired);
  }

  _toolCallStats.repairsSucceeded += 1;
  log.info(
    { event: 'tool_call_repair', stage: 'succeeded', provider: llm.provider, model: llm.modelId },
    'Malformed tool-call input recovered on repair retry',
  );
  return neutralizeBadToolCalls(repaired); // no-op when nothing marked
}
