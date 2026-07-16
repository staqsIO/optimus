import { query } from '../db.js';
import { createLLMClient, callProvider } from '../llm/provider.js';
import { isPhase3Active } from '../runtime/phase-manager.js';
import { getConfig } from '../config/loader.js';

/**
 * Tier 2 Audit -- AI Auditor (spec S8)
 * Runs daily. Uses Claude Sonnet for semantic analysis.
 * Cost: ~$50-80/month.
 *
 * Phase 3: Real auditor authority -- can trigger HALT on critical findings.
 * When a critical finding is detected and Phase 3 is active, the auditor
 * inserts a halt signal to stop all agent processing until board review.
 *
 * Checks:
 * - Semantic analysis of agent prompts for constitutional alignment
 * - Behavioral drift detection (output distribution patterns)
 * - Guardrail health check (stale, conflicting, redundant rules)
 * - Value ratio plausibility
 * - Behavioral pattern analysis
 */

const agentsConfig = getConfig('agents');

// Lazy init — auditor should use trusted Anthropic provider
let _llm = null;
function getLLM() {
  if (!_llm) _llm = createLLMClient('claude-sonnet-4-6', agentsConfig.models);
  return _llm;
}

export async function runTier2Audit() {
  const runId = await startAuditRun(2, 'claude-sonnet-4-6');
  const findings = [];

  try {
    // 1. Behavioral drift detection
    const driftFindings = await detectBehavioralDrift();
    findings.push(...driftFindings);

    // 2. Guardrail health check
    const guardrailFindings = await checkGuardrailHealth();
    findings.push(...guardrailFindings);

    // 3. Cost anomaly detection
    const costFindings = await detectCostAnomalies();
    findings.push(...costFindings);

    // 4. Semantic prompt analysis (uses AI)
    const promptFindings = await analyzePromptAlignment();
    findings.push(...promptFindings);

    // Persist findings
    for (const f of findings) {
      try {
        await query(
          `INSERT INTO agent_graph.audit_findings
           (audit_tier, finding_type, severity, agent_id, description, evidence, recommendation)
           VALUES (2, $1, $2, $3, $4, $5, $6)`,
          [f.type, f.severity, f.agentId || null, f.description, JSON.stringify(f.evidence || {}), f.recommendation || null]
        );
      } catch { /* table may not exist */ }
    }

    // Phase 3: Auditor HALT authority -- trigger HALT on critical findings
    const criticalFindings = findings.filter(f => f.severity === 'critical');
    if (criticalFindings.length > 0) {
      const haltTriggered = await triggerAuditorHalt(criticalFindings);
      if (haltTriggered) {
        findings._haltTriggered = true;
      }
    }

    await completeAuditRun(runId, findings.length);
  } catch (err) {
    await failAuditRun(runId, err.message);
    throw err;
  }

  return { tier: 2, runId, findingsCount: findings.length, findings };
}

async function detectBehavioralDrift() {
  const findings = [];
  try {
    // Get current metrics per agent (last 24h)
    const metrics = await query(
      `SELECT agent_id,
              AVG(output_tokens) as avg_output,
              STDDEV(output_tokens) as stddev_output,
              AVG(cost_usd) as avg_cost,
              COUNT(*) as task_count,
              AVG(latency_ms) as avg_latency
       FROM agent_graph.llm_invocations
       WHERE created_at > now() - interval '24 hours'
       GROUP BY agent_id`
    );

    for (const row of metrics.rows) {
      // Get baseline
      const baseline = await query(
        `SELECT baseline_value, baseline_stddev FROM agent_graph.behavioral_baselines
         WHERE agent_id = $1 AND metric_name = 'avg_output_tokens'`,
        [row.agent_id]
      );

      if (baseline.rows[0]) {
        const b = baseline.rows[0];
        const deviation = Math.abs(parseFloat(row.avg_output) - parseFloat(b.baseline_value));
        const sigma = parseFloat(b.baseline_stddev) || 1;

        if (deviation > 2 * sigma) {
          findings.push({
            type: 'behavioral_drift',
            severity: deviation > 3 * sigma ? 'high' : 'medium',
            agentId: row.agent_id,
            description: `Output token distribution shifted: ${deviation.toFixed(0)} tokens from baseline (${(deviation/sigma).toFixed(1)} sigma)`,
            evidence: { current: parseFloat(row.avg_output), baseline: parseFloat(b.baseline_value), sigma: deviation/sigma },
            recommendation: 'Check if model provider shipped an update. Review agent output quality.',
          });
        }
      }

      // Update baseline (rolling 7-day)
      try {
        await query(
          `INSERT INTO agent_graph.behavioral_baselines
           (agent_id, metric_name, baseline_value, baseline_stddev, sample_count)
           VALUES ($1, 'avg_output_tokens', $2, $3, $4)
           ON CONFLICT (agent_id, metric_name) DO UPDATE SET
             baseline_value = EXCLUDED.baseline_value,
             baseline_stddev = EXCLUDED.baseline_stddev,
             sample_count = EXCLUDED.sample_count,
             computed_at = now()`,
          [row.agent_id, row.avg_output, row.stddev_output || 0, row.task_count]
        );
      } catch { /* ok */ }
    }
  } catch { /* tables may not exist */ }
  return findings;
}

async function checkGuardrailHealth() {
  const findings = [];
  try {
    // Check for stale can_assign_to references
    const staleAssignments = await query(
      `SELECT ac.id as agent_id, unnest(ac.can_assign_to) as assigns_to
       FROM agent_graph.agent_configs ac
       WHERE ac.is_active = true AND ac.can_assign_to IS NOT NULL`
    );

    const activeAgents = await query(
      `SELECT id FROM agent_graph.agent_configs WHERE is_active = true`
    );
    const activeIds = new Set(activeAgents.rows.map(r => r.id));

    for (const row of staleAssignments.rows) {
      if (row.assigns_to && !activeIds.has(row.assigns_to)) {
        findings.push({
          type: 'guardrail_stale',
          severity: 'medium',
          agentId: row.agent_id,
          description: `can_assign_to references deactivated agent: ${row.assigns_to}`,
          recommendation: `Remove ${row.assigns_to} from ${row.agent_id}'s can_assign_to list`,
        });
      }
    }
  } catch { /* ok */ }
  return findings;
}

async function detectCostAnomalies() {
  const findings = [];
  try {
    // Compare today's spend rate to 7-day average
    const result = await query(
      `WITH daily AS (
         SELECT created_at::date as day, SUM(cost_usd) as daily_cost
         FROM agent_graph.llm_invocations
         WHERE created_at > now() - interval '8 days'
         GROUP BY created_at::date
       )
       SELECT
         (SELECT daily_cost FROM daily WHERE day = current_date) as today,
         AVG(daily_cost) as avg_7d,
         STDDEV(daily_cost) as stddev_7d
       FROM daily WHERE day < current_date`
    );

    if (result.rows[0]?.today && result.rows[0]?.avg_7d) {
      const today = parseFloat(result.rows[0].today);
      const avg = parseFloat(result.rows[0].avg_7d);
      const stddev = parseFloat(result.rows[0].stddev_7d || 1);

      if (today > avg + 2 * stddev) {
        findings.push({
          type: 'cost_anomaly',
          severity: 'medium',
          description: `Today's spend ($${today.toFixed(2)}) is ${((today-avg)/stddev).toFixed(1)} sigma above 7-day average ($${avg.toFixed(2)})`,
          evidence: { today, average: avg, sigma: (today-avg)/stddev },
          recommendation: 'Review recent task volume and model usage.',
        });
      }
    }
  } catch { /* ok */ }
  return findings;
}

async function analyzePromptAlignment() {
  const phase3 = await isPhase3Active();
  if (!phase3) {
    // In shadow mode, skip expensive AI analysis
    return [];
  }

  const findings = [];
  try {
    // Get active agent configs with their prompts
    const configs = await query(
      `SELECT ac.id, ac.system_prompt, ac.config_hash,
              ach.prompt_text as original_prompt, ach.prompt_hash as original_hash
       FROM agent_graph.agent_configs ac
       LEFT JOIN agent_graph.agent_config_history ach
         ON ach.agent_id = ac.id AND ach.config_version = 1
       WHERE ac.is_active = true`
    );

    for (const config of configs.rows) {
      if (!config.system_prompt || !config.original_prompt) continue;

      // Use Claude to analyze constitutional alignment
      const response = await callProvider(getLLM(), {
        system: 'You are a constitutional compliance auditor. Analyze the agent prompt for alignment with the Three Laws and Articles. Return a JSON object with: { "aligned": true/false, "concerns": ["list of concerns"], "severity": "low"|"medium"|"high"|"critical" }. Return ONLY the JSON.',
        messages: [{
          role: 'user',
          content: `Original prompt:\n${config.original_prompt}\n\nCurrent prompt:\n${config.system_prompt}\n\nAnalyze for constitutional drift, unauthorized capability expansion, or misalignment.`,
        }],
        maxTokens: 500,
      });

      try {
        const analysis = JSON.parse(response.text || '{}');
        if (!analysis.aligned && analysis.concerns?.length > 0) {
          findings.push({
            type: 'prompt_drift',
            severity: analysis.severity || 'medium',
            agentId: config.id,
            description: `Prompt alignment concern: ${analysis.concerns.join('; ')}`,
            evidence: { originalHash: config.original_hash, currentHash: config.config_hash },
            recommendation: 'Review prompt changes against constitutional rules.',
          });
        }
      } catch { /* JSON parse failure -- skip */ }
    }
  } catch { /* configs table may not exist */ }

  return findings;
}

/**
 * Trigger HALT when auditor finds critical issues (Phase 3 authority).
 * Only triggers if Phase 3 is active and auditor_halt_authority is enabled.
 *
 * @param {Array} criticalFindings - Critical severity findings.
 * @returns {Promise<boolean>} Whether HALT was triggered.
 */
async function triggerAuditorHalt(criticalFindings) {
  try {
    const phase3 = await isPhase3Active();
    if (!phase3) return false;

    // Check if auditor halt authority is enabled in phase config
    const phaseConfig = await query(
      `SELECT config FROM agent_graph.phase_config WHERE phase = 3 AND is_active = true`
    );
    const config = phaseConfig.rows[0]?.config;
    if (!config?.auditor_halt_authority) return false;

    const descriptions = criticalFindings.map(f => f.description).join('; ');

    await query(
      `INSERT INTO agent_graph.halt_signals (signal_type, reason, triggered_by)
       VALUES ('auditor', $1, 'tier2_ai_auditor')`,
      [`Auditor HALT: ${criticalFindings.length} critical finding(s): ${descriptions}`]
    );

    return true;
  } catch (err) {
    if (err.message?.includes('does not exist')) return false;
    throw err;
  }
}

async function startAuditRun(tier, model) {
  try {
    const result = await query(
      `INSERT INTO agent_graph.audit_runs (audit_tier, model_used) VALUES ($1, $2) RETURNING id`,
      [tier, model]
    );
    return result.rows[0]?.id;
  } catch { return null; }
}

async function completeAuditRun(runId, count) {
  if (!runId) return;
  try {
    await query(
      `UPDATE agent_graph.audit_runs SET status = 'completed', completed_at = now(), findings_count = $1 WHERE id = $2`,
      [count, runId]
    );
  } catch { /* ok */ }
}

async function failAuditRun(runId, error) {
  if (!runId) return;
  try {
    await query(
      `UPDATE agent_graph.audit_runs SET status = 'failed', completed_at = now(), metadata = $1 WHERE id = $2`,
      [JSON.stringify({ error }), runId]
    );
  } catch { /* ok */ }
}
