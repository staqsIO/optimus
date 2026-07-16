# LinkedIn Channel Analysis: Should We Build It?

**Date:** 2026-03-01
**Participants:** Eric (human), Claude (Liotta + Linus agents)
**Status:** Awaiting Dustin's review

---

## Context

We explored adding LinkedIn as a channel to AutoBot, specifically for Bennett — an IT recruiter running a small recruiting agency who uses LinkedIn Business Solutions. The question: how does LinkedIn fit alongside email and Slack as a managed channel?

## LinkedIn API Reality

LinkedIn's API is essentially a walled garden. Unlike Gmail (full read/write via OAuth) or Slack (Socket Mode gives you everything), LinkedIn locks the useful stuff behind partner programs designed for enterprise ATS vendors:

| What you'd want | API Available? | Access |
|---|---|---|
| Read/send messages | Write-only, partner-only | Closed to small devs |
| Read feed | No | `r_member_social` is **closed** |
| InMail | No API at all | Recruiter UI only |
| Connection requests | Partner-only | Closed to small devs |
| Post content | **Yes** | Self-service (`w_member_social`) |
| Sign in with LinkedIn | **Yes** | Self-service |
| Candidate search | No | Recruiter UI only |
| Sales Navigator sync | Partner-only | **SNAP paused indefinitely** (Aug 2025) |

The unofficial Voyager API exists but violates ToS and gets accounts banned.

## The Recruiting Workflow Gap

The current AutoBot architecture is **reactive** — email arrives → triage → draft response. A recruiter's workflow is **outbound-heavy**:

```
Source candidates → Outreach → Screen → Present to client → Interview → Place → Invoice
```

This is a fundamentally different motion than "keep inbox at zero."

## Three Approaches Considered

1. **LinkedIn-via-Email Bridge** — Parse LinkedIn notification emails that already land in Gmail (zero new API surface)
2. **Content + Outreach Copilot** — Use the self-service posting API + draft templates for manual copy-paste into LinkedIn
3. **Data Enrichment Layer** — Use third-party APIs (Apollo, Clearbit) to enrich contacts with LinkedIn data

## Agent Analysis

### Liotta (Contrarian Leverage / Strategy)

**Core thesis:** The 10x insight is not about LinkedIn at all. It's about the fundamental abstraction mismatch — the system has no concept of a workflow that starts from a user's goal rather than an inbound event.

**Key findings:**

1. **LinkedIn is not a channel in the adapter sense.** It's a signal source (via email notifications) and an action target (where humans execute agent-prepared templates). Forcing it into the `SENDERS` dispatcher pattern creates a leaky abstraction.

2. **The real abstraction should be:**
   - `SignalSource` — things that produce signals (Gmail, Slack, LinkedIn notifications, webhooks)
   - `ActionTarget` — things where actions get executed (Gmail drafts, Slack messages, clipboard/template)

3. **The recruiting use case is a constraint satisfaction problem.** Bennett has N open reqs (with skill/location/salary constraints) and M candidate signals. The naive approach is O(N×M) manual screening. The algorithmic solution is bipartite matching: "here are your top-3 matches per req, ranked by constraint satisfaction score."

4. **All three use cases (inbox management, recruiting, product outreach) are instances of the same abstract workflow:**
   ```
   [Signal Sources] → [Unified Contact Graph] → [Goal-Directed Planner] → [Action Proposals] → [Execution Channels]
   ```

5. **The existing task DAG can represent outbound workflows.** The `directive` work item type already exists in the schema but nothing creates them. A recruiting pipeline is just:
   ```
   directive: "Fill Senior DevOps role for Client X"
     workstream: "Source candidates"
       task: "Review LinkedIn notification: John Smith accepted connection"
       task: "Review inbound email from Jane Doe re: DevOps role"
     workstream: "Outreach"
       task: "Generate personalized outreach for top-3 candidates"
   ```

6. **Multi-principal support is the keystone.** Without a `principals` table and `principal_id` on contacts/messages/drafts, every feature for Bennett is a fork of Eric's pipeline.

### Linus (Architecture / Code Quality)

**Core thesis:** REJECT the LinkedIn integration as proposed. It is premature, architecturally misaligned, and would corrupt a clean system that currently does one thing well.

**Key findings:**

1. **The task graph cannot cleanly model outbound workflows.** Every agent downstream assumes the work item originates from an inbound message. The orchestrator polls for messages. Triage classifies inbound mail. The responder drafts replies to existing threads. None of this maps to "generate cold outreach from a candidate list." Outbound needs a separate pipeline with a separate orchestrator sharing the same DB and constitutional gates.

2. **The adapter abstraction is an honest lie for LinkedIn.** The sender dispatcher assumes the channel can at least send messages to recipients. LinkedIn can't. Adding `linkedin: { createDraft: null, send: null, readInbox: null }` is not an adapter — it's a lie with a single function hanging off it.

3. **The Gmail notification bridge is fragile.** LinkedIn changes email templates without notice. Users configure notification settings differently. Digest emails batch multiple events. If parsing fails, you lose the signal silently with zero observability.

4. **Constitutional gates need rethinking for outbound:**
   - G1 (financial ceiling): Still applies
   - G2 (commitment language): Critical for recruiting ("we'd love to offer you..." is a G2 violation)
   - G3 (voice tone match): Mostly irrelevant — InMail templates have their own conventions
   - G5 (draft-only/reversibility): **Breaks** — connection requests and InMails are irreversible
   - G6 (per-recipient rate limit): **Most critical** for cold outreach
   - G7 (pricing/timeline): Applies ("we typically offer $X-$Y range" is a G7 violation)

5. **Multi-user is the actual hard problem.** The schema has no `user_id` or `tenant_id`. Voice profiles, contacts, autonomy levels, and budgets are all global. Retrofitting tenant isolation is one of the hardest things you can do to a system.

### Where They Agree

- Don't build a LinkedIn adapter (walled garden, wrong abstraction)
- LinkedIn signal enrichment from notification emails is the right lightweight start
- Multi-principal support is the prerequisite for any second user
- Constitutional gates need per-principal configuration
- Start small, prove value with email-only pipeline first

### Where They Disagree

**Can the existing task graph handle outbound?**

- **Liotta:** Yes — the schema supports it, use the unused `directive` work item type
- **Linus:** No — the agent code is hardwired for reactive processing, build a separate outbound orchestrator

**Resolution:** The task graph schema *can* represent outbound workflows, but the agent code is oriented entirely around inbound stimulus. You'd need new agents (outbound orchestrator, sequencing agent), not new tables.

## Recommended Build Order

> **Note (2026-03-01):** Phase 2 revised per ADR-002 (decisions/002-individual-install-over-multi-tenant.md). Multi-principal schema replaced with individual-install model — each user gets their own AutoBot-Inbox instance. Multi-tenant deferred until three or more users create operational overhead that justifies the schema surgery.
>
> **Note (2026-03-01):** Phase 1.5 added and Phase 6 pulled forward per conversation/012-eric-linkedin-content-automation.md. Dustin's LinkedIn content automation validates the architecture generalization thesis and addresses co-founder burnout risk.

| Phase | What | Why | Size |
|---|---|---|---|
| **1** | Eric's inbox pipeline | Five-agent email pipeline with constitutional gates and voice system | In progress |
| **1.5** | Dustin's instance + content agent | Content orchestrator, generator, reviewer agents + LinkedIn posting API. Validates architecture generalization beyond reactive email. See 012-eric-linkedin-content-automation.md | ~680 LOC + migration |
| **2** | Repeatable install process | Clean setup (docs + script) so additional users can stand up their own instance (ADR-002) | Docs + setup script |
| **3** | LinkedIn signal enrichment | Post-triage parser for `@linkedin.com` emails, structured data in `signal.contacts` | ~200 LOC |
| **4** | Goal-directed work items | Allow creating `directive` work items via CLI/dashboard (open reqs for recruiting) | CLI + state-machine edits |
| **5** | Action proposals (issue #9) | Generalize drafts to outreach templates, candidate summaries, not just email replies | Schema + responder changes |
| **6** | Outbound pipeline | Separate orchestrator for campaign, sequence, step, send | New agent, significant |

## What NOT to Build

- LinkedIn API integration for messaging (walled garden, negative ROI)
- LinkedIn as a channel adapter (architectural lie)
- ATS integration (prove value with email-only first)
- Separate recruiting dashboard (same dashboard, principal-filtered views)
- Multi-tenant schema surgery for a single additional user (see ADR-002)

## Success Metrics (Define Before Building)

| Metric | Baseline | Target | Measurement |
|---|---|---|---|
| Time to first outreach after signal | ~24-48 hours (manual) | <2 hours | Signal ingestion → action_proposal timestamp delta |
| Signals missed | Unknown | <5% of actionable LinkedIn notifications | Audit: LinkedIn emails in Gmail vs. parsed signals |
| Pipeline reuse across principals | N/A | >80% shared agent code | LOC delta per new persona |
| Per-principal LLM cost | N/A | <$5/day for recruiting | G1 budget tracking per principal_id |
| Candidate-req matching accuracy | 0% automated | Top-3 contains placement 60%+ | Track placements vs. system recommendations |

## The One-Line Summary

**Don't build a LinkedIn integration. Build a multi-principal architecture with goal-directed work items, and LinkedIn signals fall out for free as a byproduct of emails you already receive.**

---

*Dustin: What's your read on the outbound pipeline question? Should the existing task graph stretch to cover goal-directed workflows, or does outbound deserve its own orchestrator? And does the multi-principal approach align with how you see Optimus scaling to multiple organizations?*
