import { NextRequest, NextResponse } from "next/server";
import { getGitHubToken } from "@/lib/auth";
import { REPO_OWNER, REPO_NAME, isValidFilePath } from "@/lib/github";

const MAX_FILE_SIZE = 500 * 1024; // 500KB

export async function GET(req: NextRequest) {
  const ghToken = await getGitHubToken(req);
  if (!ghToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const filePath = req.nextUrl.searchParams.get("path");
  if (!filePath || !isValidFilePath(filePath)) {
    return NextResponse.json({ error: "Invalid file path" }, { status: 400 });
  }

  try {
    const res = await fetch(
      `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${filePath}`,
      {
        headers: {
          Authorization: `Bearer ${ghToken}`,
          Accept: "application/vnd.github.v3+json",
        },
      }
    );

    if (!res.ok) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    const meta = await res.json();

    if (meta.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        { error: `File too large (${Math.round(meta.size / 1024)}KB, max 500KB)` },
        { status: 413 }
      );
    }

    // Decode base64 content from the metadata response (avoids a second API call)
    const content = Buffer.from(meta.content, "base64").toString("utf-8");

    return NextResponse.json({
      path: filePath,
      content,
      size: meta.size,
    });
  } catch {
    return NextResponse.json({ error: "GitHub API error" }, { status: 502 });
  }
}
