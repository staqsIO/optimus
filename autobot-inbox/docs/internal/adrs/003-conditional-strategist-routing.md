---
title: "ADR-003: Conditional Strategist Routing"
description: "Strategist (Opus) only invoked for high-priority emails, skipping routine mail to save cost"
---

# ADR-003: Conditional Strategist Routing

**Date**: 2026-02-28
**Status**: Accepted
**Spec Reference**: SPEC.md -- Agent Pipeline (Strategist role)

## Context

The strategist agent uses Opus, the most expensive model tier (~$0.015/call at typical input size). It provides priority scoring, response strategy recommendations, and G2/G7 flag detection. The spec positions it as an advisory layer between triage and response.

Most emails do not need strategic analysis. A newsletter, a routine scheduling email, or an FYI from a known contact can go directly from triage to response (or archive) without Opus weighing in. Running Opus on every email would cost ~$10.50/day at 700 emails/month, consuming over half the $20 daily budget ceiling (G1).

The triage agent already computes a `quickScore` -- a heuristic 0-100 priority score based on contact type, VIP status, subject keywords, and Gmail labels. This score, combined with contact metadata, provides sufficient signal to decide whether strategic analysis adds value.

## Decision

The strategist is conditionally invoked based on routing hints computed by the triage agent. Specifically, `executor-triage.js` sets `needs_strategist = true` when any of these conditions hold:

1. `quickScore >= 60` (email scores above baseline on heuristic priority)
2. `contact.is_vip === true` (sender is a designated VIP)
3. Subject matches `/urgent|critical|contract|legal/i`

The orchestrator reads `metadata.triage_result.needs_strategist` from the completed triage task and routes accordingly:

- `needs_strategist === true` -> create subtask assigned to `strategist`
- `needs_strategist === false` -> create subtask assigned directly to `executor-responder` (with `metadata.skipped_strategist: true`)

Additionally, the strategist itself has a guard: if `email.triage_category` is `fyi` or `noise`, it returns immediately without making an LLM call. This is a belt-and-suspenders check since the orchestrator should not route these categories to the strategist at all.

Emails that skip the strategist still get a `quick_score` in their metadata, which the responder can use for tone calibration.

## Alternatives Considered

| Alternative | Pros | Cons | Why Rejected |
|-------------|------|------|-------------|
| Always invoke strategist | Consistent analysis; catches edge cases | ~$10.50/day on 700 emails; exceeds half of G1 budget ceiling; most analysis would say "proceed normally" | Cost is prohibitive relative to value on routine mail |
| Never invoke strategist (remove agent) | Maximum savings; simpler pipeline | Loses strategic analysis on VIP/urgent mail where it matters most; G2/G7 detection moves to reviewer only | Strategic analysis adds real value on high-stakes emails |
| Lower threshold (quickScore >= 40) | Catches more borderline cases | Doubles strategist invocations; marginal value for emails in 40-60 range | 60 threshold already captures VIP, urgent, and high-contact-type emails |
| Higher threshold (quickScore >= 80) | Maximum savings | Misses important emails from known contacts who are not VIP | Too aggressive; the VIP and urgency overrides compensate but contact-type scoring would be lost |

## Consequences

### Positive
- Saves ~$0.015 per skipped email; at ~60% skip rate, saves ~$6.30/day
- Keeps G1 budget headroom for other agents
- Routine emails flow through the pipeline faster (skip ~2s strategist latency)

### Negative
- Emails just below threshold (quickScore 55-59, non-VIP, non-urgent subject) skip strategic analysis -- a misjudged triage could miss a high-stakes email
- Two code paths through the pipeline (with/without strategist) increase testing surface

### Neutral
- The `skipped_strategist: true` flag in work item metadata allows post-hoc analysis of which emails bypassed the strategist and whether any should not have

## Affected Files

- `src/agents/executor-triage.js` -- Computes `quickScore` and `needs_strategist` flag, stores in work item metadata
- `src/signal/priority-scorer.js` -- `quickScore()` heuristic function (contact type, VIP, subject keywords, labels)
- `src/agents/orchestrator.js` -- `handleStateChanged()` reads `needs_strategist` to route to strategist or executor-responder
- `src/agents/strategist.js` -- Belt-and-suspenders guard skips `fyi`/`noise` categories
