---
title: "Knowledge base and RAG API"
description: "HTTP contract for documents, vector search, and RAG completion — including multi-board-member access rules."
---

# Knowledge base and RAG API

This document describes how the **documents** and **search** HTTP endpoints behave for different callers. The rules are enforced in **SQL and route handlers**, not in model prompts.

## Prerequisites

- Run database migrations through **`034-rag-match-chunks-tenant-classification.sql`** (and earlier migrations, including **`017-rag-classification.sql`** for document/chunk classification). Until those are applied, vector search may not match the server code.
- **Embedding provider** configured (`OPENAI_API_KEY` or equivalent) if you want local pgvector search to return results.

## Document ownership model

| `content.documents.owner_id` | Meaning |
|------------------------------|--------|
| `NULL` | **Org-wide** — shared corpus (e.g. explicit shared ingest, some bulk pipelines). Visible to every board member (and to unrestricted API callers). |
| UUID | **Per-member** — document belongs to that board member (`agent_graph.board_members.id`). Only that member (and unrestricted callers) can list, read, search, re-embed, or delete it via board auth. |

Ingestion tied to an inbox account typically sets `owner_id` from `inbox.accounts.owner_id`.

## Authentication and visibility

| Caller | How it is recognized | Document list, detail, stats, delete, re-embed | Vector search (`/api/documents/search`, `/api/search`) |
|--------|----------------------|--------------------------------------------------|--------------------------------------------------------|
| **Board JWT** | `auth.role === 'board'` and `auth.sub` = member UUID | **Scoped:** only rows where `owner_id IS NULL` **or** `owner_id = auth.sub`. | **Scoped** to that member: shared corpus **plus** their private docs (see body flags below). Cannot search or claim another member’s `ownerId` (returns **403**). |
| **API secret** | `auth.source === 'api_secret'` | **Full** visibility (no member filter). | **Full** unless you pass `ownerId` / flags in the JSON body. |
| **Agent JWT** | `auth.source === 'agent_jwt'` | **Full** visibility. | **Full** unless constrained by body parameters. |
| **No / other auth** | Depends on route; many document routes require auth. | If allowed, behaves like unrestricted for reads that succeed. | Body `ownerId` and flags apply as implemented in `document-access.js`. |

Operational tools should continue to use the API secret or agent JWT when they must see the whole corpus.

## Endpoints (summary)

| Method | Path | Purpose |
|--------|------|--------|
| `GET` | `/api/documents` | List documents (filtered for board JWT). |
| `GET` | `/api/documents/detail?id=` | Document + chunks (403 if board cannot read that `owner_id`). |
| `GET` | `/api/documents/stats` | Aggregate stats (filtered for board JWT). |
| `POST` | `/api/documents/ingest` | Ingest text; ownership resolved from auth + body (see below). |
| `POST` | `/api/documents/search` | Vector similarity search (chunk results). |
| `POST` | `/api/search` | Vector search + optional LLM synthesis over chunks. |
| `POST` | `/api/documents/reembed` | Re-embed a document (403 if board cannot read it). |
| `DELETE` | `/api/documents` | Soft-delete (403 if board cannot read it). |

Other ingest routes (email, Drive, URL, repo, etc.) set or omit `owner_id` according to their pipeline; the same **read** rules apply when a board user calls list/detail/search/stats.

## `POST /api/documents/ingest` body

| Field | Effect |
|-------|--------|
| `sharedWithOrg: true` | Stores document with **`owner_id: null`** (org-wide). |
| `ownerId` (board JWT) | Must equal **`auth.sub`** or be omitted (omitted defaults ingest to the authenticated member). Another member’s id → **403**. |
| `ownerId` (API secret / agent JWT) | Stored as provided (or null). |

## `POST /api/documents/search` and `POST /api/search` body

Common fields:

| Field | Default | Meaning |
|-------|---------|--------|
| `query` | required | Natural language search string. |
| `matchCount`, `minSimilarity` | optional | Passed through to retrieval. |
| `includeOrgWide` | `true` | When an effective `ownerId` is set, if **true**, search includes **org-wide** documents **and** that member’s private documents. If **false**, only that member’s private documents. |
| `sharedDocumentsOnly` | `false` | If **true**, search only **`owner_id IS NULL`** documents (org-wide corpus only). For **board JWT**, this is allowed; other member scopes do not apply. |
| `ownerId` | see auth table | For **board JWT**, ignored unless it matches **`auth.sub`**; default effective owner is **`auth.sub`**. For secret/agent, optional filter. |

If the server cannot reconcile `ownerId` with the board identity, the response is **403** with an error message such as `ownerId does not match authenticated board member`.

Classification ceilings (`max_classification` in the database function) default in application code for typical calls; service integrations can extend the API later to expose `maxClassification` explicitly if needed.

## Inbox agents and RAG (no HTTP caller)

When the runtime builds email context via **`getRAGContext`**, local retrieval uses **`message.owner_id`**: if present, search uses **org-wide + that member’s** documents; if absent, **org-wide only** so agents do not pull another member’s private corpus. No dashboard login change is required for that behavior.

## Related code

- `autobot-inbox/src/api-routes/document-access.js` — authoritative rules for list filters and search/ingest options.
- `autobot-inbox/sql/034-rag-match-chunks-tenant-classification.sql` — `content.match_chunks` signature and filters.
