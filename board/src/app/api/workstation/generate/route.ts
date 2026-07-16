export const config = { api: { bodyParser: { sizeLimit: "50mb" } } };

import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getGitHubToken, getUsername } from "@/lib/auth";
import { getApiKey } from "@/lib/kv";
import { SYSTEM_PROMPT } from "@/lib/prompts";
import { REPO_OWNER, REPO_NAME, isValidFilePath } from "@/lib/github";
import { buildUserContent } from "@/lib/anthropic-content";

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

  const apiKey = await getApiKey(username);
  if (!apiKey) {
    return NextResponse.json(
      { error: "No valid API key found. Add your Anthropic API key in Settings." },
      { status: 400 }
    );
  }

  if (!prompt?.trim()) {
    return NextResponse.json({ error: "Prompt is required" }, { status: 400 });
  }

  // Fetch file contents from GitHub for context
  const fileContents: { path: string; content: string }[] = [];
  if (contextPaths?.length) {
    for (const filePath of contextPaths.slice(0, 10).filter(isValidFilePath)) {
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
        if (res.ok) {
          const text = await res.text();
          fileContents.push({ path: filePath, content: text });
        }
      } catch {
        // Skip files that can't be fetched
      }
    }
  }

  // Build file context with structural separation to prevent prompt injection
  let contextBlock = "";
  if (fileContents.length > 0) {
    contextBlock = fileContents
      .map((f) => `<file path="${f.path}">\n${f.content}\n</file>`)
      .join("\n\n");
  }

  const anthropic = new Anthropic({ apiKey });
  const generateModel = process.env.WORKSTATION_EXPERT_MODEL || "claude-sonnet-4-20250514";

  try {
    const userContent = buildUserContent(prompt, contextBlock, uploadedFiles);

    const message = await anthropic.messages.create({
      model: generateModel,
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: userContent,
        },
      ],
    });

    const text =
      message.content[0].type === "text" ? message.content[0].text : "";

    // Parse the JSON response
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      // If Claude didn't return valid JSON, wrap the text as reasoning
      parsed = {
        reasoning: text,
        commitMessage: "Update files per board direction",
        files: [],
      };
    }

    return NextResponse.json({
      reasoning: parsed.reasoning || "",
      commitMessage: parsed.commitMessage || "",
      files: parsed.files || [],
      username,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Anthropic API error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
