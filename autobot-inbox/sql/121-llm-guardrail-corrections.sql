-- 121: inbox.llm_guardrail_corrections — operator "this was wrong" capture.
--
-- PRD: docs/internal/prds/meeting-actions-to-kanban-v0.2-tech-spec.md
--   - FR-22 (Settings → LLM Guardrails: capture button next to bad decisions)
--   - AD-6  (Guardrails are DB-stored, versioned, append-only — corrections
--           are attributed to the revision in effect at capture time)
--
-- Append-only audit trail. Each row captures one operator correction:
--   - guardrail_id: which revision the LLM was running under at capture
--     time. NULLABLE + ON DELETE SET NULL so corrections survive guardrail
--     deletion (audit history outlives the prompt that triggered it).
--   - task_id: optional pointer at the offending human_task row.
--   - description: free-text "what went wrong".
--   - captured_by, captured_at: actor + timestamp (P3 transparency).
-- No UPDATE path; never reassigned to a later revision (AD-6 attribution).

CREATE TABLE IF NOT EXISTS inbox.llm_guardrail_corrections (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  guardrail_id  TEXT REFERENCES inbox.llm_guardrails(id) ON DELETE SET NULL,
  task_id       TEXT,
  description   TEXT NOT NULL,
  captured_by   TEXT NOT NULL,
  captured_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE inbox.llm_guardrail_corrections IS
  'Append-only "this was wrong" capture against the LLM guardrail revision in effect at capture time (FR-22, AD-6). guardrail_id ON DELETE SET NULL so corrections outlive their guardrail.';

CREATE INDEX IF NOT EXISTS llm_guardrail_corrections_by_guardrail
  ON inbox.llm_guardrail_corrections (guardrail_id, captured_at DESC)
  WHERE guardrail_id IS NOT NULL;
