#!/usr/bin/env node
/**
 * CI test runner: runs each test file in its own process for PGlite isolation.
 * Parses TAP output to determine pass/fail (ignores exit codes from --test-force-exit
 * which kills PGlite-holding processes with non-zero exit even when all tests pass).
 *
 * KEY INSIGHT: --test-force-exit produces TWO levels of TAP output:
 *   Level 1 (subtests): # pass 9 / # fail 0  ← actual test results
 *   Level 2 (file):     # pass 0 / # fail 1  ← force-exit artifact
 * We sum ALL "# fail N" lines. If the only failure is the file-level
 * force-exit (total fail == 1 and subtests show fail 0), it's a pass.
 */
import { readdirSync, rmSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';

const testDir = join(import.meta.dirname, '..', 'test');
const dataDir = join(import.meta.dirname, '..', 'data');
const rootDataDir = join(import.meta.dirname, '..', '..', 'data');

// Clean every persisted PGlite test data dir at the start of the run so
// tests are hermetic. Persisted state across runs caused duplicate-key
// failures (e.g. content.wiki_pages.uq_wiki_pages_org_slug) that surfaced
// only in the full suite, not when a file ran in isolation. Each test sets
// its own PGLITE_DATA_DIR; we wipe every `pglite-*` subdir under both
// possible roots, leaving anything else (production data, drive caches)
// untouched.
function purgePgliteTestDirs(parent) {
  let names = [];
  try { names = readdirSync(parent); } catch { return; }
  for (const name of names) {
    if (!name.startsWith('pglite-')) continue;
    try { rmSync(join(parent, name), { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
purgePgliteTestDirs(dataDir);
purgePgliteTestDirs(rootDataDir);

const SKIP_FILES = new Set([
  // Plan 024 triage (real-Postgres run against a docker-provisioned
  // pgvector/pgvector:pg17, replicating the ci.yml `test-postgres` lane's
  // extensions/roles/grants exactly): of the original three files parked
  // here under a blanket "needs pgcrypto/signatures/auth schema" note,
  // only schema-contracts.test.js actually needs that investigation —
  // escalation.test.js and meetings-api.test.js were stale entries (see
  // STAQPRO-243) and have been removed from this set:
  //   - escalation.test.js: already passes 8/9 under PGlite today. The one
  //     failure was a test bug unrelated to any DB backend (stale return-shape
  //     assumption on sanitizer.detectAndRecordThreats — it returns a verdict
  //     object, not a bare count) plus a DELETE-immutability assertion that
  //     only matched the BEFORE-DELETE-trigger error message and not the
  //     ACL-layer "permission denied" real Postgres raises for the
  //     non-superuser autobot_agent role (which lacks a DELETE grant on
  //     threat_memory by design — see sql/001-baseline.sql). Both fixed in
  //     test/escalation.test.js; the file now passes clean under BOTH PGlite
  //     and real Postgres with no self-gating needed.
  //   - meetings-api.test.js: has zero DB dependency (every query function is
  //     `mock.fn()`-mocked) — it never needed Postgres of any flavor and was
  //     bundled into this list in error.
  //
  // schema-contracts.test.js: REMOVED from this set (issue #533 / Plan 024
  // residual). The five schema-drift bugs found by pointing this suite at
  // real Postgres are fixed (contracts.js table-name typo, counterparties.js
  // lateral-subquery projection, search.js uuid/text cast, sql/194 audit
  // schema grant, agent-chat.js created_at projection). The file now
  // self-gates on DATABASE_URL presence (see its `before()` hook) instead of
  // forcing PGlite — it SKIPS cleanly here (PGlite job, no DATABASE_URL) and
  // runs for real against the ci.yml `test-postgres` lane. Tracked under
  // STAQPRO-243.
  //
  // Surfaced by plan 028's 0-test guard. The agent-scope-JWT verification code
  // is CORRECT and this suite PASSES (7/7) on Node 20 — an independent
  // investigation confirmed all imports resolve and every assertion holds. Under
  // the CI `test (22)` Node-22 job the file registers 0 tests: a
  // `node --experimental-test-module-mocks` registration quirk specific to Node
  // 22 (same version split that intermittently mis-counts other mock.module
  // suites), NOT a coverage gap. Skipped explicitly under the guard (not hidden)
  // pending a fix for the Node-22 registration behavior; tracked as a follow-up.
  // (auth-api-secret-scope.test.js was removed from this list — its 0-test cause
  // was a missing `resolveAuth` export + 2 real auth bugs, both fixed in #507, so
  // it now runs and passes and MUST stay unskipped to guard the OPT-148 invariant.)
  'with-agent-scope-jwt.test.js',
]);

const files = readdirSync(testDir)
  .filter(f => f.endsWith('.test.js'))
  .sort();

let totalPass = 0;
let totalFail = 0;
let totalSkippedFiles = 0;
let failedFiles = [];

// Suite-wide collapse guard (plan 028, Step 2): if the whole run drops to a
// near-zero pass count, many files silently registered no tests at once — catch
// it even if no individual file trips the per-file 0-test guard. Conservative
// floor with generous margin below the current ~3000-test baseline; override
// with MIN_TOTAL_PASS when intentionally shrinking the suite.
const MIN_TOTAL_PASS = parseInt(process.env.MIN_TOTAL_PASS || '2000', 10);

/**
 * Parse TAP output for actual test results.
 *
 * Strategy: count real "not ok" test lines (not suite wrappers, not force-exit).
 * A real test failure is a "not ok" line whose YAML block does NOT contain
 * "subtestsFailed" (suite bubble-up) or the file path (force-exit wrapper).
 */
function parseResults(output, filename) {
  const lines = output.split('\n');

  // Collect all "# pass N" and "# fail N" from the TAP summary
  const passMatches = [...output.matchAll(/# pass (\d+)/g)].map(m => parseInt(m[1]));
  const failMatches = [...output.matchAll(/# fail (\d+)/g)].map(m => parseInt(m[1]));

  if (passMatches.length === 0 && failMatches.length === 0) {
    return { pass: 0, fail: 0, hasTap: false, tests: 0, skipped: 0 };
  }

  // Structured run-summary counters. node --test emits one final summary block
  // (`# tests` / `# skipped` / ...); take the last occurrence to be safe against
  // any nested/interleaved output. These let us tell a file that *registered*
  // tests but skipped them all (intentional — e.g. requires real Postgres) apart
  // from a file that registered ZERO runnable tests or failed to load.
  const testsMatches = [...output.matchAll(/# tests (\d+)/g)].map(m => parseInt(m[1]));
  const skippedMatches = [...output.matchAll(/# skipped (\d+)/g)].map(m => parseInt(m[1]));
  const tests = testsMatches.length ? testsMatches[testsMatches.length - 1] : 0;
  const skipped = skippedMatches.length ? skippedMatches[skippedMatches.length - 1] : 0;

  // Use the first # pass (subtest level). For fail, count actual "not ok" lines
  // that represent real test failures (not suite wrappers or force-exit).
  const subtestPass = passMatches[0] || 0;

  // Count real failures: "not ok N - <test name>" lines that are NOT followed
  // by subtestsFailed (suite wrapper) and NOT the file-path wrapper
  let realFails = 0;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    if (!/^not ok \d+/.test(trimmed)) continue;

    // Skip the file-level force-exit wrapper (contains the full file path)
    if (trimmed.includes('.test.js')) continue;

    // Check next ~8 lines for "subtestsFailed" (suite-level bubble-up)
    const context = lines.slice(i + 1, i + 8).join('\n');
    if (context.includes('subtestsFailed')) continue;

    // This is a real test failure
    realFails++;
  }

  return { pass: subtestPass, fail: realFails, hasTap: true, tests, skipped };
}

for (const file of files) {
  if (SKIP_FILES.has(file)) {
    console.log(`  ⊘ ${file} (skipped — known pre-existing failure)`);
    continue;
  }

  const path = join(testDir, file);
  let output = '';
  let exitOk = true;

  // Note: PGlite data dirs persist between test files but each file runs in its own
  // node process. Tests must be idempotent (use ON CONFLICT, clean up own data).

  try {
    output = execSync(
      `node --experimental-test-module-mocks --test --test-force-exit --test-timeout=15000 "${path}"`,
      { encoding: 'utf-8', timeout: 60_000, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, NODE_ENV: 'test' } }
    );
  } catch (err) {
    output = (err.stdout || '') + (err.stderr || '');
    exitOk = false;
  }

  const { pass, fail, hasTap, tests, skipped } = parseResults(output);
  totalPass += pass;

  if (fail > 0) {
    totalFail += fail;
    failedFiles.push(file);
    console.log(`  ✗ ${file} (${pass} passed, ${fail} FAILED)`);
  } else if (pass > 0) {
    console.log(`  ✓ ${file} (${pass} passed${!exitOk ? ', force-exit' : ''})`);
  } else if (!hasTap) {
    // No TAP output — genuine crash
    failedFiles.push(file);
    totalFail++;
    console.log(`  ✗ ${file} (no test output)`);
  } else if (tests > 0 && skipped === tests) {
    // The file DID register tests but skipped every one of them — e.g. a suite
    // gated on a real Postgres URL or an opt-in env var, skipped cleanly under
    // PGlite. Registered-but-skipped is intentional and NOT a coverage
    // regression, so it is not a failure.
    totalSkippedFiles++;
    console.log(`  ⊘ ${file} (${skipped} skipped — all registered tests gated off)`);
  } else {
    // Ran and emitted TAP, but registered ZERO runnable tests (tests === 0) or
    // failed to load (file-level `not ok` wrapper, 0 passes, 0 skips). Before
    // plan 028 this was a silent benign "- (0 tests)" line, so a suite that
    // stopped registering tests — a bad import, a top-level throw after the
    // runner started, an accidentally-empty describe — stayed green while real
    // coverage evaporated. It is now a FAILURE.
    failedFiles.push(file);
    totalFail++;
    console.log(`  ✗ ${file} (0 tests registered — masked coverage regression)`);
  }
}

console.log(`\n${totalPass} passed, ${totalFail} failed, ${totalSkippedFiles} files fully skipped across ${files.length} files`);
if (failedFiles.length > 0) {
  console.log(`Failed: ${failedFiles.join(', ')}`);
  process.exit(1);
} else if (totalPass < MIN_TOTAL_PASS) {
  console.log(`Suite-wide collapse guard tripped: only ${totalPass} tests passed (expected >= ${MIN_TOTAL_PASS}). The suite likely stopped registering tests en masse. Set MIN_TOTAL_PASS to override if this shrink is intentional.`);
  process.exit(1);
} else {
  console.log('All tests passed.');
  process.exit(0);
}
