-- 032: Add resumed_at to campaigns for iteration filtering on retry.
-- When a campaign is resumed, resumed_at is set to now(). The campaign loop
-- filters iterations by created_at > resumed_at so old (pre-resume) iterations
-- don't trigger plateau detection. This respects the append-only constraint on
-- campaign_iterations (P3: transparency by structure).

ALTER TABLE agent_graph.campaigns ADD COLUMN IF NOT EXISTS resumed_at TIMESTAMPTZ;
