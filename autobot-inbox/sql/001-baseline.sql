-- 001-baseline.sql
-- Squashed from migrations 001-012 (pre-production, 2026-03-18)
-- Single migration for all DDL, indexes, views, functions, and seed data.


-- ============================================================
-- FROM: 001
-- ============================================================

-- 001-extensions.sql
-- Required Postgres extensions for autobot-inbox
-- PGlite (in-process Postgres WASM) loads extensions via JS config.
-- gen_random_uuid() is built-in to PG13+ (no uuid-ossp needed).

-- pgvector for voice embeddings — optional on hosts without the extension
DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS "vector";
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pgvector not available — voice embedding features will be disabled';
END $$;

CREATE EXTENSION IF NOT EXISTS "pg_trgm";           -- trigram similarity for fuzzy text matching

-- ============================================================
-- FROM: 002
-- ============================================================

-- 002-schemas-and-tables.sql
-- Consolidated baseline: All schemas, tables, functions, triggers, RLS, roles
-- Squashed from migrations 001-044 (pre-production, no data to preserve)
-- Spec lineage: autobot-spec v0.8.0

-- ============================================================
-- SCHEMAS (10 total)
-- ============================================================
CREATE SCHEMA IF NOT EXISTS agent_graph;
CREATE SCHEMA IF NOT EXISTS inbox;
CREATE SCHEMA IF NOT EXISTS voice;
CREATE SCHEMA IF NOT EXISTS signal;
CREATE SCHEMA IF NOT EXISTS content;
CREATE SCHEMA IF NOT EXISTS autobot_public;
CREATE SCHEMA IF NOT EXISTS autobot_comms;
CREATE SCHEMA IF NOT EXISTS autobot_finance;
CREATE SCHEMA IF NOT EXISTS autobot_distrib;
CREATE SCHEMA IF NOT EXISTS autobot_value;

-- ============================================================
-- SCHEMA: agent_graph — Core task graph
-- ============================================================

-- Agent configurations
CREATE TABLE agent_graph.agent_configs (
  id              TEXT PRIMARY KEY,
  agent_type      TEXT NOT NULL CHECK (agent_type IN ('orchestrator', 'strategist', 'executor', 'reviewer', 'architect', 'board')),
  model           TEXT NOT NULL,
  system_prompt   TEXT NOT NULL,
  tools_allowed   TEXT[] NOT NULL DEFAULT '{}',
  config_hash     TEXT NOT NULL,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  can_assign_to   TEXT[] DEFAULT '{}',
  guardrails      TEXT[] DEFAULT '{}',
  fallback_model  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Agent config version history (append-only)
CREATE TABLE agent_graph.agent_config_history (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  agent_id        TEXT NOT NULL REFERENCES agent_graph.agent_configs(id),
  config_version  INTEGER NOT NULL,
  config_json     JSONB NOT NULL,
  config_hash     TEXT NOT NULL,
  prompt_text     TEXT NOT NULL,
  prompt_hash     TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agent_id, config_version)
);

-- Work items: nodes in the task DAG
CREATE TABLE agent_graph.work_items (
  id                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  type                TEXT NOT NULL CHECK (type IN ('directive', 'workstream', 'task', 'subtask')),
  title               TEXT NOT NULL,
  description         TEXT,
  status              TEXT NOT NULL DEFAULT 'created' CHECK (status IN (
    'created', 'assigned', 'in_progress', 'review',
    'completed', 'failed', 'blocked', 'timed_out', 'cancelled'
  )),
  assigned_to         TEXT REFERENCES agent_graph.agent_configs(id),
  created_by          TEXT NOT NULL,
  parent_id           TEXT REFERENCES agent_graph.work_items(id),
  priority            INTEGER NOT NULL DEFAULT 0,
  deadline            TIMESTAMPTZ,
  budget_usd          NUMERIC(15,6),
  data_classification TEXT NOT NULL DEFAULT 'INTERNAL' CHECK (data_classification IN (
    'PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'
  )),
  acceptance_criteria JSONB,
  routing_class       TEXT CHECK (routing_class IN ('DETERMINISTIC', 'LIGHTWEIGHT', 'FULL')),
  output_quarantined  BOOLEAN NOT NULL DEFAULT false,
  retry_count         INTEGER NOT NULL DEFAULT 0,
  delegation_depth    INTEGER NOT NULL DEFAULT 0,
  metadata            JSONB DEFAULT '{}',
  account_id          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON COLUMN agent_graph.work_items.delegation_depth IS
  'Auto-computed depth in task decomposition chain. 0 = top-level directive. Max enforced in guardCheck().';
COMMENT ON COLUMN agent_graph.work_items.account_id IS
  'Provenance: which business account originated this work item. NULL = legacy/pre-multi-account. No cross-schema FK per convention.';

-- Edges: typed DAG relationships
CREATE TABLE agent_graph.edges (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  from_id     TEXT NOT NULL REFERENCES agent_graph.work_items(id),
  to_id       TEXT NOT NULL REFERENCES agent_graph.work_items(id),
  edge_type   TEXT NOT NULL CHECK (edge_type IN ('decomposes_into', 'blocks', 'depends_on')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (from_id, to_id, edge_type),
  CHECK (from_id != to_id)
);

-- State transitions: append-only audit log (partitioned by month)
CREATE TABLE agent_graph.state_transitions (
  id                    TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  work_item_id          TEXT NOT NULL,
  from_state            TEXT NOT NULL,
  to_state              TEXT NOT NULL,
  agent_id              TEXT NOT NULL,
  config_hash           TEXT NOT NULL,
  reason                TEXT,
  guardrail_checks_json JSONB,
  cost_usd              NUMERIC(15,6) DEFAULT 0,
  hash_chain_prev       BYTEA,
  hash_chain_current    BYTEA,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE TABLE agent_graph.state_transitions_2026_01 PARTITION OF agent_graph.state_transitions
  FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE agent_graph.state_transitions_2026_02 PARTITION OF agent_graph.state_transitions
  FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
CREATE TABLE agent_graph.state_transitions_2026_03 PARTITION OF agent_graph.state_transitions
  FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
CREATE TABLE agent_graph.state_transitions_2026_04 PARTITION OF agent_graph.state_transitions
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE agent_graph.state_transitions_2026_05 PARTITION OF agent_graph.state_transitions
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE agent_graph.state_transitions_2026_06 PARTITION OF agent_graph.state_transitions
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE agent_graph.state_transitions_2026_07 PARTITION OF agent_graph.state_transitions
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE agent_graph.state_transitions_2026_08 PARTITION OF agent_graph.state_transitions
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE agent_graph.state_transitions_2026_09 PARTITION OF agent_graph.state_transitions
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE agent_graph.state_transitions_2026_10 PARTITION OF agent_graph.state_transitions
  FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE agent_graph.state_transitions_2026_11 PARTITION OF agent_graph.state_transitions
  FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE agent_graph.state_transitions_2026_12 PARTITION OF agent_graph.state_transitions
  FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
CREATE TABLE agent_graph.state_transitions_default PARTITION OF agent_graph.state_transitions DEFAULT;

-- Valid transitions: state machine definition
CREATE TABLE agent_graph.valid_transitions (
  id                   TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  from_state           TEXT NOT NULL,
  to_state             TEXT NOT NULL,
  allowed_roles        TEXT[] NOT NULL,
  required_guardrails  TEXT[] NOT NULL DEFAULT '{}',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (from_state, to_state)
);

-- Task events: outbox for event-driven dispatch
CREATE TABLE agent_graph.task_events (
  event_id        TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  event_type      TEXT NOT NULL CHECK (event_type IN (
    'halt_signal', 'escalation_received', 'review_requested',
    'task_completed', 'task_assigned', 'task_created',
    'state_changed', 'draft_ready', 'approval_needed'
  )),
  work_item_id    TEXT NOT NULL,
  target_agent_id TEXT NOT NULL,
  priority        INTEGER NOT NULL DEFAULT 0,
  event_data      JSONB DEFAULT '{}',
  idempotency_key TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at    TIMESTAMPTZ
);

COMMENT ON COLUMN agent_graph.task_events.idempotency_key IS
  'Optional dedup key. If set, prevents duplicate event processing. Format: <source>:<unique-id>';

-- LLM invocations: cost tracking
CREATE TABLE agent_graph.llm_invocations (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  agent_id        TEXT NOT NULL REFERENCES agent_graph.agent_configs(id),
  task_id         TEXT NOT NULL,
  model           TEXT NOT NULL,
  input_tokens    INTEGER NOT NULL,
  output_tokens   INTEGER NOT NULL,
  cost_usd        NUMERIC(15,6) NOT NULL,
  prompt_hash     TEXT NOT NULL,
  response_hash   TEXT NOT NULL,
  latency_ms      INTEGER,
  idempotency_key TEXT NOT NULL UNIQUE,
  account_id      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Budgets: allocation tracking
CREATE TABLE agent_graph.budgets (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  scope           TEXT NOT NULL CHECK (scope IN ('daily', 'monthly', 'directive', 'workstream')),
  scope_id        TEXT,
  allocated_usd   NUMERIC(15,6) NOT NULL,
  spent_usd       NUMERIC(15,6) NOT NULL DEFAULT 0,
  reserved_usd    NUMERIC(15,6) NOT NULL DEFAULT 0,
  period_start    DATE NOT NULL,
  period_end      DATE NOT NULL,
  account_id      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT budgets_no_overspend CHECK (spent_usd + reserved_usd <= allocated_usd)
);

-- Halt signals: persistent halt state (spec §9)
CREATE TABLE agent_graph.halt_signals (
  id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  signal_type  TEXT NOT NULL CHECK (signal_type IN ('financial', 'auditor', 'human', 'system')),
  reason       TEXT NOT NULL,
  triggered_by TEXT NOT NULL,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at  TIMESTAMPTZ,
  resolved_by  TEXT
);

-- Strategic decisions: full spec §19 schema
CREATE TABLE agent_graph.strategic_decisions (
  id                    TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  work_item_id          TEXT NOT NULL REFERENCES agent_graph.work_items(id),
  agent_id              TEXT NOT NULL REFERENCES agent_graph.agent_configs(id),
  decision_type         TEXT NOT NULL CHECK (decision_type IN ('tactical', 'strategic', 'existential')),
  proposed_action       TEXT NOT NULL,
  rationale             TEXT,
  alternatives_rejected JSONB DEFAULT '[]',
  kill_criteria         JSONB DEFAULT '[]',
  perspective_scores    JSONB DEFAULT '{}',
  confidence            INTEGER CHECK (confidence >= 1 AND confidence <= 5),
  recommendation        TEXT NOT NULL CHECK (recommendation IN ('proceed', 'defer', 'reject', 'escalate')),
  outcome               TEXT CHECK (outcome IN ('succeeded', 'failed', 'reversed')),
  superseded_by         TEXT REFERENCES agent_graph.strategic_decisions(id),
  dependent_decisions   TEXT[] DEFAULT '{}',
  board_verdict         TEXT CHECK (board_verdict IN ('approved', 'rejected', 'modified')),
  board_notes           TEXT,
  decided_by            TEXT,
  decided_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Tool hash registry (spec §6)
CREATE TABLE agent_graph.tool_registry (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tool_name       TEXT NOT NULL UNIQUE,
  tool_version    TEXT NOT NULL DEFAULT '1.0.0',
  tool_hash       TEXT NOT NULL,
  description     TEXT,
  allowed_agents  TEXT[] NOT NULL DEFAULT '{}',
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Tool invocation audit trail (append-only)
CREATE TABLE agent_graph.tool_invocations (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  agent_id        TEXT NOT NULL,
  tool_name       TEXT NOT NULL,
  params_hash     TEXT,
  result_summary  TEXT,
  duration_ms     INTEGER,
  success         BOOLEAN NOT NULL,
  error_message   TEXT,
  resource_type   TEXT NOT NULL DEFAULT 'tool' CHECK (resource_type IN ('tool', 'adapter', 'api_client', 'subprocess')),
  work_item_id    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Action proposals: unified cross-channel drafts (email, content, tickets, code fixes)
CREATE TABLE agent_graph.action_proposals (
  id                    TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  action_type           TEXT NOT NULL CHECK (action_type IN ('email_draft', 'content_post', 'ticket_create', 'code_fix_pr', 'feedback_receipt', 'research_report')),
  work_item_id          TEXT,

  -- Shared columns
  body                  TEXT NOT NULL,
  tone_score            NUMERIC(3,2) CHECK (tone_score IS NULL OR (tone_score >= 0 AND tone_score <= 1)),
  few_shot_ids          TEXT[] DEFAULT '{}',
  voice_profile_id      TEXT,

  -- Reviewer verdict
  reviewer_verdict      TEXT CHECK (reviewer_verdict IN ('approved', 'rejected', 'flagged')),
  reviewer_notes        TEXT,
  gate_results          JSONB DEFAULT '{}',

  -- Board action
  board_action          TEXT CHECK (board_action IN ('approved', 'edited', 'rejected')),
  board_edited_body     TEXT,
  board_notes           TEXT,
  acted_at              TIMESTAMPTZ,
  acted_by              TEXT,  -- board member identity (GitHub username or Telegram user ID)

  -- Unified send state
  send_state            TEXT NOT NULL DEFAULT 'pending' CHECK (send_state IN (
    'pending', 'reviewed', 'approved', 'staged', 'delivered', 'cancelled'
  )),

  -- Iteration
  version               INTEGER NOT NULL DEFAULT 1,
  previous_proposal_id  TEXT REFERENCES agent_graph.action_proposals(id),

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Email-specific columns (nullable)
  message_id            TEXT,
  subject               TEXT,
  to_addresses          TEXT[],
  cc_addresses          TEXT[] DEFAULT '{}',
  account_id            TEXT,
  email_summary         TEXT,
  draft_intent          TEXT,
  channel               TEXT CHECK (channel IS NULL OR channel IN ('email', 'slack', 'whatsapp', 'telegram')),
  provider              TEXT CHECK (provider IS NULL OR provider IN ('gmail', 'outlook', 'slack', 'telegram')),
  provider_draft_id     TEXT,
  provider_sent_id      TEXT,

  -- Content-specific columns (nullable)
  topic_id              TEXT,
  platform              TEXT CHECK (platform IS NULL OR platform IN ('linkedin')),
  constraint_violations TEXT[] DEFAULT '{}',
  published_at          TIMESTAMPTZ,
  platform_post_id      TEXT,

  -- Ticket/PR tracking columns
  linear_issue_id       TEXT,
  linear_issue_url      TEXT,
  github_issue_number   INTEGER,
  github_issue_url      TEXT,
  github_pr_number      INTEGER,
  github_pr_url         TEXT,
  target_repo           TEXT,

  -- Type discriminator constraints (P2: infrastructure enforces)
  CONSTRAINT action_proposals_email_requires_fields
    CHECK (action_type != 'email_draft' OR (message_id IS NOT NULL AND to_addresses IS NOT NULL AND channel IS NOT NULL)),
  CONSTRAINT action_proposals_content_requires_fields
    CHECK (action_type != 'content_post' OR topic_id IS NOT NULL),
  CONSTRAINT action_proposals_ticket_requires_fields
    CHECK (action_type != 'ticket_create' OR body IS NOT NULL),
  CONSTRAINT action_proposals_code_fix_requires_fields
    CHECK (action_type != 'code_fix_pr' OR (body IS NOT NULL AND target_repo IS NOT NULL)),
  -- G5 reversibility: can't reach 'delivered' without board approval
  CONSTRAINT action_proposals_g5_require_board_approval
    CHECK (send_state != 'delivered' OR board_action IS NOT NULL)
);

-- Board interventions
CREATE TABLE agent_graph.board_interventions (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  work_item_id TEXT,
  intervention_type TEXT NOT NULL CHECK (intervention_type IN ('constitutional', 'judgment')),
  action TEXT NOT NULL CHECK (action IN ('approve', 'reject', 'modify', 'escalate', 'override')),
  agent_recommendation TEXT,
  board_decision TEXT,
  rationale TEXT,
  board_member TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Constitutional evaluations (shadow mode)
CREATE TABLE agent_graph.constitutional_evaluations (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  work_item_id TEXT,
  decision_id TEXT,
  evaluation_mode TEXT NOT NULL DEFAULT 'shadow' CHECK (evaluation_mode IN ('shadow', 'active')),
  rules_checked JSONB NOT NULL DEFAULT '[]',
  overall_verdict TEXT NOT NULL CHECK (overall_verdict IN ('compliant', 'violation', 'warning')),
  would_have_blocked BOOLEAN NOT NULL DEFAULT false,
  actual_outcome TEXT,
  divergence_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Prompt drift tracking
CREATE TABLE agent_graph.prompt_drift_log (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  agent_id TEXT NOT NULL,
  original_prompt_hash TEXT NOT NULL,
  current_prompt_hash TEXT NOT NULL,
  cosine_similarity NUMERIC(5,4),
  drift_threshold NUMERIC(5,4) NOT NULL DEFAULT 0.95,
  is_within_budget BOOLEAN NOT NULL,
  modification_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Suggest-mode match tracking (feeds G4)
CREATE TABLE agent_graph.suggest_mode_log (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  decision_id TEXT,
  agent_recommendation TEXT NOT NULL,
  board_decision TEXT NOT NULL,
  matched BOOLEAN NOT NULL,
  mismatch_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Audit findings (three-tier audit system)
CREATE TABLE agent_graph.audit_findings (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  audit_tier INTEGER NOT NULL CHECK (audit_tier IN (1, 2, 3)),
  finding_type TEXT NOT NULL CHECK (finding_type IN (
    'constitutional_violation', 'behavioral_drift', 'guardrail_stale',
    'guardrail_conflict', 'prompt_drift', 'anomaly', 'cost_anomaly',
    'security', 'performance', 'compliance'
  )),
  severity TEXT NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low', 'info')),
  agent_id TEXT,
  description TEXT NOT NULL,
  evidence JSONB DEFAULT '{}',
  recommendation TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved', 'dismissed')),
  resolved_by TEXT,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Behavioral baselines per agent
CREATE TABLE agent_graph.behavioral_baselines (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  agent_id TEXT NOT NULL,
  metric_name TEXT NOT NULL,
  baseline_value NUMERIC NOT NULL,
  baseline_stddev NUMERIC NOT NULL,
  sample_count INTEGER NOT NULL,
  window_days INTEGER NOT NULL DEFAULT 7,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(agent_id, metric_name)
);

-- Audit run log
CREATE TABLE agent_graph.audit_runs (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  audit_tier INTEGER NOT NULL,
  model_used TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  findings_count INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  metadata JSONB DEFAULT '{}'
);

-- Sanitization rule sets (content-addressed)
CREATE TABLE agent_graph.sanitization_rule_sets (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  version         TEXT NOT NULL,
  sha256_hash     TEXT NOT NULL,
  rules           JSONB NOT NULL,
  categories      TEXT[] NOT NULL DEFAULT '{}',
  is_active       BOOLEAN NOT NULL DEFAULT false,
  approved_by     TEXT,
  test_pass_rate  NUMERIC,
  false_positive_rate NUMERIC,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Sanitization test results
CREATE TABLE agent_graph.sanitization_test_results (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  rule_set_id     TEXT NOT NULL REFERENCES agent_graph.sanitization_rule_sets(id),
  test_category   TEXT NOT NULL,
  total_tests     INTEGER NOT NULL,
  passed          INTEGER NOT NULL,
  false_positives INTEGER NOT NULL DEFAULT 0,
  false_negatives INTEGER NOT NULL DEFAULT 0,
  run_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Capability gates (Phase 2 → 3)
CREATE TABLE agent_graph.capability_gates (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  gate_id TEXT NOT NULL CHECK (gate_id IN ('G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7')),
  gate_name TEXT NOT NULL,
  measurement_value NUMERIC,
  threshold NUMERIC,
  is_passing BOOLEAN,
  measurement_window_days INTEGER,
  measured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'
);

-- Gate snapshots: daily snapshot of all gates
CREATE TABLE agent_graph.gate_snapshots (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  snapshot_date DATE NOT NULL,
  gates_passing INTEGER NOT NULL,
  gates_total INTEGER NOT NULL DEFAULT 7,
  all_passing BOOLEAN NOT NULL,
  consecutive_days_all_passing INTEGER NOT NULL DEFAULT 0,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Agent shadow mode (replacement protocol)
CREATE TABLE agent_graph.agent_shadow_mode (
  id                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  agent_id            TEXT NOT NULL,
  old_config_hash     TEXT,
  new_config_hash     TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'shadow' CHECK (status IN (
    'shadow', 'trust_level_1', 'trust_level_2', 'trust_level_3', 'completed', 'failed'
  )),
  tasks_processed     INTEGER NOT NULL DEFAULT 0,
  task_categories_seen TEXT[] NOT NULL DEFAULT '{}',
  divergence_count    INTEGER NOT NULL DEFAULT 0,
  total_comparisons   INTEGER NOT NULL DEFAULT 0,
  rejection_count     INTEGER NOT NULL DEFAULT 0,
  started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at        TIMESTAMPTZ,
  max_duration_days   INTEGER NOT NULL DEFAULT 7,
  min_tasks           INTEGER NOT NULL DEFAULT 50
);

-- Shadow mode output comparisons
CREATE TABLE agent_graph.shadow_mode_comparisons (
  id                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  shadow_run_id       TEXT NOT NULL,
  work_item_id        TEXT NOT NULL,
  original_output     JSONB,
  shadow_output       JSONB,
  is_divergent        BOOLEAN NOT NULL DEFAULT false,
  divergence_reason   TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Strategy evaluations (three-perspective protocol)
CREATE TABLE agent_graph.strategy_evaluations (
  id               TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  decision_id      TEXT NOT NULL REFERENCES agent_graph.strategic_decisions(id),
  evaluation_tier  TEXT NOT NULL CHECK (evaluation_tier IN ('tactical', 'strategic', 'existential')),
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'gathering_signals', 'evaluating', 'synthesizing', 'completed', 'escalated'
  )),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at     TIMESTAMPTZ
);

-- Perspective evaluations
CREATE TABLE agent_graph.perspective_evaluations (
  id                       TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  evaluation_id            TEXT NOT NULL REFERENCES agent_graph.strategy_evaluations(id),
  perspective              TEXT NOT NULL CHECK (perspective IN ('opportunity', 'risk', 'capability')),
  recommendation           TEXT CHECK (recommendation IN ('proceed', 'defer', 'reject', 'escalate')),
  confidence               INTEGER CHECK (confidence BETWEEN 1 AND 5),
  scores                   JSONB NOT NULL DEFAULT '{}',
  rationale                TEXT,
  kill_criteria            JSONB DEFAULT '[]',
  counter_evidence_required BOOLEAN DEFAULT false,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (evaluation_id, perspective)
);

-- Shadow strategy comparisons (feeds G4)
CREATE TABLE agent_graph.shadow_strategy_comparisons (
  id                       TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  evaluation_id            TEXT NOT NULL REFERENCES agent_graph.strategy_evaluations(id),
  protocol_recommendation  TEXT,
  board_decision           TEXT,
  is_match                 BOOLEAN,
  divergence_reason        TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Phase configuration
CREATE TABLE agent_graph.phase_config (
  id TEXT PRIMARY KEY,
  phase INT NOT NULL,
  is_active BOOLEAN DEFAULT false,
  activated_at TIMESTAMPTZ,
  activated_by TEXT,
  deactivated_at TIMESTAMPTZ,
  config JSONB DEFAULT '{}'
);

-- Dead-man's switch (Article 3.6)
CREATE TABLE agent_graph.dead_man_switch (
  id TEXT PRIMARY KEY,
  last_renewal TIMESTAMPTZ NOT NULL DEFAULT now(),
  renewal_interval_days INT DEFAULT 30,
  status TEXT CHECK (status IN ('active', 'standby', 'shutdown')),
  last_checked_at TIMESTAMPTZ,
  consecutive_missed INT DEFAULT 0
);

-- Exploration metrics (social physics circuit breaker)
CREATE TABLE agent_graph.exploration_metrics (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  measurement_date DATE NOT NULL,
  total_directives INT,
  cross_domain_directives INT,
  exploration_ratio NUMERIC(5,4),
  below_threshold_days INT DEFAULT 0,
  circuit_breaker_active BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Merkle proofs (Phase 4 verification)
CREATE TABLE agent_graph.merkle_proofs (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  proof_type      TEXT NOT NULL CHECK (proof_type IN (
    'state_transitions', 'financial_ledger', 'distribution_ledger', 'audit_findings'
  )),
  root_hash       TEXT NOT NULL,
  row_count       BIGINT,
  covers_from     TIMESTAMPTZ,
  covers_to       TIMESTAMPTZ,
  proof_data      JSONB,
  published_at    TIMESTAMPTZ DEFAULT now(),
  verification_url TEXT
);

-- Autonomy configuration (Phase 4)
CREATE TABLE agent_graph.autonomy_config (
  id                      TEXT PRIMARY KEY,
  budget_cap_removed      BOOLEAN DEFAULT false,
  multi_product_enabled   BOOLEAN DEFAULT false,
  full_distribution_active BOOLEAN DEFAULT false,
  data_fees_active        BOOLEAN DEFAULT false,
  creator_role            TEXT DEFAULT 'custodian' CHECK (creator_role IN ('board_member', 'custodian')),
  activated_at            TIMESTAMPTZ,
  activated_by            TEXT
);

-- Data cooperative (Phase 4)
CREATE TABLE agent_graph.data_cooperative (
  id                      TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  status                  TEXT CHECK (status IN ('formation_pending', 'forming', 'active', 'suspended')),
  member_count            INT DEFAULT 0,
  formation_triggered_at  TIMESTAMPTZ,
  governance_model        TEXT DEFAULT 'democratic',
  charter_hash            TEXT,
  created_at              TIMESTAMPTZ DEFAULT now()
);

-- Threat memory (append-only, hash-chained)
CREATE TABLE agent_graph.threat_memory (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  detected_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_type     TEXT NOT NULL,
  scope_type      TEXT NOT NULL,
  scope_id        TEXT NOT NULL,
  threat_class    TEXT NOT NULL,
  severity        TEXT NOT NULL,
  detail_json     JSONB NOT NULL DEFAULT '{}',
  prev_hash       TEXT,
  hash_chain_current TEXT,
  resolved        BOOLEAN NOT NULL DEFAULT false,
  resolved_by     TEXT,
  resolved_at     TIMESTAMPTZ,

  CONSTRAINT chk_source_type CHECK (source_type IN (
    'sanitization', 'post_check', 'tier1_audit', 'tier2_audit',
    'tool_integrity', 'gateway_inbound'
  )),
  CONSTRAINT chk_scope_type CHECK (scope_type IN (
    'org', 'agent', 'task', 'workstream', 'tool', 'inbound_channel'
  )),
  CONSTRAINT chk_threat_class CHECK (threat_class IN (
    'INJECTION_ATTEMPT', 'EXFILTRATION_PROBE', 'INTEGRITY_FAILURE',
    'POLICY_VIOLATION', 'BUDGET_ABUSE', 'ESCALATION_BYPASS',
    'TOOL_ABUSE', 'ANOMALOUS_BEHAVIOR'
  )),
  CONSTRAINT chk_severity CHECK (severity IN (
    'INFORMATIONAL', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'
  ))
);

-- Tolerance config (escalation thresholds)
CREATE TABLE agent_graph.tolerance_config (
  id                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  threat_class        TEXT NOT NULL,
  scope_type          TEXT NOT NULL,
  scope_id            TEXT NOT NULL DEFAULT '*',
  window_minutes      INTEGER NOT NULL DEFAULT 60,
  level_1_threshold   INTEGER NOT NULL DEFAULT 5,
  level_2_threshold   INTEGER NOT NULL DEFAULT 15,
  level_3_threshold   INTEGER NOT NULL DEFAULT 30,
  level_4_threshold   INTEGER NOT NULL DEFAULT 50,
  severity_weights    JSONB NOT NULL DEFAULT '{"INFORMATIONAL": 0, "LOW": 1, "MEDIUM": 3, "HIGH": 5, "CRITICAL": 10}',
  created_by          TEXT NOT NULL DEFAULT 'board',
  config_hash         TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chk_tc_scope_type CHECK (scope_type IN (
    'org', 'agent', 'task', 'workstream', 'tool', 'inbound_channel'
  )),
  CONSTRAINT chk_tc_thresholds CHECK (
    level_1_threshold < level_2_threshold
    AND level_2_threshold < level_3_threshold
    AND level_3_threshold < level_4_threshold
  ),
  UNIQUE (threat_class, scope_type, scope_id)
);

-- Agent assignment rules (P2 enforcement)
CREATE TABLE agent_graph.agent_assignment_rules (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  agent_id    TEXT NOT NULL REFERENCES agent_graph.agent_configs(id),
  can_assign  TEXT NOT NULL REFERENCES agent_graph.agent_configs(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agent_id, can_assign)
);

-- Permission grants (ADR-017: unified governance surface)
CREATE TABLE agent_graph.permission_grants (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  agent_id        TEXT NOT NULL,
  resource_type   TEXT NOT NULL CHECK (resource_type IN ('tool', 'adapter', 'api_client', 'subprocess')),
  resource_name   TEXT NOT NULL,
  risk_class      TEXT NOT NULL CHECK (risk_class IN ('Internal', 'Computational', 'External-Read', 'External-Write')),
  credential_scope TEXT,
  rate_limit      JSONB,
  granted_by      TEXT NOT NULL,
  granted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at      TIMESTAMPTZ,
  UNIQUE (agent_id, resource_type, resource_name)
);

-- ============================================================
-- SCHEMA: inbox — Email metadata, triage, signals, sync
-- ============================================================

-- Accounts: multi-channel credential store
CREATE TABLE inbox.accounts (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  channel         TEXT NOT NULL CHECK (channel IN ('email', 'slack', 'whatsapp', 'telegram')),
  provider        TEXT NOT NULL DEFAULT 'gmail' CHECK (provider IN ('gmail', 'outlook', 'slack', 'telegram')),
  label           TEXT NOT NULL,
  identifier      TEXT NOT NULL,
  credentials     BYTEA,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  last_sync_at    TIMESTAMPTZ,
  sync_status     TEXT NOT NULL DEFAULT 'pending' CHECK (sync_status IN ('pending', 'active', 'syncing', 'error', 'setup')),
  last_error      TEXT,
  owner           TEXT,  -- board member GitHub username who connected this account
  owner_id        UUID,  -- FK to board_members (set by migration 007)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(channel, provider, identifier)
);

-- Message metadata (no body stored for email — D1)
CREATE TABLE inbox.messages (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  provider_msg_id TEXT,
  provider        TEXT NOT NULL DEFAULT 'gmail',
  thread_id       TEXT NOT NULL,
  message_id      TEXT NOT NULL,
  from_address    TEXT NOT NULL,
  from_name       TEXT,
  to_addresses    TEXT[] NOT NULL DEFAULT '{}',
  cc_addresses    TEXT[] NOT NULL DEFAULT '{}',
  subject         TEXT,
  snippet         TEXT,
  received_at     TIMESTAMPTZ NOT NULL,
  labels          TEXT[] NOT NULL DEFAULT '{}',
  has_attachments BOOLEAN NOT NULL DEFAULT false,
  in_reply_to     TEXT,
  channel         TEXT NOT NULL DEFAULT 'email' CHECK (channel IN ('email', 'slack', 'whatsapp', 'webhook', 'telegram')),
  account_id      TEXT REFERENCES inbox.accounts(id),
  channel_id      TEXT,
  triage_category TEXT CHECK (triage_category IN (
    'action_required', 'needs_response', 'fyi', 'noise', 'pending'
  )) DEFAULT 'pending',
  triage_confidence NUMERIC(3,2) CHECK (triage_confidence IS NULL OR (triage_confidence >= 0 AND triage_confidence <= 1)),
  priority_score    INTEGER CHECK (priority_score BETWEEN 0 AND 100),
  work_item_id    TEXT,
  processed_at    TIMESTAMPTZ,
  archived_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT messages_require_provider_id
    CHECK ((channel = 'email' AND provider_msg_id IS NOT NULL) OR (channel != 'email' AND channel_id IS NOT NULL)),
  CONSTRAINT messages_non_email_requires_account
    CHECK (channel IN ('email', 'webhook', 'telegram') OR account_id IS NOT NULL)
);

-- Signals: extracted commitments, deadlines, action items, questions
CREATE TABLE inbox.signals (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  message_id      TEXT NOT NULL REFERENCES inbox.messages(id),
  signal_type     TEXT NOT NULL CHECK (signal_type IN (
    'commitment', 'deadline', 'request', 'question',
    'approval_needed', 'decision', 'introduction', 'info',
    'action_item'
  )),
  content         TEXT NOT NULL,
  confidence      NUMERIC(3,2) NOT NULL,
  due_date        TIMESTAMPTZ,
  resolved        BOOLEAN NOT NULL DEFAULT false,
  resolved_at     TIMESTAMPTZ,
  direction       TEXT CHECK (direction IN ('inbound', 'outbound', 'both')),
  domain          TEXT CHECK (domain IN ('general', 'financial', 'legal', 'scheduling')),
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Multi-account sync state
CREATE TABLE inbox.sync_state (
  account_id    TEXT PRIMARY KEY REFERENCES inbox.accounts(id),
  channel       TEXT NOT NULL DEFAULT 'email',
  history_id    TEXT,
  cursor        TEXT,
  last_poll_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  messages_synced INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Google Drive folder watches
CREATE TABLE inbox.drive_watches (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  account_id    TEXT NOT NULL REFERENCES inbox.accounts(id),
  folder_id     TEXT NOT NULL,
  folder_url    TEXT,
  label         TEXT NOT NULL DEFAULT 'Drive Folder',
  preset        TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  last_poll_at  TIMESTAMPTZ,
  last_error    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE inbox.drive_watches IS 'Google Drive folder watch configs. Each row = one folder polled for new Google Docs.';
COMMENT ON COLUMN inbox.drive_watches.account_id IS 'FK to inbox.accounts — uses that account OAuth credentials for Drive API.';
COMMENT ON COLUMN inbox.drive_watches.folder_id IS 'Google Drive folder ID (from URL or API).';
COMMENT ON COLUMN inbox.drive_watches.preset IS 'Optional preset: tldv (meeting transcripts), generic, or NULL.';

-- ============================================================
-- SCHEMA: voice — Voice learning
-- ============================================================

-- Sent email corpus with pgvector embeddings
-- Uses vector(1024) when pgvector is available, JSONB fallback otherwise
DO $$ BEGIN
  EXECUTE '
    CREATE TABLE voice.sent_emails (
      id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      provider_msg_id TEXT NOT NULL UNIQUE,
      thread_id       TEXT NOT NULL,
      to_address      TEXT NOT NULL,
      to_name         TEXT,
      subject         TEXT,
      body            TEXT NOT NULL,
      word_count      INTEGER NOT NULL,
      sent_at         TIMESTAMPTZ NOT NULL,
      is_reply        BOOLEAN NOT NULL DEFAULT false,
      embedding       ' || CASE WHEN EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN 'vector(1024)' ELSE 'JSONB' END || ',
      recipient_cluster TEXT,
      topic_cluster     TEXT,
      account_id      TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    )';
END $$;

-- Aggregate voice profiles
CREATE TABLE voice.profiles (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  scope           TEXT NOT NULL CHECK (scope IN ('global', 'recipient', 'topic')),
  scope_key       TEXT,
  greetings       TEXT[] DEFAULT '{}',
  closings        TEXT[] DEFAULT '{}',
  vocabulary      JSONB DEFAULT '{}',
  tone_markers    JSONB DEFAULT '{}',
  avg_length      INTEGER,
  formality_score NUMERIC(3,2) CHECK (formality_score IS NULL OR (formality_score >= 0 AND formality_score <= 1)),
  sample_count    INTEGER NOT NULL DEFAULT 0,
  account_id      TEXT,
  last_updated    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Composite unique: one profile per scope + key + account (NULL-safe via COALESCE)
CREATE UNIQUE INDEX profiles_scope_key_account_unique
  ON voice.profiles (scope, COALESCE(scope_key, '__null__'), COALESCE(account_id, '__global__'));

-- Edit deltas: G4 training data (APPEND-ONLY, IMMUTABLE)
CREATE TABLE voice.edit_deltas (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  draft_id        TEXT NOT NULL,
  message_id      TEXT NOT NULL,
  original_body   TEXT NOT NULL,
  edited_body     TEXT NOT NULL,
  diff            TEXT NOT NULL,
  recipient       TEXT NOT NULL,
  subject         TEXT,
  triage_category TEXT,
  edit_type       TEXT CHECK (edit_type IN ('tone', 'content', 'structure', 'minor', 'major')),
  edit_magnitude  NUMERIC(3,2) CHECK (edit_magnitude IS NULL OR (edit_magnitude >= 0 AND edit_magnitude <= 1)),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- SCHEMA: signal — Contacts, topics, briefings
-- ============================================================

-- Contacts: relationship graph with interaction metrics
CREATE TABLE signal.contacts (
  id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  email_address     TEXT NOT NULL UNIQUE,
  name              TEXT,
  organization      TEXT,
  contact_type      TEXT CHECK (contact_type IN (
    'cofounder', 'board', 'investor',
    'team', 'advisor', 'customer', 'prospect', 'partner',
    'vendor', 'legal', 'accountant',
    'recruiter',
    'service', 'newsletter',
    'unknown'
  )) DEFAULT 'unknown',
  tier              TEXT CHECK (tier IN (
    'inner_circle', 'active', 'inbound_only', 'newsletter', 'automated', 'unknown'
  )) DEFAULT 'unknown',
  emails_received   INTEGER NOT NULL DEFAULT 0,
  emails_sent       INTEGER NOT NULL DEFAULT 0,
  last_received_at  TIMESTAMPTZ,
  last_sent_at      TIMESTAMPTZ,
  avg_response_time_hours NUMERIC(10,2),
  is_vip            BOOLEAN NOT NULL DEFAULT false,
  vip_reason        TEXT,
  phone             TEXT CHECK (phone ~ '^\+[1-9]\d{1,14}$'),
  default_repos     TEXT[],
  notes             TEXT,
  source_account_id TEXT,
  metadata          JSONB DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON COLUMN signal.contacts.source_account_id IS
  'Provenance: which account first encountered this contact. Contacts are org-wide (unique on email_address), not siloed.';

-- Contact-account junction: tracks which accounts have interacted with which contacts
-- No cross-schema FKs per convention; referential integrity enforced at application layer
CREATE TABLE signal.contact_accounts (
  contact_id        TEXT NOT NULL,
  account_id        TEXT NOT NULL,
  first_seen        TIMESTAMPTZ NOT NULL DEFAULT now(),
  interaction_count INTEGER NOT NULL DEFAULT 1,
  last_interaction  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (contact_id, account_id)
);

-- Topics: recurring topics with trending detection
CREATE TABLE signal.topics (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name            TEXT NOT NULL UNIQUE,
  description     TEXT,
  mention_count   INTEGER NOT NULL DEFAULT 0,
  last_mentioned  TIMESTAMPTZ,
  trend_direction TEXT CHECK (trend_direction IN ('rising', 'stable', 'declining')) DEFAULT 'stable',
  trend_score     NUMERIC(5,2) DEFAULT 0,
  related_contacts TEXT[] DEFAULT '{}',
  keywords        TEXT[] DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Briefings: daily briefing records
CREATE TABLE signal.briefings (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  briefing_date   DATE NOT NULL,
  summary         TEXT NOT NULL,
  action_items    JSONB NOT NULL DEFAULT '[]',
  signals         JSONB NOT NULL DEFAULT '[]',
  trending_topics JSONB NOT NULL DEFAULT '[]',
  vip_activity    JSONB NOT NULL DEFAULT '[]',
  emails_received INTEGER NOT NULL DEFAULT 0,
  emails_triaged  INTEGER NOT NULL DEFAULT 0,
  drafts_created  INTEGER NOT NULL DEFAULT 0,
  drafts_approved INTEGER NOT NULL DEFAULT 0,
  drafts_edited   INTEGER NOT NULL DEFAULT 0,
  cost_usd        NUMERIC(15,6) NOT NULL DEFAULT 0,
  generated_by    TEXT NOT NULL,
  account_id      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One briefing per account per date + one org-wide (NULL) per date
CREATE UNIQUE INDEX briefings_date_account_unique
  ON signal.briefings (briefing_date, COALESCE(account_id, '__org_wide__'));

-- Signal feedback (append-only)
CREATE TABLE signal.feedback (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  signal_id   TEXT NOT NULL,
  verdict     TEXT NOT NULL CHECK (verdict IN ('correct', 'incorrect', 'partial')),
  correction  JSONB,
  source      TEXT NOT NULL DEFAULT 'dashboard' CHECK (source IN ('dashboard', 'cli', 'api', 'slack', 'telegram')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Contact-project associations
CREATE TABLE IF NOT EXISTS signal.contact_projects (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  contact_id      TEXT NOT NULL REFERENCES signal.contacts(id) ON DELETE CASCADE,
  project_name    TEXT NOT NULL,
  platform        TEXT NOT NULL CHECK (platform IN (
    'github', 'shopify', 'wordpress', 'vercel', 'database'
  )),
  locator         TEXT NOT NULL,
  platform_config JSONB NOT NULL DEFAULT '{}',
  is_active       BOOLEAN NOT NULL DEFAULT true,
  is_primary      BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (contact_id, platform, locator)
);

-- ============================================================
-- SCHEMA: content — LinkedIn content automation (Phase 1.5)
-- ============================================================

-- Topic queue (content.topics kept; content.drafts unified into action_proposals)
CREATE TABLE content.topics (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  platform        TEXT NOT NULL DEFAULT 'linkedin' CHECK (platform IN ('linkedin')),
  topic           TEXT NOT NULL,
  topic_area      TEXT,
  notes           TEXT,
  source          TEXT CHECK (source IN ('schedule', 'directive', 'signal')),
  status          TEXT NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued', 'in_progress', 'drafted', 'published', 'skipped'
  )),
  scheduled_for   DATE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- SCHEMA: autobot_public — Transparency layer (spec §8)
-- ============================================================

CREATE TABLE autobot_public.event_log (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  event_type      TEXT NOT NULL CHECK (event_type IN (
    'email_received', 'email_triaged', 'draft_created', 'draft_reviewed',
    'draft_approved', 'draft_sent', 'halt_triggered', 'halt_cleared',
    'budget_warning', 'autonomy_evaluation', 'config_changed',
    'board_directive', 'infrastructure_error',
    'redesign_submitted', 'redesign_completed',
    'blueprint_submitted', 'blueprint_completed',
    'intent_executed',
    'agent_insight'
  )),
  summary         TEXT NOT NULL,
  agent_id        TEXT,
  work_item_id    TEXT,
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- SCHEMA: autobot_comms — Communication gateway (spec §7)
-- ============================================================

CREATE TABLE autobot_comms.outbound_intents (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  channel         TEXT NOT NULL CHECK (channel IN ('email', 'slack', 'whatsapp', 'webhook', 'sms', 'telegram')),
  recipient       TEXT NOT NULL,
  subject         TEXT,
  body            TEXT NOT NULL,
  intent_type     TEXT NOT NULL CHECK (intent_type IN ('draft', 'send', 'notification')),
  status          TEXT NOT NULL DEFAULT 'logged' CHECK (status IN ('logged', 'approved', 'sent', 'blocked')),
  source_agent    TEXT,
  source_task     TEXT,
  risk_tier       INTEGER DEFAULT 3 CHECK (risk_tier BETWEEN 0 AND 4),
  category        TEXT DEFAULT 'operational' CHECK (category IN (
    'transactional', 'operational', 'relational', 'reputational', 'legal_regulatory'
  )),
  ai_disclosure_added BOOLEAN DEFAULT false,
  cool_down_expires_at TIMESTAMPTZ,
  quorum_approvals JSONB DEFAULT '[]',
  sanitized_at    TIMESTAMPTZ,
  template_id     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE autobot_comms.inbound_messages (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'slack', 'whatsapp', 'webhook', 'sms', 'telegram')),
  sender TEXT NOT NULL,
  sender_verified BOOLEAN NOT NULL DEFAULT false,
  verification_method TEXT CHECK (verification_method IN ('spf_dkim_dmarc', 'phone_match', 'crypto_identity', 'none')),
  raw_content_hash TEXT,
  structured_extraction JSONB NOT NULL DEFAULT '{}',
  routed_to_task TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE autobot_comms.contact_registry (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  email TEXT,
  phone TEXT,
  name TEXT,
  priority_level TEXT NOT NULL DEFAULT 'normal' CHECK (priority_level IN ('critical', 'high', 'normal', 'low')),
  verified_channels JSONB DEFAULT '[]',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE autobot_comms.templates (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL DEFAULT 1,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'slack', 'whatsapp', 'webhook', 'sms', 'telegram')),
  subject_template TEXT,
  body_template TEXT NOT NULL,
  variables JSONB DEFAULT '[]',
  risk_tier INTEGER NOT NULL DEFAULT 1,
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE autobot_comms.consent_registry (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  contact_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  consent_given BOOLEAN NOT NULL DEFAULT false,
  consent_date TIMESTAMPTZ,
  opt_out_date TIMESTAMPTZ,
  legal_basis TEXT CHECK (legal_basis IN ('consent', 'legitimate_interest', 'contractual', 'legal_obligation')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE autobot_comms.rate_limits (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  scope TEXT NOT NULL CHECK (scope IN ('agent', 'recipient', 'global')),
  scope_id TEXT NOT NULL,
  window_minutes INTEGER NOT NULL DEFAULT 1440,
  max_messages INTEGER NOT NULL DEFAULT 10,
  current_count INTEGER NOT NULL DEFAULT 0,
  window_start TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(scope, scope_id)
);

CREATE TABLE autobot_comms.ai_disclosures (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  channel TEXT NOT NULL,
  disclosure_text TEXT NOT NULL,
  regulation TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- SCHEMA: autobot_finance — Financial Script (spec §12, §13)
-- ============================================================

CREATE OR REPLACE FUNCTION autobot_finance.bankers_round(val NUMERIC, dp INTEGER DEFAULT 2)
RETURNS NUMERIC AS $$
DECLARE
  rounded NUMERIC;
  truncated NUMERIC;
  diff NUMERIC;
  last_digit INTEGER;
BEGIN
  rounded := round(val, dp);
  truncated := trunc(val, dp);
  diff := abs(val - truncated) * power(10, dp);
  IF abs(diff - 0.5) < 0.0000001 THEN
    last_digit := (trunc(val * power(10, dp))::bigint % 10)::integer;
    IF last_digit % 2 = 1 THEN
      rounded := truncated + sign(val) * power(10, -dp);
    ELSE
      rounded := truncated;
    END IF;
  END IF;
  RETURN rounded;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE TABLE autobot_finance.revenue (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  source TEXT NOT NULL,
  amount NUMERIC(15,6) NOT NULL CHECK (amount >= 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  description TEXT,
  product_id TEXT,
  customer_id TEXT,
  period_month DATE NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE autobot_finance.expenses (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  category TEXT NOT NULL CHECK (category IN (
    'llm_api', 'infrastructure', 'communication', 'audit',
    'legal', 'insurance', 'tools', 'other'
  )),
  amount NUMERIC(15,6) NOT NULL CHECK (amount >= 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  description TEXT,
  vendor TEXT,
  period_month DATE NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE autobot_finance.monthly_allocations (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  period_month DATE NOT NULL UNIQUE,
  gross_revenue NUMERIC(15,6) NOT NULL DEFAULT 0,
  total_expenses NUMERIC(15,6) NOT NULL DEFAULT 0,
  net_profit NUMERIC(15,6) NOT NULL DEFAULT 0,
  reinvestment NUMERIC(15,6) NOT NULL DEFAULT 0,
  data_contribution_fees NUMERIC(15,6) NOT NULL DEFAULT 0,
  random_distribution NUMERIC(15,6) NOT NULL DEFAULT 0,
  CONSTRAINT allocation_sum_check CHECK (
    net_profit <= 0 OR
    ABS(reinvestment + data_contribution_fees + random_distribution - net_profit) < 0.01
  ),
  distribution_eligible BOOLEAN NOT NULL DEFAULT false,
  is_shadow_mode BOOLEAN NOT NULL DEFAULT true,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE autobot_finance.accounts (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  account_type TEXT NOT NULL UNIQUE CHECK (account_type IN ('operating', 'reserve')),
  balance NUMERIC(15,6) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE autobot_finance.ledger (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  entry_type TEXT NOT NULL CHECK (entry_type IN (
    'revenue', 'expense', 'allocation', 'transfer', 'adjustment'
  )),
  debit_account TEXT,
  credit_account TEXT,
  amount NUMERIC(15,6) NOT NULL,
  reference_id TEXT,
  description TEXT,
  hash_chain_prev TEXT,
  hash_chain_current TEXT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- SCHEMA: autobot_distrib — Distribution Mechanism (spec §13)
-- ============================================================

CREATE TABLE autobot_distrib.distribution_rounds (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  period_month DATE NOT NULL,
  allocation_id TEXT NOT NULL,
  total_amount NUMERIC(15,6) NOT NULL,
  reinvestment_amount NUMERIC(15,6),
  data_fees_amount NUMERIC(15,6),
  random_amount NUMERIC(15,6),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'approved', 'processing', 'completed', 'failed'
  )),
  approved_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE autobot_distrib.recipients (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  recipient_type TEXT NOT NULL CHECK (recipient_type IN (
    'data_contributor', 'random_individual'
  )),
  external_id TEXT,
  eligibility_status TEXT NOT NULL DEFAULT 'pending_kyc' CHECK (eligibility_status IN (
    'eligible', 'ineligible', 'pending_kyc', 'blocked'
  )),
  total_received NUMERIC(15,6) NOT NULL DEFAULT 0,
  last_distribution_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE autobot_distrib.distribution_transactions (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  round_id TEXT NOT NULL REFERENCES autobot_distrib.distribution_rounds(id),
  recipient_id TEXT NOT NULL REFERENCES autobot_distrib.recipients(id),
  amount NUMERIC(15,6) NOT NULL CHECK (amount > 0),
  transaction_type TEXT NOT NULL CHECK (transaction_type IN (
    'data_contribution_fee', 'random_distribution'
  )),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'submitted', 'confirmed', 'failed', 'reversed'
  )),
  partner_reference TEXT,
  tax_reporting_status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMPTZ
);

CREATE TABLE autobot_distrib.distribution_ledger (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  entry_type TEXT NOT NULL,
  round_id TEXT,
  transaction_id TEXT,
  amount NUMERIC(15,6) NOT NULL,
  description TEXT,
  hash_chain_prev TEXT,
  hash_chain_current TEXT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- SCHEMA: autobot_value — Value Measurement Script (spec §13)
-- ============================================================

CREATE TABLE autobot_value.products (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name        TEXT NOT NULL,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'sunset', 'discontinued')),
  launched_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE autobot_value.product_metrics (
  id               TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  product_id       TEXT NOT NULL REFERENCES autobot_value.products(id),
  measurement_date DATE NOT NULL,
  active_users     INT DEFAULT 0,
  new_users        INT DEFAULT 0,
  churned_users    INT DEFAULT 0,
  retained_users   INT DEFAULT 0,
  retention_rate   NUMERIC(5,4),
  revenue          NUMERIC(15,6) DEFAULT 0,
  cost             NUMERIC(15,6) DEFAULT 0,
  value_ratio      NUMERIC(10,4),
  net_value        NUMERIC(15,6),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_retention_rate_range CHECK (retention_rate >= 0 AND retention_rate <= 1)
);

CREATE TABLE autobot_value.value_assessments (
  id                     TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  product_id             TEXT REFERENCES autobot_value.products(id),
  assessment_type        TEXT NOT NULL CHECK (assessment_type IN ('daily', 'weekly', 'monthly', 'quarterly')),
  period_start           DATE,
  period_end             DATE,
  aggregate_retention    NUMERIC(5,4),
  aggregate_value_ratio  NUMERIC(10,4),
  total_revenue          NUMERIC(15,6),
  total_cost             NUMERIC(15,6),
  net_positive           BOOLEAN,
  law1_compliant         BOOLEAN,
  recommendation         TEXT CHECK (recommendation IN ('continue', 'optimize', 'sunset', 'discontinue')),
  rationale              TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE autobot_value.user_cohorts (
  id               TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  product_id       TEXT NOT NULL REFERENCES autobot_value.products(id),
  cohort_month     DATE NOT NULL,
  initial_users    INT NOT NULL,
  retained_month_1  INT,
  retained_month_2  INT,
  retained_month_3  INT,
  retained_month_6  INT,
  retained_month_12 INT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- FUNCTIONS
-- ============================================================

-- Helper: get current agent ID from session variable
CREATE OR REPLACE FUNCTION agent_graph.current_agent_id()
RETURNS TEXT AS $$
  SELECT current_setting('app.agent_id', true)::TEXT;
$$ LANGUAGE sql STABLE;

-- Cycle detection: iterative BFS with depth limit
CREATE OR REPLACE FUNCTION agent_graph.would_create_cycle(
  p_from_id TEXT,
  p_to_id TEXT
) RETURNS BOOLEAN AS $$
DECLARE
  v_queue TEXT[];
  v_visited TEXT[];
  v_current TEXT;
  v_depth INTEGER := 0;
  v_max_depth INTEGER := 100;
  v_neighbors TEXT[];
BEGIN
  v_queue := ARRAY[p_to_id];
  v_visited := ARRAY[p_to_id];

  WHILE array_length(v_queue, 1) > 0 AND v_depth < v_max_depth LOOP
    v_current := v_queue[1];
    v_queue := v_queue[2:];

    IF v_current = p_from_id THEN
      RETURN TRUE;
    END IF;

    SELECT array_agg(e.to_id)
    INTO v_neighbors
    FROM agent_graph.edges e
    WHERE e.from_id = v_current
      AND e.to_id != ALL(v_visited);

    IF v_neighbors IS NOT NULL THEN
      v_queue := v_queue || v_neighbors;
      v_visited := v_visited || v_neighbors;
    END IF;

    v_depth := v_depth + 1;
  END LOOP;

  RETURN FALSE;
END;
$$ LANGUAGE plpgsql;

-- Trigger function: prevent cycles on edge insertion
CREATE OR REPLACE FUNCTION agent_graph.check_cycle_trigger()
RETURNS TRIGGER AS $$
BEGIN
  IF agent_graph.would_create_cycle(NEW.from_id, NEW.to_id) THEN
    RAISE EXCEPTION 'Edge from % to % would create a cycle', NEW.from_id, NEW.to_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Atomic state transition (spec §3, §12)
CREATE OR REPLACE FUNCTION agent_graph.transition_state(
  p_work_item_id TEXT,
  p_to_state TEXT,
  p_agent_id TEXT,
  p_config_hash TEXT,
  p_reason TEXT DEFAULT NULL,
  p_guardrail_checks JSONB DEFAULT '{}'::jsonb,
  p_cost_usd NUMERIC(15,6) DEFAULT 0,
  p_transition_id TEXT DEFAULT NULL,
  p_hash_chain_current TEXT DEFAULT NULL
) RETURNS TABLE (
  success BOOLEAN,
  transition_id TEXT,
  from_state TEXT,
  prev_hash TEXT
) AS $$
DECLARE
  v_current_state TEXT;
  v_transition_valid BOOLEAN;
  v_required_guardrails TEXT[];
  v_prev_hash TEXT;
  v_tid TEXT;
  v_hash TEXT;
  v_payload TEXT;
BEGIN
  SELECT status INTO v_current_state
  FROM agent_graph.work_items
  WHERE id = p_work_item_id
  FOR UPDATE NOWAIT;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Work item % not found', p_work_item_id;
  END IF;

  SELECT true, required_guardrails
  INTO v_transition_valid, v_required_guardrails
  FROM agent_graph.valid_transitions
  WHERE agent_graph.valid_transitions.from_state = v_current_state
    AND agent_graph.valid_transitions.to_state = p_to_state
    AND (p_agent_id = ANY(allowed_roles) OR '*' = ANY(allowed_roles));

  IF v_transition_valid IS NOT TRUE THEN
    success := FALSE;
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT encode(hash_chain_current, 'hex') INTO v_prev_hash
  FROM agent_graph.state_transitions
  WHERE work_item_id = p_work_item_id
  ORDER BY created_at DESC
  LIMIT 1;

  v_tid := COALESCE(p_transition_id, gen_random_uuid()::text);

  IF p_hash_chain_current IS NOT NULL THEN
    v_hash := p_hash_chain_current;
  ELSE
    v_payload := COALESCE(v_prev_hash, 'genesis') || '|' ||
                 v_tid || '|' || p_work_item_id || '|' ||
                 v_current_state || '|' || p_to_state || '|' ||
                 p_agent_id || '|' || p_config_hash;
    v_hash := encode(sha256(v_payload::bytea), 'hex');
  END IF;

  UPDATE agent_graph.work_items
  SET status = p_to_state,
      updated_at = now()
  WHERE id = p_work_item_id;

  INSERT INTO agent_graph.state_transitions (
    id, work_item_id, from_state, to_state,
    agent_id, config_hash, reason, guardrail_checks_json,
    cost_usd, hash_chain_prev, hash_chain_current
  ) VALUES (
    v_tid, p_work_item_id, v_current_state, p_to_state,
    p_agent_id, p_config_hash, p_reason, p_guardrail_checks,
    p_cost_usd,
    CASE WHEN v_prev_hash IS NOT NULL THEN decode(v_prev_hash, 'hex') ELSE NULL END,
    decode(v_hash, 'hex')
  );

  IF p_to_state IN ('completed', 'failed') THEN
    INSERT INTO agent_graph.task_events
      (event_type, work_item_id, target_agent_id, priority, event_data)
    VALUES (
      'state_changed', p_work_item_id,
      'orchestrator',
      0,
      jsonb_build_object(
        'from_state', v_current_state,
        'to_state', p_to_state,
        'agent_id', p_agent_id,
        'transition_id', v_tid,
        'work_item_id', p_work_item_id
      )
    );
  END IF;

  success := TRUE;
  transition_id := v_tid;
  from_state := v_current_state;
  prev_hash := COALESCE(v_prev_hash, '');
  RETURN NEXT;
END;
$$ LANGUAGE plpgsql;

-- Claim next task: atomic with SKIP LOCKED (skips cancelled/completed)
CREATE OR REPLACE FUNCTION agent_graph.claim_next_task(
  p_agent_id TEXT
) RETURNS TABLE (
  event_id TEXT,
  event_type TEXT,
  work_item_id TEXT,
  event_data JSONB
) AS $$
DECLARE
  v_event RECORD;
BEGIN
  -- Skip events whose work items are no longer claimable.
  -- EXCEPT state_changed: these are routing events fired AFTER a task completes —
  -- the orchestrator needs to claim them to route follow-up work.
  UPDATE agent_graph.task_events te
  SET processed_at = now()
  FROM agent_graph.work_items wi
  WHERE te.work_item_id = wi.id
    AND te.processed_at IS NULL
    AND te.event_type != 'state_changed'
    AND wi.status IN ('cancelled', 'completed', 'timed_out');

  -- Now claim the next valid event.
  -- state_changed events are claimable even when the work item is completed
  -- (they trigger routing to the next pipeline stage).
  SELECT te.event_id, te.event_type, te.work_item_id, te.event_data
  INTO v_event
  FROM agent_graph.task_events te
  JOIN agent_graph.work_items wi ON wi.id = te.work_item_id
  WHERE (te.target_agent_id = p_agent_id OR te.target_agent_id = '*')
    AND te.processed_at IS NULL
    AND (
      te.event_type = 'state_changed'
      OR wi.status IN ('assigned', 'created')
    )
  ORDER BY te.priority DESC, te.created_at
  FOR UPDATE OF te SKIP LOCKED
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  UPDATE agent_graph.task_events
  SET processed_at = now()
  WHERE agent_graph.task_events.event_id = v_event.event_id;

  RETURN QUERY SELECT v_event.event_id, v_event.event_type, v_event.work_item_id, v_event.event_data;
END;
$$ LANGUAGE plpgsql;

-- Generic prevent_mutation trigger functions
CREATE OR REPLACE FUNCTION agent_graph.prevent_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Cannot % rows in append-only table %', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION voice.prevent_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Cannot % rows in append-only table voice.edit_deltas', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION autobot_public.prevent_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Cannot % rows in append-only table %', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION autobot_finance.prevent_ledger_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Financial ledger is append-only. UPDATE/DELETE forbidden.';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION autobot_finance.prevent_revenue_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Revenue table is append-only. UPDATE/DELETE forbidden.';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION autobot_finance.prevent_expenses_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Expenses table is append-only. UPDATE/DELETE forbidden.';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION autobot_distrib.prevent_distrib_ledger_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Distribution ledger is append-only. UPDATE/DELETE forbidden.';
END;
$$ LANGUAGE plpgsql;

-- Threat memory mutation prevention (allows resolved field updates only)
CREATE OR REPLACE FUNCTION agent_graph.prevent_threat_memory_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Cannot DELETE rows in append-only table agent_graph.threat_memory';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id != OLD.id
      OR NEW.detected_at != OLD.detected_at
      OR NEW.source_type != OLD.source_type
      OR NEW.scope_type != OLD.scope_type
      OR NEW.scope_id != OLD.scope_id
      OR NEW.threat_class != OLD.threat_class
      OR NEW.severity != OLD.severity
      OR NEW.detail_json != OLD.detail_json
      OR NEW.prev_hash IS DISTINCT FROM OLD.prev_hash
      OR NEW.hash_chain_current IS DISTINCT FROM OLD.hash_chain_current
    THEN
      RAISE EXCEPTION 'Cannot modify immutable columns in agent_graph.threat_memory (only resolved fields may change)';
    END IF;
    IF OLD.resolved = true AND NEW.resolved = false THEN
      RAISE EXCEPTION 'Cannot un-resolve a threat event';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Banker's rounding (agent_graph version)
CREATE OR REPLACE FUNCTION agent_graph.bankers_round(
  val NUMERIC,
  dp INTEGER DEFAULT 2
) RETURNS NUMERIC AS $$
DECLARE
  v_factor NUMERIC;
  v_scaled NUMERIC;
  v_truncated NUMERIC;
  v_remainder NUMERIC;
BEGIN
  IF val IS NULL THEN RETURN NULL; END IF;
  v_factor := POWER(10, dp);
  v_scaled := val * v_factor;
  v_truncated := TRUNC(v_scaled);
  v_remainder := ABS(v_scaled - v_truncated);
  IF ABS(v_remainder - 0.5) < 1e-10 THEN
    IF MOD(ABS(v_truncated)::BIGINT, 2) = 1 THEN
      RETURN (v_truncated + SIGN(val)) / v_factor;
    ELSE
      RETURN v_truncated / v_factor;
    END IF;
  ELSE
    RETURN ROUND(val, dp);
  END IF;
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT;

-- Budget functions (account-aware: check global + per-account ceilings)
CREATE OR REPLACE FUNCTION agent_graph.reserve_budget(
  p_estimated_cost NUMERIC(15,6),
  p_account_id TEXT DEFAULT NULL
) RETURNS BOOLEAN AS $$
DECLARE
  v_global_ok BOOLEAN := FALSE;
  v_rows INTEGER;
BEGIN
  -- Check global budget ceiling (account_id IS NULL row)
  UPDATE agent_graph.budgets
    SET reserved_usd = reserved_usd + p_estimated_cost,
        updated_at = now()
    WHERE scope = 'daily'
      AND period_start = CURRENT_DATE
      AND account_id IS NULL
      AND spent_usd + reserved_usd + p_estimated_cost <= allocated_usd;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_global_ok := v_rows > 0;

  IF NOT v_global_ok THEN
    IF EXISTS (
      SELECT 1 FROM agent_graph.budgets
      WHERE scope = 'daily' AND period_start = CURRENT_DATE
        AND account_id IS NULL
        AND spent_usd >= allocated_usd
    ) THEN
      INSERT INTO agent_graph.halt_signals (signal_type, reason, triggered_by)
      VALUES ('financial', 'Daily budget ceiling reached', 'budget_guard')
      ON CONFLICT DO NOTHING;
    END IF;
    RETURN FALSE;
  END IF;

  -- Check per-account budget ceiling (if account specified and budget row exists)
  IF p_account_id IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM agent_graph.budgets
      WHERE scope = 'daily' AND period_start = CURRENT_DATE AND account_id = p_account_id
    ) THEN
      UPDATE agent_graph.budgets
        SET reserved_usd = reserved_usd + p_estimated_cost,
            updated_at = now()
        WHERE scope = 'daily'
          AND period_start = CURRENT_DATE
          AND account_id = p_account_id
          AND spent_usd + reserved_usd + p_estimated_cost <= allocated_usd;

      GET DIAGNOSTICS v_rows = ROW_COUNT;

      -- Account budget exceeded — release the global reservation
      IF v_rows = 0 THEN
        UPDATE agent_graph.budgets
          SET reserved_usd = GREATEST(reserved_usd - p_estimated_cost, 0),
              updated_at = now()
          WHERE scope = 'daily'
            AND period_start = CURRENT_DATE
            AND account_id IS NULL;
        RETURN FALSE;
      END IF;
    END IF;
  END IF;

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION agent_graph.commit_budget(
  p_estimated_cost NUMERIC(15,6),
  p_actual_cost NUMERIC(15,6),
  p_account_id TEXT DEFAULT NULL
) RETURNS VOID AS $$
BEGIN
  -- Commit global budget
  UPDATE agent_graph.budgets
    SET spent_usd = spent_usd + p_actual_cost,
        reserved_usd = GREATEST(reserved_usd - p_estimated_cost, 0),
        updated_at = now()
    WHERE scope = 'daily'
      AND period_start = CURRENT_DATE
      AND account_id IS NULL;

  -- Commit per-account budget (if exists)
  IF p_account_id IS NOT NULL THEN
    UPDATE agent_graph.budgets
      SET spent_usd = spent_usd + p_actual_cost,
          reserved_usd = GREATEST(reserved_usd - p_estimated_cost, 0),
          updated_at = now()
      WHERE scope = 'daily'
        AND period_start = CURRENT_DATE
        AND account_id = p_account_id;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION agent_graph.release_budget(
  p_estimated_cost NUMERIC(15,6),
  p_account_id TEXT DEFAULT NULL
) RETURNS VOID AS $$
BEGIN
  -- Release global budget reservation
  UPDATE agent_graph.budgets
    SET reserved_usd = GREATEST(reserved_usd - p_estimated_cost, 0),
        updated_at = now()
    WHERE scope = 'daily'
      AND period_start = CURRENT_DATE
      AND account_id IS NULL;

  -- Release per-account budget reservation (if exists)
  IF p_account_id IS NOT NULL THEN
    UPDATE agent_graph.budgets
      SET reserved_usd = GREATEST(reserved_usd - p_estimated_cost, 0),
          updated_at = now()
      WHERE scope = 'daily'
        AND period_start = CURRENT_DATE
        AND account_id = p_account_id;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Ledger verification
CREATE OR REPLACE FUNCTION agent_graph.verify_ledger_chain(
  p_work_item_id TEXT DEFAULT NULL
) RETURNS TABLE (
  is_valid BOOLEAN,
  broken_at_id TEXT,
  broken_at_time TIMESTAMPTZ,
  expected_prev_hash TEXT,
  actual_prev_hash TEXT,
  rows_checked BIGINT
) AS $$
DECLARE
  v_row RECORD;
  v_prev_hash BYTEA := NULL;
  v_count BIGINT := 0;
  v_found_break BOOLEAN := FALSE;
  v_wi_id TEXT;
BEGIN
  IF p_work_item_id IS NOT NULL THEN
    FOR v_row IN
      SELECT st.id, st.hash_chain_prev, st.hash_chain_current, st.created_at
      FROM agent_graph.state_transitions st
      WHERE st.work_item_id = p_work_item_id
      ORDER BY st.created_at, st.id
    LOOP
      v_count := v_count + 1;
      IF v_prev_hash IS NOT NULL THEN
        IF v_row.hash_chain_prev IS DISTINCT FROM v_prev_hash THEN
          is_valid := FALSE;
          broken_at_id := v_row.id;
          broken_at_time := v_row.created_at;
          expected_prev_hash := encode(v_prev_hash, 'hex');
          actual_prev_hash := COALESCE(encode(v_row.hash_chain_prev, 'hex'), 'NULL');
          rows_checked := v_count;
          RETURN NEXT;
          RETURN;
        END IF;
      END IF;
      v_prev_hash := v_row.hash_chain_current;
    END LOOP;

    is_valid := TRUE;
    broken_at_id := NULL;
    broken_at_time := NULL;
    expected_prev_hash := NULL;
    actual_prev_hash := NULL;
    rows_checked := v_count;
    RETURN NEXT;
  ELSE
    FOR v_wi_id IN
      SELECT DISTINCT st2.work_item_id FROM agent_graph.state_transitions st2
    LOOP
      v_prev_hash := NULL;
      v_count := 0;
      v_found_break := FALSE;

      FOR v_row IN
        SELECT st.id, st.hash_chain_prev, st.hash_chain_current, st.created_at
        FROM agent_graph.state_transitions st
        WHERE st.work_item_id = v_wi_id
        ORDER BY st.created_at, st.id
      LOOP
        v_count := v_count + 1;
        IF v_prev_hash IS NOT NULL THEN
          IF v_row.hash_chain_prev IS DISTINCT FROM v_prev_hash THEN
            is_valid := FALSE;
            broken_at_id := v_row.id;
            broken_at_time := v_row.created_at;
            expected_prev_hash := encode(v_prev_hash, 'hex');
            actual_prev_hash := COALESCE(encode(v_row.hash_chain_prev, 'hex'), 'NULL');
            rows_checked := v_count;
            v_found_break := TRUE;
            RETURN NEXT;
            EXIT;
          END IF;
        END IF;
        v_prev_hash := v_row.hash_chain_current;
      END LOOP;

      IF NOT v_found_break THEN
        is_valid := TRUE;
        broken_at_id := NULL;
        broken_at_time := NULL;
        expected_prev_hash := NULL;
        actual_prev_hash := NULL;
        rows_checked := v_count;
        RETURN NEXT;
      END IF;
    END LOOP;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION agent_graph.verify_all_ledger_chains()
RETURNS TABLE (
  work_item_id TEXT,
  is_valid BOOLEAN,
  rows_checked BIGINT,
  broken_at_id TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT DISTINCT ON (wi.id)
    wi.id AS work_item_id,
    vlc.is_valid,
    vlc.rows_checked,
    vlc.broken_at_id
  FROM agent_graph.work_items wi
  CROSS JOIN LATERAL agent_graph.verify_ledger_chain(wi.id) vlc
  WHERE EXISTS (
    SELECT 1 FROM agent_graph.state_transitions st
    WHERE st.work_item_id = wi.id
  )
  ORDER BY wi.id;
END;
$$ LANGUAGE plpgsql;

-- Public event publisher
CREATE OR REPLACE FUNCTION autobot_public.publish_event(
  p_event_type TEXT,
  p_summary TEXT,
  p_agent_id TEXT DEFAULT NULL,
  p_work_item_id TEXT DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'
) RETURNS TEXT AS $$
DECLARE
  v_id TEXT;
BEGIN
  INSERT INTO autobot_public.event_log (event_type, summary, agent_id, work_item_id, metadata)
  VALUES (p_event_type, p_summary, p_agent_id, p_work_item_id, p_metadata)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$ LANGUAGE plpgsql;

-- DDL audit event trigger
CREATE OR REPLACE FUNCTION agent_graph.log_ddl_event()
RETURNS event_trigger AS $$
BEGIN
  INSERT INTO autobot_public.event_log (event_type, summary, metadata)
  VALUES (
    'config_changed',
    'DDL command: ' || tg_event || ' ' || tg_tag,
    jsonb_build_object('event', tg_event, 'tag', tg_tag)
  );
END;
$$ LANGUAGE plpgsql;

-- Cross-schema reconciliation
CREATE OR REPLACE FUNCTION agent_graph.reconcile_schemas()
RETURNS TABLE (
  issue_type TEXT,
  schema_name TEXT,
  table_name TEXT,
  record_id TEXT,
  details TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT 'orphaned_fk'::TEXT, 'agent_graph'::TEXT, 'action_proposals'::TEXT, ap.id,
         'message_id not found: ' || ap.message_id
  FROM agent_graph.action_proposals ap
  LEFT JOIN inbox.messages m ON m.id = ap.message_id
  WHERE ap.action_type = 'email_draft' AND ap.message_id IS NOT NULL AND m.id IS NULL;

  RETURN QUERY
  SELECT 'orphaned_fk'::TEXT, 'agent_graph'::TEXT, 'action_proposals'::TEXT, ap.id,
         'topic_id not found: ' || ap.topic_id
  FROM agent_graph.action_proposals ap
  LEFT JOIN content.topics t ON t.id = ap.topic_id
  WHERE ap.action_type = 'content_post' AND ap.topic_id IS NOT NULL AND t.id IS NULL;

  RETURN QUERY
  SELECT 'stale_assignment'::TEXT, 'agent_graph'::TEXT, 'work_items'::TEXT, w.id,
         'assigned to inactive agent: ' || w.assigned_to
  FROM agent_graph.work_items w
  LEFT JOIN agent_graph.agent_configs ac ON ac.id = w.assigned_to
  WHERE w.assigned_to IS NOT NULL AND (ac.id IS NULL OR ac.is_active = false)
    AND w.status IN ('created', 'assigned', 'in_progress');

  RETURN QUERY
  SELECT 'unlinked_message'::TEXT, 'inbox'::TEXT, 'messages'::TEXT, m.id, 'no work_item_id'
  FROM inbox.messages m
  WHERE m.work_item_id IS NULL AND m.received_at >= now() - interval '24 hours'
    -- Tier-3 signal-only rows are by-design unlinked (no work_item, zero LLM
    -- cost — see signal-only awareness path below). Exclude them so they stop
    -- firing the unlinked_message infrastructure alert (STAQPRO-548).
    AND NOT ('signal-only'::TEXT = ANY(m.labels));

  RETURN QUERY
  SELECT 'orphaned_fk'::TEXT, 'voice'::TEXT, 'edit_deltas'::TEXT, ed.id,
         'draft_id not found: ' || ed.draft_id
  FROM voice.edit_deltas ed
  LEFT JOIN agent_graph.action_proposals ap ON ap.id = ed.draft_id
  WHERE ap.id IS NULL;
END;
$$ LANGUAGE plpgsql;

-- Escalation functions
CREATE OR REPLACE FUNCTION agent_graph.resolve_threat(
  p_threat_id TEXT,
  p_resolved_by TEXT
) RETURNS BOOLEAN AS $$
DECLARE
  v_severity TEXT;
BEGIN
  SELECT severity INTO v_severity
  FROM agent_graph.threat_memory
  WHERE id = p_threat_id AND resolved = false;

  IF v_severity IS NULL THEN
    RETURN false;
  END IF;

  IF v_severity IN ('HIGH', 'CRITICAL') AND p_resolved_by != 'board' THEN
    RAISE EXCEPTION 'HIGH/CRITICAL threats can only be resolved by board, not %', p_resolved_by;
  END IF;

  UPDATE agent_graph.threat_memory
  SET resolved = true,
      resolved_by = p_resolved_by,
      resolved_at = now()
  WHERE id = p_threat_id AND resolved = false;

  RETURN true;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION agent_graph.current_escalation_level(
  p_scope_type TEXT,
  p_scope_id TEXT
) RETURNS INTEGER AS $$
DECLARE
  v_max_level INTEGER := 0;
  v_config RECORD;
  v_weighted_score NUMERIC;
BEGIN
  FOR v_config IN
    SELECT tc.*
    FROM agent_graph.tolerance_config tc
    WHERE tc.scope_type = p_scope_type
      AND (tc.scope_id = p_scope_id OR tc.scope_id = '*')
  LOOP
    SELECT COALESCE(SUM(
      CASE tm.severity
        WHEN 'INFORMATIONAL' THEN COALESCE((v_config.severity_weights->>'INFORMATIONAL')::numeric, 0)
        WHEN 'LOW'           THEN COALESCE((v_config.severity_weights->>'LOW')::numeric, 1)
        WHEN 'MEDIUM'        THEN COALESCE((v_config.severity_weights->>'MEDIUM')::numeric, 3)
        WHEN 'HIGH'          THEN COALESCE((v_config.severity_weights->>'HIGH')::numeric, 5)
        WHEN 'CRITICAL'      THEN COALESCE((v_config.severity_weights->>'CRITICAL')::numeric, 10)
        ELSE 0
      END
    ), 0) INTO v_weighted_score
    FROM agent_graph.threat_memory tm
    WHERE tm.resolved = false
      AND tm.scope_type = p_scope_type
      AND tm.scope_id = p_scope_id
      AND tm.threat_class = v_config.threat_class
      AND tm.detected_at > now() - (v_config.window_minutes || ' minutes')::interval;

    IF v_weighted_score >= v_config.level_4_threshold THEN
      v_max_level := GREATEST(v_max_level, 4);
    ELSIF v_weighted_score >= v_config.level_3_threshold THEN
      v_max_level := GREATEST(v_max_level, 3);
    ELSIF v_weighted_score >= v_config.level_2_threshold THEN
      v_max_level := GREATEST(v_max_level, 2);
    ELSIF v_weighted_score >= v_config.level_1_threshold THEN
      v_max_level := GREATEST(v_max_level, 1);
    END IF;
  END LOOP;

  RETURN v_max_level;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION agent_graph.verify_threat_memory_chain()
RETURNS TABLE(is_valid BOOLEAN, last_verified TIMESTAMPTZ, break_point TEXT) AS $$
DECLARE
  v_last_checked TIMESTAMPTZ;
  v_break TEXT := NULL;
BEGIN
  SELECT tm.id, tm.detected_at INTO v_break, v_last_checked
  FROM (
    SELECT id, detected_at, prev_hash, hash_chain_current,
      LAG(hash_chain_current) OVER (ORDER BY detected_at, id) as expected_prev
    FROM agent_graph.threat_memory
  ) tm
  WHERE tm.prev_hash IS NOT NULL
    AND tm.expected_prev IS NOT NULL
    AND tm.prev_hash != tm.expected_prev
  ORDER BY tm.detected_at
  LIMIT 1;

  IF v_break IS NULL THEN
    SELECT MAX(detected_at) INTO v_last_checked
    FROM agent_graph.threat_memory;
    RETURN QUERY SELECT true, COALESCE(v_last_checked, now()), NULL::TEXT;
  ELSE
    RETURN QUERY SELECT false, v_last_checked, v_break;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- check_permission (ADR-017)
CREATE OR REPLACE FUNCTION agent_graph.check_permission(
  p_agent_id TEXT,
  p_resource_type TEXT,
  p_resource_name TEXT
) RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM agent_graph.permission_grants
    WHERE agent_id = p_agent_id
      AND resource_type = p_resource_type
      AND resource_name = p_resource_name
      AND revoked_at IS NULL
  );
END;
$$ LANGUAGE plpgsql STABLE;

-- Hash checkpoint function
CREATE OR REPLACE FUNCTION agent_graph.create_hash_checkpoint()
RETURNS VOID AS $$
BEGIN
  -- Placeholder: hash_checkpoints table was dropped (0 code refs)
  -- Function retained for compatibility; no-op.
END;
$$ LANGUAGE plpgsql;

-- Delegation depth auto-compute
CREATE OR REPLACE FUNCTION agent_graph.compute_delegation_depth()
RETURNS TRIGGER AS $$
DECLARE
  v_parent_depth INTEGER;
BEGIN
  IF NEW.parent_id IS NOT NULL THEN
    SELECT delegation_depth INTO v_parent_depth
    FROM agent_graph.work_items
    WHERE id = NEW.parent_id;
    NEW.delegation_depth := COALESCE(v_parent_depth, 0) + 1;
  ELSE
    NEW.delegation_depth := 0;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Assignment enforcement (generalized)
CREATE OR REPLACE FUNCTION agent_graph.enforce_assignment_rules()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.assigned_to IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.created_by = NEW.assigned_to THEN
    RETURN NEW;
  END IF;
  IF NEW.created_by = 'board' OR NEW.created_by LIKE 'human:%' THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM agent_graph.agent_assignment_rules
    WHERE agent_id = NEW.created_by AND can_assign = NEW.assigned_to
  ) THEN
    RAISE EXCEPTION 'Agent "%" is not authorized to assign work to "%" (P2: infrastructure enforces)',
      NEW.created_by, NEW.assigned_to;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Finance: compute monthly allocation
CREATE OR REPLACE FUNCTION autobot_finance.compute_monthly_allocation(p_month DATE)
RETURNS VOID AS $$
DECLARE
  v_revenue NUMERIC(15,6);
  v_expenses NUMERIC(15,6);
  v_net NUMERIC(15,6);
  v_reinvest NUMERIC(15,6);
  v_data_fees NUMERIC(15,6);
  v_distribution NUMERIC(15,6);
  v_eligible BOOLEAN;
  v_trailing_revenue NUMERIC(15,6);
  v_trailing_expenses NUMERIC(15,6);
BEGIN
  SELECT COALESCE(SUM(amount), 0) INTO v_revenue
  FROM autobot_finance.revenue WHERE period_month = p_month;

  SELECT COALESCE(SUM(amount), 0) INTO v_expenses
  FROM autobot_finance.expenses WHERE period_month = p_month;

  v_net := v_revenue - v_expenses;

  SELECT COALESCE(AVG(gross_revenue), 0), COALESCE(AVG(total_expenses), 0)
  INTO v_trailing_revenue, v_trailing_expenses
  FROM autobot_finance.monthly_allocations
  WHERE period_month >= p_month - interval '3 months' AND period_month < p_month;

  v_eligible := v_trailing_revenue > 0 AND v_trailing_revenue > (v_trailing_expenses * 1.5);

  IF v_net > 0 AND v_eligible THEN
    v_reinvest := autobot_finance.bankers_round(v_net * 0.40, 6);
    v_data_fees := autobot_finance.bankers_round(v_net * 0.20, 6);
    v_distribution := v_net - v_reinvest - v_data_fees;
  ELSE
    v_reinvest := GREATEST(v_net, 0);
    v_data_fees := 0;
    v_distribution := 0;
  END IF;

  INSERT INTO autobot_finance.monthly_allocations
    (period_month, gross_revenue, total_expenses, net_profit,
     reinvestment, data_contribution_fees, random_distribution,
     distribution_eligible, is_shadow_mode)
  VALUES
    (p_month, v_revenue, v_expenses, v_net,
     v_reinvest, v_data_fees, v_distribution,
     v_eligible, true)
  ON CONFLICT (period_month) DO UPDATE SET
    gross_revenue = EXCLUDED.gross_revenue,
    total_expenses = EXCLUDED.total_expenses,
    net_profit = EXCLUDED.net_profit,
    reinvestment = EXCLUDED.reinvestment,
    data_contribution_fees = EXCLUDED.data_contribution_fees,
    random_distribution = EXCLUDED.random_distribution,
    distribution_eligible = EXCLUDED.distribution_eligible,
    computed_at = now();
END;
$$ LANGUAGE plpgsql;

-- Deploy events (pipeline startups + code deploys)
CREATE TABLE IF NOT EXISTS agent_graph.deploy_events (
  id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  event_type TEXT NOT NULL CHECK (event_type IN ('pipeline_start', 'code_deploy', 'manual')),
  git_sha    TEXT,
  metadata   JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE agent_graph.deploy_events IS
  'Infrastructure event log for deploy tracking. Feeds metric 12 (promotion-to-production lag).';

-- Spec proposals: agents propose spec changes, board reviews
CREATE TABLE agent_graph.spec_proposals (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  agent_tier TEXT NOT NULL,
  agent_name TEXT,
  work_item_id TEXT REFERENCES agent_graph.work_items(id),
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  sections JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'revision-requested', 'superseded')),
  board_feedback TEXT,
  revision_of TEXT REFERENCES agent_graph.spec_proposals(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by TEXT
);

CREATE TABLE agent_graph.spec_proposal_transitions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES agent_graph.spec_proposals(id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor TEXT,
  feedback TEXT,
  transitioned_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Agent intents: self-initiated work proposals with board governance
CREATE TABLE agent_graph.agent_intents (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  agent_id TEXT NOT NULL,
  agent_tier TEXT NOT NULL,
  intent_type TEXT NOT NULL CHECK (intent_type IN ('task', 'directive', 'observation', 'schedule', 'governance')),
  decision_tier TEXT NOT NULL DEFAULT 'tactical'
    CHECK (decision_tier IN ('tactical', 'strategic', 'existential')),
  title TEXT NOT NULL,
  reasoning TEXT NOT NULL,
  proposed_action JSONB NOT NULL,
  trigger_context JSONB,
  trigger_type TEXT NOT NULL DEFAULT 'once'
    CHECK (trigger_type IN ('once', 'interval', 'cron', 'condition')),
  trigger_config JSONB,
  next_fire_at TIMESTAMPTZ,
  last_fired_at TIMESTAMPTZ,
  fire_count INTEGER NOT NULL DEFAULT 0,
  max_fires INTEGER,
  cooldown_ms INTEGER,
  budget_per_fire NUMERIC(10,4),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'executed')),
  board_feedback TEXT,
  reviewed_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ,
  executed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ
);

CREATE TABLE agent_graph.agent_intent_transitions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  intent_id TEXT NOT NULL REFERENCES agent_graph.agent_intents(id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor TEXT,
  feedback TEXT,
  transitioned_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Research iterations: append-only audit trail for deep research
CREATE TABLE agent_graph.research_iterations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workstream_id   TEXT NOT NULL REFERENCES agent_graph.work_items(id),
  iteration_num   INTEGER NOT NULL,
  hypothesis      TEXT NOT NULL,
  queries         JSONB NOT NULL DEFAULT '[]',
  sources         JSONB NOT NULL DEFAULT '[]',
  findings        JSONB NOT NULL DEFAULT '[]',
  coverage_score  NUMERIC(5,4) DEFAULT 0
                  CHECK (coverage_score >= 0 AND coverage_score <= 1),
  delta_score     NUMERIC(10,4) DEFAULT 0
                  CHECK (delta_score >= 0),
  decision        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (decision IN ('kept', 'discarded', 'pending')),
  cost_usd        NUMERIC(15,6) DEFAULT 0,
  duration_ms     INTEGER,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workstream_id, iteration_num)
);

-- Auto-log intent transitions (P3)
CREATE OR REPLACE FUNCTION agent_graph.log_intent_transition()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO agent_graph.agent_intent_transitions
      (intent_id, from_status, to_status, actor, feedback)
    VALUES (
      NEW.id,
      OLD.status,
      NEW.status,
      COALESCE(current_setting('app.agent_id', true), 'system'),
      NEW.board_feedback
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Expire stale intents
CREATE OR REPLACE FUNCTION agent_graph.expire_stale_intents()
RETURNS INTEGER AS $$
DECLARE
  expired_count INTEGER;
BEGIN
  UPDATE agent_graph.agent_intents
  SET status = 'expired'
  WHERE status = 'pending'
    AND expires_at IS NOT NULL
    AND expires_at < now();
  GET DIAGNOSTICS expired_count = ROW_COUNT;
  RETURN expired_count;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- Learned patterns: aggregate patterns mined from work_items (ADR-019)
-- ============================================================

CREATE TABLE IF NOT EXISTS agent_graph.learned_patterns (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     TEXT NOT NULL,
  pattern_type TEXT NOT NULL CHECK (pattern_type IN (
    'success_rate', 'delegation_path', 'cost_efficiency',
    'duration_trend', 'failure_mode',
    'time_of_day', 'thread_depth', 'sender_type'
  )),
  description  TEXT NOT NULL CHECK (length(description) <= 500),
  metric_value NUMERIC,
  confidence   NUMERIC CHECK (confidence >= 0 AND confidence <= 1),
  sample_size  INTEGER NOT NULL DEFAULT 0,
  period_start TIMESTAMPTZ NOT NULL,
  period_end   TIMESTAMPTZ NOT NULL,
  metadata     JSONB DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Idempotency: upsert on this constraint (Linus requirement)
  UNIQUE (agent_id, pattern_type, period_start, period_end)
);

-- ============================================================
-- Learning insights: feeds into governance feed
-- ============================================================

CREATE TABLE IF NOT EXISTS agent_graph.learning_insights (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  insight_type   TEXT NOT NULL CHECK (insight_type IN (
    'success_rate_drop', 'new_failure_mode', 'cost_anomaly',
    'delegation_degradation', 'autonomy_ready'
  )),
  agent_id       TEXT NOT NULL,
  title          TEXT NOT NULL,
  summary        TEXT NOT NULL,
  severity       TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  metric_current NUMERIC,
  metric_prior   NUMERIC,
  metric_delta   NUMERIC,
  sample_size    INTEGER,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- Per-agent autonomy levels (replaces AUTONOMY_LEVEL env var)
-- ============================================================

CREATE TABLE IF NOT EXISTS agent_graph.autonomy_levels (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      TEXT NOT NULL UNIQUE,
  current_level INTEGER NOT NULL DEFAULT 0 CHECK (current_level IN (0, 1, 2)),
  promoted_at   TIMESTAMPTZ,
  promoted_by   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- Autonomy promotions log (append-only audit trail, P3)
-- ============================================================

CREATE TABLE IF NOT EXISTS agent_graph.autonomy_promotions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id          TEXT NOT NULL,
  from_level        INTEGER NOT NULL,
  to_level          INTEGER NOT NULL,
  promoted_by       TEXT NOT NULL,
  notes             TEXT,
  criteria_snapshot  JSONB NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Prevent mutations on promotion log (P3: append-only)
CREATE OR REPLACE FUNCTION agent_graph.prevent_promotion_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'autonomy_promotions is append-only (P3)';
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- TRIGGERS
-- ============================================================

-- Append-only: autonomy_promotions
DROP TRIGGER IF EXISTS trg_prevent_promotion_mutation ON agent_graph.autonomy_promotions;
CREATE TRIGGER trg_prevent_promotion_mutation
  BEFORE UPDATE OR DELETE ON agent_graph.autonomy_promotions
  FOR EACH ROW EXECUTE FUNCTION agent_graph.prevent_promotion_mutation();

-- Edge cycle prevention
CREATE TRIGGER trg_edges_no_cycle
  BEFORE INSERT ON agent_graph.edges
  FOR EACH ROW EXECUTE FUNCTION agent_graph.check_cycle_trigger();

-- Append-only: state_transitions
CREATE TRIGGER trg_state_transitions_no_update
  BEFORE UPDATE ON agent_graph.state_transitions
  FOR EACH ROW EXECUTE FUNCTION agent_graph.prevent_mutation();

CREATE TRIGGER trg_state_transitions_no_delete
  BEFORE DELETE ON agent_graph.state_transitions
  FOR EACH ROW EXECUTE FUNCTION agent_graph.prevent_mutation();

-- Append-only: edit_deltas
CREATE TRIGGER trg_edit_deltas_no_update
  BEFORE UPDATE ON voice.edit_deltas
  FOR EACH ROW EXECUTE FUNCTION voice.prevent_mutation();

CREATE TRIGGER trg_edit_deltas_no_delete
  BEFORE DELETE ON voice.edit_deltas
  FOR EACH ROW EXECUTE FUNCTION voice.prevent_mutation();

-- Append-only: agent_config_history
CREATE TRIGGER trg_config_history_no_update
  BEFORE UPDATE ON agent_graph.agent_config_history
  FOR EACH ROW EXECUTE FUNCTION agent_graph.prevent_mutation();

CREATE TRIGGER trg_config_history_no_delete
  BEFORE DELETE ON agent_graph.agent_config_history
  FOR EACH ROW EXECUTE FUNCTION agent_graph.prevent_mutation();

-- Append-only: halt_signals (no delete)
CREATE TRIGGER trg_halt_signals_no_delete
  BEFORE DELETE ON agent_graph.halt_signals
  FOR EACH ROW EXECUTE FUNCTION agent_graph.prevent_mutation();

-- Append-only: tool_invocations
CREATE TRIGGER trg_tool_invocations_no_update
  BEFORE UPDATE ON agent_graph.tool_invocations
  FOR EACH ROW EXECUTE FUNCTION agent_graph.prevent_mutation();

CREATE TRIGGER trg_tool_invocations_no_delete
  BEFORE DELETE ON agent_graph.tool_invocations
  FOR EACH ROW EXECUTE FUNCTION agent_graph.prevent_mutation();

-- Append-only: event_log
CREATE TRIGGER trg_event_log_no_update
  BEFORE UPDATE ON autobot_public.event_log
  FOR EACH ROW EXECUTE FUNCTION autobot_public.prevent_mutation();

CREATE TRIGGER trg_event_log_no_delete
  BEFORE DELETE ON autobot_public.event_log
  FOR EACH ROW EXECUTE FUNCTION autobot_public.prevent_mutation();

-- Append-only: audit_findings (delete only — update needed for status workflow)
CREATE TRIGGER trg_audit_findings_no_delete
  BEFORE DELETE ON agent_graph.audit_findings
  FOR EACH ROW EXECUTE FUNCTION agent_graph.prevent_mutation();

-- Append-only: finance tables
CREATE TRIGGER trg_ledger_immutable
  BEFORE UPDATE OR DELETE ON autobot_finance.ledger
  FOR EACH ROW EXECUTE FUNCTION autobot_finance.prevent_ledger_mutation();

CREATE TRIGGER trg_revenue_immutable
  BEFORE UPDATE OR DELETE ON autobot_finance.revenue
  FOR EACH ROW EXECUTE FUNCTION autobot_finance.prevent_revenue_mutation();

CREATE TRIGGER trg_expenses_immutable
  BEFORE UPDATE OR DELETE ON autobot_finance.expenses
  FOR EACH ROW EXECUTE FUNCTION autobot_finance.prevent_expenses_mutation();

-- Append-only: distribution_ledger
CREATE TRIGGER trg_distrib_ledger_immutable
  BEFORE UPDATE OR DELETE ON autobot_distrib.distribution_ledger
  FOR EACH ROW EXECUTE FUNCTION autobot_distrib.prevent_distrib_ledger_mutation();

-- Append-only: threat_memory
CREATE TRIGGER trg_threat_memory_immutable
  BEFORE UPDATE OR DELETE ON agent_graph.threat_memory
  FOR EACH ROW EXECUTE FUNCTION agent_graph.prevent_threat_memory_mutation();

-- Delegation depth auto-compute
CREATE TRIGGER trg_compute_delegation_depth
  BEFORE INSERT ON agent_graph.work_items
  FOR EACH ROW EXECUTE FUNCTION agent_graph.compute_delegation_depth();

-- Assignment enforcement (generalized)
CREATE TRIGGER trg_enforce_assignment_rules
  BEFORE INSERT OR UPDATE ON agent_graph.work_items
  FOR EACH ROW EXECUTE FUNCTION agent_graph.enforce_assignment_rules();

-- Auto-log intent transitions
CREATE TRIGGER trg_intent_transition
  AFTER UPDATE ON agent_graph.agent_intents
  FOR EACH ROW
  EXECUTE FUNCTION agent_graph.log_intent_transition();

-- Conditional FK: work_items.created_by → agent_configs(id)
DO $$
DECLARE
  orphan_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO orphan_count
  FROM agent_graph.work_items w
  LEFT JOIN agent_graph.agent_configs ac ON ac.id = w.created_by
  WHERE ac.id IS NULL;

  IF orphan_count = 0 THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE constraint_name = 'fk_work_items_created_by'
        AND table_schema = 'agent_graph'
        AND table_name = 'work_items'
    ) THEN
      ALTER TABLE agent_graph.work_items
        ADD CONSTRAINT fk_work_items_created_by
        FOREIGN KEY (created_by) REFERENCES agent_graph.agent_configs(id);
    END IF;
  END IF;
END $$;

-- ============================================================
-- REVOKE TRUNCATE on append-only tables
-- ============================================================
REVOKE TRUNCATE ON agent_graph.state_transitions FROM PUBLIC;
REVOKE TRUNCATE ON agent_graph.agent_config_history FROM PUBLIC;
REVOKE TRUNCATE ON agent_graph.halt_signals FROM PUBLIC;
REVOKE TRUNCATE ON agent_graph.tool_invocations FROM PUBLIC;
REVOKE TRUNCATE ON agent_graph.audit_findings FROM PUBLIC;
REVOKE TRUNCATE ON agent_graph.threat_memory FROM PUBLIC;
REVOKE TRUNCATE ON voice.edit_deltas FROM PUBLIC;
REVOKE TRUNCATE ON autobot_public.event_log FROM PUBLIC;
REVOKE TRUNCATE ON autobot_comms.outbound_intents FROM PUBLIC;
REVOKE TRUNCATE ON autobot_finance.ledger FROM PUBLIC;
REVOKE TRUNCATE ON autobot_finance.revenue FROM PUBLIC;
REVOKE TRUNCATE ON autobot_finance.expenses FROM PUBLIC;
REVOKE TRUNCATE ON autobot_distrib.distribution_ledger FROM PUBLIC;

REVOKE TRIGGER ON agent_graph.state_transitions FROM PUBLIC;
REVOKE TRIGGER ON agent_graph.agent_config_history FROM PUBLIC;
REVOKE TRIGGER ON agent_graph.halt_signals FROM PUBLIC;
REVOKE TRIGGER ON agent_graph.threat_memory FROM PUBLIC;
REVOKE TRIGGER ON voice.edit_deltas FROM PUBLIC;

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE agent_graph.work_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_graph.state_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_graph.task_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_graph.llm_invocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_graph.action_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbox.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE voice.edit_deltas ENABLE ROW LEVEL SECURITY;

CREATE POLICY agent_read_work_items ON agent_graph.work_items
  FOR SELECT USING (
    assigned_to = agent_graph.current_agent_id()
    OR created_by = agent_graph.current_agent_id()
    OR parent_id IS NULL
    OR current_setting('app.role', true) = 'board'
  );

CREATE POLICY agent_update_work_items ON agent_graph.work_items
  FOR UPDATE USING (
    assigned_to = agent_graph.current_agent_id()
    OR current_setting('app.role', true) = 'board'
  );

CREATE POLICY no_delete_work_items ON agent_graph.work_items
  FOR DELETE USING (false);

CREATE POLICY read_transitions ON agent_graph.state_transitions
  FOR SELECT USING (true);

CREATE POLICY insert_transitions ON agent_graph.state_transitions
  FOR INSERT WITH CHECK (true);

CREATE POLICY agent_read_events ON agent_graph.task_events
  FOR SELECT USING (
    target_agent_id = agent_graph.current_agent_id()
    OR current_setting('app.role', true) = 'board'
  );

CREATE POLICY agent_insert_events ON agent_graph.task_events
  FOR INSERT WITH CHECK (true);

CREATE POLICY agent_read_invocations ON agent_graph.llm_invocations
  FOR SELECT USING (
    agent_id = agent_graph.current_agent_id()
    OR current_setting('app.role', true) = 'board'
  );

CREATE POLICY read_messages ON inbox.messages
  FOR SELECT USING (true);

CREATE POLICY read_edit_deltas ON voice.edit_deltas
  FOR SELECT USING (true);

CREATE POLICY insert_edit_deltas ON voice.edit_deltas
  FOR INSERT WITH CHECK (true);

CREATE POLICY read_action_proposals ON agent_graph.action_proposals
  FOR SELECT USING (true);

-- ============================================================
-- ROLES
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'autobot_agent') THEN
    CREATE ROLE autobot_agent LOGIN NOINHERIT;
  END IF;
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

-- Grant schema usage (guarded: postgres role does not exist in PGlite/test environments)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
    GRANT USAGE ON SCHEMA agent_graph TO postgres;
    GRANT USAGE ON SCHEMA inbox TO postgres;
    GRANT USAGE ON SCHEMA voice TO postgres;
    GRANT USAGE ON SCHEMA signal TO postgres;
    GRANT USAGE ON SCHEMA content TO postgres;
    GRANT USAGE ON SCHEMA autobot_public TO postgres;
    GRANT USAGE ON SCHEMA autobot_comms TO postgres;
    GRANT USAGE ON SCHEMA autobot_finance TO postgres;
    GRANT USAGE ON SCHEMA autobot_distrib TO postgres;
    GRANT USAGE ON SCHEMA autobot_value TO postgres;

    GRANT ALL ON ALL TABLES IN SCHEMA agent_graph TO postgres;
    GRANT ALL ON ALL TABLES IN SCHEMA inbox TO postgres;
    GRANT ALL ON ALL TABLES IN SCHEMA voice TO postgres;
    GRANT ALL ON ALL TABLES IN SCHEMA signal TO postgres;
    GRANT ALL ON ALL TABLES IN SCHEMA content TO postgres;
    GRANT ALL ON ALL TABLES IN SCHEMA autobot_public TO postgres;
    GRANT ALL ON ALL TABLES IN SCHEMA autobot_comms TO postgres;
    GRANT ALL ON ALL TABLES IN SCHEMA autobot_finance TO postgres;
    GRANT ALL ON ALL TABLES IN SCHEMA autobot_distrib TO postgres;
    GRANT ALL ON ALL TABLES IN SCHEMA autobot_value TO postgres;

    GRANT USAGE ON ALL SEQUENCES IN SCHEMA agent_graph TO postgres;
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA inbox TO postgres;
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA voice TO postgres;
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA signal TO postgres;
  END IF;
END $$;

REVOKE TRUNCATE ON agent_graph.state_transitions FROM PUBLIC;
REVOKE TRUNCATE ON agent_graph.agent_config_history FROM PUBLIC;
REVOKE TRUNCATE ON agent_graph.halt_signals FROM PUBLIC;
REVOKE TRUNCATE ON voice.edit_deltas FROM PUBLIC;

REVOKE TRIGGER ON agent_graph.state_transitions FROM PUBLIC;
REVOKE TRIGGER ON agent_graph.agent_config_history FROM PUBLIC;
REVOKE TRIGGER ON agent_graph.halt_signals FROM PUBLIC;
REVOKE TRIGGER ON voice.edit_deltas FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'autobot_agent') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA agent_graph TO autobot_agent';
    EXECUTE 'GRANT USAGE ON SCHEMA inbox TO autobot_agent';
    EXECUTE 'GRANT USAGE ON SCHEMA voice TO autobot_agent';
    EXECUTE 'GRANT USAGE ON SCHEMA signal TO autobot_agent';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA agent_graph TO autobot_agent';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA inbox TO autobot_agent';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA voice TO autobot_agent';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA signal TO autobot_agent';
    EXECUTE 'GRANT USAGE ON ALL SEQUENCES IN SCHEMA agent_graph TO autobot_agent';
    EXECUTE 'GRANT USAGE ON ALL SEQUENCES IN SCHEMA inbox TO autobot_agent';
    EXECUTE 'GRANT USAGE ON ALL SEQUENCES IN SCHEMA voice TO autobot_agent';
    EXECUTE 'GRANT USAGE ON ALL SEQUENCES IN SCHEMA signal TO autobot_agent';
    EXECUTE 'REVOKE DELETE ON ALL TABLES IN SCHEMA agent_graph FROM autobot_agent';
    EXECUTE 'REVOKE DELETE ON ALL TABLES IN SCHEMA inbox FROM autobot_agent';
    EXECUTE 'REVOKE TRUNCATE ON ALL TABLES IN SCHEMA agent_graph FROM autobot_agent';
    EXECUTE 'REVOKE TRUNCATE ON ALL TABLES IN SCHEMA inbox FROM autobot_agent';
    EXECUTE 'REVOKE TRIGGER ON agent_graph.state_transitions FROM autobot_agent';
    EXECUTE 'REVOKE TRIGGER ON agent_graph.agent_config_history FROM autobot_agent';
    EXECUTE 'REVOKE TRIGGER ON agent_graph.halt_signals FROM autobot_agent';
    EXECUTE 'REVOKE TRIGGER ON voice.edit_deltas FROM autobot_agent';
  END IF;
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

-- JWT identity: enable SET ROLE autobot_agent
GRANT autobot_agent TO CURRENT_USER;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'autobot') THEN
    EXECUTE 'GRANT autobot_agent TO autobot';
  END IF;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA agent_graph TO autobot_agent;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA inbox TO autobot_agent;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA voice TO autobot_agent;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA signal TO autobot_agent;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'content') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA content TO autobot_agent';
    EXECUTE 'GRANT SELECT ON ALL TABLES IN SCHEMA content TO autobot_agent';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'autobot_public') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA autobot_public TO autobot_agent';
    EXECUTE 'GRANT SELECT ON ALL TABLES IN SCHEMA autobot_public TO autobot_agent';
  END IF;
END $$;

ALTER DEFAULT PRIVILEGES IN SCHEMA agent_graph
  GRANT SELECT, INSERT, UPDATE ON TABLES TO autobot_agent;
ALTER DEFAULT PRIVILEGES IN SCHEMA inbox
  GRANT SELECT, INSERT, UPDATE ON TABLES TO autobot_agent;
ALTER DEFAULT PRIVILEGES IN SCHEMA voice
  GRANT SELECT, INSERT, UPDATE ON TABLES TO autobot_agent;
ALTER DEFAULT PRIVILEGES IN SCHEMA signal
  GRANT SELECT, INSERT, UPDATE ON TABLES TO autobot_agent;

COMMENT ON SCHEMA agent_graph IS 'Core task graph: work items, edges, state transitions, events, budgets';
COMMENT ON SCHEMA inbox IS 'Email metadata only (D1: never stores body), triage, drafts';
COMMENT ON SCHEMA voice IS 'Voice learning: sent email corpus, profiles, edit deltas (D4: append-only)';
COMMENT ON SCHEMA signal IS 'Signal extraction: contacts, topics, daily briefings';
COMMENT ON SCHEMA content IS 'Content generation: topics, LinkedIn automation (Phase 1.5)';
COMMENT ON SCHEMA autobot_public IS 'Public transparency: event log (spec §8)';
COMMENT ON SCHEMA autobot_comms IS 'Communication gateway: outbound intents, inbound processing (spec §7)';
COMMENT ON SCHEMA autobot_finance IS 'Financial Script: revenue, expenses, allocations (spec §12-13)';
COMMENT ON SCHEMA autobot_distrib IS 'Distribution Mechanism: rounds, recipients, transactions (spec §13)';
COMMENT ON SCHEMA autobot_value IS 'Value Measurement Script: products, metrics, assessments (spec §13)';

-- ============================================================
-- FROM: 003
-- ============================================================

-- 003-indexes-and-constraints.sql
-- Consolidated baseline: All indexes, FK constraints, unique constraints
-- Squashed from migrations 001-044

-- ============================================================
-- agent_graph indexes
-- ============================================================

-- work_items
CREATE INDEX idx_work_items_status ON agent_graph.work_items(status);
CREATE INDEX idx_work_items_assigned ON agent_graph.work_items(assigned_to) WHERE assigned_to IS NOT NULL;
CREATE INDEX idx_work_items_parent ON agent_graph.work_items(parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX idx_work_items_type ON agent_graph.work_items(type);
CREATE INDEX idx_work_items_created_by ON agent_graph.work_items(created_by);
CREATE INDEX idx_work_items_account ON agent_graph.work_items(account_id) WHERE account_id IS NOT NULL;

-- edges
CREATE INDEX idx_edges_from ON agent_graph.edges(from_id);
CREATE INDEX idx_edges_to ON agent_graph.edges(to_id);

-- state_transitions
CREATE INDEX idx_state_transitions_work_item ON agent_graph.state_transitions(work_item_id, created_at DESC);
CREATE INDEX idx_state_transitions_agent ON agent_graph.state_transitions(agent_id, created_at DESC);

-- agent_config_history
CREATE INDEX idx_agent_config_history_agent ON agent_graph.agent_config_history(agent_id);

-- task_events
CREATE INDEX idx_task_events_pending ON agent_graph.task_events(target_agent_id, priority, created_at)
  WHERE processed_at IS NULL;
CREATE UNIQUE INDEX idx_task_events_idempotency
  ON agent_graph.task_events (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- llm_invocations
CREATE INDEX idx_llm_invocations_agent ON agent_graph.llm_invocations(agent_id, created_at DESC);
CREATE INDEX idx_llm_invocations_date ON agent_graph.llm_invocations(created_at);
CREATE INDEX idx_llm_invocations_account ON agent_graph.llm_invocations(account_id) WHERE account_id IS NOT NULL;

-- budgets
CREATE INDEX idx_budgets_account ON agent_graph.budgets(account_id, period_start);

-- halt_signals
CREATE INDEX idx_halt_signals_active ON agent_graph.halt_signals(is_active) WHERE is_active = true;

-- strategic_decisions
CREATE INDEX idx_strategic_decisions_pending ON agent_graph.strategic_decisions(created_at)
  WHERE board_verdict IS NULL;
CREATE INDEX idx_strategic_decisions_work_item ON agent_graph.strategic_decisions(work_item_id);
CREATE INDEX idx_strategic_decisions_agent ON agent_graph.strategic_decisions(agent_id);

-- tool_registry
CREATE INDEX idx_tool_registry_name ON agent_graph.tool_registry(tool_name);

-- tool_invocations
CREATE INDEX idx_tool_invocations_agent ON agent_graph.tool_invocations(agent_id, created_at DESC);
CREATE INDEX idx_tool_invocations_tool ON agent_graph.tool_invocations(tool_name, created_at DESC);

-- action_proposals
CREATE INDEX idx_action_proposals_account ON agent_graph.action_proposals(account_id) WHERE account_id IS NOT NULL;
CREATE INDEX idx_action_proposals_type ON agent_graph.action_proposals(action_type);
CREATE INDEX idx_action_proposals_message ON agent_graph.action_proposals(message_id) WHERE message_id IS NOT NULL;
CREATE INDEX idx_action_proposals_topic ON agent_graph.action_proposals(topic_id) WHERE topic_id IS NOT NULL;
CREATE INDEX idx_action_proposals_pending ON agent_graph.action_proposals(created_at DESC)
  WHERE board_action IS NULL AND reviewer_verdict IS NOT NULL;
CREATE INDEX idx_action_proposals_send_state ON agent_graph.action_proposals(send_state)
  WHERE send_state NOT IN ('delivered', 'cancelled');
CREATE INDEX idx_action_proposals_work_item ON agent_graph.action_proposals(work_item_id) WHERE work_item_id IS NOT NULL;
CREATE INDEX idx_action_proposals_channel ON agent_graph.action_proposals(channel)
  WHERE board_action IS NULL AND reviewer_verdict IS NOT NULL;
CREATE INDEX idx_action_proposals_linear ON agent_graph.action_proposals(linear_issue_id) WHERE linear_issue_id IS NOT NULL;
CREATE INDEX idx_action_proposals_github_pr ON agent_graph.action_proposals(github_pr_number) WHERE github_pr_number IS NOT NULL;

-- board_interventions
CREATE INDEX idx_board_interventions_type ON agent_graph.board_interventions(intervention_type);
CREATE INDEX idx_board_interventions_created ON agent_graph.board_interventions(created_at DESC);

-- constitutional_evaluations
CREATE INDEX idx_const_eval_mode ON agent_graph.constitutional_evaluations(evaluation_mode);
CREATE INDEX idx_const_eval_verdict ON agent_graph.constitutional_evaluations(overall_verdict);

-- audit_findings
CREATE INDEX idx_audit_findings_tier ON agent_graph.audit_findings(audit_tier);
CREATE INDEX idx_audit_findings_status ON agent_graph.audit_findings(status);
CREATE INDEX idx_audit_findings_severity ON agent_graph.audit_findings(severity);

-- sanitization_rule_sets
CREATE INDEX idx_sanitization_rule_sets_active
  ON agent_graph.sanitization_rule_sets(is_active) WHERE is_active = true;
CREATE INDEX idx_sanitization_rule_sets_version
  ON agent_graph.sanitization_rule_sets(version);
CREATE UNIQUE INDEX idx_sanitization_rule_sets_single_active
  ON agent_graph.sanitization_rule_sets(is_active) WHERE is_active = true;

-- sanitization_test_results
CREATE INDEX idx_sanitization_test_results_rule_set
  ON agent_graph.sanitization_test_results(rule_set_id);

-- capability_gates
CREATE INDEX idx_capability_gates_gate_measured
  ON agent_graph.capability_gates(gate_id, measured_at DESC);

-- gate_snapshots
CREATE INDEX idx_gate_snapshots_date ON agent_graph.gate_snapshots(snapshot_date DESC);

-- agent_shadow_mode
CREATE INDEX idx_agent_shadow_mode_agent_status
  ON agent_graph.agent_shadow_mode(agent_id, status);

-- shadow_mode_comparisons
CREATE INDEX idx_shadow_mode_comparisons_run
  ON agent_graph.shadow_mode_comparisons(shadow_run_id);

-- strategy_evaluations
CREATE INDEX idx_strategy_evaluations_decision
  ON agent_graph.strategy_evaluations(decision_id);

-- perspective_evaluations
CREATE INDEX idx_perspective_evaluations_evaluation
  ON agent_graph.perspective_evaluations(evaluation_id);

-- shadow_strategy_comparisons
CREATE INDEX idx_shadow_strategy_comparisons_evaluation
  ON agent_graph.shadow_strategy_comparisons(evaluation_id);

-- exploration_metrics
CREATE INDEX idx_exploration_metrics_date
  ON agent_graph.exploration_metrics(measurement_date DESC);

-- merkle_proofs
CREATE INDEX idx_merkle_proofs_type_published
  ON agent_graph.merkle_proofs(proof_type, published_at DESC);

-- threat_memory
CREATE INDEX idx_threat_memory_scope
  ON agent_graph.threat_memory(scope_type, scope_id, detected_at DESC);
CREATE INDEX idx_threat_memory_unresolved
  ON agent_graph.threat_memory(resolved, severity, detected_at DESC)
  WHERE resolved = false;

-- permission_grants
CREATE INDEX idx_permission_grants_agent_active
  ON agent_graph.permission_grants(agent_id, resource_type) WHERE revoked_at IS NULL;
CREATE INDEX idx_permission_grants_resource_active
  ON agent_graph.permission_grants(resource_type, resource_name) WHERE revoked_at IS NULL;

-- learned_patterns
CREATE INDEX IF NOT EXISTS idx_learned_patterns_agent ON agent_graph.learned_patterns(agent_id);
CREATE INDEX IF NOT EXISTS idx_learned_patterns_type ON agent_graph.learned_patterns(pattern_type);
CREATE INDEX IF NOT EXISTS idx_learned_patterns_recent ON agent_graph.learned_patterns(created_at DESC);

-- learning_insights
CREATE INDEX IF NOT EXISTS idx_learning_insights_recent ON agent_graph.learning_insights(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_learning_insights_agent ON agent_graph.learning_insights(agent_id);

-- deploy_events
CREATE INDEX idx_deploy_events_created ON agent_graph.deploy_events(created_at DESC);

-- gate_snapshots UNIQUE constraint
ALTER TABLE agent_graph.gate_snapshots
  ADD CONSTRAINT gate_snapshots_snapshot_date_unique UNIQUE (snapshot_date);

-- spec_proposals
CREATE INDEX idx_spec_proposals_status ON agent_graph.spec_proposals(status);
CREATE INDEX idx_spec_proposals_created ON agent_graph.spec_proposals(created_at DESC);
CREATE INDEX idx_spec_proposals_revision_of ON agent_graph.spec_proposals(revision_of)
  WHERE revision_of IS NOT NULL;

-- spec_proposal_transitions
CREATE INDEX idx_spec_proposal_transitions_proposal
  ON agent_graph.spec_proposal_transitions(proposal_id);

-- agent_intents
CREATE INDEX idx_agent_intents_status ON agent_graph.agent_intents(status);
CREATE INDEX idx_agent_intents_agent ON agent_graph.agent_intents(agent_id);
CREATE INDEX idx_agent_intents_created ON agent_graph.agent_intents(created_at DESC);
CREATE INDEX idx_agent_intents_pending ON agent_graph.agent_intents(created_at)
  WHERE status = 'pending';

CREATE UNIQUE INDEX idx_agent_intents_pattern_dedup
  ON agent_graph.agent_intents (
    agent_id,
    (trigger_context->>'pattern'),
    COALESCE(trigger_context->>'contact_id', ''),
    COALESCE(trigger_context->>'message_id', '')
  )
  WHERE status IN ('pending', 'approved', 'executed');

CREATE INDEX idx_agent_intents_next_fire
  ON agent_graph.agent_intents(next_fire_at)
  WHERE status = 'approved' AND trigger_type IN ('interval', 'cron', 'condition');

-- agent_intent_transitions
CREATE INDEX idx_intent_transitions_intent ON agent_graph.agent_intent_transitions(intent_id);

-- research_iterations
CREATE INDEX idx_research_iterations_workstream
  ON agent_graph.research_iterations(workstream_id);

CREATE INDEX idx_research_iterations_kept
  ON agent_graph.research_iterations(workstream_id, iteration_num)
  WHERE decision = 'kept';

-- ============================================================
-- inbox indexes
-- ============================================================

-- messages
CREATE UNIQUE INDEX idx_messages_provider_msg_id ON inbox.messages(provider_msg_id) WHERE provider_msg_id IS NOT NULL;
CREATE UNIQUE INDEX idx_messages_channel_id ON inbox.messages(channel, channel_id) WHERE channel_id IS NOT NULL;
CREATE INDEX idx_messages_thread ON inbox.messages(thread_id);
CREATE INDEX idx_messages_from ON inbox.messages(from_address);
CREATE INDEX idx_messages_triage ON inbox.messages(triage_category) WHERE triage_category = 'pending';
CREATE INDEX idx_messages_unprocessed ON inbox.messages(received_at DESC) WHERE processed_at IS NULL;
CREATE INDEX idx_messages_received ON inbox.messages(received_at DESC);
CREATE INDEX idx_messages_work_item ON inbox.messages(work_item_id) WHERE work_item_id IS NOT NULL;
CREATE INDEX idx_messages_channel ON inbox.messages(channel);
CREATE INDEX idx_messages_account ON inbox.messages(account_id, received_at DESC);

-- signals
CREATE INDEX idx_signals_message ON inbox.signals(message_id);
CREATE INDEX idx_signals_type ON inbox.signals(signal_type);
-- Note: idx_signals_unresolved from 004 superseded by idx_signals_unresolved_due from 031
CREATE INDEX idx_signals_unresolved_due ON inbox.signals(due_date ASC NULLS LAST) WHERE resolved = false;
CREATE INDEX idx_signals_direction ON inbox.signals(direction) WHERE resolved = false;
CREATE INDEX idx_signals_domain ON inbox.signals(domain) WHERE domain != 'general';

-- drive_watches
CREATE UNIQUE INDEX idx_drive_watches_folder_id ON inbox.drive_watches(folder_id);

-- ============================================================
-- voice indexes
-- ============================================================

CREATE INDEX idx_sent_emails_to ON voice.sent_emails(to_address);
CREATE INDEX idx_sent_emails_sent ON voice.sent_emails(sent_at DESC);
CREATE INDEX idx_sent_emails_account ON voice.sent_emails(account_id) WHERE account_id IS NOT NULL;
CREATE INDEX idx_voice_profiles_account ON voice.profiles(account_id) WHERE account_id IS NOT NULL;
-- pgvector ivfflat index — only created when pgvector is available
DO $$ BEGIN
  CREATE INDEX idx_sent_emails_embedding ON voice.sent_emails
    USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Skipping ivfflat index — pgvector not available';
END $$;

CREATE INDEX idx_edit_deltas_recipient ON voice.edit_deltas(recipient);
CREATE INDEX idx_edit_deltas_created ON voice.edit_deltas(created_at DESC);
CREATE INDEX idx_edit_deltas_draft ON voice.edit_deltas(draft_id);
CREATE INDEX idx_edit_deltas_message ON voice.edit_deltas(message_id);

-- ============================================================
-- signal indexes
-- ============================================================

CREATE INDEX idx_contacts_email ON signal.contacts(email_address);
CREATE INDEX idx_contacts_source_account ON signal.contacts(source_account_id) WHERE source_account_id IS NOT NULL;
CREATE INDEX idx_contact_accounts_account ON signal.contact_accounts(account_id);
CREATE INDEX idx_contacts_vip ON signal.contacts(is_vip) WHERE is_vip = true;
CREATE INDEX idx_contacts_tier ON signal.contacts(tier);
CREATE INDEX idx_contacts_contact_type ON signal.contacts(contact_type) WHERE contact_type != 'unknown';
CREATE UNIQUE INDEX idx_contacts_phone ON signal.contacts(phone) WHERE phone IS NOT NULL;

CREATE INDEX idx_topics_trend ON signal.topics(trend_score DESC);

CREATE INDEX idx_briefings_account ON signal.briefings(account_id) WHERE account_id IS NOT NULL;

CREATE INDEX idx_feedback_signal_id ON signal.feedback(signal_id);
CREATE INDEX idx_feedback_created_at ON signal.feedback(created_at);

-- contact_projects
CREATE INDEX IF NOT EXISTS idx_contact_projects_contact
  ON signal.contact_projects(contact_id);

CREATE INDEX IF NOT EXISTS idx_contact_projects_platform
  ON signal.contact_projects(platform, is_active);

-- ============================================================
-- content indexes
-- ============================================================

CREATE INDEX idx_topics_status ON content.topics(scheduled_for) WHERE status = 'queued';

-- ============================================================
-- autobot_public indexes
-- ============================================================

CREATE INDEX idx_public_events_type ON autobot_public.event_log(event_type);
CREATE INDEX idx_public_events_created ON autobot_public.event_log(created_at DESC);

-- ============================================================
-- autobot_comms indexes
-- ============================================================

CREATE INDEX idx_outbound_intents_status ON autobot_comms.outbound_intents(status);
CREATE INDEX idx_outbound_intents_created ON autobot_comms.outbound_intents(created_at DESC);
CREATE INDEX idx_outbound_intents_channel_created ON autobot_comms.outbound_intents(channel, created_at);
CREATE INDEX idx_outbound_intents_status_pending ON autobot_comms.outbound_intents(status) WHERE status IN ('logged', 'approved');
CREATE INDEX idx_inbound_received ON autobot_comms.inbound_messages(received_at DESC);
CREATE UNIQUE INDEX idx_contact_email ON autobot_comms.contact_registry(email) WHERE email IS NOT NULL;

-- ============================================================
-- autobot_finance indexes
-- ============================================================

CREATE INDEX idx_finance_ledger_recorded ON autobot_finance.ledger(recorded_at DESC);
CREATE INDEX idx_finance_revenue_month ON autobot_finance.revenue(period_month);
CREATE INDEX idx_finance_expenses_month ON autobot_finance.expenses(period_month);

-- ============================================================
-- autobot_distrib indexes
-- ============================================================

CREATE INDEX idx_distrib_rounds_period ON autobot_distrib.distribution_rounds(period_month);
CREATE INDEX idx_distrib_txn_round ON autobot_distrib.distribution_transactions(round_id);
CREATE INDEX idx_distrib_txn_recipient ON autobot_distrib.distribution_transactions(recipient_id);

-- ============================================================
-- autobot_value indexes
-- ============================================================

CREATE INDEX idx_value_product_metrics_product_date ON autobot_value.product_metrics(product_id, measurement_date);
CREATE INDEX idx_value_assessments_product_type ON autobot_value.value_assessments(product_id, assessment_type);
CREATE INDEX idx_value_user_cohorts_product_month ON autobot_value.user_cohorts(product_id, cohort_month);

-- ============================================================
-- FROM: 004
-- ============================================================

-- 004-views.sql
-- Consolidated baseline: All views and computed functions
-- Squashed from migrations 001-044

-- ============================================================
-- agent_graph views
-- ============================================================

-- Budget status: real-time (NOT materialized — per spec review)
CREATE OR REPLACE VIEW agent_graph.v_budget_status AS
SELECT
  b.id,
  b.scope,
  b.scope_id,
  b.account_id,
  a.label AS account_label,
  a.identifier AS account_identifier,
  b.allocated_usd,
  b.spent_usd,
  b.reserved_usd,
  b.allocated_usd - b.spent_usd - b.reserved_usd AS remaining_usd,
  CASE WHEN b.allocated_usd > 0
    THEN ROUND((b.spent_usd / b.allocated_usd) * 100, 2)
    ELSE 0
  END AS utilization_pct,
  b.period_start,
  b.period_end,
  (SELECT COALESCE(SUM(cost_usd), 0) FROM agent_graph.llm_invocations
   WHERE created_at >= b.period_start AND created_at < b.period_end + interval '1 day') AS actual_spend_usd
FROM agent_graph.budgets b
LEFT JOIN inbox.accounts a ON a.id = b.account_id
WHERE b.period_end >= CURRENT_DATE;

-- Agent activity summary
CREATE OR REPLACE VIEW agent_graph.v_agent_activity AS
SELECT
  ac.id AS agent_id,
  ac.agent_type,
  ac.model,
  (SELECT COUNT(*) FROM agent_graph.llm_invocations li WHERE li.agent_id = ac.id AND li.created_at >= CURRENT_DATE) AS calls_today,
  (SELECT COALESCE(SUM(cost_usd), 0) FROM agent_graph.llm_invocations li WHERE li.agent_id = ac.id AND li.created_at >= CURRENT_DATE) AS cost_today_usd,
  (SELECT COALESCE(SUM(input_tokens + output_tokens), 0) FROM agent_graph.llm_invocations li WHERE li.agent_id = ac.id AND li.created_at >= CURRENT_DATE) AS tokens_today,
  (SELECT COUNT(*) FROM agent_graph.work_items wi WHERE wi.assigned_to = ac.id AND wi.status = 'in_progress') AS active_tasks,
  (SELECT COUNT(*) FROM agent_graph.work_items wi WHERE wi.assigned_to = ac.id AND wi.status = 'completed' AND wi.updated_at >= CURRENT_DATE) AS completed_today
FROM agent_graph.agent_configs ac
WHERE ac.is_active = true;

-- ============================================================
-- inbox.drafts VIEW (must be defined before views that reference it)
-- ============================================================

-- Backwards-compatible VIEW over action_proposals (from 028)
-- Maps new state names back to legacy names so un-migrated code still works.
CREATE VIEW inbox.drafts AS
SELECT
  id,
  message_id,
  work_item_id,
  channel,
  account_id,
  body,
  subject,
  to_addresses,
  cc_addresses,
  tone_score,
  few_shot_ids,
  voice_profile_id,
  reviewer_verdict,
  reviewer_notes,
  gate_results,
  board_action,
  board_edited_body,
  board_notes,
  acted_at,
  provider_draft_id,
  provider_sent_id,
  provider,
  CASE send_state
    WHEN 'approved' THEN 'board_approved'
    WHEN 'staged' THEN 'draft_created'
    WHEN 'delivered' THEN 'sent'
    ELSE send_state
  END AS send_state,
  email_summary,
  draft_intent,
  version,
  previous_proposal_id AS previous_draft_id,
  created_at,
  updated_at
FROM agent_graph.action_proposals
WHERE action_type = 'email_draft';

-- Phase 1 metrics with p99 columns (final from 042)
-- References inbox.drafts VIEW for backwards compatibility
CREATE OR REPLACE VIEW agent_graph.v_phase1_metrics AS
SELECT
  -- M1: Inbox zero rate (% of emails triaged within 24h)
  (SELECT ROUND(
    CASE WHEN COUNT(*) > 0
      THEN COUNT(*) FILTER (WHERE processed_at IS NOT NULL AND processed_at - received_at < interval '24 hours')::numeric / COUNT(*)::numeric * 100
      ELSE 0 END, 2)
   FROM inbox.messages WHERE received_at >= now() - interval '7 days'
  ) AS m1_inbox_zero_rate_pct,

  -- M2: Average triage latency (minutes)
  (SELECT ROUND((EXTRACT(EPOCH FROM AVG(processed_at - received_at)) / 60)::NUMERIC, 1)
   FROM inbox.messages WHERE processed_at IS NOT NULL AND received_at >= now() - interval '7 days'
  ) AS m2_avg_triage_latency_min,

  -- M2b: p99 triage latency (minutes)
  (SELECT ROUND((EXTRACT(EPOCH FROM
    PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY processed_at - received_at)
  ) / 60)::NUMERIC, 1)
   FROM inbox.messages WHERE processed_at IS NOT NULL AND received_at >= now() - interval '7 days'
  ) AS m2b_p99_triage_latency_min,

  -- M3: Draft accuracy (% of drafts approved without edits)
  (SELECT ROUND(
    CASE WHEN COUNT(*) > 0
      THEN COUNT(*) FILTER (WHERE board_action = 'approved')::numeric / COUNT(*)::numeric * 100
      ELSE 0 END, 2)
   FROM inbox.drafts WHERE board_action IS NOT NULL AND acted_at >= now() - interval '14 days'
  ) AS m3_draft_accuracy_pct,

  -- M4: Edit rate (% of drafts edited by board in 14 days — L0 exit criteria)
  (SELECT ROUND(
    CASE WHEN COUNT(*) > 0
      THEN COUNT(*) FILTER (WHERE board_action = 'edited')::numeric / COUNT(*)::numeric * 100
      ELSE 0 END, 2)
   FROM inbox.drafts WHERE board_action IS NOT NULL AND acted_at >= now() - interval '14 days'
  ) AS m4_edit_rate_14d_pct,

  -- M5: Total drafts reviewed in 14 days (L0 exit: need 50+)
  (SELECT COUNT(*) FROM inbox.drafts WHERE board_action IS NOT NULL AND acted_at >= now() - interval '14 days'
  ) AS m5_drafts_reviewed_14d,

  -- M6: Daily LLM cost (average over 7 days)
  (SELECT ROUND(COALESCE(AVG(daily_cost), 0), 4)
   FROM (SELECT SUM(cost_usd) as daily_cost FROM agent_graph.llm_invocations
         WHERE created_at >= now() - interval '7 days'
         GROUP BY DATE(created_at)) sub
  ) AS m6_avg_daily_cost_usd,

  -- M7: Budget utilization (today)
  (SELECT ROUND(
    CASE WHEN allocated_usd > 0
      THEN (spent_usd / allocated_usd) * 100
      ELSE 0 END, 2)
   FROM agent_graph.budgets WHERE scope = 'daily' AND period_start = CURRENT_DATE LIMIT 1
  ) AS m7_budget_utilization_pct,

  -- M8: Hash chain integrity
  (SELECT COALESCE(bool_and(is_valid), true) FROM agent_graph.verify_all_ledger_chains()
  ) AS m8_hash_chain_valid,

  -- M9: Gate enforcement rate (% of drafts that went through reviewer)
  (SELECT ROUND(
    CASE WHEN COUNT(*) > 0
      THEN COUNT(*) FILTER (WHERE reviewer_verdict IS NOT NULL)::numeric / COUNT(*)::numeric * 100
      ELSE 0 END, 2)
   FROM inbox.drafts WHERE created_at >= now() - interval '7 days'
  ) AS m9_gate_enforcement_pct,

  -- M10: Halt response time (avg seconds from halt signal to all agents stopping)
  (SELECT COUNT(*) FROM agent_graph.halt_signals
  ) AS m10_total_halts,

  -- M11: Signal extraction rate (signals per email)
  (SELECT ROUND(
    CASE WHEN COUNT(DISTINCT m.id) > 0
      THEN COUNT(s.id)::numeric / COUNT(DISTINCT m.id)::numeric
      ELSE 0 END, 2)
   FROM inbox.messages m
   LEFT JOIN inbox.signals s ON s.message_id = m.id
   WHERE m.received_at >= now() - interval '7 days'
  ) AS m11_signals_per_email,

  -- M12: Voice profile sample count
  (SELECT COALESCE(SUM(sample_count), 0) FROM voice.profiles WHERE scope = 'global'
  ) AS m12_voice_samples,

  -- M13: Autonomy readiness (L0 exit criteria met: 50+ drafts, <10% edit, 14+ days)
  (SELECT
    CASE WHEN
      (SELECT COUNT(*) FROM inbox.drafts WHERE board_action IS NOT NULL AND acted_at >= now() - interval '14 days') >= 50
      AND (SELECT ROUND(
        CASE WHEN COUNT(*) > 0
          THEN COUNT(*) FILTER (WHERE board_action = 'edited')::numeric / COUNT(*)::numeric * 100
          ELSE 0 END, 2)
       FROM inbox.drafts WHERE board_action IS NOT NULL AND acted_at >= now() - interval '14 days') < 10
    THEN true ELSE false END
  ) AS m13_l0_exit_ready,

  -- M14: Dispatch latency avg (seconds) — creation to in_progress
  (SELECT ROUND(EXTRACT(EPOCH FROM AVG(st.created_at - w.created_at))::NUMERIC, 2)
   FROM agent_graph.work_items w
   JOIN agent_graph.state_transitions st ON st.work_item_id = w.id AND st.to_state = 'in_progress'
   WHERE w.created_at >= now() - interval '24 hours'
     AND st.from_state IN ('created', 'assigned')
  ) AS m14_dispatch_latency_avg_s,

  -- M14b: Dispatch latency p99 (seconds) — SPEC §14 requires < 2s p99
  (SELECT ROUND(EXTRACT(EPOCH FROM
    PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY st.created_at - w.created_at)
  )::NUMERIC, 2)
   FROM agent_graph.work_items w
   JOIN agent_graph.state_transitions st ON st.work_item_id = w.id AND st.to_state = 'in_progress'
   WHERE w.created_at >= now() - interval '24 hours'
     AND st.from_state IN ('created', 'assigned')
  ) AS m14b_dispatch_latency_p99_s,

  -- M15: E2E latency avg (seconds) — directive creation to last child completion
  (SELECT ROUND(AVG(EXTRACT(EPOCH FROM (child_completed - parent_created)))::NUMERIC, 2)
   FROM (
     SELECT w.created_at AS parent_created,
            MAX(st.created_at) AS child_completed
     FROM agent_graph.work_items w
     JOIN agent_graph.edges e ON e.from_id = w.id AND e.edge_type = 'decomposes_into'
     JOIN agent_graph.work_items c ON c.id = e.to_id AND c.status = 'completed'
     JOIN agent_graph.state_transitions st ON st.work_item_id = c.id AND st.to_state = 'completed'
     WHERE w.type = 'directive' AND w.created_at >= now() - interval '24 hours'
     GROUP BY w.id, w.created_at
   ) sub
  ) AS m15_e2e_latency_avg_s,

  -- M15b: E2E latency p99 (seconds)
  (SELECT ROUND(PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY e2e_seconds)::NUMERIC, 2)
   FROM (
     SELECT EXTRACT(EPOCH FROM (MAX(st.created_at) - w.created_at)) AS e2e_seconds
     FROM agent_graph.work_items w
     JOIN agent_graph.edges e ON e.from_id = w.id AND e.edge_type = 'decomposes_into'
     JOIN agent_graph.work_items c ON c.id = e.to_id AND c.status = 'completed'
     JOIN agent_graph.state_transitions st ON st.work_item_id = c.id AND st.to_state = 'completed'
     WHERE w.type = 'directive' AND w.created_at >= now() - interval '24 hours'
     GROUP BY w.id, w.created_at
   ) sub
  ) AS m15b_e2e_latency_p99_s;

-- Capability invocations: unified view over tool_invocations
CREATE OR REPLACE VIEW agent_graph.capability_invocations AS
  SELECT
    id,
    agent_id,
    resource_type,
    tool_name AS resource_name,
    params_hash,
    result_summary,
    duration_ms,
    success,
    error_message,
    work_item_id,
    created_at
  FROM agent_graph.tool_invocations;

-- ============================================================
-- inbox views
-- ============================================================

-- Inbox signal: unprocessed emails with signals and pending draft count
CREATE OR REPLACE VIEW inbox.v_inbox_signal AS
SELECT
  m.id,
  m.provider_msg_id,
  m.from_address,
  m.from_name,
  m.subject,
  m.snippet,
  m.received_at,
  m.triage_category,
  m.priority_score,
  m.processed_at IS NOT NULL AS is_processed,
  COALESCE(
    json_agg(
      json_build_object(
        'type', s.signal_type,
        'content', s.content,
        'due_date', s.due_date
      )
    ) FILTER (WHERE s.id IS NOT NULL),
    '[]'::json
  ) AS signals,
  (SELECT COUNT(*) FROM agent_graph.action_proposals ap
   WHERE ap.message_id = m.id AND ap.action_type = 'email_draft'
     AND ap.board_action IS NULL) AS pending_drafts
FROM inbox.messages m
LEFT JOIN inbox.signals s ON s.message_id = m.id
GROUP BY m.id
ORDER BY m.received_at DESC;

-- ============================================================
-- signal views
-- ============================================================

-- Daily briefing view: today's activity summary (cross-channel)
CREATE OR REPLACE VIEW signal.v_daily_briefing AS
SELECT
  CURRENT_DATE AS briefing_date,
  (SELECT COUNT(*) FROM inbox.messages WHERE received_at >= CURRENT_DATE) AS emails_received_today,
  (SELECT COUNT(*) FROM inbox.messages WHERE processed_at >= CURRENT_DATE) AS emails_triaged_today,
  (SELECT COUNT(*) FROM inbox.messages WHERE triage_category = 'action_required' AND processed_at >= CURRENT_DATE) AS action_required_today,
  (SELECT COUNT(*) FROM inbox.messages WHERE triage_category = 'needs_response' AND processed_at >= CURRENT_DATE) AS needs_response_today,
  (SELECT COUNT(*) FROM agent_graph.action_proposals WHERE created_at >= CURRENT_DATE) AS drafts_created_today,
  (SELECT COUNT(*) FROM agent_graph.action_proposals WHERE board_action = 'approved' AND acted_at >= CURRENT_DATE) AS drafts_approved_today,
  (SELECT COUNT(*) FROM agent_graph.action_proposals WHERE board_action = 'edited' AND acted_at >= CURRENT_DATE) AS drafts_edited_today,
  (SELECT COUNT(*) FROM agent_graph.action_proposals WHERE board_action = 'rejected' AND acted_at >= CURRENT_DATE) AS drafts_rejected_today,
  (SELECT COALESCE(SUM(cost_usd), 0) FROM agent_graph.llm_invocations WHERE created_at >= CURRENT_DATE) AS cost_today_usd,
  (SELECT allocated_usd FROM agent_graph.budgets WHERE scope = 'daily' AND period_start = CURRENT_DATE LIMIT 1) AS budget_today_usd,
  (SELECT COUNT(*) FROM agent_graph.action_proposals WHERE board_action IS NULL AND reviewer_verdict IS NOT NULL) AS drafts_awaiting_review,
  (SELECT COUNT(*) FROM inbox.messages WHERE triage_category = 'pending') AS emails_awaiting_triage,
  (SELECT COUNT(*) FROM inbox.signals WHERE resolved = false AND due_date IS NOT NULL AND due_date <= CURRENT_DATE + interval '2 days') AS upcoming_deadlines,
  (SELECT ROUND(
    CASE WHEN COUNT(*) > 0
      THEN (COUNT(*) FILTER (WHERE board_action = 'edited'))::numeric / COUNT(*)::numeric * 100
      ELSE 0
    END, 2)
   FROM agent_graph.action_proposals
   WHERE acted_at >= CURRENT_DATE - interval '14 days' AND board_action IS NOT NULL
  ) AS edit_rate_14d_pct,
  (SELECT COUNT(*) FROM agent_graph.action_proposals WHERE board_action IS NOT NULL AND acted_at >= CURRENT_DATE - interval '14 days') AS drafts_reviewed_14d;

-- Contact relationship strength (from 030)
CREATE OR REPLACE VIEW signal.v_contact_strength AS
SELECT
  c.id,
  c.email_address,
  c.name,
  c.organization,
  c.contact_type,
  c.tier,
  c.is_vip,
  c.emails_received,
  c.emails_sent,
  c.last_received_at,
  c.last_sent_at,
  GREATEST(0, LEAST(100, ROUND((
    -- Frequency component (0-40): total interactions, capped
    LEAST(40, (COALESCE(c.emails_received, 0) + COALESCE(c.emails_sent, 0)) * 2.0) +
    -- Recency component (0-40): exponential decay with 14-day half-life
    CASE
      WHEN GREATEST(COALESCE(c.last_received_at, '1970-01-01'::timestamptz),
                     COALESCE(c.last_sent_at, '1970-01-01'::timestamptz)) = '1970-01-01'::timestamptz THEN 0
      ELSE LEAST(40, 40 * EXP(
        -0.693 * EXTRACT(EPOCH FROM (now() - GREATEST(
          COALESCE(c.last_received_at, '1970-01-01'::timestamptz),
          COALESCE(c.last_sent_at, '1970-01-01'::timestamptz)
        ))) / (14.0 * 86400)
      ))
    END +
    -- Directionality bonus (0-20): bidirectional is stronger
    CASE
      WHEN COALESCE(c.emails_sent, 0) > 0 AND COALESCE(c.emails_received, 0) > 0 THEN 20
      ELSE 0
    END
  )::NUMERIC, 1))) AS relationship_strength
FROM signal.contacts c;

-- Signal feedback metrics (from 032)
CREATE OR REPLACE VIEW signal.v_feedback_metrics AS
SELECT
  COUNT(*) FILTER (WHERE f.verdict = 'correct') AS correct_count,
  COUNT(*) FILTER (WHERE f.verdict = 'incorrect') AS incorrect_count,
  COUNT(*) FILTER (WHERE f.verdict = 'partial') AS partial_count,
  COUNT(*) AS total_feedback,
  CASE WHEN COUNT(*) > 0
    THEN ROUND(100.0 * COUNT(*) FILTER (WHERE f.verdict = 'correct') / COUNT(*), 1)
    ELSE NULL
  END AS accuracy_pct,
  (SELECT COUNT(*) FROM inbox.signals WHERE created_at > now() - interval '7 days') AS signals_last_7d,
  (SELECT COUNT(DISTINCT signal_id) FROM signal.feedback
   WHERE created_at > now() - interval '7 days') AS feedback_last_7d,
  CASE WHEN (SELECT COUNT(*) FROM inbox.signals WHERE created_at > now() - interval '7 days') > 0
    THEN ROUND(100.0 *
      (SELECT COUNT(DISTINCT signal_id) FROM signal.feedback WHERE created_at > now() - interval '7 days')::numeric /
      (SELECT COUNT(*) FROM inbox.signals WHERE created_at > now() - interval '7 days'), 1)
    ELSE NULL
  END AS feedback_rate_pct
FROM signal.feedback f;

-- ============================================================
-- Governance feed (public schema, from 038 + 007 + 009)
-- Unified board oversight surface — 8 sources
-- ============================================================
CREATE OR REPLACE VIEW v_governance_feed AS

-- Source 1: Pending drafts (reviewed but not yet acted on by board)
SELECT
  ap.id,
  'draft_review' AS feed_type,
  COALESCE(ap.subject, 'Draft: ' || LEFT(ap.body, 60)) AS title,
  COALESCE(ap.reviewer_notes, 'Awaiting board review') AS summary,
  ap.created_at,
  jsonb_build_object(
    'action_type', ap.action_type,
    'work_item_id', ap.work_item_id,
    'reviewer_verdict', ap.reviewer_verdict,
    'tone_score', ap.tone_score,
    'to_addresses', ap.to_addresses,
    'contact_type', c.contact_type,
    'contact_tier', c.tier,
    'contact_is_vip', COALESCE(c.is_vip, false)
  ) AS metadata,
  1 AS priority,
  true AS requires_action,
  CASE
    WHEN c.is_vip = true THEN 90
    WHEN c.contact_type IN ('cofounder', 'board', 'investor')
      OR c.tier = 'inner_circle' THEN 80
    WHEN c.contact_type IN ('customer', 'team', 'advisor') THEN 60
    WHEN c.id IS NULL THEN 50
    WHEN c.tier = 'active' THEN 40
    ELSE 20
  END AS board_relevance
FROM agent_graph.action_proposals ap
LEFT JOIN inbox.messages m ON m.id = ap.message_id
LEFT JOIN signal.contacts c ON c.email_address = m.from_address
WHERE ap.board_action IS NULL
  AND ap.reviewer_verdict IS NOT NULL
  AND (
    c.id IS NULL
    OR c.is_vip = true
    OR (
      COALESCE(c.tier, 'unknown') NOT IN ('automated')
      AND COALESCE(c.contact_type, 'unknown') NOT IN ('service', 'newsletter', 'recruiter')
    )
  )

UNION ALL

-- Source 2: Strategic decisions awaiting board verdict
SELECT
  sd.id,
  'strategic_decision' AS feed_type,
  sd.proposed_action AS title,
  COALESCE(sd.rationale, 'Awaiting board verdict') AS summary,
  sd.created_at,
  jsonb_build_object(
    'decision_type', sd.decision_type,
    'recommendation', sd.recommendation,
    'work_item_id', sd.work_item_id,
    'agent_id', sd.agent_id,
    'confidence', sd.confidence
  ) AS metadata,
  CASE sd.decision_type
    WHEN 'existential' THEN 1
    WHEN 'strategic' THEN 2
    WHEN 'tactical' THEN 3
    ELSE 3
  END AS priority,
  true AS requires_action,
  CASE sd.decision_type
    WHEN 'existential' THEN 90
    WHEN 'strategic' THEN 70
    WHEN 'tactical' THEN 50
    ELSE 50
  END AS board_relevance
FROM agent_graph.strategic_decisions sd
WHERE sd.board_verdict IS NULL

UNION ALL

-- Source 3: Budget warnings (daily spend > 80% of allocation)
SELECT
  b.id,
  'budget_warning' AS feed_type,
  'Budget alert: ' || ROUND((b.spent_usd / NULLIF(b.allocated_usd, 0)) * 100) || '% spent' AS title,
  'Daily budget $' || ROUND(b.spent_usd, 2) || ' of $' || ROUND(b.allocated_usd, 2) || ' allocated' AS summary,
  b.created_at,
  jsonb_build_object(
    'scope', b.scope,
    'allocated_usd', b.allocated_usd,
    'spent_usd', b.spent_usd,
    'reserved_usd', b.reserved_usd,
    'pct', ROUND((b.spent_usd / NULLIF(b.allocated_usd, 0)) * 100)
  ) AS metadata,
  2 AS priority,
  false AS requires_action,
  60 AS board_relevance
FROM agent_graph.budgets b
WHERE b.scope = 'daily'
  AND b.spent_usd > b.allocated_usd * 0.8
  AND b.period_start <= CURRENT_DATE
  AND b.period_end >= CURRENT_DATE

UNION ALL

-- Source 4: Blocked/failed work items (last 24h)
SELECT
  st.id,
  'blocked_item' AS feed_type,
  'Work item ' || st.to_state || ': ' || COALESCE(st.reason, st.work_item_id) AS title,
  COALESCE(st.reason, 'No reason provided') AS summary,
  st.created_at,
  jsonb_build_object(
    'work_item_id', st.work_item_id,
    'from_state', st.from_state,
    'to_state', st.to_state,
    'agent_id', st.agent_id
  ) AS metadata,
  CASE st.to_state
    WHEN 'failed' THEN 2
    WHEN 'blocked' THEN 3
    ELSE 3
  END AS priority,
  true AS requires_action,
  CASE st.to_state
    WHEN 'failed' THEN 70
    WHEN 'blocked' THEN 50
    ELSE 50
  END AS board_relevance
FROM agent_graph.state_transitions st
WHERE st.to_state IN ('blocked', 'failed')
  AND st.created_at >= now() - interval '24 hours'

UNION ALL

-- Source 5: Significant events (last 24h, excluding routine)
-- agent_insight events get boosted relevance (70) vs generic events (30)
(SELECT
  el.id,
  'event' AS feed_type,
  el.event_type || ': ' || LEFT(el.summary, 80) AS title,
  el.summary,
  el.created_at,
  COALESCE(el.metadata, '{}'::jsonb) || jsonb_build_object(
    'event_type', el.event_type,
    'agent_id', el.agent_id,
    'work_item_id', el.work_item_id
  ) AS metadata,
  4 AS priority,
  false AS requires_action,
  CASE
    WHEN el.event_type = 'agent_insight' THEN 70
    ELSE 30
  END AS board_relevance
FROM autobot_public.event_log el
WHERE el.created_at >= now() - interval '24 hours'
  AND el.event_type NOT IN ('email_received', 'email_triaged')
)

UNION ALL

-- Source 6: Agent intents pending board review
SELECT
  ai.id,
  'agent_intent' AS feed_type,
  ai.title,
  LEFT(ai.reasoning, 200) AS summary,
  ai.created_at,
  jsonb_build_object(
    'agent_id', ai.agent_id,
    'agent_tier', ai.agent_tier,
    'intent_type', ai.intent_type,
    'decision_tier', ai.decision_tier,
    'proposed_action', ai.proposed_action,
    'trigger_context', ai.trigger_context,
    'expires_at', ai.expires_at
  ) AS metadata,
  CASE ai.decision_tier
    WHEN 'existential' THEN 1
    WHEN 'strategic' THEN 2
    WHEN 'tactical' THEN 3
  END AS priority,
  true AS requires_action,
  CASE ai.decision_tier
    WHEN 'existential' THEN 95
    WHEN 'strategic' THEN 75
    WHEN 'tactical' THEN 50
  END AS board_relevance
FROM agent_graph.agent_intents ai
WHERE ai.status = 'pending'

UNION ALL

-- Source 7: Recently executed intents (trace approval -> outcome)
SELECT
  ai.id,
  'intent_executed' AS feed_type,
  'Intent executed: ' || ai.title AS title,
  format('Approved intent fired: %s (%s)',
    ai.title,
    COALESCE(ai.proposed_action->'payload'->>'assigned_to',
             ai.proposed_action->>'type', 'system')
  ) AS summary,
  COALESCE(ai.executed_at, ai.created_at) AS created_at,
  jsonb_build_object(
    'agent_id', ai.agent_id,
    'agent_tier', ai.agent_tier,
    'intent_type', ai.intent_type,
    'decision_tier', ai.decision_tier,
    'proposed_action', ai.proposed_action,
    'trigger_context', ai.trigger_context,
    'approved_at', ai.reviewed_at,
    'executed_at', ai.executed_at,
    'resulting_work_item_id', (
      SELECT wi.id FROM agent_graph.work_items wi
      WHERE wi.metadata->>'intent_id' = ai.id
      ORDER BY wi.created_at DESC LIMIT 1
    )
  ) AS metadata,
  4 AS priority,
  false AS requires_action,
  45 AS board_relevance
FROM agent_graph.agent_intents ai
WHERE ai.status = 'executed'
  AND COALESCE(ai.executed_at, ai.created_at) >= now() - interval '24 hours'

UNION ALL

-- Source 8: Learning insights (pattern anomalies, last 48h)
SELECT
  li.id::text,
  'learning_insight' AS feed_type,
  li.title,
  li.summary,
  li.created_at,
  jsonb_build_object(
    'insight_type', li.insight_type,
    'agent_id', li.agent_id,
    'severity', li.severity,
    'metric_current', li.metric_current,
    'metric_prior', li.metric_prior,
    'metric_delta', li.metric_delta,
    'sample_size', li.sample_size
  ) AS metadata,
  CASE li.severity
    WHEN 'critical' THEN 2
    WHEN 'warning' THEN 3
    ELSE 4
  END AS priority,
  CASE li.severity WHEN 'critical' THEN true ELSE false END AS requires_action,
  CASE li.severity
    WHEN 'critical' THEN 85
    WHEN 'warning' THEN 65
    ELSE 40
  END AS board_relevance
FROM agent_graph.learning_insights li
WHERE li.created_at >= now() - interval '48 hours';

-- Intent match rate: rolling 90 days, per-agent, per-type
CREATE OR REPLACE VIEW agent_graph.intent_match_rate AS
SELECT
  agent_id,
  intent_type,
  COUNT(*) FILTER (WHERE status IN ('approved', 'executed')) AS approved,
  COUNT(*) FILTER (WHERE status = 'rejected') AS rejected,
  COUNT(*) FILTER (WHERE status IN ('approved', 'executed', 'rejected')) AS total,
  ROUND(
    COUNT(*) FILTER (WHERE status IN ('approved', 'executed'))::numeric /
    NULLIF(COUNT(*) FILTER (WHERE status IN ('approved', 'executed', 'rejected')), 0),
    3
  ) AS match_rate
FROM agent_graph.agent_intents
WHERE created_at > now() - INTERVAL '90 days'
GROUP BY agent_id, intent_type;

-- ============================================================
-- Cross-schema reconciliation function (final from 028)
-- ============================================================
CREATE OR REPLACE FUNCTION agent_graph.reconcile_schemas()
RETURNS TABLE (
  issue_type TEXT,
  schema_name TEXT,
  table_name TEXT,
  record_id TEXT,
  details TEXT
) AS $$
BEGIN
  -- Orphaned action proposals (email: message_id -> inbox.messages)
  RETURN QUERY
  SELECT 'orphaned_fk'::TEXT, 'agent_graph'::TEXT, 'action_proposals'::TEXT, ap.id,
         'message_id not found: ' || ap.message_id
  FROM agent_graph.action_proposals ap
  LEFT JOIN inbox.messages m ON m.id = ap.message_id
  WHERE ap.action_type = 'email_draft' AND ap.message_id IS NOT NULL AND m.id IS NULL;

  -- Orphaned action proposals (content: topic_id -> content.topics)
  RETURN QUERY
  SELECT 'orphaned_fk'::TEXT, 'agent_graph'::TEXT, 'action_proposals'::TEXT, ap.id,
         'topic_id not found: ' || ap.topic_id
  FROM agent_graph.action_proposals ap
  LEFT JOIN content.topics t ON t.id = ap.topic_id
  WHERE ap.action_type = 'content_post' AND ap.topic_id IS NOT NULL AND t.id IS NULL;

  -- Work items with stale assigned_to (agent no longer active)
  RETURN QUERY
  SELECT 'stale_assignment'::TEXT, 'agent_graph'::TEXT, 'work_items'::TEXT, w.id,
         'assigned to inactive agent: ' || w.assigned_to
  FROM agent_graph.work_items w
  LEFT JOIN agent_graph.agent_configs ac ON ac.id = w.assigned_to
  WHERE w.assigned_to IS NOT NULL AND (ac.id IS NULL OR ac.is_active = false)
    AND w.status IN ('created', 'assigned', 'in_progress');

  -- Messages without work items (unprocessed)
  RETURN QUERY
  SELECT 'unlinked_message'::TEXT, 'inbox'::TEXT, 'messages'::TEXT, m.id, 'no work_item_id'
  FROM inbox.messages m
  WHERE m.work_item_id IS NULL AND m.received_at >= now() - interval '24 hours'
    -- Tier-3 signal-only rows are by-design unlinked (no work_item, zero LLM
    -- cost — see signal-only awareness path below). Exclude them so they stop
    -- firing the unlinked_message infrastructure alert (STAQPRO-548).
    AND NOT ('signal-only'::TEXT = ANY(m.labels));

  -- Orphaned edit_deltas (draft_id -> action_proposals)
  RETURN QUERY
  SELECT 'orphaned_fk'::TEXT, 'voice'::TEXT, 'edit_deltas'::TEXT, ed.id,
         'draft_id not found: ' || ed.draft_id
  FROM voice.edit_deltas ed
  LEFT JOIN agent_graph.action_proposals ap ON ap.id = ed.draft_id
  WHERE ap.id IS NULL;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- FROM: 005
-- ============================================================

-- 005-seed.sql
-- Consolidated baseline: All seed data
-- Squashed from migrations 001-044

-- ============================================================
-- Agent configurations (008-seed + 035-feedback-pipeline)
-- ============================================================

INSERT INTO agent_graph.agent_configs (id, agent_type, model, system_prompt, tools_allowed, config_hash) VALUES
('orchestrator', 'orchestrator', 'claude-sonnet-4-6',
 'You are the Orchestrator agent for an AI inbox management system. Your role is to poll Gmail for new messages, create tasks in the work graph, and coordinate the pipeline. You do NOT triage, draft, or review. You create work items and assign them to the appropriate agents.',
 ARRAY['gmail_poll', 'gmail_fetch', 'task_create', 'task_assign'],
 'seed-v1'),

('strategist', 'strategist', 'claude-opus-4-6',
 'You are the Strategist agent. Your role is to assess email priority, recommend response strategies, and provide high-level guidance. You operate in suggest mode — you recommend, the board decides. Focus on: stakeholder importance, urgency, strategic implications, and appropriate response tone/depth.',
 ARRAY['task_read', 'gmail_fetch', 'signal_query', 'voice_query'],
 'seed-v1'),

('executor-triage', 'executor', 'claude-haiku-4-5-20251001',
 'You are the Triage agent. Classify each email into exactly one category: action_required (needs Eric to do something), needs_response (should reply), fyi (informational, label and move on), noise (newsletters, automated, spam — archive). Extract signals: commitments, deadlines, action items, questions. Be decisive and fast.',
 ARRAY['gmail_fetch', 'task_update', 'signal_extract'],
 'seed-v1'),

('executor-responder', 'executor', 'claude-haiku-4-5-20251001',
 'You are the Responder agent. Draft email replies in Eric''s voice. You will receive: the email to reply to, a voice profile, and 3-5 few-shot examples of similar emails Eric has sent. Match his tone, vocabulary, greeting/closing patterns, and typical response length. Never make commitments, promises about timelines, or financial statements.',
 ARRAY['gmail_fetch', 'voice_query', 'draft_create'],
 'seed-v1'),

('reviewer', 'reviewer', 'claude-sonnet-4-6',
 'You are the Reviewer agent. Check every draft against constitutional gates before it reaches the board. Check G2 (legal: no commitment language), G3 (tone: match score >= 0.80), G5 (reversibility: flag reply-all, prefer draft), G7 (precedent: flag pricing/timeline/policy statements). Return a verdict: approved, rejected, or flagged with specific gate violations.',
 ARRAY['draft_read', 'voice_query', 'gate_check'],
 'seed-v1'),

('architect', 'architect', 'claude-sonnet-4-6',
 'You are the Architect agent. Run daily analysis of the pipeline: throughput metrics, cost efficiency, voice learning progress, autonomy level readiness. Identify bottlenecks and suggest optimizations. Generate the daily briefing.',
 ARRAY['task_read', 'signal_query', 'stats_query', 'briefing_create'],
 'seed-v1'),

('executor-ticket', 'executor', 'claude-haiku-4-5-20251001',
 'You are the Ticket Creator agent. You structure client feedback into actionable tickets.',
 ARRAY['task_read','ticket_create_linear','ticket_create_github','slack_notify'],
 'initial'),

('executor-coder', 'executor', 'claude-sonnet-4-6',
 'You are the Code Fix agent. You generate targeted code fixes from structured tickets.',
 ARRAY['task_read','github_fetch_files','github_create_pr','slack_notify'],
 'initial'),

('executor-redesign', 'executor', 'claude-sonnet-4-6',
 'You are the Website Redesign agent. You scrape websites, analyze their design, and generate modern redesigns using Claude Code CLI. Output is a self-contained HTML file uploaded to Vercel Blob.',
 ARRAY['task_read','web_scrape','blob_upload'],
 'initial'),

('board', 'board', 'human',
 'Human board of directors. Creates directives and makes governance decisions.',
 ARRAY[]::text[],
 'seed-v1')
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- Valid state transitions (008-seed)
-- ============================================================

INSERT INTO agent_graph.valid_transitions (from_state, to_state, allowed_roles, required_guardrails) VALUES
('created',     'assigned',     ARRAY['orchestrator', '*'],  ARRAY['budget_check']),
('created',     'in_progress',  ARRAY['executor-triage', 'executor-responder', 'reviewer', 'strategist', 'architect', 'orchestrator', '*'], ARRAY['budget_check']),
('assigned',    'in_progress',  ARRAY['executor-triage', 'executor-responder', 'reviewer', 'strategist', 'architect', '*'], ARRAY['budget_check']),
('in_progress', 'completed',    ARRAY['executor-triage', 'executor-responder', 'orchestrator', 'reviewer', 'architect', '*'], ARRAY[]::text[]),
('in_progress', 'failed',       ARRAY['orchestrator', 'reviewer', '*'],  ARRAY[]::text[]),
('in_progress', 'blocked',      ARRAY['orchestrator', '*'],  ARRAY[]::text[]),
('blocked',     'in_progress',  ARRAY['orchestrator', '*'],  ARRAY[]::text[]),
('created',     'cancelled',    ARRAY['orchestrator', '*'],  ARRAY[]::text[]),
('assigned',    'cancelled',    ARRAY['orchestrator', '*'],  ARRAY[]::text[]),
('in_progress', 'cancelled',    ARRAY['orchestrator', '*'],  ARRAY[]::text[]),
('blocked',     'cancelled',    ARRAY['orchestrator', '*'],  ARRAY[]::text[]),
-- Review state transitions (spec §3)
('in_progress', 'review',       ARRAY['executor-triage','executor-responder','orchestrator','strategist','architect','*'], ARRAY[]::text[]),
('review',      'completed',    ARRAY['reviewer','orchestrator','*'], ARRAY[]::text[]),
('review',      'in_progress',  ARRAY['reviewer','orchestrator','*'], ARRAY[]::text[]),
('review',      'cancelled',    ARRAY['orchestrator', '*'],  ARRAY[]::text[]),
-- Retry transitions (spec §11: failed/timed_out -> assigned, max 3)
('failed',      'assigned',     ARRAY['orchestrator','*'], ARRAY[]::text[]),
('timed_out',   'assigned',     ARRAY['orchestrator','*'], ARRAY[]::text[]),
-- Timeout transition
('in_progress', 'timed_out',    ARRAY['orchestrator','*'], ARRAY[]::text[]);

-- ============================================================
-- Initial daily budget (008-seed)
-- ============================================================

INSERT INTO agent_graph.budgets (scope, scope_id, allocated_usd, period_start, period_end) VALUES
('daily', 'default', 20.00, CURRENT_DATE, CURRENT_DATE);

-- ============================================================
-- Tool registry (010-phase1-hardening)
-- ============================================================

INSERT INTO agent_graph.tool_registry (tool_name, tool_hash, description, allowed_agents) VALUES
('gmail_poll', 'builtin', 'Poll Gmail for new messages', ARRAY['orchestrator']),
('gmail_fetch', 'builtin', 'Fetch email body on-demand', ARRAY['orchestrator', 'executor-triage', 'executor-responder', 'reviewer', 'strategist']),
('task_create', 'builtin', 'Create work items in task graph', ARRAY['orchestrator']),
('task_assign', 'builtin', 'Assign work items to agents', ARRAY['orchestrator']),
('task_read', 'builtin', 'Read work item details', ARRAY['strategist', 'architect']),
('task_update', 'builtin', 'Update work item status', ARRAY['executor-triage']),
('signal_extract', 'builtin', 'Extract signals from emails', ARRAY['executor-triage']),
('signal_query', 'builtin', 'Query signal data', ARRAY['strategist', 'architect']),
('voice_query', 'builtin', 'Query voice profiles and samples', ARRAY['executor-responder', 'reviewer', 'strategist']),
('draft_create', 'builtin', 'Create email draft', ARRAY['executor-responder']),
('draft_read', 'builtin', 'Read draft details', ARRAY['reviewer']),
('gate_check', 'builtin', 'Run gate checks on drafts', ARRAY['reviewer']),
('stats_query', 'builtin', 'Query system statistics', ARRAY['architect']),
('briefing_create', 'builtin', 'Create daily briefing', ARRAY['architect'])
ON CONFLICT (tool_name) DO NOTHING;

-- ============================================================
-- Agent assignment rules (026 + 035 + 036)
-- ============================================================

INSERT INTO agent_graph.agent_assignment_rules (agent_id, can_assign) VALUES
  -- orchestrator → all downstream agents
  ('orchestrator', 'executor-triage'),
  ('orchestrator', 'executor-responder'),
  ('orchestrator', 'reviewer'),
  ('orchestrator', 'strategist'),
  ('orchestrator', 'architect'),
  ('orchestrator', 'executor-ticket'),
  ('orchestrator', 'executor-coder'),
  -- executor-responder → reviewer (draft handoff for gate checks)
  ('executor-responder', 'reviewer'),
  -- strategist → full routing
  ('strategist', 'architect'),
  ('strategist', 'orchestrator'),
  ('strategist', 'executor-triage'),
  ('strategist', 'executor-responder'),
  ('strategist', 'reviewer'),
  -- architect → orchestrator (routes through orchestrator per spec)
  ('architect', 'orchestrator'),
  -- executor-ticket → executor-coder, executor-responder
  ('executor-ticket', 'executor-coder'),
  ('executor-ticket', 'executor-responder')
ON CONFLICT (agent_id, can_assign) DO NOTHING;

-- ============================================================
-- Sanitization rule sets v1.0.0 (015)
-- ============================================================

INSERT INTO agent_graph.sanitization_rule_sets (
  version, sha256_hash, rules, categories, is_active, approved_by
) VALUES (
  '1.0.0',
  'seed_v1_0_0',
  '{
    "patterns": [
      {
        "category": "prompt_injection",
        "pattern": "\\b(ignore|disregard|forget|override|bypass|skip)\\s+(previous|above|all|prior|these|the|my|your|any)(\\s+\\w+)*\\s*(instructions?|prompts?|rules?|directives?|guidelines?|constraints?|system)\\b",
        "flags": "gi",
        "description": "Direct prompt injection — override instructions"
      },
      {
        "category": "prompt_injection",
        "pattern": "\\bnew\\s+(instructions?|rules?|directives?|task|objective)\\s*:",
        "flags": "gi",
        "description": "New instructions injection"
      },
      {
        "category": "prompt_injection",
        "pattern": "\\b(from now on|starting now|henceforth)\\b.*\\b(you (are|will|should|must)|your (role|task|job))\\b",
        "flags": "gi",
        "description": "Temporal context hijack"
      },
      {
        "category": "role_play",
        "pattern": "\\b(you are|act as|pretend to be|roleplay as|assume the role|behave as|switch to|become)\\b",
        "flags": "gi",
        "description": "Role hijacking"
      },
      {
        "category": "role_play",
        "pattern": "\\bsystem\\s*:\\s*",
        "flags": "gi",
        "description": "System prompt marker"
      },
      {
        "category": "role_play",
        "pattern": "\\bassistant\\s*:\\s*",
        "flags": "gi",
        "description": "Assistant prompt marker"
      },
      {
        "category": "role_play",
        "pattern": "\\bhuman\\s*:\\s*",
        "flags": "gi",
        "description": "Human prompt marker"
      },
      {
        "category": "role_play",
        "pattern": "\\buser\\s*:\\s*",
        "flags": "gi",
        "description": "User prompt marker"
      },
      {
        "category": "prompt_injection",
        "pattern": "\\brespond\\s+with\\s+(json|the following|this|exactly)\\b",
        "flags": "gi",
        "description": "Output format manipulation"
      },
      {
        "category": "prompt_injection",
        "pattern": "\\boutput\\s*:\\s*\\{",
        "flags": "gi",
        "description": "JSON output injection"
      },
      {
        "category": "prompt_injection",
        "pattern": "```json\\s*\\{",
        "flags": "gi",
        "description": "Code block JSON injection"
      },
      {
        "category": "data_exfiltration",
        "pattern": "\\b(send|forward|transmit|exfiltrate|leak|copy|share)\\s+(to|data|info|credentials|keys|tokens|secrets|password|api.?key|private)\\b",
        "flags": "gi",
        "description": "Data exfiltration attempt"
      },
      {
        "category": "data_exfiltration",
        "pattern": "\\b(fetch|curl|wget|request|call|invoke)\\s+(https?:\\/\\/|url|endpoint|webhook)",
        "flags": "gi",
        "description": "External request injection"
      },
      {
        "category": "data_exfiltration",
        "pattern": "\\b(execute|run|eval|exec|spawn|fork)\\s*\\(",
        "flags": "gi",
        "description": "Code execution attempt"
      },
      {
        "category": "data_exfiltration",
        "pattern": "\\bimport\\s*\\(|require\\s*\\(",
        "flags": "gi",
        "description": "Dynamic import/require injection"
      },
      {
        "category": "prompt_injection",
        "pattern": "<\\/?(?:untrusted_email|system|instructions|rules|context|prompt)[\\s>]",
        "flags": "gi",
        "description": "XML tag injection"
      },
      {
        "category": "encoded_payloads",
        "pattern": "[A-Za-z0-9+/=]{200,}",
        "flags": "g",
        "description": "Base64-encoded payload (long string)"
      },
      {
        "category": "encoded_payloads",
        "pattern": "[\\u0456\\u0069][\\u0261\\u0067]n[\\u043E\\u006F]r[\\u0435\\u0065]",
        "flags": "gi",
        "description": "Unicode homoglyph evasion for ignore"
      }
    ]
  }'::jsonb,
  ARRAY['prompt_injection', 'role_play', 'data_exfiltration', 'encoded_payloads'],
  true,
  'seed_migration'
) ON CONFLICT DO NOTHING;

-- ============================================================
-- Phase configurations (019 + 022)
-- ============================================================

INSERT INTO agent_graph.phase_config (id, phase, is_active, activated_at, activated_by, config)
VALUES (
  'phase-2', 2, true, now(), 'system',
  '{
    "constitutional_mode": "shadow",
    "gateway_max_auto_tier": 1,
    "financial_mode": "shadow",
    "auditor_halt_authority": false
  }'::jsonb
) ON CONFLICT (id) DO NOTHING;

INSERT INTO agent_graph.phase_config (id, phase, is_active, config)
VALUES (
  'phase-3', 3, false,
  '{
    "constitutional_mode": "active",
    "gateway_max_auto_tier": 2,
    "financial_mode": "real",
    "auditor_halt_authority": true,
    "dead_man_switch_interval_days": 30,
    "exploration_threshold": 0.05,
    "exploration_circuit_breaker_days": 30,
    "exploration_forced_ratio": 0.20
  }'::jsonb
) ON CONFLICT (id) DO NOTHING;

INSERT INTO agent_graph.phase_config (id, phase, is_active, config)
VALUES (
  'phase-4', 4, false,
  '{
    "constitutional_mode": "active",
    "budget_cap_removed": true,
    "multi_product_enabled": true,
    "full_distribution_active": true,
    "data_fees_active": true,
    "creator_role": "custodian",
    "data_cooperative_formation_threshold": 50,
    "merkle_proof_publication_interval_days": 7
  }'::jsonb
) ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- Dead-man's switch (019)
-- ============================================================

INSERT INTO agent_graph.dead_man_switch (id, last_renewal, renewal_interval_days, status)
VALUES ('primary', now(), 30, 'standby')
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- Autonomy config (022)
-- ============================================================

INSERT INTO agent_graph.autonomy_config (
  id, budget_cap_removed, multi_product_enabled,
  full_distribution_active, data_fees_active, creator_role
)
VALUES (
  'primary', false, false, false, false, 'board_member'
) ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- Data cooperative (022)
-- ============================================================

INSERT INTO agent_graph.data_cooperative (id, status, member_count, governance_model)
VALUES (
  'primary', 'formation_pending', 0, 'democratic'
) ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- Financial accounts (012)
-- ============================================================

INSERT INTO autobot_finance.accounts (account_type, balance) VALUES
  ('operating', 0),
  ('reserve', 0)
ON CONFLICT (account_type) DO NOTHING;

-- ============================================================
-- AI disclosures (014)
-- ============================================================

INSERT INTO autobot_comms.ai_disclosures (channel, disclosure_text, regulation) VALUES
  ('email', 'This message was drafted by an AI assistant and reviewed before sending.', 'FTC_S5'),
  ('email', 'This communication was generated with the assistance of artificial intelligence.', 'EU_AI_ACT_A50'),
  ('slack', '[AI-assisted] This message was drafted by an AI assistant and reviewed before sending.', 'FTC_S5'),
  ('slack', '[AI-assisted] This communication was generated with the assistance of artificial intelligence.', 'EU_AI_ACT_A50')
ON CONFLICT DO NOTHING;

-- ============================================================
-- Permission grants — ADR-017 (041)
-- 57 grandfathered capabilities, one per agent-resource pair
-- ============================================================

INSERT INTO agent_graph.permission_grants
  (agent_id, resource_type, resource_name, risk_class, credential_scope, granted_by)
VALUES
  -- orchestrator: tools
  ('orchestrator', 'tool', 'gmail_poll',    'External-Read',  'gmail:readonly',   'migration'),
  ('orchestrator', 'tool', 'gmail_fetch',   'External-Read',  'gmail:readonly',   'migration'),
  ('orchestrator', 'tool', 'task_create',   'Internal',       NULL,               'migration'),
  ('orchestrator', 'tool', 'task_assign',   'Internal',       NULL,               'migration'),
  -- orchestrator: adapters
  ('orchestrator', 'adapter', 'gmail',      'External-Read',  'gmail:readonly',   'migration'),
  ('orchestrator', 'adapter', 'outlook',    'External-Read',  'outlook:readonly', 'migration'),
  ('orchestrator', 'adapter', 'slack',      'External-Read',  'slack:read',       'migration'),
  ('orchestrator', 'adapter', 'webhook',    'Internal',       NULL,               'migration'),
  ('orchestrator', 'adapter', 'telegram',   'External-Read',  'telegram:read',    'migration'),

  -- executor-triage: tools + adapters
  ('executor-triage', 'tool', 'gmail_fetch',    'External-Read',  'gmail:readonly',   'migration'),
  ('executor-triage', 'tool', 'task_update',    'Internal',       NULL,               'migration'),
  ('executor-triage', 'tool', 'signal_extract', 'Internal',       NULL,               'migration'),
  ('executor-triage', 'adapter', 'gmail',       'External-Read',  'gmail:readonly',   'migration'),
  ('executor-triage', 'adapter', 'outlook',     'External-Read',  'outlook:readonly', 'migration'),
  ('executor-triage', 'adapter', 'slack',       'External-Read',  'slack:read',       'migration'),
  ('executor-triage', 'adapter', 'webhook',     'Internal',       NULL,               'migration'),
  ('executor-triage', 'adapter', 'telegram',    'External-Read',  'telegram:read',    'migration'),

  -- executor-responder: tools + adapters
  ('executor-responder', 'tool', 'gmail_fetch',   'External-Read',  'gmail:readonly',   'migration'),
  ('executor-responder', 'tool', 'voice_query',   'Internal',       NULL,               'migration'),
  ('executor-responder', 'tool', 'draft_create',  'Internal',       NULL,               'migration'),
  ('executor-responder', 'adapter', 'gmail',      'External-Read',  'gmail:readonly',   'migration'),
  ('executor-responder', 'adapter', 'outlook',    'External-Read',  'outlook:readonly', 'migration'),
  ('executor-responder', 'adapter', 'slack',      'External-Read',  'slack:read',       'migration'),
  ('executor-responder', 'adapter', 'webhook',    'Internal',       NULL,               'migration'),
  ('executor-responder', 'adapter', 'telegram',   'External-Read',  'telegram:read',    'migration'),

  -- reviewer: tools + adapters
  ('reviewer', 'tool', 'draft_read',   'Internal', NULL, 'migration'),
  ('reviewer', 'tool', 'voice_query',  'Internal', NULL, 'migration'),
  ('reviewer', 'tool', 'gate_check',   'Internal', NULL, 'migration'),
  ('reviewer', 'adapter', 'gmail',     'External-Read',  'gmail:readonly',   'migration'),
  ('reviewer', 'adapter', 'outlook',   'External-Read',  'outlook:readonly', 'migration'),
  ('reviewer', 'adapter', 'slack',     'External-Read',  'slack:read',       'migration'),
  ('reviewer', 'adapter', 'webhook',   'Internal',       NULL,               'migration'),
  ('reviewer', 'adapter', 'telegram',  'External-Read',  'telegram:read',    'migration'),

  -- strategist: tools + adapters
  ('strategist', 'tool', 'task_read',      'Internal',       NULL,               'migration'),
  ('strategist', 'tool', 'gmail_fetch',    'External-Read',  'gmail:readonly',   'migration'),
  ('strategist', 'tool', 'signal_query',   'Internal',       NULL,               'migration'),
  ('strategist', 'tool', 'voice_query',    'Internal',       NULL,               'migration'),
  ('strategist', 'adapter', 'gmail',       'External-Read',  'gmail:readonly',   'migration'),
  ('strategist', 'adapter', 'outlook',     'External-Read',  'outlook:readonly', 'migration'),
  ('strategist', 'adapter', 'slack',       'External-Read',  'slack:read',       'migration'),
  ('strategist', 'adapter', 'webhook',     'Internal',       NULL,               'migration'),
  ('strategist', 'adapter', 'telegram',    'External-Read',  'telegram:read',    'migration'),

  -- architect: tools
  ('architect', 'tool', 'task_read',        'Internal', NULL, 'migration'),
  ('architect', 'tool', 'signal_query',     'Internal', NULL, 'migration'),
  ('architect', 'tool', 'stats_query',      'Internal', NULL, 'migration'),
  ('architect', 'tool', 'briefing_create',  'Internal', NULL, 'migration'),

  -- executor-ticket: adapters + api_clients
  ('executor-ticket', 'adapter', 'gmail',     'External-Read',  'gmail:readonly',   'migration'),
  ('executor-ticket', 'adapter', 'outlook',   'External-Read',  'outlook:readonly', 'migration'),
  ('executor-ticket', 'adapter', 'slack',     'External-Read',  'slack:read',       'migration'),
  ('executor-ticket', 'adapter', 'webhook',   'Internal',       NULL,               'migration'),
  ('executor-ticket', 'adapter', 'telegram',  'External-Read',  'telegram:read',    'migration'),
  ('executor-ticket', 'api_client', 'linear',       'External-Write', 'linear:write',       'migration'),
  ('executor-ticket', 'api_client', 'github_issues', 'External-Write', 'github:issues:write', 'migration'),
  ('executor-ticket', 'api_client', 'slack_notify',  'External-Write', 'slack:write',         'migration'),

  -- executor-coder: subprocess + api_clients
  ('executor-coder', 'subprocess',  'claude_cli',    'External-Write', 'anthropic:cli',       'migration'),
  ('executor-coder', 'api_client',  'github_repo',   'External-Write', 'github:repo:write',   'migration'),
  ('executor-coder', 'api_client',  'slack_notify',  'External-Write', 'slack:write',         'migration'),
  ('executor-coder', 'api_client',  'linear',        'External-Write', 'linear:write',        'board'),

  -- architect: api_clients (daily digest → Gmail draft + Slack notification)
  ('architect', 'api_client', 'gmail_draft',  'External-Write', 'gmail:draft',  'board'),
  ('architect', 'api_client', 'slack_notify', 'External-Write', 'slack:write',  'board'),

  -- executor-redesign: tools + subprocess
  ('executor-redesign', 'tool',        'web_scrape',    'External-Read',  NULL,                  'migration'),
  ('executor-redesign', 'subprocess',  'claude_cli',    'External-Write', 'anthropic:cli',       'migration')

ON CONFLICT (agent_id, resource_type, resource_name) DO NOTHING;

-- ============================================================
-- Seed contacts (036)
-- ============================================================

INSERT INTO signal.contacts (email_address, name, contact_type, is_vip, default_repos)
VALUES ('mike@altitudeguitar.com', 'Mike Maibach', 'customer', true, ARRAY['staqsIO/ag-webapp'])
ON CONFLICT (email_address) DO UPDATE SET
  name = EXCLUDED.name,
  contact_type = EXCLUDED.contact_type,
  is_vip = EXCLUDED.is_vip,
  default_repos = EXCLUDED.default_repos;

INSERT INTO signal.contacts (email_address, name, contact_type, is_vip, default_repos)
VALUES ('mike.m@example.com', 'Mike Maibach', 'customer', true, ARRAY['staqsIO/ag-webapp'])
ON CONFLICT (email_address) DO UPDATE SET
  name = EXCLUDED.name,
  contact_type = EXCLUDED.contact_type,
  is_vip = EXCLUDED.is_vip,
  default_repos = EXCLUDED.default_repos;

-- ============================================================
-- Channel accounts (Slack + Telegram)
-- ============================================================

INSERT INTO inbox.accounts (id, channel, provider, label, identifier, is_active, sync_status) VALUES
('default-slack', 'slack', 'slack', 'Slack (staqsIO)', 'autobot-notifications', true, 'active'),
('default-telegram', 'telegram', 'telegram', 'Telegram', 'optimus-bot', true, 'active')
ON CONFLICT (channel, provider, identifier) DO UPDATE SET
  is_active = EXCLUDED.is_active,
  sync_status = EXCLUDED.sync_status;

-- ============================================================
-- Product seed (009)
-- ============================================================

INSERT INTO autobot_value.products (id, name, description, status, launched_at)
VALUES ('autobot-inbox', 'AutoBot Inbox', 'AI-powered inbox management system — the first Optimus product', 'active', '2026-03-07')
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- Executor-redesign assignment rule (010/011)
-- ============================================================

INSERT INTO agent_graph.agent_assignment_rules (agent_id, can_assign) VALUES
  ('orchestrator', 'executor-redesign')
ON CONFLICT (agent_id, can_assign) DO NOTHING;

-- ============================================================
-- Imagegen permission (015)
-- ============================================================

INSERT INTO agent_graph.permission_grants
  (agent_id, resource_type, resource_name, risk_class, credential_scope, granted_by)
VALUES
  ('executor-redesign', 'api_client', 'google_imagen_api', 'External-Write', 'google:generative-ai', 'migration')
ON CONFLICT (agent_id, resource_type, resource_name) DO NOTHING;

-- ============================================================
-- Executor-research agent config + permissions (038)
-- ============================================================

INSERT INTO agent_graph.agent_configs (id, agent_type, model, system_prompt, tools_allowed, config_hash)
VALUES (
  'executor-research', 'executor', 'claude-sonnet-4-6',
  'Deep research agent — iterative web search with hypothesis-driven exploration.',
  ARRAY['web_search', 'web_fetch'],
  encode(sha256('executor-research-v1'::bytea), 'hex')
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO agent_graph.permission_grants (agent_id, resource_type, resource_name, risk_class, granted_by)
VALUES
  ('executor-research', 'api_client', 'web_search', 'External-Read', 'board'),
  ('executor-research', 'api_client', 'web_fetch', 'External-Read', 'board'),
  ('executor-research', 'api_client', 'github_content_read', 'External-Read', 'board')
ON CONFLICT (agent_id, resource_type, resource_name) DO NOTHING;

-- ============================================================
-- Executor-blueprint agent config + permissions (010)
-- ============================================================

INSERT INTO agent_graph.agent_configs (id, agent_type, model, system_prompt, tools_allowed, config_hash)
VALUES (
  'executor-blueprint', 'executor', 'claude-sonnet-4-6',
  'You are the Blueprint agent. You analyze project descriptions using 4 specialist passes (architecture, risk, UX, cost) and synthesize them into a unified HTML blueprint document.',
  ARRAY['task_read'],
  'initial'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO agent_graph.permission_grants (agent_id, resource_type, resource_name, risk_class, granted_by)
VALUES
  ('executor-blueprint', 'subprocess', 'claude_cli', 'External-Write', 'board'),
  ('executor-blueprint', 'api_client', 'resend_email', 'External-Write', 'board')
ON CONFLICT (agent_id, resource_type, resource_name) DO NOTHING;

-- ============================================================
-- Executor-blueprint assignment rule
-- ============================================================

INSERT INTO agent_graph.agent_assignment_rules (agent_id, can_assign) VALUES
  ('orchestrator', 'executor-blueprint')
ON CONFLICT (agent_id, can_assign) DO NOTHING;

-- ============================================================
-- Per-agent autonomy levels: seed all active agents at L0 (009)
-- ============================================================

INSERT INTO agent_graph.autonomy_levels (agent_id, current_level)
SELECT id, 0 FROM agent_graph.agent_configs WHERE is_active = true
ON CONFLICT (agent_id) DO NOTHING;

-- ============================================================
-- Contact-project backfill from existing default_repos (008)
-- ============================================================

INSERT INTO signal.contact_projects (contact_id, project_name, platform, locator, is_primary)
SELECT
  c.id,
  split_part(repo, '/', 2),
  'github',
  repo,
  true
FROM signal.contacts c,
     unnest(c.default_repos) AS repo
WHERE c.default_repos IS NOT NULL
  AND array_length(c.default_repos, 1) > 0
ON CONFLICT (contact_id, platform, locator) DO NOTHING;

-- ============================================================
-- FROM: 006
-- ============================================================

-- Agent capabilities view: unified view of agent topology
-- Joins agent_configs + permission_grants + assignment_rules + workload metrics
-- Used by governance API and orchestrator dynamic routing

CREATE OR REPLACE VIEW agent_graph.v_agent_capabilities AS
SELECT
  ac.id AS agent_id,
  ac.agent_type,
  ac.model,
  ac.is_active,
  ac.tools_allowed,
  -- Permission grants (grouped by resource type)
  (
    SELECT jsonb_object_agg(resource_type, resources)
    FROM (
      SELECT pg.resource_type, jsonb_agg(pg.resource_name ORDER BY pg.resource_name) AS resources
      FROM agent_graph.permission_grants pg
      WHERE pg.agent_id = ac.id AND pg.revoked_at IS NULL
      GROUP BY pg.resource_type
    ) sub
  ) AS permissions,
  -- Delegation targets
  (
    SELECT array_agg(aar.can_assign ORDER BY aar.can_assign)
    FROM agent_graph.agent_assignment_rules aar
    WHERE aar.agent_id = ac.id
  ) AS can_delegate_to,
  -- Current workload
  (
    SELECT COUNT(*)
    FROM agent_graph.work_items wi
    WHERE wi.assigned_to = ac.id AND wi.status IN ('assigned', 'in_progress')
  ) AS active_tasks,
  -- Recent performance (last 7 days)
  (
    SELECT COUNT(*)
    FROM agent_graph.work_items wi
    WHERE wi.assigned_to = ac.id
      AND wi.status = 'completed'
      AND wi.created_at > now() - INTERVAL '7 days'
  ) AS completed_7d,
  (
    SELECT COUNT(*)
    FROM agent_graph.work_items wi
    WHERE wi.assigned_to = ac.id
      AND wi.status = 'failed'
      AND wi.created_at > now() - INTERVAL '7 days'
  ) AS failed_7d,
  ac.created_at,
  ac.updated_at
FROM agent_graph.agent_configs ac
ORDER BY ac.agent_type, ac.id;

-- ============================================================
-- FROM: 007
-- ============================================================

-- 007: Multi-source briefing views
-- Adds cross-channel signal counts for daily briefings.
-- Supports Tier 3 signal-only awareness path (no work_items, zero LLM cost).

-- Cross-channel signal counts (today)
CREATE OR REPLACE VIEW signal.v_cross_channel_signals AS
SELECT
  -- Linear signals
  COUNT(*) FILTER (
    WHERE 'webhook:linear' = ANY(m.labels)
      AND m.received_at >= CURRENT_DATE
  ) AS linear_signals_today,

  -- GitHub signals
  COUNT(*) FILTER (
    WHERE 'webhook:github' = ANY(m.labels)
      AND m.received_at >= CURRENT_DATE
  ) AS github_signals_today,

  -- Transcript signals (tl;dv / drive)
  COUNT(*) FILTER (
    WHERE ('webhook:tldv' = ANY(m.labels) OR 'webhook:transcript' = ANY(m.labels))
      AND m.received_at >= CURRENT_DATE
  ) AS transcript_signals_today,

  -- Total signal-only messages today (no work_item)
  COUNT(*) FILTER (
    WHERE 'signal-only' = ANY(m.labels)
      AND m.received_at >= CURRENT_DATE
  ) AS signal_only_today,

  -- Total webhook messages today (all tiers)
  COUNT(*) FILTER (
    WHERE m.channel = 'webhook'
      AND m.received_at >= CURRENT_DATE
  ) AS webhook_total_today

FROM inbox.messages m
WHERE m.channel = 'webhook'
  AND m.received_at >= CURRENT_DATE - INTERVAL '1 day';

-- Unresolved action items across all channels
CREATE OR REPLACE VIEW signal.v_unresolved_action_items AS
SELECT
  s.id AS signal_id,
  s.message_id,
  s.signal_type,
  s.content,
  s.direction,
  s.confidence,
  s.created_at,
  m.from_name AS source_name,
  m.subject AS source_subject,
  m.labels,
  CASE
    WHEN 'webhook:linear' = ANY(m.labels) THEN 'linear'
    WHEN 'webhook:github' = ANY(m.labels) THEN 'github'
    WHEN 'webhook:tldv' = ANY(m.labels) THEN 'transcript'
    WHEN m.channel = 'email' THEN 'email'
    WHEN m.channel = 'slack' THEN 'slack'
    ELSE m.channel
  END AS source_channel
FROM inbox.signals s
JOIN inbox.messages m ON m.id = s.message_id
WHERE s.signal_type IN ('action_item', 'commitment', 'request')
  AND s.direction = 'inbound'
  AND s.resolved_at IS NULL
  AND s.created_at >= CURRENT_DATE - INTERVAL '30 days'
ORDER BY s.created_at DESC;

-- Count of unresolved action items (for briefing summary line)
CREATE OR REPLACE VIEW signal.v_unresolved_action_item_counts AS
SELECT
  COUNT(*) AS total_unresolved,
  COUNT(*) FILTER (WHERE source_channel = 'linear') AS linear_unresolved,
  COUNT(*) FILTER (WHERE source_channel = 'github') AS github_unresolved,
  COUNT(*) FILTER (WHERE source_channel = 'transcript') AS transcript_unresolved,
  COUNT(*) FILTER (WHERE source_channel = 'email') AS email_unresolved,
  COUNT(*) FILTER (WHERE source_channel = 'slack') AS slack_unresolved
FROM signal.v_unresolved_action_items;

-- ============================================================
-- FROM: 008
-- ============================================================

-- 008-claw-system.sql
-- ADR-021: Two-Layer Autonomous Claw System
-- Strategic Claw (Explorer) + Operational Claw (Campaigner)
--
-- Dependencies: 002-schemas-and-tables.sql (baseline), 005-seed.sql
-- Spec lineage: autobot-spec v0.8.0, ADR-021

-- ============================================================
-- 1. EXTEND CHECK CONSTRAINTS
-- ============================================================

-- work_items.type: add 'campaign'
ALTER TABLE agent_graph.work_items
  DROP CONSTRAINT IF EXISTS work_items_type_check;
ALTER TABLE agent_graph.work_items
  ADD CONSTRAINT work_items_type_check
  CHECK (type IN ('directive', 'workstream', 'task', 'subtask', 'campaign'));

-- budgets.scope: add 'campaign', 'exploration'
ALTER TABLE agent_graph.budgets
  DROP CONSTRAINT IF EXISTS budgets_scope_check;
ALTER TABLE agent_graph.budgets
  ADD CONSTRAINT budgets_scope_check
  CHECK (scope IN ('daily', 'monthly', 'directive', 'workstream', 'campaign', 'exploration'));

-- permission_grants.resource_type: add 'external_api'
ALTER TABLE agent_graph.permission_grants
  DROP CONSTRAINT IF EXISTS permission_grants_resource_type_check;
ALTER TABLE agent_graph.permission_grants
  ADD CONSTRAINT permission_grants_resource_type_check
  CHECK (resource_type IN ('tool', 'adapter', 'api_client', 'subprocess', 'external_api'));

-- tool_invocations.resource_type: add 'external_api' (audit trail)
ALTER TABLE agent_graph.tool_invocations
  DROP CONSTRAINT IF EXISTS tool_invocations_resource_type_check;
ALTER TABLE agent_graph.tool_invocations
  ADD CONSTRAINT tool_invocations_resource_type_check
  CHECK (resource_type IN ('tool', 'adapter', 'api_client', 'subprocess', 'external_api'));

-- autobot_public.event_log: add campaign event types
ALTER TABLE autobot_public.event_log
  DROP CONSTRAINT IF EXISTS event_log_event_type_check;
ALTER TABLE autobot_public.event_log
  ADD CONSTRAINT event_log_event_type_check
  CHECK (event_type IN (
    'email_received', 'email_triaged', 'draft_created', 'draft_reviewed',
    'draft_approved', 'draft_sent', 'halt_triggered', 'halt_cleared',
    'budget_warning', 'autonomy_evaluation', 'config_changed',
    'board_directive', 'infrastructure_error',
    'redesign_submitted', 'redesign_completed',
    'blueprint_submitted', 'blueprint_completed',
    'intent_executed', 'agent_insight',
    'campaign_started', 'campaign_iteration', 'campaign_completed',
    'campaign_paused', 'campaign_cancelled',
    'exploration_cycle', 'exploration_finding'
  ));

-- ============================================================
-- 2. CAMPAIGNS TABLE (extends work_items)
-- ============================================================

CREATE TABLE agent_graph.campaigns (
  id                    TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  work_item_id          TEXT NOT NULL UNIQUE REFERENCES agent_graph.work_items(id),

  -- Goal definition (autoresearch: program.md equivalent)
  goal_description      TEXT NOT NULL,
  success_criteria      JSONB NOT NULL DEFAULT '[]',
  -- Format: [{"metric": "quality_score", "operator": ">=", "threshold": 0.85}]

  -- Constraints envelope (board-defined boundaries)
  constraints           JSONB NOT NULL DEFAULT '{}',
  -- Format: {"tool_allowlist": [...], "content_policy": {...}}

  -- Budget envelope (separate from daily operational budget)
  budget_envelope_usd   NUMERIC(15,6) NOT NULL,
  spent_usd             NUMERIC(15,6) NOT NULL DEFAULT 0,
  reserved_usd          NUMERIC(15,6) NOT NULL DEFAULT 0,
  max_cost_per_iteration NUMERIC(15,6),

  -- Iteration tracking
  max_iterations        INTEGER NOT NULL DEFAULT 50,
  completed_iterations  INTEGER NOT NULL DEFAULT 0,
  iteration_time_budget INTERVAL NOT NULL DEFAULT '5 minutes',

  -- Plateau detection (circuit breaker)
  plateau_window        INTEGER NOT NULL DEFAULT 5,
  plateau_threshold     NUMERIC(5,4) NOT NULL DEFAULT 0.01,

  -- Campaign mode
  campaign_mode         TEXT NOT NULL DEFAULT 'stateless'
    CHECK (campaign_mode IN ('stateless', 'stateful', 'workshop')),
  workspace_path        TEXT, -- git worktree path (stateful only)
  metadata              JSONB DEFAULT '{}',
  content_policy        JSONB DEFAULT '{}',

  -- Status (derived from work_item state + campaign-specific states)
  campaign_status       TEXT NOT NULL DEFAULT 'pending_approval'
    CHECK (campaign_status IN (
      'pending_approval', 'approved', 'running',
      'paused', 'plateau_paused',
      'succeeded', 'failed', 'cancelled'
    )),

  -- Provenance
  source_intent_id      TEXT,
  created_by            TEXT NOT NULL,

  -- Timestamps
  approved_at           TIMESTAMPTZ,
  started_at            TIMESTAMPTZ,
  completed_at          TIMESTAMPTZ,
  deadline              TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- P2: Infrastructure enforces budget envelope
  CONSTRAINT campaigns_no_overspend
    CHECK (spent_usd + reserved_usd <= budget_envelope_usd),
  CONSTRAINT campaigns_spent_non_negative
    CHECK (spent_usd >= 0),
  CONSTRAINT campaigns_reserved_non_negative
    CHECK (reserved_usd >= 0),
  CONSTRAINT campaigns_budget_positive
    CHECK (budget_envelope_usd > 0),
  CONSTRAINT campaigns_stateful_requires_workspace
    CHECK (campaign_mode != 'stateful' OR workspace_path IS NOT NULL
           OR campaign_status IN ('pending_approval', 'approved'))
);

COMMENT ON TABLE agent_graph.campaigns IS
  'Campaign envelopes for the Operational Claw (ADR-021). Each campaign is also a work_item (type=campaign). Budget envelope is separate from daily operational budget.';
COMMENT ON COLUMN agent_graph.campaigns.goal_description IS
  'Board-authored campaign brief — equivalent to autoresearch program.md. Campaigner reads this, never modifies it.';
COMMENT ON COLUMN agent_graph.campaigns.iteration_time_budget IS
  'Fixed time budget per iteration (autoresearch pattern). JS-enforced via AbortController.';
COMMENT ON COLUMN agent_graph.campaigns.source_intent_id IS
  'Links to Strategic Claw proposal intent, if campaign was Explorer-proposed.';

-- ============================================================
-- 3. CAMPAIGN ITERATIONS (append-only, mirrors results.tsv)
-- ============================================================

CREATE TABLE agent_graph.campaign_iterations (
  id                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  campaign_id         TEXT NOT NULL REFERENCES agent_graph.campaigns(id),
  work_item_id        TEXT REFERENCES agent_graph.work_items(id),
  iteration_number    INTEGER NOT NULL,

  -- Strategy (LLM-planned)
  strategy_used       JSONB NOT NULL DEFAULT '{}',
  action_taken        TEXT,

  -- Results
  quality_score       NUMERIC(10,4),
  quality_details     JSONB DEFAULT '{}',

  -- Cost + timing
  cost_usd            NUMERIC(15,6) NOT NULL DEFAULT 0,
  duration_ms         INTEGER,

  -- Artifacts (stateful campaigns)
  artifacts           JSONB DEFAULT '{}',
  git_commit_hash     TEXT, -- 7-char short hash

  -- Decision (autoresearch keep/discard pattern)
  decision            TEXT NOT NULL DEFAULT 'pending'
    CHECK (decision IN (
      'keep', 'discard', 'pending',
      'stop_success', 'stop_budget', 'stop_deadline',
      'stop_plateau', 'stop_halt', 'stop_error'
    )),

  -- Self-correction data
  failure_analysis    TEXT,
  strategy_adjustment TEXT,

  -- Content policy compliance
  content_policy_result JSONB,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (campaign_id, iteration_number)
);

COMMENT ON TABLE agent_graph.campaign_iterations IS
  'Append-only iteration log for campaigns (ADR-021). This IS results.tsv — the single source of truth (P3). No file-based duplicate for stateless campaigns.';

-- Prevent mutation on campaign_iterations (append-only, P3)
CREATE TRIGGER campaign_iterations_immutable
  BEFORE UPDATE OR DELETE ON agent_graph.campaign_iterations
  FOR EACH ROW EXECUTE FUNCTION agent_graph.prevent_mutation();

-- ============================================================
-- 4. CAMPAIGN TOOL CALLS (audit per iteration)
-- ============================================================

CREATE TABLE agent_graph.campaign_tool_calls (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  campaign_id     TEXT NOT NULL REFERENCES agent_graph.campaigns(id),
  iteration_id    TEXT REFERENCES agent_graph.campaign_iterations(id),
  tool_name       TEXT NOT NULL,
  params_hash     TEXT,
  result_summary  TEXT,
  duration_ms     INTEGER,
  cost_usd        NUMERIC(15,6) DEFAULT 0,
  success         BOOLEAN NOT NULL,
  error_message   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Prevent mutation (append-only)
CREATE TRIGGER campaign_tool_calls_immutable
  BEFORE UPDATE OR DELETE ON agent_graph.campaign_tool_calls
  FOR EACH ROW EXECUTE FUNCTION agent_graph.prevent_mutation();

-- ============================================================
-- 5. EXPLORATION QUEUE (domain priority for Explorer)
-- ============================================================

CREATE TABLE agent_graph.exploration_queue (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  domain          TEXT NOT NULL UNIQUE CHECK (domain IN (
    'pipeline_health', 'test_health', 'dependency_audit', 'code_quality',
    'spec_alignment', 'config_drift', 'security_scan', 'performance'
  )),
  enabled         BOOLEAN NOT NULL DEFAULT false,
  priority        INTEGER NOT NULL DEFAULT 0,
  last_run_at     TIMESTAMPTZ,
  last_yield      NUMERIC(5,4) DEFAULT 0,
  total_findings  INTEGER NOT NULL DEFAULT 0,
  total_runs      INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE agent_graph.exploration_queue IS
  'Domain priority queue for the Strategic Claw Explorer (ADR-021). Round-robin initially, yield-weighted later.';

-- ============================================================
-- 6. EXPLORATION LOG (immutable cycle log)
-- ============================================================

CREATE TABLE agent_graph.exploration_log (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  cycle_id        TEXT NOT NULL,
  domain          TEXT NOT NULL,
  findings_count  INTEGER NOT NULL DEFAULT 0,
  intents_created INTEGER NOT NULL DEFAULT 0,
  cost_usd        NUMERIC(15,6) NOT NULL DEFAULT 0,
  duration_ms     INTEGER,
  error           TEXT,
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE agent_graph.exploration_log IS
  'Immutable exploration cycle log (ADR-021). One row per domain per cycle. Append-only (P3).';

-- Prevent mutation (append-only)
CREATE TRIGGER exploration_log_immutable
  BEFORE UPDATE OR DELETE ON agent_graph.exploration_log
  FOR EACH ROW EXECUTE FUNCTION agent_graph.prevent_mutation();

-- ============================================================
-- 7. CAMPAIGN BUDGET FUNCTIONS
-- ============================================================

-- Reserve campaign budget: atomic check-and-reserve within envelope
CREATE OR REPLACE FUNCTION agent_graph.reserve_campaign_budget(
  p_campaign_id TEXT,
  p_amount NUMERIC(15,6)
) RETURNS BOOLEAN AS $$
DECLARE
  v_rows INTEGER;
  v_max_per_iteration NUMERIC(15,6);
BEGIN
  -- Check max_cost_per_iteration (Liotta: prevent single-iteration blowout)
  SELECT max_cost_per_iteration INTO v_max_per_iteration
  FROM agent_graph.campaigns WHERE id = p_campaign_id;

  IF v_max_per_iteration IS NOT NULL AND p_amount > v_max_per_iteration THEN
    RETURN FALSE;
  END IF;

  -- Atomic reserve within envelope (P2: DB constraint prevents overspend)
  UPDATE agent_graph.campaigns
    SET reserved_usd = reserved_usd + p_amount,
        updated_at = now()
    WHERE id = p_campaign_id
      AND campaign_status = 'running'
      AND spent_usd + reserved_usd + p_amount <= budget_envelope_usd;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$ LANGUAGE plpgsql;

-- Release campaign budget: undo reservation on failure
CREATE OR REPLACE FUNCTION agent_graph.release_campaign_budget(
  p_campaign_id TEXT,
  p_amount NUMERIC(15,6)
) RETURNS VOID AS $$
BEGIN
  UPDATE agent_graph.campaigns
    SET reserved_usd = GREATEST(reserved_usd - p_amount, 0),
        updated_at = now()
    WHERE id = p_campaign_id;
END;
$$ LANGUAGE plpgsql;

-- Commit campaign spend: move reserved → spent
CREATE OR REPLACE FUNCTION agent_graph.commit_campaign_spend(
  p_campaign_id TEXT,
  p_reserved_amount NUMERIC(15,6),
  p_actual_cost NUMERIC(15,6)
) RETURNS VOID AS $$
BEGIN
  UPDATE agent_graph.campaigns
    SET spent_usd = spent_usd + p_actual_cost,
        reserved_usd = GREATEST(reserved_usd - p_reserved_amount, 0),
        completed_iterations = completed_iterations + 1,
        updated_at = now()
    WHERE id = p_campaign_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 8. EXPLORER_RO DB ROLE (P2: infrastructure enforcement)
-- ============================================================

-- Create the role only if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'explorer_ro') THEN
    CREATE ROLE explorer_ro NOLOGIN;
  END IF;
END $$;

-- SELECT-only on operational schemas
GRANT USAGE ON SCHEMA agent_graph TO explorer_ro;
GRANT USAGE ON SCHEMA inbox TO explorer_ro;
GRANT USAGE ON SCHEMA voice TO explorer_ro;
GRANT USAGE ON SCHEMA signal TO explorer_ro;
GRANT USAGE ON SCHEMA content TO explorer_ro;

GRANT SELECT ON ALL TABLES IN SCHEMA agent_graph TO explorer_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA inbox TO explorer_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA voice TO explorer_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA signal TO explorer_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA content TO explorer_ro;

-- INSERT-only on exploration_log and agent_intents (Explorer's output channels)
GRANT INSERT ON agent_graph.exploration_log TO explorer_ro;
GRANT INSERT ON agent_graph.agent_intents TO explorer_ro;
GRANT INSERT ON agent_graph.agent_intent_transitions TO explorer_ro;

-- ============================================================
-- 9. SEED: EXPLORATION DOMAINS
-- ============================================================

INSERT INTO agent_graph.exploration_queue (domain, enabled, priority) VALUES
  ('pipeline_health', true, 10),
  ('test_health', true, 9),
  ('dependency_audit', true, 7),
  ('code_quality', true, 6),
  ('spec_alignment', true, 5),
  ('config_drift', true, 4),
  ('security_scan', true, 8),
  ('performance', true, 3)
ON CONFLICT (domain) DO NOTHING;

-- ============================================================
-- 10. SEED: AGENT CONFIGS
-- ============================================================

INSERT INTO agent_graph.agent_configs (id, agent_type, model, system_prompt, tools_allowed, config_hash, can_assign_to, guardrails)
VALUES
(
  'claw-explorer', 'architect', 'claude-sonnet-4-6',
  'You are the Strategic Claw (Explorer). Your role is to proactively identify problems, inefficiencies, and improvement opportunities across the Optimus organization. You run periodic exploration cycles across configurable domains (pipeline health, test health, dependency audit, etc.). You create intents for findings — tactical findings auto-route to the Orchestrator, strategic findings go to the board. You may propose campaigns for the Operational Claw. You never modify files, never assign executors, and never create directives. You observe and report.',
  ARRAY['fs_read', 'db_query', 'subprocess_sandboxed', 'web_fetch', 'intent_create'],
  encode(sha256('claw-explorer-v1'::bytea), 'hex'),
  ARRAY[]::text[],
  ARRAY['G1']
),
(
  'claw-campaigner', 'orchestrator', 'claude-sonnet-4-6',
  'You are the Operational Claw (Campaigner). Your role is to execute board-approved campaigns autonomously within a defined envelope (goal, budget, tools, deadline). You iterate using the autoresearch pattern: plan strategy, execute, measure against success criteria, keep improvements, discard regressions. You operate with full autonomy inside the envelope — no per-iteration board approval needed. You log every iteration to campaign_iterations for full transparency.',
  ARRAY['llm_invoke', 'db_read', 'db_write', 'subprocess_sandboxed', 'fs_read', 'fs_write', 'git_ops', 'intent_create'],
  encode(sha256('claw-campaigner-v1'::bytea), 'hex'),
  ARRAY[]::text[],
  ARRAY['G1']
)
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- 11. SEED: PERMISSION GRANTS
-- ============================================================

INSERT INTO agent_graph.permission_grants
  (agent_id, resource_type, resource_name, risk_class, credential_scope, granted_by)
VALUES
  -- Explorer: read-only tools
  ('claw-explorer', 'tool', 'db_query',              'Internal',        NULL,             'board'),
  ('claw-explorer', 'tool', 'fs_read',               'Internal',        NULL,             'board'),
  ('claw-explorer', 'tool', 'intent_create',          'Internal',        NULL,             'board'),
  ('claw-explorer', 'subprocess', 'npm_test',         'Computational',   NULL,             'board'),
  ('claw-explorer', 'subprocess', 'npm_audit',        'Computational',   NULL,             'board'),
  ('claw-explorer', 'api_client', 'web_fetch',        'External-Read',   NULL,             'board'),

  -- Campaigner: broader tool set (campaign-scoped via tool_allowlist)
  ('claw-campaigner', 'tool', 'llm_invoke',           'Computational',   'anthropic:api',  'board'),
  ('claw-campaigner', 'tool', 'db_read',              'Internal',        NULL,             'board'),
  ('claw-campaigner', 'tool', 'db_write',             'Internal',        NULL,             'board'),
  ('claw-campaigner', 'tool', 'fs_read',              'Internal',        NULL,             'board'),
  ('claw-campaigner', 'tool', 'fs_write',             'Internal',        NULL,             'board'),
  ('claw-campaigner', 'tool', 'git_ops',              'Internal',        NULL,             'board'),
  ('claw-campaigner', 'tool', 'intent_create',        'Internal',        NULL,             'board'),
  ('claw-campaigner', 'subprocess', 'subprocess_sandboxed', 'Computational', NULL,         'board'),
  ('claw-campaigner', 'subprocess', 'claude_cli',          'Computational', NULL,         'board'),
  ('claw-campaigner', 'api_client', 'web_fetch',      'External-Read',   NULL,             'board'),
  ('claw-campaigner', 'api_client', 'github',         'External-Write',  NULL,             'board')
ON CONFLICT (agent_id, resource_type, resource_name) DO NOTHING;

-- ============================================================
-- 12. SEED: ASSIGNMENT RULES
-- ============================================================

-- Campaigner reports to board (no assignment delegation in Phase B)
-- Explorer cannot assign (read-only observer)
-- Board can assign to both claws
INSERT INTO agent_graph.agent_assignment_rules (agent_id, can_assign) VALUES
  ('board', 'claw-explorer'),
  ('board', 'claw-campaigner')
ON CONFLICT (agent_id, can_assign) DO NOTHING;

-- ============================================================
-- 13. SEED: VALID TRANSITIONS FOR CAMPAIGN WORK ITEMS
-- ============================================================

-- Campaign work items need the same transitions as other types,
-- plus the orchestrator/campaigner role needs to drive them.
-- The '*' wildcard in existing transitions covers this,
-- but we add explicit campaigner entries for clarity.
INSERT INTO agent_graph.valid_transitions (from_state, to_state, allowed_roles, required_guardrails) VALUES
  ('created', 'in_progress', ARRAY['claw-campaigner', '*'], ARRAY['budget_check']),
  ('in_progress', 'completed', ARRAY['claw-campaigner', '*'], ARRAY[]::text[]),
  ('in_progress', 'failed', ARRAY['claw-campaigner', '*'], ARRAY[]::text[]),
  ('in_progress', 'blocked', ARRAY['claw-campaigner', '*'], ARRAY[]::text[])
ON CONFLICT (from_state, to_state) DO NOTHING;

-- ============================================================
-- 14. SEED: MONTHLY CAMPAIGN ALLOCATION
-- ============================================================

-- Board-set monthly campaign budget (separate from daily operational)
INSERT INTO agent_graph.budgets (scope, scope_id, allocated_usd, period_start, period_end)
VALUES ('monthly', 'campaign_allocation', 100.00,
        date_trunc('month', CURRENT_DATE)::date,
        (date_trunc('month', CURRENT_DATE) + interval '1 month' - interval '1 day')::date)
ON CONFLICT DO NOTHING;

-- ============================================================
-- 15. SEED: EXPLORATION BUDGET
-- ============================================================

INSERT INTO agent_graph.budgets (scope, scope_id, allocated_usd, period_start, period_end)
VALUES ('daily', 'exploration', 5.00, CURRENT_DATE, CURRENT_DATE)
ON CONFLICT DO NOTHING;

-- ============================================================
-- 16. SEED: AUTONOMY LEVELS FOR NEW AGENTS
-- ============================================================

INSERT INTO agent_graph.autonomy_levels (agent_id, current_level)
VALUES ('claw-explorer', 0), ('claw-campaigner', 0)
ON CONFLICT (agent_id) DO NOTHING;

-- ============================================================
-- 17. INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_campaigns_status ON agent_graph.campaigns (campaign_status);
CREATE INDEX IF NOT EXISTS idx_campaigns_work_item ON agent_graph.campaigns (work_item_id);
CREATE INDEX IF NOT EXISTS idx_campaign_iterations_campaign ON agent_graph.campaign_iterations (campaign_id, iteration_number);
CREATE INDEX IF NOT EXISTS idx_campaign_tool_calls_campaign ON agent_graph.campaign_tool_calls (campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_tool_calls_iteration ON agent_graph.campaign_tool_calls (iteration_id);
CREATE INDEX IF NOT EXISTS idx_exploration_log_cycle ON agent_graph.exploration_log (cycle_id);
CREATE INDEX IF NOT EXISTS idx_exploration_log_domain ON agent_graph.exploration_log (domain, created_at);

-- ============================================================
-- FROM: 009
-- ============================================================

-- 009-activity-log.sql
-- Step-level activity log for all agents (P3: Transparency by structure).
--
-- Every agent action — LLM calls, context loads, subtask creation, gate checks,
-- campaign iterations — is recorded here as an append-only tree of steps.
--
-- Parent-child linkage:
--   - Within a single agent execution: LLM calls, gate checks, etc. are children
--     of the agent's root step (parent_step_id = root step for that work item).
--   - Across agents: when agent A creates a subtask for agent B, it stores its
--     current step ID in the new work item's metadata.parent_activity_step_id.
--     Agent B's root step then has parent_step_id = that ID, creating a
--     cross-agent hierarchy.
--
-- Design: append-only, failures swallowed — logging must never break the pipeline.

CREATE TABLE IF NOT EXISTS agent_graph.agent_activity_steps (
  id               UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  work_item_id     UUID,       -- optional: link to agent_graph.work_items
  campaign_id      UUID,       -- optional: link to agent_graph.campaigns
  iteration_number INT,        -- for campaign context: which iteration
  parent_step_id   UUID        REFERENCES agent_graph.agent_activity_steps(id),
  depth            INT         NOT NULL DEFAULT 0, -- denormalized for fast tree rendering
  agent_id         TEXT,
  step_type        TEXT,       -- task_execution, llm_call, context_load, gate_check,
                               -- work_item_create, campaign_iteration, planning,
                               -- strategy_execution, quality_check, decision
  description      TEXT        NOT NULL,
  status           TEXT        NOT NULL DEFAULT 'in_progress'
                               CHECK (status IN ('in_progress', 'completed', 'failed')),
  metadata         JSONB       NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at     TIMESTAMPTZ
);

-- Append-only enforcement (P3): only allow status/completed_at/metadata updates,
-- and only while the step is still in_progress.
CREATE OR REPLACE FUNCTION agent_graph.prevent_activity_step_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'agent_activity_steps is append-only (P3)';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status != 'in_progress' THEN
      RAISE EXCEPTION 'Cannot modify a completed/failed activity step';
    END IF;
    -- Structural fields must not change
    IF NEW.id              != OLD.id
    OR NEW.work_item_id    IS DISTINCT FROM OLD.work_item_id
    OR NEW.campaign_id     IS DISTINCT FROM OLD.campaign_id
    OR NEW.iteration_number IS DISTINCT FROM OLD.iteration_number
    OR NEW.parent_step_id  IS DISTINCT FROM OLD.parent_step_id
    OR NEW.depth           != OLD.depth
    OR NEW.agent_id        IS DISTINCT FROM OLD.agent_id
    OR NEW.step_type       IS DISTINCT FROM OLD.step_type
    OR NEW.description     != OLD.description
    OR NEW.created_at      != OLD.created_at
    THEN
      RAISE EXCEPTION 'Only status, completed_at, and metadata may be updated on agent_activity_steps';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER activity_steps_immutable
BEFORE UPDATE OR DELETE ON agent_graph.agent_activity_steps
FOR EACH ROW EXECUTE FUNCTION agent_graph.prevent_activity_step_mutation();

-- Indexes for the common query patterns
CREATE INDEX IF NOT EXISTS idx_activity_steps_work_item
  ON agent_graph.agent_activity_steps(work_item_id)
  WHERE work_item_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_activity_steps_campaign
  ON agent_graph.agent_activity_steps(campaign_id, iteration_number)
  WHERE campaign_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_activity_steps_parent
  ON agent_graph.agent_activity_steps(parent_step_id)
  WHERE parent_step_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_activity_steps_created
  ON agent_graph.agent_activity_steps(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_activity_steps_agent
  ON agent_graph.agent_activity_steps(agent_id, created_at DESC)
  WHERE agent_id IS NOT NULL;

-- ============================================================
-- FROM: 010
-- ============================================================

-- 010-activity-log-fix-types.sql
-- No schema change needed. The JOIN type mismatch between agent_activity_steps.work_item_id (UUID)
-- and work_items.id (TEXT) is handled in the API query with an explicit ::text cast.
-- This migration is intentionally empty and serves as a placeholder.
SELECT 1;

-- ============================================================
-- FROM: 011
-- ============================================================

-- 011-missing-tables.sql
-- Remediation: creates tables/functions/views/indexes that were skipped by the
-- migration runner when 002-schemas-and-tables.sql partially failed and
-- 008-claw-system.sql was never applied.
--
-- All DDL uses IF NOT EXISTS / CREATE OR REPLACE / ON CONFLICT DO NOTHING
-- so this migration is safe to re-run.

-- ============================================================
-- FROM 002: spec_proposals and spec_proposal_transitions
-- ============================================================

CREATE TABLE IF NOT EXISTS agent_graph.spec_proposals (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  agent_tier TEXT NOT NULL,
  agent_name TEXT,
  work_item_id TEXT REFERENCES agent_graph.work_items(id),
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  sections JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'revision-requested', 'superseded')),
  board_feedback TEXT,
  revision_of TEXT REFERENCES agent_graph.spec_proposals(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by TEXT
);

CREATE TABLE IF NOT EXISTS agent_graph.spec_proposal_transitions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES agent_graph.spec_proposals(id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor TEXT,
  feedback TEXT,
  transitioned_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_spec_proposal_transitions_proposal
  ON agent_graph.spec_proposal_transitions(proposal_id);

-- ============================================================
-- FROM 002: agent_intents and agent_intent_transitions
-- ============================================================

CREATE TABLE IF NOT EXISTS agent_graph.agent_intents (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  agent_id TEXT NOT NULL,
  agent_tier TEXT NOT NULL,
  intent_type TEXT NOT NULL CHECK (intent_type IN ('task', 'directive', 'observation', 'schedule', 'governance')),
  decision_tier TEXT NOT NULL DEFAULT 'tactical'
    CHECK (decision_tier IN ('tactical', 'strategic', 'existential')),
  title TEXT NOT NULL,
  reasoning TEXT NOT NULL,
  proposed_action JSONB NOT NULL,
  trigger_context JSONB,
  trigger_type TEXT NOT NULL DEFAULT 'once'
    CHECK (trigger_type IN ('once', 'interval', 'cron', 'condition')),
  trigger_config JSONB,
  next_fire_at TIMESTAMPTZ,
  last_fired_at TIMESTAMPTZ,
  fire_count INTEGER NOT NULL DEFAULT 0,
  max_fires INTEGER,
  cooldown_ms INTEGER,
  budget_per_fire NUMERIC(10,4),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'executed')),
  board_feedback TEXT,
  reviewed_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ,
  executed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS agent_graph.agent_intent_transitions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  intent_id TEXT NOT NULL REFERENCES agent_graph.agent_intents(id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor TEXT,
  feedback TEXT,
  transitioned_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Auto-log intent status changes (P3)
CREATE OR REPLACE FUNCTION agent_graph.log_intent_transition()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO agent_graph.agent_intent_transitions
      (intent_id, from_status, to_status, actor, feedback)
    VALUES (
      NEW.id,
      OLD.status,
      NEW.status,
      COALESCE(current_setting('app.agent_id', true), 'system'),
      NEW.board_feedback
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_intent_transition ON agent_graph.agent_intents;
CREATE TRIGGER trg_intent_transition
  AFTER UPDATE ON agent_graph.agent_intents
  FOR EACH ROW
  EXECUTE FUNCTION agent_graph.log_intent_transition();

-- Expire stale intents
CREATE OR REPLACE FUNCTION agent_graph.expire_stale_intents()
RETURNS INTEGER AS $$
DECLARE
  expired_count INTEGER;
BEGIN
  UPDATE agent_graph.agent_intents
  SET status = 'expired'
  WHERE status = 'pending'
    AND expires_at IS NOT NULL
    AND expires_at < now();
  GET DIAGNOSTICS expired_count = ROW_COUNT;
  RETURN expired_count;
END;
$$ LANGUAGE plpgsql;

-- Indexes for agent_intents (from 003)
CREATE INDEX IF NOT EXISTS idx_agent_intents_status ON agent_graph.agent_intents(status);
CREATE INDEX IF NOT EXISTS idx_agent_intents_agent ON agent_graph.agent_intents(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_intents_created ON agent_graph.agent_intents(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_intents_pending ON agent_graph.agent_intents(created_at)
  WHERE status = 'pending';

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_intents_pattern_dedup
  ON agent_graph.agent_intents (
    agent_id,
    (trigger_context->>'pattern'),
    COALESCE(trigger_context->>'contact_id', ''),
    COALESCE(trigger_context->>'message_id', '')
  )
  WHERE status IN ('pending', 'approved', 'executed');

CREATE INDEX IF NOT EXISTS idx_agent_intents_next_fire
  ON agent_graph.agent_intents(next_fire_at)
  WHERE status = 'approved' AND trigger_type IN ('interval', 'cron', 'condition');

CREATE INDEX IF NOT EXISTS idx_intent_transitions_intent ON agent_graph.agent_intent_transitions(intent_id);

-- ============================================================
-- FROM 002: research_iterations
-- ============================================================

CREATE TABLE IF NOT EXISTS agent_graph.research_iterations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workstream_id   TEXT NOT NULL REFERENCES agent_graph.work_items(id),
  iteration_num   INTEGER NOT NULL,
  hypothesis      TEXT NOT NULL,
  queries         JSONB NOT NULL DEFAULT '[]',
  sources         JSONB NOT NULL DEFAULT '[]',
  findings        JSONB NOT NULL DEFAULT '[]',
  coverage_score  NUMERIC(5,4) DEFAULT 0
                  CHECK (coverage_score >= 0 AND coverage_score <= 1),
  delta_score     NUMERIC(10,4) DEFAULT 0
                  CHECK (delta_score >= 0),
  decision        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (decision IN ('kept', 'discarded', 'pending')),
  cost_usd        NUMERIC(15,6) DEFAULT 0,
  duration_ms     INTEGER,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workstream_id, iteration_num)
);

CREATE INDEX IF NOT EXISTS idx_research_iterations_workstream
  ON agent_graph.research_iterations(workstream_id);

-- ============================================================
-- FROM 002: learned_patterns, learning_insights
-- ============================================================

CREATE TABLE IF NOT EXISTS agent_graph.learned_patterns (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     TEXT NOT NULL,
  pattern_type TEXT NOT NULL CHECK (pattern_type IN (
    'success_rate', 'delegation_path', 'cost_efficiency',
    'duration_trend', 'failure_mode',
    'time_of_day', 'thread_depth', 'sender_type'
  )),
  description  TEXT NOT NULL CHECK (length(description) <= 500),
  metric_value NUMERIC,
  confidence   NUMERIC CHECK (confidence >= 0 AND confidence <= 1),
  sample_size  INTEGER NOT NULL DEFAULT 0,
  period_start TIMESTAMPTZ NOT NULL,
  period_end   TIMESTAMPTZ NOT NULL,
  metadata     JSONB DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agent_id, pattern_type, period_start, period_end)
);

CREATE TABLE IF NOT EXISTS agent_graph.learning_insights (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  insight_type   TEXT NOT NULL CHECK (insight_type IN (
    'success_rate_drop', 'new_failure_mode', 'cost_anomaly',
    'delegation_degradation', 'autonomy_ready'
  )),
  agent_id       TEXT NOT NULL,
  title          TEXT NOT NULL,
  summary        TEXT NOT NULL,
  severity       TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  metric_current NUMERIC,
  metric_prior   NUMERIC,
  metric_delta   NUMERIC,
  sample_size    INTEGER,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- FROM 002: autonomy_levels, autonomy_promotions
-- ============================================================

CREATE TABLE IF NOT EXISTS agent_graph.autonomy_levels (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      TEXT NOT NULL UNIQUE,
  current_level INTEGER NOT NULL DEFAULT 0 CHECK (current_level IN (0, 1, 2)),
  promoted_at   TIMESTAMPTZ,
  promoted_by   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_graph.autonomy_promotions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id          TEXT NOT NULL,
  from_level        INTEGER NOT NULL,
  to_level          INTEGER NOT NULL,
  promoted_by       TEXT NOT NULL,
  notes             TEXT,
  criteria_snapshot  JSONB NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION agent_graph.prevent_promotion_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'autonomy_promotions is append-only (P3)';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_promotion_mutation ON agent_graph.autonomy_promotions;
CREATE TRIGGER trg_prevent_promotion_mutation
  BEFORE UPDATE OR DELETE ON agent_graph.autonomy_promotions
  FOR EACH ROW EXECUTE FUNCTION agent_graph.prevent_promotion_mutation();

-- ============================================================
-- FROM 004: intent_match_rate view (needed by /api/intents/rates)
-- ============================================================

CREATE OR REPLACE VIEW agent_graph.intent_match_rate AS
SELECT
  agent_id,
  intent_type,
  COUNT(*) FILTER (WHERE status IN ('approved', 'executed')) AS approved,
  COUNT(*) FILTER (WHERE status = 'rejected') AS rejected,
  COUNT(*) FILTER (WHERE status IN ('approved', 'executed', 'rejected')) AS total,
  ROUND(
    COUNT(*) FILTER (WHERE status IN ('approved', 'executed'))::numeric /
    NULLIF(COUNT(*) FILTER (WHERE status IN ('approved', 'executed', 'rejected')), 0),
    3
  ) AS match_rate
FROM agent_graph.agent_intents
WHERE created_at > now() - INTERVAL '90 days'
GROUP BY agent_id, intent_type;

-- ============================================================
-- FROM 008: CHECK CONSTRAINT UPDATES on existing tables
-- ============================================================

-- work_items.type: add 'campaign'
ALTER TABLE agent_graph.work_items
  DROP CONSTRAINT IF EXISTS work_items_type_check;
ALTER TABLE agent_graph.work_items
  ADD CONSTRAINT work_items_type_check
  CHECK (type IN ('directive', 'workstream', 'task', 'subtask', 'campaign'));

-- budgets.scope: add 'campaign', 'exploration'
ALTER TABLE agent_graph.budgets
  DROP CONSTRAINT IF EXISTS budgets_scope_check;
ALTER TABLE agent_graph.budgets
  ADD CONSTRAINT budgets_scope_check
  CHECK (scope IN ('daily', 'monthly', 'directive', 'workstream', 'campaign', 'exploration'));

-- permission_grants.resource_type: add 'external_api'
ALTER TABLE agent_graph.permission_grants
  DROP CONSTRAINT IF EXISTS permission_grants_resource_type_check;
ALTER TABLE agent_graph.permission_grants
  ADD CONSTRAINT permission_grants_resource_type_check
  CHECK (resource_type IN ('tool', 'adapter', 'api_client', 'subprocess', 'external_api'));

-- tool_invocations.resource_type: add 'external_api'
ALTER TABLE agent_graph.tool_invocations
  DROP CONSTRAINT IF EXISTS tool_invocations_resource_type_check;
ALTER TABLE agent_graph.tool_invocations
  ADD CONSTRAINT tool_invocations_resource_type_check
  CHECK (resource_type IN ('tool', 'adapter', 'api_client', 'subprocess', 'external_api'));

-- event_log: add campaign + exploration event types
ALTER TABLE autobot_public.event_log
  DROP CONSTRAINT IF EXISTS event_log_event_type_check;
ALTER TABLE autobot_public.event_log
  ADD CONSTRAINT event_log_event_type_check
  CHECK (event_type IN (
    'email_received', 'email_triaged', 'draft_created', 'draft_reviewed',
    'draft_approved', 'draft_sent', 'halt_triggered', 'halt_cleared',
    'budget_warning', 'autonomy_evaluation', 'config_changed',
    'board_directive', 'infrastructure_error',
    'redesign_submitted', 'redesign_completed',
    'blueprint_submitted', 'blueprint_completed',
    'intent_executed', 'agent_insight',
    'intent_approved', 'intent_rejected',
    'campaign_started', 'campaign_iteration', 'campaign_completed',
    'campaign_paused', 'campaign_cancelled',
    'exploration_cycle', 'exploration_finding',
    'workshop_succeeded', 'workshop_failed'
  ));

-- ============================================================
-- FROM 008: CAMPAIGNS TABLE (duplicate removed — merged into first definition above)
-- ============================================================

-- ============================================================
-- FROM 008: CAMPAIGN ITERATIONS
-- ============================================================

CREATE TABLE IF NOT EXISTS agent_graph.campaign_iterations (
  id                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  campaign_id         TEXT NOT NULL REFERENCES agent_graph.campaigns(id),
  work_item_id        TEXT REFERENCES agent_graph.work_items(id),
  iteration_number    INTEGER NOT NULL,

  strategy_used       JSONB NOT NULL DEFAULT '{}',
  action_taken        TEXT,

  quality_score       NUMERIC(10,4),
  quality_details     JSONB DEFAULT '{}',

  cost_usd            NUMERIC(15,6) NOT NULL DEFAULT 0,
  duration_ms         INTEGER,

  artifacts           JSONB DEFAULT '{}',
  git_commit_hash     TEXT,

  decision            TEXT NOT NULL DEFAULT 'pending'
    CHECK (decision IN (
      'keep', 'discard', 'pending',
      'stop_success', 'stop_budget', 'stop_deadline',
      'stop_plateau', 'stop_halt', 'stop_error'
    )),

  failure_analysis    TEXT,
  strategy_adjustment TEXT,
  content_policy_result JSONB,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (campaign_id, iteration_number)
);

DROP TRIGGER IF EXISTS campaign_iterations_immutable ON agent_graph.campaign_iterations;
CREATE TRIGGER campaign_iterations_immutable
  BEFORE UPDATE OR DELETE ON agent_graph.campaign_iterations
  FOR EACH ROW EXECUTE FUNCTION agent_graph.prevent_mutation();

-- ============================================================
-- FROM 008: CAMPAIGN TOOL CALLS
-- ============================================================

CREATE TABLE IF NOT EXISTS agent_graph.campaign_tool_calls (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  campaign_id     TEXT NOT NULL REFERENCES agent_graph.campaigns(id),
  iteration_id    TEXT REFERENCES agent_graph.campaign_iterations(id),
  tool_name       TEXT NOT NULL,
  params_hash     TEXT,
  result_summary  TEXT,
  duration_ms     INTEGER,
  cost_usd        NUMERIC(15,6) DEFAULT 0,
  success         BOOLEAN NOT NULL,
  error_message   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS campaign_tool_calls_immutable ON agent_graph.campaign_tool_calls;
CREATE TRIGGER campaign_tool_calls_immutable
  BEFORE UPDATE OR DELETE ON agent_graph.campaign_tool_calls
  FOR EACH ROW EXECUTE FUNCTION agent_graph.prevent_mutation();

-- ============================================================
-- FROM 008: EXPLORATION QUEUE + LOG
-- ============================================================

CREATE TABLE IF NOT EXISTS agent_graph.exploration_queue (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  domain          TEXT NOT NULL UNIQUE CHECK (domain IN (
    'pipeline_health', 'test_health', 'dependency_audit', 'code_quality',
    'spec_alignment', 'config_drift', 'security_scan', 'performance'
  )),
  enabled         BOOLEAN NOT NULL DEFAULT false,
  priority        INTEGER NOT NULL DEFAULT 0,
  last_run_at     TIMESTAMPTZ,
  last_yield      NUMERIC(5,4) DEFAULT 0,
  total_findings  INTEGER NOT NULL DEFAULT 0,
  total_runs      INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_graph.exploration_log (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  cycle_id        TEXT NOT NULL,
  domain          TEXT NOT NULL,
  findings_count  INTEGER NOT NULL DEFAULT 0,
  intents_created INTEGER NOT NULL DEFAULT 0,
  cost_usd        NUMERIC(15,6) NOT NULL DEFAULT 0,
  duration_ms     INTEGER,
  error           TEXT,
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS exploration_log_immutable ON agent_graph.exploration_log;
CREATE TRIGGER exploration_log_immutable
  BEFORE UPDATE OR DELETE ON agent_graph.exploration_log
  FOR EACH ROW EXECUTE FUNCTION agent_graph.prevent_mutation();

-- ============================================================
-- FROM 008: CAMPAIGN BUDGET FUNCTIONS
-- ============================================================

CREATE OR REPLACE FUNCTION agent_graph.reserve_campaign_budget(
  p_campaign_id TEXT,
  p_amount NUMERIC(15,6)
) RETURNS BOOLEAN AS $$
DECLARE
  v_rows INTEGER;
  v_max_per_iteration NUMERIC(15,6);
BEGIN
  SELECT max_cost_per_iteration INTO v_max_per_iteration
  FROM agent_graph.campaigns WHERE id = p_campaign_id;

  IF v_max_per_iteration IS NOT NULL AND p_amount > v_max_per_iteration THEN
    RETURN FALSE;
  END IF;

  UPDATE agent_graph.campaigns
    SET reserved_usd = reserved_usd + p_amount,
        updated_at = now()
    WHERE id = p_campaign_id
      AND campaign_status = 'running'
      AND spent_usd + reserved_usd + p_amount <= budget_envelope_usd;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION agent_graph.release_campaign_budget(
  p_campaign_id TEXT,
  p_amount NUMERIC(15,6)
) RETURNS VOID AS $$
BEGIN
  UPDATE agent_graph.campaigns
    SET reserved_usd = GREATEST(reserved_usd - p_amount, 0),
        updated_at = now()
    WHERE id = p_campaign_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION agent_graph.commit_campaign_spend(
  p_campaign_id TEXT,
  p_reserved_amount NUMERIC(15,6),
  p_actual_cost NUMERIC(15,6)
) RETURNS VOID AS $$
BEGIN
  UPDATE agent_graph.campaigns
    SET spent_usd = spent_usd + p_actual_cost,
        reserved_usd = GREATEST(reserved_usd - p_reserved_amount, 0),
        completed_iterations = completed_iterations + 1,
        updated_at = now()
    WHERE id = p_campaign_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- FROM 008: DB ROLE FOR EXPLORER (P2)
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'explorer_ro') THEN
    CREATE ROLE explorer_ro NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA agent_graph TO explorer_ro;
GRANT USAGE ON SCHEMA inbox TO explorer_ro;
GRANT USAGE ON SCHEMA voice TO explorer_ro;
GRANT USAGE ON SCHEMA signal TO explorer_ro;
GRANT USAGE ON SCHEMA content TO explorer_ro;

GRANT SELECT ON ALL TABLES IN SCHEMA agent_graph TO explorer_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA inbox TO explorer_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA voice TO explorer_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA signal TO explorer_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA content TO explorer_ro;

GRANT INSERT ON agent_graph.exploration_log TO explorer_ro;
GRANT INSERT ON agent_graph.agent_intents TO explorer_ro;
GRANT INSERT ON agent_graph.agent_intent_transitions TO explorer_ro;

-- ============================================================
-- FROM 008: SEED DATA
-- ============================================================

INSERT INTO agent_graph.exploration_queue (domain, enabled, priority) VALUES
  ('pipeline_health', true, 10),
  ('test_health', true, 9),
  ('dependency_audit', true, 7),
  ('code_quality', true, 6),
  ('spec_alignment', true, 5),
  ('config_drift', true, 4),
  ('security_scan', true, 8),
  ('performance', true, 3)
ON CONFLICT (domain) DO NOTHING;

INSERT INTO agent_graph.agent_configs (id, agent_type, model, system_prompt, tools_allowed, config_hash, can_assign_to, guardrails)
VALUES
(
  'claw-explorer', 'architect', 'claude-sonnet-4-6',
  'You are the Strategic Claw (Explorer). Your role is to proactively identify problems, inefficiencies, and improvement opportunities across the Optimus organization. You run periodic exploration cycles across configurable domains (pipeline health, test health, dependency audit, etc.). You create intents for findings — tactical findings auto-route to the Orchestrator, strategic findings go to the board. You may propose campaigns for the Operational Claw. You never modify files, never assign executors, and never create directives. You observe and report.',
  ARRAY['fs_read', 'db_query', 'subprocess_sandboxed', 'web_fetch', 'intent_create'],
  encode(sha256('claw-explorer-v1'::bytea), 'hex'),
  ARRAY[]::text[],
  ARRAY['G1']
),
(
  'claw-campaigner', 'orchestrator', 'claude-sonnet-4-6',
  'You are the Operational Claw (Campaigner). Your role is to execute board-approved campaigns autonomously within a defined envelope (goal, budget, tools, deadline). You iterate using the autoresearch pattern: plan strategy, execute, measure against success criteria, keep improvements, discard regressions. You operate with full autonomy inside the envelope — no per-iteration board approval needed. You log every iteration to campaign_iterations for full transparency.',
  ARRAY['llm_invoke', 'db_read', 'db_write', 'subprocess_sandboxed', 'fs_read', 'fs_write', 'git_ops', 'intent_create'],
  encode(sha256('claw-campaigner-v1'::bytea), 'hex'),
  ARRAY[]::text[],
  ARRAY['G1']
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO agent_graph.agent_configs (id, agent_type, model, system_prompt, tools_allowed, config_hash, is_active, guardrails)
VALUES (
  'claw-workshop', 'orchestrator', 'claude-sonnet-4-6',
  'You are the Claw Workshop agent. You execute full engineering workflows (plan, implement, test, review, PR) by spawning a single Claude Code CLI session with a playbook. You operate within a budget envelope and can only create PRs — never merge, never communicate externally, never modify governance config.',
  ARRAY['task_read', 'claude_code_session', 'slack_notify'],
  'pending_sync', true,
  ARRAY['G1', 'G5']
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO agent_graph.permission_grants
  (agent_id, resource_type, resource_name, risk_class, credential_scope, granted_by)
VALUES
  ('claw-explorer', 'tool', 'db_query',              'Internal',        NULL,             'board'),
  ('claw-explorer', 'tool', 'fs_read',               'Internal',        NULL,             'board'),
  ('claw-explorer', 'tool', 'intent_create',          'Internal',        NULL,             'board'),
  ('claw-explorer', 'subprocess', 'npm_test',         'Computational',   NULL,             'board'),
  ('claw-explorer', 'subprocess', 'npm_audit',        'Computational',   NULL,             'board'),
  ('claw-explorer', 'api_client', 'web_fetch',        'External-Read',   NULL,             'board'),
  ('claw-campaigner', 'tool', 'llm_invoke',           'Computational',   'anthropic:api',  'board'),
  ('claw-campaigner', 'tool', 'db_read',              'Internal',        NULL,             'board'),
  ('claw-campaigner', 'tool', 'db_write',             'Internal',        NULL,             'board'),
  ('claw-campaigner', 'tool', 'fs_read',              'Internal',        NULL,             'board'),
  ('claw-campaigner', 'tool', 'fs_write',             'Internal',        NULL,             'board'),
  ('claw-campaigner', 'tool', 'git_ops',              'Internal',        NULL,             'board'),
  ('claw-campaigner', 'tool', 'intent_create',        'Internal',        NULL,             'board'),
  ('claw-campaigner', 'subprocess', 'subprocess_sandboxed', 'Computational', NULL,         'board'),
  ('claw-campaigner', 'subprocess', 'claude_cli',          'Computational', NULL,         'board'),
  ('claw-campaigner', 'api_client', 'web_fetch',      'External-Read',   NULL,             'board'),
  ('claw-campaigner', 'api_client', 'github',         'External-Write',  NULL,             'board'),
  ('claw-workshop',   'subprocess', 'claude_cli',      'Computational',   NULL,             'board'),
  ('claw-workshop',   'tool',       'task_read',       'Internal',        NULL,             'board'),
  ('claw-workshop',   'tool',       'slack_notify',    'External-Write',  NULL,             'board'),
  ('claw-workshop',   'api_client', 'github',          'External-Write',  NULL,             'board'),
  ('claw-workshop',   'api_client', 'linear',          'External-Write',  NULL,             'board')
ON CONFLICT (agent_id, resource_type, resource_name) DO NOTHING;

-- Note: 'board' is not an agent_config entry, so we cannot add FK-constrained
-- assignment rules for it. Board assignments are handled via API directly.

INSERT INTO agent_graph.valid_transitions (from_state, to_state, allowed_roles, required_guardrails) VALUES
  ('created', 'in_progress', ARRAY['claw-campaigner', '*'], ARRAY['budget_check']),
  ('in_progress', 'completed', ARRAY['claw-campaigner', '*'], ARRAY[]::text[]),
  ('in_progress', 'failed', ARRAY['claw-campaigner', '*'], ARRAY[]::text[]),
  ('in_progress', 'blocked', ARRAY['claw-campaigner', '*'], ARRAY[]::text[])
ON CONFLICT (from_state, to_state) DO NOTHING;

INSERT INTO agent_graph.budgets (scope, scope_id, allocated_usd, period_start, period_end)
VALUES ('monthly', 'campaign_allocation', 100.00,
        date_trunc('month', CURRENT_DATE)::date,
        (date_trunc('month', CURRENT_DATE) + interval '1 month' - interval '1 day')::date)
ON CONFLICT DO NOTHING;

INSERT INTO agent_graph.budgets (scope, scope_id, allocated_usd, period_start, period_end)
VALUES ('daily', 'exploration', 5.00, CURRENT_DATE, CURRENT_DATE)
ON CONFLICT DO NOTHING;

INSERT INTO agent_graph.autonomy_levels (agent_id, current_level)
VALUES ('claw-explorer', 0), ('claw-campaigner', 0), ('claw-workshop', 0)
ON CONFLICT (agent_id) DO NOTHING;

-- ============================================================
-- FROM 008: INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_campaigns_status ON agent_graph.campaigns (campaign_status);
CREATE INDEX IF NOT EXISTS idx_campaigns_work_item ON agent_graph.campaigns (work_item_id);
CREATE INDEX IF NOT EXISTS idx_campaign_iterations_campaign ON agent_graph.campaign_iterations (campaign_id, iteration_number);
CREATE INDEX IF NOT EXISTS idx_campaign_tool_calls_campaign ON agent_graph.campaign_tool_calls (campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_tool_calls_iteration ON agent_graph.campaign_tool_calls (iteration_id);
CREATE INDEX IF NOT EXISTS idx_exploration_log_cycle ON agent_graph.exploration_log (cycle_id);
CREATE INDEX IF NOT EXISTS idx_exploration_log_domain ON agent_graph.exploration_log (domain, created_at);

-- ============================================================
-- FROM: 012
-- ============================================================

-- 012-claw-workshop.sql
-- Claw Workshop agent: campaign_mode extension, metadata column, event types,
-- agent config, permissions.

BEGIN;

-- 1. Add metadata column to campaigns (used by workshop for playbook_id, linear context)
ALTER TABLE agent_graph.campaigns
  ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';

-- 2. Extend campaign_mode CHECK to include 'workshop'
ALTER TABLE agent_graph.campaigns
  DROP CONSTRAINT IF EXISTS campaigns_campaign_mode_check;

ALTER TABLE agent_graph.campaigns
  ADD CONSTRAINT campaigns_campaign_mode_check
  CHECK (campaign_mode IN ('stateless', 'stateful', 'workshop'));

-- 3. Add workshop event types to event_log
ALTER TABLE autobot_public.event_log
  DROP CONSTRAINT IF EXISTS event_log_event_type_check;

ALTER TABLE autobot_public.event_log
  ADD CONSTRAINT event_log_event_type_check
  CHECK (event_type IN (
    'email_received', 'email_triaged', 'draft_created', 'draft_reviewed',
    'draft_approved', 'draft_sent', 'halt_triggered', 'halt_cleared',
    'budget_warning', 'autonomy_evaluation', 'config_changed',
    'board_directive', 'infrastructure_error',
    'redesign_submitted', 'redesign_completed',
    'blueprint_submitted', 'blueprint_completed',
    'intent_executed', 'agent_insight',
    'intent_approved', 'intent_rejected',
    'campaign_started', 'campaign_iteration', 'campaign_completed',
    'campaign_paused', 'campaign_cancelled',
    'exploration_cycle', 'exploration_finding',
    'workshop_succeeded', 'workshop_failed'
  ));

-- 4. Seed agent_configs row for claw-workshop
INSERT INTO agent_graph.agent_configs (id, agent_type, model, system_prompt, tools_allowed, config_hash, is_active, guardrails)
VALUES (
  'claw-workshop', 'orchestrator', 'claude-sonnet-4-6',
  'You are the Claw Workshop agent. You execute full engineering workflows (plan, implement, test, review, PR) by spawning a single Claude Code CLI session with a playbook. You operate within a budget envelope and can only create PRs — never merge, never communicate externally, never modify governance config.',
  ARRAY['task_read', 'claude_code_session', 'slack_notify'],
  'pending_sync', true,
  ARRAY['G1', 'G5']
)
ON CONFLICT (id) DO UPDATE SET is_active = true, updated_at = now();

-- 5. Seed permission_grants for claw-workshop (resource_name is the column name)
INSERT INTO agent_graph.permission_grants (agent_id, resource_type, resource_name, risk_class, granted_by)
VALUES
  ('claw-workshop', 'subprocess', 'claude_cli', 'Computational', 'board'),
  ('claw-workshop', 'tool', 'task_read', 'Internal', 'board'),
  ('claw-workshop', 'tool', 'slack_notify', 'External-Write', 'board'),
  ('claw-workshop', 'api_client', 'github', 'External-Write', 'board'),
  ('claw-workshop', 'api_client', 'linear', 'External-Write', 'board')
ON CONFLICT (agent_id, resource_type, resource_name) DO NOTHING;

-- 6. Add valid transitions for claw-workshop
INSERT INTO agent_graph.valid_transitions (from_state, to_state, allowed_roles, required_guardrails) VALUES
  ('created', 'in_progress', ARRAY['claw-workshop'], ARRAY['budget_check']),
  ('in_progress', 'completed', ARRAY['claw-workshop'], ARRAY[]::text[]),
  ('in_progress', 'failed', ARRAY['claw-workshop'], ARRAY[]::text[])
ON CONFLICT (from_state, to_state) DO NOTHING;

-- ============================================================
-- Governance Intake System (2026-03-21)
-- Unified submission + audit pipeline for board governance
-- ============================================================

CREATE TABLE agent_graph.governance_submissions (
  id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  submitted_by      TEXT NOT NULL,
  title             TEXT NOT NULL,
  content_type      TEXT NOT NULL CHECK (content_type IN (
    'spec_amendment', 'agent_proposal', 'research', 'idea',
    'adr', 'process_improvement', 'external_reference'
  )),
  source_format     TEXT NOT NULL DEFAULT 'markdown' CHECK (source_format IN (
    'markdown', 'url', 'file_upload', 'paste', 'repo_reference'
  )),
  raw_content       TEXT CHECK (raw_content IS NULL OR length(raw_content) <= 100000),
  source_url        TEXT,
  attached_files    JSONB DEFAULT '[]'::jsonb,

  -- Auto-classification (populated by intake classifier)
  spec_domains      TEXT[] DEFAULT '{}',
  affected_sections TEXT[] DEFAULT '{}',
  affected_adrs     TEXT[] DEFAULT '{}',
  impact_level      TEXT CHECK (impact_level IN ('low', 'medium', 'high', 'critical')),
  urgency           TEXT CHECK (urgency IN ('low', 'normal', 'high', 'blocking')),

  -- Audit results (populated by audit agent)
  audit_result      JSONB,
  audit_completed   TIMESTAMPTZ,
  audit_agent       TEXT,
  audit_cost_usd    NUMERIC(10,6),

  -- Decision workflow
  status            TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN (
    'submitted', 'auditing', 'awaiting_review', 'discussing',
    'accepted', 'rejected', 'deferred', 'superseded'
  )),
  decision_by       TEXT,
  decision_at       TIMESTAMPTZ,
  decision_reason   TEXT,

  -- Linkage to existing systems
  work_item_id      TEXT REFERENCES agent_graph.work_items(id),
  pr_url            TEXT,
  adr_path          TEXT,

  -- Discussion thread
  discussion_thread JSONB DEFAULT '[]'::jsonb,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_gov_submissions_status ON agent_graph.governance_submissions(status);
CREATE INDEX idx_gov_submissions_type ON agent_graph.governance_submissions(content_type);
CREATE INDEX idx_gov_submissions_created ON agent_graph.governance_submissions(created_at DESC);
CREATE INDEX idx_gov_submissions_impact ON agent_graph.governance_submissions(impact_level) WHERE impact_level IS NOT NULL;

-- Append-only state transition log (P3: transparency by structure)
CREATE TABLE agent_graph.governance_transitions (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  submission_id   TEXT NOT NULL REFERENCES agent_graph.governance_submissions(id),
  from_status     TEXT NOT NULL,
  to_status       TEXT NOT NULL,
  changed_by      TEXT NOT NULL,
  reason          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_gov_transitions_submission ON agent_graph.governance_transitions(submission_id);

CREATE OR REPLACE FUNCTION agent_graph.update_governance_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_governance_submissions_updated
  BEFORE UPDATE ON agent_graph.governance_submissions
  FOR EACH ROW EXECUTE FUNCTION agent_graph.update_governance_updated_at();

CREATE OR REPLACE FUNCTION agent_graph.log_governance_transition()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO agent_graph.governance_transitions (submission_id, from_status, to_status, changed_by, reason)
    VALUES (NEW.id, OLD.status, NEW.status, COALESCE(NEW.decision_by, NEW.submitted_by), NEW.decision_reason);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_governance_status_transition
  AFTER UPDATE OF status ON agent_graph.governance_submissions
  FOR EACH ROW EXECUTE FUNCTION agent_graph.log_governance_transition();

CREATE OR REPLACE VIEW agent_graph.v_governance_inbox AS
SELECT
  gs.id, gs.title, gs.content_type, gs.source_format, gs.submitted_by,
  gs.status, gs.impact_level, gs.urgency, gs.spec_domains, gs.affected_adrs,
  gs.audit_result, gs.audit_completed, gs.audit_cost_usd,
  gs.decision_by, gs.decision_at, gs.decision_reason,
  gs.work_item_id, gs.pr_url, gs.discussion_thread,
  gs.created_at, gs.updated_at,
  jsonb_array_length(COALESCE(gs.discussion_thread, '[]'::jsonb)) AS discussion_count
FROM agent_graph.governance_submissions gs
ORDER BY
  CASE gs.status
    WHEN 'awaiting_review' THEN 1
    WHEN 'discussing' THEN 2
    WHEN 'auditing' THEN 3
    WHEN 'submitted' THEN 4
    ELSE 5
  END,
  CASE gs.urgency
    WHEN 'blocking' THEN 1
    WHEN 'high' THEN 2
    WHEN 'normal' THEN 3
    WHEN 'low' THEN 4
    ELSE 5
  END,
  gs.created_at DESC;

COMMIT;


-- ============================================================
-- Squashed incrementals (007-016) folded into baseline
-- ============================================================

-- 007-routing-class-enforcement.sql
-- Routing class enforcement: track actual routing for misclassification detection.
-- The routing_class column and CHECK constraint already exist on work_items (001-baseline.sql).
-- This migration adds the tracking column and monitoring view.

-- Track what actually happened (template vs LLM) for misclassification detection
ALTER TABLE agent_graph.work_items
  ADD COLUMN IF NOT EXISTS routing_class_actual TEXT
  CHECK (routing_class_actual IN ('DETERMINISTIC', 'LIGHTWEIGHT', 'FULL'));

-- Monitoring view: surface misclassifications for board review
CREATE OR REPLACE VIEW agent_graph.routing_misclassifications AS
SELECT
  wi.id AS work_item_id,
  wi.type,
  wi.routing_class AS classified_as,
  wi.routing_class_actual AS executed_as,
  wi.assigned_to,
  wi.created_at,
  li.cost_usd AS llm_cost,
  CASE
    WHEN wi.routing_class = 'DETERMINISTIC' AND wi.routing_class_actual != 'DETERMINISTIC'
      THEN 'DETERMINISTIC task hit LLM (waste)'
    WHEN wi.routing_class = 'FULL' AND wi.routing_class_actual = 'DETERMINISTIC'
      THEN 'FULL task was deterministic (over-classified)'
    WHEN wi.routing_class IS NULL AND wi.routing_class_actual IS NOT NULL
      THEN 'Unclassified task (needs routing_class)'
    ELSE 'mismatch'
  END AS mismatch_type
FROM agent_graph.work_items wi
LEFT JOIN LATERAL (
  SELECT SUM(cost_usd) AS cost_usd
  FROM agent_graph.llm_invocations
  WHERE task_id = wi.id::text
) li ON true
WHERE wi.routing_class IS DISTINCT FROM wi.routing_class_actual
  AND wi.routing_class_actual IS NOT NULL
ORDER BY wi.created_at DESC;

COMMENT ON VIEW agent_graph.routing_misclassifications IS
  'Surfaces work items where routing_class (predicted) differs from routing_class_actual (observed). Board uses this to tune the classifier.';


-- 008-capability-tags.sql
-- Capability tags: pre-assignment verification to prevent Figma-class failures.
-- Agents declare capabilities in agents.json; tasks declare requirements in work_items.

-- Required capabilities for a work item (set by orchestrator at task creation)
ALTER TABLE agent_graph.work_items
  ADD COLUMN IF NOT EXISTS required_capabilities TEXT[] DEFAULT '{}';

-- Capability tags on assignment rules (mirrors agents.json for DB-level queries)
ALTER TABLE agent_graph.agent_assignment_rules
  ADD COLUMN IF NOT EXISTS capability_tags TEXT[] DEFAULT '{}';

-- Function to check capability match at assignment time
CREATE OR REPLACE FUNCTION agent_graph.check_capability_match(
  p_agent_id TEXT,
  p_work_item_id UUID
) RETURNS BOOLEAN AS $$
DECLARE
  v_agent_caps TEXT[];
  v_required_caps TEXT[];
BEGIN
  -- Get agent capabilities from assignment rules
  SELECT capability_tags INTO v_agent_caps
  FROM agent_graph.agent_assignment_rules
  WHERE agent_id = p_agent_id
  LIMIT 1;

  -- Get required capabilities from work item
  SELECT required_capabilities INTO v_required_caps
  FROM agent_graph.work_items
  WHERE id = p_work_item_id;

  -- If no requirements, any agent matches
  IF v_required_caps IS NULL OR array_length(v_required_caps, 1) IS NULL THEN
    RETURN TRUE;
  END IF;

  -- If agent has no capabilities declared, fail the check
  IF v_agent_caps IS NULL OR array_length(v_agent_caps, 1) IS NULL THEN
    RETURN FALSE;
  END IF;

  -- Check: required_capabilities must be a subset of agent capability_tags
  RETURN v_required_caps <@ v_agent_caps;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION agent_graph.check_capability_match IS
  'Returns TRUE if the agent has all capabilities required by the work item. Used for pre-assignment verification.';

-- Index for capability-based queries
CREATE INDEX IF NOT EXISTS idx_work_items_required_capabilities
  ON agent_graph.work_items USING GIN (required_capabilities)
  WHERE required_capabilities != '{}';

CREATE INDEX IF NOT EXISTS idx_assignment_rules_capability_tags
  ON agent_graph.agent_assignment_rules USING GIN (capability_tags)
  WHERE capability_tags != '{}';


-- 009: Add provider column to llm_invocations for multi-provider tracking (P3 transparency)
-- Supports OpenRouter, Anthropic, and future providers.

ALTER TABLE agent_graph.llm_invocations
  ADD COLUMN IF NOT EXISTS provider TEXT DEFAULT 'anthropic';

COMMENT ON COLUMN agent_graph.llm_invocations.provider IS 'LLM provider: anthropic, openrouter, etc.';


-- 010: Board chat messages — Messenger-style per-agent chat for board members.
-- Separate from task graph (chat is UI, task graph is backend).
-- Liotta: lightweight path, Postgres history, one session at a time.

CREATE TABLE agent_graph.board_chat_messages (
  id          bigserial PRIMARY KEY,
  session_id  uuid NOT NULL,
  agent_id    text NOT NULL,
  board_user  text NOT NULL,
  role        text NOT NULL CHECK (role IN ('user', 'assistant')),
  content     text NOT NULL,
  cost_usd    numeric(10,6) DEFAULT 0,
  model       text,
  created_at  timestamptz DEFAULT now()
);

CREATE INDEX idx_board_chat_session ON agent_graph.board_chat_messages (session_id, created_at);
CREATE INDEX idx_board_chat_user_agent ON agent_graph.board_chat_messages (board_user, agent_id);


-- 011-campaigns-hotfix.sql
-- Production hotfix: 001-baseline.sql had duplicate CREATE TABLE campaigns.
-- The first definition created the table; the second (IF NOT EXISTS) was a no-op.
-- This adds columns that were only in the second definition.
-- Also fixes routing_misclassifications view (event_type → type).

-- Add missing columns
ALTER TABLE agent_graph.campaigns
  ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS content_policy JSONB DEFAULT '{}';

-- Widen campaign_mode CHECK to include 'workshop'
-- Drop old constraint, add new one
ALTER TABLE agent_graph.campaigns
  DROP CONSTRAINT IF EXISTS campaigns_campaign_mode_check;
ALTER TABLE agent_graph.campaigns
  ADD CONSTRAINT campaigns_campaign_mode_check
  CHECK (campaign_mode IN ('stateless', 'stateful', 'workshop'));

-- Fix routing_misclassifications view: event_type → type
CREATE OR REPLACE VIEW agent_graph.routing_misclassifications AS
SELECT
  wi.id AS work_item_id,
  wi.type,
  wi.routing_class AS classified_as,
  wi.routing_class_actual AS executed_as,
  wi.assigned_to,
  wi.created_at,
  li.cost_usd AS llm_cost,
  CASE
    WHEN wi.routing_class = 'DETERMINISTIC' AND wi.routing_class_actual != 'DETERMINISTIC'
      THEN 'DETERMINISTIC task hit LLM (waste)'
    WHEN wi.routing_class = 'FULL' AND wi.routing_class_actual = 'DETERMINISTIC'
      THEN 'FULL task was deterministic (over-classified)'
    WHEN wi.routing_class IS NULL AND wi.routing_class_actual IS NOT NULL
      THEN 'Unclassified task (needs routing_class)'
    ELSE 'mismatch'
  END AS mismatch_type
FROM agent_graph.work_items wi
LEFT JOIN LATERAL (
  SELECT SUM(cost_usd) AS cost_usd
  FROM agent_graph.llm_invocations
  WHERE task_id = wi.id::text
) li ON true
WHERE wi.routing_class IS DISTINCT FROM wi.routing_class_actual
  AND wi.routing_class_actual IS NOT NULL
ORDER BY wi.created_at DESC;


-- 012-campaign-promotion.sql
-- Campaign promotion system: auto-PR, auto-proposal, chaining (ADR-021 extension).
-- P1: deny by default — promotion only fires when metadata.promotion is configured.

-- Widen action_type CHECK to include 'campaign_result'
ALTER TABLE agent_graph.action_proposals
  DROP CONSTRAINT IF EXISTS action_proposals_action_type_check;
ALTER TABLE agent_graph.action_proposals
  ADD CONSTRAINT action_proposals_action_type_check
  CHECK (action_type IN (
    'email_draft', 'content_post', 'ticket_create',
    'code_fix_pr', 'feedback_receipt', 'research_report',
    'campaign_result'
  ));

-- Traceability: link proposals back to source campaign
ALTER TABLE agent_graph.action_proposals
  ADD COLUMN IF NOT EXISTS campaign_id TEXT
  REFERENCES agent_graph.campaigns(id);

CREATE INDEX IF NOT EXISTS idx_action_proposals_campaign
  ON agent_graph.action_proposals(campaign_id)
  WHERE campaign_id IS NOT NULL;


-- 013: Deterministic intake routes (triage-01 integration)
--
-- Zero-LLM-cost classification for known patterns.
-- Checked before the intake agent fires an LLM call.
-- Liotta: "The 10x move is deterministic short-circuiting."

CREATE TABLE IF NOT EXISTS inbox.deterministic_routes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_type    text NOT NULL CHECK (match_type IN (
    'sender_domain', 'sender_address', 'subject_contains', 'subject_regex', 'auto_reply'
  )),
  match_value   text NOT NULL,
  action        text NOT NULL CHECK (action IN ('archive', 'label', 'route_triage', 'route_orchestrator')),
  domain_tags   jsonb DEFAULT '[]'::jsonb,
  confidence    int DEFAULT 5 CHECK (confidence BETWEEN 1 AND 5),
  priority      int DEFAULT 100,  -- lower = checked first
  enabled       boolean DEFAULT true,
  notes         text,
  created_at    timestamptz DEFAULT now(),
  created_by    text DEFAULT 'board'
);

CREATE INDEX IF NOT EXISTS idx_deterministic_routes_enabled
  ON inbox.deterministic_routes (enabled, priority)
  WHERE enabled = true;

-- Seed common deterministic routes
INSERT INTO inbox.deterministic_routes (match_type, match_value, action, domain_tags, confidence, priority, notes) VALUES
  -- Auto-replies (regex-free pattern)
  ('auto_reply', '', 'archive', '["auto_reply"]', 5, 10, 'Out-of-office and auto-replies'),

  -- GitHub notification noise
  ('sender_domain', 'github.com', 'route_triage', '["github", "notifications"]', 4, 50, 'GitHub notifications — let triage classify'),

  -- Newsletter/marketing domains (common)
  ('sender_domain', 'mail.beehiiv.com', 'archive', '["newsletter"]', 5, 20, 'Beehiiv newsletters'),
  ('sender_domain', 'email.mg1.substack.com', 'archive', '["newsletter"]', 5, 20, 'Substack newsletters'),
  ('sender_domain', 'news.ycombinator.com', 'archive', '["newsletter"]', 5, 20, 'HN digest'),

  -- Google Workspace noise
  ('subject_contains', 'invitation:', 'route_triage', '["calendar"]', 3, 60, 'Calendar invites — may need action'),
  ('sender_address', 'noreply@google.com', 'archive', '["google", "automated"]', 5, 30, 'Google automated notifications')
ON CONFLICT DO NOTHING;

-- Agent config entry (required for guardCheck config_hash verification)
INSERT INTO agent_graph.agent_configs (id, agent_type, model, system_prompt, tools_allowed, config_hash)
VALUES (
  'executor-intake', 'executor', 'claude-haiku-4-5',
  'You are the Intake executor. You apply deterministic routing rules to incoming messages before any LLM classification occurs, reducing cost by short-circuiting known patterns (auto-replies, newsletters, GitHub noise).',
  ARRAY['task_read', 'task_update'],
  'pending-sync'
)
ON CONFLICT (id) DO NOTHING;

-- Assignment rules: orchestrator can assign to executor-intake (P2 enforcement)
INSERT INTO agent_graph.agent_assignment_rules (agent_id, can_assign)
VALUES ('orchestrator', 'executor-intake')
ON CONFLICT (agent_id, can_assign) DO NOTHING;


-- 014: Grant executor-coder access to Linear API client
-- executor-coder updates Linear issue status after completing code tasks
-- but was missing the api_client:linear permission grant.

INSERT INTO agent_graph.permission_grants
  (agent_id, resource_type, resource_name, risk_class, credential_scope, granted_by)
VALUES
  ('executor-coder', 'api_client', 'linear', 'External-Write', 'linear:write', 'migration')
ON CONFLICT (agent_id, resource_type, resource_name) DO NOTHING;



-- From 016: Claw agent configs and assignment rules
INSERT INTO agent_graph.agent_configs (id, agent_type, model, system_prompt, config_hash)
VALUES
  ('claw-workshop', 'executor', 'claude-sonnet-4-6', 'Playbook-driven workshop agent', 'migration-seed'),
  ('claw-campaigner', 'executor', 'claude-sonnet-4-6', 'Iterative campaign agent', 'migration-seed'),
  ('claw-explorer', 'executor', 'claude-sonnet-4-6', 'Exploratory research agent', 'migration-seed')
ON CONFLICT (id) DO NOTHING;

INSERT INTO agent_graph.agent_assignment_rules (agent_id, can_assign)
VALUES
  ('orchestrator', 'claw-workshop'),
  ('orchestrator', 'claw-campaigner')
ON CONFLICT (agent_id, can_assign) DO NOTHING;

-- ============================================================
-- From 002: executor-intake permission grants
-- executor-intake replaced executor-triage but was missing grants
-- ============================================================
INSERT INTO agent_graph.permission_grants (agent_id, resource_type, resource_name, risk_class, credential_scope, granted_by)
VALUES
  ('executor-intake', 'adapter', 'gmail',    'External-Read', 'gmail:readonly',    'migration'),
  ('executor-intake', 'adapter', 'outlook',  'External-Read', 'outlook:readonly',  'migration'),
  ('executor-intake', 'adapter', 'slack',    'External-Read', 'slack:read',        'migration'),
  ('executor-intake', 'adapter', 'telegram', 'External-Read', 'telegram:read',     'migration'),
  ('executor-intake', 'adapter', 'webhook',  'Internal',      NULL,                'migration'),
  ('executor-intake', 'tool', 'gmail_fetch',     'External-Read', 'gmail:readonly', 'migration'),
  ('executor-intake', 'tool', 'signal_extract',  'Internal',      NULL,             'migration'),
  ('executor-intake', 'tool', 'task_update',     'Internal',      NULL,             'migration')
ON CONFLICT DO NOTHING;

-- ============================================================
-- From 003: Agent heartbeats table for liveness tracking
-- ============================================================
CREATE TABLE IF NOT EXISTS agent_graph.agent_heartbeats (
  agent_id      TEXT PRIMARY KEY REFERENCES agent_graph.agent_configs(id),
  heartbeat_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  status        TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'processing', 'stopped')),
  pid           INTEGER
);
COMMENT ON TABLE agent_graph.agent_heartbeats IS 'Runtime heartbeat for agent liveness. Stale rows (>30s) indicate offline agents.';

-- ============================================================
-- From 004: executor-responder permission grants
-- Responder needs adapter grants to fetch email body for draft context
-- ============================================================
INSERT INTO agent_graph.permission_grants (agent_id, resource_type, resource_name, risk_class, credential_scope, granted_by)
VALUES
  ('executor-responder', 'adapter', 'gmail',    'External-Read', 'gmail:readonly',    'migration'),
  ('executor-responder', 'adapter', 'outlook',  'External-Read', 'outlook:readonly',  'migration'),
  ('executor-responder', 'adapter', 'slack',    'External-Read', 'slack:read',        'migration'),
  ('executor-responder', 'adapter', 'telegram', 'External-Read', 'telegram:read',     'migration'),
  ('executor-responder', 'adapter', 'webhook',  'Internal',      NULL,                'migration'),
  ('executor-responder', 'tool', 'draft_create',  'Internal', NULL, 'migration'),
  ('executor-responder', 'tool', 'voice_query',   'Internal', NULL, 'migration'),
  ('executor-responder', 'tool', 'gmail_fetch',   'External-Read', 'gmail:readonly', 'migration')
ON CONFLICT DO NOTHING;

