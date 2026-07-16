## 8. Audit and Observability

### Three-Tier Audit System

v0.1 relied on email archives. v0.4 uses three tiers:

**Tier 1: Deterministic (every agent cycle, no AI)**
- Constitution hash verification
- Financial rule checks (SQL queries against the ledger)
- Communication boundary enforcement
- Budget limit enforcement
- Agent creation authorization
- Merkle root computation and publication to independent ledger
- Cost: $0/month. Latency: milliseconds.
- Catches ~70% of violations.

**Tier 2: AI Auditor (daily, separate infrastructure)**
- Semantic analysis of agent prompts for constitutional alignment
- Value ratio plausibility checks
- Behavioral pattern analysis (is an agent's behavior changing?)
- **Behavioral drift detection:** Monitor output distribution patterns for each agent independent of prompt changes. If a model provider ships a silent update (e.g., Anthropic updates Sonnet), an agent's output characteristics may shift even though the prompt hasn't changed. Tier 2 maintains rolling statistical baselines per agent — output length distributions, tool invocation frequency, task completion time, rejection rate. Deviations beyond 2σ from baseline trigger a flag to the board. This catches what prompt drift monitoring (Article 4.2a) cannot: behavioral changes caused by external model updates.
- **Guardrail health check:** Periodically review all org, role, and task-level guardrails for internal consistency and currency. Detects "guardrail drift" — constraints that have become stale (e.g., `can_assign_to` lists referencing deactivated agents), conflicting (e.g., budget limits at org level that are lower than role-level minimums), or redundant. Reports findings to board with specific remediation recommendations. Inspired by Qodo's "rule decay" detection pattern.
- Constitutional edge case evaluation
- Runs on separate infrastructure, different cloud account, different database
- No inbound path from organizational agents
- Cost: ~$50-80/month

**Tier 3: Cross-Model Audit (weekly, different provider)**
- Same logs as Tier 2, processed by a different model from a different provider
- Divergences between Tier 2 and Tier 3 findings are flagged to the board/creator
- Eliminates single-provider blind spots
- Cost: ~$20-30/month

### Observability (Phase 1 Requirement)

Every state transition emits a structured event:

```json
{
  "event_id": "evt_2026022615302001",
  "task_id": "TASK-0042",
  "agent_id": "orchestrator-eng",
  "config_hash": "sha256:a1b2c3...",
  "model_id": "claude-sonnet-4-5-20250514",
  "action": "transition_state",
  "from_state": "in_progress",
  "to_state": "completed",
  "tokens_in": 3200,
  "tokens_out": 1100,
  "cost_usd": 0.014,
  "latency_ms": 2340,
  "guardrail_checks": {
    "budget_ok": true,
    "classification_ok": true,
    "delegation_depth_ok": true,
    "content_sanitization_flags": 0
  },
  "data_classification": "INTERNAL",
  "timestamp": "2026-02-26T15:30:20.001Z"
}
```

**Dashboard (board-facing):**
- Task funnel (directive → workstream → task → completion)
- Cost by tier, by model, by department
- Agent utilization (active vs idle time)
- P50/P95/P99 latency per tier
- Active DAG visualization
- Budget burn rate vs projection
- HALT status
- Content sanitization flag rate
- Tool integrity check failures

**Per-user operational views (AutoBot-Inbox, Phase 1):**

For multi-user deployments, five SQL views provide per-user pipeline health. These reference the autobot-inbox product schema (`inbox.*`, `voice.*`) in addition to `agent_graph.*`. All are regular views except `v_p95_latency_by_user` which should be materialized or time-windowed at scale:

| View | Source Tables | What It Shows |
|------|-------------|---------------|
| `v_cost_per_email_by_user` | `agent_graph.llm_invocations` + `inbox.messages` | Total LLM spend per processed email, grouped by user |
| `v_triage_accuracy_by_user` | `inbox.messages` (triage_category) + `inbox.triage_overrides` | % of triage decisions the user accepted without override |
| `v_draft_acceptance_by_user` | `inbox.drafts` + `voice.edit_deltas` | Draft approval rate and mean edit distance per user |
| `v_p95_latency_by_user` | `agent_graph.state_transitions` (trailing 30 days) | P95 end-to-end latency from email arrival to draft ready, per user |
| `v_escalation_rate_by_user` | `agent_graph.state_transitions` + `agent_graph.threat_memory` | % of emails requiring human intervention (guardrail violations, review exhaustion, HALT triggers) |

**Event digests (pushed to board via preferred channels):**
- Daily brief: what happened, what's in progress, any issues
- Weekly detailed: completed tasks, costs, decisions made, risks identified
- On-event: immediate escalation for guardrail violations, budget overruns, agent failures, sanitization flags

### Threat Detection Memory

An append-only log with scope dimensions and threat classification that feeds graduated escalation. Every security-relevant event detected by sanitization (§5 step 4f), output post-check (§4 step 6), Tier 1/2 auditor, tool integrity layer (§6), or Communication Gateway (§7) writes to this table.

```
agent_graph.threat_memory
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text
  detected_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  source_type   TEXT NOT NULL CHECK (source_type IN (
                  'sanitization', 'post_check', 'tier1_audit', 'tier2_audit',
                  'tool_integrity', 'gateway_inbound'))
  scope_type    TEXT NOT NULL CHECK (scope_type IN (
                  'agent', 'task', 'workstream', 'tool', 'inbound_channel'))
  scope_id      TEXT NOT NULL    -- the specific agent_id, task_id, tool_hash, etc.
  threat_class  TEXT NOT NULL CHECK (threat_class IN (
                  'INJECTION_ATTEMPT', 'EXFILTRATION_PROBE', 'RESOURCE_ABUSE',
                  'SCHEMA_VIOLATION', 'BEHAVIORAL_ANOMALY', 'INTEGRITY_FAILURE',
                  'POLICY_VIOLATION', 'UNKNOWN_PATTERN'))
  severity      TEXT NOT NULL CHECK (severity IN (
                  'INFORMATIONAL', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'))
  detail_json   JSONB NOT NULL   -- matched pattern, input excerpt, confidence, context
  prev_hash     TEXT             -- SHA-256 hash chain (same pattern as state_transitions)
  resolved      BOOLEAN NOT NULL DEFAULT false
  resolved_by   TEXT             -- agent_id, 'board', or 'auto_decay'
                                 -- auto_decay: Tier 1 resolves LOW/MEDIUM events with no
                                 --   new events in scope for 24h. HIGH/CRITICAL never auto-decay.
  resolved_at   TIMESTAMPTZ

  -- Append-only: trigger prevents UPDATE/DELETE (except resolved flag via resolve_threat())
  -- REVOKE TRUNCATE, DROP, ALTER from application roles
  -- Hash chain: verify_threat_memory_chain() for tamper detection
  -- Indexes: (scope_type, scope_id, detected_at DESC) for escalation queries
  --          (resolved, severity, detected_at DESC) WHERE resolved = false
```

**Threat classification** uses standard security terminology (not biological naming — P4):

| Class | Description | Default Severity |
|-------|-------------|-----------------|
| `INJECTION_ATTEMPT` | Input designed to override agent instructions | HIGH |
| `EXFILTRATION_PROBE` | Output or tool use attempting to leak data | HIGH |
| `RESOURCE_ABUSE` | Excessive or anomalous resource consumption | MEDIUM |
| `SCHEMA_VIOLATION` | Output that fails structural validation | LOW |
| `BEHAVIORAL_ANOMALY` | Statistical deviation from agent baseline (extends Tier 2 drift detection) | MEDIUM |
| `INTEGRITY_FAILURE` | Hash verification or chain-of-custody failure | CRITICAL |
| `POLICY_VIOLATION` | Guardrail violation that isn't adversarial (budget overrun, unauthorized delegation) | MEDIUM |
| `UNKNOWN_PATTERN` | Anomaly that doesn't match known classes | LOW |

### Graduated Escalation

The current architecture has two threat responses: the Reviewer quarantines an output (§5), or the entire system HALTs (§9). Graduated escalation fills the gap with four intermediate levels, each enforced by infrastructure (P2), not agent judgment.

`current_escalation_level(scope_type, scope_id)` computes a weighted count of unresolved threat events within a configurable time window. Per-severity weights (e.g., INFORMATIONAL=0, LOW=0.5, MEDIUM=1, HIGH=3, CRITICAL=10) convert raw event counts into a single score. The score is compared against threshold levels configured in `tolerance_config`.

| Level | Name | Actions (infrastructure-enforced) | De-escalation |
|-------|------|---------------------------------|---------------|
| **0** | Normal | Standard processing | — |
| **1** | Heightened monitoring | Increase Tier 1 check frequency for scope. Load threat context into Reviewer prompts. Log escalation to event stream. | Automatic when weighted count drops below threshold for 30 min |
| **2** | Restrict and alert | Level 1 + force all tasks in scope through Reviewer (override review-optional rules). Reduce agent tool access to read-only subset. Board notified via event digest. | Board approval or automatic after sustained drop (2 hours below L1 threshold) |
| **3** | Isolate and investigate | Level 2 + agent cannot claim new tasks. Orchestrator reassigns queued work. Board notified immediately (push, not digest). Tier 2 runs targeted analysis on scope. | Board approval required |
| **4** | Scoped HALT | Revoke JWT and disable database role for the specific agent (same mechanism as §9 step 5, narrower scope). All in-progress tasks transition to `failed` (state_transitions.reason: `'security_halt'`). Full Tier 2 + Tier 3 audit triggered. | Board approval + shadow mode re-entry (trust level resets to Level 1 per §11) |

**Relationship to §9:** Graduated escalation handles localized threats (one agent, one workstream). The §9 HALT protocol remains the system-wide emergency stop for systemic threats or board-initiated shutdowns. Level 4 is a scoped HALT — it isolates one agent, not the whole system.

**Tolerance configuration** (`tolerance_config` table) is board-managed (P2), not agent-controlled:

```
agent_graph.tolerance_config
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text
  threat_class    TEXT NOT NULL     -- matches threat_memory.threat_class CHECK values
  scope_type      TEXT NOT NULL     -- 'org', 'role', 'agent', 'tool', 'channel'
  scope_id        TEXT              -- NULL = applies to all in scope_type
  window_minutes  INTEGER NOT NULL DEFAULT 60
  level_1_threshold INTEGER NOT NULL  -- → heightened monitoring
  level_2_threshold INTEGER NOT NULL  -- → restrict + alert
  level_3_threshold INTEGER NOT NULL  -- → isolate + investigate
  level_4_threshold INTEGER NOT NULL  -- → scoped HALT
  severity_weights  JSONB NOT NULL DEFAULT '{"INFORMATIONAL":0,"LOW":0.5,"MEDIUM":1,"HIGH":3,"CRITICAL":10}'
  created_by      TEXT NOT NULL     -- must be 'board' for org/role scope
  config_hash     TEXT NOT NULL     -- content-addressed, stamped on audit trail
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()

  UNIQUE (threat_class, scope_type, scope_id)
  -- NOT append-only: board-managed configuration, updated as operational data informs tuning
  -- Default thresholds provided at Phase 1 deployment, tuned based on threat_memory data
```

**Tier 1 additions:** `threat_memory` event count and escalation level per agent/workstream added to every-cycle deterministic checks. Escalation level changes emit structured events.

**Tier 2 additions:** Daily reclassification review (e.g., a `SCHEMA_VIOLATION` that in context was `INJECTION_ATTEMPT`). Cross-scope correlation analysis (multiple agents in the same workstream accumulating low-severity events simultaneously). Tolerance effectiveness review (are thresholds too sensitive or too lax?).

### Pathway Analytical Views (Framework-Level)

Four views over `work_items`, `llm_invocations`, and `state_transitions` measure routing effectiveness (P5). These are framework-level views (applicable to any Optimus product), distinct from the per-user product views above.

| View | What It Measures |
|------|-----------------|
| `v_routing_class_effectiveness` | Misclassification rate by task type — initial `routing_class` vs `routing_class_final`, with avg cost and latency. Identifies task types where the Orchestrator's heuristic consistently miscategorizes. |
| `v_context_block_correlation` | Context blocks loaded (from `context_profile_json`) vs task outcome, grouped by task type and routing class. Identifies context blocks that don't improve success rate — candidates for removal to reduce token cost. |
| `v_cost_per_task_type_trend` | Weekly average cost, token count, and latency per task type. The key metric: are these trending downward for mature task types? If not, routing or context strategy needs adjustment. |
| `v_agent_efficiency_comparison` | Per-agent cost and success rate for the same task type. Identifies whether specific agents are consistently cheaper or more expensive than peers. |

All four views are time-windowed (trailing 30 days default). At Phase 1 volumes (~300 tasks/day), these execute in single-digit milliseconds against indexed tables. If volume scales to require denormalization, a materialized view or dedicated table can be added as an implementation optimization.
