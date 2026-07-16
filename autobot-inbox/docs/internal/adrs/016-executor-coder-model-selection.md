---
title: "ADR-016: Executor-Coder Model Selection"
description: "Document the intentional decision to keep Claude Sonnet for executor-coder rather than downgrading to Haiku-tier"
---

# ADR-016: Executor-Coder Model Selection

**Date**: 2026-03-05
**Status**: Accepted

## Context

The executor-coder agent generates code fixes from tickets and creates PRs via the Git Trees API. The spec (SPEC.md v0.7.0, section 2) designates executors as Haiku-tier, but code generation quality is critical for PR acceptance rates. The executor-coder was shipped with `llmEnabled: false` (dead code path) in `config/agents.json` pending this decision.

## Decision

Keep Claude Sonnet (`claude-sonnet-4-6`) for executor-coder rather than downgrading to Haiku. This is an intentional deviation from the spec's executor-tier model guidance. Enable the LLM by setting `llmEnabled: true`.

## Rationale

| Factor | Haiku | Sonnet |
|--------|-------|--------|
| Syntax error rate | Higher -- frequent minor errors in generated code | Significantly lower |
| Idiomatic code | Inconsistent patterns | Consistently idiomatic |
| Cost per M tokens (input/output) | $1 / $5 | $3 / $15 |
| Estimated cost per session | $0.15--0.50 | $0.50--1.50 |

- Code generation requires higher reasoning capability than triage/response tasks
- Failed PRs waste more in review time than the model cost difference
- Cost is bounded by the `claudeCode.maxBudgetUsd: 2.00` per-session hard cap
- The 3x cost premium is acceptable given the quality delta

## Consequences

- **Higher per-task LLM cost**: ~$0.50--1.50 per session vs ~$0.15--0.50 with Haiku
- **Mitigated by**: the $2/session hard cap (`claudeCode.maxBudgetUsd`) and the G1 daily budget ceiling ($20/day)
- **Spec deviation**: executor-coder is the only executor not running Haiku-tier. This is documented and intentional -- revisit if a future Haiku version closes the code generation quality gap

## Affected Files

- `config/agents.json` -- `executor-coder.llmEnabled` changed from `false` to `true`
