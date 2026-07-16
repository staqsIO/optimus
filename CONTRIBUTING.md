# Contributing to Optimus

Optimus is a governed agent organization where every operational role is an AI agent, supervised by a human board of directors. Contributions come from both agents and humans. All changes flow through GitHub with infrastructure-enforced governance (SPEC P2).

> **Status: reference implementation, small board.** Optimus is published as a reference implementation of the governance patterns described in `SPEC.md` and `CONSTITUTION.md`, not as a project with a dedicated open-source maintenance team. The human board is two people (see `README.md`), and most day-to-day review is done by an AI reviewer agent, not a large volunteer maintainer pool. That means: response times on issues and PRs can be slow, some contributions may be redirected toward discussion rather than a merge, and a few of the CI/merge mechanics below (see "Note for external contributors") were built for an internal agent pipeline and don't fully accommodate outside contributors yet. Issues and Discussions are open — triage is **best-effort**, typically within a week, with no guaranteed turnaround. Bug reports, design feedback, and small, well-scoped PRs are the most likely to get timely attention; issues labeled `good first issue` are curated starting points.

## Branch Naming

| Contributor | Pattern | Example |
|-------------|---------|---------|
| Agent | `feat/TASK-XXXX-description` or `fix/TASK-XXXX-description` | `feat/TASK-0042-add-guardrail-g8` |
| Human | `feat/description` or `fix/description` | `fix/migration-ordering` |

`XXXX` is the task graph work item ID. Both `main` and `develop` are protected — no direct push, no force push.

## Commit Format

- Explain **why**, not what. The diff shows the what.
- One logical change per commit. Keep commits atomic and reviewable.
- Include `Co-Authored-By` trailer for AI-assisted commits.

```
feat: add budget pre-check to G3 gate

Board requires budget authorization before any external API call.
This enforces P1 (deny by default) at the transaction level.

Co-Authored-By: optimus-executor-1 <executor-1@optimus.bot>
```

## PR Process

1. Create a PR targeting **`develop`** (never `main` directly).
2. All CI checks must pass (see below).
3. CODEOWNERS auto-requests a review from the relevant owner based on paths touched — see the note below on what this does and doesn't enforce.
4. One round of review feedback, then merge or escalate to the board.
5. PRs touching board-tier paths must be isolated — no mixing with agent-tier files.

## CI Requirements

All checks are required on `develop`. PRs will not merge until every check passes.

| Check | What It Validates |
|-------|-------------------|
| `npm test` | Unit and integration tests pass |
| `npm run migrate` | SQL migrations apply cleanly |
| `ci/config-isolation` | Board-tier and agent-tier files are not mixed in a single PR |
| `ci/secret-detection` | No credentials, high-entropy strings, or `.env` patterns in diff |
| `ci/agent-identity-verification` | Only applies to `autofix/*` branches (used by internal agents) — PRs from any other branch name, including all external contributor branches, are unaffected |
| `agent-signoff` | Requires the `agent-approved` label before merge — see the note below, this one needs a maintainer |

### Note for external contributors

A few of these mechanics were built around an internal agent pipeline and currently need a maintainer's help to clear, rather than something you can satisfy yourself:

- **`agent-approved` label / `agent-signoff` check.** This repo's merge gate requires an `agent-approved` label, normally applied by an internal reviewer agent after an ACCEPT/SHIP review. External contributors can't apply this label themselves — a board member will apply it (or trigger the review) once your PR looks ready. If your PR is otherwise green and waiting, that's most likely why; feel free to ping the PR asking for a look.
- **CODEOWNERS is notification, not a hard gate.** `require_code_owner_reviews` is intentionally off in branch protection (the sole remaining board reviewer can't self-approve their own PRs), so CODEOWNERS auto-requests a reviewer but does not block merge by itself. Don't take a missing CODEOWNERS approval as a sign your PR is stuck — the `agent-signoff` check above is the actual gate.
- **Some checks need repository secrets forks don't get.** A couple of CI jobs (e.g. `smoke`, checks that talk to a live database or external API) rely on secrets that GitHub does not expose to `pull_request`-triggered workflows on forked repos. If one of these fails or is skipped on your PR through no fault of your diff, say so in the PR description — a maintainer can re-run it internally.

## CODEOWNERS Tiers

> Note: the CODEOWNERS file itself lives in the private development repository and is not part of this public snapshot. The tiers below document how development is governed there.

Two enforcement tiers govern who must approve changes. GitHub CODEOWNERS enforces this structurally (P2).

### Board Tier (requires board member approval)

| Path | Rationale |
|------|-----------|
| `CLAUDE.md` | Agent behavioral guidance |
| `SPEC.md` | Canonical architecture specification |
| `config/agents.json` | Agent identity and capabilities |
| `config/gates.json` | Constitutional guardrail definitions |
| `.github/` | CI, branch protection, CODEOWNERS |
| `sql/` migrations | Schema changes affect all agents |

### Agent Tier (agents can self-merge after CI + review)

| Path | Rationale |
|------|-----------|
| `src/agents/` | Agent implementation code |
| `src/runtime/` | Runtime orchestration logic |
| `src/adapters/` | Channel and integration adapters |
| `test/` | Test suites |

A wildcard catch-all ensures new directories default to requiring review (P1: deny by default).

## Merge Permissions by Agent Tier

| Tier | Create PR | Approve PR (agent-tier) | Merge PR | Modify Board-Tier Paths |
|------|-----------|-------------------------|----------|-------------------------|
| Strategist | Yes | Yes | No | No — requires board approval |
| Architect | Yes | Yes | No | No — requires board approval |
| Orchestrator | Yes | No | Yes (approved PRs only) | No — requires board approval |
| Reviewer | Yes | Yes (designated CODEOWNER) | No | No — requires board approval |
| Executor | Yes | No | No | No — requires board approval |

No agent tier can modify board-tier paths without explicit board approval. The Orchestrator can merge only PRs that have already received the required CODEOWNERS approval.

## Tool Acceptance

Adding new tools or dependencies requires review under the tool acceptance policy. See [`autobot-inbox/docs/internal/tool-acceptance-policy.md`](autobot-inbox/docs/internal/tool-acceptance-policy.md) for the full process.

Core principle: boring infrastructure (P4). Approved dependencies include `pg`, `googleapis`, `@anthropic-ai/sdk`. Exotic or novel dependencies require board justification.

## Quick Reference

- **Package manager:** npm (no yarn, pnpm, or bun)
- **Node.js:** >= 20.0.0
- **Module system:** ES modules (`"type": "module"`)
- **SQL:** Parameterized queries only, no ORM
- **Governing spec:** `SPEC.md` (see the version noted at the top of that file — it's under active revision, so this list intentionally doesn't pin a version)
