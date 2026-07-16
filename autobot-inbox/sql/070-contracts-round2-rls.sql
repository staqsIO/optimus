-- 070: RLS hardening on the Phase 1–4 tables that shipped without it.
--
-- Background
-- ----------
-- Migrations 062 (draft_versions) and 065 (counterparties) shipped without
-- Row Level Security. The previous migration 054 (signature_requests /
-- signers / signature_events) does enable RLS with Supabase auth.uid()
-- policies, and 067 (signer_proposals) followed suit.
--
-- RLS here is defense-in-depth: the application backend uses the service
-- role which bypasses RLS, so this doesn't change day-to-day behavior.
-- What it buys: if someone accidentally proxies a counterparty or
-- draft_versions query through an anon-key connection (e.g. a future
-- client-side Supabase SDK call), the query returns empty instead of the
-- full table.
--
-- Both policies are permissive for authenticated users — single-tenant
-- internal scope. If we ever multi-tenant this module, these policies
-- need a tenancy join.

ALTER TABLE content.counterparties ENABLE ROW LEVEL SECURITY;

-- Postgres has no `CREATE POLICY IF NOT EXISTS`, so drop-then-create for idempotency.
DROP POLICY IF EXISTS "Authenticated users see counterparties" ON content.counterparties;
CREATE POLICY "Authenticated users see counterparties"
  ON content.counterparties
  FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- Explicitly deny anon writes — service role still bypasses these.
DROP POLICY IF EXISTS "Authenticated users write counterparties" ON content.counterparties;
CREATE POLICY "Authenticated users write counterparties"
  ON content.counterparties
  FOR ALL
  USING (auth.uid() IS NOT NULL)
  WITH CHECK (auth.uid() IS NOT NULL);

ALTER TABLE content.draft_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users see draft_versions" ON content.draft_versions;
CREATE POLICY "Authenticated users see draft_versions"
  ON content.draft_versions
  FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- draft_versions is append-only via append_draft_version() (SECURITY
-- INVOKER — runs as caller). Writes still go through the app backend's
-- service-role connection which bypasses RLS, so we don't need an INSERT
-- policy for application writes. The policy below covers the edge case
-- of an authenticated client attempting a direct insert.
DROP POLICY IF EXISTS "Authenticated users write draft_versions" ON content.draft_versions;
CREATE POLICY "Authenticated users write draft_versions"
  ON content.draft_versions
  FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

-- The immutability trigger already blocks UPDATE/DELETE from everyone,
-- service role included. No update/delete policies needed.

-- Verification:
--   SELECT tablename, rowsecurity FROM pg_tables
--    WHERE schemaname = 'content'
--      AND tablename IN ('counterparties', 'draft_versions');
--   -- Expected: rowsecurity = true on both
