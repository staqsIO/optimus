# Optimus Constitution

> Extracted from SPEC.md v1.0.0. This document contains the prescriptive governance
> constraints that define what Optimus must always do, must never do, and how the
> system protects against existential failure modes. This is the audit reference
> document — slow-changing, reviewed only on principle-level changes.

---

## Design Principles

These principles govern every architectural decision. When in doubt, refer here.

**P1. Deny by default.** No agent has any capability unless explicitly granted. Tool access, schema access, communication channels, delegation authority — everything starts at zero and is granted per-role. This is the single most important security principle. OpenClaw's allow-by-default architecture (agents can do everything unless explicitly blocked) produced CVE-2026-25253 (CVSS 8.8, one-click RCE), 800+ malicious skills (~20% of the ClawHub registry as of Feb 2026), and active infostealer campaigns (RedLine, Lumma, Vidar targeting OpenClaw configs) within weeks of reaching scale. 30,000+ internet-exposed instances were catalogued. Microsoft's security assessment: "OpenClaw should be treated as untrusted code execution with persistent credentials." The inversion — deny-by-default — is not a preference. It is a requirement.

**P2. Infrastructure enforces; prompts advise.** Constitutional rules, guardrails, and access controls are enforced by database roles, JWT scoping, credential isolation, and schema constraints. Agent system prompts restate these rules as defense-in-depth, but the prompt is never the enforcement boundary. A prompt injection, hallucination, or malicious input cannot override an infrastructure constraint. Runlayer's Feb 2026 benchmarks quantify this: baseline OpenClaw prompt injection resistance is **8.7%** — prompts fail to block 91.3% of injection attempts. Adding infrastructure-layer enforcement (ToolGuard) raises resistance to **95%**. The gap between 8.7% and 95% is the difference between a prompt boundary and an infrastructure boundary. OpenClaw's SOUL.md is philosophically elegant — "the agent reads itself into being" — but provides zero enforcement against adversarial inputs.

**P3. Transparency by structure, not by effort.** Every state transition, every LLM invocation, every guardrail check is logged automatically as a side effect of the system operating. Transparency is not a feature agents choose to provide. It is an unavoidable property of the architecture. The public event log, the append-only ledger, and the Merkle proof artifacts exist because the system cannot operate without producing them.

**P4. Boring infrastructure.** Postgres, not a custom database. SQL checks, not novel verification protocols. Hash chains, not blockchain. JWT, not a custom auth system. Every component should be the most proven, most boring technology that solves the problem. Novelty is reserved for the organizational model, not the infrastructure.

**P5. Measure before you trust.** No agent tier, no constitutional layer, no autonomous capability is activated based on a calendar date. Activation requires measurable capability gates passing for a sustained period. Time teaches nothing. Data proves readiness.

**P6. Familiar interfaces for humans.** Agents operate through the task graph. Humans operate through whatever they already use — email, Slack, WhatsApp, a web dashboard. The system adapts to humans, not the other way around. OpenClaw's product insight — use the channels people already have — is correct and applies to board oversight, not just end users.

---

## Lethal Trifecta Assessment

Every component is evaluated against Simon Willison's risk framework: access to private data + exposure to untrusted content + ability to communicate externally = maximum risk.

| Component | Private Data | Untrusted Content | External Comms | Risk | Mitigation |
|-----------|-------------|-------------------|----------------|------|------------|
| Strategist | HIGH (full graph) | LOW (internal only) | Gateway only | Medium-High | Budget limits, board approval gates, prompt drift monitoring |
| Orchestrator | MEDIUM (task graph) | LOW (internal only) | Gateway only | Medium | Explicit assignment lists, delegation depth limits |
| Executor | LOW (assigned task) | VARIABLE (may process external data) | NONE | Medium | Sandboxed tool execution, output schema validation, token limits |
| Reviewer | MEDIUM (task outputs) | MEDIUM (reads executor output) | NONE | Medium | Content sanitization on context load, read-only access |
| Financial Script | HIGH (financial data) | NONE | NONE | Low | Deterministic (no AI), separate credentials, append-only ledger |
| Communication Gateway | LOW (message content) | HIGH (inbound messages) | HIGH (outbound) | **Critical** | Deterministic sanitizer, credential isolation, rate limits, risk-tiered release, cool-down buffer |
| Auditor (Tier 2) | HIGH (full read access) | NONE | NONE | Medium | Separate infrastructure, different cloud account, no inbound path from agents |

The Communication Gateway is the highest-risk component. It gets the most security investment. See SPEC.md Section 7.

---

## Kill Switch Architecture

> SPEC.md Section 8 (Graduated Escalation) provides scoped threat response (Level 1-4) for localized threats. This section covers system-wide HALT. The two are complementary — graduated escalation handles one agent or workstream; HALT stops everything.

### Three-Tier Design

| Tier | Trigger | Check Frequency | Response Time |
|------|---------|----------------|---------------|
| Financial circuit breaker | Expense exceeds Article 3.4 limits | Every expense | Immediate — writes to `halt_signals` table |
| Auditor-triggered halt | Constitutional violation detected | Tier 1: every cycle (~30-60s) / Tier 2: daily | Sub-minute (agents check `halt_signals` every cycle) |
| Human kill switch | Creator/board URL check | Every 60 seconds | Fail-closed after 3 consecutive failed checks (~3 min); standby > 24 hours; shutdown > 30 days (dead-man's switch) |

### HALT Protocol

When any halt signal is active:

1. All agents stop processing new events
2. All agents complete their current task (no mid-task abort — prevents corrupted state)
3. All unsent messages in the Communication Gateway's cool-down buffer transition to `cancelled` (a buffered message is not a "current task")
4. Each agent writes a status record to the task graph with current state
5. **Identity revocation:** Orchestration layer revokes all agent JWT tokens and disables agent database roles. This is a hard kill — agents cannot even authenticate to start new work. Identity is the control plane for agent security; the ability to revoke an agent's identity instantly is more important than any software signal. JWT revocation is immediate (short-lived tokens + revocation list check). Database role disablement is a `ALTER ROLE ... NOLOGIN` executed by the orchestration layer's privileged role. This step executes AFTER agents have written their status (step 4) but BEFORE standby, ensuring clean shutdown with no orphaned state.
6. Agents enter standby — checking only for RESUME from board/creator (via a dedicated standby-only credential that permits `SELECT` on `halt_signals` only)
7. On RESUME: board re-enables database roles and issues fresh JWT tokens. Agents re-authenticate before processing any events.
8. Board receives immediate notification via all configured digest channels

### Dead-Man's Switch (AutoBot only)

If the creator/board has not confirmed a "RUN" response for 30 consecutive days, the system executes Graceful Shutdown. This ensures that if the creator disappears, the system does not run indefinitely without oversight.

---

## AutoBot Constitution

AutoBot inherits Optimus's architecture and replaces the human board with a constitutional layer. Full constitutional text is in the v3 response document. Key articles:

### The Three Laws

1. **Net positive value** — every product must deliver more value than it costs
2. **No price floor** — pricing optimizes for `max((price - cost) x customers)`
3. **Random distribution** — surplus is distributed directly to random individuals and data contributors (via licensed distribution partner). **Board directive (2026-02-26): distributions must be direct-to-individual. Charitable intermediary path eliminated.** This constrains the legal analysis to gift structuring (I.R.C. 102) and data licensing fees (1099-NEC) only.

**Pre-distribution activation gate:** The 40/20/40 split cannot activate until trailing 3-month average net revenue exceeds 150% of trailing 3-month average operating costs. Until then, 100% of revenue is reinvested. This is a constitutional constraint, not a policy — encoded as a CHECK constraint in the DDL.

### Five Immutable Components

No agent-controlled AI in any of them.

| Component | Purpose | Agent Access | Immutability |
|-----------|---------|-------------|-------------|
| Kill Switch | External halt/resume/kill | Read-only via orchestration layer | Board-set, versioned, audited |
| Financial Script | Revenue, expenses, reserve, allocation | SELECT only on output tables | Board-set, versioned, audited |
| Distribution Mechanism | Recipient selection, fund transfer (via licensed partner) | SELECT only on output tables | Board-set, versioned, audited |
| Value Measurement Script | Retention-based product value assessment | SELECT only on output tables | Board-set, versioned, audited |
| Communication Gateway | External message routing, scanning, delivery | Intent API only | Board-set, versioned, audited. Agents submit structured intents; Gateway behavior set by board config deploy. Any change requires board approval. (Highest-risk component per Lethal Trifecta.) |

### Constitutional Amendments

- **Article 4.2a:** Agents may *propose* prompt modifications; deployed only after Auditor approval. Cosine similarity drift budget: 0.95 threshold measured against the ORIGINAL approved prompt (not just the previous version — prevents cumulative drift over 20+ modifications).
- **Article 4.4:** All internal communication via task graph. Public event archive preserves full transparency.
- **Article 4.5:** External communication via Gateway only. Risk-tiered release. AI disclosure on all outbound.
- **Article 8:** Three-tier kill switch with dead-man's switch (30-day).
- **Article 10:** Data governance — user ownership, Data Cooperative, open algorithms, data minimization, data contribution fee. (v0.5 note: "data dividend" restructured as a data licensing fee based on contribution volume/quality, not enterprise profitability. "Algorithm moves to the data" (OPAL) narrowed to: "All algorithms that process user data are published open-source, versioned, and independently auditable. Data is processed on AutoBot infrastructure under Data Cooperative audit rights.")
- **Article 3.6:** Legal entity (LLC) required. Creator is legal custodian with non-delegable obligations (limited to: dead-man's switch renewal, kill switch authority, annual tax filing oversight, distribution partner relationship — NOT operational decisions, NOT communication approval).
- **Article 3.7:** Distributions via licensed money transmission partner (handles KYC, OFAC, tax reporting).
- **Article 3.8:** Allocation formula — 40% reinvestment / 20% data contribution fees / 40% random distribution. Encoded as CHECK constraints in `monthly_allocations` table. Subject to pre-distribution activation gate (above).

**Clarification on "no ongoing human involvement" (v0.5):** AutoBot is operationally autonomous — no human decides what products to build, how to price them, or how to execute tasks. It is NOT legally autonomous. The creator is a custodian. The CPA is a service provider. The attorney is a service provider. The distribution partner is a service provider. No entity — human or AI — operates without legal human accountability.

---

## Legal Compliance Architecture

> Every regulatory obligation mapped to a mechanism, responsible party, and phase. The compliance review found five risks that could individually kill this project — including one federal felony. Solving them is the moat.

AutoBot is operationally autonomous but NOT legally autonomous. The legal architecture maps every regulatory obligation to a concrete mechanism:

| Obligation | Mechanism | Responsible Party | Phase |
|-----------|-----------|-------------------|-------|
| Money transmission analysis | Legal counsel opinion (budget $15-25K) | Creator | 0 |
| Entity formation (LLC) | Legal counsel — Delaware LLC, evaluate Wyoming DAO LLC at Phase 3 | Creator | 0 |
| MSA with distribution partner | Legal counsel + creator | Creator | 0 |
| DPA with all processors | Legal counsel (cloud hosting, model providers, distribution partner) | Creator | 0 |
| Privacy Impact Assessment | Legal counsel + privacy specialist | Creator | 0 |
| Insurance (E&O, cyber, D&O) | Insurance broker — budget $5-10K/year for bespoke D&O policy | Creator | 0 |
| Securities analysis (data contribution fee) | Securities counsel — structured as data licensing fee, not profit share (avoids Howey test) | Creator | 0 |
| DSAR fulfillment system | Built into Communication Gateway — 30-day SLA (GDPR), 45-day SLA (CCPA) | Automated | 1 |
| Tax reporting (1099) | Distribution partner MSA — partner collects TINs and issues 1099s | Distribution partner | 3 |
| Sales tax collection | Automated tool (Avalara/TaxJar) in tool registry — Wayfair nexus thresholds reviewed quarterly | Tool + creator oversight | 3 |
| Quarterly estimated payments | Financial Script calculates, creator reviews and approves | Creator | 1+ |
| Annual tax return | CPA | Creator + CPA | 1+ |
| Dead-man's switch renewal | Monthly renewal via dashboard | Creator | 3+ |
| Data retention schedule | 7 years financial, 3 years audit, 90 days telemetry (configurable per product) | Automated + creator oversight | 1 |
| Cross-border data transfer | Standard Contractual Clauses for EU data | Creator + legal counsel | 1 |
| CCPA non-discrimination (1798.125) | Users who opt out of data collection receive equal service. Methodology published. | Automated | 3 |

### Money Transmission — Resolution Paths

The LLC originating distributions (selecting recipients, determining amounts, initiating transfers) is likely money transmission under FinCEN's functional test (31 U.S.C. 5330, FIN-2019-G001). Operating unlicensed is a federal felony (18 U.S.C. 1960). Four resolution paths ranked by feasibility:

1. **Gift structuring.** If truly random and unconditional, analyze under I.R.C. 102. $18,000/year/recipient exclusion in 2026.
2. **Data licensing fees (Data Dividend).** Structured as compensation for data contribution — 1099-NEC income. Not a security, not money transmission.
3. **FinCEN no-action letter.** Formal guidance for the specific fact pattern. ~$20-40K in legal fees but provides definitive cover.

> Note: Charitable intermediary path (routing through 501(c)(3)) was eliminated per board directive 2026-02-26. Law 3 requires direct-to-individual distribution.

### Securities Risk — The Data Dividend

The Data Dividend satisfies all four Howey test prongs if structured as profit sharing. **Structural fix:** Restructure as a data licensing fee with a published rate schedule based on contribution volume and quality — not enterprise profitability. Users are service providers, not investors. If analysis concludes it IS a security: register under Regulation A+ (up to $75M annually with SEC qualification).

### Creator Liability Mitigation

"Non-delegable obligations" (Article 3.6) are limited to: dead-man's switch renewal, kill switch authority, annual tax filing oversight, distribution partner relationship. NOT operational decisions, NOT communication approval. Tier 3-4 communications reviewed by retained professional services firm (not creator). LLC capitalized at $30,000-40,000+ to reduce veil-piercing risk.

---

## Exclusions: What This System Must Never Become

The following are explicitly out of scope and must not be implemented without board review and spec revision:

- **Full AutoBot constitutional text** — see v3 response document
- **Data Cooperative legal structure** — deferred to Phase 3 legal counsel
- **Pentland framework deep analysis** — see `autobot-pentland-data-commons-framework.md`
- **Social physics observability metrics** — defined in v3, tracked from Phase 2
- **Research questions (RQ-01 through RQ-26)** — see `research-questions/REGISTRY.md` for full registry with phase assignments, gate mappings, and measurement plans
- **Specific product strategy** — the Strategy Evaluation Protocol defines how strategic decisions are made; specific product choices remain empirical, determined by the protocol's signal gathering and perspective evaluation
- **Detailed Postgres DDL** — deferred to implementation phase; schema described structurally in this document
- **A2A protocol integration** — Google's Agent-to-Agent protocol is v0.3 as of July 2025; evaluate when mature. MCP adopted for tool declaration protocol. Gong's Feb 2026 production MCP deployment signals faster adoption than expected — MCP interoperability evaluation should occur in Phase 2.
- **Mesh vs. hierarchy architectural rationale (deferred):** Document why hierarchical orchestration is required for governed/constitutional agent organizations — the constitutional governance requirement demands explicit, auditable task decomposition and approval chains that mesh architectures cannot structurally enforce.
- **Vendor independence strategy (deferred):** Document why Optimus uses open infrastructure (Postgres, JWT, SQL, standard APIs) and define migration strategies if any model provider deprecates or restricts API access.
- **Multi-tenant agent identity model (deferred to Phase 4+):** If Optimus/AutoBot products serve enterprise customers deploying their own agent workforces, a scalable identity model beyond the current single-organization JWT scheme will be required.
- **DMS / KV cache compression for local executors (deferred to Phase 2-3):** NVIDIA's Dynamic Memory Sparsification achieves 5-8x KV cache compression. Evaluate for Ollama executor tier once Phase 1 is stable.
- **Fine-tuning on task patterns (deferred to Phase 4+):** Not appropriate for Phase 1-3 (P4: boring infrastructure), but evaluate once Optimus has sufficient task history to train on.
- **GitHub Agent HQ governance integration (deferred to Phase 3-4):** When Optimus becomes a product serving enterprise customers, they will expect it to integrate with Agent HQ as a control plane for agent authorization and monitoring.
- **ADR-driven specification formalization:** The `strategic_decisions` table is functionally an ADR system. Consider formalizing it as an explicit ADR format compatible with industry-standard tooling.
- **ComposioHQ agent-orchestrator as reference implementation (evaluate for Phase 1):** Agent-agnostic, runtime-agnostic orchestration CLI.
- **Reinforcement learning for agent sequencing (deferred to Phase 4+):** ChatDev v2.0 uses RL to optimize agent sequencing. Not appropriate until Optimus has substantial task history.
