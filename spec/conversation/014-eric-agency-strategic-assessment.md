# a recruiting agency Strategic Assessment

**Date:** 2026-03-06
**Author:** Eric
**Participants:** Eric (human), Claude (Liotta architecture review)
**Status:** Record -- strategic capture, no implementation proposed
**References:** SPEC.md v0.7.0, ADR-002 (individual install), ADR-008 (adapter pattern), ADR-014 (signal taxonomy v2), conversation/013 (workstream separation)

---

## Context

Eric had a discovery call with a recruiting agency -- a recruiting firm actively building agent-powered workflows. Team: [Agency Founder] (recruiter, building tools in Lovable), [Agency Partner A] (partner, company OS builder), [Agency Partner B] (partner), [Agency Ops Lead] (campaign operations, 8 agents running on Supabase + vector DB + Instantly).

This is a consulting opportunity, not a direct Optimus feature request. But the conversation stress-tested Optimus's architectural primitives against a real multi-user, multi-tool recruiting workflow. The question: **is Optimus building the right groundwork for the future these companies want to live in?**

---

## Synthesized Themes

### 1. Relationships as Platform

David's dream state: abstract everything away so the team just manages relationships. Bennett wants one-button follow-ups. They landed on "platform, not OS" -- provide the space, individuals bring their own style. This maps to P6 (familiar interfaces for humans) and the adapter pattern's philosophy of wrapping tools around existing workflows rather than replacing them.

### 2. Custodians, Not Completers

Eric's insight during the call: "We're becoming custodians -- reviewing and auditing rather than completing." The team already spends most of their time checking work, not doing work. This maps directly to Optimus's L0-L3 graduated autonomy model. The custodian role is what L1-L2 looks like in practice: agents do the work, humans review and approve.

### 3. Signal-Driven Work

Bennett's daily pain: checking Ashby, email, Slack, LinkedIn for updates, then deciding who needs follow-up. David wants daily briefings on pipeline health, relationship freshness, financial signals. This IS the signal architecture -- dimensional classification (type + direction + domain) with OWE/WAITING/CONNECT routing.

### 4. Multi-Source Convergence

Ryan has 8 campaign agents running across Supabase, vector DB, and Instantly. Bennett builds in Lovable. David and Asher built a company OS in Lovable. The candidate table is "where my side and Bennett's side meet." Four people, multiple tools, one shared entity graph. This is the multi-user problem ADR-002 explicitly deferred.

### 5. Progressive Autonomy

Ryan's campaign agents already have Slack approve/reject flows. They're organically moving from manual to approval-gated to autonomous -- without a formal framework. This validates graduated autonomy (G1-G7) as ahead of market. Most agent frameworks are binary (autonomous or HITL). Measurement-gated continuum is the moat.

### 6. Future-Proof vs Shiny Object

David: "avoid shiny object syndrome, build something the right way, three steps ahead." They've been burned by patchwork tool integrations that don't compose. This is P4 (boring infrastructure) stated as a business requirement by a customer.

### 7. Enrichment and Staleness

Candidates go stale in approximately 3 months. Ryan watches for LinkedIn profile update signals as freshness indicators. Fresh data matters more than comprehensive data. The signal architecture has no concept of data freshness or verification currency.

---

## Architectural Assessment

### Primitives That Are Right

**Task graph.** Bennett checking 5 tools for updates IS being a human task graph. The Optimus DAG with typed edges and atomic state transitions generalizes to recruiting pipelines without modification.

**Signal architecture (ADR-014).** OWE/WAITING/CONNECT maps directly to "one button, everybody I need to follow up with." Dimensional classification (type + direction + domain) scales to recruiting signals without new taxonomy.

**Adapter pattern (ADR-008).** Adding new sources (Ashby, Instantly, LinkedIn) is O(1) effort -- three methods per adapter (receive, normalize, acknowledge). The pattern was designed for this.

**Graduated autonomy (G1-G7).** Measurement-gated continuum is ahead of where the market is. Ryan's Slack approve/reject is ad-hoc L1. Optimus can offer this as a framework, not a one-off.

**Boring infrastructure (P4).** Supabase IS Postgres. pgvector handles Ryan's vector needs. No new infrastructure required. the agency's "shiny object syndrome" problem is exactly what P4 prevents.

### Critical Gap: Entity Resolution

`signal.contacts` is email-keyed -- one email address equals one contact. Real-world contacts have LinkedIn + email + phone + Ashby ID + Slack handle. Mike Maibach already has two rows in the autobot-inbox database from two email addresses.

For a recruiting firm with thousands of candidates across multiple systems, this flat model breaks immediately. The 10x leverage point is entity resolution -- the ability to say "these 5 identifiers are one person" and aggregate signals across all of them. Build it once, every future use case (recruiting, compliance, content, CRM) inherits it.

This is an architectural primitive, not a feature. It belongs at the schema level: a `contact_identities` table with (contact_id, channel, identifier, verified_at) and a merge/split operation that preserves signal history.

### Gap: Data Freshness

No `last_verified_at` or `verify_after` concept exists in the signal schema. Data silently rots. Ryan's LinkedIn signal watching is a workaround for this. A freshness dimension on contacts and signals would let agents prioritize outreach to contacts whose data is current.

### Gap: Multi-User Shared Entity Layer

ADR-002 isolates everything per instance. the agency needs 4 users sharing a candidate entity graph while running isolated agent pipelines. The entity graph should be shared; the agent graphs isolated. This is a schema-level distinction that ADR-002 doesn't address.

---

## Strategic Guidance

**Keep building product, extract platform retroactively.** autobot-inbox is use case #1, LinkedIn is #2, recruiting would be #3. Platform abstractions become obvious after 3 use cases, not before. Building a generic "agent platform" without 3 concrete use cases produces Kubernetes-for-agents -- powerful and unusable.

**The best platform looks like a product to its users.** Don't build an SDK or plugin system. The platform IS the schema + adapter interface + gate framework. If the abstractions are right, adding a recruiting vertical is configuration, not code.

**Rename email-specific columns** when building entity graph. `emails_received` becomes `interactions_inbound`. `email` column on contacts becomes one row in a `contact_identities` table. Do this during the entity resolution work, not as a separate migration.

---

## Board Questions Raised

1. **Entity resolution timing.** Should this be a Phase 1.5 primitive (build before recruiting engagement) or Phase 2 (build when the third use case demands it)?

2. **ADR-002 evolution.** The individual-install model needs a shared entity layer for multi-user deployments. Is this a revision to ADR-002 or a new ADR?

3. **the agency engagement scope.** Consulting engagement to help them architect their existing tools, or a pilot deployment of Optimus primitives in their stack? Different answers, different commitments.

4. **Data freshness as a first-class concept.** Should `verified_at` / `stale_after` be part of the signal schema, or is this a per-product concern?
