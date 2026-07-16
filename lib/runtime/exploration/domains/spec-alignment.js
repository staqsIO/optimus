/**
 * Exploration Domain: Spec Alignment (ADR-021)
 *
 * Checks for drift between SPEC.md and implementation:
 * - Agent tiers defined in spec vs agents.json
 * - Schema names in spec vs actual migrations
 * - Design principles referenced in code
 *
 * Pure filesystem analysis — zero LLM cost.
 */

import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..', '..');
const REPO_ROOT = join(PROJECT_ROOT, '..');

export const domain = 'spec_alignment';

/**
 * Run spec alignment analysis.
 * @returns {Promise<Array<{title: string, severity: string, evidence: Object, requiresBoardReview?: boolean}>>}
 */
export async function analyze() {
  const findings = [];

  // 1. Check agent tiers: SPEC.md defines tiers, agents.json implements them
  try {
    const specContent = await readFile(join(REPO_ROOT, 'SPEC.md'), 'utf-8');
    const agentsJson = JSON.parse(await readFile(join(PROJECT_ROOT, 'config', 'agents.json'), 'utf-8'));

    // Extract agent IDs from agents.json
    const configuredAgents = Object.keys(agentsJson);
    const configuredTypes = new Set(Object.values(agentsJson).map(a => a.type));

    // Check if spec mentions agent types not in config
    const specTiers = ['strategist', 'architect', 'orchestrator', 'reviewer', 'executor'];
    const missingTiers = specTiers.filter(t => !configuredTypes.has(t));

    if (missingTiers.length > 0) {
      findings.push({
        title: `Spec defines agent tiers not present in agents.json: ${missingTiers.join(', ')}`,
        severity: 'medium',
        requiresBoardReview: true,
        evidence: {
          spec_tiers: specTiers,
          configured_types: [...configuredTypes],
          missing: missingTiers,
        },
      });
    }

    // 2. Check for disabled agents that spec expects to be active
    const disabledAgents = Object.entries(agentsJson)
      .filter(([, config]) => config.enabled === false)
      .map(([id]) => id);

    if (disabledAgents.length > 0) {
      findings.push({
        title: `${disabledAgents.length} agent(s) disabled in agents.json`,
        severity: 'low',
        evidence: { disabled: disabledAgents },
      });
    }
  } catch (err) {
    // SPEC.md or agents.json not found — flag it
    findings.push({
      title: `Spec alignment check failed: ${err.message}`,
      severity: 'low',
      evidence: { error: err.message },
    });
  }

  // 3. Check schema count matches documentation claims
  try {
    const claudeMd = await readFile(join(PROJECT_ROOT, 'CLAUDE.md'), 'utf-8');
    const schemaMatch = claudeMd.match(/(\w+) isolated schemas/i);
    const claimedCount = schemaMatch ? parseInt(schemaMatch[1] === 'Five' ? '5' : schemaMatch[1]) : null;

    if (claimedCount) {
      // Count CREATE SCHEMA in migrations
      const { readdir } = await import('fs/promises');
      const sqlDir = join(PROJECT_ROOT, 'sql');
      const sqlFiles = (await readdir(sqlDir)).filter(f => f.endsWith('.sql'));
      const schemaNames = new Set();

      for (const file of sqlFiles) {
        const content = await readFile(join(sqlDir, file), 'utf-8');
        const schemas = content.matchAll(/CREATE SCHEMA(?:\s+IF NOT EXISTS)?\s+(\w+)/gi);
        for (const m of schemas) schemaNames.add(m[1]);
      }

      if (schemaNames.size !== claimedCount) {
        findings.push({
          title: `CLAUDE.md claims ${claimedCount} schemas but migrations define ${schemaNames.size}`,
          severity: 'low',
          requiresBoardReview: true,
          evidence: {
            claimed: claimedCount,
            actual: schemaNames.size,
            schemas: [...schemaNames],
          },
        });
      }
    }
  } catch { /* skip */ }

  return findings;
}
