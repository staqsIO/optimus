# Optimus GitHub Workflow Architecture

> **Document type:** Companion specification
> **Date:** 2026-02-27
> **Authors:** Dustin, Claude (drafting assistance)
> **Status:** `DRAFT` — pending Eric review
> **Spec references:** §0 (Design Principles), §2 (Agent Tiers), §4 (Agent Runtime), §5 (Guardrail Enforcement), §8 (Audit and Observability), §14 (Phased Execution Plan)
> **Proposed spec target:** v0.5.2 PATCH — new §14.1 (Source Control and Code Review Architecture)

---

## 0. Problem Statement

The spec defines how agents communicate (task graph), how actions are enforced (orchestration layer), and how the board oversees operations (dashboard + digests). It is silent on how **code** — the primary artifact of Phase 1 — flows from agents to production.

Three classes of stakeholders interact with one rapidly-evolving repository:

1. **Board members (Dustin, Eric)** — each potentially using their own AI agents (Claude in claude.ai, Claude Code, etc.) to review and interact with PRs
2. **Optimus system agents** (Phase 1: Strategist, Orchestrator, Executor) — writing code, creating PRs, iterating at machine speed
3. **Board members' agents** — operating with their principal's GitHub identity, performing code review, leaving comments, approving or requesting changes

Without a governance layer on the repo, GitHub's default notification model sends everything to everyone. At agent-speed commit rates, this is unusable within days.

### Requirements

1. Board members only get pinged for changes that require their attention
2. The routing is structural (enforced by GitHub), not behavioral (dependent on agents remembering to tag people)
3. Agents cannot bypass review requirements for governance-critical code paths
4. Every PR is traceable to a task graph work item
5. The system works for both human reviewers and their AI agents
6. Setup cost is minimal — GitHub-native features, no custom tooling

### Design Principle Alignment

| Principle | How This System Implements It |
|-----------|------------------------------|
| P1 (Deny by default) | Agents cannot push to protected branches. CODEOWNERS blocks merge without designated approval. |
| P2 (Infrastructure enforces) | Branch protection rules and CODEOWNERS are GitHub-enforced. An agent cannot comply its way around them. |
| P3 (Transparency by structure) | Auto-labeling ensures every PR is classified. PR templates force structured justification. Commit conventions link to task graph. |
| P4 (Boring infrastructure) | CODEOWNERS, branch protection, GitHub Actions, labels — all battle-tested GitHub-native features. |
| P5 (Measure before you trust) | Graduated branch access. Agents prove quality on `develop` before code reaches `main`. |
| P6 (Familiar interfaces) | Both board members operate directly in GitHub. Their agents use the same GitHub API. |

---

## 1. Architecture Overview

```
                    ┌─────────────────────────────────┐
                    │           main                   │
                    │  (production — board-gated)      │
                    │  Branch protection:              │
                    │    ✅ CODEOWNERS required         │
                    │    ✅ CI must pass                │
                    │    ✅ Squash merge only           │
                    │    ✅ No direct push              │
                    └──────────────┬──────────────────┘
                                   │
                          release/vX.Y.Z PR
                         (aggregate promotion)
                                   │
                    ┌──────────────┴──────────────────┐
                    │          develop                  │
                    │  (integration — agents merge)    │
                    │  Branch protection:              │
                    │    ✅ CI must pass                │
                    │    ✅ CODEOWNERS for protected    │
                    │       paths                      │
                    │    ✅ No direct push              │
                    └───┬──────────┬──────────┬───────┘
                        │          │          │
                   feat/TASK-  feat/TASK-  fix/TASK-
                   0042        0043        0044
                   (per-task feature branches)
```

### Flow Summary

1. **Agents** create feature branches from `develop`, one per task graph work item
2. **Agents** open PRs to `develop`. Auto-labeling classifies the PR. CODEOWNERS triggers review requests based on files changed.
3. **Board members** (or their agents) review PRs that touch their CODEOWNERS paths. Routine agent work merges without human review.
4. **Orchestrator** periodically creates a `release/vX.Y.Z` branch from `develop` and opens a promotion PR to `main` with an aggregate summary.
5. **Board** reviews the promotion PR — one diff covering everything since the last release, not 50 individual agent PRs.

---

## 2. Repository Structure

The directory layout determines review routing via CODEOWNERS. This structure maps directly to spec components:

```
optimus/
├── spec/                    # Canonical architecture spec, design docs         → §0-§20
├── schemas/                 # Postgres DDL, migrations                         → §3, §12
│   └── migrations/          # Versioned migration files
├── orchestration/           # Orchestration layer, guardCheck, runtime loop    → §4, §5
│   ├── auth/                # JWT, identity, RLS
│   ├── guards/              # guardCheck implementation
│   └── runtime/             # Agent runtime loop
├── agents/                  # Agent configs, prompts, identity definitions     → §2, §4
├── tools/                   # Tool registry, integrity layer, sandboxing      → §6
├── gateway/                 # Communication Gateway                           → §7
├── audit/                   # Audit system, event log, Merkle proofs          → §8
├── kill-switch/             # HALT protocol, dead-man's switch                → §9
├── finance/                 # Cost tracking, financial scripts                → §10
├── guardrails/              # Org/role/task guardrail definitions              → §5
├── infra/                   # Docker, CI/CD, deployment configs
│   └── secrets/             # Credential management (encrypted)
├── dashboard/               # Board-facing dashboard                          → §2, §8
├── src/                     # Application source code (agent-built)
├── tests/                   # Test suites
├── docs/                    # Internal documentation
│   └── internal/            # Agent-generated docs
├── scripts/                 # Utility scripts
├── .github/                 # GitHub configuration
│   ├── workflows/           # GitHub Actions
│   ├── labeler.yml          # Auto-label rules
│   ├── labels.yml           # Label definitions
│   └── pull_request_template.md
├── CODEOWNERS               # Review routing
└── CONTRIBUTING.md          # Agent + human workflow rules
```

---

## 3. CODEOWNERS — Review Routing

CODEOWNERS is the enforcement mechanism. GitHub will not allow a PR to merge if a required CODEOWNER has not approved. This is P2 — infrastructure enforces.

Three routing tiers:

### Tier: BOARD (both board members)

Changes here affect governance, security boundaries, agent identity, or the canonical spec. Both Dustin and Eric must be aware.

```
/spec/                                    @<dustin-github> @<eric-github>
/agents/                                  @<dustin-github> @<eric-github>
/guardrails/                              @<dustin-github> @<eric-github>
/kill-switch/                             @<dustin-github> @<eric-github>
/gateway/                                 @<dustin-github> @<eric-github>
/.env*                                    @<dustin-github> @<eric-github>
/infra/secrets/                           @<dustin-github> @<eric-github>
/dashboard/                               @<dustin-github> @<eric-github>
/CODEOWNERS                               @<dustin-github> @<eric-github>
```

**Rationale by path:**
- `/spec/` — any change is a spec amendment (§20 versioning rules apply)
- `/agents/` — controls what agents can do. A modified agent config changes the security boundary (P1). `config_hash` in the audit trail means nothing if the config can change without board review.
- `/guardrails/` — the enforcement definitions. Changing a budget limit or `can_assign_to` list is a governance decision.
- `/kill-switch/` — the HALT protocol. Self-explanatory.
- `/gateway/` — highest-risk component per the Lethal Trifecta Assessment (§2). Any change here could affect external communication.
- `/infra/secrets/` — credential management. No agent should touch this unreviewed.
- `/dashboard/` — the board's primary interface. Both care — Dustin for UX, Eric for data integrity.
- `/CODEOWNERS` — changing the review routing itself is a governance decision.

### Tier: ARCHITECTURE (Eric)

Structural technical changes. Eric shaped this architecture (v3 response) and reviews changes that affect system integrity.

```
/schemas/                                 @<eric-github>
/orchestration/                           @<eric-github>
/audit/                                   @<eric-github>
/tools/                                   @<eric-github>
/infra/                                   @<eric-github>
/finance/                                 @<eric-github>
```

**Rationale:** These are the load-bearing walls. Schema migrations, orchestration logic, audit integrity, tool sandboxing — a bug here is a security incident. Eric's lifetime coding experience is the right review gate.

### Tier: AGENT-MANAGED (no required reviewer)

Routine implementation work reviewed by Optimus reviewer agents (§2, Reviewer tier). Board members *can* review — they just aren't auto-pinged.

```
/src/                         # no CODEOWNERS entry = no required reviewer
/tests/                       # same
/docs/internal/               # same
```

**Rationale:** Executor-generated code implementing tasks against established specs. The reviewer agent handles quality. If something needs human eyes, the agent applies the `needs-review` label.

---

## 4. Branch Protection Rules

Configured in GitHub Settings → Branches. Cannot be set via file, but documented here for reproducibility and auditability.

### `main` — Production

```yaml
require_pull_request:           true
required_approvals:             1          # CODEOWNERS determines WHO
dismiss_stale_reviews:          true       # new commits invalidate old approvals
require_codeowner_review:       true       # CODEOWNERS is the routing table
require_latest_push_approval:   true       # approver must review final state
require_status_checks:          true
required_checks:
  - ci/tests                               # unit + integration
  - ci/lint                                # linting + type checking
  - ci/schema-check                        # migration validation
  - ci/security-scan                       # dependency audit + secret detection
require_up_to_date_branch:      true       # must be rebased on latest main
require_conversation_resolution: true      # all review threads resolved
require_signed_commits:         true       # commit authorship verification
require_linear_history:         true       # squash merge only — clean history
allow_force_push:               false      # NEVER
allow_deletions:                false      # NEVER
lock_branch:                    true       # all changes via PR only

# Who can merge (not push — no one pushes directly):
merge_access:
  - @<dustin-github>
  - @<eric-github>
  - orchestrator-bot                       # for automated promotions that passed all reviews
```

### `develop` — Integration

```yaml
require_pull_request:           true
required_approvals:             0          # agents can self-merge for unprotected paths
require_codeowner_review:       true       # but CODEOWNERS still enforced for protected paths
require_status_checks:          true
required_checks:
  - ci/tests
  - ci/lint
require_signed_commits:         false      # reduces agent friction
require_linear_history:         false      # merge commits OK on develop
allow_force_push:               false      # NEVER
allow_deletions:                false      # NEVER

merge_access:
  - @<dustin-github>
  - @<eric-github>
  - all agent service accounts
```

### Feature Branches (`feat/*`, `fix/*`, `chore/*`)

No protection rules. Agents create and manage these freely. Deleted after merge to `develop`.

**Naming convention:**
```
feat/TASK-0042-implement-guardcheck
fix/TASK-0044-race-condition-budget-check
chore/TASK-0045-update-lockfile
```

The task graph ID in the branch name creates a bidirectional link between git and the task graph — searchable in both directions.

---

## 5. Labels and Auto-Labeling

### Label Definitions

Labels serve two purposes: notification routing (which humans get pinged) and classification (what kind of change is this).

**Escalation labels** (trigger human attention):

| Label | Color | Description | Applied When |
|-------|-------|-------------|-------------|
| `board-decision` | Red `#D93F0B` | Requires explicit board approval before merge | PR changes security boundaries, budget limits, governance rules, or board-level CODEOWNERS paths |
| `spec-amendment` | Light red `#E99695` | Proposes a change to the canonical spec | PR modifies files in `/spec/`. PR body must include version and section per §20. |
| `security` | Red `#D93F0B` | Touches auth, JWT, RLS, sanitization, tool integrity, HALT | PR modifies files in auth, guard, sanitization, or kill-switch paths |
| `cost-impact` | Yellow `#FBCA04` | Affects operating cost model (§15) | PR changes model configs, token budgets, adds new services. Agent must estimate delta in PR body. |
| `architecture` | Purple `#5319E7` | Structural change to core systems | PR modifies orchestration, schemas, gateway, audit, or tools |
| `needs-review` | Yellow `#FBCA04` | Agent explicitly requesting human eyes | Manually applied by any agent or human |

**Informational labels** (context, not escalation):

| Label | Color | Description |
|-------|-------|-------------|
| `agent-work` | Green `#0E8A16` | Routine agent-generated implementation |
| `schema-migration` | Blue `#1D76DB` | Includes database migration |
| `agent-config` | Light blue `#C5DEF5` | Changes agent identity, permissions, guardrails |
| `tests-only` | Lighter blue `#BFD4F2` | Only test files changed |
| `docs` | Medium blue `#0075CA` | Documentation only |
| `infra` | Light purple `#D4C5F9` | CI/CD, Docker, deployment |

**Workflow labels:**

| Label | Color | Description |
|-------|-------|-------------|
| `blocked` | Dark red `#B60205` | Blocked on external dependency or board decision |
| `wip` | Grey `#EDEDED` | Work in progress — do not review |
| `phase-1` | Light green `#C2E0C6` | Phase 1 deliverable |
| `phase-2` | Light purple `#D4C5F9` | Phase 2 deliverable |

### Auto-Labeling

A GitHub Action (`.github/workflows/auto-label.yml`) runs on every PR open/sync/reopen and applies labels based on changed file paths using `actions/labeler@v5`. This is the P3 safety net — even if an agent forgets to label its PR, the file paths guarantee correct classification.

**Auto-label mapping (`.github/labeler.yml`):**

```yaml
board-decision:
  - changed-files:
    - any-glob-to-any-file:
      - 'guardrails/**'
      - 'kill-switch/**'
      - 'gateway/**'
      - '.env*'
      - 'infra/secrets/**'
      - 'CODEOWNERS'

security:
  - changed-files:
    - any-glob-to-any-file:
      - 'orchestration/**/auth/**'
      - 'orchestration/**/jwt/**'
      - 'orchestration/**/rls/**'
      - 'orchestration/**/sanitiz*'
      - 'orchestration/**/guard*'
      - 'tools/**/integrity*'
      - 'tools/**/sandbox*'
      - 'kill-switch/**'
      - 'gateway/**/sanitiz*'
      - 'gateway/**/verify*'
      - 'guardrails/**'

spec-amendment:
  - changed-files:
    - any-glob-to-any-file:
      - 'spec/**'

cost-impact:
  - changed-files:
    - any-glob-to-any-file:
      - 'agents/**/model*'
      - 'finance/**'
      - 'orchestration/**/budget*'
      - 'orchestration/**/cost*'

architecture:
  - changed-files:
    - any-glob-to-any-file:
      - 'orchestration/**'
      - 'schemas/**'
      - 'gateway/**'
      - 'audit/**'
      - 'tools/**'

agent-config:
  - changed-files:
    - any-glob-to-any-file:
      - 'agents/**'

schema-migration:
  - changed-files:
    - any-glob-to-any-file:
      - 'schemas/migrations/**'
      - 'schemas/**/*.sql'

tests-only:
  - changed-files:
    - all-globs-to-all-files:           # ALL files must be tests
      - 'tests/**'
      - '**/*.test.*'
      - '**/*.spec.*'

docs:
  - changed-files:
    - all-globs-to-all-files:
      - 'docs/**'
      - '**/*.md'
      - '!spec/**'                       # spec changes ≠ docs

infra:
  - changed-files:
    - any-glob-to-any-file:
      - 'infra/**'
      - 'docker-compose*'
      - 'Dockerfile*'
      - '.github/workflows/**'
```

### GitHub Action

```yaml
name: Auto-Label PRs
on:
  pull_request:
    types: [opened, synchronize, reopened]
permissions:
  contents: read
  pull-requests: write
jobs:
  label:
    runs-on: ubuntu-latest
    steps:
      - name: Apply labels based on changed files
        uses: actions/labeler@v5
        with:
          repo-token: "${{ secrets.GITHUB_TOKEN }}"
          configuration-path: .github/labeler.yml
          sync-labels: true
```

### Label Setup Script

Run once after creating the repo:

```bash
#!/usr/bin/env bash
set -euo pipefail
REPO="${1:?Usage: ./setup-labels.sh owner/repo}"

gh label create "board-decision"   --repo "$REPO" --color "D93F0B" --description "Requires explicit board approval before merge" --force
gh label create "spec-amendment"   --repo "$REPO" --color "E99695" --description "Proposes a change to the canonical spec" --force
gh label create "security"         --repo "$REPO" --color "D93F0B" --description "Touches auth, JWT, RLS, sanitization, tool integrity, or HALT" --force
gh label create "cost-impact"      --repo "$REPO" --color "FBCA04" --description "Affects operating cost model" --force
gh label create "architecture"     --repo "$REPO" --color "5319E7" --description "Structural change to core systems" --force
gh label create "agent-work"       --repo "$REPO" --color "0E8A16" --description "Routine agent-generated work" --force
gh label create "schema-migration" --repo "$REPO" --color "1D76DB" --description "Includes database migration" --force
gh label create "agent-config"     --repo "$REPO" --color "C5DEF5" --description "Changes agent identity, permissions, or guardrails" --force
gh label create "tests-only"       --repo "$REPO" --color "BFD4F2" --description "Only test files changed" --force
gh label create "docs"             --repo "$REPO" --color "0075CA" --description "Documentation only" --force
gh label create "infra"            --repo "$REPO" --color "D4C5F9" --description "CI/CD, Docker, deployment" --force
gh label create "needs-review"     --repo "$REPO" --color "FBCA04" --description "Agent requesting human review" --force
gh label create "blocked"          --repo "$REPO" --color "B60205" --description "Blocked on dependency or board decision" --force
gh label create "wip"              --repo "$REPO" --color "EDEDED" --description "Work in progress" --force
gh label create "phase-1"          --repo "$REPO" --color "C2E0C6" --description "Phase 1 deliverable" --force
gh label create "phase-2"          --repo "$REPO" --color "D4C5F9" --description "Phase 2 deliverable" --force
```

---

## 6. PR Template

Every PR — agent or human — uses this template. It forces structured communication (P3) and makes review efficient for board members who may be scanning dozens of notifications.

```markdown
## What This Changes
<!-- One sentence. -->

## Why
<!-- Link to task graph work item (e.g., TASK-0042) or explain motivation. -->

## Spec Reference
<!-- e.g., "§5 guardCheck — implements atomic guard + transition"
     If none: "None — [brief justification]" -->

## Risk Assessment
<!-- LOW / MEDIUM / HIGH
     LOW    = implementation within existing boundaries
     MEDIUM = schema migration, new tool, agent config change, guardrail threshold change
     HIGH   = security boundary, budget limit, external comms, HALT protocol -->

## Cost Impact
<!-- Monthly delta estimate if applicable. "None" otherwise. -->

## Board Decision Required?
<!-- YES (with specifics) / NO -->

## Changes By Category
- [ ] Schema / migration
- [ ] Guardrail configuration
- [ ] Agent configuration
- [ ] Orchestration layer
- [ ] Tool registry / integrity
- [ ] Communication Gateway
- [ ] Audit / observability
- [ ] Infrastructure / CI/CD
- [ ] Tests only
- [ ] Documentation only
- [ ] Spec amendment (include proposed version bump per §20)

## Testing
<!-- What tests cover this? Migration up+down tested? Adversarial cases? -->

## Checklist
- [ ] PR title: `[AREA] Brief description` (e.g., `[orchestration] Add atomic guardCheck`)
- [ ] Labels applied
- [ ] Spec reference accurate
- [ ] Risk assessment honest (when in doubt, go higher)
- [ ] No secrets, credentials, or PII in diff
- [ ] Tests pass
```

---

## 7. Commit Convention

Every commit references its task graph work item, creating a bidirectional audit link between git history and the task graph's `state_transitions` table.

```
[TASK-XXXX] Brief imperative description

Optional longer explanation.
Ref: spec §N
```

Non-task commits use a category prefix:

```
[infra] Fix CI timeout for schema validation
[docs] Update CONTRIBUTING.md
[chore] Update dependency lockfile
```

---

## 8. Promotion Workflow (develop → main)

This is the key workflow that prevents board members from drowning in per-commit agent noise.

### Process

1. **Orchestrator** creates `release/vX.Y.Z` branch from `develop` at milestone boundary
2. **CI** runs full suite: tests, lint, schema validation, security scan
3. **Orchestrator** opens PR against `main` with aggregate summary:

```markdown
## Release v0.1.3 — Promotion from develop

### Task Graph Items Completed
- TASK-0042: Atomic guardCheck + transition_state (§5)
- TASK-0043: JWT-scoped agent identity (§4)
- TASK-0044: Budget pre-authorization check (§5)

### Schema Migrations
- 001_create_agent_graph.sql (up + down verified)
- 002_add_budget_tables.sql (up + down verified)

### Spec Sections Implemented
- §5 guardCheck (partial — budget enforcement complete, delegation depth TBD)
- §4 agent runtime loop steps 1-4

### Aggregate Risk Assessment: MEDIUM
Schema migrations included. No security boundary changes. No external comms.

### Aggregate Cost Impact: None
No model or token budget changes.
```

4. **CODEOWNERS** triggers review requests based on aggregate files changed
5. **Board** reviews one diff covering all work since last promotion — not individual commits
6. **Squash merge** to `main` on approval

### Cadence

At minimum weekly during Phase 1, or per milestone — whichever comes first. Board can request more frequent promotions.

---

## 9. Agent-Tier Mapping

How the spec's agent tiers (§2) map to GitHub permissions:

| Agent Tier | Branch Access | PR Targets | Can Merge to develop | Can Merge to main | CODEOWNERS Paths |
|------------|--------------|------------|---------------------|-------------------|-----------------|
| Strategist | Create `feat/*` from develop | develop | Yes (for unprotected paths) | No | None (proposes via PR, board approves) |
| Orchestrator | Create `feat/*`, `release/*` from develop | develop, main | Yes (for unprotected paths) | Only via release PR with board approval | None |
| Executor | Create `feat/*`, `fix/*` from develop | develop | Yes (for unprotected paths) | No | None |
| Reviewer (Optimus) | Read-only + PR review comments | — | No (reviews only) | No | None |
| Board (Dustin) | Full access | develop, main | Yes | Yes | Board-tier paths |
| Board (Eric) | Full access | develop, main | Yes | Yes | Board-tier + architecture-tier paths |

**Key constraint:** No agent can merge a PR that touches a CODEOWNERS-protected path without the designated reviewer's approval. An executor writing a schema migration cannot merge it — Eric must approve first. This is P2 in action.

---

## 10. Board Agents

Both board members may use personal AI agents (Claude in claude.ai, Claude Code, etc.) to interact with PRs. These agents operate with their principal's identity:

- **Authentication:** The agent uses the board member's GitHub token or SSH key
- **Approvals:** The agent's approval counts as the board member's approval for CODEOWNERS
- **Comments:** The agent's review comments appear as the board member's comments
- **Constraint:** Board agents should not have write access to `/infra/secrets/` or credential stores — they can review and approve, not deploy or modify secrets

### Agent Review Workflow

A board member's agent can efficiently process PR notifications:

1. Read the PR template → extract spec reference, risk assessment, cost impact
2. If `tests-only` or `docs` label → low priority, batch review
3. If `board-decision` or `security` label → summarize for the board member, flag for immediate attention
4. If `architecture` label → deep code review, check against spec constraints
5. Leave structured review comments referencing spec sections
6. Approve or request changes per the board member's standing instructions

This mirrors the spec's tiered event processing (§4, runtime loop step 1) — escalation labels get priority, routine labels get batched.

---

## 11. Escalation Paths

When something needs human attention beyond what CODEOWNERS and labels provide:

| Situation | Agent Action |
|-----------|-------------|
| Unsure if change affects security boundary | Apply `needs-review` + `security` labels, explain in PR comment |
| Unclear cost impact | Apply `needs-review` + `cost-impact` labels, provide best estimate |
| Discovered spec gap during implementation | Apply `spec-amendment` label, describe the gap in PR body |
| Dependency CVE affects current work | Apply `security` + `blocked` labels, link CVE details |
| Tests reveal unexpected behavior in another component | Apply `needs-review`, tag the component's CODEOWNER |
| Reviewer agent rejects work 3+ times | Apply `needs-review`, include rejection history in PR comment |

---

## 12. Audit Trail Integration

GitHub's audit trail (PR reviews, approvals, merges, comments) is a complementary system to the task graph's `state_transitions` table (§8).

### Cross-Reference Points

| Git Artifact | Task Graph Artifact | Link |
|-------------|---------------------|------|
| Commit message `[TASK-XXXX]` | `work_items.id` | Task ID in commit message |
| PR number | `state_transitions.reason` | PR URL in transition reason field |
| Merge commit SHA | `work_items.updated_at` | Timestamp correlation |
| CODEOWNERS approval | Board intervention classification | "Constitutional" vs. "judgment" (§14 Phase 1 instrumentation) |

### What This Enables

During Phase 1, every board review of a PR is data for the "constitutional vs. judgment" classification (§14). If Eric approves a schema migration PR, was that approval derivable from rules (the migration passes all CI checks and follows the schema conventions) or did it require human judgment (the migration changes a security boundary in a way the spec doesn't cover)? This classification feeds directly into the Phase 2 capability gates — specifically G1 (Constitutional Coverage).

---

## 13. Setup Checklist

Execute in order after creating the GitHub repository:

```
□ 1. Create repository (private, initialize with README)
□ 2. Create directory structure (§2 of this document)
□ 3. Run label setup script (§5) — `./setup-labels.sh owner/repo`
□ 4. Add CODEOWNERS file to repo root (§3)
     └── Replace @<dustin-github> and @<eric-github> with real handles
□ 5. Add PR template to .github/pull_request_template.md (§6)
□ 6. Add auto-labeler workflow to .github/workflows/auto-label.yml (§5)
□ 7. Add labeler config to .github/labeler.yml (§5)
□ 8. Add CONTRIBUTING.md to repo root (contents: §4, §7, §8, §9, §11)
□ 9. Configure branch protection for main (§4) via GitHub Settings
□ 10. Configure branch protection for develop (§4) via GitHub Settings
□ 11. Create develop branch from main
□ 12. Create GitHub service accounts for Optimus agents
      └── Each agent gets its own GitHub identity (maps to agent_id in spec)
      └── Minimal permissions: read repo, create branches, create PRs, 
          merge to develop (for unprotected paths only)
□ 13. Test the pipeline:
      └── Agent creates feat/test-001 branch
      └── Agent opens PR to develop touching a CODEOWNERS-protected path
      └── Verify auto-labels applied
      └── Verify CODEOWNERS review request triggered
      └── Board member approves
      └── Merge succeeds
□ 14. Archive this document in /spec/ as companion to the canonical spec
```

**Estimated setup time:** 1-2 hours including testing.

---

## 14. Proposed Spec Amendment (v0.5.2)

This section proposes adding §14.1 to the canonical spec. Classification: PATCH — operational convention, no structural changes.

### Proposed §14.1 — Source Control and Code Review Architecture

> All code produced by agents or humans is managed in a single GitHub repository with the following governance structure:
>
> **Branch model:** `main` (production, board-approval required) ← `develop` (integration, agents merge freely within CODEOWNERS constraints) ← feature branches (one per task graph work item).
>
> **Review routing:** GitHub CODEOWNERS maps repository paths to required reviewers. Board-level paths (spec, agent configs, guardrails, kill switch, gateway, credentials) require both board members. Architecture-level paths (schemas, orchestration, audit, tools, infrastructure) require the technical board member. Agent-managed paths (implementation, tests) require no human reviewer by default.
>
> **Notification routing:** Auto-applied labels based on changed file paths classify every PR by escalation level (board-decision, security, cost-impact, spec-amendment) and category (schema-migration, agent-config, agent-work). Labels drive GitHub notification filtering.
>
> **Promotion flow:** Accumulated work in `develop` is periodically promoted to `main` via release PRs that summarize completed task graph items, schema migrations, spec sections implemented, and aggregate risk/cost assessment. Board reviews the aggregate, not individual agent commits.
>
> **Agent constraints:** Agents cannot push directly to protected branches, cannot merge PRs touching CODEOWNERS-protected paths without designated approval, and cannot modify CODEOWNERS, guardrails, or kill switch configuration without board approval. These constraints are enforced by GitHub branch protection rules (P2), not by agent compliance.
>
> **Commit traceability:** Every commit references its task graph work item (e.g., `[TASK-0042]`), creating a bidirectional audit link between git history and the `state_transitions` table.

### Phase 1 Build List Addition

> - GitHub repository with CODEOWNERS, branch protection, auto-labeling, and PR templates configured per §14.1
> - CONTRIBUTING.md as part of agent operational context
> - Agent GitHub service accounts with scoped permissions

---

## 15. Open Questions for Board

1. **GitHub handles:** What are the actual GitHub usernames to use in CODEOWNERS? (Currently `@<dustin-github>` and `@<eric-github>` as placeholders.)

2. **Agent GitHub identities:** One service account per agent tier (e.g., `optimus-orchestrator`) or one per agent instance (e.g., `optimus-orchestrator-eng`, `optimus-executor-01`)? The spec uses per-instance agent IDs (§4), which argues for per-instance GitHub accounts. But GitHub charges per seat on paid plans.

3. **Promotion cadence:** Weekly, per-milestone, or on-demand? My recommendation is per-milestone during Phase 1 (align with task graph directive completions), with a weekly floor (promote at least weekly even if no milestone is hit).

4. **Signed commits on develop:** Currently proposed as not required (reduces agent friction). Eric — is this acceptable or do you want commit signing everywhere?

5. **CODEOWNERS granularity:** The current mapping is directory-level. Should any individual files get their own rules? (e.g., `docker-compose.yml` separately from `/infra/`?)
