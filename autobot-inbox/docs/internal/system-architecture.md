---
title: "System Architecture"
description: "Overall system topology, service components, and environment setup for autobot-inbox"
---

# System Architecture

## Overview

autobot-inbox is a governed AI inbox management system. Six Claude-powered agents process inbound email through a Postgres task graph with no framework, no message queue, and no ORM. The system enforces seven constitutional gates at the infrastructure layer and tracks all state transitions in an append-only, hash-chained audit log.

Spec lineage: autobot-spec v0.7.0.

## System Topology

```
              Gmail API    Outlook API    Slack API
                  |             |             |
           (poll 60s)    (poll 60s)    (event-driven)
                  |             |             |
                  +------+------+------+------+
                         |             |
                  +------v------+      |
                  |  Adapter    |<-----+
                  |  Registry   |
                  +------+------+
                         |
                    +----v-----------+
                    |   Orchestrator  |  Sonnet
                    |  (poller       |
                    |   + router)     |
                    +--------+--------+
                             |
              +--------------+--------------+
              |                             |
     +--------v--------+          +--------v--------+
     | Executor-Triage  |  Haiku  |    Strategist   |  Opus
     | (classify email) |         | (priority/strat)|
     +--------+---------+         +--------+---------+
              |                             |
              +-------------+---------------+
                            |
                   +--------v--------+
                   |Executor-Responder| Haiku
                   | (draft reply)   |
                   +--------+--------+
                            |
                   +--------v--------+
                   |    Reviewer     |  Sonnet
                   | (gate checks)  |
                   +--------+--------+
                            |
                   +--------v--------+
                   |   Board (Human) |
                   | (approve/edit)  |
                   +-----------------+
                            |
                    CLI / Dashboard / Electron

    +-------------------+
    |    Architect       | Sonnet (daily schedule)
    | (briefings/audit)  |
    +-------------------+

    +-------------------+
    |    Reaper          | (system process, no LLM)
    | (stuck task recovery) |
    +-------------------+

         All agents
            |
     +------v------+
     |  Postgres    |  Supabase (prod) / PGlite (dev)
     |  5 schemas   |
     +-------------+
```

## Service Components

### Channel Adapters (`src/adapters/`)

Channel-specific I/O is abstracted behind two interfaces defined in `src/adapters/`:

- **InputAdapter** (`input-adapter.js`) — `fetchContent()` retrieves message body, `buildPromptContext()` builds structured context for agent prompts
- **OutputAdapter** (`output-adapter.js`) — `createDraft()` creates a platform draft, `executeDraft()` sends an approved draft

Three adapters are implemented:

| Adapter | Provider | Channel | Input | Output |
|---------|----------|---------|-------|--------|
| `email-adapter.js` | `gmail` | Email | Fetches body from Gmail API on-demand (D1) | Creates Gmail draft, sends via Gmail |
| `outlook-adapter.js` | `outlook` | Email | Fetches body from Outlook API on-demand (D1) | Creates Outlook draft, sends via Outlook |
| `slack-adapter.js` | `slack` | Slack | Body stored at ingestion (no API call) | Sends via Slack API (no draft concept) |

#### Adapter Registry (`registry.js`)

A singleton `Map` from provider string to adapter instance. Registered at startup in `src/index.js`:

```js
registerAdapter('gmail', createEmailAdapter());
registerAdapter('outlook', createOutlookAdapter());
registerAdapter('slack', createSlackAdapter());
```

The registry validates each adapter against the InputAdapter interface on registration. At runtime, `context-loader.js` resolves the correct adapter via `getAdapterForMessage(message)` (keyed on `message.provider`, defaulting to `'gmail'`), then calls `fetchContent()` and `buildPromptContext()` to assemble the context object. This centralizes all provider-specific body fetching in one place — individual agent handlers never import Gmail, Outlook, or Slack modules for content retrieval.

Falls back gracefully when no adapter is registered (e.g., in unit tests without the registry initialized).

Source: `src/adapters/`

### Agent Runtime (`npm start`)

The core process. A pure Node.js event loop with no HTTP server. Each of the six agents runs as an `AgentLoop` instance that:

1. Checks the halt signal (fail-closed)
2. Atomically claims a task from `task_events` using `SELECT ... FOR UPDATE SKIP LOCKED`
3. Runs guard checks within the same transaction
4. Transitions the work item to `in_progress`
5. Loads tiered context via `context-loader.js` (which resolves the adapter from the registry and fetches body + prompt context) and calls the Anthropic API (120s timeout via AbortController)
6. Runs post-execution checks
7. Transitions to `completed` or `failed`
8. Sleeps until a pg_notify/EventEmitter wake-up or 10s max idle

No Express. No Koa. No framework at all. The agent runtime is the event loop.

Source: `src/runtime/agent-loop.js`, `src/index.js`

### Tool Execution (`tools/registry.js`)

Agents interact with the system (Gmail, task graph, voice, signals) through a centralized tool registry. Tool execution is governed by four enforcement layers, implementing P1 (deny by default) and P2 (infrastructure enforces):

| Layer | Check | Failure |
|-------|-------|---------|
| 1. Config allow-list | Tool must be in `agentConfig.tools_allowed` | `Error: Agent X not authorized for tool Y` |
| 2. DB permission check | `agent_graph.tool_registry.allowed_agents` must include agent | `Error: Agent X not in tool_registry.allowed_agents for Y` |
| 3. Per-tool timeout | `Promise.race` with tool-specific timeout (10s-120s) | `Error: Tool Y timed out after Nms` |
| 4. Audit trail | Fire-and-forget INSERT to `agent_graph.tool_invocations` | Non-blocking (audit failures never affect execution) |

Each tool declares its `capabilities` (which schemas it touches, whether it needs network access). Tool integrity is verified at startup via SHA-256 hash comparison against `agent_graph.tool_registry.tool_hash` (see `src/runtime/infrastructure.js`).

Source: `tools/registry.js`, `src/runtime/infrastructure.js`

### Gmail Poller

Runs inside the agent runtime process as a `setInterval` (60s default). Calls the Gmail API, inserts email metadata into `inbox.emails` (never stores the body -- design decision D1), creates top-level work items, and assigns them to the orchestrator.

Source: `src/agents/orchestrator.js` (`startPolling`), `src/gmail/poller.js`

### Reaper

A `setInterval` (60s) that detects stuck tasks. Finds work items in `in_progress` for longer than 5 minutes and transitions them to `timed_out`. Retries up to 3 times, then transitions to `failed`. Also reclaims orphaned budget reservations from crashed agents.

Source: `src/runtime/reaper.js`

### CLI (`npm run cli`)

A readline REPL for the human board (Eric). Supports: inbox review, draft approval/editing, halt/resume, stats, briefing display. No web server -- runs in the terminal.

Source: `src/cli/index.js`

### Dashboard (`cd dashboard && npm run dev`)

A Next.js 15 application that provides a web interface for signal visualization, draft review, and pipeline monitoring. Runs as a separate package on port 3100.

Source: `dashboard/`

### Electron App (`npm run electron`)

A desktop wrapper around the dashboard and CLI. Provides system tray notifications for drafts awaiting approval.

Source: `electron/`

## Database

One Supabase project in production, PGlite for local development. Five isolated schemas with no cross-schema foreign keys.

| Schema | Tables | Purpose |
|--------|--------|---------|
| `agent_graph` | 12 tables + functions | Task DAG, state machine, budgets, LLM tracking, halt signals, tool registry + audit |
| `inbox` | 4 tables | Email metadata, triage results, drafts, sync state |
| `voice` | 3 tables | Sent email corpus, voice profiles, edit deltas |
| `signal` | 3 tables | Contacts, topics, briefings |
| `content` | 3 tables | Topic queue, content drafts, reference posts (Phase 1.5 LinkedIn automation) |

See [Database Architecture](./database-architecture.md) for full schema details.

## Event System

Dual-mode dispatch depending on the database backend:

| Mode | In-Process | Cross-Process |
|------|-----------|---------------|
| PGlite (dev) | Node.js EventEmitter | N/A (single process) |
| Real Postgres (prod) | Node.js EventEmitter | `pg_notify` / `LISTEN autobot_events` |

Events are written to `agent_graph.task_events` as the outbox table, then dispatched in-process via EventEmitter. In production Postgres mode, `pg_notify` provides cross-process wake-up on the `autobot_events` channel.

Halt checks are cached for 2 seconds to reduce contention from 6 agents polling simultaneously.

Source: `src/runtime/event-bus.js`

## Environment Variables

Required in `.env` (see `.env.example`):

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | Claude API key for all agent LLM calls |
| `GMAIL_CLIENT_ID` | OAuth client ID for Gmail API |
| `GMAIL_CLIENT_SECRET` | OAuth client secret |
| `GMAIL_REFRESH_TOKEN` | OAuth refresh token |
| `GMAIL_USER_EMAIL` | Inbox owner email (used to skip outbound mail) |
| `DAILY_BUDGET_USD` | LLM spend ceiling per day (default $20) |
| `AUTONOMY_LEVEL` | 0, 1, or 2 |
| `OPENAI_API_KEY` | For embedding generation (text-embedding-3-small) |
| `DATABASE_URL` | Supabase/Postgres connection string (optional; PGlite if absent) |

## Dependencies

The dependency list is deliberately minimal (P4: boring infrastructure):

| Package | Purpose |
|---------|---------|
| `@anthropic-ai/sdk` | Claude API client |
| `googleapis` | Gmail API client |
| `pg` | PostgreSQL client (production) |
| `@electric-sql/pglite` | Embedded Postgres (development) |
| `chalk` | Terminal color output |
| `dotenv` | Environment variable loading |

No web framework. No ORM. No message queue. No orchestration library.

## Runtime Requirements

- Node.js >= 20.0.0
- ES modules throughout (`"type": "module"`)
- Package manager: npm
