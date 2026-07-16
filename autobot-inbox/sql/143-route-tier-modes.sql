-- 143-route-tier-modes.sql
-- STAQPRO-542 (ADR-014 M5): DB-backed per-tier rollout flag for the route-tier
-- enforcement middleware.
--
-- The middleware classifies every route into a tier and consults this table for
-- that tier's mode. Mode is hot-flippable (no redeploy — avoids the Railway
-- identical-image gotcha; consistent with how halt works, P4).
--
-- PHASE 0 — OBSERVE ONLY. Every tier defaults to 'observe' (classify + log,
-- block nothing). This PR seeds NO tier to 'enforce' — the enforce flip per
-- tier is a follow-up after a clean prod bake (P5 measure-before-trust). The
-- middleware ALSO defaults to 'observe' if this table or a row is absent, so an
-- environment that hasn't run this migration (PGlite tests, mid-rollout prod)
-- is fail-safe to observe, never accidentally enforcing.
--
-- mode CHECK: only 'observe' | 'enforce' are valid.

CREATE TABLE IF NOT EXISTS agent_graph.route_tier_modes (
  tier        text PRIMARY KEY,
  mode        text NOT NULL DEFAULT 'observe' CHECK (mode IN ('observe', 'enforce')),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);

-- Seed all 7 tiers in observe. ON CONFLICT DO NOTHING so re-running the
-- migration never resets a tier an operator later flipped to enforce.
INSERT INTO agent_graph.route_tier_modes (tier, mode) VALUES
  ('public',         'observe'),
  ('webhook-authed', 'observe'),
  ('public-signing', 'observe'),
  ('ops-control',    'observe'),
  ('admin',          'observe'),
  ('org-shared',     'observe'),
  ('viewer-scoped',  'observe')
ON CONFLICT (tier) DO NOTHING;
