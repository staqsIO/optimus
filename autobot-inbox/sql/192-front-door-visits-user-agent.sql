-- 178 — front_door_visits: capture raw User-Agent.
--
-- The classifier collapses every bot (GPTBot, ChatGPT-User, PerplexityBot,
-- ClaudeBot, Googlebot, scrapers, HTTP libs) into a single platform='agent'
-- bucket, so the visits table alone can never answer "which agents are actually
-- reaching the front door?" — the question the agent-readiness thesis hinges on.
-- This deliberately revises the 162 "no body" minimalism: the raw UA is the one
-- field needed to break agent traffic down per assistant (and to flag our own
-- synthetic test traffic). Nullable; capped at 512 chars in the handler. Still
-- no IP, no PII.

ALTER TABLE content.front_door_visits
  ADD COLUMN IF NOT EXISTS user_agent TEXT;

COMMENT ON COLUMN content.front_door_visits.user_agent IS
  'Raw request User-Agent (capped 512), captured 2026-06 to break agent traffic '
  'down per assistant; the platform column is classifier-collapsed.';
