# ADR-008: M5 Activity as Optimus Federated Channel

**Date**: 2026-05-19
**Status**: Proposed — awaiting board review (Eric + Dustin)
**Issue**: Eric runs Claude Code subagents on his personal M5 MacBook and wants Optimus to passively observe that work and learn from it across sessions. The standalone proposals to do this — Screenpipe (continuous screen capture + OCR + Whisper) and an NDJSON+DuckDB collector — were both rejected. Screenpipe failed Linus's security review; the NDJSON collector duplicates Optimus capabilities (sanitization, audit, halt, review surface) that already exist as infrastructure. Should this run through Optimus instead?

---

## Context

Three observations converge:

1. **The data already exists, structured.** `~/.claude/projects/<project>/<session>.jsonl` contains 100%-precision records of every Claude Code prompt, tool call, file edit, and result on M5. No OCR is required for the primary learning signal.

2. **Optimus already implements this pipeline shape.** SPEC §3 (state_transitions), §5 (sanitization), §7 (Communication Gateway), §9 (halt_signals), plus the existing transcript→signal extraction in `autobot-inbox/src/signal/extractor.js`, `autobot-inbox/src/transcripts/action-extractor.js`, and `agents/executor-triage/` (topic pre-analysis), collectively constitute the exact pipeline a standalone M5 collector would have to reinvent. The tldv meeting-transcript pipeline (`autobot-inbox/src/tldv/{poller,webhook,api}.js`) is the closest existing analog — same shape, different source.

3. **Federation is already the framework.** ADR-007 (Federation Thesis) and ADR-018 (JWT Agent Identity), extended by the 2026-05-14 v2 org/aud claim addendum and STAQPRO-358 composite-iss work (`lib/runtime/agent-jwt.js`), define how a peer org authenticates into Optimus. The Tier-1 Staqs↔UMB self-federation work (`spec/proposals/federation-tier1-staqs-umb.md`) is the first real user of this framework. Eric's M5 is naturally modeled as a *second* peer org (`did:web:eric-m5.staqs.io`) rather than as a bespoke ingest path.

The Linus and Liotta reviews of the standalone proposals (2026-05-19) both independently recommended the Optimus-native reframe. Liotta quantified the win: ~230 LOC inside Optimus vs ~600 LOC standalone (-62%), and a security-tier upgrade from prompt-enforced (P1) to infrastructure-enforced (P2). The reframe earns its keep through §5/§7/§9 inheritance — sanitization, gateway audit, halt — not through LOC reduction.

---

## Decision

Ingest M5 activity into Optimus as a new federated channel **`m5-activity`**, with M5 modeled as a federated peer org `did:web:eric-m5.staqs.io`.

### Architecture

1. **Four ingesters run on M5 hardware** (not in the Optimus repo — they live in a sibling repo `staqsIO/optimus-m5-ingesters` or under `m5-ingesters/` consumed only at install time on M5):
   - `claude-transcripts` — tails `~/.claude/projects/**/*.jsonl`, batches per session, POSTs through the Communication Gateway. Tool-use blocks become transcript rows.
   - `git-events` — post-commit hooks across known repo roots → webhook POST.
   - `app-focus` — small Swift launchd helper subscribed to `NSWorkspaceDidActivateApplicationNotification` → webhook POST. **DEFERRED** per Liotta review — low semantic density (~5k events/day) and the only piece requiring native code. Re-evaluate after Ship 1.
   - `fswatch` — file events under repo roots and the Obsidian vault → webhook POST.

2. **Each ingester authenticates with a per-ingester JWT** issued under `iss=optimus-agent@did:web:eric-m5.staqs.io`, `aud=did:web:staqs.io`, using the v2 claim set defined by ADR-018 Federation Claim Extension addendum. The JWT primitives are already shipped (STAQPRO-358 / `lib/runtime/agent-jwt.js`).

3. **A new adapter `lib/adapters/m5-activity-adapter.js` receives the webhook traffic** and enqueues `work_items` onto the existing task graph. Adapter contract is the same one used by Gmail / Slack / Telegram / tldv adapters.

4. **`agents/executor-triage/` runs existing topic + signal extraction** on M5 transcripts. The agent's `channel` parameter gains `m5-activity` via `autobot-inbox/config/agents.json`. No new extraction code.

5. **Extracted signals land in the Postgres `signals` table tagged `origin_org=did:web:eric-m5.staqs.io`** (per the STAQPRO-359 `origin_org` work consolidated into `lib/graph/schema.js`). Sanitization per SPEC §5 runs at the gateway before storage.

6. **The Board Workstation Signals tab gains a channel filter for `m5-activity`.** No new review surface is built. Today tab gets an "M5 attention this week" widget rendered from the same query.

7. **Screenpipe is DEFERRED behind a Day-14 recall measurement gate.** If recall on Linear-web-UI ticket IDs and similar web-UI-only artifacts from the transcript+hooks ingesters alone is <90%, install Screenpipe as a 5th ingester behind the same gateway / sanitization / halt rules with Linus's mitigations (allowlist not blocklist, audio OFF, token-gated localhost-only API, 50MB/day hard cap, deletion provenance index). Otherwise it is never installed.

### Bidirectional read path — Ship 1.5

Per Liotta's "10x angle still being missed": the architectural endpoint is **bidirectional**. The same JSONL tail that ships transcripts *out* pairs with a Claude Code `PreToolUse` / `UserPromptSubmit` hook on M5 that queries the Optimus `signals` table for "have we seen this file/error/pattern before across any subagent?" and injects the top-K results as context.

This turns "Hermes watches your agents" into "Hermes learns from your agents and your agents learn from each other" — and the read path is ~40 LOC of hook plus one `lib/rag/query` call against the embedder that already ships. Not built in Ship 0. Named here so subsequent ships don't paint into a corner.

### Shipping plan

| Ship | When | Surface | Gate |
|------|------|---------|------|
| **Ship 0** | Days 1-2 | `lib/adapters/m5-activity-adapter.js` + `lib/sanitization/rules-m5.js` (extend §5) + M5 `claude-transcripts` ingester + launchd plist + `agents.json` channel claim. ~120 LOC total. | 4 gates: (a) real session produces ≥1 row in `signals`; (b) row in Board Signals tab <10s after session end; (c) sanitization log shows ≥1 redaction on injected fake API key; (d) `state_transitions` row links transcript → signal (deletion provenance verified). |
| **Ship 1** | Week 2 | `git-events` + `fswatch` ingesters. (No `app-focus` — dropped per Liotta.) | Ship 0 green for 7 days; FM1 spool drain test (kill Optimus link for 1hr, verify drain). |
| **Ship 2** | Week 3 | Linear attention-weighting SQL view + Today widget. Rewrites the Hermes Monday cron (`job_id d02974ab368e`) to pull from `signals` table instead of OCR-grep. | Ship 1 stable. |
| **Ship 1.5** | After Ship 2 | Claude Code `PreToolUse` hook on M5 calls `lib/rag/query` against `signals` table; injects top-K matches as context. Bidirectional read path. | Cross-agent learnings measurably reduce repeated-mistake rate over 30-day window (T5). |
| **Ship 3** | Day 14+ | Screenpipe as 5th ingester *only if* T1 recall <90% on Linear-web-UI IDs. Otherwise never installed. | Day-14 recall measurement (T1). |

### Operational hardening (Liotta's failure modes)

- **FM1 — M5 ↔ Optimus link partition:** local NDJSON spool on M5 with monotonic seq, drains on reconnect. Prometheus counter `m5_spool_depth`, alert at >1000 unacked. Non-negotiable for Ship 0.
- **FM2 — Sanitization gap on cannabis/PII:** adversarial test suite in Ship 0 with synthetic Metrc license #s, customer email/phone PII, JWTs, AWS keys. CI gate. Recall target ≥99% on a labeled corpus of 50+ examples.
- **FM3 — Unbounded executor-triage token spend on noisy JSONL:** pre-filter at adapter — only emit transcript rows for assistant turns with text content OR tool_use of kind ∈ {Edit, Write, Bash, Read, Grep}. Drops ~70% of JSONL volume. Hard cap $5/day in `lib/llm/budget.js`, alert at $3.

---

## Alternatives Considered

| Alternative | Pros | Cons | Why Rejected |
|---|---|---|---|
| Standalone Screenpipe daemon on M5 (original proposal) | Universal coverage; no per-app integration | Unauthenticated :3030 API; regulated-data exposure (Formul8 cannabis + AutoCSR customer PII visible on same screen); no deletion provenance; WebSocket auto-action = prompt-injection-via-screen risk | Linus security review — fails P1/P2/P3 |
| Standalone NDJSON + DuckDB collector on M5 (Liotta first-pass) | Simple; no Optimus dependency; ~600 LOC | No audit trail, no sanitization, no halt mechanism; duplicates Optimus capabilities; would have to clone §5 sanitization for regulated data | Violates P4 (boring infrastructure — don't build a second pipeline) |
| Direct Claude Code Hooks (Pre/PostToolUse) writing to a shared file | Zero new infra; hooks already exist | Hook-only misses cross-agent state, branch context, no review surface, no provenance | Insufficient signal; no governance |
| RAG-only ingestion straight into `lib/rag/ingest` | Reuses RAG primitive; minimal glue | Skips the signal extraction layer where the actual learning happens; loses topic graph | Wrong layer — learning loop is `signals`, not embeddings |
| **M5 as Optimus federated channel** *(accepted)* | Reuses Communication Gateway, §5 sanitization, audit, halt, Board review UI; deletion provenance free; validates federation framework on a 2nd peer | Optimus availability becomes load-bearing for M5 observation; concurrent thread to Phase 1 federation work | — |

---

## Consequences

**Positive**

- Reuses Communication Gateway (SPEC §7), §5 sanitization, hash-chained `state_transitions` audit, `halt_signals` (SPEC §9), and the Board Workstation Signals tab. No parallel pipeline.
- Deletion provenance comes for free via `state_transitions` — a single SQL cascade deletes any transcript row and its derived signals + Board entries in one transaction.
- Cross-agent shared learning (Ship 1.5) lands in the existing `signals` table, queryable by every Optimus agent without a sync protocol.
- Validates the federation Tier-1 framework with a second `org` (`did:web:eric-m5.staqs.io`) alongside the planned Staqs↔UMB self-federation, before any external Tier-2 counterparty is brought online. Cost: ~0 LOC because federation primitives shipped 2026-05-16.
- Replaces OCR-grep heuristics for Linear attention-weighting (Hermes cron `job_id d02974ab368e`) with typed SQL queries against `signals`.

**Negative**

- The M5 ↔ Optimus link becomes load-bearing: Optimus downtime = no observation. Mitigated by local NDJSON spool (FM1).
- Adds a concurrent workstream against in-flight Phase 1 federation work; sequencing must be explicit on the board roadmap. (m5-activity writes only to `signals`/`transcripts`, never touches federation control plane — Liotta-validated as non-blocking.)
- New ingester surface area on M5 means new macOS TCC permission grants (Full Disk Access for `~/.claude/projects/`, possibly Accessibility for `NSWorkspace` if app-focus ingester is later added). Permissions are user-side, not Optimus-side, but must be documented.

**Neutral**

- M5 becomes the second federated peer after Staqs↔UMB. The federation framework gets a second user before any Tier-2 external org joins. No architectural change to the framework itself.
- This ADR records the second consumer of the ADR-018 v2 claim set. ADR-018's identity primitive is what makes ADR-007's federation primitive *and* this ADR's ingestion path possible.

---

## Affected Files

Optimus repo (`staqsIO/optimus`):
- `lib/adapters/m5-activity-adapter.js` — **NEW**
- `lib/sanitization/rules-m5.js` — **NEW**, extends SPEC §5 sanitization with Metrc license #s, customer PII regexes, JWTs, AWS keys
- `autobot-inbox/config/agents.json` — add `m5-activity` to `executor-triage` channel allowlist
- `agents/executor-triage/index.js` — channel-aware config additions (likely YAML only if existing channel switch is config-driven)
- `lib/llm/budget.js` — per-channel daily token cap (Liotta FM3)
- `board/src/app/signals/` — add `source=m5-activity` channel filter
- `board/src/app/today/` — "M5 attention this week" widget
- `SPEC.md` §7 addendum — register `m5-activity` as a recognized channel

M5-local (not in Optimus repo):
- `claude-transcripts` ingester + launchd plist (Ship 0)
- `git-events` ingester (Ship 1)
- `fswatch` ingester (Ship 1)
- `PreToolUse` hook entry in `~/.claude/settings.json` (Ship 1.5)

Cross-references requiring updates:
- `autobot-inbox/docs/internal/adrs/018-jwt-agent-identity.md` — link forward from ADR-018 to this ADR as a consumer of the v2 org/aud claim set
- `~/vault/Memory/Decisions/Linear Working Agreement.md` — update Q5 verify-and-sweep to reference `m5-activity`-based attention data once Ship 2 lands

---

## Cross-Project Impact

- **Hermes scheduler** — the Linear weekly hygiene cron (`job_id d02974ab368e` on Hermes scheduler, scheduled `0 6 * * 1`) rewrites to query the Optimus `signals` table (filtered `origin_org=did:web:eric-m5.staqs.io`) once Ship 2 lands. Current OCR-grep path becomes the fallback during the Day-14 recall gate.
- **Obsidian vault** — `Daily Notes/M5 Activity YYYY-MM-DD.md` digests continue to exist but become a **derived view** rendered from Optimus signals, not a primary store. The vault stops being load-bearing for ambient observation; Optimus is.
- **Hermes (agent layer)** — becomes a consumer of Optimus signals via the existing API surface; ceases to be the primary observation pipeline. This collapses two write paths into one.
- **Staqs ↔ UMB Tier-1 federation** — unaffected as a counterparty, but shares the org/aud JWT machinery; any change to issuance affects both. The two efforts can run in parallel because each writes to a distinct `origin_org`.

---

## Dependencies

- **ADR-007** — Federation Thesis (`spec/decisions/007-federation-thesis.md`)
- **ADR-018** — JWT Agent Identity (`autobot-inbox/docs/internal/adrs/018-jwt-agent-identity.md`), specifically the Federation Claim Extension addendum (2026-05-14)
- **STAQPRO-358** — Composite-iss JWT, landed 2026-05-16 (commit `133fdc4`, PR #214). Implements ADR-018 v2 claim set.
- **STAQPRO-359** — Neo4j `origin_org` migrate (commit `519e819`, PR #217; cleanup `a5dd1d3`). Provides the `origin_org` write/index path for M5 signals.
- **`spec/proposals/federation-tier1-staqs-umb.md`** — Tier-1 self-federation execution plan; m5-activity is effectively the second peer.
- **`spec/proposals/capability-receipt-envelope.md`** — receipt envelope v0.1.
- **`lib/audit/capability-receipt.js`** — ed25519 envelope implementation (RFC 8785 JCS canonicalization).
- **SPEC §3** (state_transitions), **§5** (sanitization), **§7** (Communication Gateway), **§9** (halt_signals).

---

## Open Questions

**(a) M5 ingester repo location.** Separate repo `staqsIO/optimus-m5-ingesters` or `m5-ingesters/` subdir in this monorepo (consumed at install time on M5)? Default proposal: separate repo, because the install lives on a single laptop and shouldn't churn the Optimus CI. Board decision needed before Ship 0.

**(b) Should `m5-activity` ingest the Obsidian vault as well?** Eric's vault is the externalized-memory layer that survives across sessions and Claude accounts. Treating vault writes as another transcript stream would make vault edits queryable alongside Claude Code transcripts. Trade-off: vault may contain client material that shouldn't go through Optimus sanitization-then-storage. Defer to post-Ship-1 measurement.

**(c) Multi-machine generalization.** If/when Eric works on the M4 as well as the M5, do we issue a third org DID (`did:web:eric-m4.staqs.io`), or treat all of Eric's personal hardware as one `did:web:eric.staqs.io` peer? The federation framework supports both. The cleaner audit story is per-machine; the operationally simpler story is per-person. Resolve before the second machine is wired.
