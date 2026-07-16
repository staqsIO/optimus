#!/usr/bin/env node
// audit-unscoped-tenant-reads.mjs — ADR-012 §7 M-D ratchet (STAQPRO-589).
//
// The cross-tenant leaks (STAQPRO-588 signals, STAQPRO-596 /today) were all the
// same shape: a SELECT that reads a FEDERATED tenant table and does NOT append
// the tenancy chokepoint (visibleClause / scopedQuery / tenancy.visible). This
// audit counts those reads across ALL four trees the leak class can live in —
// api-routes, the rest of autobot-inbox/src, lib/**, and agents/** (Linus
// BLOCKER 1: the brief generator lives in lib/agents, not api-routes).
//
// It is a MONOTONIC ratchet, exactly like CG-1: the count may only go down.
// `.github/md-baseline` records the current count; CI runs this with --check and
// fails if the count EXCEEDS the baseline. Sweeping a read onto scopedQuery (or
// annotating a genuinely-safe read — see ALLOW markers) lowers the count; lower
// the baseline in the same PR to tighten the ratchet.
//
// Heuristic, not a parser: for every line that READS a tenant table
// (`FROM <t>` / `JOIN <t>`, excluding `DELETE FROM`), we look in a ±WINDOW line
// neighbourhood for a scoping token. No token → counted as unscoped. This errs
// toward marking reads SCOPED (a nearby token in the same file suppresses the
// hit), which makes the baseline conservative (tighter), never laxer.
//
// Writes (INSERT/UPDATE/DELETE) are out of scope here — STAQPRO-593 owns the
// write-path owner-stamp ratchet.
//
// Usage:
//   node autobot-inbox/scripts/audit-unscoped-tenant-reads.mjs          # print count
//   node autobot-inbox/scripts/audit-unscoped-tenant-reads.mjs --list   # print each hit (file:line)
//   node autobot-inbox/scripts/audit-unscoped-tenant-reads.mjs --check  # ratchet vs .github/md-baseline (CI)

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..'); // autobot-inbox/scripts → repo root
const BASELINE_FILE = join(REPO_ROOT, '.github', 'md-baseline');
// STAQPRO-593: un-stamped tenant-table INSERTs (no owner_org_id in the statement).
const INSERT_BASELINE_FILE = join(REPO_ROOT, '.github', 'md-insert-baseline');

// The four trees the leak class can live in (ADR-012 §7 / Linus BLOCKER 1).
const SCAN_DIRS = ['lib', 'agents', 'autobot-inbox/src'];

// Federated tenant tables (mig 134 + 138 owner columns; ADR-012 §4.5).
const TENANT_TABLES = [
  'signal.contacts', 'signal.briefings', 'signal.organizations',
  'inbox.signals', 'inbox.human_tasks', 'inbox.drafts', 'inbox.projects',
  'inbox.messages', 'inbox.accounts',
  'agent_graph.action_proposals', 'agent_graph.signals', 'agent_graph.campaigns',
  'agent_graph.work_items', 'agent_graph.projects',
  'content.documents', 'content.drafts',
];

// Presence of any of these within ±WINDOW lines marks the read as scoped/allowed.
const SCOPE_TOKENS = [
  'owner_org_id', 'owner_user_id', 'visibleClause', 'tenancy.visible',
  'scopedQuery', 'v.sql', 'CURRENT_ORG_READ_SCOPE',
  // Explicit, reviewable escape hatch for a read that is provably not a tenant
  // leak (e.g. a count for an internal metric, a by-id lookup under agent JWT).
  'tenancy:allow-unscoped',
];
const WINDOW = 20;

const tableAlt = TENANT_TABLES.map((t) => t.replace('.', '\\.')).join('|');
const READ_RE = new RegExp(`(FROM|JOIN)\\s+(${tableAlt})(\\b|$)`, 'i');
const DELETE_RE = new RegExp(`DELETE\\s+FROM\\s+(${tableAlt})`, 'i');
const INSERT_RE = new RegExp(`INSERT\\s+INTO\\s+(${tableAlt})(\\b|$)`, 'i');
const SCOPE_RE = new RegExp(SCOPE_TOKENS.map((t) => t.replace(/[.:]/g, '\\$&')).join('|'));
// STAQPRO-593: an INSERT is "stamped" if owner_org_id appears in the statement
// body (column list / VALUES, which can run long) — or an explicit escape.
const STAMP_RE = /owner_org_id|tenancy:allow-unstamped/;
const INSERT_WINDOW = 30;

function* walk(dir) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    if (name === 'node_modules' || name === '.git') continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else if (name.endsWith('.js') || name.endsWith('.mjs')) yield full;
  }
}

function isTestFile(path) {
  return /\.test\.[mc]?js$/.test(path) || /(^|\/)(test|__tests__)\//.test(path);
}

const readHits = [];
const insertHits = [];
for (const rel of SCAN_DIRS) {
  const base = join(REPO_ROOT, rel);
  if (!existsSync(base)) continue;
  for (const file of walk(base)) {
    if (isTestFile(file)) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Skip comment/prose lines (JSDoc `*`, `//`, markdown) — `from <table>` in
      // an English sentence is not SQL. Commented-out SQL isn't active either.
      const trimmed = line.trim();
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;
      const loc = `${relative(REPO_ROOT, file)}:${i + 1}: ${trimmed.slice(0, 120)}`;

      // Unscoped READ: FROM/JOIN a tenant table with no scope token nearby.
      if (READ_RE.test(line) && !DELETE_RE.test(line)) {
        const lo = Math.max(0, i - WINDOW);
        const hi = Math.min(lines.length, i + WINDOW + 1);
        if (!SCOPE_RE.test(lines.slice(lo, hi).join('\n'))) readHits.push(loc);
      }

      // Un-stamped INSERT (STAQPRO-593): INSERT INTO a tenant table with no
      // owner_org_id in the statement body (forward-biased window).
      if (INSERT_RE.test(line)) {
        const hi = Math.min(lines.length, i + INSERT_WINDOW + 1);
        if (!STAMP_RE.test(lines.slice(Math.max(0, i - 2), hi).join('\n'))) insertHits.push(loc);
      }
    }
  }
}

const readCount = readHits.length;
const insertCount = insertHits.length;
const mode = process.argv[2];

function readBaseline(file, label) {
  let n;
  try { n = parseInt(readFileSync(file, 'utf8').trim(), 10); } catch { n = NaN; }
  if (!Number.isFinite(n)) {
    console.error(`::error::Missing or invalid ${label} — cannot enforce ratchet`);
    process.exit(1);
  }
  return n;
}

if (mode === '--list') {
  console.log('# Unscoped tenant READS:');
  for (const h of readHits) console.log('  ' + h);
  console.log('\n# Un-stamped tenant INSERTs:');
  for (const h of insertHits) console.log('  ' + h);
  console.log(`\nunscoped reads: ${readCount}   un-stamped inserts: ${insertCount}`);
  process.exit(0);
}

if (mode === '--check') {
  const readBase = readBaseline(BASELINE_FILE, '.github/md-baseline');
  const insertBase = readBaseline(INSERT_BASELINE_FILE, '.github/md-insert-baseline');
  let failed = false;

  if (readCount > readBase) {
    console.error(
      `::error::M-D read ratchet broken: ${readCount} unscoped tenant-table reads (baseline: ${readBase}). ` +
      `Append the tenancy chokepoint (visibleClause/scopedQuery) or add a 'tenancy:allow-unscoped' comment. ` +
      `Run: node autobot-inbox/scripts/audit-unscoped-tenant-reads.mjs --list`,
    );
    failed = true;
  } else if (readCount < readBase) {
    console.error(`::warning::M-D read drift: ${readCount} < baseline ${readBase}. Lower .github/md-baseline to ${readCount}.`);
  }

  if (insertCount > insertBase) {
    console.error(
      `::error::M-D insert ratchet broken: ${insertCount} un-stamped tenant-table INSERTs (baseline: ${insertBase}). ` +
      `Stamp owner_org_id from the writer principal (lib/tenancy/owner-stamp.js) or add a 'tenancy:allow-unstamped' comment. ` +
      `Run: node autobot-inbox/scripts/audit-unscoped-tenant-reads.mjs --list`,
    );
    failed = true;
  } else if (insertCount < insertBase) {
    console.error(`::warning::M-D insert drift: ${insertCount} < baseline ${insertBase}. Lower .github/md-insert-baseline to ${insertCount}.`);
  }

  if (failed) process.exit(1);
  console.log(`Unscoped reads: ${readCount}/${readBase} — OK.  Un-stamped inserts: ${insertCount}/${insertBase} — OK.`);
  process.exit(0);
}

console.log(`reads=${readCount} inserts=${insertCount}`);
process.exit(0);
