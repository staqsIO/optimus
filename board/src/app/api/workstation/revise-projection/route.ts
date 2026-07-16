import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getGitHubToken, getUsername } from "@/lib/auth";
import { getApiKey } from "@/lib/kv";

const REVISION_SYSTEM_PROMPT = `You are a spec editor for the Optimus project. You previously produced a projected version of a spec section. The board has reviewed it and provided feedback requesting changes.

Produce a REVISED version of the projected content that addresses the board's feedback.

Rules:
- Output ONLY the revised markdown content (no heading, no explanation, no preamble)
- Preserve the section's existing structure and formatting style
- Address ALL points raised in the feedback
- Keep the same markdown heading levels, list styles, and table formats
- Do not add commentary like "Here is the revised version" — just output the content`;

export async function POST(req: NextRequest) {
  const ghToken = await getGitHubToken(req);
  const username = await getUsername(req);
  if (!ghToken || !username) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    sectionId: string;
    sectionHeading: string;
    originalContent: string;
    projectedContent: string;
    feedback: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { sectionId, sectionHeading, originalContent, projectedContent, feedback } = body;

  if (!sectionId || !projectedContent || !feedback) {
    return NextResponse.json(
      { error: "sectionId, projectedContent, and feedback are required" },
      { status: 400 }
    );
  }

  const apiKey = await getApiKey(username);
  if (!apiKey) {
    return NextResponse.json(
      { error: "No valid API key found. Add your Anthropic API key in Settings." },
      { status: 400 }
    );
  }

  const anthropic = new Anthropic({ apiKey });

  try {
    const userPrompt = [
      `## Original spec section: §${sectionId} ${sectionHeading}`,
      "",
      "```markdown",
      originalContent,
      "```",
      "",
      "## Previously projected version",
      "",
      "```markdown",
      projectedContent,
      "```",
      "",
      "## Board feedback",
      "",
      feedback,
      "",
      "Produce a revised version that addresses the board's feedback while preserving the original section's structure.",
    ].join("\n");

    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: REVISION_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    });

    const revisedContent =
      message.content[0].type === "text" ? message.content[0].text : "";

    if (!revisedContent) {
      return NextResponse.json({ error: "Model returned empty revision" }, { status: 502 });
    }

    return NextResponse.json({ projectedContent: revisedContent, sectionId });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Anthropic API error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
