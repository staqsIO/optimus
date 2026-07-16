# 020 — Repo Realignment: SPEC Hierarchy Extraction

**Author:** Eric
**Date:** 2026-03-30
**Type:** Architecture Decision

---

## Context

autobot-inbox grew beyond its original scope. What started as a Gmail-only email management product accumulated org-level infrastructure (task graph, agent runtime, adapters, guardrails, RAG pipeline) inside its `src/` directory. Agents were hardcoded to Gmail-specific tool names and capabilities. The README described Optimus as an inbox tool rather than a governed agent organization.

The SPEC (v1.0.0) defines Optimus as a multi-product agent organization with 6 agent tiers, a Communication Gateway, and channel-agnostic I/O. The implementation needed to catch up to the architecture.

Additionally, the SPEC defined only 6 base tiers but the running system had 18 agents including claw agents (workshop, campaigner, explorer), nemoclaw external agents, and specialized executors (blueprint, redesign, research) — none documented in the SPEC.

## Decision

Three board decisions made (2026-03-30):

1. **Extract org infrastructure to `lib/` at repo root.** Runtime, adapters, graph, audit, LLM, comms, RAG, and db.js moved from `autobot-inbox/src/` to `lib/`. Re-export shims at original locations ensure zero-breakage migration. `lib/` has its own `package.json` with shared dependencies.

2. **Update SPEC to document all running agents.** Rather than pruning agents to match the SPEC's 6-tier model, we extended the SPEC to match reality. Added:
   - External tier (nemoclaw instances — board member agents with API-only access)
   - Sub-tier system within each base tier (e.g., Orchestrator/workshop, Executor/engineering)
   - Every agent in `agents.json` now has `tier` and `subTier` fields

3. **Genericize agent tool/capability names.** Gmail-specific names replaced with channel-agnostic equivalents:
   - `gmail_poll` → `channel_poll`
   - `gmail_fetch` → `message_fetch`
   - `draft_create` → `proposal_create`
   - Capabilities like `gmail-api` → `channel-polling`

## Implementation

Executed in 4 atomic commits:

1. `ee70090` — 80 files extracted from `autobot-inbox/src/` to `lib/` with re-export shims
2. `205cca8` — All 18 agents mapped to SPEC tiers, tool names genericized
3. `49dca36` — README rewritten to describe Optimus as governed agent org
4. `8f85dc1` — Both CLAUDE.md files updated for new structure

## SPEC Changes

- Version bump: v1.0.0 → v1.1.0
- Section 2 (Agent Tiers): Added External tier row, added Sub-Tier Extensions table
- Sub-tiers are implementation-defined and do not alter parent tier security constraints

## What This Does NOT Change

- No agent handler code was modified (only config and docs)
- No database schema changes
- No runtime behavior changes — shims ensure identical import resolution
- Production Railway deployment is unaffected (autobot-inbox entry point unchanged)

## Next Steps

- Phase B2-B4: Refactor agent handlers to use `context.message` instead of `context.email`
- Phase D: Formalize Communication Gateway inbound pipeline per SPEC S7
- Docker/compose updates for new `lib/` directory
- Dustin review of SPEC v1.1.0 amendments
