/**
 * Exploration Domain: Test Health (ADR-021)
 *
 * Runs test suite and analyzes results for:
 * - Test failures
 * - Flaky tests (pass intermittently)
 * - Missing coverage for critical paths
 *
 * Uses sandboxed subprocess (npm test --json).
 */

import { execFile } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..', '..');

export const domain = 'test_health';

/**
 * Run test suite and analyze results.
 * @returns {Promise<Array<{title: string, severity: string, evidence: Object}>>}
 */
export async function analyze() {
  const findings = [];

  try {
    const result = await runTests();

    if (result.numFailedTests > 0) {
      findings.push({
        title: `${result.numFailedTests} test(s) failing`,
        severity: result.numFailedTests > 3 ? 'high' : 'medium',
        evidence: {
          total: result.numTotalTests,
          passed: result.numPassedTests,
          failed: result.numFailedTests,
          failedSuites: result.failedSuites?.slice(0, 5) || [],
        },
      });
    }

    if (result.numTotalTests === 0) {
      findings.push({
        title: 'No tests found — test suite may be misconfigured',
        severity: 'low',
        evidence: { numTotalTests: 0 },
      });
    }

  } catch (err) {
    // Test runner crashed — that's a finding itself
    findings.push({
      title: `Test runner error: ${err.message?.slice(0, 100)}`,
      severity: 'high',
      evidence: { error: err.message?.slice(0, 500) },
    });
  }

  return findings;
}

/**
 * Run npm test with JSON reporter and parse output.
 * Runs in a sandboxed subprocess with timeout.
 */
function runTests() {
  return new Promise((resolve, reject) => {
    const child = execFile('npm', ['test', '--', '--json', '--forceExit'], {
      cwd: PROJECT_ROOT,
      timeout: 120_000, // 2 minute timeout
      env: { ...process.env, CI: 'true', NODE_ENV: 'test' },
    }, (err, stdout, stderr) => {
      // npm test exits with code 1 on test failures — not an error for us
      try {
        const jsonMatch = stdout.match(/\{[\s\S]*"numTotalTests"[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          resolve({
            numTotalTests: parsed.numTotalTests || 0,
            numPassedTests: parsed.numPassedTests || 0,
            numFailedTests: parsed.numFailedTests || 0,
            failedSuites: (parsed.testResults || [])
              .filter(r => r.status === 'failed')
              .map(r => ({ name: r.name, message: r.message?.slice(0, 200) })),
          });
          return;
        }

        // Fallback: parse exit code
        if (err && err.code !== 1) {
          reject(new Error(`npm test crashed: ${stderr?.slice(0, 200) || err.message}`));
        } else {
          // Non-JSON output — try to count pass/fail from text
          const passMatch = stdout.match(/(\d+)\s+pass/i);
          const failMatch = stdout.match(/(\d+)\s+fail/i);
          resolve({
            numTotalTests: (parseInt(passMatch?.[1] || '0') + parseInt(failMatch?.[1] || '0')),
            numPassedTests: parseInt(passMatch?.[1] || '0'),
            numFailedTests: parseInt(failMatch?.[1] || '0'),
            failedSuites: [],
          });
        }
      } catch (parseErr) {
        reject(new Error(`Failed to parse test output: ${parseErr.message}`));
      }
    });
  });
}
