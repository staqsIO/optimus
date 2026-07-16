-- 129-task-routing-event.sql
--
-- A-prime (spec/decisions/008-agent-native-governed-operating-layer.md):
-- "bridge requests, orchestrator assigns."
--
-- The signal-action-bridge (lib/runtime/signal-action-bridge.js) creates an
-- unassigned (assigned_to=NULL) autonomous work_item and then emits a
-- 'task_routing' INTENT event targeted at the orchestrator. The orchestrator —
-- the SOLE assigner — consumes it and assigns the existing work_item to the
-- target executor (executor-responder / executor-ticket). The bridge gets ZERO
-- assignment authority.
--
-- agent_graph.task_events.event_type carries an inline CHECK constraint
-- (001-baseline.sql:183) that did NOT include 'task_routing', so emit() would be
-- rejected with a 23514 check_violation. This migration extends the constraint.
--
-- Style: mirrors 106-contact-split.sql — DROP CONSTRAINT IF EXISTS then re-ADD
-- the full allow-list. CHECK constraints are additive-only: never remove a
-- value, only append (an in-flight event of a removed type would break).
--
-- LOCK PROFILE (Linus): a plain ADD CONSTRAINT ... CHECK takes ACCESS EXCLUSIVE
-- on task_events and BLOCKS while it full-table-scans to validate every existing
-- row — a hard stall on a hot, high-write table. Instead ADD the constraint
-- NOT VALID (a fast catalog-only change: new writes are checked immediately, the
-- existing-row scan is skipped) and then VALIDATE it in a SEPARATE statement.
-- VALIDATE takes only SHARE UPDATE EXCLUSIVE, which does NOT block reads or
-- writes. Net effect: the same enforced constraint, without the write stall.
--
-- Idempotent: DROP ... IF EXISTS + named ADD so a re-run is a clean replace.
-- VALIDATE is a no-op once the constraint is already valid. Run after 128.
-- Run off-peak: even SHARE UPDATE EXCLUSIVE during VALIDATE conflicts with DDL
-- and VACUUM, so schedule away from migration/maintenance windows.

ALTER TABLE agent_graph.task_events
  DROP CONSTRAINT IF EXISTS task_events_event_type_check;
ALTER TABLE agent_graph.task_events
  ADD CONSTRAINT task_events_event_type_check CHECK (event_type IN (
    'halt_signal', 'escalation_received', 'review_requested',
    'task_completed', 'task_assigned', 'task_created',
    'state_changed', 'draft_ready', 'approval_needed',
    -- A-prime: bridge → orchestrator routing intent (ADR-008).
    'task_routing'
  )) NOT VALID;
ALTER TABLE agent_graph.task_events
  VALIDATE CONSTRAINT task_events_event_type_check;

-- Grant-row safety net. The orchestrator → executor-responder / executor-ticket
-- rules already exist in 001-baseline.sql:4001/4004, so on an up-to-date DB these
-- are no-ops. They are re-asserted here (idempotent) so the A-prime assignment
-- path is guaranteed on any fresh DB regardless of baseline drift. NO rule is
-- added for signal-action-bridge — the whole point of A-prime is that the bridge
-- has zero assignment authority.
INSERT INTO agent_graph.agent_assignment_rules (agent_id, can_assign) VALUES
  ('orchestrator', 'executor-responder'),
  ('orchestrator', 'executor-ticket')
ON CONFLICT (agent_id, can_assign) DO NOTHING;
