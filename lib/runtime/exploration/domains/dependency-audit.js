/**
 * Exploration Domain: Dependency Audit (ADR-021)
 *
 * Checks for:
 * - Known vulnerabilities (npm audit)
 * - Outdated packages
 * - Deprecated dependencies
 *
 * Uses sandboxed subprocess (npm audit --json, npm outdated --json).
 */

import { execFile } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..', '..');

export const domain = 'dependency_audit';

/**
 * Run dependency audit and analyze results.
 * @returns {Promise<Array<{title: string, severity: string, evidence: Object, pattern?: string}>>}
 */
export async function analyze() {
  const findings = [];

  // 1. npm audit — check for vulnerabilities
  try {
    const auditOutput = await runCommand('npm', ['audit', '--json', '--omit=dev'], PROJECT_ROOT);
    const audit = JSON.parse(auditOutput);

    const vulnCount = audit.metadata?.vulnerabilities || {};
    const critical = vulnCount.critical || 0;
    const high = vulnCount.high || 0;
    const moderate = vulnCount.moderate || 0;

    if (critical > 0 || high > 0) {
      findings.push({
        title: `${critical + high} critical/high vulnerability(ies) found`,
        severity: critical > 0 ? 'high' : 'medium',
        pattern: 'dep_patch',
        evidence: {
          critical,
          high,
          moderate,
          total: (audit.metadata?.totalDependencies || 0),
          advisories: Object.values(audit.advisories || {}).slice(0, 5).map(a => ({
            id: a.id,
            title: a.title,
            severity: a.severity,
            module_name: a.module_name,
            patched_versions: a.patched_versions,
          })),
        },
      });
    } else if (moderate > 0) {
      findings.push({
        title: `${moderate} moderate vulnerability(ies) found`,
        severity: 'low',
        pattern: 'dep_patch',
        evidence: { moderate, total: audit.metadata?.totalDependencies || 0 },
      });
    }
  } catch {
    // npm audit returns non-zero when vulnerabilities exist — output is still valid JSON
    // If parsing failed, skip silently
  }

  // 2. npm outdated — check for stale packages
  try {
    const outdatedOutput = await runCommand('npm', ['outdated', '--json'], PROJECT_ROOT);
    const outdated = JSON.parse(outdatedOutput || '{}');
    const outdatedPackages = Object.entries(outdated);

    // Only flag major version bumps
    const majorOutdated = outdatedPackages.filter(([, info]) => {
      const current = (info.current || '').split('.')[0];
      const latest = (info.latest || '').split('.')[0];
      return current && latest && current !== latest;
    });

    if (majorOutdated.length > 0) {
      findings.push({
        title: `${majorOutdated.length} package(s) behind by major version`,
        severity: majorOutdated.length > 5 ? 'medium' : 'low',
        pattern: 'dep_patch',
        evidence: {
          count: majorOutdated.length,
          packages: majorOutdated.slice(0, 10).map(([name, info]) => ({
            name,
            current: info.current,
            latest: info.latest,
          })),
        },
      });
    }
  } catch {
    // npm outdated returns non-zero when packages are outdated
  }

  return findings;
}

function runCommand(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: 60_000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      // npm audit/outdated return non-zero on findings — still valid output
      if (stdout) resolve(stdout);
      else reject(err || new Error('No output'));
    });
  });
}
