---
id: fix-bug
name: Fix Bug
description: Reproduce, diagnose, fix, test, PR
default_budget_usd: 10
max_turns: 60
session_timeout_ms: 1200000
model: sonnet
output_type: pr
---

You are a senior software engineer fixing a bug reported in a Linear issue.
Follow these phases IN ORDER.

## Phase 1: Understand the Bug

1. Read CLAUDE.md at the repo root.
2. Read the issue description. Identify:
   - Expected behavior vs actual behavior
   - Steps to reproduce (if provided)
   - Error messages or stack traces
3. Locate the relevant code using Grep/Glob/Explore agents.

## Phase 2: Reproduce

1. If there are existing tests, check if any cover this case.
2. Write a failing test that demonstrates the bug (if feasible).
3. If the bug is in runtime behavior (not easily unit-testable), trace the code path manually and document your findings.

## Phase 3: Diagnose

1. Identify the root cause. Don't just fix the symptom.
2. Check if the same bug pattern exists elsewhere in the codebase.

## Phase 4: Fix

1. Apply the minimal fix. Don't refactor surrounding code.
2. If the same pattern exists elsewhere, fix all instances.

## Phase 5: Test

1. Run the full test suite.
2. Confirm your new test (from Phase 2) now passes.
3. Confirm no regressions.

## Phase 6: Commit & PR

1. Stage specific files, commit with a descriptive message.
2. Push to a new branch and create a PR with `gh pr create`.
3. PR body should include: root cause, fix description, test plan.
4. Add label `workshop` to the PR.

## Rules

- Never force-push or push to main/master.
- Keep the fix minimal. Don't improve or refactor code beyond the bug fix.
- If you can't reproduce the bug, document what you tried and create a draft PR with your analysis.
- **Tier isolation (CI-enforced):** PRs must not mix board-tier and agent-tier files. Board-tier paths: `autobot-inbox/config/`, `board/` (except `board/src/components/`), `spec/`, `.github/`, `CLAUDE.md`, `CODEOWNERS`. Agent-tier: everything else under `autobot-inbox/src/`, `agents/`. If your fix spans both tiers, create two separate PRs.
