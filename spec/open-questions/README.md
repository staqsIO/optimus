# Open Questions

Questions that need resolution before moving to implementation. Create individual files for complex questions that need extended discussion.

## How to Add Questions

Create a file: `NNN-short-description.md` with:
- The question
- Why it matters
- Current positions (Eric / Dustin)
- What would resolve it

---

## Resolved Questions

### Architectural (Resolved)
- [x] OpenClaw references in v0.4: are these based on real events or hypothetical scenarios for threat modeling? **RESOLVED — All confirmed real.** CVE-2026-25253, 824+ malicious ClawHub skills, Cisco/OWASP mapping independently verified. (See conversation/008, Part 1)
- [x] Pentland framework: accepted as part of the spec or kept as a companion concept? **RESOLVED — Accepted into the spec with three refinements:** (1) narrow OPAL to auditable algorithms, (2) add enforcement to social physics metrics, (3) scrub securities-risk language. (See conversation/008, Part 8)
- [x] Communication Gateway: immutable component or configurable service? **RESOLVED — Immutable.** The Gateway is the highest-risk component per the Lethal Trifecta Assessment (§2). Agents submit structured intents; Gateway behavior is set by the board, versioned, and audited. Any change requires a board-approved config deploy. Follows from P1 (deny by default) and P2 (infrastructure enforces). **Dustin: approved 2026-02-26.** Spec impact: v0.4.1 patch to §13, make immutable status explicit in component table.
- [x] Data Cooperative: Article 10 (data governance) and 40/20/40 distribution split? **RESOLVED — Accepted as constitutional default with activation gate.** Split activates when trailing 3-month net revenue exceeds 150% of operating costs. Data Dividend structured as data licensing fee (not profit share) to avoid Howey test. DDL encodes split as configurable parameter, not hardcoded. **Dustin: approved 2026-02-26.** Spec impact: v0.4.1 patch to §13.
- [x] If charitable intermediary path is chosen for distribution, does Law 3 change? **RESOLVED — No. Law 3 is direct-to-individual. Charitable intermediary path is off the table.** This is a board directive — the random distribution mechanism must deliver funds directly to individuals, regardless of legal complexity. This eliminates Path 1 (charitable intermediary) for the Law 3 distribution and constrains the legal analysis to Path 2 (gift structuring) + Path 3 (data licensing fees for Data Dividend only). **Dustin: approved 2026-02-26.** Spec impact: v0.4.1 patch — record as board directive, Law 3 language unchanged.
- [x] Service Specification Language: declarative YAML or free composition? **RESOLVED — Deferred to Phase 2.** Phase 1 builds one organization doing one thing. Service composition is a Phase 3+ concern. **Dustin: approved 2026-02-26.**
- [x] Component maturity model: what quality gates promote a component from provisional to mastered? **RESOLVED — Property-based testing + mutation testing scores.** Deployment count rejected as vanity metric. A component is "provisional" until: (a) >90% test coverage, (b) passes property-based tests for its invariants, (c) running in shadow mode for 7+ days with zero failures. **Dustin: approved 2026-02-26.** Spec impact: v0.4.1 patch — new subsection.

### Implementation (Resolved)
- [x] MCP vs LangChain for tool integration in agents? **RESOLVED — Wrong framing.** MCP adopted for tool declaration protocol (Phase 1). No orchestration framework needed — the Postgres task graph IS the orchestration layer. Raw Node.js runtime loop (~150-630 LOC) with SQL queries + HTTP calls. LangGraph/CrewAI/AutoGen all rejected: they add a second state manager that can disagree with the database, violating P2 (infrastructure enforces). (See conversation/008, Part 6; agent reviews 2026-02-26)
- [x] Which Postgres hosting for the task graph? **RESOLVED — Supabase Pro + PITR add-on (~$50-75/mo).** Supports all requirements: WAL archiving, PITR, RLS, custom functions, pg_notify, FOR UPDATE SKIP LOCKED, custom schemas + roles. Railway Postgres rejected (no managed PITR, no read replicas). Self-hosted deferred to Phase 3+ when custom extensions or cost optimization justify the ops burden. Migration path: standard pg_dump/pg_restore — no lock-in. **Dustin: approved 2026-02-26.** Spec impact: v0.4.1 patch to §15.
- [x] Ollama vs Haiku for executor agents? **RESOLVED — Haiku 4.5 for Phase 1.** At Phase 1 volumes (~100-300 tasks/day), Haiku costs $24-54/month vs $100-200/month for self-hosted Ollama. Higher first-pass accuracy (~95% vs ~85-90%) means fewer retries in autonomous operation. Gemini 2.0 Flash ($0.0012/task) considered for lowest-risk mechanical tasks. Ollama evaluated at Phase 2+ when monthly tasks exceed 12,500 AND shadow testing shows >=90% first-pass accuracy. Agent config `fallback_model` always points to API model — self-hosted is cost optimization, API is reliability baseline. **Dustin: approved 2026-02-26.** Spec impact: v0.4.1 patch to §2 agent tiers.
- [x] Self-hosted GPU for Ollama workers: what hardware, what cost? **RESOLVED — Deferred to Phase 3 at earliest.** Math doesn't work at Phase 1 volumes — API models are 6-80x cheaper. When volume justifies: Mac Mini M4 Pro ($1,999 one-time) or Mac Studio M3 Ultra ($4,000-8,000). `fallback_model` must always point to API model. **Dustin: approved 2026-02-26.**
- [x] Contract layer scope: how many TypeScript interface contracts for Phase 1? **RESOLVED — ~5 core contracts (~5,000 LOC estimated).** Covers HTTP handlers, DB access, auth/JWT, task queue, validation, logging. Exact contract list scoped in first Phase 1 working session. **Dustin: approved 2026-02-26.**
- [x] CVE awareness pipeline: which structured feeds, what interval, what threshold? **RESOLVED — OSV.dev as primary feed** (covers NVD + GitHub Advisory DB). Daily polling. Auto-create task in task graph for any CVE affecting a dependency. Auto-patch threshold: CVSS < 4.0 (low severity) with passing test suite only. Higher severity gets human review task. **Dustin: approved 2026-02-26.** Spec impact: v0.4.1 patch to §6. **SUPERSEDED by ADR-003 (2026-03-01):** reachability-based policy with DB driver exclusion, SLAs, and auto-mitigation for actively-exploited CRITICAL. LOW threshold unchanged. See decisions/003-cve-auto-patch-policy.md.
- [x] 30-60 day lag-behind policy for npm packages? **RESOLVED — 30-day lag for non-security updates, zero lag for security patches.** Lag protects against supply chain attacks. Security patches exempt — a 30-day lag on a known vulnerability is worse than supply chain risk. **Dustin: approved 2026-02-26.** Spec impact: v0.4.1 patch to §6.
- [x] AGPL firewall: which license scanner? **RESOLVED — `license-checker` for Phase 1** (free, npm-native). Runs in CI — any dependency with AGPL, GPL, or unknown license blocks the build. Evaluate FOSSA at Phase 2 if policy-as-code needed. **Dustin: approved 2026-02-26.**
- [x] AI-generated component IP: does the LLC need a human creative direction policy? **RESOLVED — Yes, board resolution.** Per Thaler v. Perlmutter, AI output without human creative direction isn't copyrightable. Board adopts resolution that all agent-produced code/content is created under human creative direction (board's architectural decisions, spec, and task definitions constitute creative direction). One-page board resolution to be drafted. **Dustin: approved 2026-02-26.**
- [x] Privacy-by-design for PII-handling components: what constitutes mandatory tests? **RESOLVED — Defined in contract layer.** Any component touching user data must pass: (a) no PII in logs (automated scan), (b) data classification tagging on all fields, (c) deletion capability (GDPR right to erasure), (d) encryption at rest. Board certifies until Phase 3 when Auditor agent takes over. **Dustin: approved 2026-02-26.** Spec impact: v0.4.1 patch to §5.

### Legal (Resolved)
- [x] LLC formation: Delaware vs Wyoming DAO LLC? **RESOLVED — Delaware LLC now.** Wyoming DAO LLC Act has zero court precedent. "Smart contract precedence" rule is dangerous when governance is a Postgres CHECK constraint — a DDL bug could override the operating agreement. Standard Delaware LLC incorporates all constitutional constraints in operating agreement. Clean conversion path to Wyoming later if statute matures. **Dustin: approved 2026-02-26.** Spec impact: v0.4.1 patch to §14 Phase 0.
- [x] Distribution partner selection: GiveDirectly or alternative? **RESOLVED — Deferred until money transmission analysis completes.** GiveDirectly doesn't fit: no programmatic API, selects own recipients (breaks Law 3 randomness), no 1099 reporting. Partner selection depends on legal path from money transmission analysis. **Dustin: approved 2026-02-26.**

---

## Evaluated and Deferred

Ideas formally evaluated but not accepted into the spec. Each has explicit trigger conditions for revisiting.

- [ ] **Decentralized Executor Network (DEN):** External executor nodes on contributor GPU hardware.
  **Evaluated 2026-03-01. DEFERRED -- economics require executor costs >$2,000/month to justify.**
  Current executor costs: $40-80/month. Liotta/Linus review: savings ~$27/mo vs $5K+ legal/engineering costs.
  Break-even: 185 months (15+ years) at current scale.
  Revisit trigger: executor costs exceed $2,000/month sustained.
  Priority order when triggered: (1) local Ollama inference, (2) prompt caching/batch API, (3) fine-tuned smaller models, (4) decentralized compute only if 1-3 insufficient.
  See conversation/011-dustin-den-dom-proposal.md.

- [ ] **Deterministic Operations Mesh (DOM):** Free-tier compute for non-LLM workloads across AWS Lambda, Oracle Cloud, GCP.
  **Evaluated 2026-03-01. DEFERRED -- target workloads already cost ~$0 incremental on Supabase.**
  Multi-cloud deployment violates P4 (boring infrastructure) at current scale.
  Three cloud providers for one user's inbox is not boring infrastructure.
  Revisit trigger: infrastructure costs exceed $1,000/month OR task volume exceeds 10,000/day.
  See conversation/011-dustin-den-dom-proposal.md.

- [ ] **DEN Phase 1 schema prep (contributor_id columns, executor API boundary, per-contributor quality metrics):**
  **Evaluated 2026-03-01. REJECTED -- YAGNI per Linus review.**
  Executor API boundary is the easy part -- wrap existing Postgres functions in HTTP handlers in two days when needed.
  Nullable columns for speculative features = schema pollution (every query plan considers NULL columns).
  `state_transitions` is append-only and partitioned -- schema changes are permanent.
  Do not revisit until DEN evaluation is triggered.

---

## Current Open Questions

### Legal (Awaiting Phase 2)
- [ ] Money transmission analysis: is the distribution mechanism money transmission? **Approved for engagement at Phase 2 start (~$10-15K budget).** Charitable intermediary path eliminated per board directive (Law 3 must be direct-to-individual). Scope narrowed to: **Path 2 (gift structuring)** for the 40% random distribution + **Path 3 (data licensing fees)** for the 20% Data Dividend. Path 4 (FinCEN no-action letter) evaluated as Phase 3 backstop if Path 2 is ambiguous. Does not block Phase 1. **Dustin: approved 2026-02-26.**

### Research
- [ ] 26 research questions (RQ-01 through RQ-26) — see [`research-questions/REGISTRY.md`](../research-questions/REGISTRY.md) for full registry with phase assignments, gate mappings, measurement plans, and status tracking.

---

## Spec Patches Required (v0.4.1)

The following v0.4.1 patches are needed to reflect board decisions made 2026-02-26:

| Patch | Section | Change |
|-------|---------|--------|
| Gateway immutability | §13 component table | Make Gateway's immutable status explicit |
| 40/20/40 activation gate | §13 | Add activation gate (150% trailing 3-month revenue > operating costs) and data licensing fee framing |
| Law 3 board directive | §13 | Record direct-to-individual requirement; eliminate charitable intermediary |
| Supabase Pro | §15 | Update infrastructure line item to reflect Supabase Pro + PITR |
| Haiku 4.5 executors | §2 agent tiers | Update executor model column for Phase 1 |
| Component maturity gates | New subsection | >90% coverage, property-based tests, 7-day shadow mode |
| CVE pipeline | §6, §18 | OSV.dev feed, daily poll, auto-task, reachability-based auto-patch policy (ADR-003) |
| npm lag policy | §6 | 30-day lag for non-security, zero lag for security patches |
| PII test requirements | §5 | Mandatory tests for PII-handling components |
| Delaware LLC | §14 Phase 0 | Confirm Delaware LLC formation |
