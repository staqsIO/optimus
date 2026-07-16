// tenant-read-ratchet.test.js — STAQPRO-589 M-D ratchet, local enforcement.
//
// The CI job `md-unscoped-tenant-reads` runs the audit on every PR, but Actions
// is currently dark (billing). This test runs the SAME --check in the required
// `test:ci` suite so the ratchet enforces NOW: a PR that adds a new unscoped
// read of a federated tenant table fails locally before it can ship.
//
// To fix a failure: append the tenancy chokepoint (visibleClause/scopedQuery) to
// the new read, or — for a provably-safe read — add a `tenancy:allow-unscoped`
// comment near it. If you legitimately removed unscoped reads, lower
// .github/md-baseline to match (the audit prints the new number).

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '..', 'scripts', 'audit-unscoped-tenant-reads.mjs');
const BASELINE_FILE = join(here, '..', '..', '.github', 'md-baseline');

test('unscoped tenant-table reads do not exceed the M-D baseline', () => {
  let out;
  let code = 0;
  try {
    out = execFileSync('node', [SCRIPT, '--check'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    code = e.status ?? 1;
    out = `${e.stdout || ''}${e.stderr || ''}`;
  }
  assert.equal(code, 0, `M-D ratchet exceeded — new unscoped tenant reads detected.\n${out}`);
});

test('the M-D baseline is a positive integer (ratchet is wired)', () => {
  const baseline = parseInt(readFileSync(BASELINE_FILE, 'utf8').trim(), 10);
  assert.ok(Number.isFinite(baseline) && baseline >= 0, '.github/md-baseline must hold a non-negative integer');
});
