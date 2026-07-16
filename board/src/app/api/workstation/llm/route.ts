import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getUsername } from "@/lib/auth";
import { getApiKey } from "@/lib/kv";
import { callLLM, isOpenRouterEnabled } from "@/lib/llm-client";
import { getOpsAuthHeaders } from "@/lib/ops-proxy";

const API_URL = process.env.OPS_API_URL || "http://localhost:3001";
const LLM_TIMEOUT_MS = 60_000;

/**
 * POST /api/workstation/llm — Multi-provider LLM proxy
 *
 * Resolution order:
 * 1. OpenRouter configured (OPENROUTER_API_KEY) → call via OpenAI SDK
 * 2. User has personal API key + Claude model → call Anthropic directly
 * 3. ANTHROPIC_API_KEY env var + Claude model → call Anthropic directly
 * 4. Backend is configured → proxy to POST /api/workstation/llm on autobot-inbox
 *
 * Body: { model, system, messages, maxTokens, temperature }
 * Returns: { text, inputTokens, outputTokens, costUsd, model, stopReason }
 */
export async function POST(req: NextRequest) {
  const username = await getUsername(req);
  if (!username) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    model: string;
    system?: string;
    messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }>;
    maxTokens?: number;
    temperature?: number;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { model, system, messages, maxTokens, temperature } = body;
  if (!model || !messages?.length) {
    return NextResponse.json(
      { error: "model and messages are required" },
      { status: 400 }
    );
  }

  // Normalize messages to string content for the unified client
  const stringMessages = messages.map(m => ({
    role: m.role as "user" | "assistant",
    content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
  }));

  // --- Path 1: OpenRouter configured → handles all model providers ---
  if (isOpenRouterEnabled()) {
    try {
      const result = await callLLM(null, {
        model,
        system: system || "",
        messages: stringMessages,
        maxTokens: maxTokens || 4096,
        temperature: temperature ?? 0.3,
      });
      return NextResponse.json({
        text: result.text,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costUsd: 0,
        model: result.model,
        source: "openrouter",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "OpenRouter error";
      return NextResponse.json({ error: message }, { status: 502 });
    }
  }

  // --- Path 2: Personal API key or env var → call Anthropic directly ---
  let apiKey: string | null = null;
  try {
    apiKey = await getApiKey(username);
  } catch {
    // Redis may be down — try env var
  }
  // Fall back to env var
  if (!apiKey) {
    apiKey = process.env.ANTHROPIC_API_KEY || null;
  }

  if (apiKey && model.startsWith("claude-")) {
    try {
      const anthropic = new Anthropic({ apiKey });
      const response = await anthropic.messages.create({
        model,
        max_tokens: maxTokens || 4096,
        temperature: temperature ?? 0.3,
        system: system || undefined,
        messages: messages as Anthropic.MessageParam[],
      });

      const text =
        response.content[0]?.type === "text" ? response.content[0].text : "";

      return NextResponse.json({
        text,
        inputTokens: response.usage?.input_tokens || 0,
        outputTokens: response.usage?.output_tokens || 0,
        costUsd: 0,
        model,
        stopReason: response.stop_reason,
        source: apiKey === process.env.ANTHROPIC_API_KEY ? "env-key" : "personal-key",
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Anthropic API error";
      return NextResponse.json({ error: message }, { status: 502 });
    }
  }

  // --- Path 3: Proxy to backend (last resort) ---
  const opsHeaders = await getOpsAuthHeaders(req);
  if (!opsHeaders) {
    return NextResponse.json(
      {
        error: "No LLM provider configured and no valid session to proxy to backend.",
      },
      { status: 400 }
    );
  }

  try {
    const res = await fetch(`${API_URL}/api/workstation/llm`, {
      method: "POST",
      headers: opsHeaders,
      body: JSON.stringify({ model, system, messages, maxTokens, temperature }),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Backend LLM error" }));
      return NextResponse.json(err, { status: res.status });
    }

    const data = await res.json();
    return NextResponse.json({ ...data, source: "backend" });
  } catch {
    return NextResponse.json(
      { error: "Backend unreachable for LLM proxy" },
      { status: 502 }
    );
  }
}
