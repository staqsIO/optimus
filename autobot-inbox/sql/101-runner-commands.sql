-- 101-runner-commands.sql
--
-- Control-plane table for issuing one-shot commands to runners (restart,
-- and later pause/resume). Each row is consumed once: runner.js polls for
-- WHERE runner_id = $self AND consumed_at IS NULL, marks consumed_at +
-- the consuming PID, then acts on the command. Pairs with the Phase 2
-- /api/runners/:id/restart endpoint and the Runners dashboard buttons
-- (STAQPRO-290).

CREATE TABLE IF NOT EXISTS agent_graph.runner_commands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  runner_id TEXT NOT NULL,
  command TEXT NOT NULL CHECK (command IN ('restart', 'pause', 'resume')),
  issued_by TEXT NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed_at TIMESTAMPTZ,
  consumed_by_pid TEXT,
  metadata JSONB
);

CREATE INDEX IF NOT EXISTS idx_runner_commands_pending
  ON agent_graph.runner_commands (runner_id, issued_at)
  WHERE consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_runner_commands_audit
  ON agent_graph.runner_commands (issued_at DESC);
