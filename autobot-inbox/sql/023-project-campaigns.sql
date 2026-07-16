-- Migration 023: Project deploy campaigns
-- Widen campaign_mode CHECK to include 'project' mode
-- Add cleanup_at for auto-cleanup of preview deploys

-- Widen campaign_mode CHECK
ALTER TABLE agent_graph.campaigns DROP CONSTRAINT IF EXISTS campaigns_campaign_mode_check;
ALTER TABLE agent_graph.campaigns ADD CONSTRAINT campaigns_campaign_mode_check
  CHECK (campaign_mode IN ('stateless', 'stateful', 'workshop', 'project'));

-- Add cleanup_at for auto-cleanup of preview deploys (7-day TTL after completion)
ALTER TABLE agent_graph.campaigns ADD COLUMN IF NOT EXISTS cleanup_at TIMESTAMPTZ;
