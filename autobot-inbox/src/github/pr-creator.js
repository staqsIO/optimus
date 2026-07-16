/**
 * GitHub PR creator via Git Trees API.
 * Extracted from dashboard/src/app/api/workstation/create-pr/route.ts.
 * Same blob→tree→commit→branch→PR flow, plain ESM.
 *
 * Auth: GitHub App installation token (preferred) or GITHUB_TOKEN PAT (fallback).
 */

import { getGitHubToken } from './app-auth.js';

const GITHUB_API = 'https://api.github.com';

async function getHeaders(tokenOverride) {
  const token = tokenOverride || await getGitHubToken();
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
  };
}

async function ghApi(path, options = {}) {
  const headers = await getHeaders(options._tokenOverride);
  const res = await fetch(`${GITHUB_API}${path}`, {
    ...options,
    headers: { ...headers, ...options.headers },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${res.status} ${path}: ${text}`);
  }
  return res.json();
}

/**
 * Create a PR with file changes via the Git Trees API.
 * Atomic: blob→tree→commit→branch→PR in one flow.
 *
 * @param {Object} params
 * @param {string} params.owner - Repo owner
 * @param {string} params.repo - Repo name
 * @param {string} [params.baseBranch='main'] - Base branch
 * @param {string} [params.branchPrefix='autofix'] - Branch name prefix
 * @param {Array<{path: string, content: string}>} params.files - Files to create/update
 * @param {string} params.commitMessage - Commit message
 * @param {string} params.prTitle - PR title
 * @param {string} params.prBody - PR body (markdown)
 * @param {string[]} [params.labels] - Labels to apply
 * @param {{name: string, email: string}} [params.author] - Commit author (defaults to Optimus bot)
 * @returns {Promise<{prUrl: string, prNumber: number, branchName: string}>}
 */
export async function createPR({
  owner,
  repo,
  baseBranch = 'main',
  branchPrefix = 'autofix',
  files,
  commitMessage,
  prTitle,
  prBody,
  labels = [],
  author = { name: 'ecgang', email: 'eric@staqs.io' },
  requestReviewers = [],
  token,
}) {
  if (!files?.length || !commitMessage) {
    throw new Error('Files and commit message are required');
  }

  // Wrap ghApi to inject token override for cross-org repos
  const api = token
    ? (path, opts = {}) => ghApi(path, { ...opts, _tokenOverride: token })
    : ghApi;

  // 1. Get base branch SHA
  const refData = await api(
    `/repos/${owner}/${repo}/git/ref/heads/${baseBranch}`
  );
  const baseSha = refData.object.sha;

  // 2. Get base commit tree SHA
  const baseCommit = await api(
    `/repos/${owner}/${repo}/git/commits/${baseSha}`
  );
  const baseTreeSha = baseCommit.tree.sha;

  // 3. Create blobs for each file
  const treeEntries = [];
  for (const file of files) {
    const blobData = await api(`/repos/${owner}/${repo}/git/blobs`, {
      method: 'POST',
      body: JSON.stringify({
        content: file.content,
        encoding: file.encoding || 'utf-8',
      }),
    });
    treeEntries.push({
      path: file.path,
      mode: '100644',
      type: 'blob',
      sha: blobData.sha,
    });
  }

  // 4. Create new tree
  const treeData = await api(`/repos/${owner}/${repo}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({
      base_tree: baseTreeSha,
      tree: treeEntries,
    }),
  });

  // 5. Create commit (explicit author prevents inheriting PAT owner's email)
  const commitData = await api(`/repos/${owner}/${repo}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({
      message: commitMessage,
      tree: treeData.sha,
      parents: [baseSha],
      author,
    }),
  });

  // 6. Create branch
  const slug = commitMessage
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 40)
    .replace(/-$/, '');
  const timestamp = Date.now();
  const branchName = `${branchPrefix}/${timestamp}-${slug}`;

  await api(`/repos/${owner}/${repo}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({
      ref: `refs/heads/${branchName}`,
      sha: commitData.sha,
    }),
  });

  // 7. Create PR
  const prData = await api(`/repos/${owner}/${repo}/pulls`, {
    method: 'POST',
    body: JSON.stringify({
      title: prTitle,
      head: branchName,
      base: baseBranch,
      body: prBody,
    }),
  });

  // 8. Apply labels (best-effort)
  if (labels.length > 0) {
    await api(`/repos/${owner}/${repo}/issues/${prData.number}/labels`, {
      method: 'POST',
      body: JSON.stringify({ labels }),
    }).catch(() => {});
  }

  // 9. Request reviewers (best-effort, non-fatal)
  if (requestReviewers.length > 0 && prData.number) {
    try {
      await api(`/repos/${owner}/${repo}/pulls/${prData.number}/requested_reviewers`, {
        method: 'POST',
        body: JSON.stringify({ reviewers: requestReviewers }),
      });
    } catch (err) {
      console.warn(`[pr-creator] Failed to request reviewers: ${err.message}`);
    }
  }

  return {
    prUrl: prData.html_url,
    prNumber: prData.number,
    branchName,
  };
}
