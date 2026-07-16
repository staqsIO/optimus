-- Migration 016: Add metadata column to campaigns table
-- Fixes: GET /api/campaigns/:id error (500): column "metadata" does not exist
-- The chat-first campaign builder (659a3bb) writes metadata but the column was never added.

ALTER TABLE agent_graph.campaigns
  ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';

ALTER TABLE agent_graph.campaigns
  ADD COLUMN IF NOT EXISTS source_intent_id TEXT;

ALTER TABLE agent_graph.campaigns
  ADD COLUMN IF NOT EXISTS created_by TEXT DEFAULT 'board';
