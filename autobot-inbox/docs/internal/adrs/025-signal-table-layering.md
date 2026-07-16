---
title: "ADR-025: Signal Table Layering -- Envelopes vs Extractions"
description: "Why agent_graph.signals and inbox.signals coexist and must not be merged"
---

# ADR-025: Signal Table Layering -- Envelopes vs Extractions

**Date**: 2026-05-03
**Status**: Accepted
**Related**: ADR-008 (Adapter Pattern), ADR-013 (Unified Action Proposals), ADR-014 (Signal Taxonomy v2)

## Context

The system has two tables, both named with the word "signals," that look superficially redundant:

- `agent_graph.signals` -- written by `lib/adapters/*` and `src/webhooks/signal-ingester.js`. One row per inbound channel event (a Slack message arrived at T, a Gmail message arrived at T, a webhook fired at T). Schema: `{ id, type, payload, source_agent, created_at }`. Read by the Board's `/signals` view, by `lib/runtime/flow-engine.js` for trigger matching, and by tool/registry consumers.
- `inbox.signals` -- written by `agents/executor-triage/index.js`. One row per **extracted proposition** lifted out of an inbound message body by an LLM. Schema: `{ id, message_id, signal_type ∈ ['commitment', 'deadline', 'request', 'question', 'approval_needed', 'decision', 'introduction', 'info', 'action_item'], content, confidence, due_date, resolved, direction, domain, metadata, created_at }`. Read by `agents/strategist/index.js`, `lib/runtime/context-loader.js`, `autobot-inbox/tools/registry.js`, the obligations / OWE-WAITING-CONNECT views in `/today`, and the new `/meetings` view.

Engineers asked to "consolidate signals" twice in the past two months. Both proposals would have either:

1. **Merged** the two tables into one with a `source` discriminator column, or
2. **Migrated** one schema's callers to the other and renamed.

This ADR records why both proposals are wrong and what to do instead.

## Decision

**Keep the two tables. Treat them as different abstraction layers.** They are not duplication; they are explicitly separated by SPEC §12 (no cross-schema FKs) precisely because they have different write paths, different trust levels, and different retention semantics.

| Property | `agent_graph.signals` | `inbox.signals` |
|----------|----------------------|-----------------|
| Concept | Transport envelope | Extracted proposition |
| Source of truth | Yes (immutable inbound fact) | No (LLM-derived claim) |
| Re-derivable? | No (loss = data loss) | Yes (re-run extractor on stored body) |
| Producer | Channel adapters (deterministic) | Executor-triage (Haiku/DeepSeek) |
| Consumers | Flow engine triggers, tool registry, Board /signals | Strategist scoring, /today obligations, /meetings UI, context-loader |
| Lifecycle | Append-only, kept indefinitely | May be re-extracted when prompts/models change |
| Schema | Channel-agnostic (type + payload JSON) | Domain-specific (signal_type, direction, domain, due_date, resolved) |

The join itself documents the layering: the `/meetings` API at `src/api-routes/meetings.js` joins `inbox.messages → inbox.signals` to surface "what arrived" alongside "what we extracted from it." Anyone reading that query sees the two layers explicitly.

## Decision: Naming Convention (Future Work, Not This ADR)

The recurring "consolidate signals" question is mostly a name collision. "Signal" is the right word for both at different abstraction levels. To kill the ambiguity at the next natural touch point on each schema:

- `agent_graph.signals` → `agent_graph.inbound_events` (or `envelopes`)
- `inbox.signals` → `inbox.extractions` (or `extracted_claims`)

This is filed as a separate ticket, not bundled here, because:

1. The rename is mechanical (~8 callers per table) but spans agent code, lib code, board code, tools, docs, and at least one running flow definition. Bundling it with anything else creates merge risk.
2. The rename should be done as part of an existing migration that already touches each schema (e.g., the next time `inbox.signals` gets a column added), to amortize the diff cost.
3. Until the rename happens, this ADR is the canonical reference engineers can cite when the question comes back.

## Alternatives Considered

| Alternative | Pros | Cons | Why Rejected |
|-------------|------|------|--------------|
| Merge into one table with `source` discriminator | One fewer table; one query covers both | Forces lowest-common-denominator schema (lose envelope-specific `payload` JSON shape and extraction-specific `confidence`/`due_date`/`direction`/`domain`); breaks the source-of-truth/derived-view boundary; collapses different write paths into one constraint surface | Destructive consolidation. The "duplication" is a name collision, not a data-model collision. |
| Migrate `agent_graph.signals` callers to `inbox.signals` | Single canonical table | Envelopes aren't message-scoped (no `message_id`); flow engine triggers don't fit the extraction taxonomy; would force schema gymnastics on every channel adapter | Breaks ADR-008 (channel-agnostic adapter contract). |
| Migrate `inbox.signals` callers to `agent_graph.signals` | Single canonical table | Loses the dimensional classification from ADR-014 (direction, domain, due_date, resolved). Strategist scoring would have to re-derive these from a generic `payload` blob on every read | Breaks ADR-014. Read-time re-derivation is the cost we explicitly avoided. |
| SQL VIEW unioning both with a `source` column | UI thinks it's one thing | Same lowest-common-denominator problem as #1, plus query-planner pain across schemas with different DB roles; creates a phantom unified concept that doesn't exist in the domain | View is the right tool when two tables are the same concept split for partitioning/perf. These aren't. |
| Status quo (do nothing) | Zero work | Question keeps recurring; new engineers waste time relitigating | Free-but-lossy. This ADR + the future rename closes it. |

## Consequences

### Positive

- Engineers stop relitigating "should we merge these?" -- there is now a citable answer.
- The two layers retain their independent retention/audit semantics. We can re-run extraction (e.g., when an extractor prompt is improved) without disturbing the immutable inbound event log.
- The `/meetings` UI's join query at `src/api-routes/meetings.js` becomes self-documenting: it joins envelope-layer and extraction-layer in one place, with the schema names visible in SQL.
- Future products (next agent organization on a new vertical) can reuse `agent_graph.signals` via the existing adapter pattern without inheriting the email-specific extraction taxonomy of `inbox.signals`.

### Negative

- The "signals" name continues to be overloaded until the rename ticket is executed. New engineers will keep asking the question -- but this ADR makes the answer fast.
- Cross-schema joins in user-facing queries (e.g., `/meetings`) cost a planner step each. Acceptable at current scale; revisit if `inbox.signals` grows past ~10M rows.

### Neutral

- No code changes from this ADR alone. The rename is a separate ticket.
- `inbox.signals` remains compatible with the dimensional taxonomy in ADR-014 (signal_type + direction + domain). Adding offset columns (`start_offset`, `end_offset`) for inline transcript highlights in the `/meetings` detail view is orthogonal; file separately if/when that UX is built.

## Affected Files

This ADR documents existing structure; no code changes. References:

- `autobot-inbox/sql/001-baseline.sql` -- both tables defined here
- `autobot-inbox/src/api-routes/meetings.js` -- new (this session); joins both layers
- `agents/executor-triage/index.js` -- writes to `inbox.signals`
- `lib/adapters/*` and `autobot-inbox/src/webhooks/signal-ingester.js` -- write to `agent_graph.signals`
- `agents/strategist/index.js`, `lib/runtime/context-loader.js`, `autobot-inbox/tools/registry.js` -- read `inbox.signals`
- `lib/runtime/flow-engine.js` -- reads `agent_graph.signals` for trigger matching
- `board/src/app/signals/page.tsx` -- reads `agent_graph.signals`
- `board/src/app/meetings/page.tsx` -- reads both via the meetings API

## References

- SPEC §12 (no cross-schema FKs)
- ADR-008 (channel-agnostic adapter contract -- `agent_graph.signals` is the adapter output target)
- ADR-013 (Unified Action Proposals -- analogous decision to consolidate at the *output* layer; this ADR refuses to do the same at the *input* layer because the abstraction levels differ)
- ADR-014 (Signal Taxonomy v2 -- defines the `inbox.signals` dimensional model that would be lost in a merge)
- Board session 2026-05-03: Liotta architectural read, Delphi UX read on the `/meetings` surface decision
