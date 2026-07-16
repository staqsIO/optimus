-- 162-front-door-corpus.sql
-- Feature 008 Phase 1 (P1-B): intent×product head corpus store + minimal visit
-- telemetry for the progressive intent front door.
--
-- content.front_door_corpus — ONE row per (site_host, intent_slug). The head
-- corpus is pre-generated OFFLINE (tools/front-door/seed-corpus.js): intent
-- text is Model-Armor screened (fail-closed), products are ranked by
-- intent-matcher, copy is LLM-generated against a strict schema and sanitized
-- to plain text BEFORE insert. Serving paths:
--   - findCorpusMatch() (src/api-routes/front-door-corpus.js) — serve-by-match
--     for /api/redesign/submit, gated by FRONT_DOOR_SERVE_BY_MATCH.
--   - GET /api/front-door/corpus[...] — published-only read API consumed by
--     test-site frontends (first: altitudeguitar.com /intent/[slug] ISR pages).
--
-- payload is versioned structured JSON (v1: headline/subhead/sections/products/
-- faq/cta). products carry Shopify HANDLES ONLY — never price/stock snapshots;
-- the frontend re-fetches live, so catalog drift cannot serve stale offers.
-- html is NULL in Phase 1 (reserved for the agent-path full-HTML render).
--
-- Staleness: catalog_hash = sha256 over the sorted (handle,price) catalog at
-- generation time. The seed script's generate pass skips entries whose stored
-- hash still matches the live catalog; a mismatch flags copy for re-generation.
-- Manual re-run only — no cron in Phase 1 (P5: measure before automating).
--
-- safety_version pins REDESIGN_SAFETY_VERSION (lib/runtime/redesign-safety.js)
-- at generation time, mirroring the redesign dedup invariant: serving paths
-- only trust rows whose safety_version is current (re-screen on bump).
--
-- content.front_door_visits — append-only beacon telemetry (spec 008 §8
-- metrics: tier mix, corpus hit rate, rewrite rate). Deliberately MINIMAL: the
-- full provenance/attribution spine (conversation_id, intent_source, …) is
-- Phase 2 (§5/§10.1). No PII beyond path; no body, no IP.
--
-- DESIGN (P1/P2/P4): owner_org_id NOT NULL, no DEFAULT (stamped by the seeding
-- writer, never request bodies). No cross-schema FK. Idempotent. pgvector is in
-- the baseline (001); embedding is nullable — keyword fallback when no embedder.

CREATE TABLE IF NOT EXISTS content.front_door_corpus (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_org_id        UUID NOT NULL,          -- tenancy boundary; stamped by seeder
  site_host           TEXT NOT NULL,          -- e.g. 'altitudeguitar.com' (no www)
  intent_slug         TEXT NOT NULL,          -- URL-safe slug, e.g. 'best-beginner-acoustic-guitar'
  intent_text         TEXT NOT NULL,          -- canonical phrasing (Model-Armor screened)
  intent_variants     JSONB NOT NULL DEFAULT '[]'::jsonb,  -- alternate phrasings (string array)
  intent_embedding    VECTOR(1536),           -- NULL when embedder unavailable → keyword fallback
  payload             JSONB NOT NULL,         -- versioned copy JSON (v1), handles-only products
  html                TEXT,                   -- agent-path render; NULL in Phase 1
  catalog_hash        TEXT,                   -- sha256(sorted handle|price) at generation time
  safety_version      INT NOT NULL,           -- REDESIGN_SAFETY_VERSION at generation time
  publish_status      TEXT NOT NULL DEFAULT 'draft'
                        CHECK (publish_status IN ('draft', 'published', 'retired')),
  model               TEXT,                   -- generation model id (cost audit)
  generation_cost_usd NUMERIC,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (site_host, intent_slug)
);

-- Serving reads are always (site_host, published). 10–20 rows per site — no
-- vector index (in-JS cosine over the candidate set is the right shape; an
-- ivfflat index at this cardinality is pure overhead).
CREATE INDEX IF NOT EXISTS front_door_corpus_serve_idx
  ON content.front_door_corpus (site_host, publish_status);

COMMENT ON TABLE content.front_door_corpus IS
  'Feature 008 Phase 1: pre-generated intent×product head corpus. One row per '
  '(site_host, intent_slug); payload is versioned structured JSON with Shopify '
  'handles only (frontend re-fetches live). Seeded offline by '
  'tools/front-door/seed-corpus.js (screened, sanitized, Eric-approved intents); '
  'served by findCorpusMatch (flag-gated) and the published-only read API.';

CREATE TABLE IF NOT EXISTS content.front_door_visits (
  id                BIGSERIAL PRIMARY KEY,
  site_host         TEXT NOT NULL,
  tier              SMALLINT NOT NULL CHECK (tier IN (0, 1)),  -- declared tiers 2/3 are Phase 2/3
  platform          TEXT NOT NULL,            -- chatgpt | perplexity | claude | direct | …
  visitor_kind      TEXT NOT NULL,            -- human | agent
  path              TEXT NOT NULL,
  served_intent_slug TEXT,                    -- NULL = no intent page involved
  rewrite_applied   BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS front_door_visits_site_time_idx
  ON content.front_door_visits (site_host, created_at);

COMMENT ON TABLE content.front_door_visits IS
  'Feature 008 Phase 1: append-only front-door visit beacons (tier mix, corpus '
  'hit rate, rewrite rate — spec §8). Minimal by design: no IP, no body; the '
  'full provenance/attribution spine is Phase 2 (§5).';

DO $$ BEGIN
  RAISE NOTICE '[162] front door: content.front_door_corpus + content.front_door_visits (feature 008 Phase 1 P1-B)';
END $$;
