// shim-regrowth-ratchet.test.js — Plan 034 guard against dead-shim regrowth.
//
// Plan 034 deleted the 36 agent-tier "Re-export shim" files that had zero
// importers (dead indirection from the STAQPRO-560 relocations). This test runs
// the SAME audit inside the required `test:ci` suite so the ratchet enforces now,
// even while GitHub Actions is dark: a PR that adds a new zero-importer agent-tier
// shim — or migrates a live shim's last caller but leaves the shim behind — fails
// locally before it can ship.
//
// To fix a failure: delete the dead shim (its old path has no callers), or, if it
// is genuinely still needed, migrate a caller onto it. If you intentionally
// deleted more dead shims, lower BASELINE in
// scripts/audit-zero-importer-shims.mjs (it prints the current number).

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '..', 'scripts', 'audit-zero-importer-shims.mjs');

test('no zero-importer agent-tier re-export shims exceed the Plan 034 baseline', () => {
  let out;
  let code = 0;
  try {
    out = execFileSync('node', [SCRIPT, '--check'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    code = e.status ?? 1;
    out = `${e.stdout || ''}${e.stderr || ''}`;
  }
  assert.equal(code, 0, `Dead re-export shim regrowth detected.\n${out}`);
});
