---
title: "ADR-009: Config-Driven Agent Selection"
description: "Agent instantiation driven by config/agents.json rather than hardcoded imports in src/index.js"
---

# ADR-009: Config-Driven Agent Selection

**Date**: 2026-03-01
**Status**: Accepted
**Spec Reference**: ADR-002 (individual install over multi-tenant), SPEC.md -- per-instance configuration

## Context

`src/index.js` hardcoded imports and instantiation of all six agents. Every installation ran the identical agent set. This blocked ADR-002 (individual install) because different users need different agent subsets:

- Eric's inbox instance needs the full email pipeline (orchestrator, triage, responder, reviewer, strategist, architect)
- Dustin's LinkedIn instance (Phase 1.5) needs content-generation agents, not the email pipeline
- Future instances may mix channels or skip expensive agents (strategist) to stay under budget

Hardcoded imports also meant adding a new agent required modifying `src/index.js`, increasing merge conflicts when multiple contributors work on different agents.

## Decision

Agent configuration is defined in `config/agents.json`. The runtime reads this file at startup and instantiates only agents with `"enabled": true`. Each agent entry specifies:

- `id`, `type` -- agent identity
- `enabled` -- whether to instantiate at startup
- `model`, `maxTokens`, `temperature` -- LLM configuration
- `tools` -- allowed tool list
- `guardrails` -- constitutional gates applied
- `hierarchy` -- delegation, reporting, and escalation relationships
- `schedule`, `scheduleTime` -- for scheduled agents (architect)
- `skipFor` -- categories to skip (strategist skips fyi/noise)
- `mode` -- operational mode (strategist: suggest)

The runtime dynamically imports agent handler modules based on the `type` field. No hardcoded agent imports remain in `src/index.js`.

## Alternatives Considered

| Alternative | Pros | Cons | Why Rejected |
|-------------|------|------|-------------|
| Environment variable flags (ENABLE_STRATEGIST=true) | Simple; no new files | Doesn't capture model/tools/guardrails; .env bloat with 6+ agents x 5+ fields each | Insufficient expressiveness |
| Plugin directory (drop agent files into plugins/) | Very extensible | Implicit configuration; hard to validate at startup; agents need explicit ordering | Over-engineering for a known, finite agent set |
| Database-driven config (agent_configs table) | Already exists for config hashing | Requires DB connection before agent startup; chicken-and-egg with migrations | Runtime should boot before DB is available for config |

## Consequences

### Positive
- Different installations can run different agent subsets by editing one JSON file
- Adding a new agent type does not require modifying `src/index.js`
- Agent configuration is declarative and version-controlled
- Config changes are tracked via `agent_config_history` table (existing infrastructure)

### Negative
- Config file must be kept in sync with available agent handler modules -- a typo in `type` causes a runtime error at startup
- Harder to see at a glance which agents run without reading the JSON file (previously obvious from imports)

### Neutral
- `config/agents.json` also stores model pricing info for budget calculations, consolidating LLM configuration in one place

## Affected Files

- `config/agents.json` -- agent configuration (new file)
- `src/index.js` -- replaced hardcoded imports with config-driven instantiation
