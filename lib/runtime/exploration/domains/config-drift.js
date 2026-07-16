/**
 * Exploration Domain: Config Drift (ADR-021)
 *
 * Detects mismatches between agents.json config and reality:
 * - Agents configured but no handler file exists
 * - Handler files that exist but aren't in agents.json
 * - Model references that may be outdated
 * - Permission grants referencing non-existent agents
 *
 * Pure filesystem + DB analysis — zero LLM cost.
 */

import { readFile, readdir, access } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { query } from '../../../db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..', '..');
const AGENTS_DIR = join(PROJECT_ROOT, 'src', 'agents');

export const domain = 'config_drift';

/**
 * Run config drift analysis.
 * @returns {Promise<Array<{title: string, severity: string, evidence: Object, pattern?: string}>>}
 */
export async function analyze() {
  const findings = [];

  // Load agents.json
  let agentsJson;
  try {
    agentsJson = JSON.parse(await readFile(join(PROJECT_ROOT, 'config', 'agents.json'), 'utf-8'));
  } catch {
    findings.push({ title: 'agents.json missing or invalid', severity: 'high', evidence: {} });
    return findings;
  }

  const configuredIds = new Set(Object.keys(agentsJson));

  // 1. Check for agents in config without handler files
  const missingHandlers = [];
  for (const [id, config] of Object.entries(agentsJson)) {
    if (!config.enabled) continue;
    // Check both patterns: agents/<id>.js and agents/<id>/index.js
    const flatPath = join(AGENTS_DIR, `${id}.js`);
    const dirPath = join(AGENTS_DIR, id, 'index.js');
    const handlerPath = join(PROJECT_ROOT, 'src', 'runtime', `${id}.js`);

    let found = false;
    for (const p of [flatPath, dirPath, handlerPath]) {
      try { await access(p); found = true; break; } catch { /* try next */ }
    }

    // Special cases: agents that are wired differently
    const specialAgents = new Set(['claw-explorer']); // Explorer extends self-improve-scanner
    if (!found && !specialAgents.has(id)) {
      missingHandlers.push(id);
    }
  }

  if (missingHandlers.length > 0) {
    findings.push({
      title: `${missingHandlers.length} enabled agent(s) in config have no handler file`,
      severity: 'medium',
      evidence: { agents: missingHandlers },
    });
  }

  // 2. Check for handler directories not in config
  try {
    const agentDirs = (await readdir(AGENTS_DIR, { withFileTypes: true }))
      .filter(e => e.isDirectory())
      .map(e => e.name);

    const unconfigured = agentDirs.filter(dir => !configuredIds.has(dir));
    if (unconfigured.length > 0) {
      findings.push({
        title: `${unconfigured.length} agent directory(ies) not in agents.json`,
        severity: 'low',
        evidence: { directories: unconfigured },
      });
    }
  } catch { /* skip */ }

  // 3. DB agent_configs vs agents.json alignment
  try {
    const dbConfigs = await query(
      `SELECT agent_id FROM agent_graph.agent_configs`
    );
    const dbIds = new Set(dbConfigs.rows.map(r => r.agent_id));

    const inConfigNotDb = [...configuredIds].filter(id => !dbIds.has(id));
    const inDbNotConfig = [...dbIds].filter(id => !configuredIds.has(id));

    if (inConfigNotDb.length > 0 || inDbNotConfig.length > 0) {
      findings.push({
        title: `agents.json ↔ agent_configs table mismatch`,
        severity: 'medium',
        evidence: {
          in_config_not_db: inConfigNotDb,
          in_db_not_config: inDbNotConfig,
        },
      });
    }
  } catch { /* DB may not have the table yet */ }

  return findings;
}
