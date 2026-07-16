#!/usr/bin/env node
// audit-system-scope-importers.mjs — STAQPRO-263 Bucket 2 caller ratchet.
//
// withSystemScope() (lib/db.js) stamps app.role='system', which the Tier-0
// tenancy.is_system() branch (sql/199) treats as a FULL cross-org read bypass.
// That power is safe ONLY while the set of callers stays small and audited.
//
// Two hardening layers guard it, restricting DIFFERENT things:
//   * The frozen SYSTEM_ACTORS allow-list + guard token (lib/db.js) restrict
//     WHICH actor id may open a system scope, and make the role value
//     mechanically unreachable from any non-withSystemScope caller.
//   * This ratchet restricts WHICH FILES may call withSystemScope at all. The
//     allow-list does not do that — an unaudited new module could still pass a
//     valid actor id. Widening the bypass surface must be a reviewed diff, not a
//     silent import.
//
// Bucket 2 wired ZERO call sites (the helper landed inert), so BASELINE started
// at 0; OPT-166 P2a raised it to 1 (tick-context) and P2b to 3 (the reaper
// system-transition path). Later slices route the remaining always-on runtime
// read paths (agent-loop, graph, context-loader, the pollers, audit writers,
// ~40 HTTP routes) through withSystemScope; each MUST raise BASELINE here in the
// same PR and enumerate the new callers in the commit message — making every
// expansion of the cross-org bypass surface explicit and auditable.
//
// A "caller" is any file, outside the definition (lib/db.js) and outside tests /
// this script / the flip-readiness sensor, that either (a) imports/re-exports
// withSystemScope from lib/db.js or (b) invokes it as `withSystemScope(...)`.
// Test files, this script, and the flip-readiness smoke sensor are exempt: they
// exercise or enforce the symbol to PROVE the bypass is safe, they are not
// production runtime call sites. The sensor
// (scripts/flip-readiness-smoke.mjs) only runs manually / in the real-PG fuzz
// gate, never in the agent runtime — so it does not widen the production
// cross-org bypass surface that BASELINE guards. It is exempted by explicit
// path (not a broad pattern) so any OTHER new caller still trips the ratchet.
//
// Usage:
//   node scripts/audit-system-scope-importers.mjs           # list callers
//   node scripts/audit-system-scope-importers.mjs --check    # exit 1 if count > BASELINE
//
// To legitimately raise BASELINE (Bucket 3), update the constant below and note
// the newly-authorized callers in the commit.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Authorized production callers of withSystemScope (raise BASELINE + append here
// in the SAME PR that wires each one; the ratchet is the audit trail):
//   1. lib/runtime/agents/tick-context.js — OPT-166 P2a. buildTickContext() reads
//      state_transitions + work_items across ALL agents/orgs (pipeline-health,
//      unclaimed backlog) → agent-scope would black-hole them post-flip. Read-only,
//      DB-only (no I/O held across the scoped txn).
//   2. lib/runtime/state/state-machine.js — OPT-166 P2b. transitionState({...,
//      systemActor}) opens a system scope for the transition when a daemon must
//      move a work item it does NOT own (reaper recovery). Without it the
//      pre-transition SELECT ... FOR UPDATE + the agent_update_work_items policy
//      (sql/200) black-hole to 0 rows for another agent's task → silent no-op.
//      Cross-agent WRITE path (state_transitions hash chain + status update).
//   3. lib/runtime/state/reaper.js — OPT-166 P2b. The stuck-task recovery daemon
//      reads/re-transitions OTHER agents' work_items: discovery SELECT, retry_count
//      bump, sweepStuckCreated (EXISTS work_items), sweepOrphanedCreated (INSERT …
//      SELECT work_items), reclaimOrphanedBudget (global COUNT of in_progress
//      work_items), and the re-queue emit() (INSERT … RETURNING re-checks the
//      agent_read_events SELECT policy on a row targeting another agent → needs
//      is_system()). All cross-agent; agent-scope would recover nothing post-flip.
//   4. lib/runtime/agents/context-loader.js — OPT-166 P2c. Opens brief,
//      single-statement system scopes for the reads/writes that are NOT
//      correspondent-keyed and would black-hole under agent scope regardless of
//      caller: the head work_items PK read (loadContext must never black-hole a
//      chat/api load of another agent's child item), the G8 quarantine + PII
//      metadata WRITEs (loading agent may not be the item's assignee →
//      agent_update_work_items needs is_system() post-sql/200), and the two
//      loadSystemTopology cross-agent aggregates (per-agent in-progress counts /
//      fleet routing success rates — agent scope would collapse them to the
//      caller's own rows). The correspondent-keyed signals/contacts reads and
//      the reflection read do NOT use system scope — they run under org / agent
//      scope (withAgentScope) precisely to avoid the cross-org leak a system
//      scope would open on those org-keyed tables.
//   5. lib/llm/record-spend.js — OPT-166 P2e-E1. The cross-cutting spend meter.
//      recordSpendMetered() / dailySpendMeteredUsd() open withSystemScope('metering')
//      so the agent_graph.llm_invocations INSERT (system_insert_invocations WITH
//      CHECK is_system(), sql/200) and the daily-spend SELECT (agent_read_invocations
//      OR is_system() branch) resolve post-flip. Concentrating the scope in this
//      shared primitive keeps its two schedulers (the research-source poller and the
//      artifact enricher) OFF this ratchet — they import the metered wrappers, not
//      withSystemScope. Single, auditable metering choke point.
//   6. autobot-inbox/src/tldv/poller.js — OPT-166 P2e-E3. The tl;dv transcript
//      poller wraps ONLY the inbox.messages INSERT (ensureTldvMessageAndWorkItem)
//      in withSystemScope('tldv-poller'): its INSERT policy is
//      WITH CHECK (tenancy.is_system()) (system_insert_messages, sql/200), so an
//      unscoped INSERT hard-fails 42501 post-flip. The dedup SELECT + both
//      snippet/work_item_id UPDATEs stay unscoped (bare-permissive USING(true)
//      policies), and content.documents reads/writes go through withAgentScope
//      (org scope), NOT system scope, to avoid a cross-org leak on that
//      org-keyed table. The sibling webhook.js path adds NO system-scope caller
//      (it inserts no inbox.messages row — org scope only).
//   7. autobot-inbox/src/api-routes/redesign.js - OPT-166 P3-B5. The redesign
//      intake routes create agent_graph.work_items on behalf of the pipeline
//      (no owning agent principal on the HTTP request). withSystemScope('redesign-intake')
//      wraps ONLY those work_items writes (system_insert_work_items WITH CHECK
//      is_system(), sql/200) - an unscoped INSERT hard-fails 42501 post-flip.
//   8. autobot-inbox/src/api-routes/voice-memo.js - OPT-166 P3-B5. SPLIT scope:
//      the inbound inbox.messages INSERT is wrapped in withSystemScope('voice-memo-intake')
//      (system_insert_messages WITH CHECK is_system(), sql/200), while the
//      content.documents compile_status UPDATE goes through withAgentScope (org
//      scope) - that org-keyed table must NOT ride the cross-org system bypass.
//   9. autobot-inbox/src/api-routes/signing.js - OPT-166 P3-B5. The magic-link
//      signer endpoint (/api/sign/:token/*) is an UNAUTHENTICATED external
//      principal, so its work_items/state writes have no agent identity;
//      withSystemScope('signing-magic-link') wraps them. The board-authenticated
//      /api/signatures/* create path uses withBoardScope instead (NOT system).
//  10. autobot-inbox/src/api-routes/federation.js - OPT-166 P3-B5. The federation
//      /query + revocation + audit reads span ALL orgs' grants (that is the
//      point of federation), which agent/org scope would black-hole;
//      withSystemScope('federation-query') covers them. The /grant WRITE path
//      is board-gated and uses withBoardScope, NOT system scope.
//  11. autobot-inbox/src/api.js - OPT-166 P3-B6. The generic POST
//      /api/webhooks/:source fallthrough (non-GitHub/Linear sources) has no
//      board or agent principal on the request; withSystemScope('webhook-intake')
//      wraps the inbox.messages INSERT (system_insert_messages WITH CHECK
//      is_system(), sql/200) and the subsequent work_item_id UPDATE in the same
//      handler - both hard-fail 42501 unscoped post-flip. Fail-closed: no
//      catch-and-fallback to an unscoped query.
const BASELINE = 11; // production callers of withSystemScope allowed. OPT-166 P2/P3 raises this per slice.

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', '..'); // autobot-inbox/scripts -> repo root
const SCAN_DIRS = ['lib', 'agents', 'autobot-inbox', 'board', 'spec', 'scripts', 'tools'];
const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx']);
const SYMBOL = 'withSystemScope';

// The definition lives here — it must never count as a caller of itself.
const DEF_FILE = path.resolve(ROOT, 'lib', 'db.js');

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

// A file is exempt when it is a test, this ratchet script itself, or the
// flip-readiness smoke sensor — those are allowed to name the symbol (they
// exercise / enforce it to prove flip-safety) and are not prod runtime call
// sites. Exemptions are by explicit path / test-pattern only, so any genuinely
// new production caller still trips the ratchet (deny-by-default, P1).
function isExempt(relPath) {
  return (
    relPath.includes('/test/') ||
    relPath.startsWith('test/') ||
    /(^|\/)[^/]*\.test\.[cm]?[jt]sx?$/.test(relPath) ||
    relPath === 'autobot-inbox/scripts/audit-system-scope-importers.mjs' ||
    relPath === 'autobot-inbox/scripts/flip-readiness-smoke.mjs'
  );
}

function computeCallers() {
  const allFiles = [];
  for (const d of SCAN_DIRS) walk(path.join(ROOT, d), allFiles);

  // (a) import / export-from statements — capture the binding clause + specifier
  //     so a multi-line named import is still matched as one statement.
  const importRe = /(?:import|export)\s+([\s\S]*?)\s+from\s*['"`]([^'"`]+)['"`]/g;
  // (b) an actual invocation: withSystemScope( ... — not a bare comment mention.
  const callRe = /\bwithSystemScope\s*\(/;
  const bindingRe = /\bwithSystemScope\b/;

  const callers = [];
  for (const f of allFiles) {
    if (path.resolve(f) === DEF_FILE) continue;
    const rel = path.relative(ROOT, f).split(path.sep).join('/');
    if (isExempt(rel)) continue;

    const c = fs.readFileSync(f, 'utf8');
    if (!c.includes(SYMBOL)) continue;

    let isCaller = false;

    // (a) import / re-export of the symbol from lib/db.js
    importRe.lastIndex = 0;
    let m;
    while ((m = importRe.exec(c))) {
      const binding = m[1];
      const target = resolveSpec(f, m[2]);
      if (target === DEF_FILE && bindingRe.test(binding)) { isCaller = true; break; }
    }

    // (b) a direct call expression (covers dynamic import destructuring too)
    if (!isCaller && callRe.test(c)) isCaller = true;

    if (isCaller) callers.push(rel);
  }
  callers.sort();
  return callers;
}

const callers = computeCallers();
const check = process.argv.includes('--check');

if (check) {
  if (callers.length > BASELINE) {
    console.error(`FAIL: ${callers.length} production caller(s) of withSystemScope found (baseline ${BASELINE}).`);
    console.error('withSystemScope opens a full cross-org read bypass (app.role=system).');
    console.error('Each new caller widens that surface and must be an explicit, reviewed diff:');
    for (const d of callers) console.error(`  ${d}`);
    console.error('\n(If these callers are intended — e.g. Bucket 3 wiring — raise BASELINE in this script and enumerate them in the commit.)');
    process.exit(1);
  }
  console.log(`OK: ${callers.length} production caller(s) of withSystemScope (baseline ${BASELINE}).`);
  process.exit(0);
}

console.log(`Production callers of withSystemScope: ${callers.length}`);
for (const d of callers) console.log(`  ${d}`);
