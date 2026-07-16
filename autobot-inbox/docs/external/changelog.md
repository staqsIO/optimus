---
title: "Changelog"
description: "Version history of AutoBot Inbox in Keep a Changelog format."
---

# Changelog

All notable changes to AutoBot Inbox are documented here. This changelog is written for the board -- it describes what changed from an operational perspective, not what code was modified.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added

- **Meeting Registry — one canonical record per meeting** (`/meetings/registry`) -- The same call captured through multiple doors (TL;DV's verbatim transcript, the Gemini Notes doc dropped in a watched Drive folder, a manual upload) now converges on ONE meeting record instead of scattering into look-alike duplicates. Convergence works by recovering the meeting's calendar event: when a capture arrives without one, the system matches it against synced Google Calendar events by time + title + attendee overlap, conservatively — an ambiguous or low-confidence match is left unlinked (marked "weak") rather than merged wrong, and upgrades automatically when the calendar later confirms it. Each meeting shows its capture sources with a deterministic "primary" pick (the curated Gemini Notes summary outranks the raw TL;DV transcript), and the meeting's extracted action items stay traceable to it. **Personal vs org capture stays consented**: if a board member's private note and the org's shared capture describe the same meeting, they remain separate records with a visible cross-link — the owner can explicitly *Promote to org*, which merges their copy into the shared record and keeps the personal one as audited lineage (never deleted, never auto-merged). A member of one org never sees that another org captured the same meeting. Aligns with feature spec 007 (`spec/features/007-meeting-note-hierarchy.md`).

### Operational Impact

Board members reviewing meetings no longer reconcile duplicates by hand: the registry view (linked from `/meetings`) is the canonical answer to "what happened in that meeting," regardless of which tool recorded it. TL;DV transcripts join the artifact registry only after an operator sets `TLDV_OWNER_ORG_ID` (explicit opt-in — unset keeps today's behavior). Drive-captured Gemini notes now also fire the meeting→work classifier, so org-folder captures produce action items exactly like TL;DV meetings do; the existing action-item dedup prevents double-creation when both sources see the same meeting.

- **Configurable "primary source" priority** (Source priority panel on `/meetings/registry`) -- Which capture wins as a meeting's primary transcript is no longer hardcoded. The default is Gemini Notes › TL;DV › Manual, but a board member can set a different **org-wide default**, and any member can set a **personal preference** that wins for their own meetings (teams that prefer the raw verbatim transcript can put TL;DV first). The panel shows the effective order, lets you reorder with up/down, and "Reset to inherited" drops back to the org (or system) default. Saving immediately re-picks the primary on existing meetings in that scope.

- **Google Calendar on the /calendar page** -- Scheduled Google Calendar events now show on the month grid and per-day right-rail panel alongside meetings, signals, and significant emails. Future days populate (previously empty by design); past days show what was *scheduled* in addition to what was *recorded* (TL;DV / Gemini Notes). Calendar events get a distinct emerald chip on day cells and render as a "Calendar" group at the top of the right-rail, separate from the existing violet "Meetings" group — so scheduled-vs-recorded stays visible at a glance. Multi-account / multi-calendar is managed from Settings → Calendar Watches: add an `account_email` + (optional) `calendar_id`, click Backfill to import history, and the live 5-minute poller picks the watch up going forward. Auth is the same Drive service account with `calendar.readonly` added to its delegated scopes (no per-user OAuth re-consent). Cancellations are kept (status='cancelled') so the day view can show "this meeting was on the calendar, then dropped." Architectural rationale in ADR-027.

- **Contracts module — full negotiation and execution workflow** -- The `/contracts` surface evolved from a list+edit view over drafts into a complete internal contracting product. All board-authored contracts now have version history, counterparty identity, RAG-grounded AI editing, signer-initiated redlines and comments, reply threads, governance gates at send time, work-items spawned from signed deliverables, board-only chain verification, Chromium-rendered PDF downloads with embedded audit trail, board-editable templates, and a cron-driven expiry + reminder sweeper.

### Operational Impact

The board can now run the entire contract lifecycle end-to-end without engineering involvement. Click `+ New` on `/contracts`, pick a counterparty (typeahead with inline create), pick a template (the 3 bundled ones or any authored on `/contracts/templates`), edit via the AI Bar using context pulled from inbox + meetings + KB, approve, send — and counterparties receive a signing link with a proper PDF attached to the confirmation when they sign. If a signer raises a redline, it lands in a proposals panel on the contract detail with Accept / Dismiss / Reply actions; accepting a redline can auto-revoke the current signing request, integrate the change (exact substring or LLM fuzzy reconcile if the board already edited around it), and auto-resend new signing links to the same signers. When the last signer completes, the signed contract's deliverables are extracted by Haiku and queued as `agent_graph.work_items` so the task graph sees them, and a `contract_signed` signal fires for any flow subscribed to that signal type. Board members receive a "fully signed" email with the final PDF; every signer receives their own archival copy of what they signed. The pre-send governance scan (G2 legal / G7 precedent) runs automatically when the Send form opens and blocks sends with severe findings unless the board supplies an override reason of at least 10 characters — the reason and the full findings snapshot are logged immutably to `content.send_overrides`. Reminder emails are rate-limited per signer (24h cooldown) and, in sequential mode, only nudge the current signer. A board-only `/verify/<contractId>` page renders the full hash chain with anchor-vs-recomputed comparison for any auditor moment. The deployment runbook at `docs/internal/runbooks/contracts-deploy.md` covers migrations (062–073), required env vars, Railway cron schedule, and Chromium install. Architectural rationale in ADR-024.

- **Knowledge base API reference** (`docs/external/api-knowledge-base.md`) -- Documents how board authentication vs service credentials scope document and RAG endpoints, including org-wide vs per-member documents and request body flags (`includeOrgWide`, `sharedDocumentsOnly`, `sharedWithOrg`).

---

## [0.9.0] - 2026-03-01

### Changed
- **Constitutional gates now channel-aware** -- The reviewer no longer assumes every draft is an email. Each constitutional gate now declares which action types it applies to, so the system can handle LinkedIn content posts (Phase 1.5) alongside email drafts without false-positive gate failures. Gates G2 (Legal language scan) and G7 (Pricing/timeline/policy commitments) apply universally to both email drafts and content posts. Gates G3 (Tone match), G5 (Reversibility), and G6 (Stakeholder rate limits) apply only to email drafts and are automatically skipped for content posts, since they depend on email-specific data like voice profiles and recipient lists.

### Operational Impact
For email, nothing changes -- every gate still fires on every email draft exactly as before. The difference is what happens when LinkedIn content posts start flowing through the pipeline in Phase 1.5: the reviewer will correctly enforce commitment language and precedent checks on content posts while skipping email-specific checks that would otherwise produce meaningless failures (e.g., measuring tone match against an email voice corpus for a LinkedIn post). Gate applicability is configured in `config/gates.json`, so the board can adjust which gates apply to which action types without code changes. The reviewer's skip decisions are logged with `skipped: true` for full audit visibility.

---

## [0.8.0] - 2026-03-01

### Changed
- **Unified action proposals table** -- All draft and action proposal data now lives in a single table (`agent_graph.action_proposals`) instead of separate tables per channel. Email drafts, LinkedIn content posts, and any future channel types share one review queue, one state machine (`pending -> reviewed -> approved -> staged -> delivered / cancelled`), and one set of metrics. Previously, adding a new channel meant creating a new drafts table and duplicating review logic; now it means adding one row type. Cross-channel metrics (edit rate, approval rate, draft accuracy) are computed from one table instead of stitching together separate queries per channel.
- **Migration range expanded** from 000-027 to 000-028

### Operational Impact
The board's day-to-day workflow is unchanged -- the dashboard draft review queue, CLI approve/reject commands, and all metrics pages continue to work identically. Behind the scenes, this restructuring eliminates the need to build separate draft plumbing for each new channel. Phase 1.5 LinkedIn content automation will use the same review queue and approval flow that email drafts already use, with no additional setup. A backwards-compatible view ensures any existing queries or bookmarks referencing the old table name continue to return correct results during the transition period.

---

## [0.7.0] - 2026-03-01

### Added
- **Voice feedback loop** -- The system now learns from the board's corrections. When you edit a draft (changing a greeting, adjusting tone, fixing vocabulary), those edits are analyzed and fed back into voice profiles and future draft generation. Previously, edits were recorded but never read back -- the AI would repeat the same mistakes. Now it sees a "past corrections" section showing recent edits you made, so it avoids patterns you have already corrected. Over time, this should reduce the edit rate as the system internalizes your preferences.
- **Automatic profile rebuilding** -- After every 5 edits accumulate, voice profiles are automatically rebuilt with the latest correction patterns merged in. No manual intervention is needed; the system continuously improves in the background.
- **`voice rebuild` CLI command** -- Manually trigger a voice profile rebuild at any time. Useful after a batch of corrections or if you want to force the system to incorporate recent edits immediately. Also available as `POST /api/voice/rebuild` for dashboard or programmatic use.

### Fixed
- **Edit delta recording accuracy** -- The dashboard edit flow was not properly classifying edit types (greeting change vs. tone adjustment vs. vocabulary override) or calculating how significant each edit was. Edits are now fully analyzed, which means the feedback loop has accurate data to learn from.

### Operational Impact
The combination of these changes means the system should make fewer repeated mistakes over time. Each correction you make teaches the AI something specific -- if you consistently change "Dear" to "Hey", the system will learn that preference and stop using "Dear" in future drafts for that recipient. The board should see draft quality steadily improve as more corrections are recorded, and the 14-day edit rate (M4) should trend downward.

---

## [0.6.0] - 2026-03-01

### Added
- **Provider-agnostic agent pipeline** -- Agents no longer know which email provider delivered a message. A new adapter registry routes messages to the correct provider (Gmail, Outlook, Slack) automatically based on message metadata. Adding a new provider (e.g., IMAP, Microsoft 365) now requires only writing an adapter -- no agent changes needed.
- **Outlook email support** -- Full Outlook adapter with OAuth setup, draft creation, and board-approved send via Microsoft Graph API. Outlook emails flow through the same six-agent pipeline and constitutional gates as Gmail messages.
- **Centralized message fetching** -- Email body retrieval is now handled once by the context-loader before any agent sees the message, instead of each agent fetching independently. This reduces redundant API calls and eliminates provider-specific logic from agent code.
- **Adapter registry test suite** -- 12 test cases covering adapter registration, lookup, message routing, and edge cases. Total test count: 160 passing.

### Fixed
- **Strategist fetch failures in multi-account setups** -- The strategist agent was calling the email body fetch function with a missing parameter, which could cause silent failures when processing emails from accounts other than the default. Fixed by centralizing all body fetching in the context-loader.
- **Silent error swallowing during message fetch** -- Real API errors (auth expiration, network failures) were being silently caught alongside expected test fallbacks. Production fetch errors are now logged so issues are visible in operations.

### Changed
- Three agents (triage, responder, strategist) no longer import Gmail client code directly -- they read message content from a shared context object provided by the pipeline

---

## [0.5.0] - 2026-03-01

### Added
- **Multi-channel adapter layer** -- Agents now process messages through InputAdapter/OutputAdapter interfaces instead of calling Gmail directly. Email and Slack adapters are implemented; adding a new channel requires only a new adapter, not agent modifications.
- **Config-driven agent selection** -- Agent instantiation is now driven by `config/agents.json`. Different installations can run different agent subsets by editing one JSON file, enabling per-user configuration (ADR-002: individual install).
- **Content schema** (Phase 1.5 groundwork) -- New `content` database schema with topic queue, content drafts, and reference posts tables for LinkedIn content automation. No content agent is live yet; this is the data layer foundation. Mirrors the inbox.drafts pattern with state machine, G5-equivalent board approval constraint, and pgvector embeddings for few-shot selection.
- Architecture Decision Records: ADR-008 (adapter pattern for multi-channel), ADR-009 (config-driven agent selection)

### Changed
- Database now has five isolated schemas (added `content` alongside `agent_graph`, `inbox`, `voice`, `signal`)
- Migration range expanded from 000-022 to 000-023
- Aligns with spec v0.7.0

### Decisions
- **DEN/DOM proposal deferred** -- Dustin's Delegate Executive Network / Delegate Operations Manager proposal (conversation/011) acknowledged but deferred to post-Phase 1 completion. Current priority is shipping the email pipeline end-to-end before adding governance complexity.

---

## [0.4.0] - 2026-02-28

### Added
- Stress test tool for validating end-to-end pipeline throughput -- injects batches of test emails and monitors processing through triage, drafting, and review
- Full pipeline operational: 15 test emails triaged, 8 drafts generated and reviewed, all constitutional gates enforced

### Changed
- Pipeline routing now uses state_changed events for agent-to-agent handoff, fixing an issue where work items could stall between agents
- Guard check logic corrected to properly evaluate gate results before advancing drafts to board review

### Fixed
- Work items no longer get stuck between triage and responder stages due to missing event routing
- Gate enforcement now correctly blocks drafts that fail constitutional checks rather than passing them through with warnings

### Metrics
- Average cost per email: $0.004
- End-to-end pipeline latency: under 5 minutes for draft generation
- Gate enforcement rate: 100% of drafts checked against all applicable gates

---

## [0.3.0] - 2026-02-27

### Added
- Voice profile system: analyzes Eric's sent mail to learn writing patterns (greetings, closings, formality, average length) per recipient and globally
- Signal extraction: identifies contacts, trending topics, and upcoming deadlines from processed emails
- Daily briefing generation: produces a summary of inbox activity, action items, and extracted signals
- Docker Postgres support: option to run against a real Postgres instance instead of PGlite for production use

### Changed
- Database layer now supports both PGlite (embedded, for development) and Docker Postgres (for production)
- Responder agent now uses voice profiles and few-shot examples from similar sent emails when drafting replies

### Metrics
- Voice profiles built from sent mail corpus
- Signal extraction operational across all triage categories

---

## [0.2.0] - 2026-02-26

### Added
- Web dashboard (Next.js 15) with 10 pages: Home, Drafts, Pipeline, Metrics, Finance, Signals, Audit, Stats, Settings, System
- Draft review queue with split-pane view (original email on the left, AI draft on the right), gate status indicators, and inline editing
- Bulk draft actions: select multiple drafts and approve, send, or reject all at once
- Keyboard navigation for the draft review queue (j/k to navigate, x to select, o to expand)
- Finance page showing LLM cost breakdown by model and by agent
- Pipeline visualization showing work items and state transitions
- Phase 1 metrics page tracking all 13 success metrics from the spec
- Settings page with one-click Gmail OAuth connection flow
- System page with halt/resume controls, gate status, and dead man switch
- Real-time updates via server-sent events (SSE) -- dashboard stats refresh every 5 seconds
- API caching layer to prevent PGlite contention between agent queries and dashboard reads

### Changed
- API server now serves as the bridge between the database and the dashboard, with CORS restricted to localhost origins only

---

## [0.1.0] - 2026-02-25

### Added
- Six-agent pipeline: Orchestrator, Strategist, Triage, Responder, Reviewer, Architect
- Task graph engine: work items, edges, state transitions, and event-driven agent coordination via Postgres
- Gmail integration: OAuth setup, email polling every 60 seconds, on-demand body fetch (metadata-only storage)
- Triage classification: categorizes emails as action_required, needs_response, fyi, or noise
- Draft generation: AI-composed replies for emails needing a response
- Constitutional gate enforcement: all seven gates (G1 Financial, G2 Legal, G3 Reputational, G4 Autonomy, G5 Reversibility, G6 Stakeholder, G7 Precedent)
- Budget management: daily spend ceiling with atomic reservation before each LLM call
- CLI (command-line interface) with commands: inbox, review, send, briefing, stats, halt, resume, directive, voice
- Audit trail: append-only state_transitions table with hash chaining
- L0 autonomy enforcement: all drafts require board approval before sending
- PGlite embedded database: four isolated schemas (agent_graph, inbox, voice, signal) with no cross-schema foreign keys
- Database migrations (sql/000-009) as the DDL source of truth
- Graduated autonomy tracking: L0 exit criteria measured automatically (50+ drafts, edit rate below 10%, 14 days)
- Prompt injection defense: input sanitization on email content before passing to AI agents
