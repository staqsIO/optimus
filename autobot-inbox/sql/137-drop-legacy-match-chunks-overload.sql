-- 137-drop-legacy-match-chunks-overload.sql
--
-- SECURITY (tenancy live read-leak follow-up to migration 135).
--
-- Migration 135 made content.match_chunks fail-closed on owner_org_id by adding
-- a 10th param `filter_org_ids UUID[]` and DROPping the prior 9-arg SMALLINT
-- overload. But an ORIGINAL 4-arg overload created by migrations 012/013 —
--
--     content.match_chunks(vector(1536), INT, FLOAT, UUID)   -- filter_owner_id only
--
-- was never dropped (118 dropped the 9-arg TEXT shape, 135 dropped the 9-arg
-- SMALLINT shape; neither touched the 4-arg original). It survives in production
-- (verified via pg_proc: oid carried NO owner_org_id gate, NO filter_org_ids)
-- and is FAIL-OPEN — a caller resolving to it bypasses the org gate entirely.
--
-- It is also a function-resolution AMBIGUITY hazard: the new 10-arg function has
-- DEFAULTs on args 2..10, so a 4-positional-arg call could match BOTH the 4-arg
-- and the 10-arg signatures ("function is not unique"). The sole live caller
-- (lib/rag/retriever.js) passes all 10 args explicitly, so it resolves cleanly
-- today — but the legacy overload must go so nothing can resolve to the
-- ungated shape.
--
-- This migration drops ONLY the legacy 4-arg overload. The fail-closed 10-arg
-- function from migration 135 is left intact.
--
-- Idempotent + Supabase-safe: DROP FUNCTION IF EXISTS, no auth/pgcrypto touch.

DROP FUNCTION IF EXISTS content.match_chunks(
  vector(1536), INT, FLOAT, UUID
);
