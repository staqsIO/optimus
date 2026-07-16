---
title: "ADR-012: Graduated Escalation (Threat Memory)"
description: "Five-level escalation system bridging per-output quarantine and full HALT, with hash-chained threat memory and board-managed tolerance thresholds"
---

# ADR-012: Graduated Escalation (Threat Memory)

**Date**: 2026-03-01
**Status**: Accepted
**Issue**: The system had only two security responses: quarantine a single output (Reviewer) or halt everything (section 9 kill switch). No intermediate escalation existed to handle sustained low-level threats, gradual degradation, or probing attacks that individually pass review but collectively signal a problem.

## Context

The Reviewer agent enforces constitutional gates on individual outputs. The kill switch (halt_signals) is an all-or-nothing mechanism. Between these two extremes, the system had no way to:

- Ramp up scrutiny when threats accumulate over time
- Restrict agent behavior proportionally to threat severity
- Require board intervention for serious but non-critical threats
- Maintain an auditable, tamper-evident record of security events

The autobot-spec section 8 defines graduated escalation as five levels (0-4) computed from threat event history. This migration implements that design at the database layer, consistent with P2 (infrastructure enforces; prompts advise).

## Decision

Add two tables and three functions to the `agent_graph` schema:

**`threat_memory`** -- An append-only, hash-chained event log recording every detected threat. Each event has a source type (which detection layer found it), scope (which agent/task/tool is implicated), threat class (what kind of threat), and severity. Immutability is enforced by a trigger that permits updates only to resolution fields, and only in the false-to-true direction.

**`tolerance_config`** -- Board-managed thresholds that define when escalation levels activate. Each row maps a `(threat_class, scope_type, scope_id)` tuple to four thresholds and a severity weight scheme. A rolling time window ensures old resolved threats decay out of the escalation calculation. Conservative defaults are seeded at org and agent scope.

**`current_escalation_level(scope_type, scope_id)`** -- Computes the current level (0-4) by summing severity-weighted unresolved threats per tolerance config row and returning the highest level reached. Agents and the runtime query this function to determine what restrictions apply.

**`resolve_threat(threat_id, resolved_by)`** -- The only code path that can mark a threat resolved. HIGH and CRITICAL severity require board resolution -- agents and auto-decay cannot clear them. This is P1 (deny by default) applied to threat resolution.

**`verify_threat_memory_chain()`** -- Tamper detection, same pattern as the existing state_transitions hash chain.

The "why": graduated response prevents two failure modes. Without it, the system either over-reacts (halting on minor threats) or under-reacts (ignoring accumulating signals that individually seem benign). Board-only resolution for HIGH/CRITICAL ensures humans stay in the loop for serious security events.

## Alternatives Considered

| Alternative | Pros | Cons | Why Rejected |
|-------------|------|------|--------------|
| Application-level escalation (in-memory counters) | Simpler, no migration | Loses state on restart; no audit trail; single point of failure; P2 violation | Must survive restarts and be auditable |
| Binary threshold (quarantine or halt, no middle) | Already implemented | No proportional response; nuisance threats cause full halt or are ignored | Exactly the gap this fills |
| Time-based cooldown instead of weighted scoring | Simpler math | Treats all threat classes equally; no way to tune sensitivity per threat type | Weighted scoring with configurable thresholds is more precise and board-tunable |
| External SIEM integration | Industry standard for threat management | Massive complexity; external dependency; contradicts P4 (boring infrastructure) | Overkill for current scale; can add later if needed |

## Consequences

**Positive:**
- Proportional response to threats -- five levels between "normal" and "halt"
- Hash-chained, append-only audit trail for all security events
- Board retains control: HIGH/CRITICAL require human resolution; thresholds are board-configurable
- Consistent with existing patterns (hash chains, append-only triggers, DB-layer enforcement)

**Negative:**
- Adds a DB query on each agent claim/execution cycle to check escalation level
- tolerance_config requires board understanding of threshold tuning (mitigated by conservative defaults)

**Neutral:**
- Five escalation levels are defined but runtime enforcement (what each level actually restricts) is implemented in the agent runtime, not in this migration. The migration provides the data layer; the runtime queries `current_escalation_level()` and acts accordingly.

## Affected Files

- `sql/027-threat-memory-and-escalation.sql` -- New migration: `threat_memory` table, `tolerance_config` table, three functions, append-only trigger, default config seed data
- `docs/internal/database-architecture.md` -- Updated: new tables, functions, append-only enforcement entry
- `CLAUDE.md` (autobot-inbox) -- Updated: migration range 000-027

## Cross-Project Impact

- **Root `CLAUDE.md`** -- Migration range updated from 000-026 to 000-027.
- **`autobot-spec`** -- This implements spec section 8. No spec changes needed; the implementation matches the spec design.
