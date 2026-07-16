/**
 * Spec Drift Detector — daily check for spec-vs-implementation gaps.
 *
 * Reads SPEC.md sections and checks whether the codebase implements what
 * the spec says should exist. Creates strategic intents for board review
 * when gaps are found.
 *
 * Zero LLM cost — pure SQL + filesystem checks.
 * P3: transparency by structure — gaps are surfaced as intents, not hidden.
 *
 * Checks:
 *   §3 Task Graph: required tables exist in information_schema
 *   §5 Guardrails: G1-G7 completeness in config/gates.json
 *   §9 Kill Switch: halt_signals table + dead-man-switch active
 *   §14 Phased Execution: phase-1 exit criteria metrics
 */

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { query } from '../../db.js';
import { createIntent } from '../intent-manager.js';
import { createLogger } from '../../logger.js';
const log = createLogger('runtime/spec-drift-detector');

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = join(__dirname, '..', '..', 'config');

/**
 * Run all spec drift checks. Creates intents for any gaps found.
 * Called by scheduleService in index.js (daily, 20-min startup delay).
 */
export async function checkSpecDrift() {
  const checks = [
    checkTaskGraphTables,
    checkGuardrailCompleteness,
    checkKillSwitch,
    checkPhase1Metrics,
  ];

  let gapsFound = 0;
  for (const check of checks) {
    try {
      const found = await check();
      gapsFound += found;
    } catch (err) {
      log.error(`Check failed: ${check.name}: ${err.message}`);
    }
  }

  if (gapsFound > 0) {
    log.info(`Found ${gapsFound} gap(s)`);
  }
  return gapsFound;
}

/**
 * §3 Task Graph: verify required tables exist.
 */
async function checkTaskGraphTables() {
  const requiredTables = [
    { schema: 'agent_graph', table: 'work_items' },
    { schema: 'agent_graph', table: 'edges' },
    { schema: 'agent_graph', table: 'state_transitions' },
    { schema: 'agent_graph', table: 'agent_intents' },
    { schema: 'agent_graph', table: 'action_proposals' },
  ];

  const result = await query(
    `SELECT table_schema, table_name
     FROM information_schema.tables
     WHERE table_schema = 'agent_graph'`
  );
  const existing = new Set(result.rows.map(r => `${r.table_schema}.${r.table_name}`));

  let gaps = 0;
  for (const { schema, table } of requiredTables) {
    if (!existing.has(`${schema}.${table}`)) {
      await createDriftIntent(
        '§3',
        `Missing table: ${schema}.${table}`,
        `SPEC §3 requires the ${table} table in the ${schema} schema, but it does not exist.`
      );
      gaps++;
    }
  }
  return gaps;
}

/**
 * §5 Guardrails: verify G1-G7 all defined in gates.json.
 */
async function checkGuardrailCompleteness() {
  const requiredGates = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7'];
  const gatesPath = join(CONFIG_DIR, 'gates.json');

  if (!existsSync(gatesPath)) {
    await createDriftIntent(
      '§5',
      'Missing gates.json configuration',
      'SPEC §5 requires constitutional gates G1-G7 but config/gates.json is missing.'
    );
    return 1;
  }

  let gates;
  try {
    gates = JSON.parse(readFileSync(gatesPath, 'utf-8'));
  } catch {
    await createDriftIntent(
      '§5',
      'Invalid gates.json configuration',
      'config/gates.json exists but cannot be parsed as JSON.'
    );
    return 1;
  }

  const definedGates = Object.keys(gates.gates || {});
  const missing = requiredGates.filter(g => !definedGates.includes(g));

  if (missing.length > 0) {
    await createDriftIntent(
      '§5',
      `Missing gates: ${missing.join(', ')}`,
      `SPEC §5 requires gates ${missing.join(', ')} but they are not defined in gates.json.`
    );
    return 1;
  }
  return 0;
}

/**
 * §9 Kill Switch: verify halt_signals table exists and dead-man-switch is active.
 */
async function checkKillSwitch() {
  let gaps = 0;

  // Check halt_signals table
  const tableResult = await query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'agent_graph' AND table_name = 'halt_signals'`
  );
  if (tableResult.rows.length === 0) {
    await createDriftIntent(
      '§9_halt_signals',
      'Missing halt_signals table',
      'SPEC §9 requires the agent_graph.halt_signals table for kill switch functionality.'
    );
    gaps++;
  }

  // Check dead-man-switch has fired recently (within 48h)
  try {
    const dmsResult = await query(
      `SELECT 1 FROM agent_graph.task_events
       WHERE event_type = 'dead_man_switch'
         AND created_at > now() - interval '48 hours'
       LIMIT 1`
    );
    if (dmsResult.rows.length === 0) {
      await createDriftIntent(
        '§9_dead_man_switch',
        'Dead-man-switch not firing',
        'No dead_man_switch event in the last 48 hours. The kill switch watchdog may be inactive.'
      );
      gaps++;
    }
  } catch (err) {
    log.warn(`dead-man-switch check skipped: ${err.message}`);
  }

  return gaps;
}

/**
 * §14 Phased Execution: verify phase-1 metrics are being collected.
 */
async function checkPhase1Metrics() {
  try {
    const result = await query(
      `SELECT 1 FROM agent_graph.task_events
       WHERE event_type = 'phase1_metrics'
         AND created_at > now() - interval '48 hours'
       LIMIT 1`
    );
    if (result.rows.length === 0) {
      await createDriftIntent(
        '§14',
        'Phase-1 metrics not collecting',
        'No phase1_metrics events in the last 48 hours. Phase-1 exit criteria cannot be evaluated without metrics.'
      );
      return 1;
    }
  } catch (err) {
    log.warn(`phase1-metrics check skipped: ${err.message}`);
  }
  return 0;
}

/**
 * Create a drift intent with dedup pattern 'spec_drift_§{section}'.
 */
async function createDriftIntent(section, title, reasoning) {
  return createIntent({
    agentId: 'architect',
    intentType: 'observation',
    decisionTier: 'strategic',
    title: `Spec drift ${section}: ${title}`,
    reasoning,
    proposedAction: {
      type: 'create_work_item',
      payload: {
        type: 'task',
        title: `Spec drift ${section}: ${title}`,
        description: reasoning,
        assigned_to: 'architect',
        priority: 2,
        metadata: {
          source: 'spec-drift-detector',
          spec_section: section,
        },
      },
    },
    triggerContext: {
      pattern: `spec_drift_${section}`,
      source: 'spec-drift-detector',
      spec_section: section,
    },
    budgetPerFire: 0.10,
  });
}
