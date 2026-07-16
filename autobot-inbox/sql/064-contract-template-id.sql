-- 064: Explicit template_id for contract drafts.
--
-- Background
-- ----------
-- The board/src/app/contracts page derives the template by string-matching the
-- contract title ("nda" in title ⇒ NDA, "sow" ⇒ SOW, else service-proposal).
-- This breaks on any contract titled "Acme Non-Disclosure" if someone writes
-- "Non-Disclosure" differently, or a service proposal that happens to mention
-- the word "sow" somewhere. Template choice is made at create time — it should
-- be stored, not re-inferred forever from the title.
--
-- Change
-- ------
-- 1. content.drafts gains template_id TEXT (nullable — only contracts use it).
-- 2. Backfill: for existing contract drafts, apply the same heuristic the
--    frontend used so no behavior regresses. Future contracts get the explicit
--    value from POST /api/contracts/new.

ALTER TABLE content.drafts
  ADD COLUMN IF NOT EXISTS template_id TEXT;

COMMENT ON COLUMN content.drafts.template_id IS
  'Which template generated this draft. Currently one of "service-proposal", '
  '"nda", "sow". Only populated for content_type = contract. Set at create time; '
  'never inferred from the title after the draft exists.';

-- One-shot backfill using the legacy title heuristic
UPDATE content.drafts
SET template_id = CASE
  WHEN lower(title) LIKE '%nda%' OR lower(title) LIKE '%non-disclosure%' THEN 'nda'
  WHEN lower(title) LIKE '%sow%' OR lower(title) LIKE '%statement of work%' THEN 'sow'
  ELSE 'service-proposal'
END
WHERE content_type = 'contract' AND template_id IS NULL;

-- Verification:
--   SELECT template_id, count(*) FROM content.drafts
--   WHERE content_type = 'contract' GROUP BY 1 ORDER BY 2 DESC;
