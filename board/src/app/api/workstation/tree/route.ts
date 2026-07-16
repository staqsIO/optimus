import { NextRequest, NextResponse } from "next/server";
import { getGitHubToken } from "@/lib/auth";
import { REPO_OWNER, REPO_NAME, BASE_BRANCH } from "@/lib/github";

const FILTERED_PREFIXES = [".git/", ".github/", "node_modules/", ".next/", ".env"];

interface GitHubTreeItem {
  path: string;
  mode: string;
  type: "blob" | "tree";
  sha: string;
  size?: number;
}

function shouldFilter(path: string): boolean {
  return FILTERED_PREFIXES.some(
    (prefix) => path.startsWith(prefix) || path.includes(`/${prefix}`)
  );
}

import type { TreeNode } from "@/components/workstation/types";

function buildTree(items: GitHubTreeItem[]): TreeNode[] {
  const root: TreeNode[] = [];
  const dirs = new Map<string, TreeNode>();

  for (const item of items) {
    if (shouldFilter(item.path)) continue;

    const parts = item.path.split("/");
    const name = parts[parts.length - 1];

    const node: TreeNode = {
      name,
      path: item.path,
      type: item.type === "tree" ? "directory" : "file",
    };

    if (node.type === "directory") {
      node.children = [];
      dirs.set(item.path, node);
    }

    if (parts.length === 1) {
      root.push(node);
    } else {
      const parentPath = parts.slice(0, -1).join("/");
      const parent = dirs.get(parentPath);
      if (parent?.children) {
        parent.children.push(node);
      }
    }
  }

  return root;
}

export async function GET(req: NextRequest) {
  const ghToken = await getGitHubToken(req);
  if (!ghToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const refRes = await fetch(
      `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/git/ref/heads/${BASE_BRANCH}`,
      { headers: { Authorization: `Bearer ${ghToken}` } }
    );

    if (!refRes.ok) {
      return NextResponse.json({ error: "Failed to fetch branch" }, { status: 502 });
    }

    const refData = await refRes.json();
    const sha = refData.object?.sha;
    if (!sha) {
      return NextResponse.json({ error: "Could not resolve branch SHA" }, { status: 502 });
    }

    const treeRes = await fetch(
      `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/git/trees/${sha}?recursive=1`,
      { headers: { Authorization: `Bearer ${ghToken}` } }
    );

    if (!treeRes.ok) {
      return NextResponse.json({ error: "Failed to fetch tree" }, { status: 502 });
    }

    const treeData = await treeRes.json();
    const tree = buildTree(treeData.tree);

    return NextResponse.json({
      tree,
      truncated: treeData.truncated || false,
    });
  } catch {
    return NextResponse.json({ error: "GitHub API error" }, { status: 502 });
  }
}
