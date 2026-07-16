import { query } from '../db.js';
import { recordThreatEvent } from '../runtime/escalation-manager.js';

/**
 * Tier 1 Audit -- Deterministic (spec S8)
 * Runs every agent cycle. No AI. $0/month.
 * Catches ~70% of violations.
 */

// Global lock: only one audit runs at a time across all agent loops
let _auditRunning = false;
let _lastGlobalAuditAt = 0;
const AUDIT_INTERVAL_MS = 300_000; // 5 min (was 60s per-agent = 8x overhead)

export async function runTier1Audit() {
  // Centralized: skip if another agent loop already ran audit recently
  if (_auditRunning || Date.now() - _lastGlobalAuditAt < AUDIT_INTERVAL_MS) {
    return { tier: 1, findingsCount: 0, findings: [], skipped: true };
  }
  _auditRunning = true;
  _lastGlobalAuditAt = Date.now();

  const findings = [];

  // 1. Hash chain verification (bounded to last 10 min, not 1 hour)
  //
  // Order the chain by chain_seq — NOT created_at — to match the writer in
  // lib/runtime/state/state-machine.js (which reads prev_hash by chain_seq DESC).
  // Under sub-second retry storms created_at can be earlier than commit/chain
  // order, so ordering the auditor by created_at would compare a row against
  // the wrong predecessor and raise a false-positive CRITICAL "Hash chain
  // broken" finding. The auditor and writer MUST always order by the same
  // column — see migration 091 / STAQPRO-273. The created_at > now() window
  // below only bounds WHICH rows to check; chain_seq bounds their ORDER.
  try {
    const chainResult = await query(
      `SELECT COUNT(*) as broken FROM (
         SELECT id, hash_chain_prev, hash_chain_current,
           LAG(hash_chain_current) OVER (PARTITION BY work_item_id ORDER BY chain_seq) as expected_prev
         FROM agent_graph.state_transitions
         WHERE created_at > now() - interval '10 minutes'
       ) sub WHERE hash_chain_prev IS NOT NULL AND expected_prev IS NOT NULL AND hash_chain_prev != expected_prev`
    );
    if (parseInt(chainResult.rows[0]?.broken || 0) > 0) {
      findings.push({ type: 'security', severity: 'critical', description: `Hash chain broken: ${chainResult.rows[0].broken} mismatches in last 10min` });
    }
  } catch { /* table may not exist */ }

  // 2. Budget limit check
  try {
    const budgetResult = await query(
      `SELECT id, spent_usd, allocated_usd FROM agent_graph.budgets
       WHERE period_start <= now() AND period_end > now() AND spent_usd > allocated_usd`
    );
    for (const row of budgetResult.rows) {
      findings.push({ type: 'constitutional_violation', severity: 'high', description: `Budget exceeded: $${row.spent_usd}/$${row.allocated_usd}` });
    }
  } catch (err) {
    // Budget check failure is itself a finding — fail-closed
    findings.push({ type: 'security', severity: 'medium', description: `Budget check failed: ${err.message}` });
  }

  // 3. Active halt signals check
  try {
    const haltResult = await query(`SELECT COUNT(*) as active FROM agent_graph.halt_signals WHERE is_active = true`);
    const activeHalts = parseInt(haltResult.rows[0]?.active || 0);
    if (activeHalts > 0) {
      findings.push({ type: 'compliance', severity: 'info', description: `${activeHalts} active halt signal(s)` });
    }
  } catch { /* ok */ }

  // 4. Stuck tasks (should have been caught by reaper)
  try {
    const stuckResult = await query(
      `SELECT COUNT(*) as stuck FROM agent_graph.work_items
       WHERE status = 'in_progress' AND updated_at < now() - interval '30 minutes'`
    );
    if (parseInt(stuckResult.rows[0]?.stuck || 0) > 0) {
      findings.push({ type: 'performance', severity: 'medium', description: `${stuckResult.rows[0].stuck} tasks stuck in_progress > 30min` });
    }
  } catch { /* ok */ }

  // 5. Agent config consistency
  try {
    const configResult = await query(
      `SELECT id, config_hash FROM agent_graph.agent_configs WHERE is_active = true AND config_hash IS NULL`
    );
    for (const row of configResult.rows) {
      findings.push({ type: 'security', severity: 'high', description: `Agent ${row.id} has no config_hash` });
    }
  } catch { /* ok */ }

  // Persist findings
  try {
    for (const f of findings) {
      try {
        await query(
          `INSERT INTO agent_graph.audit_findings (audit_tier, finding_type, severity, description)
           VALUES (1, $1, $2, $3)`,
          [f.type, f.severity, f.description]
        );
      } catch { /* table may not exist */ }
    }

    // Record security/constitutional findings as threat events (spec §8)
    for (const f of findings) {
      if (f.severity === 'info') continue; // skip informational
      try {
        const threatClass = f.type === 'security' ? 'INTEGRITY_FAILURE' : 'POLICY_VIOLATION';
        const severity = f.severity === 'critical' ? 'CRITICAL'
          : f.severity === 'high' ? 'HIGH'
          : f.severity === 'medium' ? 'MEDIUM' : 'LOW';
        await recordThreatEvent({
          sourceType: 'tier1_audit',
          scopeType: 'org',
          scopeId: '*',
          threatClass,
          severity,
          detail: { description: f.description, findingType: f.type },
        });
      } catch { /* threat_memory table may not exist yet */ }
    }
  } finally {
    _auditRunning = false;
  }

  return { tier: 1, findingsCount: findings.length, findings };
}
