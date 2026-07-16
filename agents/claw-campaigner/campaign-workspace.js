/**
 * Campaign Workspace Manager (ADR-021, Phase C)
 *
 * Git worktree lifecycle for stateful campaigns:
 * - create: git worktree add + goal.md bootstrap
 * - commit: git commit on quality improvement
 * - reset: git reset on quality regression
 * - cleanup: remove worktree on campaign completion/cancel
 * - orphanScan: startup check for stale worktrees
 *
 * Each stateful campaign gets an isolated git worktree checked out
 * from a campaign-specific branch. The workspace contains:
 *   campaigns/<campaign-id>/
 *     goal.md           — Board-authored brief (never modified by agent)
 *     workspace/         — Agent's working surface
 *     artifacts/         — Iteration outputs
 */

import { execFile } from 'child_process';
import { mkdir, writeFile, readdir, rm, access, readFile } from 'fs/promises';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { query } from '../../lib/db.js';
import { fetchWithTimeout } from '../../lib/runtime/fetch-utils.js';
import { getGitHubToken } from '../../autobot-inbox/src/github/app-auth.js';
import { createChildLogger } from '../../lib/logger.js';

const log = createChildLogger({ agent: 'workspace' });

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const DEFAULT_WORKTREE_BASE = join(REPO_ROOT, 'campaigns');
const PROJECT_BASE = '/tmp/optimus-projects';

/**
 * Create a campaign workspace (git worktree + directory structure).
 *
 * @param {string} campaignId
 * @param {string} goalDescription - Board-authored campaign brief
 * @param {Object} successCriteria - Campaign success criteria
 * @param {string} [worktreeBase] - Base directory for worktrees
 * @returns {Promise<string>} Path to the created workspace
 */
export async function createWorkspace(campaignId, goalDescription, successCriteria, worktreeBase = DEFAULT_WORKTREE_BASE, { existingBranch } = {}) {
  const worktreePath = join(worktreeBase, campaignId);

  // Ensure base directory exists
  await mkdir(worktreeBase, { recursive: true });

  if (existingBranch) {
    // Reuse an existing PR branch — fetch it and create worktree from it
    try {
      await gitExec(['fetch', 'origin', existingBranch]);
      await gitExec(['worktree', 'add', worktreePath, `origin/${existingBranch}`]);
      // Checkout as local branch tracking remote
      await gitExec(['checkout', '-B', existingBranch, `origin/${existingBranch}`], worktreePath);
      // Merge main to bring in latest changes
      try {
        await gitExec(['merge', 'main', '--no-edit'], worktreePath);
      } catch {
        await gitExec(['merge', '--abort'], worktreePath);
        await gitExec(['reset', '--hard', 'main'], worktreePath);
      }
      log.info(` Reusing existing branch ${existingBranch} for campaign ${campaignId}`);
    } catch (err) {
      log.warn(` Could not reuse branch ${existingBranch}: ${err.message} — creating new branch`);
      // Fall through to create new branch
      const branchName = `campaign/${campaignId}`;
      await gitExec(['worktree', 'add', '-b', branchName, worktreePath, 'HEAD']);
    }
  } else {
    // Create git worktree with a new branch from HEAD
    const branchName = `campaign/${campaignId}`;
    // Force-remove stale worktree + branch from previous failed attempts
    try { await gitExec(['worktree', 'remove', '--force', worktreePath]); } catch { /* may not exist */ }
    try { await gitExec(['worktree', 'prune']); } catch { /* non-critical */ }
    try { await gitExec(['branch', '-D', branchName]); } catch { /* branch may not exist */ }
    await gitExec(['worktree', 'add', '-b', branchName, worktreePath, 'HEAD']);
  }

  // Set commit author in worktree to prevent inheriting machine-level git config
  try {
    await gitExec(['config', 'user.name', 'ecgang'], worktreePath);
    await gitExec(['config', 'user.email', 'eric@staqs.io'], worktreePath);
  } catch (err) {
    log.warn(` Failed to set git author: ${err.message}`);
  }

  // Create directory structure
  await mkdir(join(worktreePath, 'workspace'), { recursive: true });
  await mkdir(join(worktreePath, 'artifacts'), { recursive: true });

  // Bootstrap goal.md (never modified by the agent — this is autoresearch's program.md)
  const goalContent = `# Campaign Goal

${goalDescription}

## Success Criteria

${formatSuccessCriteria(successCriteria)}

## Notes

This file is the campaign brief. The Campaigner reads it but never modifies it.
Changes to the campaign goal require board intervention.

---
Campaign ID: ${campaignId}
Created: ${new Date().toISOString()}
`;

  await writeFile(join(worktreePath, 'goal.md'), goalContent, 'utf-8');

  // Write CLAUDE.md so the CLI has project context (appendSystemPrompt reads this)
  const claudeMd = `# CLAUDE.md — Campaign Workspace

## Goal
${goalDescription}

## How to Work
- Use Write/Edit tools to create and modify files. NEVER output code as markdown text.
- After making changes, commit: \`git add -A && git commit -m "description"\`
- The scorer evaluates your git changes (committed + uncommitted), not your text output.
- Your response text should be a brief summary of what you changed and why.

## Conventions
- ES modules (\`"type": "module"\`) for JavaScript
- Commit frequently with descriptive messages
- Run \`npm test\` if a test script exists

Campaign ID: ${campaignId}
`;
  await writeFile(join(worktreePath, 'CLAUDE.md'), claudeMd, 'utf-8');

  // Initial commit in the worktree
  await gitExec(['add', '.'], worktreePath);
  await gitExec(['commit', '-m', `Initialize campaign ${campaignId} workspace`], worktreePath);

  // Update campaign record with workspace path
  await query(
    `UPDATE agent_graph.campaigns SET workspace_path = $1, updated_at = now() WHERE id = $2`,
    [worktreePath, campaignId]
  );

  log.info(` Created worktree for campaign ${campaignId} at ${worktreePath}`);
  return worktreePath;
}

/**
 * Commit current workspace changes (quality improved → keep).
 *
 * @param {string} worktreePath
 * @param {number} iterationNumber
 * @param {number} qualityScore
 * @returns {Promise<string|null>} Short git hash or null if nothing to commit
 */
export async function commitImprovement(worktreePath, iterationNumber, qualityScore) {
  // Check for changes
  const status = await gitExec(['status', '--porcelain'], worktreePath);
  if (!status.trim()) return null; // nothing to commit

  await gitExec(['add', '-A'], worktreePath);
  const message = `iteration #${iterationNumber}: score ${qualityScore?.toFixed(4) || 'N/A'} (kept)`;
  await gitExec(['commit', '-m', message], worktreePath);

  // Get short hash
  const hash = await gitExec(['rev-parse', '--short=7', 'HEAD'], worktreePath);
  return hash.trim();
}

/**
 * Reset workspace to last committed state (quality regressed → discard).
 *
 * @param {string} worktreePath
 */
export async function resetRegression(worktreePath) {
  await gitExec(['checkout', '.'], worktreePath);
  await gitExec(['clean', '-fd'], worktreePath);
}

/**
 * Get git diff of cumulative changes since workspace creation.
 *
 * @param {string} worktreePath
 * @param {number} [maxLines=200] - Truncate diff output
 * @returns {Promise<string>}
 */
export async function getCumulativeDiff(worktreePath, maxLines = 200) {
  try {
    // Diff from first commit on the campaign branch
    const firstCommit = await gitExec(
      ['log', '--reverse', '--format=%H', '--max-count=1'],
      worktreePath
    );
    const hash = firstCommit.trim();
    if (!hash) return '';

    const diff = await gitExec(['diff', `${hash}..HEAD`, '--stat'], worktreePath);
    const lines = diff.split('\n');
    if (lines.length > maxLines) {
      return lines.slice(0, maxLines).join('\n') + `\n... (${lines.length - maxLines} more lines)`;
    }
    return diff;
  } catch {
    return '';
  }
}

/**
 * Read the goal.md from a campaign workspace.
 *
 * @param {string} worktreePath
 * @returns {Promise<string>}
 */
export async function readGoal(worktreePath) {
  try {
    return await readFile(join(worktreePath, 'goal.md'), 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Clean up a campaign workspace (remove worktree + prune refs).
 *
 * @param {string} campaignId
 * @param {string} [worktreeBase]
 */
export async function cleanupWorkspace(campaignId, worktreeBase = DEFAULT_WORKTREE_BASE) {
  const worktreePath = join(worktreeBase, campaignId);
  const branchName = `campaign/${campaignId}`;

  try {
    // Remove the worktree
    await gitExec(['worktree', 'remove', '--force', worktreePath]);
  } catch (err) {
    // Worktree may already be gone — try manual removal
    log.warn(` Worktree remove failed for ${campaignId}: ${err.message}`);
    try {
      await rm(worktreePath, { recursive: true, force: true });
      await gitExec(['worktree', 'prune']);
    } catch {
      // Best effort
    }
  }

  // Delete the campaign branch (keep the commits in reflog for a while)
  try {
    await gitExec(['branch', '-D', branchName]);
  } catch {
    // Branch may not exist
  }

  log.info(` Cleaned up workspace for campaign ${campaignId}`);
}

/**
 * Scan for orphaned worktrees on startup.
 * Finds directories in campaigns/ that don't correspond to active campaigns.
 *
 * @param {string} [worktreeBase]
 * @returns {Promise<string[]>} List of orphaned campaign IDs
 */
export async function scanOrphanedWorktrees(worktreeBase = DEFAULT_WORKTREE_BASE) {
  const orphans = [];

  try {
    await access(worktreeBase);
  } catch {
    return orphans; // No campaigns directory
  }

  const entries = await readdir(worktreeBase, { withFileTypes: true });
  const dirs = entries.filter(e => e.isDirectory()).map(e => e.name);

  if (dirs.length === 0) return orphans;

  // Get all active campaign IDs
  const result = await query(
    `SELECT id FROM agent_graph.campaigns
     WHERE campaign_status NOT IN ('succeeded', 'failed', 'cancelled')`
  );
  const activeCampaignIds = new Set(result.rows.map(r => r.id));

  for (const dir of dirs) {
    if (!activeCampaignIds.has(dir)) {
      orphans.push(dir);
      log.warn(` Orphaned worktree detected: ${dir}`);
    }
  }

  return orphans;
}

/**
 * Clean up all orphaned worktrees.
 */
export async function cleanupOrphans(worktreeBase = DEFAULT_WORKTREE_BASE) {
  const orphans = await scanOrphanedWorktrees(worktreeBase);
  for (const campaignId of orphans) {
    await cleanupWorkspace(campaignId, worktreeBase);
  }
  if (orphans.length > 0) {
    log.info(` Cleaned up ${orphans.length} orphaned worktree(s)`);
  }
  return orphans.length;
}

// ============================================================
// Project mode workspace (fresh GitHub repo, not a worktree)
// ============================================================

/**
 * Create a project workspace: fresh GitHub repo + local clone.
 * Used by campaign_mode='project' instead of git worktrees.
 *
 * @param {string} campaignId
 * @param {string} goalDescription - Board-authored campaign brief
 * @returns {Promise<string>} Path to the created workspace
 */
export async function createProjectWorkspace(campaignId, goalDescription) {
  const projectName = `optimus-project-${campaignId.slice(0, 8)}`;
  const workspacePath = join(PROJECT_BASE, campaignId);

  // Ensure base directory exists
  await mkdir(PROJECT_BASE, { recursive: true });

  // Step 1: Create GitHub repo via API
  let repoFullName;
  try {
    const token = await getGitHubToken();
    const res = await fetchWithTimeout('https://api.github.com/orgs/staqsIO/repos', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: projectName,
        description: `Optimus project campaign ${campaignId.slice(0, 8)}`,
        private: true,
        auto_init: true,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitHub repo creation failed (${res.status}): ${text}`);
    }

    const repo = await res.json();
    repoFullName = repo.full_name; // e.g., "staqsIO/optimus-project-abc12345"
    log.info(` Created GitHub repo: ${repoFullName}`);
  } catch (err) {
    log.error(` Failed to create GitHub repo for campaign ${campaignId}: ${err.message}`);
    throw err;
  }

  // Step 2: Clone the repo locally (retry with delay — GitHub App needs a moment to register new repo)
  const cloneToken = await getGitHubToken();
  const cloneUrl = `https://x-access-token:${cloneToken}@github.com/${repoFullName}.git`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await gitExec(['clone', cloneUrl, workspacePath], PROJECT_BASE);
      break;
    } catch (cloneErr) {
      if (attempt < 2 && /not found|does not exist/i.test(cloneErr.message)) {
        log.info(` Clone attempt ${attempt + 1} failed (repo not ready yet), retrying in ${(attempt + 1) * 3}s...`);
        await new Promise(r => setTimeout(r, (attempt + 1) * 3000));
        // Clean up partial clone directory
        try { await rm(workspacePath, { recursive: true, force: true }); } catch { }
      } else {
        throw cloneErr;
      }
    }
  }

  // Step 3: Configure git author in the clone
  try {
    await gitExec(['config', 'user.name', 'ecgang'], workspacePath);
    await gitExec(['config', 'user.email', 'eric@staqs.io'], workspacePath);
  } catch (err) {
    log.warn(` Failed to set git author: ${err.message}`);
  }

  // Step 4: Write goal.md
  const goalContent = `# Campaign Goal

${goalDescription}

---
Campaign ID: ${campaignId}
Created: ${new Date().toISOString()}
`;
  await writeFile(join(workspacePath, 'goal.md'), goalContent, 'utf-8');

  // Step 5: Commit and push
  await gitExec(['add', '.'], workspacePath);
  await gitExec(['commit', '-m', `Initialize project campaign ${campaignId.slice(0, 8)}`], workspacePath);
  await gitExec(['push', 'origin', 'main'], workspacePath);

  // Step 6: Update campaign record
  await query(
    `UPDATE agent_graph.campaigns
     SET workspace_path = $1,
         metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('github_repo', $2::text),
         updated_at = now()
     WHERE id = $3`,
    [workspacePath, repoFullName, campaignId]
  );

  log.info(` Created project workspace for campaign ${campaignId} at ${workspacePath}`);
  return workspacePath;
}

/**
 * Clean up a project workspace: archive GitHub repo + remove local clone.
 * Optionally delegates Railway cleanup to project-deploy.js.
 *
 * @param {string} campaignId
 */
export async function cleanupProjectWorkspace(campaignId) {
  // Get campaign metadata for repo name and Railway IDs
  const result = await query(
    `SELECT metadata, workspace_path FROM agent_graph.campaigns WHERE id = $1`,
    [campaignId]
  );
  const row = result.rows[0];
  if (!row) return;

  const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata || {};

  // Archive GitHub repo (not delete — P3 audit trail)
  if (meta.github_repo) {
    try {
      const token = await getGitHubToken();
      const res = await fetchWithTimeout(`https://api.github.com/repos/${meta.github_repo}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ archived: true }),
      });
      if (res.ok) {
        log.info(` Archived GitHub repo: ${meta.github_repo}`);
      } else {
        log.warn(` Failed to archive repo ${meta.github_repo}: ${res.status}`);
      }
    } catch (err) {
      log.warn(` GitHub archive failed: ${err.message}`);
    }
  }

  // Delete deploy project (Railway or Vercel)
  if (meta.railway_project_id) {
    try {
      const { deleteRailwayProject } = await import('./project-deploy.js');
      await deleteRailwayProject(meta.railway_project_id);
      log.info(` Deleted Railway project: ${meta.railway_project_id}`);
    } catch (err) {
      log.warn(` Railway cleanup failed: ${err.message}`);
    }
  }
  if (meta.vercel_project_id) {
    try {
      const { deleteVercelProject } = await import('./project-deploy.js');
      await deleteVercelProject(meta.vercel_project_id);
      log.info(` Deleted Vercel project: ${meta.vercel_project_id}`);
    } catch (err) {
      log.warn(` Vercel cleanup failed: ${err.message}`);
    }
  }

  // Remove local clone
  if (row.workspace_path) {
    try {
      await rm(row.workspace_path, { recursive: true, force: true });
    } catch {
      // Best effort
    }
  }

  // Mark as cleaned up in metadata
  await query(
    `UPDATE agent_graph.campaigns
     SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"cleaned_up": true}'::jsonb,
         updated_at = now()
     WHERE id = $1`,
    [campaignId]
  );

  log.info(` Cleaned up project workspace for campaign ${campaignId}`);
}

// ============================================================
// Git helpers
// ============================================================

/**
 * Push the campaign branch to origin so the board can access artifacts.
 * Uses --force-with-lease (safe push — campaign branches are single-writer).
 * Stores branch name in campaign metadata for the preview endpoint.
 *
 * @param {string} campaignId
 * @returns {Promise<string>} Branch name that was pushed
 */
export async function pushBranch(campaignId) {
  const result = await query(
    `SELECT workspace_path FROM agent_graph.campaigns WHERE id = $1`,
    [campaignId]
  );
  const wsPath = result.rows[0]?.workspace_path;
  if (!wsPath) throw new Error(`No workspace path for campaign ${campaignId}`);

  // Get current branch name
  const branchName = (await gitExec(['rev-parse', '--abbrev-ref', 'HEAD'], wsPath)).trim();

  // Push to origin
  await gitExec(['push', 'origin', branchName, '--force-with-lease'], wsPath);

  // Store branch in campaign metadata
  await query(
    `UPDATE agent_graph.campaigns
     SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('branch', $1::text),
         updated_at = now()
     WHERE id = $2`,
    [branchName, campaignId]
  );

  log.info(` Pushed branch ${branchName} for campaign ${campaignId}`);
  return branchName;
}

function gitExec(args, cwd = REPO_ROOT) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`git ${args[0]} failed: ${stderr || err.message}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

function formatSuccessCriteria(criteria) {
  if (!criteria || !Array.isArray(criteria)) return '(none defined)';
  return criteria.map(c =>
    `- ${c.metric} ${c.operator} ${c.threshold}`
  ).join('\n');
}
