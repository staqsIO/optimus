/**
 * GitHub REST API client for Issues and Code Search.
 * Plain fetch — no SDK dependency (P4: boring infrastructure).
 *
 * Auth: GitHub App installation token (preferred) or GITHUB_TOKEN PAT (fallback).
 */

import { getGitHubToken } from './app-auth.js';

const GITHUB_API = 'https://api.github.com';

async function getHeaders() {
  const token = await getGitHubToken();
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
  };
}

async function ghFetch(path, options = {}) {
  const headers = await getHeaders();
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
 * Create a GitHub issue.
 * @param {Object} params
 * @param {string} params.owner - Repo owner
 * @param {string} params.repo - Repo name
 * @param {string} params.title
 * @param {string} params.body - Markdown body
 * @param {string[]} [params.labels]
 * @returns {Promise<{number: number, html_url: string, title: string}>}
 */
export async function createIssue({ owner, repo, title, body, labels }) {
  const payload = { title, body };
  if (labels?.length) payload.labels = labels;

  return ghFetch(`/repos/${owner}/${repo}/issues`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/**
 * Fetch a single file's content from a repo.
 * @param {Object} params
 * @param {string} params.owner
 * @param {string} params.repo
 * @param {string} params.path - File path within repo
 * @param {string} [params.ref] - Branch/tag/SHA (default: repo default branch)
 * @returns {Promise<{content: string, sha: string, size: number}>}
 */
export async function fetchFileContent({ owner, repo, path, ref }) {
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const data = await ghFetch(
    `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}${query}`
  );

  return {
    content: Buffer.from(data.content, 'base64').toString('utf-8'),
    sha: data.sha,
    size: data.size,
    path: data.path,
  };
}

/**
 * Search code within a repo.
 * @param {Object} params
 * @param {string} params.owner
 * @param {string} params.repo
 * @param {string} params.query - Search term
 * @returns {Promise<Array<{path: string, sha: string, score: number}>>}
 */
export async function searchCode({ owner, repo, query }) {
  const q = encodeURIComponent(`${query} repo:${owner}/${repo}`);
  const data = await ghFetch(`/search/code?q=${q}&per_page=20`);
  return (data.items || []).map(item => ({
    path: item.path,
    sha: item.sha,
    score: item.score,
  }));
}

/**
 * List repos the authenticated user has access to (all orgs + personal).
 * Used by the settings UI repo picker.
 * @returns {Promise<Array<{full_name: string, name: string, owner: string, private: boolean, updated_at: string}>>}
 */
export async function listAccessibleRepos() {
  const useAppAuth = !!(process.env.GITHUB_APP_ID && process.env.GITHUB_APP_INSTALLATION_ID);
  const repos = [];
  let page = 1;
  while (page <= 5) { // cap at 500 repos
    if (useAppAuth) {
      // GitHub App: use installation repositories endpoint
      const data = await ghFetch(`/installation/repositories?per_page=100&page=${page}`);
      const repoList = data.repositories || [];
      if (!repoList.length) break;
      repos.push(...repoList.map(r => ({
        full_name: r.full_name,
        name: r.name,
        owner: r.owner.login,
        private: r.private,
        updated_at: r.updated_at,
      })));
      if (repos.length >= data.total_count) break;
    } else {
      // PAT: use user repos endpoint
      const data = await ghFetch(`/user/repos?per_page=100&page=${page}&sort=updated`);
      if (!data.length) break;
      repos.push(...data.map(r => ({
        full_name: r.full_name,
        name: r.name,
        owner: r.owner.login,
        private: r.private,
        updated_at: r.updated_at,
      })));
    }
    page++;
  }
  return repos;
}

/**
 * List open issues for a repo, optionally filtered by labels.
 * Paginates automatically (up to 5 pages / 500 issues).
 * @param {Object} params
 * @param {string} params.owner
 * @param {string} params.repo
 * @param {string[]} [params.labels] - Filter by label names (comma-joined)
 * @param {string} [params.state] - 'open' | 'closed' | 'all' (default: 'open')
 * @param {number} [params.maxPages] - Max pages to fetch (default: 5, cap at 500 issues)
 * @returns {Promise<Array<{number: number, title: string, labels: string[], html_url: string, body: string, assignee: Object|null}>>}
 */
export async function listIssues({ owner, repo, labels, state = 'open', maxPages = 5 }) {
  const issues = [];
  for (let page = 1; page <= maxPages; page++) {
    const params = new URLSearchParams({ state, per_page: '100', page: String(page) });
    if (labels?.length) params.set('labels', labels.join(','));
    const data = await ghFetch(`/repos/${owner}/${repo}/issues?${params}`);
    if (!data.length) break;
    for (const item of data) {
      if (item.pull_request) continue; // issues endpoint includes PRs
      issues.push({
        number: item.number,
        title: item.title,
        labels: (item.labels || []).map(l => l.name),
        html_url: item.html_url,
        body: item.body,
        assignee: item.assignee,
      });
    }
    if (data.length < 100) break; // last page
  }
  return issues;
}

/**
 * Fetch the repo tree (file listing).
 * @param {Object} params
 * @param {string} params.owner
 * @param {string} params.repo
 * @param {string} [params.ref] - Branch/tag/SHA (default: HEAD)
 * @returns {Promise<Array<{path: string, type: string, size: number}>>}
 */
export async function fetchRepoTree({ owner, repo, ref }) {
  const sha = ref || 'HEAD';
  const data = await ghFetch(
    `/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`
  );
  return (data.tree || [])
    .filter(item => item.type === 'blob')
    .map(item => ({
      path: item.path,
      type: item.type,
      size: item.size || 0,
    }));
}
