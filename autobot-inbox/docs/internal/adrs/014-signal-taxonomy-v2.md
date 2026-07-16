---
title: "ADR-014: Signal Taxonomy v2 -- Dimensional Classification"
description: "Replace flat signal/contact taxonomies with dimensional classification (type + direction + domain) to enable accountability-oriented dashboard and automated contact classification"
---

# ADR-014: Signal Taxonomy v2 -- Dimensional Classification

**Date**: 2026-03-02
**Status**: Accepted

## Context

The current signal extraction system uses 7 flat signal types (commitment, deadline, action_item, question, decision, introduction, request) and 7 flat contact types (team, investor, customer, partner, vendor, recruiter, unknown). These were original schema design decisions (migrations 002, 004) that have never been validated against real usage, competitive research, or agent review.

Research against best-in-class products (Superhuman, Claryti, Shortwave, Gmail Gemini, Microsoft Viva) and review by Liotta and Linus agents identified three problems:

1. **Signal types lack directionality.** "commitment" doesn't distinguish who committed to whom. Claryti and Microsoft Research show that bidirectional commitment tracking (what you owe vs what's owed to you) is the highest-value signal feature. Without it, the dashboard is a chronological feed instead of an accountability ledger.

2. **Contact types are never populated.** Every contact is 'unknown'. The schema has 7 types but no classification logic. Expanding types without classification is dead schema.

3. **The dashboard is system-centric.** Daily briefing shows pipeline stats and cost instead of actionable sections (what do I owe, what am I waiting for, which relationships are going cold).

## Decision

Adopt a dimensional signal classification model: orthogonal type, direction, and domain axes instead of a flat taxonomy expansion.

### Signal Types: 7 to 9 (net +2)

Keep: commitment, deadline, question, decision, introduction.
Add: approval_needed (explicit sign-off requests), info (worth knowing, no action required).
Rename: action_item absorbed into request (action_item kept as DB alias for backward compatibility).

Rejected alternatives:
- 18 flat types (commitment_made, commitment_received, follow_up, scheduling, invoice, payment, contract, referral, sentiment_shift, waiting_on) -- Liotta and Linus both rejected this. Adjacent-category confusion in Haiku degrades extraction accuracy. Most proposed additions are better represented as dimensions or computed states.
- follow_up -- computed from direction:outbound + resolved:false + age > N days
- scheduling -- request with domain:scheduling
- waiting_on -- computed from direction:outbound + resolved:false
- invoice/payment/contract -- commitment/request with domain:financial or domain:legal
- sentiment_shift -- requires multi-message analysis, not single-email extraction
- referral -- semantically identical to introduction for "what should I do" purposes

### New Dimension: direction (who owes whom)

Values: inbound (someone expects something from you), outbound (you expect something from someone), both (mutual obligation). Default: inbound.

This is the core architectural insight. Direction as a binary/ternary classification is dramatically more accurate for Haiku than splitting types. Liotta's analysis: ~2.4x better accuracy on commitment directionality vs type-splitting approach.

Existing commitment rows get NULL direction (not backfilled -- original extraction didn't track this). New extractions populate direction. Clean migration path.

### New Dimension: domain (what world)

Values: general (default), financial (invoices, payments, budgets, pricing), legal (contracts, NDAs, terms, compliance), scheduling (meetings, availability, calendar).

This replaces the rejected invoice/payment/contract signal types. A commitment with domain:financial is more accurate than a separate invoice type because the LLM classifies two simple questions (is this a commitment? is it financial?) rather than one complex question (is this an invoice vs payment vs contract vs commitment?).

Domain feeds into topic extraction and context enrichment downstream.

### Contact Types: 7 to 15

Add: cofounder, board, advisor, prospect, legal, accountant, service (automated senders), newsletter.
Keep: team, investor, customer, partner, vendor, recruiter, unknown.

Ship alongside auto-classification logic -- types without classification are dead schema. Classification approach:
- Deterministic rules first (noreply -> service, user's org domain -> team, send-only with no replies -> newsletter)
- Interaction pattern heuristics (bidirectional + high-frequency -> inner circle candidates)
- Manual override via dashboard (user sets type, persists)

### New: relationship_strength as a SQL view

Computed from existing signal.contacts data: recency (exponential decay, 14-day half-life), frequency (emails_received + emails_sent), directionality bonus (bidirectional > one-way). Implemented as a Postgres view, not a stored column or cron job. Always fresh, zero maintenance.

### Strategist Role

Strategist (Sonnet/Opus) enriches signals on action_required and needs_response emails only:
- Confidence refinement on direction classification
- Cross-email pattern detection (repeated follow-ups = escalation)
- Thread-history-aware waiting_on computation
- Does NOT run on fyi/noise (majority of emails) -- cost stays low

### Dashboard: OWE / WAITING / CONNECT

New /today route with three sections:
- OWE: signals where direction=inbound, sorted by urgency (overdue -> due_date ASC -> priority DESC)
- WAITING: signals where direction=outbound, sorted by age (oldest first)
- CONNECT: contacts with decaying relationship_strength, sorted ascending (coldest first)

Existing /signals page stays unchanged. New route ships as a separate increment.

PREP section (calendar-aware meeting context) deferred until Google Calendar integration lands.

### Shipping Strategy (3 increments)

1. Migration 030: Contact type expansion + relationship_strength view + auto-classification logic + priority-scorer update
2. Migration 031: Signal type expansion + direction/domain columns + triage prompt update + application-layer validation + Strategist enrichment wiring
3. Separate PR: Dashboard OWE/WAITING/CONNECT route

Each increment is independently testable and revertable.

## Alternatives Considered

| Alternative | Pros | Cons | Why Rejected |
|-------------|------|------|--------------|
| 18 flat signal types | Explicit names for every signal variant; no ambiguity | Adjacent-category confusion degrades Haiku accuracy; 2.4x worse on directionality vs dimensional approach; most types are better as computed states | LLM accuracy is the binding constraint -- simpler classification with dimensions wins |
| Expand contact types without classification logic | Quick schema change; no runtime work | Every contact stays 'unknown'; dead schema (current state proves this) | Types without classification logic have zero value |
| Backfill direction on existing signals | Complete historical data | Original extraction didn't capture this; backfill would require re-processing every email through LLM | Cost-prohibitive; NULL direction for historical rows is acceptable |
| Materialized view for relationship_strength | Faster queries on large datasets | Refresh scheduling adds maintenance burden; stale data between refreshes | Plain view is sufficient at current scale (<500 contacts); promote to materialized view if needed |
| Ship dashboard first, schema later | Faster user-visible impact | Dashboard would show the same chronological feed with different styling; value comes from the data model, not the UI | The dimensional model IS the feature; UI is the presentation layer |

## Consequences

**Positive:**
- Signal feed becomes an accountability ledger (what you owe vs what's owed to you)
- Contact classification goes from 0% to >70% automated
- Dashboard answers "what should I do today?" in 30 seconds
- Haiku extraction accuracy maintained (9 types + 2 simple dimensions vs 18 flat types)
- Domain column enables future topic/context enrichment
- Strategist adds quality layer without adding cost on low-value emails

**Negative:**
- Existing commitment signals have NULL direction (no backfill possible)
- Dashboard has two signal views during transition (/signals and /today)
- Contact auto-classification heuristics need tuning after deployment
- Priority scorer needs rebalancing with 15 contact types (board decision on relative weights)

**Neutral:**
- Signal type count increases modestly (7 to 9) -- well within Haiku's classification range
- action_item remains as a DB alias; no breaking change for existing queries
- relationship_strength view has no write-side cost; read cost is trivial at current scale

## Risks

- Haiku direction classification accuracy -- mitigate by defaulting to inbound (more actionable) and measuring after 100 emails
- Dashboard layout regression -- mitigate by shipping as new route, keeping existing page
- relationship_strength computation on large contact sets -- trivial at current scale (<500 contacts), promote to materialized view if needed

## Affected Files

- `sql/030-contact-classification.sql` -- New migration: contact type expansion, relationship_strength view, auto-classification function
- `sql/031-signal-taxonomy-v2.sql` -- New migration: signal type expansion, direction/domain columns, application-layer validation
- `src/signal/` -- Signal extraction prompt updates, direction/domain classification
- `src/agents/strategist.js` -- Enrichment logic for direction confidence and cross-email patterns
- `config/agents.json` -- Strategist routing updates for enrichment triggers
- `dashboard/` -- New /today route (OWE/WAITING/CONNECT), separate PR

## Cross-Project Impact

- **Root `CLAUDE.md`** -- Migration range updated when migrations ship.
- **`autobot-spec`** -- No spec changes needed. Dimensional classification implements the spec's signal extraction model more precisely than flat types did.
- **Dashboard (autobot-inbox)** -- New /today route adds a page; existing /signals route unchanged.

## References

- Liotta agent review (2026-03-02): dimensional classification, OWE/WAITING/CONNECT model
- Linus agent review (2026-03-02): incremental shipping, application-layer validation, SQL view for strength
- Competitive research: Claryti (commitment tracking), Superhuman (waiting_on), Microsoft Research (bidirectional commitment detection), Introhive/Affinity (relationship strength scoring)
- conversation/013-eric-workstream-separation.md (v1.0 exit criteria)
