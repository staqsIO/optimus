import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

/**
 * Unified LLM client for the Board Workstation.
 *
 * When OPENROUTER_API_KEY is set, uses OpenAI SDK against OpenRouter
 * with cheaper models (DeepSeek, Gemini Flash). Falls back to Anthropic
 * SDK with the user's API key or ANTHROPIC_API_KEY env var.
 *
 * Both SDKs support messages.create() but with different response shapes.
 * This module normalizes the interface.
 */

interface LLMResponse {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

interface LLMCallOptions {
  model: string;
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  maxTokens: number;
  temperature?: number;
}

const openRouterKey = process.env.OPENROUTER_API_KEY;

export function isOpenRouterEnabled(): boolean {
  return !!openRouterKey;
}

export function getDefaultModels(): { router: string; expert: string } {
  if (openRouterKey) {
    return {
      router: process.env.WORKSTATION_ROUTER_MODEL || "deepseek/deepseek-chat-v3-0324",
      expert: process.env.WORKSTATION_EXPERT_MODEL || "google/gemini-2.5-flash",
    };
  }
  return {
    router: process.env.WORKSTATION_ROUTER_MODEL || "claude-haiku-4-5-20251001",
    expert: process.env.WORKSTATION_EXPERT_MODEL || "claude-sonnet-4-20250514",
  };
}

/** Call LLM via OpenRouter (OpenAI SDK) */
async function callOpenRouter(opts: LLMCallOptions): Promise<LLMResponse> {
  const client = new OpenAI({
    apiKey: openRouterKey,
    baseURL: "https://openrouter.ai/api/v1",
  });

  const response = await client.chat.completions.create({
    model: opts.model,
    max_tokens: opts.maxTokens,
    temperature: opts.temperature ?? 0.7,
    messages: [
      { role: "system", content: opts.system },
      ...opts.messages,
    ],
  });

  const choice = response.choices[0];
  return {
    text: choice?.message?.content || "",
    model: response.model || opts.model,
    inputTokens: response.usage?.prompt_tokens || 0,
    outputTokens: response.usage?.completion_tokens || 0,
  };
}

/** Call LLM via Anthropic SDK */
async function callAnthropic(apiKey: string, opts: LLMCallOptions): Promise<LLMResponse> {
  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model: opts.model,
    max_tokens: opts.maxTokens,
    system: opts.system,
    messages: opts.messages.map(m => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
  });

  const textBlock = response.content.find(b => b.type === "text");
  return {
    text: textBlock?.text || "",
    model: response.model,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}

/**
 * Call LLM with automatic provider selection.
 * OpenRouter (if OPENROUTER_API_KEY set) → Anthropic (apiKey param) → error
 */
export async function callLLM(apiKey: string | null, opts: LLMCallOptions): Promise<LLMResponse> {
  if (openRouterKey) {
    return callOpenRouter(opts);
  }
  if (apiKey) {
    return callAnthropic(apiKey, opts);
  }
  throw new Error("No LLM provider configured. Set OPENROUTER_API_KEY or ANTHROPIC_API_KEY.");
}
