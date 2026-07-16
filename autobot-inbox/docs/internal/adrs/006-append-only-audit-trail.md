---
title: "ADR-006: Append-Only Audit Trail"
description: "state_transitions and edit_deltas tables are immutable with SHA-256 hash chains for tamper detection"
---

# ADR-006: Append-Only Audit Trail

**Date**: 2026-02-28
**Status**: Accepted
**Spec Reference**: SPEC.md -- P3 (Transparency by Structure), Spec Section 12 (Hash Chain Integrity)

## Context

The Optimus governance model (P3: transparency by structure) requires that the board can audit every action taken by every agent. This means:

1. Every state transition must be recorded with full context (who, what, when, why, at what cost, with what config).
2. Records must be tamper-evident -- if someone modifies a historical record, it should be detectable.
3. Edit deltas (human corrections to AI drafts) are the most valuable training data in the system. Losing or corrupting them degrades the voice learning system.

A standard audit log (append rows, hope nobody runs DELETE) is insufficient. Database administrators, compromised credentials, or bugs could silently alter history. The system needs cryptographic integrity guarantees.

## Decision

Two tables are append-only with infrastructure enforcement:

### state_transitions (agent_graph schema)

- **Immutability**: Database triggers (`trg_state_transitions_no_update`, `trg_state_transitions_no_delete`) raise exceptions on UPDATE or DELETE, enforced by `agent_graph.prevent_mutation()`.
- **Hash chain**: Each transition stores `hash_chain_prev` (previous entry's hash) and `hash_chain_current` (SHA-256 of `prev_hash|transition_id|work_item_id|from_state|to_state|agent_id|config_hash`). The genesis entry has `prev_hash = 'genesis'`.
- **Partitioned by month**: Table is range-partitioned on `created_at` with monthly partitions (2026-01 through 2026-12 plus a default). This enables efficient pruning of old partitions without violating append-only semantics on active partitions.
- **Verification**: `verify_ledger_chain(work_item_id)` walks the chain for a work item and reports the first broken link. `verify_all_ledger_chains()` verifies every work item's chain.

### edit_deltas (voice schema)

- **Immutability**: Triggers (`trg_edit_deltas_no_update`, `trg_edit_deltas_no_delete`) prevent mutation via `voice.prevent_mutation()`.
- **No hash chain**: Edit deltas are append-only but not hash-chained. Their integrity is less critical than state transitions (they are training data, not governance records).

### Additional append-only tables

- `agent_config_history` -- Triggers prevent UPDATE/DELETE. Records every config version for each agent.
- `halt_signals` -- DELETE trigger prevents removal of halt history (UPDATE is allowed to resolve halts via `is_active = false`).

### Hash computation

The hash chain is computed in JavaScript (`state-machine.js: computeHashChain()`) rather than in SQL via `pgcrypto`. This is because PGlite (used in dev/test mode, see [ADR-004](./004-pglite-to-docker-postgres.md)) does not have `pgcrypto`. The SQL function `transition_state()` accepts a pre-computed hash via `p_hash_chain_current` parameter. If no hash is provided, the SQL function computes it using `sha256()` (available in Postgres 14+).

## Alternatives Considered

| Alternative | Pros | Cons | Why Rejected |
|-------------|------|------|-------------|
| Standard audit log (no triggers) | Simpler; relies on application-level discipline | No enforcement; DELETE/UPDATE possible; no tamper detection | Insufficient for P3 governance requirements |
| Blockchain / distributed ledger | Strongest tamper evidence; decentralized trust | Massive complexity for a single-org system; latency; P4 violation | Overkill; we trust the infrastructure, we just want to detect accidental corruption |
| Event sourcing framework (e.g., EventStoreDB) | Purpose-built for immutable event logs | Additional service; different query model; P4 violation | Postgres triggers + hash chains provide equivalent guarantees without another dependency |
| Hash chain in SQL only (pgcrypto) | Single implementation; no JS/SQL split | PGlite lacks pgcrypto; dual-mode support requires JS computation anyway | Maintaining dual-mode (see [ADR-004](./004-pglite-to-docker-postgres.md)) forces JS-side hash computation |

## Consequences

### Positive
- Tamper-evident audit trail: any modification to historical records breaks the hash chain
- `verify_ledger_chain()` provides on-demand integrity verification
- Edit deltas are preserved for voice learning even if application bugs occur
- Monthly partitioning enables efficient queries on recent data and future partition management

### Negative
- Append-only tables grow without bound; partitioning helps but old data cannot be deleted without dropping partitions
- Hash chain verification is O(n) per work item -- acceptable for current scale but may need optimization
- Dual JS/SQL hash computation creates a coupling: the hash format string must match exactly between `computeHashChain()` in `state-machine.js` and the fallback in `transition_state()` SQL function

### Neutral
- The triggers fire on every partition of `state_transitions`, not just the parent table -- Postgres propagates triggers to partitions automatically

## Affected Files

- `sql/001-agent-graph.sql` -- `state_transitions` table definition with partitioning
- `sql/003-voice.sql` -- `edit_deltas` table definition
- `sql/005-functions.sql` -- `prevent_mutation()` triggers, `verify_ledger_chain()`, `verify_all_ledger_chains()`, `transition_state()` with hash chain logic
- `src/runtime/state-machine.js` -- `computeHashChain()` JS implementation, `transitionState()` passes pre-computed hash to SQL
