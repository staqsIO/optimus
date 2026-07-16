---
title: "Guardrail Enforcement"
section: 5
tier: core
description: "Constitutional gates, guardrail enforcement, and content sanitization"
---
## 5. Guardrail Enforcement

### Architecture: Orchestration Layer Enforces, Agents Do Not Self-Police

Per P2, the enforcement boundary is the orchestration layer — a process that is not the agent, running with different credentials, validating every action before and after execution. See §0 P1/P2 for the threat data that drove this decision.

**`guardCheck()` and `transition_state()` MUST execute as a single atomic Postgres transaction.** A gap between "guard passes" and "transition executes" creates a race condition where two agents can pass the same budget check and both spend. This is a correctness requirement, not an optimization.

```sql
-- guardCheck + transition_state as a single atomic operation
--
-- LOCK ORDERING: Always acquire budgets lock BEFORE work_items lock.
-- All code paths must follow this order to prevent deadlocks.
BEGIN;
  -- 1. Budget check: atomic UPDATE with CHECK constraint (no FOR UPDATE needed).
  --    If budget is exceeded, the UPDATE affects 0 rows → guard fails → ROLLBACK.
  UPDATE budgets
    SET spent = spent + $estimated_cost
    WHERE directive_id = $2
      AND spent + $estimated_cost <= allocation;
  -- If rows_affected = 0: budget exceeded → ROLLBACK

  -- 2. Lock the work item for state transition
  SELECT ... FROM work_items WHERE id = $1 FOR UPDATE;

  -- 3. Evaluate remaining guard conditions against locked state:
  --   actor_can_assign_to_target (explicit list, no globs)
  --   delegation_depth_within_limit
  --   data_classification_cleared
  --   tool_calls_permitted (all in allow-list, all hash-verified)
  --   no_dag_cycle (would_create_cycle check)
  --   halt_not_active
  --   valid_state_transition
  --   output_passes_adversarial_content_scan

  -- 4. Graduated escalation check (see §8):
  --   v_level := current_escalation_level('agent', $agent_id)
  --   Level 2+: force review (override review-optional rules)
  --   Level 3+: block new task claims (RAISE EXCEPTION)
  --   Level 4:  all actions blocked (agent should already be disabled,
  --             but defense-in-depth)
  -- If all pass: update state, write audit, emit event
  -- If any fail: ROLLBACK (budget UPDATE is also rolled back)
COMMIT;
```

The budget check uses an atomic `UPDATE ... WHERE` instead of `SELECT ... FOR UPDATE` followed by a separate check. This eliminates lock contention on the budget row — concurrent tasks for the same agent don't serialize on the budget lock, they race on the atomic UPDATE and the CHECK constraint guarantees correctness. If the transaction rolls back for any reason, the budget increment is also rolled back.

### Guardrail Tiers

**Organizational guardrails** (board-level, enforced on all agents):

```json
{
  "org_guardrails": {
    "max_daily_spend_usd": 100.00,
    "max_single_task_usd": 20.00,
    "no_external_communication_except_via_gateway": true,
    "no_production_deploys_without_board_approval": true,
    "data_classification_required_on_all_tasks": true,
    "halt_on_security_incident": true,
    "deny_by_default": true,
    "all_tools_must_be_hash_verified": true,
    "content_sanitization_on_all_context_loads": true
  }
}
```

**Role-level guardrails:**

| Tier | Can Delegate | Can Communicate | Can Access | Special Constraints |
|------|-------------|----------------|-----------|-------------------|
| Strategist | To any agent below | Via Gateway (Tier 2+ requires board approval) | Full task graph (read), budget tables | Must escalate to board above budget threshold |
| Architect | To orchestrators only | Internal only | Task graph (read), architecture docs | Cannot assign to executors directly |
| Orchestrator | To explicit `can_assign_to` list | Internal only | Task graph (read/write subtasks) | Max 1 task per executor at a time, must set deadline |
| Reviewer | Cannot delegate | Internal only | Task outputs (read-only) | Cannot modify outputs, 1 round of feedback then escalate |
| Executor | Cannot delegate | Reply to assigner only | Assigned task only | Hard token limit, sandboxed tool execution, cannot read other executors' work |
| Utility | Cannot delegate | Configured target only | Configured data source only | Mechanical only, no reasoning tasks |

### Content Sanitization

OpenClaw demonstrated that persistent memory creates stateful, delayed-execution attacks. Palo Alto Networks flagged that malicious payloads can be injected into memory and trigger later, across sessions. In Optimus, the task graph is the persistent memory. A compromised executor could write adversarial content to a task output that a reviewer or orchestrator later loads into its context.

Hash chains detect tampering (was this record modified after creation?). Content sanitization detects adversarial content (does this record contain injection patterns, regardless of whether it was modified?).

**Sanitization runs at context-loading time (step 4f of the runtime loop):**
1. Strip known injection patterns (prompt override attempts, system prompt references, role-play instructions) using a **versioned rule set** — not ad-hoc patterns
2. Validate structured data against expected schema
3. Truncate oversized fields to the token budget (prevents context flooding)
4. Flag anomalous content (unexpected format, unusual token patterns) for reviewer attention before the agent processes it
5. Log all sanitization actions to the audit trail

**Sanitization specification:** Implementation-defined via ADR. The spec mandates that content sanitization is infrastructure-enforced (P2), versioned, tested against adversarial inputs, and logged to the audit trail. The specific pattern categories, rule sets, update mechanisms, and testing methodology are implementation concerns that evolve faster than the spec — they are documented in the implementation ADR and operational runbooks.

**False negative acknowledgment**: This layer cannot catch everything. It is defense-in-depth, not a security boundary. The security boundary is P2 (infrastructure enforcement). When sanitization misses something, the post-check (step 6) and Tier 2 auditor catch it. The chain is: sanitization → post-check → Tier 2 daily review.

**PII-handling component requirements:** Any component touching user data must pass mandatory tests before deployment:
- (a) No PII in logs — automated scan of all log output
- (b) Data classification tagging on all fields (PUBLIC, INTERNAL, CONFIDENTIAL, RESTRICTED)
- (c) Deletion capability — GDPR right to erasure (Article 17) functional
- (d) Encryption at rest for CONFIDENTIAL and RESTRICTED fields
- Board certifies compliance until Phase 3, when the Auditor agent assumes certification authority.

This is defense-in-depth. Infrastructure constraints (P2) prevent most attacks. Content sanitization catches what infrastructure cannot — adversarial content that is structurally valid but semantically malicious.

---
