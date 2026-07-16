import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getGitHubToken, getUsername } from "@/lib/auth";
import { getApiKey } from "@/lib/kv";
import { REPO_OWNER, REPO_NAME, isValidFilePath } from "@/lib/github";

const PROJECTION_SYSTEM_PROMPT = `You are a spec editor for the Optimus project. Given a current spec section and a proposal document, produce the PROJECTED version of that spec section — what it would look like if the proposal were accepted and incorporated.

Rules:
- Output ONLY the projected markdown content (no heading, no explanation, no preamble)
- Preserve the section's existing structure and formatting style
- Integrate the proposal's changes naturally into the existing text
- If the proposal doesn't affect this section, return the original content unchanged
- Keep the same markdown heading levels, list styles, and table formats
- Do not add commentary like "Here is the projected version" — just output the content`;

async function fetchFileContent(
  ghToken: string,
  filePath: string
): Promise<string | null> {
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
    return await res.text();
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  const ghToken = await getGitHubToken(req);
  const username = await getUsername(req);
  if (!ghToken || !username) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    sectionId: string;
    sectionHeading: string;
    sectionContent: string;
    agendaItemTitle: string;
    agendaItemSummary: string;
    sourceFile: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { sectionId, sectionHeading, sectionContent, agendaItemTitle, agendaItemSummary, sourceFile } = body;

  if (!sectionId || !sectionContent) {
    return NextResponse.json({ error: "sectionId and sectionContent are required" }, { status: 400 });
  }

  const apiKey = await getApiKey(username);
  if (!apiKey) {
    return NextResponse.json(
      { error: "No valid API key found. Add your Anthropic API key in Settings." },
      { status: 400 }
    );
  }

  // Fetch the source document for context
  let sourceContent = "";
  if (sourceFile && isValidFilePath(sourceFile)) {
    const content = await fetchFileContent(ghToken, sourceFile);
    if (content) sourceContent = content;
  }

  const anthropic = new Anthropic({ apiKey });

  try {
    const userPrompt = [
      `## Current spec section: §${sectionId} ${sectionHeading}`,
      "",
      "```markdown",
      sectionContent,
      "```",
      "",
      `## Proposal: "${agendaItemTitle}"`,
      "",
      agendaItemSummary,
      sourceContent ? `\n## Source document\n\n${sourceContent}` : "",
      "",
      "Produce the projected version of the spec section above, incorporating the proposal's changes.",
    ].join("\n");

    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: PROJECTION_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    });

    const projectedContent =
      message.content[0].type === "text" ? message.content[0].text : "";

    return NextResponse.json({ projectedContent, sectionId });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Anthropic API error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
