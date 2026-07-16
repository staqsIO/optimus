# Liotta Systems Architect Review: GitHub Workflow Architecture

> **Date:** 2026-02-27
> **Reviewer:** Liotta (Systems Architect agent)
> **Document reviewed:** Optimus GitHub Workflow Architecture (companion specification, DRAFT)
> **Spec context:** SPEC.md v0.5.2 -- sections 0, 2, 14, 15
> **Verdict:** Structurally sound, tactically over-engineered for Phase 1. Specific cuts recommended below.

---

## Executive Summary

The document solves the right problem: agent-speed commits will drown two humans in GitHub noise, and the promotion workflow is the correct architectural response. The CODEOWNERS routing and auto-labeling are genuinely good ideas that align with P2 (infrastructure enforces).

However, this is a governance spec for a 2-person board supervising 5 agents during an 8-week sprint. The document contains 16 label categories, a 3-tier CODEOWNERS scheme, 11 branch protection flags on `main`, a detailed promotion workflow, and a 14-step setup checklist. That is enterprise-grade ceremony for a seed-stage operation.

The core insight -- batch agent work and present it as aggregate release PRs -- is a 10x idea. The surrounding apparatus is 5x more complex than it needs to be to deliver that insight.

---

## 1. Leverage Analysis: The 10x Idea and Its Barnacles

### The 10x insight is the promotion workflow

The single highest-leverage decision in this document is section 8: agents merge to `develop` freely, the Orchestrator batches completed work into a release branch, the board reviews one aggregate diff. This is the right answer. At 20-50 PRs/day (agent speed), reviewing individual PRs is O(n) human attention. Batched promotion is O(1) per release cycle. That is a genuine order-of-magnitude improvement in board cognitive load.

Everything else in this document exists to support that one insight. The question is whether the support structure is proportional.

### The barnacles

**16 labels for 2 reviewers.** Dustin and Eric are the only humans. They do not need 6 escalation labels, 6 informational labels, and 4 workflow labels to figure out what needs their attention. CODEOWNERS already routes the right PRs to the right person. Labels on top of CODEOWNERS are redundant notification routing -- GitHub already notifies CODEOWNERS when their paths are touched.

The labels become valuable at Phase 2+ when you might have external contributors or when board agents need machine-readable classification to triage. For Phase 1, they are setup cost with no measurable return.

**3-tier CODEOWNERS for 2 people.** The tiers are BOARD (both), ARCHITECTURE (Eric), and AGENT-MANAGED (nobody). With two humans, this is effectively: Eric reviews everything in BOARD + ARCHITECTURE paths, Dustin reviews everything in BOARD paths, nobody reviews the rest. That is a 2-tier system. Calling it 3 tiers is naming complexity that does not exist. The actual enforcement is binary: "needs a human" or "does not need a human."

**11 branch protection flags on main.** Signed commits, linear history, conversation resolution, latest push approval, stale review dismissal -- these are individually defensible and collectively premature. Phase 1 has 2 humans and 5 agents in a private repo. Signed commits solve an impersonation threat that does not exist when you control all the service accounts. Conversation resolution solves a "forgot to address feedback" problem that does not exist when the Orchestrator is the one creating release PRs. `require_latest_push_approval` solves a "sneak a commit in after approval" problem -- but the agents are your agents, operating under your orchestration layer, and you control their credentials.

These flags become essential at Phase 2 when tactical autonomy means agents can act without per-decision board approval. At Phase 1, they are security theater against a threat model that has not materialized.

---

## 2. First-Principles Breakdown: Complexity Budget

The spec (section 15) puts Phase 1 monthly burn at $1,800-3,965/month. The document estimates 1-2 hours of setup time. That is the visible cost. The invisible costs are:

**Maintenance cost of 16 labels.** Labels drift. File paths change. The labeler.yml config becomes stale. Someone has to debug why a PR got `board-decision` when it should not have, or did not get `security` when it should have. For 2 humans who already get CODEOWNERS notifications, this maintenance cost has near-zero ROI.

**Cognitive cost of the PR template.** The template has 11 checkbox categories, 6 structured sections, and a 6-item checklist. An Executor agent generating 10-20 PRs/day will fill this out correctly every time -- it is an LLM, templates are trivially easy for it. But the board members reading these PRs now have 11 checkboxes and 6 sections of boilerplate to scan before they reach the diff. At agent speed, the template becomes noise, not signal. The aggregate release PR (section 8) is where the board actually reads. The per-PR template is an intermediate artifact that mostly serves the auto-labeler, which mostly serves a notification system that CODEOWNERS already handles.

**GitHub seat cost for service accounts.** This is the most concrete cost question in the document. GitHub Team is $4/user/month. GitHub Enterprise is $21/user/month. 5 agent service accounts = $20-105/month. That is 1-5% of the operating budget. Not ruinous, but not nothing.

The alternative: a single bot account (e.g., `optimus-bot`) with the agent identity encoded in commit metadata (trailers, commit message prefixes, or signed-off-by lines). Git already supports this via `--trailer "Agent: executor-01"`. You lose per-agent GitHub permission scoping, but at Phase 1, all agents have identical GitHub permissions anyway (create branches, create PRs, merge to develop for unprotected paths). The permission differentiation is enforced by the orchestration layer and JWT scoping (P2), not by GitHub.

Per-agent service accounts become valuable at Phase 2 when you want GitHub's audit log to distinguish which agent did what without parsing commit messages. But the spec already has its own audit trail (section 8, `state_transitions` table). GitHub's audit log is a secondary record.

**Recommendation:** Start with 1-2 bot accounts (one for agents, one for the Orchestrator if you want to distinguish promotion PRs). Expand to per-agent accounts when the audit trail needs justify the seat cost.

---

## 3. Algorithmic Optimization: Promotion Cadence

The document proposes weekly promotion with a per-milestone floor. This is the wrong default for Phase 1.

### The bottleneck analysis

At agent speed, the develop branch accumulates meaningful changes in hours, not weeks. A weekly promotion cadence means:

- Worst case: 7 days of accumulated changes in one release PR. At 20 PRs/day, that is 140 PRs worth of changes in a single diff. The aggregate summary helps, but the diff itself becomes unreviewable.
- The board cannot deploy fixes to `main` faster than once per week without breaking cadence.
- A critical bug found on Monday sits in `develop` until Friday's promotion PR.

### The right model is event-driven with a size cap

Promote when any of these conditions are met:

1. A milestone (task graph directive) completes.
2. The accumulated diff since last promotion exceeds N files or M lines changed (suggest: 30 files or 500 lines).
3. Any PR merged to `develop` carries the `security` or `board-decision` label.
4. A board member requests promotion.
5. 72 hours have elapsed since last promotion (staleness floor).

This is a simple priority queue check that the Orchestrator can run after every merge to `develop`. The complexity is O(1) per merge -- check 5 conditions against counters and timestamps. No cron job, no calendar coordination.

**Why this matters for Phase 2:** If the promotion cadence is calendar-based, you have to re-engineer it when agent speed increases at Phase 2. If it is event-driven from day one, it scales automatically. The threshold parameters (30 files, 500 lines, 72 hours) are tunable without architectural change.

---

## 4. Missing: Success Metrics

This is the most significant gap in the document. The canonical spec (section 14) defines 10 success metrics for Phase 1. The GitHub workflow document defines zero. For a system that will handle the primary artifact of Phase 1 (code), this is an oversight.

### Proposed metrics

| Metric | Target | Rationale |
|--------|--------|-----------|
| PR-to-merge cycle time (develop) | < 30 min p95 for agent-managed paths | Agents should not be blocked waiting for merges. If this is high, the CI pipeline is the bottleneck, not governance. |
| PR-to-merge cycle time (CODEOWNERS paths) | < 4 hours p95 during business hours | Board review latency. If this is consistently high, the CODEOWNERS routing is too broad -- too many paths require human review. |
| Promotion-to-production lag | < 24 hours p95 | Time from release PR opened to merged to main. If this is high, the aggregate diff is too large or the board is overloaded. |
| False escalation rate | < 10% | Percentage of PRs labeled `board-decision` or `security` that the board reviews and determines required no board action. If this is high, the auto-labeler rules are too aggressive. |
| Missed escalation rate | 0% | PRs that should have been escalated but were not. Must be zero. Measure via post-hoc board review of a random sample of agent-managed PRs. |
| CI pass rate | > 95% | If agents are generating PRs that fail CI more than 5% of the time, the Reviewer agent or Executor agent needs recalibration. |
| Release PR review time (board) | < 2 hours of actual review time per release | If the board is spending more than 2 hours reviewing a promotion PR, the release is too large. Trigger more frequent promotions. |
| Agent-managed PR merge rate | > 90% without human intervention | The whole point of the AGENT-MANAGED tier is that agents handle routine work. If more than 10% of agent-managed PRs require human intervention, the tier boundaries are wrong. |

These metrics should be tracked from day one. GitHub API provides all of them via PR timestamps, label data, and review events. A simple daily script querying the GitHub API can compute them.

---

## 5. Cost Analysis: What This Actually Costs

### GitHub seats

| Scenario | Plan | Agent accounts | Monthly cost |
|----------|------|---------------|-------------|
| 1 bot account | Team ($4/seat) | 1 | $4 |
| Per-tier accounts (3) | Team ($4/seat) | 3 | $12 |
| Per-agent accounts (5) | Team ($4/seat) | 5 | $20 |
| Per-agent accounts (5) | Enterprise ($21/seat) | 5 | $105 |

Board members presumably already have GitHub accounts, so their seats are not incremental.

**Recommendation:** GitHub Team plan, 1-2 bot accounts at Phase 1. Total incremental cost: $4-8/month. This is rounding error on a $1,800-3,965/month operating budget. Do not over-optimize here.

### GitHub Actions minutes

Auto-labeling workflow: trivially cheap. The `actions/labeler` runs in <10 seconds. At 50 PRs/day, that is ~8 minutes of compute/day. GitHub Free includes 2,000 minutes/month. This will never be a cost concern.

CI checks (tests, lint, schema validation, security scan) are the real Actions cost, but those are not defined in this document -- they are part of the CI/CD architecture, which is a separate concern.

### Hidden cost: signed commits

`require_signed_commits: true` on `main` means every agent service account needs GPG key management. This is operationally non-trivial: key generation, key storage (where? the spec says no secrets in the repo), key rotation policy, and handling of expired keys. For Phase 1, this adds setup complexity with no security benefit over the fact that you control the service accounts and their credentials.

**Recommendation:** Defer signed commits to Phase 2. Add it to the Phase 2 build list.

---

## 6. The 20% Complexity / 90% Governance Cut

Here is what Phase 1 actually needs:

### Keep (high leverage, low complexity)

1. **Branch model:** `main` (protected) <- `develop` (integration) <- feature branches. This is table stakes. Keep it.
2. **CODEOWNERS:** Two tiers only. "Needs a human" (governance paths -> both board members) and "does not need a human" (everything else). Drop the ARCHITECTURE tier for Phase 1 -- Eric gets notified on BOARD paths anyway, and if he wants to review schema PRs, he can subscribe to the `schemas/` path in his GitHub notification settings without making it a merge-blocking CODEOWNERS rule.
3. **Promotion workflow:** Event-driven, not calendar-based. Orchestrator creates release PRs with aggregate summaries. This is the 10x idea. Keep it, improve the cadence model.
4. **Branch protection on main:** Require PR, require CODEOWNERS approval, require CI pass, no direct push, no force push. That is 5 flags, not 11.
5. **Commit convention:** `[TASK-XXXX] description` for traceability. Simple, valuable, zero cost.
6. **PR template (simplified):** What, why, spec reference, risk level. Drop the 11-checkbox category list (the auto-labeler handles classification), drop the 6-item checklist (CI handles validation).

### Defer to Phase 2 (valuable but premature)

1. **Auto-labeling with 16 categories.** Start with 4 labels: `board-decision`, `security`, `agent-work`, `needs-review`. Add categories when the board demonstrates they are actually filtering by label.
2. **Signed commits.** Add when the threat model includes untrusted contributors.
3. **Per-agent service accounts.** Add when per-agent audit trail differentiation matters.
4. **`require_conversation_resolution`, `require_latest_push_approval`, `dismiss_stale_reviews`.** Add when the promotion workflow demonstrates these gaps exist.
5. **The 3-tier CODEOWNERS scheme.** Add the ARCHITECTURE tier when Eric's review load demonstrates that 2-tier routing is too coarse.

### Cut entirely

1. **`require_linear_history` on main.** Squash merge already achieves clean history. The flag adds no value if squash merge is the only allowed merge strategy.
2. **Phase labels (`phase-1`, `phase-2`).** A PR is in the phase when it is merged. The phase is a property of the timeline, not the PR. These labels will never be used for filtering because all PRs during Phase 1 are Phase 1 PRs by definition.
3. **`wip` label.** GitHub has draft PRs. Use the platform feature, not a label that duplicates it.
4. **`blocked` label.** If a PR is blocked, close it and reopen when unblocked. Or use draft status. A label that means "do not review" is a process smell -- why is the PR open if it cannot be reviewed?

---

## 7. Scaling Traps

### Trap 1: CODEOWNERS as the sole governance enforcement

CODEOWNERS blocks merges. It does not block branch creation, PR creation, or PR content. An agent can create a PR that modifies `/guardrails/` AND `/src/` in the same PR. The CODEOWNERS rule triggers board review for the guardrails change, but the board might approve the whole PR because the `/src/` changes look fine, inadvertently approving a guardrail change they did not scrutinize closely enough.

**Mitigation:** The CI pipeline (not CODEOWNERS) should enforce that PRs touching BOARD-tier paths cannot also touch AGENT-MANAGED paths. Single-concern PRs are a CI-enforceable rule. Add a GitHub Action that fails if a PR crosses tier boundaries.

### Trap 2: Promotion PR size grows unbounded

The document says "weekly or per-milestone." If a milestone takes 3 weeks, the promotion PR covers 3 weeks of agent output. At 20 PRs/day, that is 300+ PRs worth of aggregate changes. No human can meaningfully review that diff.

**Mitigation:** The event-driven promotion cadence with a size cap (section 3 of this review) prevents this. Hard-cap the promotion PR at a reviewable size.

### Trap 3: Bot account identity conflation

If you use a single bot account (my recommendation for Phase 1), all agent commits look identical in GitHub's UI. When you transition to per-agent accounts at Phase 2, you need to decide whether historical commits matter for attribution. They probably do not -- the `state_transitions` table is the authoritative record -- but confirm this before committing to the single-bot approach.

### Trap 4: The develop branch becomes a merge conflict factory

5 agents creating feature branches from `develop` and merging back will produce merge conflicts, especially if two agents modify the same file. The document does not address conflict resolution.

**Mitigation:** Two options:
- **Orchestrator-managed merge queue:** The Orchestrator serializes merges to `develop` via GitHub's merge queue feature. This eliminates conflicts at the cost of serialization latency. At Phase 1 volumes (20 PRs/day = ~2.5 PRs/hour), serialization adds minutes, not hours.
- **Task graph conflict detection:** The Orchestrator checks for file-level conflicts before assigning tasks that touch overlapping files. This is a scheduling optimization in the task graph, not a Git feature.

Either approach works. The merge queue is simpler and uses GitHub-native tooling (P4).

### Trap 5: CODEOWNERS file drift

As the repo structure evolves, CODEOWNERS paths become stale. A new directory appears, nobody adds it to CODEOWNERS, and it defaults to AGENT-MANAGED (no reviewer required). This is the failure mode of deny-by-default applied to review routing: the default should be "requires review" (P1), not "no review required."

**Mitigation:** Add a wildcard catch-all at the top of CODEOWNERS:

```
# Default: all paths require at least one board member
* @<eric-github>
```

Then add specific overrides below. In CODEOWNERS, the last matching pattern wins, so specific paths listed after the wildcard will override the default. Agent-managed paths like `/src/` and `/tests/` would need explicit entries with less restrictive ownership (or the same owner, since CODEOWNERS cannot specify "no owner").

**Important caveat:** GitHub CODEOWNERS does not support "no owner" as an override. The last matching pattern wins. This means you cannot have a catch-all that requires review AND agent-managed paths that do not require review. The actual solution is: make the catch-all `@<eric-github>`, accept that Eric will get review requests for uncategorized paths, and treat those requests as a signal to update CODEOWNERS. This is the P1-aligned approach -- deny by default, explicitly grant exceptions.

---

## 8. Answers to the Document's Open Questions (Section 15)

**Q1: GitHub handles.** Not an architectural question. Resolve immediately, it blocks nothing.

**Q2: Agent GitHub identities.** Start with 1 bot account. Expand to per-tier (3 accounts) at Phase 2 when audit differentiation matters. Per-instance accounts are over-specified for the foreseeable future -- the orchestration layer's JWT identity is the authoritative agent identity, not GitHub's.

**Q3: Promotion cadence.** Event-driven with a staleness floor (72 hours) and a size cap (30 files or 500 lines). See section 3 of this review.

**Q4: Signed commits on develop.** No. Not on develop, not on main, not anywhere during Phase 1. You control all the accounts. Signed commits solve impersonation threats. You do not have an impersonation threat. Revisit at Phase 2.

**Q5: CODEOWNERS granularity.** Directory-level is correct. File-level CODEOWNERS rules are a maintenance nightmare that scales linearly with repo size. If a specific file needs special treatment, it belongs in a directory that has the right CODEOWNERS rule, or it needs a CI check, not a CODEOWNERS entry.

---

## 9. Implementation Recommendation

### Phase 1 minimal GitHub governance (setup time: 30 minutes)

1. Create repo, create `develop` branch.
2. CODEOWNERS with 2 tiers: BOARD paths (both members) and a catch-all default (Eric).
3. Branch protection on `main`: require PR, require CODEOWNERS, require CI, no direct push, no force push. Five flags.
4. Branch protection on `develop`: require PR, require CI pass. Two flags.
5. PR template: 4 fields (what, why, spec ref, risk level).
6. Commit convention: `[TASK-XXXX] description`.
7. 4 labels: `board-decision`, `security`, `agent-work`, `needs-review`.
8. Auto-labeler for `board-decision` and `security` only (the two escalation labels that matter).
9. 1 bot account for all agents. Agent identity in commit trailers.
10. Event-driven promotion workflow implemented in the Orchestrator's task logic.

### Phase 2 additions (when measurement justifies)

- Expand to per-tier bot accounts (3 accounts).
- Add ARCHITECTURE CODEOWNERS tier for Eric.
- Add remaining labels as the board demonstrates they filter by them.
- Add signed commits.
- Add merge queue.
- Add remaining branch protection flags.

This gets 90% of the governance value (protection of critical paths, batch review, audit traceability) with 20% of the setup and maintenance complexity.

---

## 10. Verdict

The document demonstrates strong architectural thinking. The promotion workflow is the right answer to the agent-speed notification problem. The CODEOWNERS approach correctly applies P2 (infrastructure enforces). The audit trail integration (section 12) correctly identifies the constitutional-vs-judgment classification opportunity.

The document's weakness is a failure to apply its own design principles to itself. P4 says "boring infrastructure." A 16-label taxonomy with auto-labeling workflows is not boring -- it is enterprise governance scaffolding. P5 says "measure before you trust." But the document proposes all 16 labels, all 11 branch protection flags, and all 3 CODEOWNERS tiers upfront without any measurement showing they are needed.

The right approach: start minimal, measure what the board actually needs to filter on, and add governance machinery in response to measured gaps. That is P5 applied to the governance layer itself.

The document should be revised to separate "Phase 1 minimum" from "Phase 2+ additions," and the proposed spec amendment (section 14) should reflect the minimal version, with the full version documented as a scaling target.

---

*Review generated by Liotta Systems Architect agent, 2026-02-27.*
