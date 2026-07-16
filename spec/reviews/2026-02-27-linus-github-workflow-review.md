# Review: Optimus GitHub Workflow Architecture

**Reviewer:** Linus (architecture + systems review)
**Date:** 2026-02-27
**Document reviewed:** Optimus GitHub Workflow Architecture (companion specification, DRAFT)
**Canonical spec version:** v0.5.2
**Proposed spec target:** New section 14.1 (Source Control and Code Review Architecture)

---

## 1. Overall Assessment

**NEEDS WORK** -- The document is structurally sound and well-reasoned. The fundamental approach is correct: use GitHub-native enforcement mechanisms (CODEOWNERS, branch protection) instead of relying on agent compliance. This is P2 applied to source control, and I respect that. The problem statement is clear, the CODEOWNERS tiering is sensible, and the promotion workflow solves a real noise problem.

However, there are security gaps that matter when your "developers" are AI agents, several unnecessary complications for a 2-person board, and the proposed section 14.1 text loses critical governance detail. None of these are fatal, but several are blockers.

---

## 2. Critical Issues (Blockers)

### C1. The `required_approvals: 0` on `develop` creates a self-merge loophole for agent-managed paths

Section 4 of the companion doc, `develop` branch protection:

```yaml
required_approvals:             0          # agents can self-merge for unprotected paths
require_codeowner_review:       true       # but CODEOWNERS still enforced for protected paths
```

The comment says "agents can self-merge for unprotected paths" and CODEOWNERS is "still enforced for protected paths." This assumes GitHub treats these as independent constraints. In practice, when `required_approvals` is 0 and `require_codeowner_review` is true, the behavior depends on whether the changed files match a CODEOWNERS rule. Files that do NOT match any CODEOWNERS rule have zero approval requirement -- they can be merged by anyone with merge access. That part is fine.

But here is the problem: the document lists agent service accounts under `merge_access: all agent service accounts`. If an agent opens a PR touching ONLY files in `/src/` or `/tests/` (no CODEOWNERS entry), that agent can open the PR and merge it with zero reviews. The Reviewer agent from section 2 of the spec -- the one that is supposed to do quality assurance on executor output -- has no structural enforcement here. The document says the Reviewer tier is "read-only + PR review comments" and "cannot merge," but there is no GitHub mechanism described that actually prevents an Executor from self-merging its own PR to `develop`.

The spec's runtime loop (section 4) requires every task to pass through a `review` state before `completed`. But the GitHub layer has no enforcement of this. An executor could open a PR, CI passes, and the executor merges it -- bypassing the Reviewer entirely at the git layer.

**Fix:** Either (a) set `required_approvals: 1` on `develop` and designate the Reviewer agent's service account as a required reviewer for all paths not covered by CODEOWNERS (effectively making the Reviewer a universal CODEOWNER for `/src/` and `/tests/`), or (b) add an explicit CODEOWNERS entry that routes `/src/` and `/tests/` to the Reviewer agent's service account, making Reviewer approval structurally required. Option (b) is simpler and aligns with P2 -- infrastructure enforces.

### C2. Orchestrator has `merge_access` to `main` -- this undermines board gatekeeping

Section 4 of the companion doc, `main` branch protection:

```yaml
merge_access:
  - @<dustin-github>
  - @<eric-github>
  - orchestrator-bot                       # for automated promotions that passed all reviews
```

The Orchestrator can merge to `main`. The comment says "for automated promotions that passed all reviews." But who approved those reviews? CODEOWNERS approval is required, yes, but the Orchestrator is the one creating the release PR. If the release PR touches only files in the AGENT-MANAGED tier (`/src/`, `/tests/`), there is no CODEOWNERS reviewer, and the Orchestrator could theoretically self-merge a promotion to production.

The whole point of the promotion workflow (section 8) is that the board reviews the aggregate. If the Orchestrator can merge to main without a board member approving, the board gate is advisory, not structural. That violates P2.

**Fix:** Remove `orchestrator-bot` from `merge_access` on `main`. Only board members merge to `main`. Period. The Orchestrator creates the release PR. The board merges it. This is a 2-person operation, not a bottleneck -- the Orchestrator does all the work of assembling the release summary. The board clicks one button. If you are worried about latency, that is a process problem, not a tooling problem.

### C3. No enforcement that agents cannot bundle config changes with code changes

The CODEOWNERS routes `/agents/` to both board members. Good. But what prevents an agent from modifying files in `/agents/` on a feature branch, opening a PR to `develop`, and burying the config change in a 50-file diff alongside legitimate code changes? The PR would be blocked from merging because CODEOWNERS requires board approval. But the board member reviewing might approve the code change without noticing the config change buried in the diff.

The spec (section 4, Agent Configuration) says agent configs are stored in `agent_configs` with `config_hash` versioning and that config changes require board approval. But the GitHub layer has no structural mechanism to surface config changes -- it relies on the board member noticing the `/agents/` path in the diff.

**Fix:** Add a CI check (`ci/config-change-detection`) that fails the build if any PR touching `/agents/`, `/guardrails/`, `/kill-switch/`, or `/CODEOWNERS` also touches files outside those directories. Force config changes into dedicated PRs. This makes config changes impossible to sneak into a larger code PR. This is cheap to implement (a few lines of shell script in CI) and eliminates an entire class of oversight failure.

### C4. No agent identity verification at the git layer

The spec (section 4) defines JWT-scoped agent identity with `config_hash` verification. Every agent action is tied to a cryptographically verifiable identity. But at the GitHub layer, agent identity is just a service account with a PAT or GitHub App token. There is no mechanism described to verify that the GitHub service account creating a PR is actually the agent instance that was assigned the corresponding task graph work item.

If `executor-01`'s GitHub token is compromised (or if an agent constructs a commit using a different agent's credentials), there is no cross-verification between the task graph's `agent_id` and the GitHub commit author.

**Fix:** Add a CI check that cross-references the PR author (GitHub service account) against the task graph's `assigned_to` field for the referenced `TASK-XXXX`. If the PR author does not match the assigned agent, the CI check fails. This closes the identity gap between the task graph and git. It also catches the scenario where an agent works on a task it was not assigned.

---

## 3. Code Quality Issues (Should Fix)

### Q1. Over-engineered label taxonomy for a Phase 1 operation

The document defines 16 labels across three categories (escalation, informational, workflow). For a 2-person board and 5 agents in Phase 1, this is too many. Several labels overlap:

- `board-decision` and `spec-amendment` -- a spec amendment IS a board decision. Having both creates ambiguity about which to apply.
- `architecture` overlaps heavily with `security` -- the auto-labeler will apply both to most changes in `/orchestration/`.
- `phase-1` and `phase-2` are metadata that belongs in the task graph, not on GitHub labels. The task graph already tracks which phase a work item belongs to.
- `wip` is what draft PRs are for. GitHub has native draft PR support. A label is redundant.

**Recommendation:** Cut to 8-10 labels. Drop `phase-1`, `phase-2`, `wip` (use draft PRs). Merge `spec-amendment` into `board-decision`. Keep the escalation labels tight. You can always add labels later. You cannot easily remove them once agents are trained to use them.

### Q2. The PR template is too long for agent-generated PRs

The template has 12 fields including a checklist of 10 change categories. Agents generating PRs at machine speed will fill this out mechanically, and board members reviewing will skim past it. The template should optimize for the board member's scan time, not the agent's thoroughness.

**Recommendation:** Reduce to 5 fields: What (one sentence), Why (task graph link), Risk (LOW/MEDIUM/HIGH), Cost Impact (delta or "None"), Board Decision Required (YES/NO). The "Changes By Category" checklist is redundant with auto-labeling -- the labels already classify the PR. The "Spec Reference" and "Testing" sections are useful but could be in the PR body, not the template. Keep it lean enough that a board member can read the entire template in 10 seconds.

### Q3. `/agents/` CODEOWNERS entry is too broad

The `/agents/` directory contains "agent configs, prompts, identity definitions." But the auto-labeler separately handles `agent-config` changes. If `/agents/` contains both the agent prompt text and the agent's operational config (model, tools, guardrails), these should have different review requirements. A prompt text change is a governance decision. Adding a new test case to an agent's evaluation suite is not.

**Recommendation:** Either (a) split `/agents/` into `/agents/configs/` (board-reviewed) and `/agents/evals/` (architecture-reviewed), or (b) add a CI check that distinguishes config files from non-config files within `/agents/`. This prevents prompt-change-level review friction from blocking routine agent evaluation work.

### Q4. No conflict resolution protocol for `develop` at agent speed

Section 1 says agents "create feature branches from `develop`, one per task graph work item." At agent speed, multiple agents working on related files will generate merge conflicts on `develop` frequently. The document does not address:

- Who resolves merge conflicts? The agent that opened the PR? The Orchestrator?
- What happens when two agents modify the same schema file simultaneously?
- Is there a lock mechanism to prevent concurrent work on the same files?

The spec's `claim_next_task()` uses `FOR UPDATE SKIP LOCKED` to prevent duplicate task claims, but there is no analogous mechanism for file-level contention in git.

**Recommendation:** Define a conflict resolution protocol. At minimum: (a) first PR to merge wins, (b) subsequent PRs must rebase on updated `develop`, (c) the Orchestrator is responsible for coordinating agents to avoid file-level conflicts by not assigning overlapping work concurrently. This is a process rule, not a tooling rule, but it needs to be documented.

### Q5. Signed commits disabled on `develop` is a real trade-off that needs explicit justification

Section 4 disables signed commits on `develop`:

```yaml
require_signed_commits:         false      # reduces agent friction
```

The comment says "reduces agent friction." The document lists this as Open Question 4. But this is not a small decision. Without signed commits on `develop`, anyone with a compromised agent PAT can push commits attributed to any agent. The `main` branch requires signed commits, but if unsigned, potentially-spoofed commits flow through `develop` and get squash-merged to `main`, the squash merge commit will be signed by whoever merges -- but the underlying authorship is unverified.

**Recommendation:** Either (a) require signed commits on `develop` (GPG keys for agent service accounts are a one-time setup cost), or (b) explicitly document this as an accepted risk with a mitigation plan (e.g., the CI check from C4 partially mitigates identity spoofing). Do not leave this as "reduces agent friction" without quantifying the friction.

### Q6. Missing: what happens when CI fails on a release PR?

Section 8 (Promotion Workflow) describes the happy path. What happens when CI fails on the `release/vX.Y.Z` PR? Does the Orchestrator fix it? Does it cherry-pick the failing commits out? Does it abort the release and create a new one? At agent speed, a failed release PR that blocks the promotion pipeline for days is a real problem.

**Recommendation:** Define the failure path. At minimum: (a) Orchestrator diagnoses the failure and creates fix tasks, (b) fixes are merged to `develop`, (c) Orchestrator rebases the release branch on updated `develop`, (d) if the release branch is unfixable, delete it and create a new `release/vX.Y.Z+1` from develop.

### Q7. `board-decision` auto-label does not cover `/agents/`

The auto-labeler in section 5 applies `board-decision` for changes to `guardrails/`, `kill-switch/`, `gateway/`, `.env*`, `infra/secrets/`, and `CODEOWNERS`. But not `/agents/`. The CODEOWNERS routes `/agents/` to both board members (BOARD tier). Yet the auto-labeler only applies `agent-config` (an informational label, not an escalation label).

This means a PR modifying agent identity definitions gets the `agent-config` label (informational) but not `board-decision` (escalation). A board member filtering notifications by escalation labels would miss this.

**Fix:** Add `agents/**` to the `board-decision` auto-label rule. Agent config changes are governance decisions.

---

## 4. Specific Section Comments

### Section 0 (Problem Statement)

Clean. The problem statement is accurate and the principle alignment table is well done. The distinction between "structural (enforced by GitHub)" and "behavioral (dependent on agents remembering)" in Requirement 2 is exactly right.

### Section 3 (CODEOWNERS)

The three-tier structure (BOARD / ARCHITECTURE / AGENT-MANAGED) is the right decomposition. The rationale per path is well explained. One observation: the document lists `/dashboard/` as BOARD-tier because "Dustin for UX, Eric for data integrity." The dashboard is the board's monitoring tool -- if agents can modify the dashboard without review, they can change what the board sees. This is correct to have at BOARD tier. Good.

### Section 9 (Agent-Tier Mapping)

The table states that the Strategist "Can Merge to develop: Yes (for unprotected paths)." But the Strategist's role in the spec (section 2) is "strategic planning, cross-domain synthesis" -- it creates DIRECTIVEs and approves budgets. It does not write code. Why would the Strategist ever merge a PR to `develop`?

**Recommendation:** Restrict the Strategist to read-only on the repository. If it needs to propose spec changes, it opens a PR that the board reviews. It should not have merge access.

### Section 10 (Board Agents)

This section is important and under-specified. The constraint "Board agents should not have write access to `/infra/secrets/`" uses the word "should." In a governance document, "should" means "optional." Say "must not" or do not bother.

The statement that a board agent's approval "counts as the board member's approval for CODEOWNERS" is correct for GitHub's identity model -- the agent uses the board member's token, so GitHub sees the board member. But this creates an accountability question: if the board member's agent approves a PR that introduces a security vulnerability, and the board member never personally reviewed it, who is accountable? This is a governance question, not a technical one, but it should be acknowledged in this document.

### Section 12 (Audit Trail Integration)

The cross-reference table is useful. The "What This Enables" section correctly connects PR review data to the Phase 2 capability gates (G1: Constitutional Coverage). This is one of the stronger sections -- it shows how GitHub workflow data feeds the graduated autonomy model.

### Section 14 (Proposed Section 14.1)

The proposed spec text is too compressed. It loses several critical details:

1. **Missing:** The three-tier CODEOWNERS classification (BOARD / ARCHITECTURE / AGENT-MANAGED). The text says "Board-level paths... Architecture-level paths... Agent-managed paths" but does not enumerate which directories fall into which tier. Without the enumeration, the spec is incomplete -- someone implementing from the spec alone would not know what to put in CODEOWNERS.
2. **Missing:** The promotion workflow cadence. The text says "periodically promoted" but does not specify the weekly floor or per-milestone cadence.
3. **Missing:** The agent-tier-to-GitHub-permission mapping (section 9 of the companion doc). This is critical governance detail -- which agents can merge where.
4. **Missing:** The CI checks required on each branch. The text mentions "branch protection rules (P2)" but does not specify what those rules are.
5. **Present but vague:** "Agents cannot push directly to protected branches" -- which branches are protected? Both `main` and `develop`, but the text does not say.

**Recommendation:** The proposed section 14.1 should either (a) expand to include the full CODEOWNERS tier definitions, the agent-tier-to-permission mapping, and the CI check list, or (b) explicitly reference the companion document as the normative source for these details and state that the companion document has the same status as the spec for source control governance. Option (b) is simpler and avoids duplicating detail that will drift.

---

## 5. Missing Pieces

### M1. No secret rotation or PAT expiration policy for agent service accounts

The document mentions creating GitHub service accounts for agents (section 13, step 12) but says nothing about credential lifecycle. How often are PATs rotated? What happens when a PAT expires mid-sprint? Are GitHub Apps used instead of PATs (GitHub Apps have automatic token rotation)? This is a security hygiene requirement that needs to be specified.

### M2. No branch cleanup policy

Feature branches are "deleted after merge to `develop`" (section 4). But there is no automation described, and at agent speed, stale branches will accumulate fast. Define either (a) automatic branch deletion on PR merge (a GitHub repository setting), or (b) a periodic cleanup job.

### M3. No rate limiting on PR creation

At agent speed, an executor could create dozens of PRs per hour. This floods the notification system, the CI pipeline, and the board's review queue. There should be a rate limit -- either at the GitHub layer (using API rate limits) or at the orchestration layer (the Orchestrator limits how many tasks are in-flight concurrently). The spec's orchestration constraints ("max 1 task per executor at a time" in section 5) partially address this, but the constraint should be explicitly restated in this document.

### M4. No disaster recovery for the GitHub repository

The spec (section 14, Phase 1) defines backup/DR infrastructure for Postgres with WAL archiving and PITR. But the GitHub repository itself has no backup strategy described. If the repository is compromised (force push, branch deletion despite protections, account compromise), what is the recovery path? At minimum: (a) a mirror repository, or (b) a CI job that backs up the repo to an independent location.

### M5. No `.env` or secrets handling beyond CODEOWNERS routing

CODEOWNERS routes `.env*` and `/infra/secrets/` to both board members. But there is no `.gitignore` entry described that prevents `.env` files from being committed in the first place. There is a `ci/security-scan` check mentioned for `main`, but not for `develop`. An agent could commit secrets to `develop` and they would persist in git history even after removal.

**Recommendation:** (a) Define `.gitignore` entries for `.env`, `.env.*`, and any credential files. (b) Add `ci/security-scan` (specifically secret detection) as a required check on `develop`, not just `main`. (c) Add pre-commit hooks or a CI step that scans for high-entropy strings in diffs.

---

## 6. What Is Done Well

The document gets several things right that are worth acknowledging:

- **P2 alignment is genuine.** The entire document is built around the principle that infrastructure enforces, not agents. CODEOWNERS, branch protection, and auto-labeling are all GitHub-enforced mechanisms that agents cannot comply their way around. This is the right foundation.
- **The promotion workflow (section 8) is the best idea in the document.** Aggregating agent work into release PRs and having the board review one diff instead of 50 individual PRs is the correct solution to the notification noise problem. This will save the board hours per week.
- **The audit trail integration (section 12) connects git governance to the spec's capability gates.** Using PR review data to classify "constitutional vs. judgment" interventions and feed G1 is a concrete example of measure-before-you-trust (P5).
- **The problem statement is honest.** It correctly identifies that GitHub's default notification model breaks at agent speed and that the routing must be structural, not behavioral.

---

## 7. Final Verdict

This is a solid foundation with security gaps that must be closed before it can be integrated as section 14.1. The document understands the right principles but does not follow them all the way through in the details.

**Must fix before integration:**

1. **(C1)** Close the self-merge loophole on `develop` -- add Reviewer as CODEOWNERS for `/src/` and `/tests/`.
2. **(C2)** Remove Orchestrator from `merge_access` on `main` -- only board members merge to production.
3. **(C3)** Add CI check to force config changes into dedicated PRs.
4. **(C4)** Add CI check cross-referencing PR author against task graph assignment.
5. **(Q7)** Add `/agents/` to the `board-decision` auto-label rule.
6. **(M5)** Define `.gitignore` and secret scanning for `develop`.

**Should fix before integration:**

7. **(Q1)** Trim the label taxonomy.
8. **(Q2)** Shorten the PR template.
9. **(Q4)** Define conflict resolution protocol.
10. **(Q5)** Decide on signed commits for `develop` with explicit justification.
11. **(Q6)** Define the release PR failure path.
12. **(Section 14)** Either expand the proposed section 14.1 text with critical details or add a normative reference to the companion document.

**Can defer:**

13. **(M1)** PAT rotation policy (document it, implement later).
14. **(M2)** Branch cleanup automation.
15. **(M3)** Rate limiting (partially covered by spec's orchestration constraints).
16. **(M4)** Repository DR.

Fix C1-C4 and this is ready for spec integration. The architecture is right. The details need tightening.

---

*Reviewed by: Linus (architecture + systems review agent)*
*Spec version reviewed against: v0.5.2*
*Companion document status: DRAFT*
