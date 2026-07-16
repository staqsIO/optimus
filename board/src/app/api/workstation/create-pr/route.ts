import { NextRequest, NextResponse } from "next/server";
import { getGitHubToken, getUsername } from "@/lib/auth";
import { REPO_OWNER, REPO_NAME, BASE_BRANCH, isValidFilePath } from "@/lib/github";

async function ghApi(
  path: string,
  token: string,
  options: RequestInit = {}
): Promise<Response> {
  return fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
}

export async function POST(req: NextRequest) {
  const ghToken = await getGitHubToken(req);
  const username = await getUsername(req);
  if (!ghToken || !username) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { files, commitMessage, prompt, reasoning } = (await req.json()) as {
    files: { path: string; content: string; action: string }[];
    commitMessage: string;
    prompt: string;
    reasoning: string;
  };

  if (!files?.length || !commitMessage) {
    return NextResponse.json(
      { error: "Files and commit message are required" },
      { status: 400 }
    );
  }

  // Validate all file paths before proceeding
  const invalidPaths = files.filter((f) => !isValidFilePath(f.path));
  if (invalidPaths.length > 0) {
    return NextResponse.json(
      { error: `Invalid file paths: ${invalidPaths.map((f) => f.path).join(", ")}` },
      { status: 400 }
    );
  }

  try {
    // 1. Get the SHA of the base branch
    const refRes = await ghApi(
      `/repos/${REPO_OWNER}/${REPO_NAME}/git/ref/heads/${BASE_BRANCH}`,
      ghToken
    );
    if (!refRes.ok) {
      return NextResponse.json({ error: "Could not read base branch" }, { status: 502 });
    }
    const refData = await refRes.json();
    const baseSha = refData.object.sha;

    // 2. Get the base commit to find its tree SHA
    const baseCommitRes = await ghApi(
      `/repos/${REPO_OWNER}/${REPO_NAME}/git/commits/${baseSha}`,
      ghToken
    );
    if (!baseCommitRes.ok) {
      return NextResponse.json({ error: "Could not read base commit" }, { status: 502 });
    }
    const baseCommit = await baseCommitRes.json();
    const baseTreeSha = baseCommit.tree.sha;

    // 3. Create blobs for each file
    const treeEntries = [];
    for (const file of files) {
      const blobRes = await ghApi(
        `/repos/${REPO_OWNER}/${REPO_NAME}/git/blobs`,
        ghToken,
        {
          method: "POST",
          body: JSON.stringify({
            content: file.content,
            encoding: "utf-8",
          }),
        }
      );
      if (!blobRes.ok) {
        const err = await blobRes.text();
        return NextResponse.json(
          { error: `Failed to create blob for ${file.path}: ${err}` },
          { status: 502 }
        );
      }
      const blobData = await blobRes.json();
      treeEntries.push({
        path: file.path,
        mode: "100644" as const,
        type: "blob" as const,
        sha: blobData.sha,
      });
    }

    // 4. Create a new tree with the changes
    const treeRes = await ghApi(
      `/repos/${REPO_OWNER}/${REPO_NAME}/git/trees`,
      ghToken,
      {
        method: "POST",
        body: JSON.stringify({
          base_tree: baseTreeSha,
          tree: treeEntries,
        }),
      }
    );
    if (!treeRes.ok) {
      const err = await treeRes.text();
      return NextResponse.json({ error: `Failed to create tree: ${err}` }, { status: 502 });
    }
    const treeData = await treeRes.json();

    // 5. Create the commit
    const commitRes = await ghApi(
      `/repos/${REPO_OWNER}/${REPO_NAME}/git/commits`,
      ghToken,
      {
        method: "POST",
        body: JSON.stringify({
          message: commitMessage,
          tree: treeData.sha,
          parents: [baseSha],
        }),
      }
    );
    if (!commitRes.ok) {
      const err = await commitRes.text();
      return NextResponse.json({ error: `Failed to create commit: ${err}` }, { status: 502 });
    }
    const commitData = await commitRes.json();

    // 6. Create the branch pointing at the new commit
    const slug = commitMessage
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 40)
      .replace(/-$/, "");
    const timestamp = Date.now();
    const branchName = `board/${username}-${timestamp}-${slug}`;

    const createBranchRes = await ghApi(
      `/repos/${REPO_OWNER}/${REPO_NAME}/git/refs`,
      ghToken,
      {
        method: "POST",
        body: JSON.stringify({
          ref: `refs/heads/${branchName}`,
          sha: commitData.sha,
        }),
      }
    );
    if (!createBranchRes.ok) {
      const err = await createBranchRes.text();
      return NextResponse.json({ error: `Failed to create branch: ${err}` }, { status: 502 });
    }

    // 7. Build PR body
    const fileList = files
      .map((f) => `- \`${f.path}\` (${f.action})`)
      .join("\n");

    const prBody = `## Board-Directed Change

**Directed by:** @${username} (board member)
**Tool:** Optimus Board Workstation

### Prompt
${prompt}

### Claude's Approach
${reasoning}

### Files Changed
${fileList}`;

    // 8. Create PR
    const prRes = await ghApi(
      `/repos/${REPO_OWNER}/${REPO_NAME}/pulls`,
      ghToken,
      {
        method: "POST",
        body: JSON.stringify({
          title: commitMessage,
          head: branchName,
          base: BASE_BRANCH,
          body: prBody,
        }),
      }
    );
    if (!prRes.ok) {
      const err = await prRes.text();
      return NextResponse.json({ error: `Failed to create PR: ${err}` }, { status: 502 });
    }
    const prData = await prRes.json();

    // 9. Apply 'board-decision' label (best-effort)
    await ghApi(
      `/repos/${REPO_OWNER}/${REPO_NAME}/issues/${prData.number}/labels`,
      ghToken,
      {
        method: "POST",
        body: JSON.stringify({ labels: ["board-decision"] }),
      }
    ).catch(() => {});

    return NextResponse.json({
      prUrl: prData.html_url,
      prNumber: prData.number,
      branchName,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "GitHub API error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
