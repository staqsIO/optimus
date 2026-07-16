-- 025-campaign-recovery.sql
-- Per-campaign heartbeat for stale detection + recovery
-- See plan: zany-bouncing-ritchie.md

-- Heartbeat timestamp updated every iteration by the owning runner
ALTER TABLE agent_graph.campaigns ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ;

-- Runner identity for graceful shutdown release + debugging
ALTER TABLE agent_graph.campaigns ADD COLUMN IF NOT EXISTS claimed_by_runner TEXT;

-- Partial index for recovery scan: only running campaigns need checking
CREATE INDEX IF NOT EXISTS idx_campaigns_stale_recovery
  ON agent_graph.campaigns (campaign_status, last_heartbeat_at)
  WHERE campaign_status = 'running';
