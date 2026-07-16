# Scope Lock: Phase 1 vs Phase 2 Boundary

**Version:** 1.0
**Date:** 2026-04-01
**Classified against:** SPEC.md v1.0.0 (2026-03-10)
**Sources:** SPEC.md v1.0.0, ADR-018 (2026-03-07), ADR-015 (2026-03-02, superseded), CONCERNS.md (2026-04-01)

> **Version note:** CLAUDE.md references SPEC.md v0.7.0 in several places; the actual SPEC.md file header reads v1.0.0 dated 2026-03-10. This document classifies against the actual file (v1.0.0). Board members should note the discrepancy — CLAUDE.md should be updated to reflect the current spec version.

---

## Executive Summary

Every SPEC.md section (22 total, §0 through §21 including §5a and §14.1) has been classified as P1-REQUIRED, P1-PARTIAL, P2-DEFERRED, or NOT-APPLICABLE. Classification is based on three authoritative sources: SPEC.md v1.0.0 (canonical architecture target), ADR-018 (2026-03-07 board mandate reversing ADR-015 on JWT), and CONCERNS.md (2026-04-01 codebase analysis). **Recommendation: the board should approve this document as the audit anchor before any Phase 2-6 compliance fixes are written.** Twelve sections are P1-REQUIRED, five are P1-PARTIAL, two are P2-DEFERRED, and nine are NOT-APPLICABLE. No section is unclassified.

Phase 1 requires full implementation of: design principles enforcement (§0), architecture overview compliance (§2), task graph completeness (§3), agent runtime tier constraints (§4), kill switch (§9), cost tracking (§10), failure mode handling (§11), source control and code review (§14.1), and operating cost model instrumentation (§15). Phase 1 partial scope includes guardrail enforcement JWT/RLS boundary (§5), tool integrity layer hash verification (§6), communication gateway shadow mode (§7), audit observability Tier 1 (§8), and single-pass strategy evaluation (§19). Per ADR-018 §Out of Scope, per-agent database roles and token revocation are explicitly Phase 2. The knowledge graph layer (§5a) is P2-DEFERRED, gated on Linus security fixes per ADR-019.

**One contradiction requires board resolution before Phase 3 begins.** CONCERNS.md (2026-04-01) recommends implementing a token revocation list as Phase 1 work on the grounds that agents are already running on shared infrastructure (Railway). ADR-018 (2026-03-07) explicitly defers token revocation to Phase 2, stating the kill switch is sufficient for Phase 1. The 25-day gap between these documents is significant: ADR-018 was written when Railway deployment was the trigger for reversing ADR-015, while CONCERNS.md was authored with explicit knowledge that shared-infrastructure deployment is live. Neither position wins automatically — this document holds the ADR-018 classification (P2-DEFERRED) and flags the contradiction for board resolution. See the "Board Resolution Required" section below.

---

## Classification Table

| Section | Title | Classification | Source / Rationale |
|---------|-------|----------------|--------------------|
| §0 | Design Principles | P1-REQUIRED | P1-P6 are foundational; each must have at least one enforcement point in the codebase. Default rule (D-06) applies: no source defers these. |
| §1 | The Core Idea | NOT-APPLICABLE | Conceptual framing only — no implementation deliverables. Classifying code against a vision statement is not meaningful. |
| §2 | Architecture Overview | P1-REQUIRED | Agent tiers, orchestration layer, and JWT/RLS/guardCheck diagram are Phase 1 core per SPEC §14 exit criteria. |
| §3 | The Task Graph | P1-REQUIRED | agent_graph schema and work item state machine are the Postgres coordination backbone. Phase 1 core per SPEC §14. |
| §4 | Agent Runtime | P1-REQUIRED | Agent loop, tier constraints, and model assignments are Phase 1 core. Default rule (D-06) applies. |
| §5 | Guardrail Enforcement | P1-PARTIAL | JWT per ADR-018 Phase 1 scope; per-agent roles and token revocation deferred. See sub-table below. |
| §5a | Knowledge Graph Layer | P2-DEFERRED | ADR-019 status: Proposed. Deployment gated on Linus security fixes. Not a Phase 1 exit requirement per SPEC §5a status note. |
| §6 | Tool Integrity Layer | P1-PARTIAL | Hash verification before tool invocation is Phase 1; sandboxed execution environment is Phase 2. See sub-table below. |
| §7 | Communication Gateway | P1-PARTIAL | Shadow mode (draft, no auto-send) is Phase 1; Tier 0-1 auto-send capability is Phase 2. See sub-table below. |
| §8 | Audit and Observability | P1-PARTIAL | Tier 1 hourly audit is Phase 1; Tier 2 AI Auditor and Tier 3 cross-run analysis are Phase 2. See sub-table below. |
| §9 | Kill Switch | P1-REQUIRED | Phase 1 core — board-triggered HALT is a fundamental governance control. Default rule (D-06) applies. |
| §10 | Cost Tracking | P1-REQUIRED | Phase 1 core — G1 budget gate depends on cost ledger. Partial implementation already exists; audit to verify completeness. |
| §11 | Failure Modes | P1-REQUIRED | Retry logic (up to 3 times), escalation, and dead-man switch are Phase 1 requirements per SPEC §14. |
| §12 | Database Architecture (AutoBot Extension) | NOT-APPLICABLE | AutoBot-only extension. Optimus Phase 1 uses standard agent_graph, inbox, voice, signal, content schemas. |
| §13 | AutoBot Constitution Summary | NOT-APPLICABLE | AutoBot Phase 3+. Outside Optimus Phase 1 scope. |
| §14 | Phased Execution Plan | NOT-APPLICABLE | Reference document and classification source; not itself a deliverable. Classifying the roadmap against itself is not meaningful. |
| §14.1 | Source Control and Code Review Architecture | P1-REQUIRED | Phase 1 deliverable explicitly listed in §14 exit criteria. Audit coverage required. |
| §15 | Operating Cost Model | P1-REQUIRED | Phase 1 cost instrumentation per SPEC §14 and SPEC §15. G1 gate (budget ceiling) depends on this. |
| §16 | Open Questions Resolved | NOT-APPLICABLE | Historical record of resolved questions. Not a deliverable. |
| §17 | Legal Compliance Architecture | NOT-APPLICABLE | Phase 0 prerequisite. Outside compliance audit scope — legal structure is a board-level concern, not a code audit target. |
| §18 | Autonomous Software Composition | NOT-APPLICABLE | Phase 2+. Not an Optimus Phase 1 deliverable. |
| §19 | Strategy Evaluation Protocol | P1-PARTIAL | Single-pass evaluation is Phase 1; three-perspective evaluation with adversarial agent is Phase 2. See sub-table below. |
| §20 | What This Document Does Not Cover | NOT-APPLICABLE | Meta-section, not a deliverable. |
| §21 | Changelog | NOT-APPLICABLE | Version history. Not an implementation deliverable. |

---

## P1-PARTIAL Sub-Tables

### §5 Guardrail Enforcement — Phase Boundary Detail

Source: ADR-018 (2026-03-07). ADR-018 supersedes ADR-015 on JWT scope.

| Item | P1 Scope | Deferred |
|------|----------|---------|
| guardCheck() atomic with transition_state() | P1-REQUIRED — single Postgres transaction per spec §5 | — |
| JWT issuer (initializeJwtKeys) | P1-REQUIRED — complete per CONCERNS.md | — |
| JWT signing (issueToken, RS256) | P1-REQUIRED — complete per CONCERNS.md | — |
| JWT verification (verifyToken) | P1-REQUIRED — complete per CONCERNS.md | — |
| withAgentScope() validates JWT before set_config | P1-REQUIRED per ADR-018 §Decision item 4; implementation status to be audited in Phase 3 | — |
| RLS activation (autobot_agent role) | P1-REQUIRED per ADR-018 §Decision item 5; activation status to be audited in Phase 3 | — |
| Content sanitization (static rule set) | P1-REQUIRED; versioned rule set management → Phase 2 | Versioned rule sets |
| Per-agent DB roles (one role per agent) | — | P2-DEFERRED (ADR-018 §Out of Scope) |
| Token revocation list | — | P2-DEFERRED per ADR-018; CONTRADICTION — see Board Resolution Required section |
| External JWT verification | — | P2-DEFERRED (ADR-018 §Out of Scope) |

---

### §6 Tool Integrity Layer — Phase Boundary Detail

Source: SPEC §6 content; default rule (D-06) applies for items neither ADR-018 nor CONCERNS.md addresses explicitly.

| Item | P1 Scope | Deferred |
|------|----------|---------|
| Tool hash verification before invocation | P1-REQUIRED per spec §6; audit to verify implementation | — |
| Tool allow-list enforcement per agent tier | P1-REQUIRED per spec §6 (P1 Deny by default) | — |
| Sandboxed tool execution environment | — | P2-DEFERRED — spec §6 notes sandboxing as a hardening layer beyond hash verification |
| Dynamic tool registration from external sources | — | P2-DEFERRED — introduces supply chain risk; not in Phase 1 exit criteria |

---

### §7 Communication Gateway — Phase Boundary Detail

Source: SPEC §7 content; autobot-inbox operational model (shadow mode, all drafts require approval at L0).

| Item | P1 Scope | Deferred |
|------|----------|---------|
| Shadow mode drafting (all replies as drafts) | P1-REQUIRED — current L0 operational mode | — |
| Multi-channel adapter abstraction (Gmail, Outlook, Slack) | P1-REQUIRED — adapter registry already implemented | — |
| Board approval workflow for drafts | P1-REQUIRED — CLI + dashboard approval paths exist | — |
| Tier 0 auto-send (noise/FYI auto-archive) | — | P2-DEFERRED — requires L1 autonomy gate passage (50+ drafts, <10% edit rate, 14 days) |
| Tier 1 auto-send (routine replies without approval) | — | P2-DEFERRED — requires L2 autonomy gate and further capability proof |
| Outbound channel expansion (WhatsApp, webhook auto-trigger) | — | P2-DEFERRED — not in Phase 1 exit criteria |

---

### §8 Audit and Observability — Phase Boundary Detail

Source: SPEC §8 content; CONCERNS.md observability notes; default rule (D-06) applies.

| Item | P1 Scope | Deferred |
|------|----------|---------|
| Tier 1: Hourly automated audit (state transition hash chain verification) | P1-REQUIRED per spec §8 | — |
| Append-only state_transitions with hash chain | P1-REQUIRED (P3 Transparency by structure) | — |
| Public event archive (searchable, filterable) | P1-REQUIRED per SPEC §2 architecture diagram | — |
| Merkle proof artifact generation | P1-REQUIRED per spec §8 and merkle-publisher.js reference | — |
| LLM-based activity summarization (Tier 1.5) | P1-PARTIAL — basic activity logging Phase 1; AI-generated narrative summaries deferred | AI narrative summaries |
| Tier 2: AI Auditor agent (cross-run anomaly detection) | — | P2-DEFERRED — requires baseline data and capability proof before activating auditor agent |
| Tier 3: Cross-run analysis and pattern detection | — | P2-DEFERRED — Phase 2+ capability |
| Spec drift detection (automated) | — | P2-DEFERRED — infrastructure.js notes this as future capability |

---

### §19 Strategy Evaluation Protocol — Phase Boundary Detail

Source: SPEC §19 content; evaluation-protocol.js in codebase.

| Item | P1 Scope | Deferred |
|------|----------|---------|
| Single-pass strategy evaluation (Strategist agent) | P1-REQUIRED — current implementation | — |
| Priority scoring and recommendation output | P1-REQUIRED — Strategist in suggest mode | — |
| Three-perspective evaluation (advocate, skeptic, neutral) | — | P2-DEFERRED — requires multi-agent evaluation infrastructure |
| Adversarial evaluation agent | — | P2-DEFERRED — Phase 2+ capability |
| Cross-strategy comparison and ranking | — | P2-DEFERRED — depends on three-perspective infrastructure |

---

## Board Resolution Required

### BOARD RESOLUTION REQUIRED: Token Revocation Timeline (HIGH SEVERITY)

This contradiction must be resolved by the board before Phase 3 (Identity and Enforcement audit) begins. Both positions are stated below. This document makes no recommendation — the board decides.

| Source | Date | Position |
|--------|------|----------|
| ADR-018 | 2026-03-07 | "Token revocation list" is explicitly listed under "Out of Scope (Phase 2)". Rationale: "kill switch is sufficient for Phase 1." |
| CONCERNS.md | 2026-04-01 | Under "Missing Critical Features — Token Revocation List": "Should be Phase 1 if agents run on shared infrastructure." Implementation note: in-memory blocklist in `src/runtime/agent-jwt.js`, cleared on HALT. |

**Context for board decision:**
- ADR-018 was written on the day Railway deployment was decided as the trigger condition for reversing ADR-015. The shared-infrastructure concern was part of the context when ADR-018 was written.
- CONCERNS.md was authored 25 days later (2026-04-01) with explicit awareness that Railway deployment is live and agents are operating on shared infrastructure.
- The 15-minute JWT TTL means a killed or compromised agent token remains valid for up to 15 minutes without a revocation list. The kill switch (HALT) stops the process but does not invalidate outstanding tokens.
- Implementation cost is low: in-memory blocklist with HALT-clear is a small addition to `agent-jwt.js`.

**Current classification:** P2-DEFERRED (following ADR-018, the board's most recent explicit decision). Classification will be updated to P1-REQUIRED if board resolution in this PR overrides ADR-018 on this point.

---

### NOTED: RLS Enforcement Activation Gap (MEDIUM SEVERITY — Implementation Gap, Not Strategic Contradiction)

This is an implementation status gap, not a strategic disagreement. Both sources agree RLS activation is Phase 1 scope — the gap is in activation status.

| Source | Date | Position |
|--------|------|----------|
| ADR-018 | 2026-03-07 | "RLS activation — connect as `autobot_agent` role with RLS policies enforced" — listed as in Phase 1 implementation scope. |
| CONCERNS.md | 2026-04-01 | "RLS enforcement: Partial (policies defined, enforcement optional)" — reports activation is incomplete. |

**Context:** ADR-018 mandates RLS activation as a Phase 1 deliverable. CONCERNS.md reports the current implementation has RLS policies defined in schema but enforcement not fully active. This is a compliance gap that Phase 3 (Identity and Enforcement audit) will measure and fix. No board decision needed — the scope classification (P1-REQUIRED for RLS activation, per §5 sub-table) is agreed by both sources. The gap is execution status, not scope assignment.

**Resolution:** Phase 3 will audit all `withAgentScope()` callsites, verify RLS policy coverage, and activate enforcement with a feature flag + staging smoke test (per STATE.md Pre-Phase 3 blocker note).

---

## Default Rule

SPEC sections where neither ADR-018 nor CONCERNS.md takes an explicit position on phase assignment default to **P1-REQUIRED** (conservative approach per D-06). This forces the compliance audit to verify every spec claim, rather than silently treating unaddressed items as out of scope. Any section classified P1-REQUIRED by default that cannot be implemented within Phase 1 constraints should be escalated to the board for explicit P2 deferral — gaps must be named, not ignored.

Sections classified by default rule (no conflicting source): §0, §2 (partial), §4, §9, §11, §14.1, §15.

---

## Document Purpose

This document is the **audit anchor** for the Optimus Spec Compliance Audit (Phases 1-6). Every compliance finding, fix commit, and phase exit report in Phases 2-6 references back to this classification table. A finding for a P1-REQUIRED or P1-PARTIAL section becomes an active fix target. A finding for a P2-DEFERRED or NOT-APPLICABLE section becomes a deferred item logged for the appropriate future phase.

**Requirement addressed:** FOUN-05 — Phase 1 vs Phase 2 scope boundary formalized from CONCERNS.md and ADR-018 before any code changes are written.

**How to cite this document in fix commits:**
```
fix(audit): [description of fix]

Addresses scope-lock §5 P1-REQUIRED: [specific item]
Refs: autobot-inbox/docs/internal/SCOPE-LOCK.md
```

**Document maintenance:** This document is versioned at v1.0. Updates require a PR with board review. Classification changes are board decisions (see D-05, D-07 in CONTEXT.md).
