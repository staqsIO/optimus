# Changelog

All notable changes to the Optimus/AutoBot specification.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.10.0] - 2026-04-12

Phase 1.5: Unified Content Engine -- blog + LinkedIn content pipeline. Expands LinkedIn-only Phase 1.5 (conversation 012) to unified content generation with multi-author support, 5-phase research pipeline, and static MDX delivery.

### Added
- `SPEC.md` section 14, Phase 1.5 (Unified Content Engine) -- new phase between Phase 1 and Phase 2. Defines: executor-writer (5-phase pipeline: research, grounding, draft, image gen, memory), content-atomizer (blog to LinkedIn derivation), unified `content` schema, content-specific gates (G8 Factual Accuracy, hard constraint gates), git-push delivery topology with P2-compliant blast radius isolation, multi-author voice profiles, success metrics (7 metrics), exit criteria.
- `conversation/021-eric-unified-content-engine.md` -- documents expansion decision. Three-perspective analysis (Liotta + Linus). Google ADK evaluation: keep the multi-agent pattern, skip the framework. Contract schema between Optimus and consuming sites.

### Changed
- Phase 1.5 scope: LinkedIn-only content automation (conversation 012) -> unified blog + LinkedIn content engine
- Phase 1.5 agents: 3 new agents (content-orchestrator, content-generator, content-reviewer) -> 2 new agents (executor-writer, content-atomizer) + existing campaign system as orchestrator

### Provenance
- Eric + Dustin decision following UMB Advisors blog requirement. Liotta and Linus agent reviews inform architecture (hybrid topology, no ADK). Inspired by Google Cloud's multi-agent content system (ADK + MCP blog post).

---

## [0.9.0] - 2026-03-13

Knowledge graph layer — board-approved Neo4j integration for agent learning and relationship intelligence. Reviewed by Linus (security) and Liotta (architecture).

### Added
- `SPEC.md` §5a (Knowledge Graph Layer) — new section documenting Neo4j as advisory learning layer alongside Postgres: purpose and separation of concerns, graph model (nodes/edges), outbox-based sync mechanism, tier-gated reflection, graceful degradation requirements, P4 exception rationale, and cross-references to P1/P2/P3/P4/P5 and §2/§3/§5.

### Changed
- `autobot-inbox/docs/internal/adrs/019-neo4j-knowledge-graph.md` — status Proposed → Accepted; added Board Decision section (approved 2026-03-13 with production deployment gated on Linus fixes); added Review Findings subsection summarizing Linus security findings (NEO4J_USER env var, PII scrubbing, pg_notify durability, permission_grants seed removal) and Liotta architecture findings (multi-hop query requirement, Postgres complement recommendation, outbox as highest-priority risk).

---

## [0.8.1] - 2026-03-01 — DRAFT

Resolve CVE auto-patch threshold (issue #33). Board decision informed by Linus, Liotta, DBA, and Compliance agent reviews.

### Added
- `decisions/003-cve-auto-patch-policy.md` — ADR defining reachability-based CVE response policy with DB driver exclusion, auto-mitigation for actively-exploited CRITICAL, SLAs, and three-condition gate for all auto-patches.

### Changed
- `SPEC.md` §18 (CVE Awareness Pipeline) — replaced "under discussion" with resolved policy. Primary axis is reachability + exposure classification, not raw CVSS.
- `SPEC.md` §6 (Tool Integrity Layer) — updated CVE pipeline summary to reflect ADR-003 policy.
- `open-questions/README.md` — marked CVE threshold resolution as superseded by ADR-003; updated spec patches table.

---

## [0.8.0] - 2026-03-01 — DRAFT

Research question registry -- structured tracking for all 26 spec research questions.

### Added
- `research-questions/REGISTRY.md` — central registry of all 26 research questions (RQ-01 through RQ-26) with phase assignments, gate mappings, measurement plans, status tracking, and phase index. Extracted from conversation/005-eric-unified-v3.md. Supports P5 (measure before you trust).

### Changed
- `open-questions/README.md` — replaced generic research checkboxes with cross-reference to registry
- `SPEC.md` §20 — updated research questions reference to point to registry
- `README.md` — added `research-questions/` to repository structure diagram

---

## [0.7.0] - 2026-02-28 — DRAFT

Redundancy cleanup + threat detection memory + pathway performance instrumentation. Reviewed by Linus + Liotta.

### Added
- §8 `agent_graph.threat_memory` — append-only threat event log with scope dimensions (agent/task/workstream/tool/channel), 8-class threat taxonomy, 5-level severity, resolved lifecycle, hash chain
- §8 `agent_graph.tolerance_config` — board-managed escalation thresholds per threat class/scope
- §8 Graduated Escalation model — 4 levels (heightened monitoring → restrict+alert → isolate+investigate → scoped HALT) filling the gap between Reviewer quarantine and §9 HALT
- §8 4 framework-level pathway analytical views: routing class effectiveness, context block correlation, cost per task type trend, agent efficiency comparison
- §8 5 per-user operational SQL views (cost/email, triage accuracy, draft acceptance, p95 latency, escalation rate) — scoped to AutoBot-Inbox product schema
- §3 `routing_class_final` and `context_profile_json` columns on `work_items` for pathway instrumentation
- §3 `current_escalation_level(scope_type, scope_id)` function — returns 0-4 based on weighted unresolved threat count
- §5 Graduated escalation check added to `guardCheck()` (Level 2+ forces review, Level 3+ blocks claims, Level 4 blocks all)
- §9 Cross-reference note linking to §8 graduated escalation (complementary scoped vs system-wide response)
- `CHANGELOG.md` now contains full version history (extracted from §21)
- `multi-user-engineering-plan.md` — 5-blocker engineering plan for multi-user rollout
- `reference/` directory for archived companion documents

### Changed
- §3 Schema declaration: 11 tables + 1 view → 12 tables + 5 views (added `threat_memory`, `tolerance_config`, 4 pathway analytical views; removed `threat_events`)
- §3 "Why Not Email" compressed from 17 lines to 3 (back-references preserved)
- §5 Opening compressed — OpenClaw/SOUL.md re-argument replaced with P2 back-reference
- §6 "The Problem" compressed — ClawHub stats replaced with §0 P1 back-reference
- §7 "Gateway is highest-risk" restatement removed (already in §2 Lethal Trifecta)
- §20 Deferred items compressed — verbose version attributions removed, descriptions shortened
- Companion document references compressed to one-liners
- Lineage header compressed

### Fixed
- §15 Strategist cost: ~$0.43 → $0.42 with explicit breakdown (input $0.12 + output $0.30). Matches §4 table corrected in v0.5. `agents/strategist.md` updated to match. Closes #34.

### Removed
- All "(new in v0.4)", "(v0.5.1 addition)", "(v0.6 addition)" version tags from section headers and inline text
- All "(board decision 2026-02-26)" inline date attributions (decisions retained, provenance in changelog)
- §21 inline changelog entries (moved to CHANGELOG.md, stub remains)

### Moved
- `eos-overlay-v0.7.0-draft.md` → `reference/` (deferred per Linus/Liotta review)
- `phase1-build-sequence-and-gap-analysis.md` → `reference/` (deferred)
- `Modifications/spec-amendment-discovery-protocol-v0.7.md` → `reference/` (deferred)
- `spec-redundancy-analysis.md` → `reference/` (executed)

### Provenance
- Threat Detection Memory and Pathway Performance Instrumentation: Dustin's refined proposals from PR #11 comments, accepted by Eric in closing comment, scoped to spec-appropriate level per Liotta evaluation (full DDL deferred to build phase)

---

## [0.6.2] - 2026-02-28 — DRAFT

Agent review follow-ups: missing orchestrator, cost table fix, P2 enforcement tightening.

### Added
- agents/orchestrator-eng.md — missing 5th Phase 1 agent definition (task decomposition, dispatch, release promotion)
- Context loading note in AGENTS.md: root file (~3,250 tokens) must not be loaded into executor/reviewer context

### Fixed
- SPEC.md §4 cost table: added output token costs — Strategist was $0.12 (input only), corrected to $0.42 (input+output). All tiers now show full cost.
- Per-directive cost target: $2.00 -> $3.00 (consistent with corrected per-task costs)
- Architect create_subtask tool: added infrastructure-enforced routing constraint (auto-routes to orchestrator-eng, cannot set assigned_to directly). Closes P2 gap from Linus C4.
- Removed orchestrator-product from Phase 1 can_assign_to lists in strategist.md and architect.md (agent does not exist until Phase 2)
- Removed escape-hatch parenthetical on executor external_http_request forbidden tool (P1 violation)

### Reviews
- Agent review outputs: Linus agents.md review, Liotta agents.md evaluation

---

## [0.6.1] - 2026-02-27 — DRAFT

Source control governance layer on top of v0.6.0 ecosystem alignment.

### Added
- §14.1 Source Control and Code Review Architecture — GitHub workflow governance for agent-produced code (Dustin, reviewed by Linus + Liotta agents)
- CI enforcement checks: config isolation (C3), agent identity verification (C4), secret detection on both branches
- Event-driven promotion workflow with size cap (30 files / 500 lines / 72h staleness floor)
- Phase 1 GitHub governance success metrics (PR cycle time, promotion lag, missed escalation rate)
- Companion documents: 009-dustin-github-workflow-architecture.md, 010-dustin-github-multiagent-ecosystem-research.md
- Agent review outputs: Linus GitHub workflow review, Liotta GitHub workflow evaluation

### Security
- C1: Reviewer agent as CODEOWNERS for /src/ and /tests/ (closes self-merge loophole)
- C2: Only board members merge to main (Orchestrator removed from merge access)
- C3: CI check forces governance-path changes into dedicated PRs
- C4: CI check cross-references PR author against task graph assignment

---

## [0.6.0] - 2026-02-27 — DRAFT

Dustin's GitHub multi-agent ecosystem alignment pass.

### Added
- agents.md as human-authored agent definition standard (Linux Foundation, 60K+ projects)
- Executor filesystem isolation (agent-per-worktree pattern)
- Automated reaction loops (CI failure → retry with context, review rejection → revision)
- Cost-aware routing (deterministic bypass → fallback model → full-tier model)
- CI/CD execution model (read-only-by-default, extends P1 to CI/CD layer)
- 4 new deferred items: GitHub Agent HQ, ADR formalization, ComposioHQ evaluation, RL for agent sequencing

---

## [0.5.2] - 2026-02-27 — DRAFT

Critical fixes from Linus/Liotta audit + graduated autonomy model.

### Added
- Graduated Autonomy Model: Level 0 (Full HITL) through Level 3 (Constitutional autonomy)
- Strategist suggest mode for Phase 1 (proposes decisions, board accepts/rejects, feeds G4)

### Changed
- §14 Phased Execution Plan: reframed from "add agents per phase" to graduated autonomy — all 5 agents present from Phase 1, human checkpoints removed progressively
- Cost model: Strategist split into suggest mode ($200-800) and full autonomy ($640-800)

### Fixed
- Cost model contradiction between changelog and body (standardized to $2,240-4,565)
- Schema declaration: 7 tables → 10 (added agent_configs, agent_config_history, strategic_decisions)
- `quarantined` state: resolved as output-level flag, not workflow state
- Reviewer missing from Phase 1 roster (5 agents, not 4)
- $0.50/directive success metric impossible → changed to $3.00
- "Tier 0/1 tasks" undefined → replaced with concrete classification criteria

---

## [0.5.1] - 2026-02-27 — DRAFT

Three-agent review fixes + VentureBeat research sweep + Strategy Evaluation Protocol.

### Added
- §19 Strategy Evaluation Protocol — tiered decision-making, three-perspective evaluation, decision reversal rate measurement
- §3 Work item state machine (9 states, formal transitions)
- §5 guardCheck lock ordering (budgets before work_items)
- §4 Data quality tier classification (Q1-Q4)
- §4 Output quarantine gate and completeness check
- OpenClaw threat metrics update (800+ malicious skills, Runlayer 8.7% vs 95% data)
- Board command interface via Slack/email (P6)

### Changed
- Hash chain checkpoint standardized to 10,000 rows
- Shadow mode: measurement-based exit criteria (up to 7 days)
- Executor cost targets: Ollama removed, Haiku 4.5 pricing
- Phase gates: G1 clarified, G4 refined, G6 bootstrap clause, G7 rolling window

---

## [0.5.0] - 2026-02-27 — DRAFT

Eric's 10-part review of v0.4 with 4 agent reviews (architecture, safety, database, compliance).

---

## [0.4.0] - 2026-02-26 — DRAFT

Dustin's canonical v0.4 incorporating Eric's infrastructure feedback, OpenClaw lessons, and Pentland framework.

### Added
- 7 design principles (P1-P7), deny-by-default as P1
- OpenClaw gap analysis and lessons learned (CVE-2026-25253 reference)
- Content sanitization in orchestration layer (P2 defense-in-depth)
- Tool integrity verification (hash check before invoke)
- Semantic versioning scheme for the spec itself

### Changed
- Communication substrate: email replaced by Postgres task graph (preserving email as human audit interface)
- Constitutional enforcement: prompt-based → infrastructure-enforced (DB roles, JWT, credential isolation)
- Kill switch: hourly polling → three-tier (circuit breaker + Auditor halt + human URL + dead-man's switch)
- Auditor: single Claude instance → three-tier (deterministic + Claude + cross-model)
- Self-modification: direct prompt editing → propose-and-review protocol
- Value measurement: CEO self-reporting → deterministic Value Measurement Script
- Launch gate: 3-month calendar → 6 capability gates (90-day rolling window)

### Preserved
- The Three Laws (net positive value, no price floor, random distribution)
- Three firewalls (financial, constitutional, oversight)
- Auditor independence
- Full transparency mandate
- Graceful shutdown and cost reduction protocols
- Build order: Optimus first, AutoBot second

---

## [0.3.0] - 2026-02-26

Eric's unified v3 response adding Pentland data governance framework.

### Added
- Article 10: Data Governance (data ownership, cooperative, open algorithms, data dividend)
- Communication Gateway as 5th immutable component
- Social physics observability metrics
- Computational trust (Merkle proofs for independent verification)
- Federated value measurement (OPAL model)
- 6 new research questions from Pentland framework
- Full analysis of all 20 original research questions

### Changed
- Distribution allocation: 40/60 → 40/20/40 (reinvest / data dividend / random)
- External communication: lockdown → audited gateway with risk-tiered release
- Trust model: trust the Auditor → computational verification (anyone can verify)

---

## [0.2.0] - 2026-02-25

Eric's revised response with infrastructure enforcement and legal foundation.

### Added
- Postgres task graph replacing email for agent communication
- Infrastructure enforcement map (every constitutional article → DB constraint)
- Four isolated database schemas (agent_graph, autobot_finance, autobot_distrib, autobot_public)
- Append-only ledger with hash-chain tamper detection
- Legal foundation requirements (LLC, money transmission partner)
- Context window economics model
- Operating cost model
- Phased execution plan (Phase 0-4)

### Changed
- Agent naming: corporate titles → functional roles
- Guardrail enforcement: agent self-policing → orchestration layer enforcement

---

## [0.1.0] - 2026-02-25

Dustin's original vision — agent organization architecture.

### Added
- Multi-tier agent hierarchy (CEO → VPs → Tech Leads → Workers)
- Email as communication protocol
- Mixed-model tiering (Claude executives, Ollama workers)
- Agent runtime loop with guardrails cascade
- AutoBot constitutional layer (Three Laws, three firewalls, Auditor, kill switch)
- 20 research questions
- MVP roadmap
