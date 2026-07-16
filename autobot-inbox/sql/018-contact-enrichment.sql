-- 018-contact-enrichment.sql
-- Expand contact_projects platform CHECK to include linear and other

ALTER TABLE signal.contact_projects DROP CONSTRAINT IF EXISTS contact_projects_platform_check;
ALTER TABLE signal.contact_projects ADD CONSTRAINT contact_projects_platform_check
  CHECK (platform IN ('github', 'shopify', 'wordpress', 'vercel', 'linear', 'database', 'other'));
