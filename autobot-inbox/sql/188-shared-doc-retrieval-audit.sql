-- 188-shared-doc-retrieval-audit.sql
-- ADR-017 #12 — Per-retrieval audit. Logs every RAG retrieval that surfaced
-- a chunk made visible via an active share_grant. Powers cross-org usage
-- reporting ("how often does UMB actually query Staqs's shared docs?") and
-- future billing without requiring schema upheaval later.
--
-- Design:
--   * Append-only. Rows are insert-only — never updated, never deleted (except
--     by retention policy, see below). P3 (transparency by structure).
--   * Fire-and-forget. The retriever inserts asynchronously; a failed insert
--     never breaks retrieval. We use SECURITY DEFINER so the insert runs even
--     under restrictive caller roles.
--   * Cheap. Single INSERT per chunk-with-shared_via in the result set,
--     deduped per (retrieval_id, document_id, grant_id) so the same query
--     returning 5 shared chunks → 5 rows, but a re-run of the same query is
--     a new retrieval_id and produces a new set. No aggregation tables yet —
--     the metrics surface (#governance) reads from this table directly with
--     date-bucketed COUNTs; partitioning kicks in once volume warrants.
--   * Retention. metadata.retention_until = ts + 365 days by default. A
--     future sweep job purges past this date. Not implemented in this
--     migration — the column is there so retention can be added without
--     migrating rows later.

CREATE SCHEMA IF NOT EXISTS audit;

CREATE TABLE IF NOT EXISTS audit.shared_doc_retrievals (
  id              BIGSERIAL PRIMARY KEY,
  retrieval_id    UUID NOT NULL,                    -- one per RAG call
  document_id     UUID NOT NULL,
  grant_id        UUID NOT NULL,                    -- snapshot at retrieval time (the matching share_grants row)
  granter_type    TEXT NOT NULL CHECK (granter_type IN ('user','org')),
  granter_id      UUID NOT NULL,
  target_type     TEXT NOT NULL CHECK (target_type IN ('user','group','org')),
  target_id       UUID NOT NULL,
  scope_type      TEXT NOT NULL,
  scope_ref       TEXT,
  caller_user_id  UUID,
  caller_org_ids  UUID[],
  query_excerpt   TEXT,                             -- first 200 chars of the query string (privacy-bounded)
  ts              TIMESTAMPTZ NOT NULL DEFAULT now(),
  retention_until TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '365 days'),
  UNIQUE (retrieval_id, document_id, grant_id)
);

CREATE INDEX IF NOT EXISTS shared_doc_retrievals_grant_ts_idx
  ON audit.shared_doc_retrievals(grant_id, ts DESC);
CREATE INDEX IF NOT EXISTS shared_doc_retrievals_caller_ts_idx
  ON audit.shared_doc_retrievals(caller_user_id, ts DESC) WHERE caller_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS shared_doc_retrievals_granter_ts_idx
  ON audit.shared_doc_retrievals(granter_type, granter_id, ts DESC);
CREATE INDEX IF NOT EXISTS shared_doc_retrievals_retention_idx
  ON audit.shared_doc_retrievals(retention_until) WHERE retention_until IS NOT NULL;

COMMENT ON TABLE audit.shared_doc_retrievals IS
  'Append-only per-retrieval audit (ADR-017 #12). One row per (retrieval_id, document_id, grant_id) triple. Drives cross-org sharing usage reports and any future per-query billing. Fire-and-forget inserts from lib/rag/retriever.js — a failed insert never breaks retrieval.';

-- A daily aggregate view for the /governance metrics panel. View, not a
-- materialized view: row counts are bounded by retention and the per-grant
-- indexes keep this fast.
CREATE OR REPLACE VIEW audit.shared_doc_retrievals_daily AS
SELECT
  date_trunc('day', ts) AS day,
  grant_id,
  granter_type, granter_id,
  target_type, target_id,
  count(*)::int AS retrieval_count,
  count(DISTINCT caller_user_id)::int AS distinct_callers,
  count(DISTINCT document_id)::int AS distinct_docs
FROM audit.shared_doc_retrievals
GROUP BY date_trunc('day', ts), grant_id, granter_type, granter_id, target_type, target_id;
