---
title: "Architecture Decision Records"
description: "Index and process for autobot-inbox ADRs"
---

# Architecture Decision Records

This directory contains Architecture Decision Records (ADRs) for the autobot-inbox project. ADRs capture the "why" behind significant technical decisions -- the context, the alternatives considered, and the consequences accepted.

## Process

1. **When to write an ADR**: Any decision that affects the system's architecture, data model, security posture, cost profile, or agent coordination model warrants an ADR.
2. **Numbering**: ADRs are numbered sequentially (001, 002, ...). Never reuse a number.
3. **Immutability**: Once accepted, an ADR is not modified. If a decision is reversed, write a new ADR that supersedes the old one and update the old ADR's status to "Superseded by ADR-NNN".
4. **Spec references**: Where a decision implements or deviates from the autobot-spec, reference the relevant SPEC.md section.

## Status Values

- **Proposed** -- Under discussion, not yet implemented.
- **Accepted** -- Decision made and implemented.
- **Deprecated** -- No longer relevant (e.g., feature removed).
- **Superseded by ADR-NNN** -- Replaced by a newer decision.

## ADR Index

| ADR | Title | Status | Date |
|-----|-------|--------|------|
| [001](./001-metadata-only-email-storage.md) | Metadata-Only Email Storage | Accepted | 2026-02-28 |
| [002](./002-zero-llm-orchestrator.md) | Zero-LLM Orchestrator | Accepted | 2026-02-28 |
| [003](./003-conditional-strategist-routing.md) | Conditional Strategist Routing | Accepted | 2026-02-28 |
| [004](./004-pglite-to-docker-postgres.md) | PGlite to Docker Postgres Migration | Accepted | 2026-02-28 |
| [005](./005-task-graph-over-message-queue.md) | Task Graph Over Message Queue | Accepted | 2026-02-28 |
| [006](./006-append-only-audit-trail.md) | Append-Only Audit Trail | Accepted | 2026-02-28 |
| [007](./007-state-changed-routing-fix.md) | State-Changed Event Routing Fix | Accepted | 2026-02-28 |
| [008](./008-adapter-pattern-for-multi-channel.md) | Adapter Pattern for Multi-Channel Support | Accepted | 2026-03-01 |
| [009](./009-config-driven-agent-selection.md) | Config-Driven Agent Selection | Accepted | 2026-03-01 |
| [010](./010-tool-sandboxing-and-architect-routing.md) | Tool Sandboxing and Architect Routing Enforcement | Accepted | 2026-03-01 |
| [011](./011-voice-edit-delta-feedback-loop.md) | Voice Edit Delta Feedback Loop | Accepted | 2026-03-01 |
| [012](./012-graduated-escalation.md) | Graduated Escalation (Threat Memory) | Accepted | 2026-03-01 |
| [013](./013-unified-action-proposals.md) | Unified Action Proposals | Accepted | 2026-03-01 |
| [014](./014-signal-taxonomy-v2.md) | Signal Taxonomy v2 -- Dimensional Classification | Accepted | 2026-03-02 |
| [015](./015-jwt-deferral-to-phase2.md) | JWT Agent Identity Deferred to Phase 2 | Accepted | 2026-03-02 |
| [016](./016-executor-coder-model-selection.md) | Executor-Coder Model Selection | Accepted | 2026-03-05 |
| [017](./017-unified-permission-grants.md) | Unified Permission Grants | Accepted | 2026-03-06 |
| [018](./018-jwt-agent-identity.md) | JWT Agent Identity — Board Mandate | Accepted | 2026-03-07 |
| [019](./019-neo4j-knowledge-graph.md) | Neo4j Knowledge Graph for Agent Learning | Proposed | 2026-03-12 |
| [020](./020-unified-multi-business-organization.md) | Unified Multi-Business Organization | Accepted | 2026-03-14 |
| [021](./021-two-layer-autonomous-claw-system.md) | Two-Layer Autonomous Claw System | Accepted | 2026-03-16 |
| [022](./022-gws-cli-integration.md) | Google Workspace CLI (gws) Integration | Proposed | 2026-03-22 |
| [023](./023-participant-aware-rag.md) | Participant-Aware RAG | Accepted | 2026-04-16 |
| [024](./024-contracts-module.md) | Contracts Module | Accepted | 2026-04-22 |
| [025](./025-signal-table-layering.md) | Signal Table Layering -- Envelopes vs Extractions | Accepted | 2026-05-03 |
| [026](./026-contacts-are-persons.md) | Contacts ARE Persons; Identities Are Channels | Accepted | 2026-05-05 |
| [027](./027-google-calendar-mirror.md) | Google Calendar Mirror in Postgres | Accepted | 2026-05-12 |
| [028](./028-external-customer-access-on-prem.md) | External Customer Access + On-Prem / Portability Path (OPT-37) | Proposed | 2026-06-08 |
| [029](./029-rag-enrichment-architecture.md) | RAG Enrichment Architecture — Vault, Sent Mail, Board Chat, Contact Graph | Proposed | 2026-04-02 |
| [030](./030-pipeline-unblock-review.md) | Pipeline Unblock — Architectural Review | Accepted | 2026-03-28 |

## Template

New ADRs should follow the template in each existing ADR: frontmatter, context, decision, alternatives considered (table), consequences (positive/negative/neutral), and affected files.
