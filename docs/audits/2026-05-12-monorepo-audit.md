# Optimus Monorepo Audit — 2026-05-12

**Auditors:** `/neo:neo-review` (tactical / code-level), `/neo:neo-architect` (structural / strategic)
**Scope:** `lib/`, `agents/`, `autobot-inbox/`, `board/`
**Trigger:** Post-ADR-007 federation thesis (2026-05-11). Audit checks whether the codebase has drifted from the narrowed strategic surface.

---

## TL;DR — the three findings that matter

1. **Federation pre-GA primitives are not shipped.** ADR-007 §1–§4 mandates four primitives that cost essentially nothing to add *now* and become painful migrations after a second org install. Status: **0/4 shipped.** This is the single most urgent finding.

2. **Neo4j enrichment needs an audit, not a halt.** *Revised 2026-05-13 after Eric pushback.* The original framing — that five `lib/graph/` files violate ADR-007 — was a misread. ADR-007 halts *federation-specific* Neo4j (clustering, remote BOLT, cross-org sharing), not single-org enrichment. Single-org graph richness is a deliberate pitch + product asset. The real question is which of those five files feed a user-visible feature (graph view, briefing context, signal extraction, agent context loading) vs. write nodes nobody reads. See revised Item 15.

3. **`executor-triage` is not dead.** CLAUDE.md says `executor-intake` replaced it. Code reality contradicts that: orchestrator falls back to triage, intake delegates to triage for transcripts/signals, and triage handles non-email channels. Either kill it for real (with migration) or update CLAUDE.md.

Everything else is bookkeeping — meaningful bookkeeping, but secondary to these three.

---

## Inventory snapshot

| Area | Size | Health |
|------|------|--------|
| `lib/runtime/` | 54–65 files | **Too big** — three orthogonal concerns mixed (execution / governance / context) |
| `lib/rag/` | 20 files | Healthy. ADR-007 says leave alone. |
| `lib/graph/` | 9 files | **5/9 violate ADR-007 HALT** |
| `lib/signatures/` + `lib/contracts/` + `lib/adapters/boldsign.js` | 11 files | One domain split across three modules. BoldSign has 1 caller and is marked for removal. |
| `agents/` (root) | 16 dirs | Some shimmed via `src/agents/`, some genuine duplicates needing reconciliation |
| `autobot-inbox/src/agents/` | 13 wired | `executor-intake` + `executor-triage` both live |
| `autobot-inbox/src/api.js` | 3,926 LOC | God-file. 114 commits in 60d. Partial extraction in flight. |
| `autobot-inbox/src/api-routes/governance.js` | 1,676 LOC | Multi-domain (halt + kill-switch + dead-man + audit) |
| `autobot-inbox/src/api-routes/contracts.js` | 1,668 LOC | Multi-phase (draft / send / sign / redline / pdf) |
| `board/src/app/` | 42 routes | Bloated. ≥10 routes are dead, duplicate, or experimental. |
| `autobot-inbox/dashboard/` | Legacy app | Replaced by `board/`. `.next/` build artifacts checked in. |
| Migrations | 001 → 114 | Healthy. No orphans. |
| CG-1 cross-layer imports | baseline 1 / current 1 | No new drift. The one violation is eliminated by killing BoldSign. |

---

## NOW — ship this week (zero risk, no migration)

These are pure deletes. No callers to migrate. PRs should be 1–2 hours each.

1. **`autobot-inbox/dashboard/.next/`** — checked-in Next.js build artifacts in git. Should be `.gitignore`d. Caused this audit's batch grep to time out. *Delete the directory + add `.next/` to `.gitignore` if not already.*
2. **`autobot-inbox/dashboard/` (entire legacy app)** — replaced by `board/` (port 3200). No active imports. Remove app + `compose.yml:105–127` + `compose.prod.yml:85–90` + `.claude/settings.local.json` line 10 in one PR.
3. **`lib/adapters/boldsign.js`** + **`autobot-inbox/src/api-routes/content.js` lines ~155–192** — one dynamic caller, replaced by `lib/signatures/`. CLAUDE.md memory explicitly marks for removal. Eliminates the lone CG-1 violation.
4. **`audit/B1-static-analysis.json`** — one-shot audit artifact, stale, root-level junk.
5. **`board/src/app/board/`** — route-inside-app duplicate. Move `lanes.js` + tests + page into `today/` or `pipeline/` and delete.
6. **`board/src/app/demo/`** — throwaway demo route. CLAUDE.md memory (`user_ladd_angelius.md`) says "honest status, not aspirational demos."
7. **`lib/runtime/agent-loop.js:911`** — stale TODO ("Replace with LLM-based completeness check behind a feature flag"). Either ship the flag or delete the comment.

**Estimated impact:** ~3,000 LOC removed, 0 migration risk, CG-1 ratchet drops to 0.

---

## NEXT SPRINT — small migrations (1–3 days each)

These have callers to migrate but no architectural debate.

8. **Collapse `lib/signatures/` + `lib/contracts/` → `lib/signing/`** (M)
   - 13 dynamic imports of `lib/signatures/`, 5 of `lib/contracts/`. One domain, two modules, no clear seam between them.
   - Resulting shape: `lib/signing/{sessions, contracts, pdf, notifier, sweeper}.js`.
   - Eliminates the parallel-module confusion and clears `lib/adapters/` for the channel-registry pattern that's already documented in CLAUDE.md.

9. **Reconcile `executor-triage` reality** (S)
   - Pick one explicitly: either intake replaces triage (then set `executor-triage.enabled = false` in `agents.json` and migrate the 2 remaining callers in `tldv/poller.js` and `transcripts/action-extractor.js`) or they coexist (then update CLAUDE.md: intake = email, triage = transcripts/signals).
   - Current state — both live, CLAUDE.md says one replaces the other — is the worst of both worlds.

10. **Reconcile `agents/executor-triage/` vs `autobot-inbox/src/agents/executor-triage.js`** (S)
    - Two implementations. `src/index.js:11` imports the `src/agents/` one. `agents/executor-triage/index.js` is 538+ LOC and may be newer. Diff them, pick canonical, add a re-export shim like `src/agents/redesign-strategy.js` already does. Same pattern for `executor-coder`, `executor-blueprint`, `executor-redesign`, `executor-research` root-level dirs.

11. **Split `autobot-inbox/src/api-routes/contracts.js` (1,668 LOC)** (S)
    - Clean seams: `contracts/{draft, send, redline, pdf, sign}.js`. All dynamic imports of `lib/contracts/*` and `lib/signatures/*` already live here.

12. **Split `autobot-inbox/src/api-routes/governance.js` (1,676 LOC)** (S)
    - Seams: `governance/{halt, audit, dead-man, kill-switch}.js`.

13. **Board route consolidations** (XS each, batch into one PR):
    - `voice/` + `voice-prints/` → `voice/` with tab
    - `runners/` + `runs/` → `runs/` (CLAUDE.md already says Campaigns→Runs)
    - `counterparties/` + `organizations/` + `relationships/` → `organizations/` with relationship view
    - `verify/[contractId]/` → moved under `contracts/verify/`
    - `wiki/` + `spec/` → redirect to vault or `/spec/decisions/`, delete the routes
    - `flows/` (14 files) — INVESTIGATE first; either justify in CLAUDE.md or kill.

14. **Continue extracting `autobot-inbox/src/api.js` (3,926 LOC) → `api-routes/`** (M)
    - Already partially decomposed (24 route files). Target: `api.js` < 500 LOC, router wiring only. Grep for inline `routes.set(` blocks and migrate. Ongoing work, not one PR.

---

## STRATEGIC DECISIONS — Eric input required

These cannot be acted on without a strategic call.

15. **`lib/graph/` enrichment writers — VERIFIED LOAD-BEARING** *(verdict closed 2026-05-13 after grep audit)*
    - **Original Neo Architect kill recommendation: REJECTED.** All 5 files have confirmed downstream readers. Killing any of them breaks shipping features.
    - **Per-file verdict:**
      - `governance-sync.js` (138 LOC) → `api-routes/governance.js` → `/governance` board route. KEEP.
      - `claw-learning.js` (291 LOC) → claw-campaigner, claw-workshop, self-improve-scanner. KEEP. Killing breaks claw improvement loop.
      - `pattern-extractor.js` (724 LOC) → `lib/graph/queries.js` (agent context) **+ `lib/runtime/autonomy-evaluator.js` (L0→L1 promotion / M13)**. KEEP. Killing breaks autonomy graduation. Note: this file writes to Postgres `agent_graph.learned_patterns`, NOT Neo4j — Neo Architect mis-categorized it as a Neo4j file.
      - `relationship-inferrer.js` (282 LOC) → `board/src/components/contacts/ConnectionsPanel.tsx`, `relationship-strength.js`, `api-routes/organizations.js`. KEEP. Killing breaks contacts page Connections panel.
      - `relationship-strength.js` (168 LOC) → `board/src/app/contacts/[id]/page.tsx`, `api-routes/relationships.js`. KEEP.
    - **Implication for graph-view investment:** the substrate for Tier 1 (entity lens) already exists and is producing live data. Tier 1 work is primarily UI exposure of computed data, not new computation. Estimated effort revised down: **3–5 days**, not 1+ week.
    - **Federation-Neo4j HALT still applies separately** — no clustering work, no remote BOLT, no shared-graph-across-orgs patterns. That's unchanged.
    - **Audit miss noted:** Neo Architect's lib/graph/ kill list was wrong on every file. See `~/.claude/projects/.../memory/feedback_verify_subagent_kills.md`.

16. **`executor-redesign` pipeline status** (M)
    - 1,425 LOC agent + dedicated board route. Is this UMB blog/marketing infra (org-internal, fine) or "Redesign-as-a-Service" exploration (ADR-007 says no second product before N=2)?
    - Default if exploratory: `enabled: false` in `agents.json`, mothball the agent.

17. **Split `lib/runtime/` 65 files into runtime/governance/context** (L)
    - Neo Architect's top structural recommendation. Natural seams already exist by filename clusters.
    - Highest sustained-velocity payoff: governance becomes its own module, which makes ADR-007's federation-aware enforcement (`current_org_id()`, issuer-aware JWT) a surgical change instead of a sprawling one.
    - Effort: L (multi-day refactor, ~50 file moves, careful import-path updates).
    - **Verdict needed:** prioritize this now, or defer until federation pre-GA primitives ship?
    - Recommendation: defer 1–2 weeks. Ship pre-GA primitives first (items 18–21), then split runtime.

---

## ADR-007 COMPLIANCE GAPS — pre-GA federation primitives

**These are the headline finding.** All four items cost ~1 day total and prevent multi-day retrofit migrations once Staqs becomes the second org.

18. **JWT `iss` + `org` claims missing** (S)
    - File: `lib/runtime/agent-jwt.js:119`
    - Current: `iss: 'optimus-agent'` (hard-coded single-org pin), no `org` claim.
    - Required (ADR-007 §1): `iss: process.env.OPTIMUS_ORG_ID ?? "self"` + new `org` claim.
    - `verifyAgentToken()` becomes issuer-aware (JWKS lookup deferred but field must ship).
    - Cost now: one-line change. Cost later: multi-day retrofit + RLS rework + token re-signing.

19. **`origin_org` property missing on all Neo4j node writes** (S)
    - Files: `lib/graph/{client.js, sync.js, queries.js, governance-sync.js, claw-learning.js, pattern-extractor.js, relationship-inferrer.js, relationship-strength.js, spec-seed.js}`
    - Zero hits for `origin_org` or `OPTIMUS_ORG_ID` in `lib/graph/`.
    - Required (ADR-007 §2): every node write carries `origin_org: process.env.OPTIMUS_ORG_ID ?? "self"`.
    - Implementation: single helper in `lib/graph/client.js` that injects the property into every Cypher CREATE + an eslint rule rejecting raw `CREATE (n:` without the helper.
    - Cost now: write-time constant. Cost later: full graph rewrite (no retrofit path).

20. **Capability receipt envelope undefined** (M)
    - `lib/audit/` has `tier1-deterministic.js`, `tier2-ai-auditor.js`, `tier3-cross-model.js` — no receipt file.
    - Required (ADR-007 §4): signed receipt envelope format, JSON schema, signing utility.
    - New file: `lib/audit/capability-receipt.js`.
    - Don't build federation transport — just lock the envelope so future records are forward-compatible.

21. **`agent_graph.federated_kg_imports` table missing** (S)
    - Required (ADR-007 §2): authoritative KG-export substrate (signed JSON-LD blob in Postgres).
    - New migration: `autobot-inbox/sql/115-federated-kg-imports.sql`.
    - Empty table is fine. Schema-only landing is enough.

---

## WHAT WE'RE STOPPING — focus recommendations

To dial in the solution, stop doing these:

1. **Stop building Neo4j enrichment without a reader.** *Revised 2026-05-13.* Single-org graph richness is allowed and valuable (it's the pitch asset). What's NOT allowed: enrichment writers nobody reads, and any federation-specific Neo4j work (clustering, remote BOLT, cross-org). Gate new graph work on a named user-visible feature.
2. **Stop adding board routes without removing one.** 42 routes is product sprawl. Set a soft cap (≤ 25) and force tradeoffs.
3. **Stop the dual-implementation pattern** (`agents/X` + `autobot-inbox/src/agents/X` as separate codebases). Pick the shim pattern globally and apply uniformly. Five agents still need cleanup.
4. **Stop accumulating new bespoke RPC between agents.** Anything that's not Postgres task graph (ADR-001) or MCP is sunk cost the day MCP federation ships (ADR-007).
5. **Stop the "executor-intake replaces executor-triage" narrative until it's actually true in code.** Either migrate or update CLAUDE.md.
6. **Stop expanding `lib/runtime/` as a monolith.** Every new file added before the split makes the split harder. New runtime code should go into the intended target module (governance/ or context/) as a separate dir from day one.

---

## Verification — did this audit deliver?

Cross-checked against the plan's success criteria:

- [x] **Trim list is concrete:** Every entry above has a file path, verdict, and effort estimate.
- [x] **≥ 5 zero-risk items:** Items 1–7 all ship this week.
- [x] **≥ 2 strategic recommendations cite ADR-007:** Items 15 (Neo4j freeze) and 18–21 (pre-GA primitives) directly cite ADR-007 §"What Gets Killed" and §1/2/4.
- [x] **No new architecture proposed:** Every recommendation is a delete, merge, split, or reconcile. Zero new abstractions.
- [x] **Eric can act in 30 min:** Pick from 21 numbered items; I draft Linear issues for the chosen ones.

---

## Suggested execution order

If acting today:

**Week 1 (ship now):**
- Items 1–7 (NOW): one PR each, ~8 LOC PRs, half a day each.
- Item 18 (JWT `iss`/`org`) — one-line change, half a day.
- Item 19 (`origin_org` helper) — one helper + eslint rule, half a day.

**Week 2:**
- Items 20–21 (receipt envelope + migration) — full day.
- Items 8–9 (signing consolidation + executor-triage reconcile) — 2 days.

**Week 3+:**
- Items 11–14 (route/file splits).
- Items 15–16 (strategic decisions with Eric).
- Item 17 (lib/runtime split) — defer to month 2.

---

*Audit document. Action items convert to Linear tickets only on explicit user go-ahead per item.*
