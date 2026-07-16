---
title: "Contracts module — internal UMB tool on top of the signatures substrate"
status: Accepted
date: 2026-04-22
authors: [Carlos]
spec_refs: ["P1 (Deny by default)", "P2 (Infrastructure enforces)", "P3 (Transparency by structure)", "P4 (Boring infrastructure)"]
---

# ADR-024: Contracts module

## Context

`/contracts` started as a thin list+edit view over `content.drafts` filtered to `content_type = 'contract'`, coupled to the `signatures.*` schema (migration 054) for hash-chained e-signature. Over the Phase 1–4 + round-2 build-outs it grew into a full internal contracting product for UMB Advisors:

- Identity: `content.counterparties` (migration 065) replaces free-text client names in `seo_metadata`.
- Versioning: `content.draft_versions` (062) captures every AI/manual/revert/counter-proposal edit with hash-dedup.
- Tamper resistance: `signatures.compute_document_hash()` (063) covers body + attachments; hash_version grandfathers pre-063 anchors.
- Provenance: `content.draft_versions.rag_chunks` (068) records which emails/meetings/KB chunks fed each AI edit.
- Governance: `lib/contracts/pre-send-check.js` runs G2/G7 at send time; `content.send_overrides` (071) logs block-severity overrides immutably.
- Negotiation: `signatures.signer_proposals` (067) + `signatures.proposal_replies` (072) for structured redlines and reply threads.
- Execution linkage: `agent_graph.work_items` spawned on signed via `lib/contracts/spawn-work-items.js` (069), with idempotent claim via `work_items_spawned_at`.
- Flow hook: `agent_graph.signals` emits `contract_signed` after spawn so flow definitions can react downstream.

## Decision

Keep the module internal-UMB-scoped — no tenancy column, no multi-org, no public verify surface — and structure it as a set of small lib modules under `lib/contracts/` with Postgres as the source of truth:

- `lib/contracts/pdf-render.js` — shared Chromium renderer; PDF embedded audit trail
- `lib/contracts/pre-send-check.js` — LLM-backed G2/G7 scan
- `lib/contracts/spawn-work-items.js` — signed → work_items + signal emit
- `lib/contracts/redline-reconcile.js` — fuzzy reconcile fallback
- `lib/signatures/sweeper.js` — expiry + sequential-aware reminders

No new framework, no new message queue. All coordination via Postgres: task graph for work items, signals table for flow hooks, immutability triggers for audit tables, RLS policies on every new table. P4 maintained.

### Non-goals / deferred

- **Multi-tenancy.** The internal-UMB scope was explicit. If we ever want this as a product, every new table (counterparties, send_overrides, draft_versions, signer_proposals, proposal_replies) needs a tenancy column and the RLS policies rewritten.
- **Agent auto-assignment of spawned work_items.** The orchestrator could pick these up automatically; today they're unassigned for board triage. Intentional — wiring an agent to consume contract-signed deliverables needs a governance conversation first.
- **Full flow engine integration (path b from item-9 discussion).** We emit `contract_signed` signals but don't ship a default `contract_signed` flow. The signal is additive; direct work_items creation stays authoritative.
- **Public `/verify` page.** The board-only `/verify/<contractId>` page works; a public variant needs a fresh API with redacted signer metadata and an explicit tenancy check.

## Consequences

- Operators can run the full contract lifecycle without engineering involvement — create, edit via AI with RAG provenance, send, see signer proposals + reply, accept with fuzzy reconcile, auto-resend, download stamped PDF, verify chain.
- The signed contract is now the authority token for the agent task graph: the deliverables it obligates UMB to produce become work items in `agent_graph.work_items`, linked back via metadata. This is the P3 "transparency by structure" payoff — no separate system to reconcile.
- `content.send_overrides` gives counsel a single-query answer to "why did this go out despite the flagged issues": `SELECT * FROM content.send_overrides WHERE draft_id = $1`.
- Costs: every AI edit, every pre-send check, every spawn LLM call is billed to Haiku. Pre-send runs automatically when the Send form opens; worth watching in the LLM cost dashboard after real traffic.
- The Playwright/Chromium dependency needs to be present on Railway for PDF export. If the deploy environment strips Chromium, PDF attachment silently fails to the confirmation email (the email still sends without the PDF).

## References

- Migrations 062–073 (autobot-inbox/sql/)
- `/board/src/app/contracts/`, `/board/src/app/sign/[token]/`, `/board/src/app/verify/[contractId]/`, `/board/src/app/counterparties/[id]/`, `/board/src/app/contracts/templates/`
- `lib/contracts/*.js`, `lib/signatures/*.js`
