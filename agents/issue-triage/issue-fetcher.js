/**
 * Issue Fetcher — polls Linear and GitHub for unassigned issues.
 *
 * Returns a unified list of issues from all configured sources.
 * Filters: unassigned, non-completed, not too old, not already triaged.
 */

import { query } from '../../lib/db.js';
import { createChildLogger } from '../../lib/logger.js';

const log = createChildLogger({ agent: 'issue-triage' });

/**
 * Fetch unassigned issues from Linear via GraphQL.
 * Supports multiple team keys (polls each team).
 *
 * @param {Object} linearClient - Linear API client (from src/linear/client.js)
 * @param {Object} config - Triage config with linearTeamKeys (array) or linearTeamKey (string)
 * @returns {Promise<Array>}
 */
export async function fetchLinearIssues(linearClient, config) {
  // Support both single key and array of keys
  const teamKeys = config.linearTeamKeys || (config.linearTeamKey ? [config.linearTeamKey] : []);
  if (teamKeys.length === 0 || !linearClient) return [];

  const maxAge = Date.now() - (config.maxAgeHours || 720) * 3600_000;
  const allIssues = [];

  for (const teamKey of teamKeys) {
    try {
      const issues = await linearClient.listUnassignedIssues(teamKey, 20);
      if (!issues?.length) continue;

      for (const issue of issues) {
        if (new Date(issue.createdAt).getTime() < maxAge) continue;
        allIssues.push({
          source: 'linear',
          sourceIssueId: issue.id,
          sourceIssueUrl: issue.url,
          title: issue.title,
          description: (issue.description || '').slice(0, 1500),
          priority: issue.priority || 3,
          labels: issue.labels?.nodes?.map(l => l.name) || [],
          team: issue.team?.key || teamKey,
          rawIssue: issue,
        });
      }
    } catch (err) {
      log.warn(` Linear fetch failed for team ${teamKey}: ${err.message}`);
    }
  }

  return allIssues;
}

/**
 * Fetch unassigned issues from GitHub repos and/or orgs.
 * Supports both explicit repos and org-level discovery.
 *
 * @param {Function} getGitHubToken - Auth token provider
 * @param {Object} config - { githubOrgs: string[], githubRepos: string[] }
 * @returns {Promise<Array>}
 */
export async function fetchGitHubIssues(getGitHubToken, config) {
  const token = typeof getGitHubToken === 'function' ? await getGitHubToken() : null;
  if (!token) {
    log.warn(' No GitHub token available, skipping GitHub issues');
    return [];
  }

  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json' };

  // Discover repos from orgs
  const repos = new Set(config.githubRepos || []);
  for (const org of (config.githubOrgs || [])) {
    try {
      const res = await fetch(
        `https://api.github.com/orgs/${org}/repos?type=all&per_page=100&sort=pushed&direction=desc`,
        { headers, signal: AbortSignal.timeout(10000) }
      );
      if (!res.ok) { log.warn(` Failed to list repos for org ${org}: ${res.status}`); continue; }
      const orgRepos = await res.json();
      for (const repo of orgRepos) {
        if (!repo.archived && repo.has_issues) {
          repos.add(repo.full_name);
        }
      }
    } catch (err) {
      log.warn(` GitHub org fetch failed for ${org}: ${err.message}`);
    }
  }

  if (repos.size === 0) return [];
  log.info(` Polling ${repos.size} GitHub repos across ${(config.githubOrgs || []).length} org(s)`);

  const allIssues = [];
  for (const repoSlug of repos) {
    try {
      const res = await fetch(
        `https://api.github.com/repos/${repoSlug}/issues?state=open&assignee=none&per_page=10&sort=created&direction=desc`,
        { headers, signal: AbortSignal.timeout(10000) }
      );
      if (!res.ok) continue;
      const issues = await res.json();

      for (const issue of issues) {
        if (issue.pull_request) continue;
        if (issue.labels?.some(l => l.name === 'optimus-triaged')) continue;

        allIssues.push({
          source: 'github',
          sourceIssueId: `${repoSlug}#${issue.number}`,
          sourceIssueUrl: issue.html_url,
          title: issue.title,
          description: (issue.body || '').slice(0, 1500),
          priority: 3,
          labels: issue.labels?.map(l => l.name) || [],
          repo: repoSlug,
          rawIssue: issue,
        });
      }
    } catch (err) {
      log.warn(` GitHub fetch failed for ${repoSlug}: ${err.message}`);
    }
  }

  return allIssues;
}

/**
 * Check if an issue has already been triaged (dedup).
 * Attempts INSERT ... ON CONFLICT DO NOTHING.
 * Returns true if the issue is new (insert succeeded), false if already triaged.
 */
export async function tryInsertTriage(issue) {
  const result = await query(
    `INSERT INTO agent_graph.issue_triage_log (source, source_issue_id, source_issue_url, title, decision, raw_issue)
     VALUES ($1, $2, $3, $4, 'pending', $5)
     ON CONFLICT (source, source_issue_id) DO NOTHING
     RETURNING id`,
    [issue.source, issue.sourceIssueId, issue.sourceIssueUrl, issue.title, JSON.stringify(issue.rawIssue)]
  );
  return result.rows.length > 0 ? result.rows[0].id : null;
}
