# ADR-002: Individual Install Over Multi-Tenant for Second Users

**Status:** Accepted
**Date:** 2026-03-01
**Decided by:** Eric

## Context

The LinkedIn channel analysis (conversation/linkedin-channel-analysis.md) surfaced a concrete second-user scenario: Bennett, an IT recruiter, wants to use AutoBot-Inbox for his recruiting workflow. Both Liotta and Linus independently identified multi-principal support as the prerequisite for any second user.

The spec addresses multi-user in two places that contradict each other in spirit:

1. **Per-user operational views (SPEC.md, ~line 878):** Five SQL views reference a "user" dimension (`v_cost_per_email_by_user`, `v_triage_accuracy_by_user`, etc.), implying a shared-database multi-user model. However, the underlying schema has no `user_id` or `principal_id` columns — these views are aspirational, not implementable.

2. **Multi-tenant identity model (SPEC.md, ~line 1848):** Explicitly deferred to Phase 4+, framed as enterprise customers deploying agent workforces — a different problem than a second individual user.

The question: when Bennett wants to use AutoBot-Inbox, do we add tenant isolation to the existing schema or deploy a separate instance?

## Decision

Deploy AutoBot-Inbox as an individually installed product. Each user gets their own instance — their own database, their own `.env`, their own Gmail OAuth, their own budget ceiling. No shared-database multi-tenancy.

## Rationale

1. **Schema surgery is expensive and risky.** Retrofitting `principal_id` onto `agent_graph.work_items`, `inbox.messages`, `voice.speaker_profiles`, `voice.edit_deltas`, `signal.contacts`, and every view and query is one of the hardest things you can do to a running system. It touches every schema, every agent, and every query.

2. **The current architecture does one thing well.** Single-user, single-inbox, five-agent pipeline with constitutional gates. Adding tenant filtering to every query creates a new class of bugs (data leakage between tenants) with no current benefit.

3. **Aligns with spec phasing.** Multi-tenant is deferred to Phase 4+. Individual install lets a second user run in Phase 1-2 without pulling forward Phase 4 complexity.

4. **Matches the "sandboxed instance" pattern.** The spec already uses separate instances for the AutoBot sandbox (Phase 3). Individual install is the same pattern applied to additional users.

5. **Keeps infrastructure boring (P4).** A second `.env` and a second Postgres database is boring. A tenant isolation layer with RLS policies, per-tenant budget partitioning, and cross-tenant contact graph isolation is not.

## What This Defers

- Cross-user contact graph / shared signal enrichment
- Centralized dashboard with principal-filtered views
- Shared LLM cost accounting across principals
- The aspirational "per-user views" in the spec (these need schema work regardless)

## When to Revisit

Revisit this decision when:
- Three or more users are running instances and operational overhead of separate databases becomes a burden
- A product requirement emerges that requires cross-user data (shared contact graph, org-wide analytics)
- Infrastructure cost of separate instances exceeds the engineering cost of tenant isolation

## Consequences

- Bennett can run AutoBot-Inbox by standing up his own instance with his own credentials
- The install/setup process needs to be clean enough for a second person to self-serve (documentation + setup script)
- No schema migrations required for multi-user support
- Each instance has independent constitutional gates, budgets, and autonomy levels
- The spec's "per-user views" remain aspirational until multi-tenant is actually needed

## Alternatives Considered

1. **Shared-database multi-tenant (`principal_id` everywhere)** — rejected as premature; high cost, high risk, no current benefit beyond supporting one additional user
2. **Schema-per-tenant in shared Postgres** — rejected; still requires query routing complexity, and Supabase/PGlite don't make this easy
3. **Account switching in a single instance** — rejected; creates the same data isolation problems as multi-tenant without the infrastructure to enforce it
