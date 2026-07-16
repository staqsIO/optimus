# SPEC v1.0 — Board Decision Document

> **Purpose:** Consolidate all open items from `conversation/` entries, addenda, gap analyses, and reviews into actionable decisions for finalizing SPEC.md v1.0.
> **Date:** 2026-03-10
> **Status:** DRAFT — awaiting board review

---

## Conversation Folder Disposition

18 files spanning 450KB. Entries 001-007 are **historical** — they shaped the spec from v0.1 through v0.4 and are fully incorporated. Entries 008-016 contain open proposals. Recommendation: archive 001-007 and the unnumbered `linkedin-channel-analysis.md` into `conversation/archive/`, keep 008-016 until decisions below are resolved, then archive those too.

### File Status

| Entry | Status | Notes |
|-------|--------|-------|
| 001-007 | INCORPORATED | Shaped v0.1→v0.4→v0.7.0. Archive. |
| 008 | PARTIALLY INCORPORATED | 3 critical items still open (see D1-D3 below) |
| 009 | PARTIALLY INCORPORATED | GitHub workflow proposed but not finalized |
| 010 | INCORPORATED | agents.md adoption reflected in spec |
| 011 | CLOSED | DEN/DOM rejected by Liotta. No action. Archive. |
| 012 | DEFERRED | LinkedIn content automation = Phase 1.5. Not spec material. Archive. |
| 013 | POLICY | Workstream separation / spec freeze. Needs ratification (see D8). |
| 014 | OPEN | the agency discovery — entity resolution, data freshness gaps (see D5-D6) |
| 015 | DEFERRED | Governance extraction scoping. Post-Phase 1. Archive for now. |
| 016-behavioral-contracts | OPEN | agents.md schema expansion (see D7) |
| 016-paperclip-analysis | OPEN | 3 proposals: session persistence, cost attribution, invocation triggers (see D9) |
| linkedin-channel-analysis | INCORPORATED | Conclusion (multi-principal first) absorbed. Unnumbered. Archive. |

**Naming collision:** Two files numbered 016. Renumber paperclip to 017 when archiving.

---

## Decisions Required

### CRITICAL — Must resolve for v1.0

#### D1: Cost Model Correction (from 008)

**Issue:** SPEC.md section 15 cost model is understated by ~50%. Missing output token costs, retry overhead, context compaction, gateway processing. Original estimate: $1.5-3.2K/mo. Corrected estimate: $2.2-4.5K/mo.

**Options:**
- (a) Update section 15 with corrected numbers and explicit token arithmetic
- (b) Remove specific dollar amounts from spec, reference a living cost model document instead

**Decision:** (b) accepted — revised to strip all dollar amounts. Spec owns mechanism (G1 gate + per-invocation token logging), not numbers. Cost unit is tokens per tier.

---

#### D2: Guard Check Atomicity (from 008)

**Issue:** SPEC pseudocode shows `guardCheck()` and `transition_state()` as separate operations. This creates a race condition — an agent could pass the guard check, then the state changes before the transition executes.

**Decision:** Already resolved. SPEC.md §5 already mandates single atomic Postgres transaction (fixed in a prior version). No change needed.

---

#### D3: Kill Switch Fail-Closed (from 008)

**Issue:** Current spec says "fail-open < 1 hour" when kill switch health checks fail. Linus flagged: 60 minutes of unsupervised operation violates P5 ("measure before you trust").

**Decision:** Already resolved. SPEC.md §9 already says "Fail-closed after 3 consecutive failed checks (~3 min)". No change needed.

**Original options for reference:**
- (a) Fail-closed: enter HALT after 3 consecutive check failures (~3 minutes)
- (b) Keep fail-open with reduced window (e.g., 5 minutes)
- (c) Tiered: degrade to reduced-capability mode after 3 failures, full HALT after 10

**Recommendation:** (a) — fail-closed is the only option consistent with P1 (deny by default).

---

#### D4: Content Sanitization Specification (from 008)

**Issue:** Spec says "strip known injection patterns" without defining what that means. No pattern database, no update mechanism, no false-positive targets. P2 (infrastructure enforces) is unenforceable without a concrete spec.

**Options:**
- (a) Full sanitization spec in SPEC.md (pattern classes, update cadence, testing methodology)
- (b) Reference an external sanitization standard (OWASP LLM Top 10) and require conformance
- (c) Defer — sanitization is implementation detail, spec just requires "infrastructure-enforced input validation"

**Decision:** (c) accepted — spec mandates infrastructure-enforced input validation as a requirement. Implementation details (patterns, rule sets, testing) go in an ADR.

---

### HIGH PRIORITY — Should resolve for v1.0

#### D5: Entity Resolution Architecture (from 014)

**Issue:** a recruiting agency discovery call revealed that contacts exist across multiple channels with multiple identities. No entity resolution in current architecture. Blocks multi-user scenarios and recruiting use case.

**Options:**
- (a) Add entity resolution as a new spec section (contact graph, identity linking, merge rules)
- (b) Defer to Phase 2 — document as a known gap with forward reference
- (c) Add as an ADR with architectural constraints, not full spec

**Decision:** Rejected from spec scope. Entity resolution is a product-level concern for autobot-inbox, not an architectural primitive. Track via GitHub issue #56.

---

#### D6: Data Freshness (from 014)

**Issue:** Signals and contact data rot silently. No `verified_at`, `stale_after`, or freshness scoring concept in the spec.

**Options:**
- (a) Add freshness metadata to signal schema in spec
- (b) Implementation detail — add to autobot-inbox schema, not spec-level

**Decision:** Out of spec scope. Product-level schema concern for autobot-inbox.

---

#### D7: Behavioral Contracts for agents.md (from 016)

**Issue:** Proposes adding `communication_style`, `success_metrics`, and `workflow_phases` to the agents.md schema. Makes reviewer validation formalizable.

**Options:**
- (a) Accept all three fields into spec's agent configuration section
- (b) Accept `success_metrics` only (most valuable for P5 measurement)
- (c) Defer — agents.md schema is implementation config, not spec material

**Decision:** Accepted as spec-level requirement in §2. Spec mandates agents declare behavioral contracts (expected outputs, success criteria, interaction norms). Schema fields are implementation-defined.

---

### MEDIUM PRIORITY — Can defer past v1.0

#### D8: Spec Freeze Policy (from 013)

**Issue:** Entry 013 proposed freezing spec at v0.7.0 until autobot-inbox v1.0 ships. No new MAJOR/MINOR bumps — only PATCH for corrections.

**Options:**
- (a) Ratify the freeze — ship v1.0 spec only after autobot-inbox v1.0 validates it
- (b) Release v1.0 now with current decisions, iterate with patches

**Decision:** (b) accepted — freeze lifted. v1.0.0 released with D1-D7 incorporated.

---

#### D9: Paperclip Competitive Proposals (from 016-paperclip)

Three proposals from competitive analysis:

| Proposal | Value | Recommendation |
|----------|-------|----------------|
| Agent session persistence table | Performance optimization | Defer — implementation detail, not spec |
| Cost attribution by workstream | Board reporting | Defer — add as operational requirement, not spec section |
| Explicit invocation triggers (invocation_log) | Audit completeness | Defer — already partially covered by P3 transparency |

**Decision:** All three out of spec scope. Track as product-level GitHub issues.

---

#### D10: GitHub Workflow Governance (from 009)

**Issue:** Dustin proposed full CODEOWNERS spec, branch protection rules, and review routing. Partially reflected in spec as "proposed §14.1" but never finalized.

**Options:**
- (a) Finalize as spec section (this is infrastructure enforcement per P2)
- (b) Implement via GitHub settings + ADR, not spec-level

**Decision:** Out of spec scope. Covered by P2 principle + operational GitHub config (CODEOWNERS, branch protection). Already implemented.

---

#### D11: Multi-User / ADR-002 Evolution (from 014, linkedin-analysis)

**Issue:** ADR-002 chose individual install (own DB, own OAuth, own budget per user). the agency discovery revealed need for shared entity graph across 4+ users. LinkedIn analysis concluded "multi-principal architecture first."

**Options:**
- (a) Revise ADR-002 in spec to acknowledge multi-user as Phase 2 requirement
- (b) Leave ADR-002 as-is — it explicitly says "revisit at 3+ users"

**Decision:** (b) accepted — ADR-002 unchanged. Revisit at 3+ users as written.

---

## Addenda & Gap Analysis Disposition

These files were merged to main but their relationship to SPEC.md is unclear:

| File | Content | Recommendation |
|------|---------|----------------|
| `SPEC-ADDENDUM-1.md` (autobot-spec/) | Context poisoning defenses | Extract actionable items into D4 (sanitization). Archive. |
| `SPEC-ADDENDUM-Academic-Research.md` | Academic references (Pentland, governance) | Research bibliography. Keep as reference. Not spec material. |
| `SPEC-ADDENDUM-CONSOLIDATED-2026-03-03-to-03-07.md` | Field work synthesis | Extract decisions into this document. Archive after. |
| `SPEC-ADDENDUM-OPENDEV-2026-03-08.md` | OpenDev conference insights | Research input. Keep as reference. Not spec material. |
| `tds-gap-analysis-2026-03-08.md` | TDS analysis vs SPEC v0.7.0 | Gap analysis — review for any items not covered by D1-D11. Archive. |
| `sage-gap-analysis.md` | SAGE protocol analysis vs SPEC v0.7.0 | Gap analysis — review for any items not covered by D1-D11. Archive. |
| `cross-document-alignment-analysis.md` | Cross-document consistency check | Meta-analysis. Useful for v1.0 consistency pass. Archive after. |

---

## v1.0 Release Plan

1. ~~**Board reviews D1-D7** and makes accept/reject/defer decisions~~ DONE (2026-03-10)
2. ~~**Apply accepted changes** as diffs to SPEC.md~~ DONE
3. ~~**Bump version** to v1.0.0~~ DONE
4. **Archive** conversation entries 001-013 + resolved items to `conversation/archive/`
5. **Move** gap analyses and addenda to `autobot-spec/research/` (reference material, not spec)
6. **Clean up** root-level analysis files (currently cluttering repo root)
7. **Update companion documents list** in SPEC.md header
8. **Delete merged branches** (15 stale remote branches)

---

## Quick Reference: What Goes Where

| Content Type | Location |
|-------------|----------|
| Architecture specification | `SPEC.md` |
| Architecture decisions | `autobot-spec/decisions/` |
| Historical conversations | `autobot-spec/conversation/archive/` |
| Research & gap analyses | `autobot-spec/research/` |
| Implementation docs | `autobot-inbox/docs/internal/` |
| Product-level ADRs | `autobot-inbox/docs/internal/adrs/` |
