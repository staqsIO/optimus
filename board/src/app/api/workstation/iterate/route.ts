import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getGitHubToken, getUsername } from "@/lib/auth";
import { getApiKey } from "@/lib/kv";
import { SYSTEM_PROMPT } from "@/lib/prompts";

export async function POST(req: NextRequest) {
  const ghToken = await getGitHubToken(req);
  const username = await getUsername(req);
  if (!ghToken || !username) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    prompt: string;
    originalPrompt: string;
    previousResponse: {
      reasoning: string;
      commitMessage: string;
      files: { path: string; content: string; action: string }[];
    };
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { prompt, originalPrompt, previousResponse } = body;

  const apiKey = await getApiKey(username);
  if (!apiKey) {
    return NextResponse.json(
      { error: "No valid API key found. Add your Anthropic API key in Settings." },
      { status: 400 }
    );
  }

  if (!prompt?.trim()) {
    return NextResponse.json({ error: "Iteration prompt is required" }, { status: 400 });
  }

  if (!previousResponse?.files || !Array.isArray(previousResponse.files)) {
    return NextResponse.json({ error: "Previous response with files is required" }, { status: 400 });
  }

  const previousFilesBlock = previousResponse.files
    .map((f) => `--- ${f.path} (${f.action}) ---\n${f.content}`)
    .join("\n\n");

  const anthropic = new Anthropic({ apiKey });

  try {
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: originalPrompt || "Make the requested changes.",
        },
        {
          role: "assistant",
          content: JSON.stringify(previousResponse),
        },
        {
          role: "user",
          content: `Please revise your previous changes based on this feedback:\n\n${prompt}\n\n<file-context>\n${previousFilesBlock}\n</file-context>\n\nReturn the updated JSON response with the same structure.`,
        },
      ],
    });

    const text =
      message.content[0].type === "text" ? message.content[0].text : "";

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = {
        reasoning: text,
        commitMessage: previousResponse.commitMessage,
        files: previousResponse.files,
      };
    }

    return NextResponse.json({
      reasoning: parsed.reasoning || "",
      commitMessage: parsed.commitMessage || "",
      files: parsed.files || [],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Anthropic API error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
