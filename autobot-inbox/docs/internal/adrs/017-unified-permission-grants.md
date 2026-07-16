---
title: "ADR-017: Unified Permission Grants"
status: Accepted
date: 2026-03-06
---

# ADR-017: Unified Permission Grants

## Context

ADR-010 established a 4-layer tool enforcement system (`executeTool()`) with config allow-lists, DB `tool_registry` permission checks, per-tool timeouts, and `tool_invocations` audit logging. Investigation in STAQPRO-17 revealed this system is **completely bypassed in production**:

1. **No agent calls `executeTool()`** — all agents import client functions directly (e.g., `createLinearIssue()`, `spawnClaudeCLI()`, `adapter.fetchContent()`).
2. **The `tool_invocations` table is empty** — zero audit rows since deployment.
3. **Layer 1 is permanently broken** — `registry.js` checks `agentConfig.tools_allowed` but `agents.json` uses `tools` (key name mismatch, ADR-009 side effect).
4. **9 External-Read/Write capabilities operate through adapters and direct imports** with zero governance: Gmail, Slack, GitHub (issues + repo), Linear, Telegram, Claude CLI.

The tool acceptance policy (v1.0) explicitly excluded adapters from governance, stating they are "part of the runtime, not the tool registry." This created a policy gap where the highest-risk operations (External-Write: creating GitHub PRs, sending Slack messages, spawning AI subprocesses) had no permission checks, no audit trail, and no revocation mechanism.

## Decision

Replace the fragmented `tool_registry` + `agent_configs.tools_allowed` dual-check with a **unified `permission_grants` table** covering all four resource types: tools, adapters, API clients, and subprocesses. Wire a callable `checkPermission()` function (not DB trigger) at actual call sites where external interactions happen.

### Key design choices:

1. **Callable function, not DB trigger** — permission checks happen at scattered call sites (adapter fetch, Linear API call, CLI spawn), not a single table write that a trigger could intercept.
2. **Extend `tool_invocations`, not new table** — add `resource_type` and `work_item_id` columns, create `capability_invocations` VIEW. Preserves existing append-only/immutable constraints.
3. **Granularity: per-agent, per-resource-type, per-resource-name** — e.g., `('executor-ticket', 'api_client', 'linear')`. No glob patterns (SPEC §3: explicit `can_assign_to` list).
4. **Explicit wrapping at agent level** — agents pass their own ID to `requirePermission()`. No magic context propagation (AsyncLocalStorage would violate P4: boring infrastructure).
5. **Graceful degradation in context-loader** — denied adapter = null body (not crash). Agent-level calls use `requirePermission()` which throws (task retries 3x then escalates per existing state machine).
6. **Grandfather all 33 existing capabilities** — `granted_by = 'migration'` marks pre-ADR-017 grants.

## Alternatives Considered

| Alternative | Rejected Because |
|-------------|-----------------|
| Force all agents through `executeTool()` | Only covers tools in `registry.js`. Adapters, API clients, and subprocesses are fundamentally different — they're not in-process handler functions. Would require wrapping HTTP calls as fake "tools." |
| AsyncLocalStorage for implicit agent context | P4 violation — hidden magic, hard to debug. Agents are simple enough to pass their ID explicitly. |
| DB triggers on a unified `capability_calls` table | External calls happen via HTTP/subprocess, not DB writes. A trigger can only fire on table mutation. Would require agents to INSERT a request row, trigger checks it, then agent reads result — overly complex. |
| Separate `adapter_grants`, `api_grants`, `subprocess_grants` tables | Unnecessary fragmentation. Same columns, same semantics, same enforcement pattern. One table with `resource_type` discriminator is simpler. |

## Consequences

### Positive

- **Single governance surface** for all agent-to-external interactions (P1: deny by default)
- **Audit trail** for adapter fetches, API calls, and subprocess spawns (P3: transparency by structure)
- **Revocation** is one UPDATE (`revoked_at = now()`) — covers all resource types uniformly
- **Layer 1 fixed** — `tools_allowed` → `tools` mismatch resolved, `executeTool()` now works if called
- **Policy doc v2.0** covers all resource types, not just tools

### Negative

- **33 seed rows** add migration complexity (offset by `ON CONFLICT DO NOTHING` idempotency)
- **Extra DB round-trip per external call** for permission check (mitigated: `check_permission()` is a simple EXISTS query on indexed columns)
- **Not all call sites wired yet** — only the highest-traffic paths (context-loader, executor-ticket, executor-coder). Other agents using `executeTool()` have Layer 1+2 checks but not `permission_grants` checks. Full convergence is Phase 2 work.

### Neutral

- `tool_registry` is NOT removed — it still handles hash integrity verification for in-process tools
- Rate limit column exists but enforcement is deferred
- `capability_invocations` VIEW is sugar over `tool_invocations` — no performance impact

## Affected Files

| File | Change |
|------|--------|
| `sql/041-permission-grants.sql` | New: migration |
| `src/runtime/permissions.js` | New: checkPermission, requirePermission, logCapabilityInvocation |
| `src/runtime/context-loader.js` | Edit: wrap adapter.fetchContent with permission check + audit |
| `src/agents/executor-ticket.js` | Edit: wrap Linear/GitHub/Slack calls |
| `src/agents/executor-coder.js` | Edit: wrap Claude CLI spawn and GitHub repo access |
| `tools/registry.js` | Edit: fix tools_allowed → tools mismatch |
| `docs/internal/tool-acceptance-policy.md` | Edit: v2.0 with capabilities, grandfather clause |

## Spec References

- §5 Guardrail Enforcement — `check_permission()` is a new guardrail entry point
- §6 Tool Acceptance — policy expanded to cover all resource types
- P1 Deny by default — `check_permission()` returns false when no grant exists
- P2 Infrastructure enforces — DB function, not prompt instruction
- P3 Transparency by structure — `tool_invocations` extended for universal audit
- P4 Boring infrastructure — Postgres function + explicit JS calls, no magic
