/**
 * Self-Improvement Scanner — Extended with Exploration System (ADR-021)
 *
 * Two modes:
 * 1. Legacy weekly scan (3 checks: failures, budget, stale config)
 * 2. Exploration mode (pluggable domains, configurable schedule, two-track routing)
 *
 * Exploration mode runs on the M1 runner with EXPLORATION_ENABLED=true.
 * Legacy scan runs weekly on the primary instance (unchanged behavior).
 *
 * Exploration domains are pluggable: each domain module exports
 * { domain: string, analyze: () => Promise<Finding[]> }.
 *
 * Two-track intent routing:
 * - Tactical: cost < $0.50, no schema/config changes, matches known patterns → auto-route
 * - Strategic: everything else → board approval
 */

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { query } from '../../db.js';
import { createIntent } from '../intent-manager.js';
import { getNextDomains, recordDomainRun, checkExplorationCircuitBreaker } from '../exploration/domain-selector.js';
import { recordExplorationCycle } from '../../graph/claw-learning.js';
import { createLogger } from '../../logger.js';
const log = createLogger('runtime/self-improve-scanner');

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENTS_CONFIG_PATH = join(__dirname, '..', '..', 'config', 'agents.json');
const AGENTS_DIR = join(__dirname, '..', 'agents');

// Domain modules registry
const DOMAIN_MODULES = {
  pipeline_health: () => import('../exploration/domains/pipeline-health.js'),
  test_health: () => import('../exploration/domains/test-health.js'),
  dependency_audit: () => import('../exploration/domains/dependency-audit.js'),
  code_quality: () => import('../exploration/domains/code-quality.js'),
  spec_alignment: () => import('../exploration/domains/spec-alignment.js'),
  config_drift: () => import('../exploration/domains/config-drift.js'),
  security_scan: () => import('../exploration/domains/security-scan.js'),
  performance: () => import('../exploration/domains/performance.js'),
};

// Known tactical patterns (auto-route without board approval)
const TACTICAL_PATTERNS = new Set(['test_fix', 'dep_patch', 'lint_fix', 'dead_code', 'stuck_task', 'retry_excess']);

/**
 * Run self-improvement scan. Skips if last scan was <6 days ago (deploy-safe).
 * Called by scheduleService in index.js (weekly, 30-min startup delay).
 */
export async function runSelfImproveScan() {
  // DB-persisted guard: check if we created a self-improve intent recently
  try {
    const recent = await query(
      `SELECT 1 FROM agent_graph.agent_intents
       WHERE trigger_context->>'source' = 'self-improve-scanner'
         AND created_at > now() - interval '6 days'
       LIMIT 1`
    );
    if (recent.rows.length > 0) {
      return; // already ran this week
    }
  } catch (err) {
    log.warn(`Recency check skipped: ${err.message}`);
  }

  log.info('Starting weekly quality scan');

  const checks = [
    checkFailedTaskPatterns,
    checkBudgetEfficiency,
    checkStaleConfig,
  ];

  let findingsTotal = 0;
  for (const check of checks) {
    try {
      const findings = await check();
      findingsTotal += findings;
    } catch (err) {
      log.error(`Check failed: ${check.name}: ${err.message}`);
    }
  }

  log.info(`Scan complete: ${findingsTotal} finding(s)`);
  return findingsTotal;
}

// ============================================================
// EXPLORATION MODE (ADR-021)
// ============================================================

/**
 * Run a full exploration cycle across enabled domains.
 * Called on configurable interval (default: 4h) when EXPLORATION_ENABLED=true.
 *
 * @param {Object} explorationConfig - From agents.json claw-explorer config
 * @returns {Promise<number>} Total findings across all domains
 */
export async function runExplorationCycle(explorationConfig = {}) {
  const {
    perCycleBudgetUsd = 1.00,
    dailyBudgetUsd = 5.00,
    cycleTimeoutMs = 1_800_000,
    domainTimeoutMs = 600_000,
    maxIterationsPerDomain = 5,
    quietHoursStart = 0,
    quietHoursEnd = 6,
  } = explorationConfig;

  // Quiet hours check
  const hour = new Date().getHours();
  if (hour >= quietHoursStart && hour < quietHoursEnd) {
    log.info('Quiet hours — skipping exploration cycle');
    return 0;
  }

  // Circuit breaker check
  const circuitBreaker = await checkExplorationCircuitBreaker();
  if (circuitBreaker.active && circuitBreaker.level === 'pause') {
    log.info(`Circuit breaker: ${circuitBreaker.reason}`);
    await createIntent({
      agentId: 'claw-explorer',
      intentType: 'governance',
      decisionTier: 'strategic',
      title: 'Exploration circuit breaker activated — pausing',
      reasoning: circuitBreaker.reason,
      proposedAction: { type: 'pause_exploration' },
      triggerContext: { source: 'exploration-circuit-breaker' },
      budgetPerFire: 0,
    });
    return 0;
  }

  // Daily budget check
  const dailySpend = await getExplorationDailySpend();
  if (dailySpend >= dailyBudgetUsd) {
    log.info(`Daily budget exhausted ($${dailySpend.toFixed(2)}/$${dailyBudgetUsd})`);
    return 0;
  }

  const cycleId = `cycle-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const cycleStart = Date.now();
  log.info(`Starting exploration cycle ${cycleId}`);

  // Get domains to explore
  const domains = await getNextDomains(maxIterationsPerDomain);
  if (domains.length === 0) {
    log.info('No enabled domains — skipping');
    return 0;
  }

  let totalFindings = 0;
  let cycleCost = 0;

  for (const domainEntry of domains) {
    // Cycle timeout
    if (Date.now() - cycleStart > cycleTimeoutMs) {
      log.info('Cycle timeout reached');
      break;
    }

    // Per-cycle budget
    if (cycleCost >= perCycleBudgetUsd) {
      log.info('Per-cycle budget exhausted');
      break;
    }

    const domainStart = Date.now();
    let domainFindings = 0;

    try {
      // Load domain module
      const moduleLoader = DOMAIN_MODULES[domainEntry.domain];
      if (!moduleLoader) {
        log.warn(`Unknown domain: ${domainEntry.domain}`);
        continue;
      }

      const domainModule = await moduleLoader();

      // Run analysis with timeout
      const findings = await Promise.race([
        domainModule.analyze(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('domain timeout')), domainTimeoutMs)
        ),
      ]);

      domainFindings = findings.length;
      totalFindings += domainFindings;

      // Route findings as intents
      for (const finding of findings) {
        await routeFinding(finding, domainEntry.domain, cycleId);
      }

      // Record domain run
      await recordDomainRun(domainEntry.domain, domainFindings, cycleId);

      // Log to exploration_log
      await query(
        `INSERT INTO agent_graph.exploration_log
         (cycle_id, domain, findings_count, intents_created, cost_usd, duration_ms, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [cycleId, domainEntry.domain, domainFindings, domainFindings,
         0, Date.now() - domainStart, JSON.stringify({ findings: findings.map(f => f.title) })]
      );

      // Record to Neo4j knowledge graph (non-blocking)
      recordExplorationCycle(cycleId, domainEntry.domain, findings, Date.now() - domainStart).catch(() => {});

      log.info(`${domainEntry.domain}: ${domainFindings} finding(s) in ${Date.now() - domainStart}ms`);

    } catch (err) {
      log.error(`Domain ${domainEntry.domain} error: ${err.message}`);
      await query(
        `INSERT INTO agent_graph.exploration_log
         (cycle_id, domain, findings_count, intents_created, cost_usd, duration_ms, error)
         VALUES ($1, $2, 0, 0, 0, $3, $4)`,
        [cycleId, domainEntry.domain, Date.now() - domainStart, err.message]
      );
    }
  }

  log.info(`Cycle ${cycleId} complete: ${totalFindings} finding(s) across ${domains.length} domain(s) in ${Date.now() - cycleStart}ms`);
  return totalFindings;
}

/**
 * Route a finding as either tactical (auto-route) or strategic (board approval).
 */
async function routeFinding(finding, domain, cycleId) {
  // Determine if tactical or strategic
  const isTactical = TACTICAL_PATTERNS.has(finding.pattern) ||
    (finding.severity === 'low' && !finding.requiresBoardReview);

  const decisionTier = isTactical ? 'tactical' : 'strategic';
  const assignTo = isTactical ? 'orchestrator' : null;

  await createIntent({
    agentId: 'claw-explorer',
    intentType: 'observation',
    decisionTier,
    title: finding.title,
    reasoning: `[${domain}] ${finding.title}. Evidence: ${JSON.stringify(finding.evidence).slice(0, 300)}`,
    proposedAction: {
      type: finding.proposedCampaign ? 'campaign' : 'create_work_item',
      payload: finding.proposedCampaign || {
        type: 'task',
        title: finding.title,
        description: `Exploration finding from ${domain} domain.`,
        assigned_to: assignTo,
        priority: finding.severity === 'high' ? 1 : finding.severity === 'medium' ? 2 : 3,
        metadata: {
          source: 'exploration',
          domain,
          cycle_id: cycleId,
          severity: finding.severity,
          evidence: finding.evidence,
        },
      },
    },
    triggerContext: {
      source: 'exploration',
      domain,
      cycle_id: cycleId,
      pattern: finding.pattern || `exploration_${domain}`,
    },
    budgetPerFire: 0.05,
  });
}

/**
 * Get total exploration spend for today.
 */
async function getExplorationDailySpend() {
  const result = await query(
    `SELECT COALESCE(SUM(cost_usd), 0) AS total
     FROM agent_graph.exploration_log
     WHERE created_at >= CURRENT_DATE`
  );
  return parseFloat(result.rows[0]?.total || '0');
}

// ============================================================
// LEGACY CHECKS (unchanged from original)
// ============================================================

/**
 * Check 1: Failed task patterns — which agents fail most and why?
 */
async function checkFailedTaskPatterns() {
  const result = await query(
    `SELECT
       w.assigned_to AS agent,
       COUNT(*) AS fail_count,
       COUNT(*) FILTER (WHERE w.created_at > now() - interval '7 days') AS recent_fails
     FROM agent_graph.state_transitions st
     JOIN agent_graph.work_items w ON w.id = st.work_item_id
     WHERE st.to_state = 'failed'
       AND st.created_at > now() - interval '30 days'
     GROUP BY w.assigned_to
     HAVING COUNT(*) >= 3
     ORDER BY fail_count DESC`
  );

  let findings = 0;
  for (const row of result.rows) {
    await createIntent({
      agentId: 'architect',
      intentType: 'observation',
      decisionTier: 'tactical',
      title: `Agent "${row.agent}" has ${row.fail_count} failures (30d)`,
      reasoning: `${row.agent} failed ${row.fail_count} tasks in the last 30 days ` +
        `(${row.recent_fails} in the last 7 days). Investigate failure patterns and ` +
        `consider prompt/config adjustments.`,
      proposedAction: {
        type: 'create_work_item',
        payload: {
          type: 'task',
          title: `Investigate ${row.agent} failure pattern (${row.fail_count} fails/30d)`,
          description: `Agent ${row.agent} has a high failure rate. Review state_transitions for root causes.`,
          assigned_to: 'architect',
          priority: 1,
          metadata: {
            source: 'self-improve-scanner',
            check: 'failed_task_patterns',
            agent: row.agent,
            fail_count: row.fail_count,
            recent_fails: row.recent_fails,
          },
        },
      },
      triggerContext: {
        pattern: `self_improve_failures_${row.agent}`,
        source: 'self-improve-scanner',
        agent: row.agent,
      },
      budgetPerFire: 0.10,
    });
    findings++;
  }
  return findings;
}

/**
 * Check 2: Budget efficiency — cost per completed task by agent.
 * Flags agents whose average cost is >2x the fleet average.
 */
async function checkBudgetEfficiency() {
  const result = await query(
    `SELECT
       w.assigned_to AS agent,
       COUNT(*) AS completed_count,
       COALESCE(SUM(
         (w.metadata->>'total_cost')::numeric
       ), 0) AS total_cost
     FROM agent_graph.work_items w
     WHERE w.status = 'completed'
       AND w.created_at > now() - interval '30 days'
       AND w.metadata->>'total_cost' IS NOT NULL
     GROUP BY w.assigned_to
     HAVING COUNT(*) >= 5`
  );

  if (result.rows.length < 2) return 0; // need at least 2 agents to compare

  const agents = result.rows.map(r => ({
    agent: r.agent,
    count: parseInt(r.completed_count),
    totalCost: parseFloat(r.total_cost),
    avgCost: parseFloat(r.total_cost) / parseInt(r.completed_count),
  }));

  const fleetAvg = agents.reduce((sum, a) => sum + a.avgCost, 0) / agents.length;
  let findings = 0;

  for (const a of agents) {
    if (a.avgCost > fleetAvg * 2 && a.avgCost > 0.05) {
      await createIntent({
        agentId: 'architect',
        intentType: 'observation',
        decisionTier: 'tactical',
        title: `Agent "${a.agent}" costs $${a.avgCost.toFixed(3)}/task (fleet avg: $${fleetAvg.toFixed(3)})`,
        reasoning: `${a.agent} averages $${a.avgCost.toFixed(3)} per completed task — ` +
          `${(a.avgCost / fleetAvg).toFixed(1)}x the fleet average of $${fleetAvg.toFixed(3)}. ` +
          `Review if model tier, prompt length, or retry patterns can be optimized.`,
        proposedAction: {
          type: 'create_work_item',
          payload: {
            type: 'task',
            title: `Optimize ${a.agent} cost efficiency ($${a.avgCost.toFixed(3)}/task)`,
            description: `${a.agent} is ${(a.avgCost / fleetAvg).toFixed(1)}x fleet average cost. Investigate.`,
            assigned_to: 'architect',
            priority: 1,
            metadata: {
              source: 'self-improve-scanner',
              check: 'budget_efficiency',
              agent: a.agent,
              avg_cost: a.avgCost,
              fleet_avg: fleetAvg,
            },
          },
        },
        triggerContext: {
          pattern: `self_improve_cost_${a.agent}`,
          source: 'self-improve-scanner',
          agent: a.agent,
        },
        budgetPerFire: 0.05,
      });
      findings++;
    }
  }
  return findings;
}

/**
 * Check 3: Stale config — agents.json entries that don't have corresponding agent files.
 */
async function checkStaleConfig() {
  if (!existsSync(AGENTS_CONFIG_PATH)) return 0;

  let config;
  try {
    config = JSON.parse(readFileSync(AGENTS_CONFIG_PATH, 'utf-8'));
  } catch {
    return 0;
  }

  const agentIds = Object.keys(config.agents || {});
  const stale = [];

  for (const agentId of agentIds) {
    // Check common file naming patterns
    const possibleFiles = [
      join(AGENTS_DIR, `${agentId}.js`),
      join(AGENTS_DIR, `${agentId.replace(/-/g, '_')}.js`),
      join(AGENTS_DIR, agentId, 'index.js'),
    ];
    const exists = possibleFiles.some(f => existsSync(f));
    if (!exists) {
      stale.push(agentId);
    }
  }

  if (stale.length > 0) {
    await createIntent({
      agentId: 'architect',
      intentType: 'observation',
      decisionTier: 'tactical',
      title: `Stale agent config: ${stale.join(', ')}`,
      reasoning: `agents.json defines ${stale.length} agent(s) without corresponding files ` +
        `in src/agents/: ${stale.join(', ')}. Either remove from config or create the agent file.`,
      proposedAction: {
        type: 'create_work_item',
        payload: {
          type: 'task',
          title: `Clean up stale agent config: ${stale.join(', ')}`,
          description: `${stale.length} agents in config without implementation files.`,
          assigned_to: 'architect',
          priority: 0,
          metadata: {
            source: 'self-improve-scanner',
            check: 'stale_config',
            stale_agents: stale,
          },
        },
      },
      triggerContext: {
        pattern: 'self_improve_stale_config',
        source: 'self-improve-scanner',
      },
      budgetPerFire: 0.05,
    });
    return 1;
  }
  return 0;
}
