---
title: "ADR-004: PGlite to Docker Postgres Migration"
description: "Migrated from PGlite (in-process) to Docker Postgres with pgvector for production use"
---

# ADR-004: PGlite to Docker Postgres Migration

**Date**: 2026-02-28
**Status**: Accepted
**Spec Reference**: SPEC.md -- P4 (Boring Infrastructure)

## Context

The initial implementation used PGlite (`@electric-sql/pglite`) -- an in-process Postgres engine compiled to WASM. PGlite was attractive for early development: zero setup, no Docker dependency, runs anywhere Node.js runs, and supports the Postgres wire protocol.

Three limitations drove the migration:

1. **No pgvector support for production workloads**: PGlite ships a vector extension, but its IVFFlat index performance is not suitable for the voice similarity searches required by G3 (tone match gate). The `voice.sent_emails` table uses `vector(1536)` embeddings with cosine similarity queries that need real pgvector.
2. **No `pg_notify`**: The spec calls for event-driven coordination via Postgres LISTEN/NOTIFY. PGlite does not support `pg_notify`, limiting the event bus to polling.
3. **Connection pooling**: PGlite is single-connection by design. The agent runtime runs 5+ agents concurrently, each needing transactional isolation (`SKIP LOCKED`, `FOR UPDATE NOWAIT`). PGlite's transaction model could not support concurrent agent claim operations.

## Decision

Production runs against a Docker Postgres container using the `pgvector/pgvector:pg17` image on port 5432. The container is named `autobot-postgres`.

The `db.js` module retains dual-mode support:

- **`DATABASE_URL` set** -> real Postgres via `pg.Pool` (max 5 connections, 30s idle timeout, 5s connect timeout)
- **`DATABASE_URL` unset** -> PGlite in-process (demo/dev/test)

Both modes expose the same API: `query()`, `withTransaction()`, `setAgentContext()`, `close()`. The PGlite path wraps transactions to provide pg-compatible `rowCount` (PGlite uses `affectedRows`).

Migration tracking uses a `public._migrations` table. Both modes run the same `sql/000-022` migration files on first launch, skipping already-applied files.

## Alternatives Considered

| Alternative | Pros | Cons | Why Rejected |
|-------------|------|------|-------------|
| PGlite only (keep as-is) | Zero ops; single binary | No pgvector perf; no pg_notify; no concurrent transactions | Three blocking limitations for production use |
| Supabase hosted | Managed service; built-in pgvector; connection pooling | Network latency for local dev; cost for always-on; requires internet | Adds operational dependency; Docker is simpler for a single-user system |
| SQLite + separate vector DB | Simpler DB; dedicated vector search | Two databases to manage; lose transactional guarantees across stores; violates P4 | Splitting data across stores creates consistency problems |
| Remove PGlite entirely | Simpler codebase (one path) | Lose zero-setup dev/demo mode; tests need Docker running | PGlite mode is valuable for `npm run demo` and test isolation |

## Consequences

### Positive
- Full pgvector with IVFFlat indexes for G3 tone matching
- `pg_notify` available for event-driven coordination
- `pg.Pool` with 5 connections supports concurrent agent operations
- `SKIP LOCKED` and `FOR UPDATE NOWAIT` work correctly under contention

### Negative
- Docker is now a production dependency
- Dual-mode `db.js` has two code paths to maintain (real Postgres vs PGlite)
- PGlite compatibility shims (e.g., `rowCount` vs `affectedRows`) may mask subtle behavioral differences

### Neutral
- Migration files (`sql/000-022`) work identically on both backends
- Hash chain computation is done in JavaScript (not pgcrypto) to maintain PGlite compatibility

## Affected Files

- `src/db.js` -- Dual-mode initialization, `getPgPool()` for real Postgres, `getPgLite()` for in-process
- `sql/000-extensions.sql` -- `CREATE EXTENSION IF NOT EXISTS vector` (pgvector)
- `sql/003-voice.sql` -- `embedding vector(1536)` column and IVFFlat index
- `src/runtime/state-machine.js` -- Hash chain computed in JS (not SQL `pgcrypto`) for PGlite compat
