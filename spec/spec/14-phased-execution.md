## 14. Phased Execution Plan

### Phase 0: Legal Foundation (Before Any Code)

1. Form Delaware LLC, creator as sole member (Wyoming DAO LLC evaluated for Phase 3 conversion if statute matures)
2. Legal counsel on money transmission — select distribution partner
3. Attorney drafts ToS, privacy policy (GDPR/CCPA compliant), operating agreement incorporating constitutional constraints
4. Stripe, cloud hosting, bank accounts under the entity
5. CPA engagement for tax compliance
6. E&O + Cyber Liability insurance
7. Domain registration, public website skeleton
8. Data Cooperative formation counsel (legal structure identified for future formation)
9. **Audit schema legal discovery review:** Have counsel review the `state_transitions` and `event_log` schema designs for evidentiary admissibility. These logs are not just operational monitoring — they are potential evidence in litigation or regulatory inquiry. Designing for legal defensibility during Phase 0 costs nothing relative to discovering a gap during a dispute.

**Estimated cost:** $7K-22K one-time, $7.5K-25K/year ongoing.
**Exit criterion:** Legal entity exists, distribution path legally validated, accounts provisioned.

### Graduated Autonomy Model (v0.5.2)

The phasing model is **graduated autonomy**: all agents are present from Phase 1, but human-in-the-loop checkpoints are progressively removed as measurement gates pass. This is the same principle as graduated trust escalation (§11) applied at the organizational level.

**Rationale:** The Strategist must observe every board decision from day one to build the training data that feeds G4. Removing the Strategist from Phase 1 means it misses the most formative period of the organization. The board is teaching the agents how to operate — the agents must be present to learn. The phasing question is not "which agents exist" but "where are the human checkpoints."

| Autonomy Level | Who Decides | Human Role | Exit Condition |
|----------------|-------------|------------|----------------|
| **Level 0 — Full HITL** (Phase 1) | Board decides everything. Agents propose. | Approve/reject every DIRECTIVE, review Strategist recommendations, spot-check Reviewer output. | G1-G4 measured, no hard-fails for 30 days |
| **Level 1 — Tactical autonomy** (Phase 2) | Agents handle tactical decisions autonomously (90% of volume). Board approves strategic + existential. | Review strategic/existential decisions, monitor dashboards, intervene on flags. | All seven gates pass simultaneously for 90-day rolling window |
| **Level 2 — Strategic autonomy** (Phase 3) | Agents handle tactical + strategic decisions. Board retains veto + existential decisions only. | Dashboard monitoring, kill switch, dead-man's switch renewal, veto on existential. | All seven gates pass for 90 days at full autonomy (sandbox) |
| **Level 3 — Constitutional autonomy** (Phase 4) | Constitution governs all operational decisions. | Legal custodian, dead-man's switch, dashboard, kill switch. | Ongoing — no exit, continuous measurement. |

### Phase 1: Optimus MVP — Full HITL (8 weeks)

Build the governed agent organization. All agents present. Board approves everything.

**Autonomy level:** 0 — every Strategist recommendation requires board approval. Every Reviewer decision is board-auditable. The Strategist runs in **suggest mode**: it proposes decisions, the board accepts or rejects, and the delta is recorded as training data for G4.

**Build:**
- Postgres task graph (`agent_graph` schema)
- 5 agents: Strategist (Claude Opus — suggest mode), Architect (Claude Sonnet), Orchestrator (Claude Sonnet), Reviewer (Claude Sonnet), Executor (Haiku 4.5)
- Orchestration layer with `guardCheck()`, JWT identity, RLS
- Public event log from day one
- Tier 1 deterministic audit checks from day one
- Tool Integrity Layer with hash verification (full sandboxed execution deferred to Phase 2 when external tools enter the picture)
- Content sanitization on context load (static rule set; versioned rule sets deferred to Phase 2)
- Event digest service (push to board via email/Slack)
- Board command interface via Slack/email — approve/reject tasks, inject directives, trigger HALT from existing channels (P6). Dashboard is secondary; meeting the board where they already are is primary.
- Tool acceptance policy — board co-authors written approval criteria per tool risk class before any non-core tools are registered (see §6)
- Backup/DR infrastructure:
  - WAL archiving with PITR (point-in-time recovery)
  - WAL-based async replication (Supabase Pro managed). Hash chain verification (`verify_ledger_chain()`) provides tamper detection at the application layer. Synchronous replication deferred to Phase 3+ when transaction volume or regulatory audit justifies the cost (~$599/mo Supabase Team or self-hosted).
  - Defined RTO (recovery time objective) and RPO (recovery point objective)
  - Hash chain recovery protocol: verify chains post-restore, mark gaps explicitly, publish new Merkle root including gap documentation

- Strategy evaluation: single-pass structured evaluation for all Strategist decisions (see §19)
- Decision record schema in task graph (`strategic_decisions` table)
- Value Measurement Script in shadow mode
- Communication Gateway in shadow mode (all intents logged, none sent)
- GitHub repository with CODEOWNERS, branch protection, CI enforcement checks, and PR templates configured per §14.1
- CONTRIBUTING.md as part of agent operational context
- Agent GitHub bot accounts (1-2) with scoped permissions

**Instrument:**
- Every board intervention classified as "constitutional" (derivable from rules) or "judgment" (requires human reasoning)
- All Phase 1 success metrics tracked from day one
- Decision reversal rate tracked from day one (§19)
- Strategist suggest-vs-board-decision match rate (feeds G4)

**Phase 1 success metrics:**

| Metric | Target |
|--------|--------|
| End-to-end latency (3-task directive) | < 120s p95 |
| Total cost per directive | < $3.00 |
| Task dispatch latency | < 2s p99 |
| Context tokens per task | < 8,000 max |
| Agent idle time | < 30% |
| Task success rate | > 90% |
| Observability coverage | 100% state transitions logged |
| Crash recovery time | < 60s to re-queue |
| Content sanitization false positive rate | < 5% |
| Tool integrity check pass rate | 100% |
| PR-to-merge cycle time (agent-managed paths) | < 30 min p95 |
| Promotion-to-production lag | < 24 hours p95 |
| Missed escalation rate (GitHub) | 0% |

**Exit criterion:** All metrics pass. Board intervention classification data accumulating. Strategist suggest-mode match rate being measured.

### Phase 2: Tactical Autonomy (8 weeks)

Agents handle tactical decisions (90% of volume) autonomously. Board approves strategic and existential decisions. AutoBot constitutional layer runs in shadow mode.

**Autonomy level:** 1 — tactical decisions (low-risk, low-budget, matching established patterns) execute without board approval. Strategic decisions still require board sign-off.

**Add:**
- Constitutional layer running in shadow mode
- Tier 2 AI Auditor (daily) + Tier 3 cross-model audit (weekly)
- Financial Script in shadow mode
- Three-tier kill switch infrastructure live
- Communication Gateway: Tier 0-1 auto-send activated (transactional only)
- Tool Integrity Layer: full sandboxed execution with behavioral monitoring (external tools now permitted)
- Content sanitization: versioned rule sets with adversarial testing
- Prompt modification proposal system (propose-and-review)
- Agent replacement protocol with shadow mode + graduated trust escalation
- Three-perspective strategy evaluation in shadow mode for DIRECTIVE-level decisions (§19). Compare protocol recommendations against board decisions to feed G4.
- GitHub governance expansion (§14.1): per-agent service accounts, ARCHITECTURE CODEOWNERS tier, signed commits on `develop`, expanded label taxonomy (add `schema-migration`, `agent-config`, `architecture`, `cost-impact` when board demonstrates filtering need), merge queue activation

**Track seven capability gates:**

| Gate | Condition |
|------|-----------|
| G1: Constitutional Coverage | Board interventions classified as "judgment" (not derivable from constitutional rules) < 2/month for 3 consecutive months |
| G2: Value Ratio Integrity | Strategist-reported vs board-assessed value ratios diverge < 10% |
| G3: Prompt Stability | No prompt change causes > 5% success rate shift |
| G4: Strategic Decision Quality | Strategy evaluation protocol recommendations match board decisions > 80% AND decision reversal rate < 15% over rolling 90 days (§19) |
| G5: Auditor Efficacy | Catches > 95% of synthetically injected violations |
| G6: Revenue Sustainability | Positive net revenue for 3 consecutive months (measured from first product launch; gate is N/A until then) |
| G7: Communication Safety | Gateway unsafe message escape rate < 0.01% over rolling 60-day window (not reset by individual incidents — uses aggregate rate) |

**Exit criterion:** All seven gates measured. No hard-fails in last 30 days.

### Phase 3: Strategic Autonomy — AutoBot Sandbox (Until All Gates Pass)

**Autonomy level:** 2 — agents handle tactical + strategic decisions. Board retains veto and existential decisions only. Human board removed for a sandboxed instance. Hard budget cap ($3,000-5,000/month — must cover corrected operating costs from §15). Board monitors via dashboard + kill switch only.

**Activate:**
- Constitutional layer has authority
- `autobot_finance`, `autobot_distrib`, and `autobot_comms` schemas active
- Real financial transactions (small scale, through licensed partner)
- Communication Gateway: full tier activation
- Real Auditor authority (can trigger HALT)
- Dead-man's switch active (30-day renewal)
- One product maximum
- Data Cooperative formation triggered when user count exceeds 50
- Social physics observability metrics tracked with circuit breaker: if exploration ratio drops below 5% for 30 consecutive days, the Strategist is required to assign at least 20% of new directives to cross-domain workstreams

**Exit criterion:** All seven gates pass simultaneously for a 90-day rolling window.

### Phase 4: Constitutional Autonomy — AutoBot Production (Ongoing)

**Autonomy level:** 3 — constitution governs all operational decisions. Creator is legal custodian only.

- Budget cap removed
- Multiple products permitted
- Full distribution mechanism active
- Data contribution fees active (20% allocation)
- Creator role: legal custodian, monthly dead-man's switch renewal, dashboard monitoring, kill switch access
- Constitution governs all operational decisions
- Data Cooperative independently governs data practices
- Merkle proof artifacts published for independent verification

### 14.1. Source Control and Code Review Architecture (v0.5.2)

> *Added in v0.5.2. Dustin's companion specification, reviewed by Linus (architecture) and Liotta (systems architect). Addresses how code — the primary artifact of Phase 1 — flows from agents to production. Full operational detail in companion document `optimus-github-workflow-architecture.md`; this section is the canonical governance summary.*

All code produced by agents or humans is managed in a single GitHub repository with the following governance structure. The design applies P2 (infrastructure enforces) to source control: CODEOWNERS, branch protection rules, and CI checks are GitHub-enforced mechanisms that agents cannot comply their way around.

**Branch model:** `main` (production, board-approval required) <- `develop` (integration, agents merge within CODEOWNERS constraints) <- feature branches (one per task graph work item, named `feat/TASK-XXXX-description` or `fix/TASK-XXXX-description`). Both `main` and `develop` are protected branches — no direct push, no force push.

**Review routing (CODEOWNERS):** GitHub CODEOWNERS maps repository paths to required reviewers. Two enforcement tiers for Phase 1:

| Tier | Paths | Required Reviewers | Rationale |
|------|-------|--------------------|-----------|
| BOARD | `/spec/`, `/agents/`, `/guardrails/`, `/kill-switch/`, `/gateway/`, `/infra/secrets/`, `/dashboard/`, `/.env*`, `/CODEOWNERS` | Both board members | Governance, security boundaries, agent identity, constitutional rules. Changes here alter what agents can do. |
| ARCHITECTURE | `/schemas/`, `/orchestration/`, `/audit/`, `/tools/`, `/infra/`, `/finance/` | Technical board member | Load-bearing infrastructure. Schema migrations, orchestration logic, audit integrity, tool sandboxing. |

Agent-managed paths (`/src/`, `/tests/`, `/docs/internal/`) require Reviewer agent approval via CODEOWNERS (not zero reviewers — closes self-merge loophole identified in Linus audit C1). The Reviewer agent's service account is designated as CODEOWNER for these paths, making review structurally required (P2).

A wildcard catch-all (`* @<technical-board-member>`) ensures new directories default to requiring review (P1: deny by default). Specific path overrides below the catch-all take precedence per CODEOWNERS last-match-wins rule.

**Branch protection — `main`:** Require PR, require CODEOWNERS approval, require CI pass (tests, lint, schema validation, secret detection), no direct push, no force push. Only board members have merge access — no agent service accounts (closes Linus audit C2; Orchestrator creates release PRs, board merges them).

**Branch protection — `develop`:** Require PR, require CODEOWNERS approval, require CI pass (tests, lint, secret detection). Agent service accounts may merge PRs for paths where they are CODEOWNERS-approved.

**CI enforcement checks:**
- `ci/config-isolation`: Fails if a PR touching BOARD-tier paths (`/agents/`, `/guardrails/`, `/kill-switch/`, `/CODEOWNERS`) also touches files outside those directories. Forces config changes into dedicated PRs — eliminates the class of oversight failure where config changes are buried in large code diffs (Linus C3).
- `ci/agent-identity-verification`: Cross-references PR author (GitHub service account) against the task graph's `assigned_to` field for the referenced `TASK-XXXX`. Fails if the PR author does not match the assigned agent. Closes the identity gap between the task graph and git (Linus C4).
- `ci/secret-detection`: Runs on both `main` and `develop`. Scans diffs for high-entropy strings, `.env` patterns, and known credential formats. Required check on both branches.

**Notification routing:** Auto-applied labels based on changed file paths classify every PR. Phase 1 uses 4 escalation labels: `board-decision` (governance paths including `/agents/`), `security` (auth, guards, kill-switch, gateway sanitization), `agent-work` (routine implementation), `needs-review` (manual escalation by any agent or human). Additional informational labels (`schema-migration`, `agent-config`, `architecture`, `cost-impact`) added in Phase 2 when measurement shows the board needs finer-grained filtering.

**Promotion flow:** Accumulated work in `develop` is promoted to `main` via release PRs. The Orchestrator creates `release/vX.Y.Z` branches with aggregate summaries covering completed task graph items, schema migrations, spec sections implemented, and aggregate risk/cost assessment. Board reviews the aggregate, not individual agent commits.

Promotion cadence is **event-driven** (not calendar-based — Liotta recommendation):
1. A task graph directive completes.
2. Accumulated diff exceeds 30 files or 500 lines changed.
3. Any PR merged to `develop` carries the `security` or `board-decision` label.
4. A board member requests promotion.
5. 72 hours have elapsed since last promotion (staleness floor).

The Orchestrator checks these conditions after every merge to `develop`. Thresholds are tunable parameters, not architectural constraints.

**Release PR failure path:** If CI fails on a release PR, the Orchestrator diagnoses the failure and creates fix tasks. Fixes merge to `develop`. Orchestrator rebases the release branch. If unfixable, the release branch is deleted and a new `release/vX.Y.Z+1` is created from `develop`.

**Agent constraints:** Agents cannot push directly to protected branches, cannot merge PRs touching CODEOWNERS-protected paths without designated approval, and cannot modify CODEOWNERS, guardrails, or kill switch configuration without board approval. These constraints are enforced by GitHub branch protection rules (P2), not by agent compliance. The Strategist has read-only repository access — it proposes via PRs that the board reviews, consistent with its suggest-mode role in Phase 1.

**Agent GitHub identity (Phase 1):** 1-2 bot accounts (one for agent operations, one for Orchestrator promotion PRs). Agent identity encoded in commit trailers (`Agent: executor-01`). The task graph's JWT-scoped `agent_id` remains the authoritative identity; GitHub identity is secondary. Per-agent service accounts deferred to Phase 2 when audit trail differentiation justifies the per-seat cost ($4/seat/month on GitHub Team).

**Commit traceability:** Every commit references its task graph work item (e.g., `[TASK-0042] Implement atomic guardCheck`), creating a bidirectional audit link between git history and the `state_transitions` table. Non-task commits use a category prefix (`[infra]`, `[docs]`, `[chore]`).

**Conflict resolution:** First PR to merge wins. Subsequent PRs must rebase on updated `develop`. The Orchestrator coordinates agents to avoid file-level conflicts by not assigning overlapping work concurrently. GitHub merge queue used for serialization when concurrent merge volume exceeds 2-3 PRs/hour.

**Audit trail integration:** GitHub PR review data (approvals, rejections, comments) feeds the Phase 2 capability gates. Every board review of a PR is classified as "constitutional" (derivable from rules — the PR passes all CI checks and follows conventions) or "judgment" (requires human reasoning the spec does not cover). This classification feeds G1 (Constitutional Coverage).

**Signed commits:** Deferred to Phase 2. Phase 1 threat model does not include untrusted contributors — all service accounts are board-controlled. The `ci/agent-identity-verification` check partially mitigates identity spoofing in the interim.

**Phase 1 GitHub governance success metrics:**

| Metric | Target |
|--------|--------|
| PR-to-merge cycle time (agent-managed paths) | < 30 min p95 |
| PR-to-merge cycle time (CODEOWNERS paths) | < 4 hours p95 during business hours |
| Promotion-to-production lag | < 24 hours p95 |
| False escalation rate | < 10% |
| Missed escalation rate | 0% |
| CI pass rate on agent PRs | > 95% |
| Agent-managed PR merge rate (no human intervention) | > 90% |

**Ecosystem context (v0.5.2):** The GitHub multi-agent ecosystem is evolving rapidly. Key reference points as of Feb 2026:
- **GitHub Agentic Workflows (`gh-aw`)** — GitHub's official approach: Markdown-defined workflows compiled to GitHub Actions, read-only by default, sandboxed execution. Technical preview. Validates our P1 (deny by default) approach.
- **`agents.md` standard** — Linux Foundation-stewarded format for agent specialization, used by 60,000+ projects. Our agent configs should maintain compatibility with this emerging standard.
- **Agent-per-worktree isolation** (ComposioHQ pattern) — each agent gets its own git worktree, preventing filesystem-level conflicts. Validated by multiple production implementations. Worth adopting when concurrent agent count exceeds 3.
- **Automated reaction loops** (CI fail -> agent fixes -> re-run) — the most mature systems handle feedback loops automatically, escalating to humans only on repeated failure. This maps to our Reviewer rejection escalation (3+ rejections -> `needs-review` label).
- **Workflow-level vs. infrastructure-level enforcement** — existing reference architectures (AndrewAltimit/template-repo, ComposioHQ/agent-orchestrator) enforce governance via GitHub Actions and YAML rules, not database roles or JWT scoping. This is the P2 gap our architecture deliberately addresses: their enforcement boundaries are prompts and workflows; ours are infrastructure constraints.
