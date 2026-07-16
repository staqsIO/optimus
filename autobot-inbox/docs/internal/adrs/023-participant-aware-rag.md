---
title: "Participant-Aware RAG"
status: Accepted
date: 2026-04-16
authors: [Carlos]
spec_refs: ["P2 (Infrastructure enforces)", "P3 (Transparency by structure)", "P4 (Boring infrastructure)"]
---

# ADR-023: Participant-Aware RAG

## Context

The RAG knowledge base indexes chunk *text* but loses *who was involved*. When a board member asked questions like "what happened in the meeting with John?", retrieval ran a vector search over chunk text only. Two failure modes:

1. **tl;dv transcripts**: the normalizer strips speaker-line prefixes (`[00:00](url) John:`) before embedding, so John's name may never appear in any chunk's text even when he attended and spoke extensively. Vector similarity on the content finds nothing about John → the model confidently answers "there was no meeting with John."
2. **Emails and Drive documents**: participant information exists in the raw payload (From/To/Cc, Drive owners/collaborators) but is dropped at ingest time, never reaching `content.documents.metadata` in structured form.

The `signal.contacts` directory existed but was not refreshed by ingest — the `signal.contact_accounts` junction was defined in migration 001 and never populated. A silent bug in `src/transcripts/action-extractor.js` tried to create contacts with `contact_type='meeting_participant'`, which violated the CHECK constraint and failed silently.

## Decision

Participants become first-class RAG metadata across every source, stored on the document record, indexed for fast retrieval, and kept in sync with `signal.contacts` as a side effect of ingest.

### Data model (migrations 056 + 057)

- `content.documents.participants` — JSONB array of `{ contact_id, name, email, role, confidence }`.
- GIN index `idx_documents_participants_gin` on `participants` using `jsonb_path_ops` for `@>` containment lookups.
- GIN index `idx_chunks_metadata_gin` on `content.chunks.metadata` so the existing `speakers[]` field on tl;dv chunks is indexable.
- `signal.contacts.contact_type` CHECK constraint expanded to include `'participant'` (fixes the silent failure in action-extractor).
- `content.match_chunks()` extended with two optional params:
  - `filter_participant_ids UUID[]` — hard filter (all ids must be in `d.participants`).
  - `boost_participant_ids UUID[]` — scoring hint; returns `participant_match BOOLEAN` so the JS retriever can nudge similarity.
- Return row gains `document_participants JSONB` so retrieval can render a "Meeting participants: …" header in the assembled context without a second round trip.

### Pipeline

- **Ingest** (`lib/rag/ingest.js`): after normalization, calls `lib/rag/participants/extractors.js` (source-specific raw-payload → uniform shape) then `lib/rag/participants/resolver.js` (resolve to `signal.contacts.id`, upsert contacts, populate `signal.contact_accounts`). Writes structured participants into the documents INSERT.
- **tl;dv**: no caller change — participants come from the normalized segments' `metadata.speaker`.
- **Email (bulk)**: `autobot-inbox/src/api-routes/documents.js` now requests Cc/Bcc headers and walks every message in the thread. Previously only the first message's headers drove the participants string.
- **Drive**: watcher and bulk routes expand the `files.list` field mask to include `owners`, `lastModifyingUser`, `sharingUser`.
- **Retrieval** (`lib/rag/retriever.js`): new `detectParticipantsInQuery` runs before query rewriting, extracts candidate names/emails via heuristics (capitalized tokens with stopword filtering; email regex), resolves against `signal.contacts`. Strong-intent phrasing (`meeting with X`, `email from X`) becomes a filter; softer mentions become a boost (+0.05 on similarity). Citations now carry `document_participants`, and the assembled answer prefixes each chunk with a `[Participants: …]` header when available.

### Resolution policy

The resolver's design principle: **contacts are only created when an email is available**. Name-only speakers (common in tl;dv, where only the display name is broadcast) are recorded on `content.documents.participants` with `contact_id: null, confidence: 'unresolved'`. This is the deliberate trade-off — synthesizing fake emails to satisfy the `email_address NOT NULL UNIQUE` constraint would pollute the contacts directory with sub-optimal fuzzy matches that compound over time. When an unresolved name is later matched to a real contact (e.g., the speaker sends an email from a known address), existing behavior already handles the join at retrieval time.

### Backfill

New CLI command `npm run cli -- backfill-participants --source <tldv|email|all>` iterates `content.documents`, re-parses `raw_text` (tl;dv) or `metadata.participants` (email backfill path), resolves, and writes. No re-embedding required — chunking is untouched.

Drive backfill is deferred because the original ingestion dropped `owners/permissions` entirely; the only way back is a per-file Drive API re-fetch, which belongs in a dedicated job.

## Consequences

**Gains**
- Queries like "meeting with John" now route to documents where John is a recorded participant, regardless of whether the chunk text names him. Context blocks include a participant header so the LLM reasons over who was there.
- `signal.contacts` and `signal.contact_accounts` are kept alive by ingest (P3: transparency by structure), closing a latent dead-code path.
- The silent `'meeting_participant'` bug in action-extractor is removed; it now uses the shared resolver.

**Trade-offs**
- Name-only tl;dv speakers don't become contacts automatically. Follow-up work: surface an unresolved-participants count in the daily briefing so the board can merge them when the person shows up with an email address.
- GIN indexes add write amplification on ingest; at current corpus size (~863 documents) this is negligible.
- `+0.05` boost is a magic number. Measurable performance tuning comes after running the new retriever on the existing `rag-eval-golden.json` set.

**Out of scope**
- Slack RAG ingestion (Slack isn't in RAG today).
- Cross-source contact merging UI (e.g. "John" from transcript + "john@example.com" from email → same person).
- Embedding participant headers *into* the vector itself (current boost/filter approach is a superset of what embedding would give us).

## References

- `spec/SPEC.md` §3 (task graph), §5 (guardrail enforcement)
- Migrations: `autobot-inbox/sql/056-rag-participants.sql`, `autobot-inbox/sql/057-match-chunks-participants.sql`
- Code: `lib/rag/participants/`, `lib/rag/query-participants.js`, `lib/rag/retriever.js`, `lib/rag/ingest.js`
- Tests: `autobot-inbox/test/participant-extractors.test.js`, `autobot-inbox/test/query-participants.test.js`
