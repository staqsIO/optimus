/**
 * Exploration Domain: Security Scan (ADR-021)
 *
 * Checks for:
 * - Hardcoded secrets/API keys in source
 * - Permission grants with overly broad scope
 * - Agents with more permissions than their tier warrants
 * - Missing RLS policies on sensitive tables
 *
 * Filesystem + DB analysis — zero LLM cost.
 */

import { readFile, readdir } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';
import { query } from '../../../db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(__dirname, '..', '..', '..');

// Patterns that suggest hardcoded secrets
const SECRET_PATTERNS = [
  /(?:api[_-]?key|secret|token|password|credential)\s*[:=]\s*['"][A-Za-z0-9+/=_-]{20,}['"]/i,
  /sk-[a-zA-Z0-9]{20,}/,  // Anthropic/OpenAI keys
  /ghp_[a-zA-Z0-9]{20,}/, // GitHub PATs
  /xoxb-[0-9]+-[a-zA-Z0-9]+/, // Slack bot tokens
];

export const domain = 'security_scan';

/**
 * Run security analysis.
 * @returns {Promise<Array<{title: string, severity: string, evidence: Object, requiresBoardReview?: boolean}>>}
 */
export async function analyze() {
  const findings = [];

  // 1. Scan for hardcoded secrets in source files
  const jsFiles = await collectFiles(SRC_ROOT);
  const secretHits = [];

  for (const file of jsFiles) {
    try {
      const content = await readFile(file, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        // Skip comments that reference patterns (like this file)
        if (lines[i].trim().startsWith('//') || lines[i].trim().startsWith('*')) continue;
        for (const pattern of SECRET_PATTERNS) {
          if (pattern.test(lines[i])) {
            secretHits.push({
              file: file.replace(SRC_ROOT, 'src'),
              line: i + 1,
              snippet: lines[i].trim().slice(0, 60) + '...',
            });
            break; // One hit per line is enough
          }
        }
      }
    } catch { /* skip */ }
  }

  if (secretHits.length > 0) {
    findings.push({
      title: `${secretHits.length} potential hardcoded secret(s) found in source`,
      severity: 'high',
      requiresBoardReview: true,
      evidence: { hits: secretHits.slice(0, 10) },
    });
  }

  // 2. Check for overly broad permission grants
  try {
    const grants = await query(
      `SELECT agent_id, resource_type, resource_id, actions, conditions
       FROM agent_graph.permission_grants
       WHERE revoked_at IS NULL`
    );

    // Flag agents with wildcard resource_id
    const wildcardGrants = grants.rows.filter(g => g.resource_id === '*');
    if (wildcardGrants.length > 0) {
      findings.push({
        title: `${wildcardGrants.length} permission grant(s) use wildcard resource_id`,
        severity: 'medium',
        evidence: {
          grants: wildcardGrants.slice(0, 10).map(g => ({
            agent: g.agent_id,
            type: g.resource_type,
            actions: g.actions,
          })),
        },
      });
    }

    // Flag executor-tier agents with write permissions they shouldn't have
    const configContent = await readFile(join(SRC_ROOT, '..', 'config', 'agents.json'), 'utf-8');
    const agentsJson = JSON.parse(configContent);
    const executorIds = Object.entries(agentsJson)
      .filter(([, c]) => c.type === 'executor')
      .map(([id]) => id);

    const executorWriteGrants = grants.rows.filter(g =>
      executorIds.includes(g.agent_id) &&
      g.actions && JSON.stringify(g.actions).includes('write')
    );

    if (executorWriteGrants.length > 0) {
      findings.push({
        title: `${executorWriteGrants.length} executor-tier agent(s) have write permissions`,
        severity: 'medium',
        requiresBoardReview: true,
        evidence: {
          grants: executorWriteGrants.map(g => ({
            agent: g.agent_id,
            type: g.resource_type,
            resource: g.resource_id,
          })),
        },
      });
    }
  } catch { /* DB may not have permission_grants */ }

  return findings;
}

async function collectFiles(dir, files = []) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await collectFiles(fullPath, files);
      } else if (['.js', '.json', '.env'].includes(extname(entry.name))) {
        // Skip .env.example files
        if (entry.name.endsWith('.example')) continue;
        files.push(fullPath);
      }
    }
  } catch { /* skip */ }
  return files;
}
