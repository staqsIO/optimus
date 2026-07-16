---
title: "ADR-015: JWT Agent Identity Deferred to Phase 2"
description: "Document the intentional deferral of JWT-scoped agent identity from Phase 1, the current enforcement surface, and the concrete Phase 2 trigger conditions"
---

# ADR-015: JWT Agent Identity Deferred to Phase 2

**Date**: 2026-03-02
**Status**: Accepted

## Context

SPEC.md v0.7.0 lists "JWT-scoped agent identity" as a Phase 1 deliverable in the orchestration layer (section 2, section 5). The target architecture: each agent gets a signed JWT with `{ agent_id, tier, allowed_tools, iat, exp }`, DB connections authenticate per-tier, and RLS enforces row-level isolation cryptographically.

The implementation uses application-layer identity instead:
- `set_config('app.agent_id', $1, true)` sets a Postgres session variable per transaction
- RLS policies in `006-rls.sql` reference `current_setting('app.agent_id')` across 7 tables
- The `autobot_agent` DB role is defined in `007-roles.sql` but not used at runtime

RLS is **defined but not enforced** because:
- PGlite (local dev) is single-user — roles are not supported
- Supabase connects as `postgres` (superuser) — superuser bypasses RLS entirely

This means the RLS policies are schema documentation, not runtime enforcement.

## Decision

Defer JWT-scoped agent identity to Phase 2. Accept application-layer identity as sufficient for Phase 1's threat model.

### Phase 1 Enforcement Surface (What Actually Enforces Today)

| Mechanism | Layer | Enforces Against |
|-----------|-------|-----------------|
| Assignment trigger (`026-assignment-enforcement.sql`) | Database | Agents claiming work outside their `agent_assignment_rules` |
| `guardCheck()` pre/post execution | Application | Budget overruns, config hash mismatch, halt signals, delegation depth |
| `reserve_budget()` SQL function | Database | Spending beyond allocated budget (atomic CAS) |
| `claim_next_task()` WHERE clause | Application | Agents picking up tasks not assigned to them |
| Config hash verification | Application | Running with outdated or tampered agent configuration |

These mechanisms enforce P2 (infrastructure enforces) for the realistic Phase 1 threat surface. The assignment trigger and budget atomics are true DB-level enforcement. Guard checks are application-layer but run in a controlled, single-process environment.

### What JWT Would Add

| Threat | Current (Session Vars) | With JWT |
|--------|----------------------|----------|
| Cross-agent data access (same process) | Prevented if app code is correct | Prevented cryptographically |
| External API impersonation | Not applicable (no network exposure) | Closed |
| Ambient authority creep | Not applicable (HITL approves everything) | Token TTL enforces revocation |
| Audit log identity tampering | Agent ID is an unsigned string | Signed claim, tamper-detectable |

### Phase 1 Threat Model Assessment

Phase 1 operates as: single-user local install, two board members control all service accounts, no untrusted code in the agent process, no network exposure beyond localhost, full HITL (board approves every action).

Under this model, the marginal security gain of JWT over session vars is zero for runtime enforcement. The one meaningful gap is audit log non-repudiation — agent identity in `state_transitions` is an unsigned string. The intermediate HMAC-signing approach (below) closes that gap at minimal cost.

## Phase 2 Trigger Conditions

JWT (or equivalent per-agent DB role enforcement) becomes **required** when ANY of:

1. **Multi-user install**: A second user's agents share a DB instance
2. **Untrusted agent code**: Any executor runs code not written/reviewed by the board
3. **Network-exposed agent API**: Any agent endpoint reachable from outside localhost without board authentication
4. **Autonomous execution without HITL**: An agent completes a task involving external data write without a human approval gate in the preceding 24 hours

## Intermediate Step: HMAC-Signed Audit Claims

Before full JWT, implement HMAC-signed agent claims in `state_transitions` records. This provides non-repudiable identity binding in the audit log without JWT infrastructure. Estimated effort: 50 lines, 1 new env var (`AGENT_SIGNING_KEY`).

## Consequences

- Phase 1 ships without cryptographic agent identity at the DB connection level
- RLS policies remain defined (ready to activate when connecting as `autobot_agent`)
- The assignment trigger and budget atomics provide real DB-level enforcement
- Spec §14 Phase 1 deliverables list should note JWT as deferred
- Phase 2 planning must include: JWT key management, connection pool partitioning per tier, RLS activation testing
