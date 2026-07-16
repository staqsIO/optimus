export const config = { api: { bodyParser: { sizeLimit: "50mb" } } };

import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getGitHubToken, getUsername } from "@/lib/auth";
import { getApiKey } from "@/lib/kv";
import { QA_SYSTEM_PROMPT } from "@/lib/prompts";
import { REPO_OWNER, REPO_NAME, isValidFilePath } from "@/lib/github";
import { EXPERTS, DOCUMENT_INDEX, ROUTER_PROMPT } from "@/lib/experts";
import { buildUserContent } from "@/lib/anthropic-content";
import { getOpsAuthHeaders } from "@/lib/ops-proxy";

const OPS_API_URL = process.env.OPS_API_URL || "http://localhost:3001";
const LLM_TIMEOUT_MS = 60_000;

type OpsHeaders = Record<string, string> | null;

interface WorkstationConfig {
  routerModel: string;
  expertModel: string;
  maxTokens: number;
}

/** Fetch workstation config from the backend, with sensible defaults */
async function getWorkstationConfig(
  opsHeaders: OpsHeaders
): Promise<WorkstationConfig> {
  const defaults: WorkstationConfig = {
    routerModel: "claude-haiku-4-5-20251001",
    expertModel: "claude-sonnet-4-6",
    maxTokens: 4096,
  };
  if (!opsHeaders) return defaults;
  try {
    const res = await fetch(`${OPS_API_URL}/api/agents/config`, {
      headers: opsHeaders,
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return defaults;
    const data = await res.json();
    return { ...defaults, ...data.workstation };
  } catch {
    return defaults;
  }
}

/**
 * Call LLM via the backend proxy (supports all providers in agents.json).
 * Returns null if backend is unavailable, so caller can fall back to direct SDK.
 */
async function callLLMProxy(
  opsHeaders: OpsHeaders,
  params: {
    model: string;
    system: string;
    messages: Array<{
      role: string;
      content: string | Array<Record<string, unknown>>;
    }>;
    maxTokens: number;
    temperature?: number;
  }
): Promise<{ text: string } | null> {
  if (!opsHeaders) return null;
  try {
    const res = await fetch(`${OPS_API_URL}/api/workstation/llm`, {
      method: "POST",
      headers: opsHeaders,
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

async function fetchFileContent(
  ghToken: string,
  filePath: string
): Promise<{ path: string; content: string } | null> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${filePath}`,
      {
        headers: {
          Authorization: `Bearer ${ghToken}`,
          Accept: "application/vnd.github.v3.raw",
        },
      }
    );
    if (!res.ok) return null;
    const text = await res.text();
    return { path: filePath, content: text };
  } catch {
    return null;
  }
}

interface CommandInfo {
  title: string;
  description: string;
  assignTo: string;
  priority: number;
  jamie?: boolean;
}

interface RouterResponse {
  intent: "question" | "command";
  expert: string;
  files: string[];
  reasoning: string;
  command?: CommandInfo;
}

async function routeMessage(
  opsHeaders: OpsHeaders,
  anthropic: Anthropic | null,
  message: string,
  routerModel: string
): Promise<RouterResponse> {
  const indexText = DOCUMENT_INDEX.map(
    (d) => `- ${d.path}: ${d.description}`
  ).join("\n");

  const userContent = `Document index:\n${indexText}\n\nMessage: ${message}`;

  // Try backend proxy first (supports any model), fall back to direct SDK
  let text = "";
  const proxyResult = await callLLMProxy(opsHeaders, {
    model: routerModel,
    system: ROUTER_PROMPT,
    messages: [{ role: "user", content: userContent }],
    maxTokens: 512,
    temperature: 0.1,
  });

  if (proxyResult) {
    text = proxyResult.text;
  } else if (anthropic) {
    const response = await anthropic.messages.create({
      model: routerModel,
      max_tokens: 512,
      system: ROUTER_PROMPT,
      messages: [{ role: "user", content: userContent }],
    });
    text = response.content[0].type === "text" ? response.content[0].text : "";
  } else {
    // No proxy and no personal key — can't route
    return {
      intent: "question",
      expert: "operations",
      files: EXPERTS.operations.defaultFiles,
      reasoning: "No LLM available for routing — defaulting to operations",
    };
  }

  try {
    const parsed = JSON.parse(text);
    return {
      intent: parsed.intent === "command" ? "command" : "question",
      expert: parsed.expert || "operations",
      files: Array.isArray(parsed.files) ? parsed.files.slice(0, 8) : [],
      reasoning: parsed.reasoning || "",
      command: parsed.command ? { ...parsed.command, jamie: !!parsed.command.jamie } : undefined,
    };
  } catch {
    return {
      intent: "question",
      expert: "operations",
      files: EXPERTS.operations.defaultFiles,
      reasoning: "Router parse failed — falling back to operations",
    };
  }
}

async function executeCommand(
  opsHeaders: OpsHeaders,
  command: CommandInfo
): Promise<{
  ok: boolean;
  workItem?: Record<string, unknown>;
  error?: string;
}> {
  if (!opsHeaders) {
    return { ok: false, error: "No valid session — cannot reach backend" };
  }

  try {
    const res = await fetch(`${OPS_API_URL}/api/governance/command`, {
      method: "POST",
      headers: opsHeaders,
      body: JSON.stringify({
        title: command.title,
        description: command.description,
        assignTo: command.assignTo,
        priority: command.priority,
        jamie: command.jamie || false,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      return { ok: false, error: `Backend returned ${res.status}: ${text}` };
    }

    const data = await res.json();
    return { ok: true, workItem: data.workItem };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to reach backend" };
  }
}

export async function POST(req: NextRequest) {
  const ghToken = await getGitHubToken(req);
  const username = await getUsername(req);
  if (!ghToken || !username) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { prompt: string; contextPaths?: string[]; uploadedFiles?: { name: string; mimeType: string; base64: string }[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { prompt, contextPaths, uploadedFiles } = body;

  // Server-side file upload validation (0C security fix)
  const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
  const ALLOWED_MIME_TYPES = new Set([
    'image/png', 'image/jpeg', 'image/gif', 'image/webp',
    'application/pdf',
    'text/plain', 'text/csv', 'text/markdown',
    'application/json',
  ]);

  const validatedFiles = uploadedFiles?.map((file: { name: string; mimeType: string; base64: string }, i: number) => {
    // Validate MIME type
    if (!ALLOWED_MIME_TYPES.has(file.mimeType)) {
      return null; // silently drop unsupported types
    }
    // Validate base64 decoded size
    const estimatedSize = Math.ceil((file.base64?.length || 0) * 0.75);
    if (estimatedSize > MAX_FILE_SIZE_BYTES) {
      return null; // silently drop oversized files
    }
    // Strip filename from LLM context — use generic label
    return {
      name: `attachment_${i + 1}`,
      mimeType: file.mimeType,
      base64: file.base64,
    };
  }).filter((f): f is { name: string; mimeType: string; base64: string } => f !== null);

  let apiKey: string | null = null;
  try {
    apiKey = await getApiKey(username);
  } catch {
    // Redis may be down — fall through, backend proxy may still work
  }

  // Per-user JWT for backend proxy fallback. May be null if there's no live
  // session (we've already verified one above via getUsername, but the JWT
  // mint is allowed to fail without crashing — direct SDK still works).
  const opsHeaders = await getOpsAuthHeaders(req);

  // Need at least one LLM path available
  if (!apiKey && !opsHeaders) {
    return NextResponse.json(
      { error: "No API key configured and backend not connected. Add an Anthropic API key in Settings or ensure the backend is running." },
      { status: 400 }
    );
  }

  if (!prompt?.trim()) {
    return NextResponse.json({ error: "Question is required" }, { status: 400 });
  }

  const anthropic = apiKey ? new Anthropic({ apiKey }) : null;
  const wsConfig = await getWorkstationConfig(opsHeaders);
  // Model overrides via env vars (use cheaper models without changing code)
  if (process.env.WORKSTATION_ROUTER_MODEL) wsConfig.routerModel = process.env.WORKSTATION_ROUTER_MODEL;
  if (process.env.WORKSTATION_EXPERT_MODEL) wsConfig.expertModel = process.env.WORKSTATION_EXPERT_MODEL;
  const hasManualContext = contextPaths && contextPaths.length > 0;

  // --- Manual mode: user provided context files (backward compatible) ---
  if (hasManualContext) {
    const fileContents: { path: string; content: string }[] = [];
    for (const filePath of contextPaths.slice(0, 10).filter(isValidFilePath)) {
      const result = await fetchFileContent(ghToken, filePath);
      if (result) fileContents.push(result);
    }

    let contextBlock = "";
    if (fileContents.length > 0) {
      contextBlock = fileContents
        .map((f) => `<file path="${f.path}">\n${f.content}\n</file>`)
        .join("\n\n");
    }

    try {
      const userContent = buildUserContent(prompt, contextBlock, validatedFiles);
      const messages = [{ role: "user" as const, content: userContent }];

      // Try backend proxy first, fall back to direct SDK
      const proxyResult = await callLLMProxy(opsHeaders, {
        model: wsConfig.expertModel,
        system: QA_SYSTEM_PROMPT,
        messages,
        maxTokens: wsConfig.maxTokens,
      });

      let answer: string;
      if (proxyResult) {
        answer = proxyResult.text;
      } else if (anthropic) {
        const message = await anthropic.messages.create({
          model: wsConfig.expertModel,
          max_tokens: wsConfig.maxTokens,
          system: QA_SYSTEM_PROMPT,
          messages,
        });
        answer = message.content[0].type === "text" ? message.content[0].text : "";
      } else {
        return NextResponse.json({ error: "No LLM provider available" }, { status: 502 });
      }

      return NextResponse.json({ answer });
    } catch (err) {
      const message = err instanceof Error ? err.message : "LLM API error";
      return NextResponse.json({ error: message }, { status: 502 });
    }
  }

  // --- Automatic mode: two-step router → expert (or command dispatch) ---
  try {
    // Step 1: Route the message — detect intent
    const route = await routeMessage(
      opsHeaders,
      anthropic,
      prompt,
      wsConfig.routerModel
    );

    // Step 1b: If command, dispatch to backend and confirm
    if (route.intent === "command" && route.command) {
      const result = await executeCommand(opsHeaders, route.command);
      if (!result.ok) {
        return NextResponse.json({
          answer: `I tried to create that task but hit an error: ${result.error}`,
          expert: "operations",
          expertName: "Operations & Pipeline",
        });
      }

      const workItem = result.workItem as Record<string, string>;
      const isJamie = route.command.jamie && route.command.assignTo === "executor-coder";
      const agentLabel = isJamie ? "executor-coder (Jamie on M1)" : route.command.assignTo;
      const linearUrl = workItem?.linear_issue_url;

      let answer = `Done. I've created a task assigned to **${agentLabel}**:\n\n> **${route.command.title}**\n> ${route.command.description || ""}`;
      if (linearUrl) {
        const linearId = workItem?.linear_issue_identifier || "issue";
        answer += `\n\n[Linear: ${linearId}](${linearUrl}) · Task is in the pipeline.`;
      } else {
        answer += `\n\nThe task is now in the pipeline and will appear in the governance feed.`;
      }
      answer += ` Priority: ${route.command.priority || 2}/5.`;

      return NextResponse.json({
        answer,
        expert: "operations",
        expertName: "Operations & Pipeline",
        action: {
          type: "command_dispatched",
          workItemId: workItem?.id,
          assignedTo: route.command.assignTo,
          title: route.command.title,
          linearUrl: linearUrl || undefined,
        },
      });
    }

    // Look up the expert profile
    const expert = EXPERTS[route.expert] || EXPERTS.operations;

    // Merge routed files with expert default files, deduplicate
    const allPaths = [...new Set([...route.files, ...expert.defaultFiles])];

    // Step 2: Fetch files in parallel
    const fetchResults = await Promise.all(
      allPaths.filter(isValidFilePath).slice(0, 10).map((p) => fetchFileContent(ghToken, p))
    );
    const fileContents = fetchResults.filter(
      (r): r is { path: string; content: string } => r !== null
    );

    // Build context block
    let contextBlock = "";
    if (fileContents.length > 0) {
      contextBlock = fileContents
        .map((f) => `<file path="${f.path}">\n${f.content}\n</file>`)
        .join("\n\n");
    }

    const userContent = buildUserContent(prompt, contextBlock, validatedFiles);
    const expertMessages = [{ role: "user" as const, content: userContent }];

    // Step 2: Expert call with domain-specific system prompt
    // Try backend proxy first (supports OpenRouter models), fall back to direct SDK
    let answer: string;
    const expertProxy = await callLLMProxy(opsHeaders, {
      model: wsConfig.expertModel,
      system: expert.systemPrompt,
      messages: expertMessages,
      maxTokens: wsConfig.maxTokens,
    });

    if (expertProxy) {
      answer = expertProxy.text;
    } else if (anthropic) {
      const message = await anthropic.messages.create({
        model: wsConfig.expertModel,
        max_tokens: wsConfig.maxTokens,
        system: expert.systemPrompt,
        messages: expertMessages,
      });
      answer = message.content[0].type === "text" ? message.content[0].text : "";
    } else {
      return NextResponse.json({ error: "No LLM provider available" }, { status: 502 });
    }

    return NextResponse.json({
      answer,
      expert: expert.id,
      expertName: expert.name,
      filesUsed: fileContents.map((f) => f.path),
      reasoning: route.reasoning,
      model: wsConfig.expertModel,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "LLM API error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
