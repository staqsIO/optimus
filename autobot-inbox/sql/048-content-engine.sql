-- 048: Unified Content Engine schema (Phase 1.5)
-- Expands content schema from LinkedIn-only to blog + LinkedIn unified pipeline.
-- Blog posts are primary artifacts; LinkedIn posts are derived distribution format.

-- 1. Expand content.topics platform constraint to include 'blog'
ALTER TABLE content.topics
  DROP CONSTRAINT IF EXISTS topics_platform_check;
ALTER TABLE content.topics
  ADD CONSTRAINT topics_platform_check
  CHECK (platform IN ('linkedin', 'blog', 'both'));

-- 2. Add research metadata columns to topics
ALTER TABLE content.topics
  ADD COLUMN IF NOT EXISTS target_audience TEXT,
  ADD COLUMN IF NOT EXISTS seo_keywords TEXT[],
  ADD COLUMN IF NOT EXISTS research_brief JSONB DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS author TEXT,
  ADD COLUMN IF NOT EXISTS campaign_id TEXT;

-- 3. Content drafts — unified for blog and LinkedIn
-- Blog drafts store MDX + frontmatter; LinkedIn drafts store plain text.
-- Both go through content gates (G7, G8) before delivery.
CREATE TABLE IF NOT EXISTS content.drafts (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  topic_id        TEXT REFERENCES content.topics(id),
  campaign_id     TEXT,
  work_item_id    TEXT,
  content_type    TEXT NOT NULL CHECK (content_type IN ('blog', 'linkedin')),
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'review', 'approved', 'published', 'rejected'
  )),
  title           TEXT,
  slug            TEXT,
  author          TEXT,
  body            TEXT NOT NULL,
  frontmatter     JSONB DEFAULT '{}',
  seo_metadata    JSONB DEFAULT '{}',
  image_assets    JSONB DEFAULT '{}',
  gate_results    JSONB DEFAULT '{}',
  tone_score      NUMERIC(4,3),
  word_count      INTEGER,
  reading_time_min INTEGER,
  edit_delta      TEXT,
  source_draft_id UUID REFERENCES content.drafts(id),
  cost_usd        NUMERIC(10,6) DEFAULT 0,
  published_at    TIMESTAMPTZ,
  published_url   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_content_drafts_type_status
  ON content.drafts(content_type, status);

CREATE INDEX IF NOT EXISTS idx_content_drafts_topic
  ON content.drafts(topic_id);

CREATE INDEX IF NOT EXISTS idx_content_drafts_campaign
  ON content.drafts(campaign_id);

CREATE INDEX IF NOT EXISTS idx_content_drafts_slug
  ON content.drafts(slug) WHERE slug IS NOT NULL;

-- 4. Reference posts — voice-matched examples for tone calibration
-- Dustin's 4 annotated LinkedIn posts + future blog reference posts.
-- Embedded via pgvector for similarity search during content generation.
CREATE TABLE IF NOT EXISTS content.reference_posts (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  author          TEXT NOT NULL,
  platform        TEXT NOT NULL CHECK (platform IN ('linkedin', 'blog')),
  title           TEXT,
  body            TEXT NOT NULL,
  annotations     TEXT,
  topic_area      TEXT,
  embedding       vector(1536),
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reference_posts_author
  ON content.reference_posts(author, platform);

-- 5. Content gate results log — append-only audit trail (P3)
-- Records every gate check for content drafts (G7, G8, hard constraints).
CREATE TABLE IF NOT EXISTS content.gate_log (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  draft_id        UUID NOT NULL REFERENCES content.drafts(id),
  gate_name       TEXT NOT NULL,
  passed          BOOLEAN NOT NULL,
  details         JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_content_gate_log_draft
  ON content.gate_log(draft_id);
