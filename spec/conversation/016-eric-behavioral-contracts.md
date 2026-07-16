# 016: Structured Agent Behavioral Contracts

**Author:** Eric
**Date:** 2026-03-09
**Status:** Proposal — board review requested
**Spec sections affected:** §3 Agent Configuration (agents.md schema expansion)

## Context

External research into [msitarzewski/agency-agents](https://github.com/msitarzewski/agency-agents) (16K+ stars) — a library of 61 agent persona definitions — surfaced a pattern worth adopting. Their persona files include communication style, success metrics, and workflow phases for each agent. These are prompt-only (no infrastructure enforcement), but the *structure* is sound.

Our spec already defines `agents.md` as the human-authored agent definition layer (§3, lines 411-435), with identity, boundaries, tools, delegation rules, and anti-patterns. What's missing are three behavioral dimensions that would enable **scored validation** by the Reviewer and **richer context loading** by the Orchestrator.

## Proposal: Expand `agents.md` Schema

Add three new standard fields to the `agents.md` specification:

### 1. `communication_style`

How the agent frames its outputs. Consumed by the Reviewer for format compliance checks and by downstream agents for expectation-setting.

```yaml
communication_style:
  tone: analytical         # analytical | advisory | direct | conversational
  output_format: structured  # structured | prose | mixed
  framing: recommendation-first  # recommendation-first | evidence-first | options-list
  vocabulary_constraints:
    - "Never use hedging language ('might', 'perhaps') in triage classifications"
    - "Always cite specific gate IDs when flagging guardrail issues"
```

**Why this matters:** Right now, the Reviewer evaluates output quality by general judgment. With explicit communication contracts, format compliance becomes a binary check — either the Responder's draft matches its declared output format or it doesn't. This aligns with P5 (measure before you trust).

### 2. `success_metrics`

Measurable criteria for agent-level performance, distinct from per-task acceptance_criteria. These are aggregated over time and feed into capability gate assessments (P5).

```yaml
success_metrics:
  - metric: triage_accuracy
    description: "Classification matches human-corrected label"
    target: ">= 0.92"
    measurement: "Weekly sample of 50 triaged items vs board corrections"
  - metric: draft_approval_rate
    description: "Drafts approved without edit by board"
    target: ">= 0.85"
    measurement: "Rolling 14-day window"
  - metric: false_positive_rate
    description: "Items flagged action_required that board reclassifies as FYI/noise"
    target: "<= 0.08"
    measurement: "Rolling 14-day window"
```

**Why this matters:** Graduated autonomy (L0 → L1 → L2) currently uses coarse metrics (edit rate, error rate). Per-agent success metrics make capability gates granular — an agent can graduate for specific task types while remaining supervised for others. The Reviewer can also use these to weight its evaluation (an agent consistently missing one metric gets flagged for Architect review).

### 3. `workflow_phases`

Explicit state progression within an agent's execution cycle. Consumed by the Orchestrator for progress tracking and by the Auditor for anomaly detection (an agent skipping phases or spending disproportionate time in one phase).

```yaml
workflow_phases:
  - phase: context_load
    description: "Fetch voice profile + select few-shot examples"
    max_duration_ms: 5000
  - phase: draft
    description: "Generate response using loaded context"
    max_duration_ms: 15000
  - phase: self_check
    description: "Score draft against tone threshold before submission"
    max_duration_ms: 3000
    gate: "tone_score >= 0.80 or escalate"
```

**Why this matters:** Currently, agent execution is a black box between `in_progress` and `review`. Workflow phases make the internal progression observable (P3 — transparency by structure). The Orchestrator can detect stuck agents (phase timeout), and the Auditor can identify pattern drift (an agent that used to spend 3s on self-check now spending 15s suggests prompt degradation).

## What Does NOT Change

- The existing `agents.md` fields (identity, boundaries, tools, delegation, anti-patterns) remain as-is
- The compilation step (`agents.md` → JSON config) remains deterministic
- Infrastructure enforcement (P2) still governs hard constraints — behavioral contracts are the *specification layer*, not the enforcement layer
- `workflow_phases.max_duration_ms` is advisory in Phase 1 (logged but not enforced); becomes a hard kill-switch in Phase 2

## Compilation Impact

The three new fields compile to additional JSON config properties:

```json
{
  "communication_style": { ... },
  "success_metrics": [ ... ],
  "workflow_phases": [ ... ]
}
```

These are loaded as part of the agent's identity context (currently ~500 tokens, would grow to ~800-1,000 tokens). The Reviewer receives the target agent's `communication_style` and `success_metrics` in its context when evaluating outputs.

## Implementation Phasing

| Phase | Deliverable |
|-------|-------------|
| Spec patch (now) | Add the three fields to §3 Agent Configuration |
| Phase 2 | Author `config/agents/*.md` for all 9 agents, build compiler |
| Phase 2 | Reviewer loads behavioral contracts for scored validation |
| Phase 3 | Auditor uses workflow_phases for anomaly detection |

## Board Decision Requested

1. **Accept/reject** the three new `agents.md` fields
2. **Confirm** that `workflow_phases.max_duration_ms` is advisory-only in Phase 1
3. **Confirm** the token budget increase (~500 tokens) for agent identity context is acceptable

## Prior Art

- [agency-agents](https://github.com/msitarzewski/agency-agents) — prompt-level personas with communication style, success metrics, workflow steps (no infrastructure enforcement)
- [agents.md standard](https://agents.md/) — Linux Foundation format, already adopted in SPEC §3
- OpenClaw context management patterns (referenced in SPEC §3 Context Window Management)
