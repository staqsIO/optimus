-- Migration 130 — register the signal-action-bridge as an agent_config identity
--
-- Why: the signal→action bridge (lib/runtime/signal-action-bridge.js) creates
-- work_items with created_by='signal-action-bridge'. work_items.created_by has
-- a FOREIGN KEY (fk_work_items_created_by) to agent_graph.agent_configs(id), so
-- every LIVE bridge INSERT failed with 23503 until this row exists. The Phase 1
-- small-batch live test surfaced this (dry-run never reaches createWorkItem).
--
-- The bridge is NOT an LLM agent — it is a deterministic runtime pipeline
-- component with no model and no prompt. agent_type is constrained to
-- ('orchestrator','strategist','executor','reviewer','architect','board'); none
-- fits perfectly, so we use 'executor' (the closest: a non-initiating worker)
-- with model='none' and is_active=true. created_by then carries a real,
-- audit-meaningful identity that matches metadata.source on the work_item.
--
-- Deliberately granted ZERO assignment authority (no agent_assignment_rules row)
-- — A-prime (migration 129) keeps the orchestrator as the SOLE assigner; the
-- bridge only requests via the task_routing event.
--
-- Idempotent: ON CONFLICT (id) DO NOTHING. Run after 129.

INSERT INTO agent_graph.agent_configs
  (id, agent_type, model, system_prompt, config_hash, is_active)
VALUES
  ('signal-action-bridge', 'executor', 'none',
   'Deterministic signal->action bridge (ADR-008). Not an LLM agent; carries '
   'a created_by identity for work_items spawned from inbox.signals. Has no '
   'assignment authority — emits task_routing for the orchestrator to assign.',
   'signal-action-bridge-v1', true)
ON CONFLICT (id) DO NOTHING;

DO $$ BEGIN
  RAISE NOTICE '[130] agent_graph.agent_configs: signal-action-bridge identity registered (created_by FK satisfied)';
END $$;
