# Signal Pipeline Architecture — First-Principles Analysis

**Date**: 2026-04-08
**Author**: Architect Agent (Liotta Systems Architect)
**Status**: PROPOSAL — requires board review

---

## 1. Leverage Analysis: What's the 10x Opportunity?

The current architecture has **two independent signal ontologies** crossing each other:

| System | Table | Purpose | Writers |
|--------|-------|---------|---------|
| **Inbox signals** | `inbox.signals` | Structured extractions from messages (commitments, deadlines, questions) | `executor-triage.js`, `signal-ingester.js`, `tools/registry.js` |
| **Flow signals** | `agent_graph.signals` | Generic events that trigger automated pipelines | `flow-engine.js`, `api-routes/flows.js`, `cli/commands/flow.js` |
| **Messages** | `inbox.messages` | Raw channel input (email, Slack, Telegram, webhook, Drive) | `orchestrator.js`, `signal-ingester.js`, `telegram/listener.js`, `slack/listener.js`, `drive/watcher.js`, `api.js` |

Plus a **third conceptual layer**: `agent_graph.task_events` serves as the inter-agent dispatch bus (9 event types, pg_notify backed).

The naive approach (your proposed 3-stage funnel) would merge these into `raw → processed → trigger`. But here is where I push back.

### The Contrarian Take: You Don't Have a Signal Problem. You Have a Vocabulary Problem.

The two signal systems aren't duplicating work — they serve fundamentally different lifecycle stages:

1. **`inbox.signals`** = **extracted facts** from human communication (commitment, deadline, question). These have `message_id` FK, `confidence`, `due_date`, `direction`, `domain`, `resolved` tracking. They are **stateful** (resolved/unresolved) and **domain-classified**.

2. **`agent_graph.signals`** = **events** that trigger automation. These have `source_adapter`, `payload` JSONB, `project_id`. They are **stateless** (fire-and-forget) and **trigger-oriented**.

These are not the same thing. Merging them into one table forces you to either:
- Add nullable columns for both use cases (wide table anti-pattern), or
- Use JSONB for everything (losing all the CHECK constraints that make `inbox.signals` self-documenting)

**The real mess is not the tables. It's the 9+ code paths that write to `inbox.messages` without a shared entry point.** That is where the 10x leverage lives.

---

## 2. Recommended Architecture: 2-Stage, Not 3-Stage

I propose a **2-stage model** instead of 3-stage:

```
Stage 1: Unified Ingestion Gateway (single code path)
    → inbox.messages (raw channel input, stored for audit)
    → agent_graph.signals (event emitted for flow engine)

Stage 2: Processing (existing agents, unchanged)
    → inbox.signals (extracted facts, written by executor-triage)
    → agent_graph.flow_executions (automation runs, written by flow-engine)
```

### Why 2 Stages, Not 3

The 3-stage model (raw → processed → trigger) implies a linear pipeline. But the actual data flow is a **fan-out**:

```
                    ┌─→ inbox.messages (audit/metadata)
Channel Input ──→ GATEWAY ──→ agent_graph.signals (flow trigger)
                    └─→ work_items (task graph dispatch)
```

Then **downstream agents** create derived artifacts:
- `executor-triage` reads messages → writes `inbox.signals` (extractions)
- `flow-engine` reads `agent_graph.signals` → writes `flow_executions` (automation)
- `orchestrator` reads `work_items` → creates child work items (routing)

The "processed signal" stage already exists — it's just `executor-triage` doing its job. Adding a third table between ingestion and processing adds a mandatory hop with zero information gain.

---

## 3. Schema Design

### 3A. Keep `inbox.signals` and `agent_graph.signals` Separate (recommended)

**Rationale**: They model different things with different lifecycles.

| Property | `inbox.signals` | `agent_graph.signals` |
|----------|-----------------|----------------------|
| FK to source | `message_id → inbox.messages` | None (event is self-contained) |
| Lifecycle | Stateful (resolved/unresolved) | Stateless (fire-and-forget) |
| Schema | Tight CHECK constraints (9 types, 4 domains) | Open (any `signal_type` string) |
| Written by | Triage agents after LLM analysis | Adapters/API/flow-engine automatically |
| Read by | Briefing generator, dashboard, daily digest | Flow engine only |
| Cardinality | ~5-15 per message (extracted facts) | ~1 per inbound event |

Merging them would destroy the tight typing on `inbox.signals` (which enforces P2: infrastructure enforces). The `agent_graph.signals` table needs to be open-ended because new signal types emerge from flow definitions without schema changes.

### 3B. `inbox.messages` Stays as Raw Channel Input

`inbox.messages` is not "just a raw signal" — it's the **metadata record** for channel-specific input with fields that only make sense for messages (`subject`, `snippet`, `from_address`, `to_addresses`, `cc_addresses`, `labels`, `thread_id`, `in_reply_to`, `triage_category`, etc.).

Trying to generalize this into a "raw signal" table would either:
- Dump all those fields into JSONB (losing CHECK constraints, indexes, and query ergonomics)
- Keep them as columns on a "signals" table where 80% of signals don't use them

**Verdict**: `inbox.messages` stays. It's the right abstraction for channel input metadata.

### 3C. The One Table That's Missing: Unified Ingestion Log

What *is* missing is a **thin audit table** that records "something arrived" before any processing:

```sql
CREATE TABLE agent_graph.ingestion_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source        TEXT NOT NULL,            -- 'gmail', 'slack', 'telegram', 'webhook', 'drive', 'api', 'linear', 'github'
  source_id     TEXT,                     -- dedup key (provider_msg_id, event_id, etc.)
  channel       TEXT NOT NULL,            -- matches inbox.messages.channel enum
  account_id    TEXT,                     -- FK to inbox.accounts if applicable
  message_id    TEXT,                     -- FK to inbox.messages (set after insert)
  signal_id     UUID,                     -- FK to agent_graph.signals (set if flow signal emitted)
  work_item_id  TEXT,                     -- FK to agent_graph.work_items (set after orchestrator creates task)
  metadata      JSONB DEFAULT '{}',       -- source-specific context (headers, webhook type, etc.)
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX idx_ingestion_dedup ON agent_graph.ingestion_log(source, source_id) WHERE source_id IS NOT NULL;
CREATE INDEX idx_ingestion_source ON agent_graph.ingestion_log(source, created_at);
```

This table costs almost nothing (thin rows, append-only, no business logic) but gives you:
- **Single dedup point** — the `(source, source_id)` unique index catches duplicates before any processing
- **Full audit trail** — "when did this arrive, from where, what did we create from it?"
- **Correlation** — links message_id ↔ signal_id ↔ work_item_id in one row
- **Observability** — `SELECT source, count(*) FROM ingestion_log WHERE created_at > now() - interval '1 hour' GROUP BY source` gives instant throughput dashboard

---

## 4. Single Ingestion Point: The Gateway Function

The 10x win is not a new table — it's a **single function** that every adapter calls:

```
lib/runtime/ingestion-gateway.js
```

```javascript
/**
 * Universal ingestion gateway. Every channel adapter calls this.
 * Returns { messageId, signalId?, workItemId? }
 *
 * Responsibilities:
 *   1. Dedup check (ingestion_log)
 *   2. Insert inbox.messages (channel metadata)
 *   3. Emit agent_graph.signal (if flow-eligible)
 *   4. Log to ingestion_log (correlation record)
 *   5. Return IDs for caller to use
 *
 * Does NOT:
 *   - Classify or triage (that's executor-triage's job)
 *   - Create work_items (that's orchestrator's job via event bus)
 *   - Extract signals (that's executor-triage's job)
 */
export async function ingest({
  source,           // 'gmail', 'slack', 'telegram', 'webhook', 'drive', 'github', 'linear'
  sourceId,         // provider dedup key
  channel,          // 'email', 'slack', 'telegram', 'webhook'
  accountId,        // inbox.accounts FK

  // Message metadata (channel-specific, passed through)
  fromAddress,
  fromName,
  toAddresses,
  ccAddresses,
  subject,
  snippet,
  receivedAt,
  labels,
  hasAttachments,
  inReplyTo,
  threadId,
  providerId,       // provider_msg_id for email
  channelId,        // channel_id for non-email

  // Optional: pre-extracted signals (webhook/GitHub payloads may include them)
  signals,          // [{ signal_type, content, confidence, ... }]

  // Optional: emit flow signal
  emitFlowSignal,   // { signalType, payload } — if set, creates agent_graph.signal
  metadata,         // arbitrary JSONB stored on ingestion_log
}) { ... }
```

### Current vs Proposed Code Paths

| Adapter | Current | Proposed |
|---------|---------|----------|
| Gmail poller (`orchestrator.startPolling`) | Direct `INSERT INTO inbox.messages`, inline dedup, creates work_item | `ingest({ source: 'gmail', ... })` → event bus → orchestrator creates work_item |
| Webhook (`signal-ingester.js`) | `INSERT INTO inbox.messages` + loops `INSERT INTO inbox.signals` | `ingest({ source: 'webhook', signals: [...] })` |
| Telegram (`telegram/listener.js`) | Direct `INSERT INTO inbox.messages` | `ingest({ source: 'telegram', ... })` |
| Slack (`slack/listener.js`) | Direct `INSERT INTO inbox.messages` | `ingest({ source: 'slack', ... })` |
| Drive (`drive/watcher.js`) | Direct `INSERT INTO inbox.messages` | `ingest({ source: 'drive', ... })` |
| API (`api.js` x2) | Direct `INSERT INTO inbox.messages` | `ingest({ source: 'api', ... })` |
| GitHub (`webhook-handler.js`) | Calls `signal-ingester.ingestAsSignal` | `ingest({ source: 'github', ... })` |
| Linear (`linear/ingest.js`) | Calls `signal-ingester.ingestAsSignal` | `ingest({ source: 'linear', ... })` |

**9 code paths → 1 function. That's the 10x.**

---

## 5. Processing Stage: What "Process" Means

The question "what does processing a raw signal mean?" already has an answer in the codebase. It's the executor-triage pipeline:

1. **Classification** — LLM categorizes message into `triage_category` (action_required, needs_response, fyi, noise, pending)
2. **Signal extraction** — LLM extracts structured facts → writes `inbox.signals` (commitment, deadline, request, etc.)
3. **Contact resolution** — `upsertContact()` updates `signal.contacts`
4. **Priority scoring** — `quickScore()` computes `priority_score`

This pipeline is correct as-is. The proposed ingestion gateway does not change it. What changes is that **the gateway guarantees every channel hits this pipeline** instead of some channels writing signals directly (webhook ingester) while others defer to the orchestrator.

### Flow Signal Processing

For `agent_graph.signals`, processing is already implemented:

```
signal arrives → flow-engine.onSignal(signal)
  → getFlowsForSignalType(signal.signal_type)
  → for each matching flow_definition: executeFlow()
    → for each step: dispatch tool
    → if step has output_signal_type: recursive onSignal()
```

This is clean and sufficient. The DAG validation (`validateFlowDAG`) prevents cycles. Depth guards prevent infinite recursion. No changes needed.

---

## 6. Flow Triggering: Assessment of Current Design

The existing flow engine (`lib/runtime/flow-engine.js`) is well-designed:

**Strengths:**
- Clean separation: `createSignal()` → `onSignal()` → `getFlowsForSignalType()` → `executeFlow()`
- Depth guard (`maxGlobalDepth = 8`) prevents infinite recursion
- Timeout per flow (`timeout_ms`, checked before and after each step)
- Step-level audit trail (`step_executions` table)
- Retry policies per flow (none/skip/retry_step)
- DAG cycle detection at definition time
- Dry-run support

**One Gap: No Connection to the Ingestion Gateway**

Currently, flow signals are emitted by:
1. The API (`POST /api/signals`)
2. The CLI (`flow emit`)
3. The flow engine itself (output signal chaining)

But the channel adapters (Gmail, Slack, etc.) **never emit flow signals**. This means the flow engine can only react to explicitly-emitted events, not to channel input.

**Fix**: The ingestion gateway should optionally emit a flow signal for each ingested message:

```javascript
// In ingest():
if (emitFlowSignal || autoFlowSignal) {
  const signalType = emitFlowSignal?.signalType || `${channel}.received`;
  const signal = await flowEngine.createSignal(signalType, {
    message_id: messageId,
    source,
    channel,
    subject,
    from: fromAddress,
    ...emitFlowSignal?.payload,
  }, source);
  // Don't auto-trigger onSignal() here — let the event bus handle it
  // This allows the flow engine to be decoupled from the ingestion path
}
```

This bridges the gap: channel input now triggers flows like `email.received → auto-label → notify-slack`.

---

## 7. Migration Path

### Phase 1: Add Ingestion Gateway (non-breaking, ~2 days)

1. Create `agent_graph.ingestion_log` table (new migration 042)
2. Create `lib/runtime/ingestion-gateway.js`
3. Add `ingest()` function that:
   - Checks dedup via `ingestion_log`
   - Delegates to existing `INSERT INTO inbox.messages` logic
   - Optionally creates `agent_graph.signals`
   - Logs to `ingestion_log`
4. **No existing code changes yet** — gateway exists alongside current paths

### Phase 2: Migrate Adapters One-by-One (incremental, ~3 days)

Migrate each adapter to call `ingest()` instead of direct INSERT. Order by risk:

1. `signal-ingester.js` (webhook) — already has the most logic, biggest win
2. `telegram/listener.js` — simple adapter
3. `slack/listener.js` — simple adapter
4. `drive/watcher.js` — simple adapter
5. `api.js` (two INSERT paths) — consolidate both
6. `orchestrator.startPolling` — most complex, migrate last

Each migration is a separate PR. Each can be tested independently. Rollback = revert one PR.

### Phase 3: Wire Flow Engine to Gateway (optional, ~1 day)

Add `channel.received` flow signal emission to the gateway. This enables reactive flows triggered by any channel input.

### Production Data

No data migration needed. The `ingestion_log` is new and forward-only. Existing `inbox.messages` and `inbox.signals` rows remain valid. The gateway writes to the same tables — it just centralizes the write path.

---

## 8. Quantified Gains

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| Ingestion code paths | 9 (across 7 files) | 1 (`ingestion-gateway.js`) | 9x reduction in write surface |
| Dedup implementations | 3 (orchestrator, signal-ingester, api) | 1 (gateway) | Eliminates dedup inconsistencies |
| Tables storing "signal-like" things | 3 (`inbox.messages`, `inbox.signals`, `agent_graph.signals`) | 3 + 1 audit log | Same count, but clear separation of concerns |
| Lines of INSERT boilerplate | ~180 LOC across 9 files | ~60 LOC in gateway | 3x reduction |
| Observability (throughput by source) | Requires 3 separate queries | `SELECT source, count(*) FROM ingestion_log GROUP BY source` | 1 query |
| New channel onboarding | Copy-paste INSERT logic + dedup + error handling | Call `ingest({...})` | <10 LOC per new channel |
| Flow engine reach | API/CLI only (3 entry points) | Any channel input | Full coverage |

### What We DON'T Gain From a 3-Table Merge

If we had merged `inbox.signals` + `agent_graph.signals` + `inbox.messages`:
- We'd lose CHECK constraints on signal types (P2 violation)
- We'd lose the `message_id` FK relationship (breaks briefing queries)
- We'd need JSONB for channel-specific fields (slower queries, no index)
- We'd add migration risk for production data
- Net result: **worse**, not better

---

## 9. Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Gateway has a bug that drops messages | Medium | High | Phase 2 is per-adapter; each has its own PR with rollback |
| Ingestion_log grows large | Low | Low | Append-only, thin rows (~200 bytes). Partition by month if needed |
| Flow signals on every message create too many flow_executions | Medium | Medium | Gate behind config flag; only emit when flow_definitions exist for that signal_type |
| Migration takes longer than expected | Low | Low | Non-breaking; old paths work until migrated |

---

## 10. Decision Summary for Board Review

**Recommendation**: Do NOT merge the signal tables. Instead, create a single ingestion gateway function that all adapters call, plus a thin audit table for correlation and observability.

**The 3-stage funnel model is directionally right but structurally wrong.** The stages exist, but they're not a linear pipeline — they're a fan-out from a single entry point. The fix is not new tables; it's consolidating the 9 write paths into 1.

**Board decisions needed:**
1. Approve the `ingestion_log` table addition (042 migration)
2. Approve the phased adapter migration (3 phases, ~6 days total)
3. Decide whether to auto-emit flow signals for all channel input (Phase 3) or keep flow signals opt-in

**Cost**: ~$0 infrastructure cost (same Postgres, same tables). Engineering effort: ~6 days across 3 phases.

**What we don't do**: Merge tables, rewrite the flow engine, or migrate production data. The current table separation is correct — it reflects genuinely different data models.
