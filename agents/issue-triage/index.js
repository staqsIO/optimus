/**
 * Issue Triage Agent — proactively polls Linear/GitHub for unassigned issues,
 * evaluates them via LLM, and auto-assigns clear ones to idle runners.
 *
 * Runs in-process alongside claw-workshop + claw-campaigner in runner.js.
 * Same battle-tested pattern: poll interval + pg_notify wake-up + circuit breaker.
 *
 * Unanimous consensus (Liotta + Linus + Neo Architect): agent loop, not cron HTTP.
 * Eliminates network hop failure class, uses existing pool infrastructure.
 */

import { query, isCircuitOpen } from '../../lib/db.js';
import { subscribe } from '../../lib/runtime/event-bus.js';
import { fetchLinearIssues, fetchGitHubIssues, tryInsertTriage } from './issue-fetcher.js';
import { evaluateIssue } from './triage-evaluator.js';
import { autoAssignIssue, checkCapacity, requestClarification } from './auto-assigner.js';
import { createChildLogger } from '../../lib/logger.js';

const log = createChildLogger({ agent: 'issue-triage' });

let running = false;
let triageRunning = false;
let pollTimer = null;
let _unsubscribe = null;
let _lastHeartbeatAt = null;
let config = null;

// Lazy imports to avoid circular deps at startup
let linearClient = null;
let getGitHubToken = null;

async function loadDeps() {
  if (!linearClient) {
    try {
      const mod = await import('../../autobot-inbox/src/linear/client.js');
      linearClient = mod;
    } catch (err) {
      log.warn(` Linear client unavailable: ${err.message}`);
    }
  }
  if (!getGitHubToken) {
    try {
      const mod = await import('../../autobot-inbox/src/github/app-auth.js');
      getGitHubToken = mod.getGitHubToken;
    } catch (err) {
      log.warn(` GitHub auth unavailable: ${err.message}`);
    }
  }
}

async function loadTriageConfig() {
  try {
    const { loadMergedConfig } = await import('../../lib/runtime/config-loader.js');
    const raw = await loadMergedConfig();
    return raw.agents['issue-triage']?.triage || {};
  } catch {
    // Fallback: read directly from disk
    try {
      const { readFileSync } = await import('fs');
      const { dirname, join } = await import('path');
      const { fileURLToPath } = await import('url');
      const __dirname = dirname(fileURLToPath(import.meta.url));
      const configPath = join(__dirname, '../../autobot-inbox/config/agents.json');
      const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
      return raw.agents['issue-triage']?.triage || {};
    } catch { return {}; }
  }
}

function writeHeartbeat(status) {
  if (isCircuitOpen()) return;
  const now = Date.now();
  if (_lastHeartbeatAt && now - _lastHeartbeatAt < 30_000) return;
  _lastHeartbeatAt = now;
  query(
    `INSERT INTO agent_graph.agent_heartbeats (agent_id, heartbeat_at, status, pid)
     VALUES ('issue-triage', now(), $1, $2)
     ON CONFLICT (agent_id) DO UPDATE SET heartbeat_at = now(), status = $1, pid = $2`,
    [status, process.pid]
  ).catch(() => {});
}

async function updateLinearIssueState(issue, stateName, client) {
  if (issue.source !== 'linear' || !client) return;
  try {
    await client.updateIssueStateByName(issue.sourceIssueId, stateName);
    log.info(` Moved Linear "${issue.title}" → ${stateName}`);
  } catch (err) {
    log.warn(` Failed to update Linear state: ${err.message}`);
  }
}

async function poll() {
  if (triageRunning || isCircuitOpen()) return;
  triageRunning = true;

  try {
    await loadDeps();
    const triageConfig = config || await loadTriageConfig();
    const maxPerRun = triageConfig.maxPerRun || 10;

    // Fetch unassigned issues from both sources
    const [linearIssues, githubIssues] = await Promise.all([
      fetchLinearIssues(linearClient, triageConfig),
      fetchGitHubIssues(getGitHubToken, triageConfig),
    ]);

    const allIssues = [...linearIssues, ...githubIssues].slice(0, maxPerRun);
    if (allIssues.length === 0) return;

    log.info(` Found ${allIssues.length} unassigned issues (${linearIssues.length} Linear, ${githubIssues.length} GitHub)`);

    let autoAssigned = 0, clarification = 0, boardReview = 0, skipped = 0;

    for (const issue of allIssues) {
      // Dedup: try insert, skip if already triaged
      const triageLogId = await tryInsertTriage(issue);
      if (!triageLogId) { skipped++; continue; }

      // LLM evaluate
      const evaluation = await evaluateIssue(issue);

      // Deterministic decision logic (post-LLM)
      let decision;
      const minClarity = triageConfig.autoApproveMinClarity || 4;
      const maxScope = triageConfig.autoApproveMaxScope || 'M';
      const scopeOrder = { S: 1, M: 2, L: 3 };

      if (evaluation.clarity_score >= minClarity
          && evaluation.feasibility === 'auto_assign'
          && scopeOrder[evaluation.scope_estimate] <= scopeOrder[maxScope]) {
        // Check runner capacity before auto-assigning
        const capacity = await checkCapacity(evaluation.campaign_mode);
        if (capacity.hasCapacity) {
          decision = 'auto_assigned';
          await autoAssignIssue(issue, evaluation, triageLogId);
          autoAssigned++;
          // Move Linear issue out of Triage → "In Development"
          await updateLinearIssueState(issue, 'In Development', linearClient);
        } else {
          // Defer — remove triage log entry so we retry next poll
          await query(`DELETE FROM agent_graph.issue_triage_log WHERE id = $1`, [triageLogId]);
          log.info(` Deferred "${issue.title}" — runners at capacity (${capacity.active}/${capacity.max})`);
          continue;
        }
      } else if (evaluation.clarity_score <= 2 || evaluation.feasibility === 'needs_clarification') {
        decision = 'needs_clarification';
        await requestClarification(issue, evaluation.clarification_questions, linearClient);
        clarification++;
        // Keep in Triage — human needs to add info
      } else if (evaluation.feasibility === 'skip') {
        decision = 'skipped';
        skipped++;
        // Move stale/irrelevant issues to Backlog so they don't clog Triage
        await updateLinearIssueState(issue, 'Backlog', linearClient);
      } else {
        decision = 'board_review';
        boardReview++;
        // Move to Todo — board will review from there
        await updateLinearIssueState(issue, 'Todo', linearClient);
      }

      // Update triage log with evaluation results
      await query(
        `UPDATE agent_graph.issue_triage_log
         SET clarity_score = $1, feasibility = $2, scope_estimate = $3,
             classification = $4, target_repos = $5, playbook_id = $6,
             reasoning = $7, decision = $8
         WHERE id = $9`,
        [
          evaluation.clarity_score, evaluation.feasibility, evaluation.scope_estimate,
          evaluation.classification, evaluation.target_repo ? [evaluation.target_repo] : null,
          evaluation.playbook_id, evaluation.reasoning, decision, triageLogId,
        ]
      );
    }

    if (autoAssigned + clarification + boardReview > 0) {
      log.info(` Results: ${autoAssigned} auto-assigned, ${clarification} need clarification, ${boardReview} board review, ${skipped} skipped`);
    }
  } catch (err) {
    log.error(` Poll error: ${err.message}`);
  } finally {
    triageRunning = false;
  }
}

// ============================================================
// Exported loop interface (compatible with runner.js)
// ============================================================

export const triageLoop = {
  agentId: 'issue-triage',

  async start() {
    if (running) return;
    running = true;
    config = await loadTriageConfig();

    const pollInterval = config?.pollIntervalMs || 300_000; // 5 min default
    log.info(` Starting (${pollInterval / 1000}s poll)`);

    writeHeartbeat('idle');

    // Subscribe for instant wake-up
    try {
      _unsubscribe = await subscribe('issue-triage', () => {
        if (!triageRunning) poll();
      });
    } catch {}

    // Initial poll after short delay (let other agents start first)
    setTimeout(() => poll(), 15_000);

    // Regular polling
    pollTimer = setInterval(() => {
      writeHeartbeat(triageRunning ? 'processing' : 'idle');
      poll();
    }, pollInterval);
  },

  async stop() {
    running = false;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (_unsubscribe) { _unsubscribe(); _unsubscribe = null; }
    writeHeartbeat('stopped');
    log.info(' Stopped');
  },
};
