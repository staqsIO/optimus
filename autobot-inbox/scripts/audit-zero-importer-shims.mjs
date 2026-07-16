#!/usr/bin/env node
// audit-zero-importer-shims.mjs — Plan 034 regrowth guard.
//
// STAQPRO-560 relocated ~180 files, leaving two-line "Re-export shim" wrappers.
// Plan 034 deleted the agent-tier shims that had ZERO importers (dead indirection).
// This audit recomputes that set and fails if it grows above BASELINE (0): every
// new agent-tier shim must have at least one live importer, otherwise it is dead
// surface and must be deleted, not committed. It also fires when a live shim's last
// caller is migrated away but the shim is left behind — forcing the follow-up
// deletion the plan calls for.
//
// A shim is agent-tier when it lives under lib/, agents/, or autobot-inbox/src/
// (excluding autobot-inbox/config/). An "importer" is ANY file (anywhere in the
// scanned tree) whose static import / export-from / require / dynamic import()
// resolves to the shim file — an importer that is itself a shim still counts
// (conservative: keep re-export chains).
//
// Usage:
//   node scripts/audit-zero-importer-shims.mjs           # print the current set
//   node scripts/audit-zero-importer-shims.mjs --check    # exit 1 if count > BASELINE
//
// If you legitimately need to raise/lower BASELINE (e.g. you deleted more dead
// shims), update the constant below and note why in the commit.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASELINE = 0; // agent-tier zero-importer shims allowed. Plan 034 drove this to 0.

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', '..'); // autobot-inbox/scripts -> repo root
const SCAN_DIRS = ['lib', 'agents', 'autobot-inbox', 'board', 'spec', 'scripts', 'tools', 'test'];
const AGENT_TIER_PREFIXES = ['lib/', 'agents/', 'autobot-inbox/src/'];
const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx']);

function walk(dir, acc) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of ents) {
    if (['node_modules', '.git', '.next', 'dist', 'build'].includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (CODE_EXT.has(path.extname(e.name))) acc.push(full);
  }
  return acc;
}

function resolveSpec(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const noQuery = spec.split('?')[0]; // strip cache-buster (import(`x.js?t=${Date.now()}`))
  const base = path.resolve(path.dirname(fromFile), noQuery);
  const candidates = [
    base, base + '.js', base + '.mjs', base + '.cjs', base + '.ts', base + '.tsx', base + '.jsx',
    path.join(base, 'index.js'), path.join(base, 'index.mjs'), path.join(base, 'index.ts'),
  ];
  for (const c of candidates) { try { if (fs.statSync(c).isFile()) return c; } catch {} }
  return null;
}

function computeZeroImporterShims() {
  const allFiles = [];
  for (const d of SCAN_DIRS) walk(path.join(ROOT, d), allFiles);

  const shimFiles = new Set();
  const content = new Map();
  for (const f of allFiles) {
    const c = fs.readFileSync(f, 'utf8');
    content.set(f, c);
    if (c.includes('Re-export shim')) shimFiles.add(f);
  }

  const specRe = /(?:from|import|require)\s*\(?\s*['"`]([^'"`]+)['"`]/g;
  const importersByTarget = new Map();
  for (const f of allFiles) {
    const c = content.get(f);
    specRe.lastIndex = 0;
    let m;
    while ((m = specRe.exec(c))) {
      const target = resolveSpec(f, m[1]);
      if (target && target !== f) {
        if (!importersByTarget.has(target)) importersByTarget.set(target, new Set());
        importersByTarget.get(target).add(f);
      }
    }
  }

  const dead = [];
  for (const shim of shimFiles) {
    const rel = path.relative(ROOT, shim).split(path.sep).join('/');
    const inAgentTier = AGENT_TIER_PREFIXES.some(p => rel.startsWith(p)) && !rel.startsWith('autobot-inbox/config/');
    if (!inAgentTier) continue;
    const importers = [...(importersByTarget.get(shim) || new Set())].filter(x => x !== shim);
    if (importers.length === 0) dead.push(rel);
  }
  dead.sort();
  return dead;
}

const dead = computeZeroImporterShims();
const check = process.argv.includes('--check');

if (check) {
  if (dead.length > BASELINE) {
    console.error(`FAIL: ${dead.length} zero-importer agent-tier re-export shim(s) found (baseline ${BASELINE}).`);
    console.error('These are dead indirection — delete them, or add a live importer:');
    for (const d of dead) console.error(`  ${d}`);
    console.error('\n(If you intentionally deleted more dead shims, lower BASELINE in this script.)');
    process.exit(1);
  }
  console.log(`OK: ${dead.length} zero-importer agent-tier shim(s) (baseline ${BASELINE}).`);
  process.exit(0);
}

console.log(`Zero-importer agent-tier re-export shims: ${dead.length}`);
for (const d of dead) console.log(`  ${d}`);
