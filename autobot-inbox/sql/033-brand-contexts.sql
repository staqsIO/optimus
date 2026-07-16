-- Brand context cache for sharing design system data between executors.
-- Written by executor-redesign after analysis, read by orchestrator for executor-coder injection.
-- 24h TTL enforced at query time (expires_at column).

CREATE TABLE IF NOT EXISTS content.brand_contexts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_url TEXT NOT NULL,
  design_system JSONB NOT NULL,
  business_context JSONB,
  strategy_brief TEXT,
  lighthouse_before JSONB,
  source TEXT DEFAULT 'executor-redesign',
  expires_at TIMESTAMPTZ DEFAULT now() + INTERVAL '24 hours',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_brand_contexts_url ON content.brand_contexts(target_url);
CREATE INDEX IF NOT EXISTS idx_brand_contexts_expires ON content.brand_contexts(expires_at);

-- Cleanup: remove expired entries periodically (safe, no FK dependencies)
-- This can be called from a scheduled task or on each write.
