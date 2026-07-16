# Optimus — STATE.md (Single Source of Truth)

_Last reconciled: 2026-05-30. Generated from Linear inventory (125 issues) + repo reality scan._

## 1. Current State per Linear Project

### Phase 1 — MVP Completion (107 issues)
| State | Count | Notes |
|---|---|---|
| Completed (Delivered) | 60 | ~56% of project |
| Backlog | 25 | Largest bucket of remaining work |
| Unstarted (In Planning / Todo) | 13 | **Dormant** — mostly the STAQPRO-85→98 Apr-07 roadmap cluster, untouched ~52d |
| Started (In Progress / In Dev) | 9 | 5 stale (>3wk), 4 active |

**Active started (healthy):** STAQPRO-252 (Urgent, Phase-1 exit gate, parent), 296, 301, 302.
**Stale started (needs decision):** STAQPRO-16 (61d — but CI file now exists, likely done), 90, 91 (52d, carlos), 99 (46d, isaias), 277 (21d, Eric).

### Phase 2 — Repeatable Install (18 issues)
| State | Count | Notes |
|---|---|---|
| Completed | 3 | STAQPRO-303 (RLS pool-role), 356 (ADR-007 primitives), 307 (RLS bypass fix) |
| Backlog | 14 | Federation (501/504/515/516/517), entity-resolution (265), budget/legal tracking |
| Started | 1 | STAQPRO-263 (JWT identity parent) — active 8d |

All Phase 2 work is owned by Eric except 5 unassigned tracking/policy issues (264, 266–270).

## 2. Wired-But-Unsurfaced Capabilities (backend exists, no/partial board UI)

| Capability | Backend | UI status | Gap |
|---|---|---|---|
| GitHub (issues/PRs/webhooks/app-auth) | `autobot-inbox/src/github/` | partial | No `/github` page; PRs only appear as links in `campaigns/[id]`. No first-class PR/issue view. |
| Telegram (listener/sender/actions) | `autobot-inbox/src/telegram/` | **none** | Only a contact-channel enum. No comms observability. |
| Signal briefings (briefing-gen/digest/recap) | `autobot-inbox/src/signal/` | partial | `/signals` is a rule editor, not a viewer. Generated briefings/digests never displayed. |
| TLDv meeting notes | `autobot-inbox/src/tldv/` | **yes** | Surfaced on `/meetings` + `/calendar` rail. (Browse/search depth could improve.) |
| Google Calendar (gcal_event) | `autobot-inbox/src/calendar/` | **yes** | Surfaced on `/calendar`. Connection/settings flow could be hardened. |
| Scheduled services (status/pause/resume/trigger) | `src/api-routes/services.js` | **none** | Zero board consumers. `/observability` is now a redirect to `/activity`. |
| Linear (client/ingest/classifier) | `autobot-inbox/src/linear/` | partial | Linked issues on task cards only; ingest/classify pipeline has no view. |

## 3. Doc-vs-Reality Discrepancies (corrected values)

| Doc | Stale claim | Corrected |
|---|---|---|
| `CLAUDE.md:67` | migrations "001 baseline through 128" | **001 → 130** (`130-signal-action-bridge-agent-config.sql`) |
| `CLAUDE.md:131` | "18 agents across 7 tiers" | **20 agents** in `config/agents.json` |
| `CLAUDE.md:95` | roadmap step 4 lists `phase1-metrics.js` + `campaign-promoter.js` as pending | **Both relocated already** — gone from `lib/runtime/`. Only `lib/contracts/*` + `lib/wiki/compiler.js` remain. |
| `autobot-inbox/CLAUDE.md` | "Five schemas: agent_graph, inbox, voice, signal, content" | **12 schemas** (adds signatures, engagements, autobot_comms/distrib/finance/public/value) |
| `CLAUDE.md` | implies `/observability` is a live page | Now a `redirect()` to `/activity`; SystemStatsPanel/AgentTimeline deferred |

## 4. Multi-Tenant Leak (CONFIRMED — top priority)

Verified application-layer bug: `board/.../inbox-proxy/route.ts` authenticates the session but never forwards viewer identity; backend `api_secret` path resolves to `adminBypass:true`, so every board member sees all drafts/contacts. **Not an RLS gap** — closeable in app layer today (see new Phase 2 Urgent issue). RLS pool-role flip (PR-B / STAQPRO-303) is a separate, already-shipped hardening layer.

## 5. Vision Re-Anchor — One Roadmap

North star (per MEMORY north-star): a **governed, agent-native operating layer** where the self-brain (Eric's inbox/voice/calendar) and the org-brain (Optimus task graph) are bridged, benchmarked against five reference shapes:

- **gbrain / company-brain (YC shape):** a brain you query, scoped by login. **Acceptance bar: zero-leak brain slice** — a logged-in member sees only their slice. → directly gated by the **multi-tenant scoping fix** (§4). This is the explicit pass/fail bar for "we have a company brain."
- **Symphony (monitor → spawn → proof-of-work → land PRs):** Linear-driven autonomous pipeline. → already partially live (claw-workshop, executor-coder, signal-action-bridge agent mig 129/130). Surface it via the GitHub PR view + scheduled-services panel.
- **Agent-native (agent + UI equal partners, context-aware, A2A):** → meeting-context loop (Calendar + TLDv, both surfaced) feeds agent context; A2A is the federation backlog.
- **Polsia (autonomous org / AutoBot end-state):** governance-first; the human board → constitutional layer. Long-arc.
- **zerohuman / hivemind / parslee:** deterministic pre-execution governance (P2), cross-agent memory, reversibility-gate replacing the human autonomy dial.

**Roadmap layers (scannable):**

1. **Trust foundation (do first):** Multi-tenant scoping fix (zero-leak bar) → unblocks the company-brain claim. Finish JWT enforcement (263 → PR-C / STAQPRO-304).
2. **Make existing power visible (Phase-1 MVP completion):** surface the 4 unsurfaced backends — GitHub PR view, Telegram comms panel, signal-briefing auto-display, scheduled-services/observability panel; harden Calendar connection settings.
3. **Meeting-context loop:** Calendar + TLDv → `:Meeting` nodes (STAQPRO-328) → agent context injection. Mostly wired; close the node-creation gap.
4. **Cross-surface learning:** signals from Slack/email/kanban/proposals → topic promoter (STAQPRO-300) → content + priority. Symphony-style proof-of-work loop.
5. **Federation + entity-resolution (Phase 2 / AutoBot precursor):** STAQPRO-501 (2nd instance, critical path) → 504 (grants table) → 515 (capability receipts) → 516 (grant/query endpoints) → 517 (Staqs↔UMB demo). Entity resolution: 265 / 322 / 308 feed the contact graph the federation demo joins across.
6. **End-state:** reversibility-gate + constitutional layer (Polsia/AutoBot).
