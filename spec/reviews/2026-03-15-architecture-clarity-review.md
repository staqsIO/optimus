# Architecture Clarity Review — 2026-03-15

**Reviewer:** Liotta (Systems Architect)
**Scope:** Full Optimus/autobot-inbox system assessment against SPEC v1.0.0
**Purpose:** Eric requested clarity on what the system actually does vs. what it should do.

---

## 1. Architecture Clarity Map: What The System Actually Does

### The Happy Path (Plain English)

The system is an **email processing pipeline with governance theater**. Here is what actually happens end-to-end:

1. **Orchestrator** polls Gmail every 60 seconds. Finds new emails. Creates `work_item` rows in Postgres.
2. **Executor-Triage** (Haiku) claims those work items, classifies each email as `action_required`, `needs_response`, `fyi`, or `noise`.
3. For `action_required`/`needs_response`: **Strategist** (Opus) scores priority and recommends strategy. Skipped for `fyi`/`noise`.
4. **Executor-Responder** (Haiku) drafts replies using voice profile + few-shot examples from your sent mail corpus.
5. **Reviewer** (Sonnet) gate-checks drafts: tone match (G3), commitment detection (G2), precedent flags (G7).
6. Draft lands in the dashboard for human approval (L0 autonomy — all drafts require manual send).
7. **Architect** (Sonnet) runs daily, generates a pipeline briefing.

Additionally:
- **Executor-Ticket** and **Executor-Coder** handle a feedback-to-PR pipeline (client feedback → Linear/GitHub issues → code PRs).
- **Executor-Research**, **Executor-Redesign**, **Executor-Blueprint** are satellite agents on the M1 MacBook for CLI-driven tasks.
- Slack, Telegram, Google Drive, and Outlook adapters exist for ingestion.
- Neo4j knowledge graph syncs task outcomes for pattern learning.
- A Next.js dashboard (port 3100) shows pipeline status, drafts, signals, contacts, metrics, audit, finance, system controls.
- A separate Board Workstation dashboard (port 3200) provides prompt-to-PR capability.

### What The Metrics Actually Say

| Metric | Value | Interpretation |
|--------|-------|----------------|
| Active work items | 33 | Modest pipeline activity |
| Awaiting triage | 27 | 82% of items stuck at first gate — triage is the bottleneck or input volume outpaced processing |
| Signals extracted today | 0 | Signal extraction is not producing actionable output |
| Daily cost | $0.02 | The system barely runs. This is either extreme efficiency or extreme underutilization. |
| Agents configured | 11 | 8 core + 3 satellite |

**Honest interpretation:** At $0.02/day and 0 signals, this is a well-architected system that processes a trickle of email. The governance infrastructure (7 constitutional gates, 5 DB schemas, 19 ADRs, Neo4j, 31 runtime modules) is built for a workload roughly 100x what it currently handles.

---

## 2. Phase 1 Exit Gaps

### What's Genuinely Built and Working

- Task graph with atomic state transitions (Postgres, not prompts — P2 satisfied)
- Constitutional gates G1-G7 DB-enforced
- Config-driven agent selection (ADR-009)
- Multi-channel adapter layer (email, Slack, Telegram, Drive, Outlook)
- Voice learning system (pgvector embeddings, edit deltas)
- Append-only audit trail with hash chains
- Permission grants system (ADR-017)
- Dashboard with 12+ views
- GitHub App integration for automated PRs
- Phase 1 metrics instrumentation (phase1-metrics.js)
- Reaper for stuck task cleanup

### What's Spec-Complete But Untested Under Load

- **Graduated autonomy (L0→L1 transition):** The exit condition is "50+ drafts, <10% edit rate, 14 days." At current volume, hitting 50 drafts will take months. The mechanism exists but has never been exercised.
- **Graduated escalation (ADR-012):** Threat memory, tolerance config, escalation levels 0-4 — all built. No adversarial events have triggered escalation.
- **Neo4j learning layer:** Schema seeded, sync running, pattern extractor exists. But with 33 work items total, there are no meaningful patterns to extract. Graph intelligence requires volume that does not exist.
- **Cost-aware routing:** Budget gates enforce $20/day ceiling. Actual spend is $0.02. The constraint has never been tested at the boundary.
- **Tool integrity layer:** SPEC §6 mandates a Tool Acceptance Policy as a Phase 1 deliverable. The policy document does not appear to exist yet. Tool sandboxing (ADR-010) is implemented, but the written policy for tool approval criteria per risk class is missing.
- **Behavioral contracts:** SPEC §2 (v1.0.0 addition) requires each agent to declare measurable success criteria. These are not formalized — agents have config in agents.json but no machine-readable success criteria contracts.

### What's Actually Missing

1. **Tool Acceptance Policy** — Explicitly called out as "Phase 1 deliverable" in SPEC §6. No non-core tools should be registered without it.
2. **Behavioral contracts per agent** — SPEC v1.0.0 D7 added this requirement. Not implemented.
3. **Sustained metric validation** — Issue #59 tracks 48-72h of metric accumulation. The 13 success metrics need data that only accumulates with real email volume.
4. **develop/main branch workflow** — SPEC §8 describes a specific promotion flow (develop → release/vX.Y.Z → main). Current repo works directly on main.
5. **CODEOWNERS enforcement** — SPEC §8 defines tiered path protection. Not present in the repo.
6. **CI checks** — SPEC §8 mandates `ci/config-isolation` and `ci/agent-identity-verification`. Neither exists.

---

## 3. Redundancy and Confusion Points

### The Dashboard Surface Area Problem

The autobot-inbox dashboard has **14 pages**: metrics, settings, voice-train, pipeline, today, drafts, contacts, signals, system, audit, finance, stats, and the root page. For a system processing a trickle of email at $0.02/day, this is an order of magnitude too much dashboard.

**Specific overlap:** You noted "Signals view and Agents view show overlapping/identical data." This is symptomatic — when you have 14 views for 33 work items, views will inevitably show the same data from slightly different angles. The dashboards were built for the system the SPEC imagines, not the system that currently exists.

### The Runtime Module Explosion

`src/runtime/` contains **31 files / 8,380 lines**:

| Module | Lines | Used in Active Pipeline? |
|--------|-------|--------------------------|
| agent-loop.js | Core | Yes — every agent |
| state-machine.js | 240 | Yes — every transition |
| guard-check.js | Core | Yes — every action |
| event-bus.js | Core | Yes — pg_notify |
| context-loader.js | Core | Yes — prompt assembly |
| reaper.js | Core | Yes — stuck task cleanup |
| permissions.js | Core | Yes — ADR-017 |
| phase1-metrics.js | Metric | Yes — instrumentation |
| adversarial-test-suite.js | ? | Unclear — when does this run? |
| agent-jwt.js | ? | JWT deferred to Phase 2 (ADR-015/018) |
| agent-replacement.js | ? | What replaces what? |
| autonomy-controller.js | ? | L0 has never transitioned |
| autonomy-evaluator.js | ? | Same — untested |
| capability-gates.js | ? | P5 gates — no volume to evaluate |
| constitutional-engine.js | ? | Separate from guard-check? Redundancy? |
| dead-man-switch.js | ? | Active or speculative? |
| escalation-manager.js | ? | No escalation events to manage |
| exploration-monitor.js | ? | What does this monitor? |
| infrastructure.js | ? | Vague name |
| intent-executor.js | ? | Separate from agent-loop? |
| intent-manager.js | ? | Separate from intent-executor? |
| log-redactor.js | ? | PII redaction — does it run? |
| merkle-publisher.js | ? | Merkle proofs for public ledger — running? |
| phase-manager.js | ? | Phase transitions — only in Phase 1 |
| prompt-drift-monitor.js | ? | Monitoring what drift at this volume? |
| sanitizer.js | ? | Content sanitization |
| self-improve-scanner.js | ? | Self-improvement detection |
| spawn-cli.js | 387 | Yes — satellite agents |
| spec-drift-detector.js | 229 | Detects SPEC/implementation drift |
| startup.js | 80 | Yes |

**At least 15 of 31 runtime modules appear to be speculative infrastructure** — built because the SPEC describes them, not because current operations demand them. This is the core confusion: the codebase has been built to satisfy the SPEC rather than to serve the current workload.

### The Agent Count Problem

11 agents configured. The email pipeline needs 5 (orchestrator, triage, responder, reviewer, strategist). The remaining 6:

- **Architect**: Daily briefing. Useful for monitoring but not core email processing.
- **Executor-Ticket**: Feedback → tickets. Separate concern from email.
- **Executor-Coder**: Tickets → PRs. Separate concern from email.
- **Executor-Research**: CLI-driven. Not part of email pipeline.
- **Executor-Redesign**: CLI-driven. Not part of email pipeline.
- **Executor-Blueprint**: CLI-driven. Not part of email pipeline.

The system is described as "inbox management" but is actually 3 systems: (1) email processing pipeline, (2) feedback-to-code pipeline, (3) CLI agent toolkit. These have been unified under one process, one config, one dashboard. This makes the system harder to reason about without making any of the three better.

### The Schema Complexity

5 schemas, 7 SQL migrations totaling 177KB of DDL (002-schemas-and-tables.sql alone is 101KB / 2,698 lines). For a system doing $0.02/day of work, the schema is enterprise-grade. This is not inherently wrong — you are building for the future — but it means:

- Migration failures are high-blast-radius (101KB of DDL in one file)
- Schema comprehension requires significant ramp-up time
- The schema encodes SPEC requirements that have no runtime exercisers

### The Neo4j Question

8 graph files, separate database dependency, pattern extraction, spec seeding. The SPEC acknowledges this violates P4 (boring infrastructure) and justifies it with "multi-hop relationship traversal." At 33 work items, there are no multi-hop patterns to traverse. The graph is empty calories right now.

---

## 4. Honest Assessment: Useful Work vs. Infrastructure

**The system is approximately 85% infrastructure and 15% useful work.**

Useful work: poll Gmail, classify emails, draft replies, gate-check drafts, present for approval. This could be accomplished with ~2,000 lines of JavaScript and 3 agents (triage + responder + reviewer).

What the remaining 85% buys you:
- **Governance provenance** — every action is auditable, hash-chained, permission-checked. This is the Optimus thesis: prove that agent governance works. The infrastructure IS the product for the "governed agent organization" story.
- **Future capacity** — the system can scale to handle 1,000x the current workload without architectural changes. Multi-channel, multi-agent, cost-tracked, autonomy-gated.
- **Spec compliance** — the implementation faithfully mirrors the SPEC. This matters if the SPEC is the deliverable (proving the governance model).

**The question you need to answer:** Is the deliverable a *working email assistant* or a *proof that governed agent organizations work*?

If it is the email assistant: you have 10x too much infrastructure. Cut to 5 agents, 1 schema, 5 runtime modules, 3 dashboard pages.

If it is the governance proof: you need 10x more workload. The infrastructure is built but unexercised. 33 work items cannot validate a system designed for thousands.

Right now you have neither — too much infrastructure for a simple product, too little volume for a governance proof.

---

## 5. Recommended Simplifications Before Phase 2

### Tier 1: Cut Now (Zero Regret)

1. **Consolidate dashboard to 5 pages**: Pipeline (merge today + pipeline), Drafts, Contacts, System (merge audit + system + finance + metrics + stats), Settings. Kill signals as a standalone page — embed signal data in Contacts view.

2. **Disable Neo4j until volume justifies it.** The graceful degradation is already built (ADR-019). Set NEO4J_URI=unset. Remove the startup cost and cognitive overhead. Re-enable when work items exceed 500.

3. **Split the 3 systems explicitly.** Create PROCESS_ROLE documentation that makes it clear: `ingestion` = email/slack/telegram/drive polling, `agents` = the 5-agent email pipeline + architect, `satellite` = ticket/coder/research/redesign/blueprint. The code already supports PROCESS_ROLE but the mental model is muddy.

4. **Archive speculative runtime modules.** Move the ~15 unused/untested runtime modules to `src/runtime/_future/`. They still exist in git history. This makes it immediately clear which modules are load-bearing today.

### Tier 2: Do Before Phase 2 Gate

5. **Write the Tool Acceptance Policy.** SPEC §6 explicitly requires this as Phase 1 deliverable. It is a document, not code. 1-2 pages.

6. **Write behavioral contracts for the 5 core agents.** Machine-readable success criteria per SPEC v1.0.0 D7. Add to agents.json as a `contract` field per agent.

7. **Increase email volume.** Connect Dustin's inbox. Connect a second test account. The system needs volume to prove itself. 33 work items in 8 days is not enough data for any of the 13 Phase 1 success metrics.

8. **Set up the develop branch.** SPEC §8 is clear: agents work on develop, board merges to main. Currently everything goes to main. This costs 10 minutes to set up.

### Tier 3: Decide Before Phase 2

9. **Resolve the identity question.** Is autobot-inbox an email assistant product, or is it the first proof-of-concept for the Optimus governed agent organization? The answer determines whether Phase 2 is "repeatable install" (product path) or "increase workload diversity" (governance proof path). Both are valid. Doing both simultaneously is how you end up with 14 dashboard pages and 31 runtime modules.

10. **Set a workload target.** Define: "Phase 1 is validated when the system has processed X work items across Y days with Z% requiring human intervention." Without this number, Phase 1 exit is vibes-based, which violates P5 (measure before you trust).

---

## 6. The Leverage Insight

The 10x opportunity hiding in this system is not algorithmic — it is **operational focus**. The SPEC is a 20-section, multi-phase document. The implementation has faithfully built infrastructure for all of it. But Phase 1's actual job is narrow: prove that a governed agent pipeline can process email reliably, safely, and cheaply.

The infrastructure-to-workload ratio is inverted. You have built the highway system; now you need cars on it. Every additional infrastructure feature added before volume increases is waste — it cannot be validated, it cannot produce metrics, and it adds cognitive load that makes the system harder to explain.

**The single highest-leverage action is: increase input volume, not system capability.**

Connect more inboxes. Process more email. Let the 13 metrics accumulate. The infrastructure is ready. The workload is not.

---

## Summary Table

| Category | Status | Action |
|----------|--------|--------|
| Core email pipeline | Working | Increase volume |
| Constitutional gates G1-G7 | Enforced | Needs load testing |
| Task graph | Working | Needs volume |
| Dashboard | Over-built | Consolidate to 5 pages |
| Runtime modules | 15/31 speculative | Archive unused |
| Neo4j | Built, empty | Disable until 500+ items |
| Tool Acceptance Policy | Missing | Write it (Phase 1 blocker) |
| Behavioral contracts | Missing | Add to agents.json |
| Branch workflow | Not following SPEC | Set up develop branch |
| CI enforcement | Missing | Add before Phase 2 |
| Phase 1 metrics | Instrumented | Needs 10x more data |
| Satellite agents | Working | Document as separate system |
