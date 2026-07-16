# 004 — Capture, Enrich & the Artifact Manager (the company-brain ingress)

> Feature spec for the MCP/CLI capture layer that turns work created **elsewhere**
> (Claude sessions, PRDs, proposals, transcripts, Drive docs) into durable,
> searchable, **entity-linked** knowledge inside Optimus — so the team can adopt
> Optimus while still living in other tools, and we steadily move off them.
> Extends **OPT-37** (MCP + CLI access layer) and builds on **OPT-90 / STAQPRO-611**
> (the three capture write-tools, shipped). Status: **DESIGN COMPLETE — decisions
> D1–D4 resolved 2026-06-02 (Eric ✓); data model resolved by Liotta architecture
> pass 2026-06-02 (see "Resolved data model" below). Ready to implement item 1.**

## Context

OPT-90 gave us a safe **capture** surface: `optimus_ingest_document /
_transcript / _push_summary` → `POST /api/ingest` → `ingestDocument()` →
`content.documents` + chunks + embeddings, with token-derived ownership,
content-hash dedup, a per-user daily cap, and G8/PII gates. A captured doc is
**searchable** (`optimus_search_kb`).

But capture is not enrichment. `/api/ingest` **does not extract entities and does
not touch contacts or projects.** Eric's stated #1 priority — *"enrich all of our
contacts and projects with information generated from other systems, as fast as
possible"* — is precisely the layer that does not exist yet.

Two more gaps block the adoption goal:
- **No artifact manager.** `content.documents` is a RAG blob store; `engagements`
  and `lib/contracts/*` produce proposals/contracts. There is no first-class
  registry of *managed artifacts* (PRDs, proposals, specs, ADRs, briefs, decks)
  with type, version lineage, status, source system, and links to the entities
  they concern. The team has nowhere to "route a PRD through Optimus" and see it
  land, versioned and connected.
- **No auto-capture loops.** Everything is a manual MCP call. The compounding only
  happens when someone remembers to push.

The strategic frame (from `spec/strategy-onboarding-roundout.md`): make capture
*easy and confidence-inspiring* while the team is still on Linear/Notion/Drive,
capture the information when we want it, and let the system learn until our own
tools are the ones worth relying on.

### Design principle

Keep capture **fast and reliable**; do the heavy LLM enrichment **off the write
path**. Every write returns a **receipt** so the team *sees* the system working
("stored · searchable · linked to contact C + project P · 4 facts extracted").
Reuse what exists — the email signal extractor (`src/signal/`) and the
`extract_entities` flow-native (`autobot-inbox/agents/flow-agents/`) are the
enrichment engine; the artifact manager links to `content.documents`, it does not
replace it.

## User stories

- **As a teammate using Claude elsewhere**, when I finish a session my work is
  pushed into Optimus automatically (no extra steps), so the company brain
  compounds passively.
- **As a PM**, I route a PRD/proposal through Optimus (MCP, CLI, board upload, or a
  watched Drive folder) and it lands as a **typed, versioned artifact** linked to
  the right project and contacts.
- **As anyone**, when I open a contact or project I see the artifacts and facts
  captured about it from other systems — the entity is *enriched*, not empty.
- **As a builder**, I get a capture **receipt** confirming what was stored, that
  it's searchable, and which entities it was linked to — so I trust the capture.
- **As an external user / customer (OPT-37 horizon)**, I plug my own agent system
  into the same MCP/CLI surface with the same auth/ownership tiers.

## What to build

### Layer 1 — Capture (write tools), extend the existing three
- `optimus_ingest_artifact({ raw, kind, title, links })` — typed artifact:
  `prd | proposal | spec | adr | brief | deck | note`. Lands in the artifact
  registry **and** the KB (chunks/embeddings) in one call.
- `optimus_wiki_ingest({ source, raw })` — true wiki **source-write** (compile a
  source page + entity/concept updates), not just `wiki_compile` from the KB.
- `optimus_capture_url({ url })` — fetch + ingest a Drive doc / web page
  (reuse `lib/rag/normalizers/url.js`; fail clearly on auth-walled URLs).
- All inherit the OPT-90 invariants: token-derived ownership (caller-supplied
  ownership = 400), content-hash dedup, daily cap, G8/PII gates.

### Layer 2 — Enrich (the priority) — **async worker + receipt** (Decision D2)
- On every capture, emit `capture.ingested` via `pg_notify`.
- A new **enrichment worker/agent** consumes it: extract people/orgs/projects/
  topics (reuse `src/signal/` + `extract_entities`) → resolve against
  `signal.contacts`, projects, `engagements` → **link** + attach derived
  facts/signals with provenance back to the source artifact.
- **Linking authority (Decision D3):** auto-link above a confidence threshold;
  ambiguous matches go to a board **pending-links review queue**. No silent bad
  merges.
- On-demand: `optimus_enrich_contact(id)` / `optimus_enrich_project(id)` — "pull
  everything captured into this entity now."
- Capture receipt reports `enrichment: pending` immediately; the entity links and
  fact count appear when the worker completes.

### Layer 3 — Artifact Manager — **new `content.artifacts` registry** (Decision D1)
- New tables (finalized below): `content.artifacts` (`current_version_id` UUID FK,
  not a counter), `content.artifact_versions` (immutable lineage, pins one
  `content.documents` row), `content.artifact_entity_links`
  (`artifact_id → contact|project|engagement`, confidence, link_status). Points at
  the `content.documents` row(s) for RAG; does not duplicate chunk storage.
- Read tools: `optimus_list_artifacts`, `optimus_get_artifact`.
- Board: an **Artifacts** browser + an **Artifacts tab** on every contact /
  project / engagement detail; export/render via existing `lib/contracts`
  (docx/pdf, brand-aware).

### Layer 4 — Auto-capture loops — **Claude Code session hook first** (Decision D4)
- **First:** a Claude Code SessionEnd/Stop hook that auto-pushes each teammate's
  session summary + artifacts to `ingest_artifact` / `push_summary`. Documented
  one-line install in `team-agentic-sop.md`.
- Next (sequenced, not now): scheduled daily-summary Claude task; Drive-folder
  watcher (extend `src/drive`) → typed artifact; Gmail/Slack attachment capture;
  optional Linear/Notion webhooks for the transition window.

### Layer 5 — CLI parity
- `optimus ingest <file|->`, `optimus artifact add --kind prd <file>`,
  `optimus capture <url>`, `optimus push-summary`, `optimus search <q>`,
  `optimus enrich contact|project <id>`, `optimus watch <folder>` (auto-ingest),
  batch globs. Same Bearer-token/ownership model as the MCP.

### Layer 6 — Confidence / adoption UX
- **Capture receipts** on every write (stored · searchable · linked · facts).
- A board **"Captured" feed** with provenance (who/what/when/source system).
- Provisioning note: UMB members need a `tenancy.memberships` row or their pushes
  default to Staqs (a precondition, not a code path).

## Acceptance

- [ ] `optimus_ingest_artifact` writes a `content.artifacts` row (+ version + KB
  doc) with correct `owner_user_id` / `owner_org_id`; `optimus_get_artifact` and
  `optimus_search_kb` both retrieve it.
- [ ] Capturing a transcript/PRD that names a known contact + project produces, via
  the async worker, an `artifact_entity_links` row at/above threshold; an ambiguous
  name lands in the pending-links queue (no auto-merge).
- [ ] Opening that contact/project on the board shows the artifact under its
  Artifacts tab + the extracted facts.
- [ ] `optimus_wiki_ingest` creates a wiki source page + updates entity/concept
  pages (passes `wiki_lint`).
- [ ] The Claude Code session hook pushes a session artifact end-to-end with a
  receipt, zero manual steps.
- [ ] Staqs vs UMB scoping holds across all new write/read paths
  (`autobot-inbox/scripts/verify-tenancy-live.mjs`): a UMB user cannot see a
  Staqs-only artifact.
- [ ] `npm run test:ci` green. Linus review on the new external write surface +
  tenancy; Liotta sign-off on the artifact + enrichment data model.

## Decisions (resolved 2026-06-02 — Eric ✓)

- **D1. Artifact storage = new `content.artifacts` registry** (not extending
  `content.documents`). Artifacts are a distinct concept from RAG blobs; versioning
  + status + entity links live on the registry, which *points at* the KB.
- **D2. Enrichment = async worker + receipt.** Capture returns instantly; a
  `pg_notify`-driven enrichment agent extracts and links shortly after. Heavy LLM
  work stays off the write path; receipt shows `pending → done`.
- **D3. Linking = auto-link high-confidence, queue ambiguous.** A board pending-
  links surface resolves the ambiguous tail. Fast enrichment, no silent bad merges.
- **D4. First auto-capture loop = Claude Code session hook.** Captures the work the
  team is already doing — the strongest passive-compounding win — before the
  scheduled/folder/webhook loops.

## Resolved data model (Liotta architecture pass, 2026-06-02)

Boring infra throughout: raw parameterized SQL, no ORM, no cross-schema FK (the
entity links cross schemas → `(entity_type, entity_id TEXT)` with app-layer
integrity; `artifact_versions.document_id` is a same-schema FK into
`content.documents`, which is allowed).

**Tables (migration ~154):**
- `content.artifacts` — `id`, `kind` (prd/proposal/spec/adr/brief/deck/transcript/
  summary/doc/other), `title`, `status` (active/superseded/archived),
  `source_system` (mcp/claude-code/drive/linear/notion/manual), `identity_key`
  (server-derived, never caller-supplied — 602 class), `current_version_id` UUID
  FK, `owner_org_id` NOT NULL (no DEFAULT — mig-145-ready), `owner_id`, audit cols.
  **`UNIQUE (owner_org_id, identity_key)`** — dedup is per-tenant, not global.
- `content.artifact_versions` — immutable lineage; each version pins ONE
  `content.documents` row via `document_id`; `content_hash` (same hash
  `ingestDocument` derives) is the version key; `supersedes_id`;
  **`UNIQUE (artifact_id, content_hash)`** → identical re-push is an idempotent
  no-op. New bytes → `version_no = max+1`, then one UPDATE flips
  `artifacts.current_version_id`. Supersession is at the *version* level.
- `content.artifact_entity_links` — `(entity_type, entity_id, confidence,
  link_status: auto/pending/confirmed/rejected)`, `UNIQUE (artifact_id,
  entity_type, entity_id)`. Partial index `WHERE link_status='pending'` IS the
  board review queue.
- `content.derived_facts` — `(entity_type, entity_id, fact, artifact_id,
  document_id, span INT4RANGE NULL, confidence, provenance_hash UNIQUE)`. Every
  fact traces to artifact + document (+ optional span). `provenance_hash` makes
  re-enrichment idempotent → **write volume is bounded**.
- `content.enrichment_queue` — durable queue (`document_id, artifact_id,
  owner_org_id, status, attempts`). INSERTed in the *same transaction* as the
  artifact; an AFTER-INSERT trigger `pg_notify('capture_ingested', {ids})`.

**Enrichment worker** — a dedicated runtime worker
`lib/runtime/signals/artifact-enrichment-worker.js` (mirror
`human-task-enrichment-worker.js`). `LISTEN capture_ingested` for latency **+ a
30s poll of the queue** as the restart-safety backstop (notify is fire-and-forget;
the 087 lesson). Atomic claim (`UPDATE … SET status='processing' WHERE
status='pending' RETURNING`). Reuses the `extract_entities` flow-agent (Haiku,
$0.03/call) for extraction; worker self-enforces a hard daily G10 cap via
`dailySpendUsd('artifact-enricher')`. Retry-then-escalate after 3 attempts. A
flaky LLM call wedges one queue row, never capture (capture already returned).

**Confidence (deterministic, no ML)** — weighted additive scorer over
`signal.contacts` etc.: exact email +0.70 (the unique identity key), normalized
name +0.25, `pg_trgm` name similarity ≥0.6 +0.15, org/domain +0.10, project/
engagement context +0.10. **≥0.85 → auto-link · 0.55–0.85 → pending queue · <0.55
→ drop.** New-email person → insert contact (owner-stamped); name-only trigram
match → pending merge-suggestion, never a silent merge. Add the `pg_trgm`
extension (boring; we already run pgvector).

**Risks the board should hold (from Liotta):**
1. The 0.85 threshold is the trust fulcrum — **instrument auto-link precision as a
   day-one SLO** (sample auto-links weekly, track false-auto rate, tune the
   constant against data, not a guess). This must be *built in*.
2. `extract_entities` has no char offsets / person-org taxonomy yet — **ship v1
   with NULL spans** (artifact+document provenance is the load-bearing 90%); defer
   span precision rather than block the #1 enrichment loop.
3. The durable `enrichment_queue` + poll backstop is **non-negotiable** — without
   it the receipt's `pending → done` promise can't survive a deploy.

### Still open (OPT-37 horizon — not this feature)
Admin tier, per-customer token scoping, on-prem packaging.

## Decomposition (Linear, under OPT-13 / extends OPT-37) — resequenced per Liotta

Strictly sequential 1→2→3 (each is meaningless before the prior); 4 ships in
parallel once 1 lands; wiki + later loops are split into a follow-on feature.

1. **Artifact registry** (mig ~154) — `content.artifacts` + `artifact_versions` +
   `artifact_entity_links` + `derived_facts` + `enrichment_queue`; `ingest_artifact`
   + `capture_url` write-tools; `list/get_artifact` reads; capture receipts.
2. **Enrichment worker** — `capture_ingested` notify + durable-queue poll backstop;
   `extract_entities` → `pg_trgm` resolver → links + `derived_facts`; auto-link
   ≥0.85, pending queue 0.55–0.85; hard G10 cap.
3. **Board surfaces** — Artifacts browser, per-entity Artifacts tab, pending-links
   review queue, "Captured" feed, **+ auto-link precision SLO instrumentation**.
4. **Client surfaces** (merged) — Claude Code SessionEnd/Stop hook **+ `optimus`
   CLI** (ingest/artifact/capture/enrich/watch), one `team-agentic-sop.md` install.

**Split into a follow-on feature (005, later):** `optimus_wiki_ingest` wiki
source-write; scheduled daily-summary task; Drive-folder watcher; Gmail/Slack
attachment capture; Linear/Notion transition webhooks.
