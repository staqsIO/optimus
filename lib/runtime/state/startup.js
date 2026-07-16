import { createHash } from 'crypto';
import { query } from '../../db.js';
import { createLogger } from '../../logger.js';
const log = createLogger('runtime/startup');

/**
 * Sync agent config hashes into the DB.
 * The AgentLoop computes SHA-256 from the MERGED config (disk + DB overrides) and
 * guardCheck compares against this row. We MUST hash the same merged config here —
 * hashing the plain disk `agents.json` disagrees for any agent with a DB override
 * (e.g. the orchestrator/reviewer model overrides) and blocks every task with
 * 'config_hash_mismatch'. This matters most for the M1 runner (runner.js), which
 * runs this on every restart and writes hashes for ALL agents — clobbering the
 * API process's merged hash for overridden agents and freezing its pipeline.
 * If the merged load fails (transient DB error at boot), skip silently —
 * AgentLoop.start() writes the authoritative per-agent hash anyway.
 */
export async function syncConfigHashes() {
  let merged;
  try {
    const { loadMergedConfig } = await import('../config-loader.js');
    merged = await loadMergedConfig();
  } catch (err) {
    log.warn(`syncConfigHashes skipped — merged config load failed: ${err.message}`);
    return;
  }
  for (const [agentId, config] of Object.entries(merged.agents)) {
    const hash = createHash('sha256')
      .update(JSON.stringify(config))
      .digest('hex')
      .slice(0, 16);

    const result = await query(
      `UPDATE agent_graph.agent_configs SET config_hash = $1 WHERE id = $2 AND config_hash != $1`,
      [hash, agentId]
    );
    if (result.rowCount > 0) {
      log.info(`Updated ${agentId} config_hash → ${hash}`);
    }
  }
}

/**
 * Ensure today's daily budget exists (G1 financial gate).
 */
export async function ensureDailyBudget() {
  const dailyBudget = parseFloat(process.env.DAILY_BUDGET_USD || '20');

  const existing = await query(
    `SELECT id FROM agent_graph.budgets WHERE scope = 'daily' AND period_start = CURRENT_DATE`
  );

  if (existing.rows.length === 0) {
    await query(
      `INSERT INTO agent_graph.budgets (scope, scope_id, allocated_usd, period_start, period_end)
       VALUES ('daily', 'default', $1, CURRENT_DATE, CURRENT_DATE)`,
      [dailyBudget]
    );
    log.info(`Daily budget created: $${dailyBudget}`);
  }
}

/**
 * Release any leaked budget reservations from prior process lifetimes.
 *
 * Reservations are made before an LLM call and released/committed after.
 * If the process is killed mid-call (Railway redeploy, OOM, manual restart),
 * the reservation stays in the DB with no committer to release it. Over a
 * day of redeploys, reserved_usd can accumulate to the point where the G1
 * gate rejects every new claim despite plenty of real budget remaining.
 *
 * At startup we know nothing is in flight — any reserved_usd > 0 is
 * unambiguously stale and can be safely zeroed. Runs on every boot.
 *
 * NOTE: assumes a single autobot-inbox process. With horizontal scaling
 * this would need a per-process reservation table with TTL instead.
 */
export async function releaseStaleReservations() {
  const result = await query(
    `UPDATE agent_graph.budgets
        SET reserved_usd = 0,
            updated_at = now()
      WHERE reserved_usd > 0
      RETURNING scope, period_start, account_id, reserved_usd AS released_usd`
  );
  for (const row of result.rows) {
    log.warn(
      `Released stale reservation: scope=${row.scope} period=${row.period_start} ` +
      `account=${row.account_id || 'global'} amount=$${row.released_usd}`
    );
  }
  if (result.rows.length === 0) {
    log.info('No stale budget reservations to release');
  }
}

/**
 * Log a deploy/startup event for audit trail.
 * @param {object} [extra] - Additional metadata (e.g. { runner_id, hostname })
 */
export async function logDeployEvent(extra = {}) {
  try {
    const { execFileSync } = await import('child_process');
    let gitSha = null;
    try {
      gitSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
        encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {}
    const metadata = {
      node_version: process.version,
      pid: process.pid,
      ...extra,
    };
    await query(
      `INSERT INTO agent_graph.deploy_events (event_type, git_sha, metadata)
       VALUES ('pipeline_start', $1, $2)`,
      [gitSha, JSON.stringify(metadata)]
    );
    log.info(`Deploy event logged (pipeline_start, ${gitSha || 'no-git'})`);
  } catch (err) {
    // Table may not exist yet (pre-migration) — non-fatal
    log.warn(`Skip: ${err.message}`);
  }
}
