---
title: "ADR-008: Adapter Pattern for Multi-Channel Support"
description: "Introduced InputAdapter/OutputAdapter interfaces to decouple agents from Gmail-specific I/O"
---

# ADR-008: Adapter Pattern for Multi-Channel Support

**Date**: 2026-03-01
**Status**: Accepted
**Spec Reference**: SPEC.md -- P6 (familiar interfaces for humans), multi-channel pipeline

## Context

The agent pipeline was tightly coupled to Gmail. Every agent that needed message content called `fetchEmailBody()` directly, and the responder agent called Gmail-specific draft/send functions. This coupling meant adding a second channel (Slack) would require modifying every agent handler -- a violation of the open/closed principle and a maintenance hazard as more channels are added (LinkedIn content in Phase 1.5, recruiting pipeline in Phase 3+).

The triage agent's prompt also contained email-specific framing ("untrusted_email" tags, email-specific classification hints) that would be misleading for Slack messages.

## Decision

Introduce two adapter interfaces in `src/adapters/`:

- **InputAdapter** (`input-adapter.js`) -- `channel`, `fetchContent(message)`, `buildPromptContext(message, body)`. Returns a `PromptContext` with channel-aware content labels, sender info, threading, and channel-specific prompt hints.
- **OutputAdapter** (`output-adapter.js`) -- `channel`, `createDraft(draftId)`, `executeDraft(draftId)`. Abstracts platform-specific draft creation and sending.

Two concrete adapters implement both interfaces:

- `email-adapter.js` -- wraps `gmail/client.js` and `gmail/sender.js`
- `slack-adapter.js` -- wraps `slack/sender.js`; input is inline since Slack stores full text at ingestion

Adapters are validated at startup using `validateInputAdapter()` and `validateOutputAdapter()`. Agent handlers receive a `PromptContext` from the adapter and never import Gmail modules directly.

## Alternatives Considered

| Alternative | Pros | Cons | Why Rejected |
|-------------|------|------|-------------|
| Modify agent handlers per channel (if/else) | No new abstraction | Every agent gains channel-specific branches; grows linearly with channels | Violates open/closed principle; maintenance hazard |
| Strategy pattern (one class per channel per agent) | Full isolation per agent+channel | Class explosion (agents x channels); most agents need identical logic | Over-engineering for thin I/O differences |
| Middleware/plugin system | Very flexible | Too much infrastructure for 2-3 channels; violates P4 (boring infrastructure) | Complexity not justified by current scale |

## Consequences

### Positive
- Agents are channel-agnostic -- adding a new channel requires only a new adapter, not agent modifications
- Prompt injection defense is channel-appropriate (`untrusted_email` vs `untrusted_message` tags)
- Slack adapter provides channel-specific classification hints (bias toward "needs_response" for DMs)
- Testable: adapters accept dependency injection for unit testing

### Negative
- One more layer of indirection between agents and I/O
- Adapter interface changes require updating all concrete adapters

### Neutral
- Existing Gmail modules (`gmail/client.js`, `gmail/sender.js`) are preserved unchanged; adapters wrap them

## Affected Files

- `src/adapters/input-adapter.js` -- InputAdapter interface and validator
- `src/adapters/output-adapter.js` -- OutputAdapter interface and validator
- `src/adapters/email-adapter.js` -- Email adapter wrapping Gmail modules
- `src/adapters/outlook-adapter.js` -- Outlook adapter wrapping Outlook modules
- `src/adapters/slack-adapter.js` -- Slack adapter wrapping Slack modules
- `src/adapters/registry.js` -- Singleton adapter registry (provider -> adapter Map)
- `src/runtime/context-loader.js` -- Resolves adapter via registry, centralizes body fetching
- `src/agents/executor-triage.js` -- Removed direct `fetchEmailBody` import; uses context.emailBody
- `src/agents/executor-responder.js` -- Removed direct `fetchEmailBody` import; uses context.emailBody
- `src/agents/strategist.js` -- Removed direct `fetchEmailBody` import; uses context.emailBody
- `src/index.js` -- Registers gmail, outlook, slack adapters at startup
- `test/adapter-registry.test.js` -- 12 test cases covering registry API surface

---

## Addendum: Pipeline Wiring Complete (2026-03-01)

The original ADR introduced adapter interfaces and two concrete adapters. Pipeline wiring -- connecting adapters to the live agent runtime so agents are fully decoupled from provider-specific imports -- shipped in a follow-up:

1. **Adapter Registry** (`src/adapters/registry.js`): A singleton `Map` from provider key (`'gmail'`, `'outlook'`, `'slack'`) to adapter instance. Validates InputAdapter interface on registration. Registered at startup in `src/index.js`.

2. **Centralized body fetching** (`src/runtime/context-loader.js`): Resolves the adapter for each message via `getAdapterForMessage()` (keyed on `message.provider`, defaulting to `'gmail'`). Calls `adapter.fetchContent()` and `adapter.buildPromptContext()` to populate `context.emailBody` and `context.promptContext` for all context tiers (Q1-Q4). Falls back to `null` when no adapter is registered (test environments).

3. **Agent decoupling**: `executor-triage.js`, `executor-responder.js`, and `strategist.js` no longer import `fetchEmailBody` from `gmail/client.js`. They consume `context.emailBody` and `context.promptContext` provided by context-loader. This also fixed a bug in strategist where `fetchEmailBody()` was called without the required `account_id` argument.

4. **Third adapter**: `outlook-adapter.js` added, wrapping `outlook/client.js` and `outlook/sender.js`. Channel is `'email'` (same medium as Gmail), provider is `'outlook'`.
