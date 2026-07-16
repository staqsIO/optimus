-- =============================================================
-- Migration 014: Human-in-the-Loop (HITL) for Campaigns
--
-- Adds 'awaiting_input' campaign status and a table for storing
-- agent questions / operator answers.
-- =============================================================

-- 1. Extend the campaign_status CHECK constraint to include 'awaiting_input'
ALTER TABLE agent_graph.campaigns
  DROP CONSTRAINT IF EXISTS campaigns_campaign_status_check;

ALTER TABLE agent_graph.campaigns
  ADD CONSTRAINT campaigns_campaign_status_check
    CHECK (campaign_status IN (
      'pending_approval', 'approved', 'running',
      'paused', 'plateau_paused',
      'awaiting_input',
      'succeeded', 'failed', 'cancelled'
    ));

-- 2. HITL requests table
CREATE TABLE IF NOT EXISTS agent_graph.campaign_hitl_requests (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  campaign_id   TEXT NOT NULL REFERENCES agent_graph.campaigns(id) ON DELETE CASCADE,
  agent_id      TEXT NOT NULL,
  question      TEXT NOT NULL,
  answer        TEXT,
  status        TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'resolved', 'cancelled')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS hitl_by_campaign
  ON agent_graph.campaign_hitl_requests (campaign_id, status, created_at DESC);

COMMENT ON TABLE agent_graph.campaign_hitl_requests IS
  'Stores agent questions that pause a campaign and await human operator input (ADR-024).';
