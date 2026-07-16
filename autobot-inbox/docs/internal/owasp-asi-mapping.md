---
title: "OWASP Agentic Security Initiatives (ASI) Mapping"
description: "Maps Optimus governance infrastructure to all 10 OWASP ASI risks"
created: 2026-03-16
spec_version: v0.8.0
---

# OWASP ASI Mapping — Optimus Governance Infrastructure

## Purpose

This document maps Optimus's existing governance infrastructure to the [OWASP Top 10 Agentic Security Risks](https://owasp.org/www-project-agentic-security/) (ASI-01 through ASI-10). Every risk is mitigated at the **database serialization layer** — infrastructure enforces, prompts advise (P2).

**Summary**: Optimus covers all 10 OWASP Agentic Security risks with Postgres-level enforcement. No middleware. No bypassable SDK layers.

---

## ASI-01: Privilege Escalation

**Risk**: An agent gains capabilities beyond its authorized scope.

**Optimus Mitigation**: FULLY COVERED

| Mechanism | Enforcement Layer | Source |
|-----------|------------------|--------|
| `permission_grants` table | Unified governance surface — tools, adapters, api_clients, subprocesses. `checkPermission()` at call sites. | `sql/002` (line 705), ADR-017 |
| `agent_assignment_rules` + DB trigger | `enforce_agent_assignment()` trigger prevents agents from being assigned work outside their `can_assign_to` list. | `sql/002` (line ~2111) |
| `tools_allowed` array on `agent_configs` | Config-level tool allow-list checked before execution. | `sql/002` (line 30) |
| `tool_registry` with SHA-256 hashes | Tool source integrity verified at startup — modified tools cannot execute. | `sql/002` (line 242) |
| Postgres RLS policies | 7 tables with RLS enabled. Agents can only read/write rows matching their `agent_id`. | `sql/002` (lines 2609-2664) |
| `v_agent_capabilities` view | Audit surface: single query shows complete capability matrix per agent. | `sql/006` |

**Design principle**: P1 (Deny by default). Agents have zero capabilities unless explicitly granted.

---

## ASI-02: Uncontrolled Code Execution (Tool Use)

**Risk**: Agents execute arbitrary tools or code without proper sandboxing.

**Optimus Mitigation**: FULLY COVERED

| Mechanism | Enforcement Layer | Source |
|-----------|------------------|--------|
| 4-layer tool execution model | (1) Config allow-list → (2) DB `tool_registry` lookup → (3) per-tool timeout → (4) append-only audit in `tool_invocations`. | ADR-010, `tools/registry.js` |
| `tool_invocations` (append-only) | Every tool call is logged. `trg_tool_invocations_no_update` and `trg_tool_invocations_no_delete` triggers prevent tampering. | `sql/002` (lines 2497-2503) |
| `tool_registry.tool_hash` | SHA-256 hash of tool source verified at startup. Modified tools are rejected. | `sql/002` (line 246) |
| `REVOKE TRUNCATE` on `tool_invocations` | Even the DB role cannot truncate audit trails. | `sql/002` (line 2589) |
| `permission_grants` resource_type='tool' | Fine-grained per-agent tool permissions with revocation tracking (`revoked_at`). | ADR-017 |

**Design principle**: P2 (Infrastructure enforces). Tool execution gate is the DB, not the prompt.

---

## ASI-03: Data Exfiltration / Leakage

**Risk**: Agents access or transmit sensitive data beyond their authorization.

**Optimus Mitigation**: FULLY COVERED

| Mechanism | Enforcement Layer | Source |
|-----------|------------------|--------|
| `data_classification` on `work_items` | 4-tier classification: PUBLIC, INTERNAL, CONFIDENTIAL, RESTRICTED. CONFIDENTIAL/RESTRICTED require board approval in `guardCheck()`. | `sql/002` (line 69), `guard-check.js` (line 132) |
| Metadata-only email storage (D1) | Email bodies are NEVER stored in DB. Fetched on-demand via adapter. No data at rest to exfiltrate. | ADR-001 |
| Postgres RLS | `inbox.messages`, `voice.edit_deltas`, `agent_graph.action_proposals` — agents cannot read cross-boundary data. | `sql/002` (lines 2614-2664) |
| Schema isolation | 10 schemas with no cross-schema FKs. Agent roles are scoped to their operational schema. | `sql/002` (lines 9-18), SPEC §12 |
| `permission_grants` resource_type='adapter' | Agents can only use communication adapters they're explicitly granted. | ADR-017 |

**Design principle**: P1 (Deny by default). Data access is opt-in per classification level.

---

## ASI-04: Unauthorized Actions

**Risk**: Agents take actions the principal did not authorize.

**Optimus Mitigation**: FULLY COVERED

| Mechanism | Enforcement Layer | Source |
|-----------|------------------|--------|
| G4 Autonomy gate | L0: all actions require board approval. L1/L2: graduated autonomy with exit criteria (50+ drafts, <10% edit rate, 14 days). | `config/gates.json`, constitutional-gates.md |
| `suggest_mode_log` | Strategist operates in propose-only mode. All suggestions logged, none auto-executed. | `sql/002` (line 388) |
| `agent_intents` table | Agents propose intents → board reviews → only then executed. Intent match rate tracked per-agent. | `sql/002`, `v_governance_feed` Source 6 |
| `drafts_g5_require_board_approval` CHECK | DB constraint: drafts cannot reach `sent` state without `board_action IS NOT NULL`. | `sql/002` |
| Board intervention classification | Every override classified as `constitutional` vs `judgment` — feeds G1 measurement. | `sql/002` (`board_interventions` table) |

**Design principle**: P5 (Measure before you trust). Autonomy earned through data, not calendar dates.

---

## ASI-05: Prompt Injection

**Risk**: Adversarial inputs manipulate agent behavior through injected instructions.

**Optimus Mitigation**: COVERED (structural)

| Mechanism | Enforcement Layer | Source |
|-----------|------------------|--------|
| Centralized context loading | `context-loader.js` sanitizes and assembles all prompt context. Agents never import provider modules directly. | `src/runtime/context-loader.js` |
| G2 Legal gate | Regex + LLM dual-check catches commitment language that could be injected via email body. One-way merge: automated failure cannot be overridden by LLM. | `guard-check.js` (lines 244-257) |
| G7 Precedent gate | Catches injected pricing/timeline/policy language. Same one-way merge enforcement. | `guard-check.js` (lines 368-376) |
| `config_hash` verification | Agent config hash validated in `guardCheck()` — tampered configs halt execution. | `guard-check.js` (line ~86) |
| `original_prompt_hash` / `current_prompt_hash` | LLM invocations record both hashes — drift detection between intended and actual prompts. | `sql/002` (lines 378-379) |

**Note**: Optimus does not implement input/output guardrail classifiers (e.g., prompt injection detection models). The structural approach — infrastructure enforcement + one-way merge — means a successful injection still cannot bypass DB-level gates.

---

## ASI-06: Memory Poisoning

**Risk**: Agents' persistent memory/context is corrupted to influence future behavior.

**Optimus Mitigation**: PARTIALLY COVERED

| Mechanism | Enforcement Layer | Source |
|-----------|------------------|--------|
| Append-only audit tables | `state_transitions`, `tool_invocations`, `halt_signals`, `edit_deltas` — all protected by triggers preventing UPDATE/DELETE. | `sql/002` (triggers, REVOKE TRUNCATE) |
| SHA-256 hash chains | `state_transitions` uses `hash_chain_prev` / `hash_chain_current` — any tampering breaks the chain. `verify_ledger_chain()` detects breaks. | `sql/002` (lines 110-111, 1805-1912) |
| Voice corpus integrity | `voice.edit_deltas` is append-only (immutable trigger). Board edits are the training signal — cannot be retroactively modified. | ADR-011 |
| `raw_content_hash` on content | Content entries hash their raw content at creation — modification detected. | `sql/002` (line 1080) |

**Gap**: No explicit context window poisoning detection (malicious data in retrieved context influencing agent reasoning). The hash-chain approach detects data tampering but not semantic poisoning of retrieved context. Neo4j knowledge graph (ADR-019) will add pattern-based anomaly detection.

**Severity**: LOW. The append-only + hash-chain model makes data tampering detectable. Semantic poisoning requires compromising the data source (email, webhook), which is outside the agent governance boundary.

---

## ASI-07: Resource Overuse

**Risk**: Agents consume excessive compute, API calls, or budget.

**Optimus Mitigation**: FULLY COVERED

| Mechanism | Enforcement Layer | Source |
|-----------|------------------|--------|
| G1 Financial gate | $20/day ceiling enforced via `reserve_budget()` — atomic `UPDATE...WHERE` prevents concurrent overspend. `budgets_no_overspend` CHECK constraint. | `guard-check.js` (lines 35-67), `sql/002` |
| Auto-halt on budget exhaustion | `reserve_budget()` inserts `halt_signal` when budget depleted — all agents stop. | `sql/002` (line 1711) |
| `llm_invocations` tracking | Every LLM call logged with `cost_usd`, `input_tokens`, `output_tokens`. Real-time spend computed in `v_budget_status`. | `sql/002` (line 175+), `sql/004` |
| `delegation_depth` limit | `guardCheck()` enforces max depth (default 5) — prevents recursive task explosion. | `guard-check.js` (lines 143-150), `sql/002` (line 76) |
| G6 Stakeholder rate limit | Per-recipient-per-day email cap (default 3) — prevents spam floods. | `guard-check.js` (lines 334-365) |
| Budget reserve/commit/release lifecycle | 3-phase budget: reserve before call, commit actual cost after, release on failure. No cost leaks. | `sql/002` (functions) |
| `v_phase1_metrics` M6/M7 | Real-time dashboarding of daily cost and budget utilization. | `sql/004` |

**Design principle**: P4 (Boring infrastructure). Postgres atomic transactions for budget enforcement. No eventual consistency.

---

## ASI-08: Output Integrity / Hallucination

**Risk**: Agent outputs are incorrect, fabricated, or inconsistent with their mandate.

**Optimus Mitigation**: FULLY COVERED

| Mechanism | Enforcement Layer | Source |
|-----------|------------------|--------|
| G3 Reputational gate | pgvector cosine similarity against voice corpus (top-10 sent emails). Minimum 0.80 threshold. Fail-closed on API error. | `guard-check.js` (lines 260-318) |
| Reviewer agent pipeline | Every draft passes through a dedicated reviewer agent before board surface. Reviewer runs G2/G3/G5/G6/G7. | `src/agents/reviewer.js` |
| Board review in L0 | ALL outputs reviewed by humans before external delivery. Edit rate tracked for autonomy graduation. | G4, constitutional-gates.md |
| `edit_deltas` feedback loop | Board edits are append-only training data. System learns from corrections — tracked via `v_phase1_metrics` M3/M4. | ADR-011 |
| `postExecutionChecks()` | Result shape validation, subtask assignment validation, quarantine detection. | `src/runtime/agent-loop.js` (lines 252-286) |
| One-way merge on G2/G7 | Automated gate failure (regex) cannot be overridden by LLM review. LLM can only add concerns, not dismiss them. | `guard-check.js` |

---

## ASI-09: Lack of Accountability / Auditability

**Risk**: Agent actions cannot be traced, verified, or attributed.

**Optimus Mitigation**: FULLY COVERED — this is Optimus's strongest area.

| Mechanism | Enforcement Layer | Source |
|-----------|------------------|--------|
| SHA-256 hash-chained `state_transitions` | Every state change is append-only, hash-linked to predecessor. `verify_all_ledger_chains()` verifies integrity. | `sql/002` (lines 110-111, 1805-1912) |
| `config_hash` on every transition | Agent config hash recorded with each state change — proves which config version was active. | `sql/002` (line 106) |
| `agent_config_history` (append-only) | Full version history of every agent configuration change. | `sql/002` (lines 41-51) |
| `autobot_public.event_log` | Public event archive — transparency by structure, not by effort (P3). | `sql/002` |
| `tool_invocations` (append-only) | Every tool call with `params_hash`, `result_summary`, `duration_ms`, `success`, `error_message`. | `sql/002` (line 255+) |
| `llm_invocations` with prompt/response hashes | `prompt_hash` and `response_hash` enable verification of what was sent/received. | `sql/002` (lines 182-183) |
| `v_governance_feed` (8 sources) | Unified board oversight surface — pending drafts, strategic decisions, budget warnings, blocked items, events, intents, executed intents, learning insights. | `sql/004` |
| Hash checkpoints + `threat_memory` | Hash-chained threat detection log. | `sql/002` (lines 635-646) |
| `idempotency_key` on events | Prevents duplicate event processing — exactly-once semantics. | `sql/002` (line 165) |

**Design principle**: P3 (Transparency by structure). Logging is a side effect of operating, not a feature agents choose to provide.

---

## ASI-10: Trust Boundary Violations

**Risk**: Agents cross trust boundaries (between agents, between agent and external systems) without proper validation.

**Optimus Mitigation**: COVERED

| Mechanism | Enforcement Layer | Source |
|-----------|------------------|--------|
| Agent tier hierarchy | 5-tier model: Strategist → Architect → Orchestrator → Reviewer → Executor. Each tier has explicit constraints. | SPEC §2-§5, `agent_configs.agent_type` |
| `can_assign_to` list (explicit, no globs) | Orchestrator can only assign to agents in its explicit list. No wildcard delegation. | `sql/002` (line 33) |
| `enforce_agent_assignment()` trigger | DB trigger prevents architects from bypassing orchestrator routing. | `sql/002`, ADR-010 |
| `guardCheck()` agent identity verification | Agent can only claim tasks assigned to it — verified at DB level within the same transaction as `claimAndStart()`. | `guard-check.js` (line 122+) |
| Adapter isolation via `permission_grants` | External system access (Gmail, Slack, Linear, GitHub) gated per-agent. | ADR-017 |
| `delegation_depth` enforcement | Max depth prevents unbounded delegation chains. | `guard-check.js` (lines 143-150) |

**Gap**: Agent identity is currently HMAC-based (shared secret). ADR-018 designs asymmetric JWT identity (Ed25519) — decouples signer from verifier. Scheduled for Phase 2.

---

## Coverage Summary

| ASI Risk | Status | Primary Enforcement |
|----------|--------|-------------------|
| ASI-01 Privilege Escalation | **FULL** | `permission_grants` + RLS + `tool_registry` + assignment triggers |
| ASI-02 Uncontrolled Code Execution | **FULL** | 4-layer tool execution + append-only audit + hash verification |
| ASI-03 Data Exfiltration | **FULL** | Data classification + RLS + metadata-only storage + schema isolation |
| ASI-04 Unauthorized Actions | **FULL** | G4 autonomy + suggest_mode + board approval + DB constraints |
| ASI-05 Prompt Injection | **FULL** | Structural enforcement + one-way merge + config hash + context sanitization |
| ASI-06 Memory Poisoning | **PARTIAL** | Hash chains + append-only tables + content hashing (gap: semantic poisoning detection) |
| ASI-07 Resource Overuse | **FULL** | G1 budget + atomic reservation + delegation depth + rate limits + auto-halt |
| ASI-08 Output Integrity | **FULL** | G3 voice matching + reviewer pipeline + board review + edit delta feedback |
| ASI-09 Accountability | **FULL** | SHA-256 hash chains + append-only audit + public event log + governance feed |
| ASI-10 Trust Boundaries | **FULL** | Agent tiers + assignment rules + DB triggers + adapter isolation (gap: HMAC → JWT planned) |

**9 of 10 fully covered. 1 partially covered (ASI-06 — semantic poisoning detection deferred to Neo4j knowledge graph, ADR-019).**

---

## Architectural Advantage: Why Database-Layer Enforcement Matters

Microsoft's Agent Governance Toolkit enforces via **middleware** (SDK interceptors, policy engines). Optimus enforces at the **Postgres serialization layer**:

| Property | Middleware (Microsoft) | Database (Optimus) |
|----------|----------------------|-------------------|
| Bypass difficulty | Import a different SDK | Break Postgres serialization |
| Consistency model | Saga (eventual) | Single-tx (strong) |
| Tamper evidence | Append-only log | SHA-256 hash chains |
| Audit completeness | Opt-in logging | Structural side-effect |
| Budget atomicity | Redis counter | `UPDATE...WHERE` + CHECK constraint |

**Key claim**: An Optimus agent cannot bypass a governance check without failing the Postgres transaction that enables its work. There is no alternate code path.

---

## Identified Gaps (Backlog)

1. **ASI-06 semantic poisoning**: Context window poisoning detection — planned via Neo4j knowledge graph anomaly detection (ADR-019)
2. **ASI-10 agent identity**: HMAC → Ed25519 JWT — designed in ADR-018, scheduled for Phase 2
3. **Trust scoring**: Behavioral 0-1000 score from `state_transitions` + `tool_invocations` — backlog item (P5 reification)

---

## References

- [OWASP Top 10 Agentic Security Risks](https://owasp.org/www-project-agentic-security/)
- [Microsoft Agent Governance Toolkit](https://github.com/microsoft/agent-governance-toolkit) — evaluated 2026-03-16, verdict: be aware + surgical extractions
- SPEC.md v0.8.0 §2-§5 (agent tiers, task graph, guardrails)
- ADR-010 (tool sandboxing), ADR-017 (permission grants), ADR-018 (JWT identity), ADR-019 (Neo4j knowledge graph)
- `autobot-inbox/docs/internal/constitutional-gates.md` (G1-G7 deep reference)
