# Tool and Capability Acceptance Policy v2.0

**Date**: 2026-03-06
**Status**: Draft (requires board co-approval by Dustin and Eric)
**Spec Reference**: SPEC.md v0.8.0 §6
**Supersedes**: Tool Acceptance Policy v1.0 (2026-03-02)

> "No non-core tools may be registered until the policy is approved by the board." — SPEC §6

## Scope

This policy governs **all agent-to-external-system interactions**, not just tools registered in `tool_registry`. The unified `permission_grants` table (ADR-017) is the single governance surface for:

| Resource Type | Examples | Enforcement Point |
|---------------|----------|-------------------|
| **tool** | `gmail_poll`, `draft_create`, `gate_check` | `executeTool()` in `tools/registry.js` |
| **adapter** | `gmail`, `slack`, `outlook`, `webhook`, `telegram` | `loadContext()` in `src/runtime/context-loader.js` |
| **api_client** | `linear`, `github_issues`, `github_repo`, `slack_notify` | Agent handler functions |
| **subprocess** | `claude_cli` | Agent handler functions |

## Risk Classes

| Class | Description | Approval Path | Pre-Screening | Example |
|-------|-------------|---------------|---------------|---------|
| **Internal** | Read/write to owned schemas only, no external I/O | Architect review | Hash verification, output schema validation | `claim_next_task`, `transition_state`, `guard_check` |
| **Computational** | Pure computation, no I/O, no state mutation | Architect review | Resource profiling (CPU/memory limits), output validation | Embeddings generation, hash computation, text sanitization |
| **External-Read** | Read from external APIs or filesystems | Board review (either member) | Network traffic monitoring, credential scope verification | Gmail read, Drive read, contacts sync, web fetch |
| **External-Write** | Write to external systems, send communications | Board approval required (both members) | Full pre-screening suite, sandbox dry-run, rate limit verification | Linear issue create, Slack post, GitHub PR, Claude CLI spawn |

## Automatic Rejection Criteria

A capability is automatically rejected if ANY of the following are true:

1. Capability requests network access not declared in its registration
2. Capability modifies files or schemas outside its declared scope
3. Tool hash does not match the `agent_graph.tool_registry` entry at verification time
4. Capability fails sandboxed pre-screening (exceeds resource limits, invalid output schema)
5. Capability requires credentials broader than its declared risk class (e.g., an Internal tool requesting API keys)
6. Capability has no test cases or fails any registered test case
7. Capability introduces a dependency not in the project's vendor cache (see SPEC §18)

## Registration Requirements

Every capability must provide at registration:

| Requirement | Description |
|-------------|-------------|
| **Description** | Plain-language purpose statement (1-2 sentences) |
| **Input/output schema** | JSON schema for parameters and return value |
| **Risk class** | One of: Internal, Computational, External-Read, External-Write |
| **Risk justification** | Why this risk class (not a lower one) is necessary |
| **Allowed agents** | Explicit list of agent IDs permitted to invoke (deny-by-default) |
| **Test cases** | Minimum 3: happy path, error path, edge case |
| **Content hash** | SHA-256 of tool source, stored in `agent_graph.tool_registry` (tools only) |
| **Timeout** | Maximum execution time in milliseconds |
| **Credential scope** | What credentials the capability accesses (e.g., `gmail:readonly`, `github:repo:write`) |
| **Rate limit** | Maximum invocations per time window (enforcement deferred to Phase 2) |

## Reclassification Triggers

A capability must be re-registered at the highest applicable risk class when:

- Its scope changes (new schemas, new network access, new credential requirements)
- It gains write access where it previously had read-only
- A security audit identifies undeclared side effects
- The credential it uses gains broader scope (e.g., GitHub token adds `admin:org`)

Scope change = re-registration at highest class. No grandfathering for scope expansion.

## Deregistration

| Trigger | Authority | Process |
|---------|-----------|---------|
| Board decision | Either board member | Immediate deactivation: `revoked_at = now()` on `permission_grants`, `is_active = false` on `tool_registry` |
| Architect recommendation | Architect agent | Proposes deactivation, board confirms within 24h |
| Hash verification failure | Automatic | 1 hash mismatch → immediate deactivation + board alert |
| Security incident | Automatic | Any capability involved in a Tier 1 audit finding → immediate deactivation pending board review |

## Grandfather Clause

33 capabilities are grandfathered from migration `041-permission-grants.sql` with `granted_by = 'migration'`. These represent every agent-to-external-call path traced from the codebase as of 2026-03-06. They are subject to the same review cadence as any other capability — grandfathered status only exempts them from initial registration approval, not ongoing oversight.

See `SELECT * FROM agent_graph.permission_grants WHERE granted_by = 'migration'` for the full list.

## Emergency Registration Path

When an urgent operational need requires a new capability before the next review cycle:

1. Either board member grants temporary permission via `INSERT INTO agent_graph.permission_grants`
2. `granted_by` must be the board member's name (not 'migration' or 'board')
3. 72-hour review window: within 72 hours, the other board member reviews and either confirms (permanent) or revokes
4. If not reviewed within 72 hours, the grant remains active but is flagged in the next review cycle
5. Emergency grants are limited to capabilities with existing credential infrastructure (no new API keys)

## Currently Registered Capabilities (Phase 1)

### Tools (via `tool_registry` + `executeTool()`)

Core tools registered in `010-phase1-hardening.sql`. All are Internal or Computational class.

### Adapters (via `context-loader.js`)

| Adapter | Risk Class | Credential | Agents |
|---------|------------|------------|--------|
| gmail | External-Read | `gmail:readonly` | orchestrator |
| outlook | External-Read | `outlook:readonly` | orchestrator |
| slack | External-Read | `slack:read` | orchestrator |
| webhook | Internal | none | orchestrator |
| telegram | External-Read | `telegram:read` | orchestrator |

### API Clients (direct imports in agent handlers)

| Client | Risk Class | Credential | Agents |
|--------|------------|------------|--------|
| linear | External-Write | `linear:write` | executor-ticket |
| github_issues | External-Write | `github:issues:write` | executor-ticket |
| github_repo | External-Write | `github:repo:write` | executor-coder |
| slack_notify | External-Write | `slack:write` | executor-ticket, executor-coder |

### Subprocesses

| Subprocess | Risk Class | Credential | Agents |
|------------|------------|------------|--------|
| claude_cli | External-Write | `anthropic:cli` | executor-coder |

## Review Cadence

- **Monthly** during Phase 1: Board reviews full `permission_grants` table for scope creep
- **Quarterly** after Phase 2: Reduced cadence once JWT-scoped agent identity provides finer controls
- **On registration**: New capabilities follow the approval path for their risk class
- **On agent addition**: When a new agent is added, review which capabilities it needs access to
- **On scope change**: Any change to a capability's scope triggers re-registration (see Reclassification Triggers)

---

*This policy must be co-approved by both board members (Dustin and Eric) before any new External-Write capabilities are registered. Update this document when approval is granted.*
