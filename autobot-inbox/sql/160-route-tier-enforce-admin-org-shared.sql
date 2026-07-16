-- 160-route-tier-enforce-admin-org-shared.sql
-- OPT-37 (ADR-014 M5 enforce flip): move the `admin` and `org-shared` route tiers
-- from 'observe' → 'enforce'. These are the tiers the external customer surface
-- uses; enforcing them closes the identity holes the observe grace period left
-- open.
--
-- What this changes at runtime (identity gate, api.js middleware):
--   * admin (board-only): agent JWTs and bare API_SECRET (no x-board-user
--     identity) are now HARD-DENIED 403 on admin routes (halt/resume/governance/
--     board-members/models/customer-token admin/…). Board humans unaffected.
--   * org-shared (authed-any): unauthenticated callers are HARD-DENIED 401.
--     Authenticated board/agent/customer principals are unaffected at the identity
--     gate; org SCOPE remains the handler's visibleClause obligation (unchanged).
--
-- This is hot-reversible WITHOUT a redeploy (the middleware caches modes ~30s):
--   UPDATE agent_graph.route_tier_modes SET mode='observe', updated_at=now(),
--     updated_by='rollback' WHERE tier IN ('admin','org-shared');
--
-- viewer-scoped and ops-control INTENTIONALLY stay in observe for now — they
-- carry more legacy automation traffic and need their own bake (P5). The
-- customer ceiling (api.js) already hard-enforces customer-token isolation
-- independent of these modes, so external safety does NOT depend on this flip.

UPDATE agent_graph.route_tier_modes
   SET mode = 'enforce', updated_at = now(), updated_by = 'OPT-37 migration 160'
 WHERE tier IN ('admin', 'org-shared');

-- Defensive: if 143 never ran in this environment, ensure the rows exist enforcing.
INSERT INTO agent_graph.route_tier_modes (tier, mode, updated_by) VALUES
  ('admin',      'enforce', 'OPT-37 migration 160'),
  ('org-shared', 'enforce', 'OPT-37 migration 160')
ON CONFLICT (tier) DO UPDATE
  SET mode = 'enforce', updated_at = now(), updated_by = 'OPT-37 migration 160';
