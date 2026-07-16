# STAQPRO-303 PR-B-prereq.1d — Bare `query()` Caller Audit

**Status:** Discovery complete. Awaiting sub-ticket triage before code migration.
**Author:** Eric / 2026-05-22
**Closes:** Linus pre-impl review **MISSING #2** from PR #230 design memo.

## Why this audit exists

The 7 tables that `B-prereq.1e` will gate under `FORCE ROW LEVEL SECURITY` are:

- `agent_graph.work_items`
- `agent_graph.state_transitions`
- `agent_graph.task_events`
- `agent_graph.llm_invocations`
- `agent_graph.action_proposals`
- `inbox.messages`
- `voice.edit_deltas`

The top-level `query()` export in `lib/db.js` hits the pool directly — no agent context, no RLS session vars, no `app.tier`, no `app.agent_id`. As long as the pool connects as the Supabase superuser, this is fine: RLS is bypassed entirely. The moment `B-prereq.1e` activates `FORCE` and `B-prereq.2` switches the pool to the `autobot_agent` role:

- Every `WRITE` (`INSERT`/`UPDATE`/`DELETE`) issued via bare `query()` against a FORCE'd table **fails outright** — there is no policy that grants the unauthenticated session anything.
- Every `READ` (`SELECT`) issued via bare `query()` returns **filtered or empty results** depending on the policy — usually empty, because `current_agent_id()` is `NULL` and no `OR is_board()` clause holds.

Linus's pre-impl review named three offenders explicitly. This audit enumerates the full population.

## Headline numbers

| Metric | Count |
|---|---|
| Files scanned that reference FORCE'd tables | 102 |
| Files with at least one bare `query()` touching a FORCE'd table | **86** |
| Total bare-query call sites touching FORCE'd tables | **351** |
| Of those, WRITE operations (INSERT/UPDATE/DELETE) | **97** |
| Of those, READ operations (SELECT) | 254 |

The 97 writes are the hard-break set. The 254 reads are the silent-deny set.

## Categorized by directory

```
   80  autobot-inbox/src/api-routes
   60  autobot-inbox/src
   47  lib/runtime
   28  autobot-inbox/src/commands
   17  autobot-inbox/src/gmail
   15  autobot-inbox/src/runtime
   10  autobot-inbox/src/linear
    9  autobot-inbox/src/cli/commands
    9  autobot-inbox/src/flow-wrappers
    9  autobot-inbox/src/voice
    8  lib/graph
    7  lib/runtime/exploration/domains
    6  autobot-inbox/src/github
    6  autobot-inbox/src/signal
    6  autobot-inbox/src/telegram
    5  autobot-inbox/src/outlook
    5  autobot-inbox/src/strategy
    5  autobot-inbox/src/tldv
    4  lib/audit
    3  autobot-inbox/src/drive
    3  autobot-inbox/src/slack
    2  autobot-inbox/src/finance
    2  autobot-inbox/src/webhooks
    2  lib/engagements
    1  autobot-inbox/src/transcripts
    1  lib/comms
    1  lib/contracts
```

## Categorized by call-site type

| Category | Files | Hits | Writes | Migration target |
|---|---|---|---|---|
| **BOARD_API** | 21 | 128 | 29 | `withBoardScope` (helper shipped in PR #232) |
| **BG_SERVICE** | 15 | 49 | 11 | acquire own scope per tick (sweeper/reaper pattern) |
| **ADAPTER_IO** | 10 | 39 | 20 | scope per ingest call (orchestrator-tier service identity) |
| **CLI** | 7 | 37 | 11 | operator-tier JWT or admin bypass |
| **INTEGRATIONS** | 12 | 33 | 11 | scope per ingest call (orchestrator-tier service identity) |
| **METRICS_AUDIT** | 3 | 17 | 0 | `SECURITY DEFINER` views (precedent: `v_phase1_metrics`) |
| **OTHER** | 4 | 15 | 6 | case by case |
| **FLOW_WRAPPERS** | 6 | 9 | 3 | flows already run inside agent scope; rename `query`→`scopedQuery` |
| **GRAPH** | 1 | 8 | 0 | mixed: scoped where called from agents, definer for cross-org enrichers |
| **AGENT_LOOP** | 1 | 7 | 4 | already inside `withAgentScope` — rename `query`→`scopedQuery` |
| **STRATEGY** | 2 | 5 | 1 | orchestrator-tier service identity |
| **LIB_CONTRACTS_ENG** | 3 | 3 | 1 | product-coupled; review separately |
| **COMMS** | 1 | 1 | 0 | service identity for outbound dispatch |

The board API row alone is **128 hits across 21 files** — the bulk of the migration work. PR #232's `withBoardScope` is the unblocking primitive.

## Top 20 offenders

```
   48  autobot-inbox/src/api.js
   19  autobot-inbox/src/api-routes/pipeline.js
   15  autobot-inbox/src/commands/agent-chat.js
   13  autobot-inbox/src/api-routes/redesign.js
   13  autobot-inbox/src/runtime/phase1-metrics.js
   10  autobot-inbox/src/commands/board-commands.js
   10  lib/runtime/context-loader.js
    9  autobot-inbox/src/gmail/sender.js
    8  autobot-inbox/src/api-routes/blueprint.js
    8  autobot-inbox/src/demo.js
    8  lib/graph/pattern-extractor.js
    7  lib/runtime/agent-loop.js
    6  autobot-inbox/src/api-routes/governance.js
    6  autobot-inbox/src/linear/comment-handler.js
    6  lib/runtime/autonomy-evaluator.js
    5  autobot-inbox/src/api-routes/campaigns.js
    5  autobot-inbox/src/api-routes/runs.js
    5  autobot-inbox/src/cli/commands/review.js
    5  autobot-inbox/src/outlook/sender.js
    5  autobot-inbox/src/tldv/poller.js
```

## Linus's three named files in detail

### `lib/comms/sender.js` — 1 hit, READ

```
L21 [READ] agent_graph.action_proposals
   SELECT * FROM agent_graph.action_proposals WHERE id = $1
```

Outbound dispatch path. Reads a proposal before sending. **Migration:** acquire a service-tier scope at top of sender invocation; rename to `scopedQuery`. Single-line change once the scope is wired.

### `lib/runtime/autonomy-evaluator.js` — 6 hits (1 WRITE, 5 READ)

```
L30  [WRITE] agent_graph.task_events       INSERT INTO ... (event_type, work_item_id, target_agent_id, ...
L47  [READ]  agent_graph.action_proposals  SELECT COUNT(*) ... WHERE board_action IS NULL ...
L54  [READ]  agent_graph.action_proposals  SELECT COUNT(*) ... FILTER (WHERE board_action = 'edited') ...
L66  [READ]  agent_graph.llm_invocations   SELECT COUNT(DISTINCT DATE(created_at)) ...
L166 [READ]  agent_graph.llm_invocations   (same)
L174 [READ]  agent_graph.action_proposals  SELECT COUNT(*) ... (autonomy aggregate)
```

Background service that computes L0/L1/L2 autonomy thresholds. **Migration:** `SECURITY DEFINER` view over the aggregates, OR acquire orchestrator-tier scope per tick. View is simpler — the function emits no agent-specific writes (the L30 INSERT is a routing event, fine under service identity). Lean toward SECURITY DEFINER view + scoped task_events INSERT.

### `lib/runtime/context-loader.js` — 10 hits (2 WRITE, 8 READ)

```
L118 [READ]  agent_graph.work_items                            SELECT * FROM ... WHERE id = $1
L135 [READ]  inbox.messages                                    SELECT * FROM ... WHERE id = $1
L191 [WRITE] agent_graph.work_items                            UPDATE ... SET input_quarantined = true ...
L229 [WRITE] agent_graph.work_items                            UPDATE ... SET metadata = metadata || $1 ...
L376 [READ]  inbox.messages                                    SELECT s.* FROM inbox.signals s JOIN ...
L397 [READ]  agent_graph.action_proposals                      SELECT * FROM ... WHERE message_id = $1 ...
L467 [READ]  inbox.messages                                    SELECT m.id, m.subject, m.snippet, ...
L524 [READ]  agent_graph.work_items, .state_transitions        SELECT wi.id, ..., st.cost_usd, ...
L568 [READ]  agent_graph.work_items                            SELECT ac.id, ac.agent_type, ...
L584 [READ]  agent_graph.work_items                            SELECT wi.assigned_to, COUNT(*) AS total ...
```

This is the highest-stakes file in the audit. `context-loader.js` runs as part of every agent tick — it builds the prompt context. Its callers (`agent-loop.js`) DO acquire a `scopedQuery` via `withAgentScope`, but they invoke `loadContext` which then uses bare `query()` instead of the scoped one.

**Migration:** `loadContext()` signature must take a `scopedQuery` parameter (or a context object containing it) and use it everywhere. Renaming `query`→`scopedQuery` is not enough — the function needs the scoped instance passed in. ~10 call sites changed inside one function; ~3-5 call sites changed in `agent-loop.js` and other callers of `loadContext`.

## Sequencing — what must change BEFORE the FORCE flag flips

Not everything in this audit needs to move before `RLS_ENFORCE_V2=true`. Categorize by:

- **MUST MIGRATE BEFORE FLIP** — writes against FORCE'd tables. 97 hits across the bg_service, adapter_io, board_api, agent_loop, integrations, cli, and other categories. Every one of these breaks production the moment FORCE activates.
- **SHOULD MIGRATE BEFORE FLIP** — reads from FORCE'd tables that are functionally required (e.g., context-loader's work_item lookup). Silent-deny is its own production break (the agent gets `undefined` instead of the work_item it's processing).
- **SAFE TO DEFER** — read-only metrics/audit/admin reads where empty results degrade gracefully (e.g., the `/api/briefing` summary returning zeros until the route is scoped). The board UX shows stale data, but no agent crash.

A rough first-pass triage on the 97 writes:

| Category | Writes | Pre-flip blocking? |
|---|---|---|
| BOARD_API | 29 | YES — `withBoardScope` migration |
| ADAPTER_IO | 20 | YES — adapters write `inbox.messages` on ingest |
| AGENT_LOOP | 4 | YES — rename to scopedQuery |
| CLI | 11 | DEPENDS — only blocks if invoked post-flip |
| BG_SERVICE | 11 | YES — sweepers/reapers must run |
| INTEGRATIONS | 11 | YES — Linear/GitHub/webhook ingest writes |
| OTHER | 6 | review |
| FLOW_WRAPPERS | 3 | YES — already in agent scope, trivial rename |
| STRATEGY | 1 | YES |
| LIB_CONTRACTS_ENG | 1 | review |

That's **~80 writes** that genuinely must migrate before the flag flips.

## Proposed Linear sub-ticket structure

File the following children under STAQPRO-303 (parent of the B-prereq.1 family):

- **STAQPRO-303-1d-1**: Migrate `lib/runtime/context-loader.js` to use scopedQuery (HIGHEST IMPACT — every tick, 10 sites)
- **STAQPRO-303-1d-2**: Migrate `lib/runtime/autonomy-evaluator.js` (1 WRITE + 5 READ; possibly SECURITY DEFINER view for aggregates)
- **STAQPRO-303-1d-3**: Migrate `lib/comms/sender.js` (1 site; service identity scope)
- **STAQPRO-303-1d-4**: Migrate `lib/runtime/agent-loop.js` internal bare-query calls (7 sites, 4 writes)
- **STAQPRO-303-1d-5**: Migrate Board API (`api.js` + `api-routes/`) — bulk migration to `withBoardScope`. May fan out into sub-sub-tickets by route family (pipeline, redesign, blueprint, governance, campaigns, runs, etc.).
- **STAQPRO-303-1d-6**: Migrate adapter ingest paths (`gmail/sender`, `outlook/sender`, `tldv/poller`, etc.) — service-tier scopes on outbound + inbound writes.
- **STAQPRO-303-1d-7**: Migrate integrations (`linear/comment-handler`, `github/*`, `slack/*`, `telegram/*`, `webhooks/*`).
- **STAQPRO-303-1d-8**: Migrate background services (`sweeper`, `reaper`, `phase1-metrics`) — sweepers acquire scope per tick; metrics moves to SECURITY DEFINER views.
- **STAQPRO-303-1d-9**: Migrate CLI commands — operator-tier JWT or admin bypass.
- **STAQPRO-303-1d-10**: Migrate `flow-wrappers` — trivial rename from `query` to `scopedQuery`.

Plus the existing **STAQPRO-303** sequence continues to **1.e** (policies + state-machine patch + FORCE behind flag), which MUST not flip until at least 1d-1 through 1d-8 have landed.

## Methodology

Audit produced by a deterministic JS script that:

1. Found all `*.js` files under `lib/` and `autobot-inbox/src/` that reference one of the 7 FORCE'd tables by exact `schema.table` name.
2. For each file, located every `query(` call site **not** preceded by `.` or scoped-prefix (i.e., excluded `scopedQuery(`, `client.query(`, `c.query(`, `tx.query(`, `d.query(`, `_query(`).
3. Parsed the SQL string literal at the call site; tagged it WRITE if it contains `\bINSERT|UPDATE|DELETE\b`, READ otherwise; recorded which forced tables it references.
4. Saved both raw and categorized findings to `$CLAUDE_JOB_DIR/1d-findings*.json` for downstream tooling.

Limitations:
- Misses SQL passed via interpolated variables or imported from external `.sql` files (not common in this repo — most SQL is inline template literals).
- Does not detect indirect bare-query calls via helper functions that take a query arg and the caller passes the top-level export.

A small number of false positives may exist where a file declares both a local `query` variable (rebound from `scopedQuery`) AND the top-level `query`; manual review during sub-ticket execution will catch these.
