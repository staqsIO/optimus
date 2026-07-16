---
title: "ADR-010: Tool Sandboxing and Architect Routing Enforcement"
description: "Move tool execution permissions and architect routing constraints from prompt-level conventions to infrastructure enforcement"
---

# ADR-010: Tool Sandboxing and Architect Routing Enforcement

**Date**: 2026-03-01
**Status**: Accepted (partially superseded — see notes below)
**Issues**: #17 (Tool sandboxed execution), #37 (Architect P2 enforcement)

## Context

Two P2 violations were identified:

1. **Tool execution** relied on prompt instructions to limit which tools agents could use. Nothing prevented an agent from calling any tool in the registry. The audit trail for tool usage was implicit (buried in LLM invocation logs), not structured.

2. **Architect routing** relied on prompt instructions to ensure the architect only creates work items routed through the orchestrator. The architect could assign work directly to any agent, bypassing orchestrator routing logic.

Both violations contradict P2 (infrastructure enforces; prompts advise) and P1 (deny by default). Prompt-level enforcement is insufficient because LLM outputs are non-deterministic.

## Decision

Enforce both constraints at the infrastructure layer:

**Tool execution** gets four enforcement layers in `executeTool()`:
1. Agent config allow-list (`tools_allowed` array) -- P1 deny-by-default
2. DB `tool_registry.allowed_agents` check -- P2 infrastructure enforcement
3. Per-tool timeout via `Promise.race` -- prevents runaway tool calls
4. Append-only audit trail in `tool_invocations` -- P3 transparency by structure

**Architect routing** gets a DB trigger (`enforce_architect_routing`) on `work_items` that raises an exception if `created_by = 'architect'` and `assigned_to` is anything other than `orchestrator` or NULL.

**Tool integrity** verification is activated at startup: `verifyToolRegistry()` computes SHA-256 hashes of tool source files and compares against `tool_registry.tool_hash`. On first real startup, the placeholder `'builtin'` hashes are replaced with computed values.

The "why": prompts advise but cannot be trusted as sole enforcement. Agents are non-deterministic -- the only reliable way to restrict their behavior is to make violations impossible at the infrastructure layer.

## Alternatives Considered

| Alternative | Pros | Cons | Why Rejected |
|-------------|------|------|--------------|
| Prompt-only enforcement (status quo) | No code changes needed | Non-deterministic; no audit trail; P2 violation | Exactly what we're fixing |
| Application-level middleware (no DB) | Simpler; no migration | Single point of failure; no DB-layer safety net | DB trigger is more reliable for routing; audit needs append-only table |
| Separate tool sandbox process | Strongest isolation | Massive complexity increase; contradicts P4 (boring infrastructure) | Overkill for current threat model |

## Consequences

**Positive:**
- Tool execution is deny-by-default at two independent layers (config + DB)
- Every tool call is audited in a structured, append-only table
- Architect cannot bypass orchestrator routing regardless of prompt behavior
- Tool source integrity is verified at startup

**Negative:**
- Adds a DB round-trip on first tool call per agent session (permission cache load)
- New migration (024) adds a table and trigger to `agent_graph`

**Neutral:**
- Tool capability declarations (`schemas`, `network`) are metadata-only today; future enforcement is possible but not implemented

## Affected Files

- `sql/024-tool-sandboxing.sql` -- New migration: `tool_invocations` table, `enforce_architect_routing` trigger
- `tools/registry.js` -- 4-layer `executeTool()`, capability declarations on all tools
- `src/runtime/infrastructure.js` -- `verifyToolRegistry()` seeds real SHA-256 hashes on first startup

## Implementation Notes (2026-03-20)

**Tool sandboxing (`executeTool`)**: The 4-layer `executeTool()` function described above is dead code — no agent calls it. ADR-017 introduced `requirePermission()` at individual call sites as the replacement enforcement mechanism, with the same P1/P2/P3 guarantees (deny-by-default via DB `check_permission()`, append-only audit via `tool_invocations`). The `executeTool()` code remains but is not on any active code path.

**Architect routing**: The `enforce_architect_routing()` trigger was generalized into `enforce_assignment_rules()` backed by the `agent_assignment_rules` table. This supports the same constraint (architect can only assign to orchestrator or NULL) but extends to any agent pair, allowing the orchestrator to assign to executor-redesign, executor-blueprint, etc. The table-driven approach is more flexible than a hardcoded trigger.

## Cross-Project Impact

None. Tool execution and architect routing are internal to autobot-inbox. The spec (`autobot-spec/SPEC.md`) already mandates P1/P2 enforcement; this ADR implements those mandates for the tool layer.
