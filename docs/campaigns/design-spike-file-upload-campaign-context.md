# Design Spike: File Upload for LLM Campaign Context

**Status:** Draft — Board Review Required
**Date:** 2026-04-02
**Priority:** High
**Spike Author:** claw-campaigner (campaign design agent)

---

## Executive Summary

This spike proposes a four-phase implementation to add persistent file upload to the campaign creation workflow, wiring uploaded documents into the existing RAG pipeline so campaigns can retrieve specific context at runtime. The infrastructure (pgvector, chunker, embedder, retriever) is already in place — this feature is primarily **plumbing** from the upload UI down to the campaign context loader, not greenfield RAG work.

**Estimated risk:** Low-medium. The hard parts (RAG, pgvector, embeddings) already work. New risk surface is: security scanning integration, PDF parsing, and scoping RAG retrieval to a single campaign.

---

## Current State Assessment

### What already exists

| Component | Location | Status |
|-----------|----------|--------|
| Chat-first file upload UI | `board/src/app/campaigns/campaign-chat.tsx` | Partial — text only, 500KB, inline to LLM |
| RAG ingest pipeline | `lib/rag/ingest.js` | Complete — handles upload source |
| Chunker | `lib/rag/chunker.js` | Complete — 256–512 tokens, 50 overlap |
| Embedder | `lib/rag/embedder.js` | Complete — text-embedding-3-small, 1536-dim |
| Retriever | `lib/rag/retriever.js` | Complete — pgvector HNSW + brain-rag fallback |
| Document storage | `content.documents` + `content.chunks` | Complete — pgvector schema exists |
| Campaign context injection | `agents/claw-campaigner/strategy-planner.js` | Partial — no RAG query at iteration time |

### The gap

Files uploaded via campaign chat are:
1. Embedded inline in the LLM message (capped at 100KB per file, ephemeral)
2. Stored only as `{ name, size }` references in `campaign.metadata` JSONB (no content persisted)
3. Not ingested into the RAG pipeline
4. Not scoped to the campaign — anything retrievable is org-wide

**The fix:** persist uploaded files → ingest into RAG with campaign-scoped metadata → query at strategy-planning time.

---

## Implementation Plan

### Phase 1: Upload UI + Validation (Frontend)

**File:** `board/src/app/campaigns/campaign-chat.tsx`

**Changes:**
- Extend accepted types to include `.pdf` (currently text-only)
- Increase per-file limit from 500KB to 10MB (object storage will handle it)
- Add visual attachment list with file type icons + remove buttons
- On campaign create, POST files to `/api/campaigns/upload` before creating campaign
- Store returned `attachment_id[]` in campaign create payload

**PDF rendering:** Use browser-native `FileReader` + send raw bytes to backend for parsing — do not parse PDF in browser.

**Accepted types (Phase 1):**
```
text/plain (.txt)
text/markdown (.md)
application/pdf (.pdf)
```

**Validation (client-side, before upload):**
- MIME type check against allowed list
- File size: max 10MB per file, max 25MB total per campaign
- File count: max 5 files per campaign
- Empty file rejection

---

### Phase 2: Secure Storage + Campaign Association

#### New DB Migration: `014-campaign-attachments`

```sql
-- New table in agent_graph schema
CREATE TABLE agent_graph.campaign_attachments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id   UUID REFERENCES agent_graph.campaigns(id) ON DELETE CASCADE,
  document_id   UUID REFERENCES content.documents(id) ON DELETE SET NULL,
  original_name TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  size_bytes    INT NOT NULL,
  storage_key   TEXT NOT NULL,          -- S3/R2 object key
  scan_status   TEXT NOT NULL DEFAULT 'pending',  -- pending, clean, flagged, failed
  scan_result   JSONB,
  rag_status    TEXT NOT NULL DEFAULT 'pending',  -- pending, ingested, failed
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX ON agent_graph.campaign_attachments(campaign_id);
CREATE INDEX ON agent_graph.campaign_attachments(scan_status) WHERE scan_status = 'pending';
```

#### Storage Strategy: Cloudflare R2 (or S3-compatible)

Object key pattern: `campaigns/{campaign_id}/attachments/{attachment_id}/{original_name}`

Bucket policy:
- Private (no public access)
- Server-side encryption at rest
- Presigned URLs for download (15-minute TTL)
- Lifecycle: delete objects when campaign deleted (via webhook or scheduled job)

**No direct file content in DB** — `storage_key` is the pointer, consistent with D1 (metadata-only storage).

#### New API Endpoint: `POST /api/campaigns/upload`

```javascript
// Request: multipart/form-data
// Fields: files[] (up to 5 files)

// Response:
{
  attachments: [
    {
      id: uuid,
      original_name: string,
      mime_type: string,
      size_bytes: number,
      scan_status: "pending"
    }
  ]
}
```

Flow:
1. Receive files
2. Validate MIME type against allowlist (server-side, not just Content-Type header)
3. Validate file size
4. Upload to R2 under `campaigns/pending/{temp_id}/`
5. Insert into `campaign_attachments` with `scan_status: 'pending'`, no `campaign_id` yet (pre-creation)
6. Enqueue security scan job (see Phase 3)
7. Return attachment IDs

On campaign create (`POST /api/campaigns`), accept `attachment_ids: uuid[]` in body, update rows to set `campaign_id`.

---

### Phase 3: Security Scanning

**Scan triggers:** After upload, before RAG ingestion. RAG ingestion blocked until `scan_status = 'clean'`.

**Scanning layers (in order):**

| Layer | Implementation | Blocks ingestion? |
|-------|----------------|-------------------|
| MIME type validation | `file-type` npm package (reads magic bytes, not Content-Type header) | Yes |
| File size enforcement | Server check | Yes |
| Content sanitization | Strip null bytes, validate UTF-8 for text files | Yes |
| Malware scan | ClamAV (self-hosted via Docker) OR VirusTotal API (managed) | Yes |
| PDF structure validation | `pdf-parse` — reject malformed/encrypted PDFs | Yes |
| Content policy screen | Model Armor (already integrated for G6) | Warn only (flag, don't block) |

**ClamAV (recommended for Phase 1):** Already within infrastructure budget. Docker image `clamav/clamav:stable`. Stream file bytes to `clamdscan --stream`. Returns clean/infected + virus name.

**Scan job design:**
```javascript
// lib/scan/file-scanner.js
export async function scanAttachment(attachmentId) {
  // 1. Fetch from R2 (presigned URL)
  // 2. MIME magic bytes check
  // 3. ClamAV stream scan
  // 4. Update campaign_attachments.scan_status + scan_result
  // 5. If clean → emit 'attachment.scanned' event → trigger RAG ingest
  // 6. If flagged → notify board (Slack), set scan_status='flagged', do not ingest
}
```

Scan results stored in `scan_result JSONB`:
```json
{
  "mime_detected": "application/pdf",
  "mime_declared": "application/pdf",
  "clamav": { "clean": true, "engine_version": "1.3.1" },
  "content_policy": { "flagged": false }
}
```

---

### Phase 4: RAG Pipeline + Campaign Context Injection

This is the payoff phase. Uploaded files become queryable context at each campaign iteration.

#### Ingestion (post-scan)

When `scan_status` transitions to `'clean'`:

```javascript
// lib/rag/ingest.js — extend existing ingestDocument()
await ingestDocument({
  source: 'campaign_upload',
  sourceId: attachmentId,       // dedup key
  title: originalName,
  rawText: extractedText,       // see PDF extraction below
  format: detectFormat(mimeType),
  metadata: {
    campaign_id: campaignId,    // ← CRITICAL: scope to campaign
    attachment_id: attachmentId,
    file_type: mimeType,
  }
});
```

Update `campaign_attachments.document_id` and `rag_status = 'ingested'`.

**PDF text extraction:**
- Use `pdf-parse` (already acceptable per P4 boring deps) or `pdfjs-dist`
- Extract plain text only — no image OCR in Phase 1
- Reject encrypted/password-protected PDFs at scan phase

#### Campaign-Scoped Retrieval

The existing `content.match_chunks` SQL function accepts `owner_id` for user-scoping. We need to add **campaign_id scoping**.

**Option A: Filter in retriever (recommended for Phase 1)**
```javascript
// lib/rag/retriever.js — extend searchChunks()
export async function searchChunks(queryText, opts = {}) {
  const { matchCount = 30, minSimilarity = 0.15, ownerId, campaignId } = opts;

  // If campaignId provided, add metadata filter
  const campaignFilter = campaignId
    ? `AND d.metadata->>'campaign_id' = $4`
    : '';

  const sql = `
    SELECT c.text, c.metadata, 1 - (c.embedding <=> $1) AS similarity
    FROM content.chunks c
    JOIN content.documents d ON d.id = c.document_id
    WHERE 1 - (c.embedding <=> $1) > $3
    ${campaignFilter}
    ORDER BY c.embedding <=> $1
    LIMIT $2
  `;
  // ...
}
```

**Option B: Separate match function (cleaner, more DB-idiomatic)**
Add `content.match_campaign_chunks(query_embedding, campaign_id, match_count, min_similarity)` as a dedicated PG function. Preferred for Phase 2+.

#### Context Injection in Strategy Planner

```javascript
// agents/claw-campaigner/strategy-planner.js — extend buildStrategyPrompt()

// New: fetch campaign-scoped RAG context
const ragContext = await ragClient.getRAGContext(goal, {
  campaignId,           // scope to this campaign's uploaded files
  kbOnly: false,        // include campaign docs + org KB
  scope: 'campaign',
});

const strategyPrompt = `
${existingPromptParts}

## Uploaded Reference Documents
${ragContext.chunks.length > 0
  ? ragContext.chunks.map(c => `### ${c.metadata.title}\n${c.text}`).join('\n\n')
  : '(No uploaded documents for this campaign)'}

Use the reference documents above to inform your strategy and execution.
`;
```

This injects retrieved chunks directly into the strategy planner's context window at every iteration — the LLM sees the most relevant excerpts, not the entire file.

---

## Architecture Diagram

```
Campaign Creation Flow:
  User → campaign-chat.tsx
    → [selects files: .txt, .md, .pdf]
    → POST /api/campaigns/upload (multipart)
      → MIME validation (magic bytes)
      → R2 upload (storage_key)
      → campaign_attachments row (scan_status: pending)
      → enqueue scan job
    → [receives attachment_ids]
    → POST /api/campaigns (with attachment_ids[])
      → campaigns row created
      → attachment rows updated with campaign_id

Security Scan Job:
  attachment_id → fetch from R2
    → ClamAV stream scan
    → update scan_status (clean | flagged)
    → if clean → emit 'attachment.scanned'

RAG Ingestion (triggered by scan clean):
  attachmentId → fetch from R2
    → PDF parse / text extract
    → ingestDocument({ campaign_id in metadata })
      → normalize
      → chunk (256-512 tokens)
      → embed (text-embedding-3-small)
      → store content.documents + content.chunks
    → update attachment: rag_status = ingested

Campaign Runtime (each iteration):
  strategy-planner.js
    → searchChunks(goal, { campaignId })  ← scoped retrieval
    → inject top-k chunks into system prompt
    → LLM iterates with document context
```

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| PDF parsing fails (malformed/encrypted) | Medium | Low | Reject encrypted PDFs at scan, fallback to empty text with user notification |
| ClamAV false positive blocks legitimate file | Low | Medium | Expose flagged status in UI, allow board override |
| Large PDF degrades chunking quality | Medium | Medium | Cap extracted text at 500K chars pre-chunking |
| Campaign-scoped retrieval returns org-wide docs | Medium (if filter missed) | High | Unit test retrieval isolation before shipping |
| R2 costs exceed budget | Very Low | Low | Files < 10MB each, campaigns typically < 5 files |
| User uploads file with PII/sensitive data | Medium | Medium | Content policy scan (Model Armor G6) warns; user education |

---

## Phased Delivery Recommendation

| Phase | Scope | Effort | Unlocks |
|-------|-------|--------|---------|
| 1 | Upload UI (txt/md/pdf) + validation | 0.5 day | User can attach files to campaigns |
| 2 | R2 storage + campaign_attachments table | 1 day | Files persist across sessions |
| 3 | Security scanning (ClamAV) | 1 day | Safe ingestion gating |
| 4 | RAG ingestion + context injection | 1.5 days | LLM actually uses file content at runtime |

**Total: ~4 days.** Phases 1–2 can be built in parallel. Phase 3 can be stubbed (auto-approve small text files) to unblock Phase 4 earlier.

---

## Board Decisions Required

1. **Object storage:** Cloudflare R2 vs AWS S3 vs Supabase Storage? (R2 recommended — no egress costs, S3-compatible API)
2. **Malware scanning:** Self-hosted ClamAV vs VirusTotal API? (ClamAV recommended — no third-party data exposure)
3. **Scope of Phase 1 file types:** `.txt` + `.md` only first, add `.pdf` in Phase 2? Or all three at once?
4. **RAG injection strategy:** Campaign-scoped only, or blend with org KB? (Campaign-scoped first, opt-in org KB blend in Phase 2)

---

## Success Metrics

| Metric | Target |
|--------|--------|
| Files successfully uploaded and stored | 100% of submissions passing validation |
| Security scan false positive rate | < 1% |
| RAG retrieval relevance (cosine similarity avg) | ≥ 0.65 for campaign-uploaded docs |
| Campaign quality_score delta (with vs without docs) | ≥ +0.15 lift (measure over 20 campaigns) |
| Context injection latency overhead per iteration | < 500ms |

---

*Design spike produced by claw-campaigner. Requires board review before implementation begins.*
