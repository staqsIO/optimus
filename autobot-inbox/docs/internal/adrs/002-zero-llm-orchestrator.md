---
title: "ADR-002: Zero-LLM Orchestrator"
description: "Orchestrator uses pure code routing with no LLM calls, saving cost on deterministic work"
---

# ADR-002: Zero-LLM Orchestrator

**Date**: 2026-02-28
**Status**: Accepted
**Spec Reference**: SPEC.md -- Agent Pipeline (Orchestrator role)

## Context

The autobot-spec designates the orchestrator as a Sonnet-tier agent responsible for "Gmail poll, task creation, pipeline coordination." The original design assumed orchestration would require LLM judgment -- deciding which agent should handle an email, what priority to assign, whether to parallelize work.

In practice, orchestrator routing is entirely deterministic:

1. New email arrives -> create triage subtask -> assign to executor-triage.
2. Triage completes -> read `triage_result` metadata -> route based on `category` and `needs_strategist` flag.
3. If `needs_strategist` is true -> assign to strategist. Otherwise -> assign to executor-responder.
4. If category is `fyi` or `noise` -> no further routing needed.

No step requires judgment. The routing logic is a switch statement on structured data that the triage agent already produced. Spending a Sonnet call (~$0.003/email at ~1K input tokens) on this deterministic routing would cost ~$63/month at 700 emails/month with zero benefit.

## Decision

The orchestrator makes zero LLM calls. It is implemented as pure JavaScript routing logic in `orchestrator.js`:

- `handleNewEmailTask()` creates a triage subtask and assigns it to `executor-triage`.
- `handleStateChanged()` reads the completed triage task's `metadata.triage_result` and routes to `strategist` or `executor-responder` based on `category` and `needs_strategist`.
- `startPolling()` polls Gmail every 60 seconds, inserts email metadata, and creates top-level work items.

The handler reports `costUsd: 0` in its return value. The orchestrator does not import or use the Anthropic SDK.

## Alternatives Considered

| Alternative | Pros | Cons | Why Rejected |
|-------------|------|------|-------------|
| LLM-based routing (Sonnet) | Could handle edge cases; adapts to novel email patterns | ~$63/month for purely deterministic decisions; adds latency (~1s per call); no edge cases observed in practice | All routing rules are expressible as code; LLM adds cost and latency for zero benefit |
| Rule engine (e.g., json-rules-engine) | Externalized rules; non-developer editable | Additional dependency; overkill for 4 routing branches; violates P4 (boring infrastructure) | Switch statement is simpler and fully sufficient |
| Hybrid (LLM fallback for unknown categories) | Handles future category additions | Complexity of dual path; triage categories are an enum, so "unknown" should not occur | Triage categories are constrained by CHECK constraint in `inbox.emails` |

## Consequences

### Positive
- Saves ~$63/month in LLM costs (Sonnet at ~$0.003/email, ~700 emails/month)
- Sub-millisecond routing latency vs ~1s for an LLM call
- Deterministic, testable behavior -- no prompt sensitivity
- No risk of orchestrator hallucinating incorrect routing

### Negative
- Adding a new routing path requires a code change, not a prompt edit
- If routing ever needs genuine judgment (e.g., priority-based agent selection), this decision must be revisited

### Neutral
- CLAUDE.md still lists the orchestrator model as "Sonnet" reflecting the spec's tier designation; the implementation simply does not invoke it

## Affected Files

- `src/agents/orchestrator.js` -- Pure code handler with `costUsd: 0`, no LLM import
- `src/agents/executor-triage.js` -- Produces `triage_result` metadata that the orchestrator consumes for routing
