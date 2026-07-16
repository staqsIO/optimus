// system-scope-importer-ratchet.test.js — STAQPRO-263 Bucket 2 caller ratchet.
//
// withSystemScope() (lib/db.js) stamps app.role='system' — the Tier-0
// tenancy.is_system() branch (sql/199) treats that as a full cross-org read
// bypass. The frozen SYSTEM_ACTORS allow-list + guard token restrict WHICH actor
// may open a scope and make the role value mechanically unreachable from other
// callers; this ratchet restricts WHICH FILES may call it at all, so widening the
// bypass surface is always a reviewed diff and never a silent import.
//
// It runs the SAME audit inside the required `test:ci` suite (like
// shim-regrowth-ratchet.test.js) so the ratchet enforces now — even while GitHub
// Actions is dark — rather than depending on a separate CI job. (A dedicated CI
// job would also live under .github/, which config-isolation classifies as
// board-tier and would refuse to co-land with this PR's agent-tier sql/lib/test
// changes; a test in the existing agent-tier `test` job avoids that split.)
//
// Bucket 2 wires ZERO callers, so the baseline is 0. To fix a failure: remove the
// new caller, or — if it is intended Bucket 3 wiring — raise BASELINE in
// scripts/audit-system-scope-importers.mjs and enumerate the callers in the commit.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '..', 'scripts', 'audit-system-scope-importers.mjs');

test('no production file imports/calls withSystemScope beyond the STAQPRO-263 baseline', () => {
  let out;
  let code = 0;
  try {
    out = execFileSync('node', [SCRIPT, '--check'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    code = e.status ?? 1;
    out = `${e.stdout || ''}${e.stderr || ''}`;
  }
  assert.equal(code, 0, `Unauthorized withSystemScope caller detected.\n${out}`);
});
