# Paperclip Competitive Analysis — Spec Adoption Proposals

**Date:** 2026-03-09
**Author:** Eric
**Participants:** Eric (human), Claude (Liotta architecture audit, Linus code review)
**Status:** Proposal — three spec additions derived from competitive analysis
**References:** SPEC.md v0.8.0 §3 (Task Graph), §4 (Agent Runtime), §8 (Audit/Observability), §10 (Cost Tracking); Paperclip v0.3.0 (https://github.com/paperclipai/paperclip)

---

## Context

Paperclip AI launched as an open-source "control plane for zero-human companies" — 14.3k GitHub stars in 7 days. MIT license, TypeScript monorepo, Drizzle ORM over Postgres.

Liotta and Linus performed deep audits of their actual codebase. The overall verdict: **useful reference, not a threat**. Their governance is shallow (advisory SKILL.md, no DB-layer enforcement, raceable budget checks, mutable audit log, hardcoded JWT fallback). Optimus's constitutional enforcement is architecturally superior.

However, three patterns in Paperclip solve real problems we have not yet addressed. This entry proposes spec-level additions for each.

---

## Proposal 1: Agent Session Persistence (§4 — Agent Runtime)

### The Problem

Our `AgentLoop` is stateless across poll iterations. Each loop cycle builds context from scratch: load work item, load parent summary, load sibling statuses, load guardrails. For multi-step tasks that span multiple loop iterations (or future heartbeat-based invocations), this means redundant context loading on every cycle.

At current token costs (~$0.003/1K tokens for Haiku, ~$0.015/1K for Sonnet), a 4K-token context reload per iteration across 200 iterations/day is ~$2.40-$12/day in redundant context tokens. As agent volume scales, this becomes material.

### What Paperclip Does

They maintain an `agent_task_sessions` table linking (agent_id, work_item_id) to a session blob. Adapters serialize/deserialize session state across heartbeats. An agent working on issue PAP-315 can resume its Claude Code session mid-task without rebuilding context.

### Proposed Spec Addition

Add to §4 (Agent Runtime), after the Runtime Loop diagram:

```markdown
### Session Continuity

When an agent processes the same work item across multiple runtime loop iterations,
the orchestration layer MAY persist session state to reduce redundant context loading.

Schema: `agent_graph.agent_sessions`

| Column          | Type      | Purpose                                    |
|-----------------|-----------|--------------------------------------------|
| id              | uuid PK   | Session identifier                         |
| agent_id        | text FK   | Owning agent                               |
| work_item_id    | uuid FK   | Associated work item                       |
| session_data    | jsonb     | Serialized session state (model-specific)  |
| token_count     | integer   | Estimated tokens in session context        |
| created_at      | timestamptz | Session creation                         |
| updated_at      | timestamptz | Last session update                      |
| expires_at      | timestamptz | TTL (default: work item completion + 1h) |

Constraints:
- UNIQUE(agent_id, work_item_id) — one session per agent per work item
- Sessions are automatically deleted when the work item reaches a terminal state
  (completed, cancelled) via ON DELETE CASCADE or a cleanup trigger
- session_data is opaque to the orchestration layer — only the owning agent
  reads/writes it
- Session persistence is OPTIONAL — agents MUST function correctly without it
  (graceful degradation to full context rebuild)
- Sessions do NOT bypass guardrail pre-checks — every iteration still runs
  the full guardrail pipeline regardless of session state (P2)

This is a performance optimization, not an architectural primitive. No governance
decisions should depend on session state.
```

### Enforcement Notes

- Sessions scoped by agent_id (RLS in Phase 2 prevents cross-agent reads)
- No session data in audit trail (it is transient, not governance-relevant)
- Token budget from §4.5 (Context Window Management) still applies — session_data counts against the budget

### Priority: Medium (Phase 2)

---

## Proposal 2: Cost Attribution by Work Stream (§10 — Cost Tracking)

### The Problem

§10 currently tracks costs per LLM invocation and aggregates by department and model. But we cannot answer: "How much did the LinkedIn content pipeline cost this week?" or "What's the per-email cost of the inbox pipeline?" Cost is tracked at the invocation level but not rolled up to work streams, directives, or product lines.

As Optimus operates multiple products (autobot-inbox now, LinkedIn content in Phase 1.5, future products), the board needs cost visibility by work stream for budget allocation decisions.

### What Paperclip Does

They trace costs through activity logs to issues to projects, enabling a `byProject()` cost breakdown. Simple but effective for answering "how much did this project cost?"

### Proposed Spec Addition

Add to §10 (Cost Tracking), after the daily digest example:

```markdown
### Cost Attribution

Every `llm_invocations` record already links to a `task_id`. The cost attribution
view aggregates costs along the work item DAG to provide roll-up visibility.

View: `agent_graph.v_cost_by_workstream`

Aggregation hierarchy:
  directive → top-level work item → subtasks → llm_invocations

The view computes:
- Total cost per directive (work stream level)
- Total cost per top-level work item (project level)
- Cost per completed work item (unit economics)
- Rolling 7-day and 30-day cost trends per work stream

The daily cost digest (sent to board) includes a work stream breakdown:

```
Cost Report — 2026-03-09

Total spend today: $18.42

By work stream:
  Inbox Pipeline:     $12.30  (processing 47 emails)
  LinkedIn Content:   $4.12   (3 posts drafted, 1 published)
  Infrastructure:     $2.00   (migration validation)

Unit economics:
  Cost per email processed:    $0.26  (7-day avg: $0.24)
  Cost per content piece:      $1.37  (7-day avg: $1.45)
```

This view is read-only and requires no additional logging — it derives from
existing llm_invocations + work_items + dag_edges data.
```

### Enforcement Notes

- View only — no new writes, no new enforcement surface
- Aligns with P3 (transparency by structure) — cost attribution is a side effect of existing data, not a new reporting feature agents maintain
- Board can use this for G1 (budget) allocation decisions across work streams

### Priority: Medium (Phase 1.5 — needed when LinkedIn pipeline goes live)

---

## Proposal 3: Explicit Invocation Triggers (§4 — Agent Runtime)

### The Problem

Our runtime loop uses pg_notify to wake agents, with a priority-ordered event list (§4, step 1). But the trigger reason is implicit — the agent knows it was woken, but the "why" is embedded in the event type. There is no queryable record of "Agent X was invoked because of event Y at time Z" separate from the work item state transitions.

This matters for:
- Debugging: "Why did the orchestrator wake up 47 times in the last hour?"
- Optimization: "Which event types generate the most invocations?"
- Audit: "Was this agent invoked by a legitimate event or a spurious pg_notify?"

### What Paperclip Does

They maintain an `agent_wakeup_requests` table that explicitly records why an agent was invoked (task assignment, @-mention, scheduled heartbeat, etc.) with status tracking (pending, acknowledged, expired).

### Proposed Spec Addition

Add to §4 (Agent Runtime), after the Runtime Loop diagram:

```markdown
### Invocation Log

Every agent invocation is recorded with its trigger reason:

Schema: `agent_graph.invocation_log`

| Column          | Type         | Purpose                                   |
|-----------------|--------------|-------------------------------------------|
| id              | uuid PK      | Invocation identifier                     |
| agent_id        | text FK      | Invoked agent                             |
| trigger_type    | text NOT NULL | Event type that caused invocation         |
| trigger_ref     | uuid         | Reference to triggering entity (work item, escalation, etc.) |
| invoked_at      | timestamptz   | When the invocation started              |
| completed_at    | timestamptz   | When the invocation finished             |
| outcome         | text         | Result: executed, skipped_idempotent, skipped_halted, failed |
| tokens_used     | integer      | Total tokens consumed in this invocation  |
| cost_usd        | numeric(10,4)| Total cost of this invocation             |

Valid trigger_type values:
  task_assigned, escalation_received, review_requested,
  dependency_resolved, halt_signal, scheduled, manual_board

This table is append-only (P3). It provides the queryable surface for:
- Agent utilization metrics (invocations/hour by agent and trigger type)
- Cost per invocation type (are escalations more expensive than assignments?)
- Anomaly detection (unexpected invocation spikes)
```

### Enforcement Notes

- Append-only (aligns with existing audit table patterns)
- Written by the orchestration layer, not agents (P2)
- Complements §8 (Audit/Observability) metrics — the p99 latency and invocation count metrics in §8.2 can derive from this table instead of requiring separate instrumentation

### Priority: Low (Phase 2)

---

## Summary

| Proposal | Spec Section | What It Adds | Priority | Complexity |
|----------|-------------|--------------|----------|------------|
| Session Persistence | §4 | Reduce redundant context loading across loop iterations | Medium | Low (1 table, AgentLoop changes) |
| Cost Attribution | §10 | Roll-up cost visibility by work stream | Medium | Low (1 view, digest template change) |
| Invocation Log | §4 | Queryable record of why agents were invoked | Low | Low (1 append-only table) |

All three proposals:
- Derive from competitive analysis of Paperclip's architecture
- Align with existing design principles (P2, P3, P4)
- Require no changes to the governance model or constitutional gates
- Are performance/observability improvements, not architectural changes

None are blockers for Phase 1 exit. Recommended sequencing: Cost Attribution for Phase 1.5 (LinkedIn pipeline needs it), Session Persistence and Invocation Log for Phase 2.

---

## Board Decision Requested

Approve, modify, or defer these three spec additions. Each is independent — they can be adopted individually.
