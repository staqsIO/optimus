# ADR-020: Unified Multi-Business Organization

**Status:** Accepted
**Date:** 2026-03-16
**Supersedes:** ADR-002 (Individual Install per User) — for governance testing context
**Authors:** Eric, Dustin (Board)

## Context

Optimus is scaling from 1 test inbox to 5 different people's businesses with several hundred work items/month. ADR-002 prescribed individual installs per user, but the governance thesis requires proving that one agent organization can manage multiple businesses — learning cross-business patterns, sharing contact intelligence, and enforcing unified constitutional gates.

This is not multi-tenant SaaS. There are no access control boundaries between accounts. The board sees everything. Agents are shared resources. The only hard boundaries are voice profiles (each business owner writes differently) and budget ceilings (prevent one business from consuming all resources).

## Decision

One Optimus instance governs N businesses as a unified organization. `account_id` is provenance tagging, not tenant isolation.

### Schema Changes (008-multi-account.sql)

Add nullable `account_id` columns to:
- `agent_graph.work_items` — task provenance
- `agent_graph.budgets` — per-account budget ceilings
- `agent_graph.llm_invocations` — cost attribution
- `agent_graph.action_proposals` — draft ownership
- `voice.profiles` — per-account voice (hard boundary)
- `voice.sent_emails` — voice training data scoping
- `signal.contacts` — `source_account_id` (provenance, not isolation)
- `signal.briefings` — per-account + org-wide digests

New table: `signal.contact_accounts` — junction table tracking which accounts have interacted with which contacts.

### Budget Functions

`reserve_budget()`, `commit_budget()`, `release_budget()` accept optional `p_account_id`. Global ceiling (NULL account_id) is always checked. Per-account ceiling checked additionally when account budget row exists.

### Voice Isolation

Voice profiles are the only hard boundary. Each business owner has a different writing style. `buildGlobalProfile(accountId)`, `buildRecipientProfiles(accountId)`, `getProfile(email, accountId)`, and `selectFewShots({accountId})` all scope to the originating account.

### What Stays Shared (by design)

- Agent configs, permissions, tool registry — agents serve all accounts
- State machine, audit trail — governance is org-wide
- Contacts — shared with provenance tagging, not siloed
- Neo4j knowledge graph — cross-account patterns are a feature
- Constitutional gates G1-G7 — uniform governance (G1 gets account-aware budget)

## Consequences

- **Positive:** Cross-business learning, unified governance visibility, contact entity resolution across accounts, single operational surface for the board
- **Positive:** Backward compatible — NULL account_id = legacy behavior, no breaking changes
- **Negative:** Voice profile rebuild now iterates per account (linear scaling)
- **Risk:** Dashboard needs account selector UX to avoid information overload at 5+ accounts
- **Migration:** ADR-002 remains valid for future external users; this decision is specific to the governance testing phase where one board oversees multiple businesses
