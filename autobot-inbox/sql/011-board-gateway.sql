-- Board API Gateway infrastructure (Linus security review 2026-03-30)
-- Enables NemoClaw + external clients to authenticate via board member JWTs.

-- Token revocation table (jti blocklist)
-- Verified on every board JWT verification. Pruned periodically (expires_at).
CREATE TABLE IF NOT EXISTS agent_graph.token_revocations (
  jti         TEXT PRIMARY KEY,
  member_id   UUID REFERENCES agent_graph.board_members(id),
  revoked_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,  -- prune after token's natural expiry
  reason      TEXT
);

CREATE INDEX IF NOT EXISTS idx_token_revocations_member
  ON agent_graph.token_revocations(member_id);

CREATE INDEX IF NOT EXISTS idx_token_revocations_expires
  ON agent_graph.token_revocations(expires_at);

-- Rate limiting state (Postgres-backed, survives restarts)
CREATE TABLE IF NOT EXISTS agent_graph.gateway_rate_limits (
  member_id       UUID NOT NULL,
  window_start    TIMESTAMPTZ NOT NULL,
  request_count   INT NOT NULL DEFAULT 1,
  PRIMARY KEY (member_id, window_start)
);

-- Cleanup old windows (anything older than 5 minutes is irrelevant)
-- Called periodically by rate-limiter.js pruneRateLimits()
