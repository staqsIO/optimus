-- 055: Add 'contract' to content.drafts content_type check constraint
-- Required for executor-contract to store contract drafts.

ALTER TABLE content.drafts DROP CONSTRAINT IF EXISTS drafts_content_type_check;
ALTER TABLE content.drafts ADD CONSTRAINT drafts_content_type_check
  CHECK (content_type IN ('blog', 'linkedin', 'contract'));
