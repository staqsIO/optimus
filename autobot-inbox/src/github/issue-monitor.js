/**
 * GitHub Issue Reconciliation Poll — catches anything the webhook missed.
 *
 * Runs every 12 hours on the primary instance. Zero LLM cost — pure API + DB checks.
 * For each open issue with an actionable label, checks for existing intent via
 * pattern: 'github_issue_${repo}_${number}'. Creates intent only if none exists.
 *
 * P1: deny by default — only configured labels in github-bot.json are actionable.
 * P4: boring infrastructure — REST API + SQL, no framework.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { query } from '../db.js';
import { listIssues } from './issues.js';
import { createIntent } from '../runtime/intent-manager.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const configPath = join(__dirname, '..', '..', 'config', 'github-bot.json');
let config;
try {
  config = JSON.parse(readFileSync(configPath, 'utf-8'));
} catch {
  config = null;
}

/**
 * Reconcile GitHub issues — find actionable issues without corresponding intents or work items.
 * Called by scheduleService in index.js.
 */
export async function reconcileGitHubIssues() {
  if (!config) {
    return; // github-bot.json not configured, skip reconciliation
  }
  if (!process.env.GITHUB_TOKEN && !process.env.GITHUB_APP_ID) {
    return; // GitHub auth not configured, skip reconciliation
  }

  let created = 0;
  let skipped = 0;

  for (const repoFullName of config.repos) {
    const [owner, repo] = repoFullName.split('/');
    if (!owner || !repo) {
      console.warn(`[github-reconciliation] Invalid repo format: ${repoFullName}`);
      continue;
    }

    // Collect all actionable labels from config
    const actionableLabels = [
      ...config.autoFixLabels,
      ...Object.keys(config.intentLabels),
    ];

    let issues;
    try {
      issues = await listIssues({ owner, repo, state: 'open' });
    } catch (err) {
      console.error(`[github-reconciliation] Failed to fetch issues for ${repoFullName}: ${err.message}`);
      continue;
    }

    for (const issue of issues) {
      const matchedLabels = issue.labels.filter(l => actionableLabels.includes(l));
      if (matchedLabels.length === 0) continue;

      const isAutoFix = matchedLabels.some(l => config.autoFixLabels.includes(l));

      if (isAutoFix) {
        // Check for existing work item (auto-fix bypasses intents)
        const existingWork = await query(
          `SELECT id FROM agent_graph.work_items
           WHERE metadata->>'github_issue_number' = $1
             AND metadata->>'github_repo' = $2
             AND status NOT IN ('completed', 'cancelled', 'failed')
           LIMIT 1`,
          [String(issue.number), repoFullName]
        );
        if (existingWork.rows.length > 0) {
          skipped++;
          continue;
        }
        // Auto-fix reconciliation: create intent instead of direct work item
        // (reconciliation is conservative — let board confirm stale auto-fix issues)
      }

      // Check for existing intent via dedup pattern
      const existingIntent = await query(
        `SELECT id FROM agent_graph.agent_intents
         WHERE trigger_context->>'pattern' = $1
           AND status NOT IN ('expired', 'rejected')
         LIMIT 1`,
        [`github_issue_${repoFullName}_${issue.number}`]
      );
      if (existingIntent.rows.length > 0) {
        skipped++;
        continue;
      }

      // Find the first actionable intent label
      const intentLabel = matchedLabels.find(l => config.intentLabels[l]) || matchedLabels[0];
      const routing = config.intentLabels[intentLabel] || {
        agent: config.defaultAgent,
        tier: config.defaultTier,
      };

      const intent = await createIntent({
        agentId: routing.agent,
        intentType: 'task',
        decisionTier: routing.tier,
        title: `GitHub #${issue.number}: ${issue.title}`,
        reasoning: `Reconciliation: open issue with "${intentLabel}" label in ${repoFullName}. ${issue.body?.slice(0, 200) || 'No description.'}`,
        proposedAction: {
          type: 'create_work_item',
          payload: {
            type: 'task',
            title: `GitHub #${issue.number}: ${issue.title}`,
            description: issue.body?.slice(0, 500) || '',
            assigned_to: routing.agent,
            priority: routing.tier === 'strategic' ? 2 : 1,
            metadata: {
              target_repo: repoFullName,
              github_issue_number: String(issue.number),
              github_issue_url: issue.html_url,
              github_repo: repoFullName,
              github_label: intentLabel,
              source: 'github-reconciliation',
            },
          },
        },
        triggerContext: {
          pattern: `github_issue_${repoFullName}_${issue.number}`,
          source: 'github-reconciliation',
          github_issue_number: issue.number,
          github_repo: repoFullName,
          github_label: intentLabel,
        },
        budgetPerFire: routing.tier === 'strategic' ? 0.50 : 0.25,
      });

      if (intent) {
        created++;
        console.log(`[github-reconciliation] Created intent for #${issue.number} [${intentLabel}]`);
      } else {
        skipped++;
      }
    }
  }

  if (created > 0 || skipped > 0) {
    console.log(`[github-reconciliation] Done: ${created} created, ${skipped} skipped`);
  }
}
