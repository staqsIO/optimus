# ADR-029: RAG Enrichment Architecture — Vault, Sent Mail, Board Chat, Contact Graph

**Status:** Proposed
**Date:** 2026-04-02
**Deciders:** Eric, Dustin
**Relates to:** SPEC §3 (Task Graph), §5 (Guardrails), ADR-012 (Document Ingestion)

## Context

The RAG pipeline (`lib/rag/`) ingests documents into `content.documents` + `content.chunks` with pgvector HNSW search. Currently 863 docs / 6663 chunks from Drive files and meeting transcripts. Four gaps:

1. **Obsidian vault** (~100+ notes) contains institutional knowledge agents cannot access
2. **Sent mail** is missing — agents see inbound only, not Eric's decisions and commitments
3. **Board chat** (`agent-chat.js`) answers from training data, never queries the knowledge base
4. **Contact enrichment** — `signal.contacts` has no project/repo/channel associations

## Decision

### Implementation Order

**Phase A: Board Chat RAG injection** (highest ROI, lowest effort)
**Phase B: Obsidian vault ingestion** (unlocks institutional memory)
**Phase C: Sent mail thread ingestion** (completes conversation context)
**Phase D: Contact enrichment** (builds the relationship graph)

Rationale: A is a 30-line change that makes all subsequent ingestion immediately useful. B and C feed the pipeline A enables. D depends on richer context from B+C for accurate association.

---

## Phase A: RAG Context in Board Chat

### What changes

Inject RAG retrieval into `agent-chat.js:handleAgentChat()` alongside the existing `gatherPipelineContext()` and `gatherAgentMetrics()` calls.

### Design

```
handleAgentChat(agentId, message, opts)
  │
  ├── gatherPipelineContext()     [existing]
  ├── gatherAgentMetrics()        [existing]
  └── retrieveContext(message)    [NEW — lib/rag/retriever.js]
       │
       └── searchChunks() → top-N chunks by cosine similarity
```

**Implementation:**

1. Import `retrieveContext` from `lib/rag/retriever.js` into `agent-chat.js`
2. Call it in the existing `Promise.all` alongside pipeline context and metrics
3. Append results as a `<knowledge_base>` block in the system prompt
4. Token budget: reuse existing `RAG_CONTEXT_MAX_TOKENS` (2200 tokens, ~8800 chars)

**Also wire into `autoRouteMessage`:** Before routing, do a lightweight RAG search. If top-match similarity > 0.5, include a hint in the system prompt so the agent knows relevant KB content exists.

### Cost impact

~$0.001-0.003 per chat message (one OpenAI embedding call). Already within G1 daily budget.

---

## Phase B: Obsidian Vault Ingestion

### Source

`~/vault` (iCloud-synced Obsidian vault). Key directories:
- `Memory/` — project states, session logs
- `Memory/Projects/` — per-project knowledge
- Research notes, architecture decisions

### Design

New normalizer: `lib/rag/normalizers/obsidian.js`

```
normalizeObsidian(markdown)
  ├── Strip wikilinks [[Page]] → "Page"
  ├── Strip Obsidian callouts > [!note] → plain text
  ├── Preserve YAML frontmatter as metadata (tags, date, project)
  ├── Split by ## headings (each heading = one segment)
  └── Return NormalizedSegment[] with metadata.heading, metadata.tags
```

New ingestion script: `scripts/ingest-vault.js`

```
1. Glob ~/vault/**/*.md (exclude .obsidian/, .trash/)
2. For each file:
   a. source = 'vault', sourceId = relative path (dedup key)
   b. Extract YAML frontmatter → metadata
   c. ingestDocument({ source: 'vault', format: 'obsidian', ... })
3. Track file mtime for incremental re-ingestion
```

**Incremental sync strategy:**
- Store `vault_sync_state` in `content.documents` metadata: `{ mtime, hash }`
- On re-run, skip files where mtime + hash match
- Modified files: delete old chunks, re-ingest (sourceId dedup handles this by checking existing)
- New approach: add `ON CONFLICT (source, source_id) DO UPDATE` to allow re-ingestion of modified files

### Wikilink resolution

Obsidian wikilinks (`[[Some Page]]`) become searchable text. No need to resolve to actual links — the RAG chunker treats them as entity references, which is actually better for semantic search (the page title IS the concept).

### Schema changes

None. Uses existing `content.documents` + `content.chunks`. Source type = `'vault'`.

Add to `ingestDocument` source check: `'vault'` (currently allows `'drive', 'email', 'upload', 'transcript', 'webhook'`).

---

## Phase C: Sent Mail Thread Ingestion

### Source

Gmail Sent folder. The voice system already analyzes sent mail for tone profiles (`src/voice/`), but the text content is not in the RAG pipeline.

### Design

New ingestion mode in the existing Gmail poll loop or as a separate scheduled task.

```
scripts/ingest-sent-mail.js
  │
  ├── List sent messages (Gmail API, after last-sync cursor)
  ├── For each thread with sent messages:
  │   a. Fetch full thread (sent + received interleaved)
  │   b. Format as conversation: "From: X\nTo: Y\nDate: Z\n\n<body>"
  │   c. source = 'email_sent', sourceId = threadId
  │   d. Metadata: { participants, subject, date, threadId }
  │   e. ingestDocument({ source: 'email_sent', format: 'plain', ... })
  └── Store sync cursor in content.documents metadata or a dedicated row
```

**Key design choice: Thread-level, not message-level.**
Ingest the full thread as one document. This preserves conversational context — a reply only makes sense with the message it responds to. The chunker's sliding window naturally creates chunks that span message boundaries.

**D1 compliance:** We store the text in `content.documents.raw_text` which is the RAG store, not `inbox.messages`. This is a knowledge base document, not email storage. The distinction matters: D1 says "never store body in DB [inbox schema]." The content schema is explicitly for document storage.

### Privacy/security

- G8 sanitization runs on all ingested content (existing pipeline)
- Only Eric's sent mail (single-user system)
- Sent mail contains Eric's decisions, pricing, commitments — high-value for G2/G7 context

---

## Phase D: Contact Enrichment

### Goal

When a message arrives from contact X, the system knows: "This person works on Project Y in repo Z, communicates via Slack channel #foo, and has 3 open Linear issues."

### Schema: `signal.contact_associations`

```sql
-- Migration: 017-contact-associations.sql

CREATE TABLE IF NOT EXISTS signal.contact_associations (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  contact_id      TEXT NOT NULL REFERENCES signal.contacts(id) ON DELETE CASCADE,
  association_type TEXT NOT NULL CHECK (association_type IN (
    'github_repo', 'linear_project', 'linear_issue',
    'slack_channel', 'domain', 'organization', 'tag'
  )),
  external_id     TEXT NOT NULL,      -- repo full name, project ID, channel ID, domain
  display_name    TEXT,               -- human-readable label
  confidence      NUMERIC(3,2) DEFAULT 1.0,  -- 1.0 = explicit, <1.0 = inferred
  source          TEXT NOT NULL,      -- 'github_pr', 'linear_assignee', 'email_domain', 'manual', 'agent_inferred'
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  interaction_count INTEGER NOT NULL DEFAULT 1,
  metadata        JSONB DEFAULT '{}',
  UNIQUE (contact_id, association_type, external_id)
);

CREATE INDEX idx_contact_assoc_contact ON signal.contact_associations(contact_id);
CREATE INDEX idx_contact_assoc_lookup ON signal.contact_associations(association_type, external_id);
CREATE INDEX idx_contact_assoc_type ON signal.contact_associations(association_type);
```

### Enrichment sources (automated)

| Source | Association Type | Trigger |
|--------|-----------------|---------|
| GitHub PR authors/reviewers | `github_repo` | PR webhook or claw-workshop |
| Linear issue assignees | `linear_project`, `linear_issue` | Linear webhook or poll |
| Email domain | `domain` | On contact creation (extract from email) |
| Slack channel membership | `slack_channel` | Slack API poll |
| Agent inference | `tag`, `organization` | executor-intake classifies context |

### Enrichment flow

```
lib/contacts/enricher.js

enrichContact(contactId)
  ├── lookupGitHubRepos(contactIdentities.github)
  ├── lookupLinearProjects(contactIdentities.email)
  ├── inferDomainAssociation(email_address)
  └── upsertAssociations(results)
```

**Trigger points:**
1. On contact creation (new sender)
2. On GitHub PR events (associate PR author with repo)
3. Periodic batch enrichment (weekly sweep)

### Integration with agent context

Extend `getRAGContext()` in `lib/rag/client.js`:

```javascript
// After sender RAG query, also load contact associations
const contactAssociations = await query(
  `SELECT ca.association_type, ca.display_name, ca.external_id, ca.interaction_count
   FROM signal.contact_associations ca
   JOIN signal.contact_identities ci ON ci.contact_id = ca.contact_id
   WHERE ci.channel = 'email' AND ci.identifier = $1
   ORDER BY ca.interaction_count DESC LIMIT 10`,
  [email.from_address]
);
```

Append to the knowledge base context block:
```
CONTACT ASSOCIATIONS (eric@example.com):
- GitHub: staqsIO/optimus (12 PRs), staqsIO/autobot-inbox (8 PRs)
- Linear: Project "Phase 1 MVP" (3 open issues)
- Domain: staqs.io (internal)
```

---

## Shared Infrastructure

### Normalizer registry extension

Register `obsidian` in `lib/rag/normalizers/index.js`:

```javascript
import { normalizeObsidian } from './obsidian.js';

const normalizers = {
  tldv: normalizeTldv,
  plain: normalizePlain,
  obsidian: normalizeObsidian,  // NEW
};
```

### Source type expansion

`ingestDocument` accepts any string for `source`. No code changes needed — the dedup check uses `(source, source_id)` composite. New source values:
- `vault` — Obsidian vault notes
- `email_sent` — Sent mail threads

### Re-ingestion support

Currently `ingestDocument` returns early on dedup match. For vault sync (files change), add an optional `forceUpdate` flag:

```javascript
export async function ingestDocument({ ..., forceUpdate = false }) {
  const existing = await query(...);
  if (existing.rows.length > 0) {
    if (!forceUpdate) return { documentId: existing.rows[0].id, ... };
    // Delete old chunks and update document
    await query('DELETE FROM content.chunks WHERE document_id = $1', [existing.rows[0].id]);
    await query('DELETE FROM content.documents WHERE id = $1', [existing.rows[0].id]);
  }
  // ... proceed with ingestion
}
```

---

## Implementation Plan

| Phase | Scope | Files Changed | Effort | Depends On |
|-------|-------|---------------|--------|------------|
| A | Board chat RAG | `src/commands/agent-chat.js` | 2h | Nothing |
| B | Vault ingestion | `lib/rag/normalizers/obsidian.js`, `scripts/ingest-vault.js`, `lib/rag/normalizers/index.js`, `lib/rag/ingest.js` | 4h | A (to see results) |
| C | Sent mail ingestion | `scripts/ingest-sent-mail.js`, `lib/rag/ingest.js` | 4h | A |
| D | Contact associations | `sql/017-contact-associations.sql`, `lib/contacts/enricher.js`, `lib/rag/client.js` | 6h | B, C (for richer context) |

Total: ~16h of implementation across 4 phases.

## Consequences

**Positive:**
- Agents gain institutional memory (vault), full conversation context (sent mail), and relationship awareness (contacts)
- Board chat becomes dramatically more useful — answers grounded in organizational knowledge
- Contact enrichment improves routing accuracy (know which project a sender relates to)
- All phases reuse existing RAG pipeline — no new infrastructure

**Negative:**
- Embedding costs increase (~$0.50-2.00 for initial vault + sent mail bulk ingestion)
- Vault sync needs iCloud to be current on the machine running ingestion
- Sent mail ingestion stores email body in content schema (technically different from inbox schema D1, but worth noting)

**Risks:**
- Vault notes may contain sensitive content — G8 sanitization handles injection, but PII/secrets in vault notes would enter the RAG. Mitigation: exclude specific vault paths (e.g., `Vault/Private/`)
- Sent mail volume could be large — use date cutoff (last 6 months) for initial ingestion
