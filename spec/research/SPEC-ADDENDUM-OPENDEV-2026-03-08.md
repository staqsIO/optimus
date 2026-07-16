# SPEC Addendum — OpenDev Paper Findings (arXiv 2603.05344)

> **Target spec version:** v0.7.1
> **Addendum created:** 2026-03-08
> **Source:** Gap analysis of "Building AI Coding Agents for the Terminal: Scaffolding, Harness, Context Engineering, and Lessons Learned" (Nghi D. Q. Bui, OpenDev)
> **Status:** ACCUMULATING
> **How to use:** Each section references the spec section it modifies. When ready to merge, apply each section to the corresponding location in SPEC.md. These three entries are independent — they can be merged individually or as a batch.

---

## Change Log

| Date | Section | Summary |
|------|---------|---------|
| 2026-03-08 | §4 Runtime Loop (AMEND) | Add progressive context compaction stages with trigger thresholds |
| 2026-03-08 | §4 Runtime Loop (AMEND) | Add event-driven system reminders for instruction fade-out |
| 2026-03-08 | §11 Failure Modes (AMEND) | Add doom-loop detection for repeated identical failing actions |

---

## §4 Agent Runtime — Progressive Context Compaction (AMEND)

> **Source:** OpenDev paper §2.3.6 (Adaptive Context Compaction), gap analysis session 2026-03-08
> **Spec section affected:** §4, Context Window Management (paragraph beginning "Compaction: When an agent's historical context exceeds its token budget...")
> **Change type:** AMEND — extends existing compaction description with concrete stages and trigger thresholds

### Current Spec Text

The spec states: "When an agent's historical context exceeds its token budget, older task summaries are compressed by a deterministic summarization pass (a utility agent on the smallest model). The full records remain in the database; only the context window representation is compacted."

This describes *what* happens but not *when* or *how aggressively*. An executor at 95% context budget needs a different compaction strategy than one at 60%.

### Proposed Amendment

Add after the existing compaction paragraph in §4 Context Window Management:

**Progressive compaction stages:** Compaction is triggered by token utilization thresholds, not by budget exhaustion. The orchestration layer evaluates context pressure at step 4 (context loading) of every agent cycle and applies the appropriate stage:

| Stage | Trigger | Strategy | What's Preserved |
|-------|---------|----------|-----------------|
| **0 — Normal** | < 60% of `max_context_tokens_per_task` | No compaction | Everything |
| **1 — Trim** | 60-74% | Summarize tool outputs older than 3 cycles. Replace raw outputs with structured summaries (tool name, result type, key values). | Current task details, recent tool results, all Q1 context |
| **2 — Compress** | 75-84% | Stage 1 + compress sibling task statuses to one-line-each. Collapse parent summary to title + acceptance criteria only. | Current task, most recent tool result, Q1 context, compressed parent |
| **3 — Aggressive** | 85-94% | Stage 2 + remove all prior work search results. Compress agent identity to role + current constraints only. | Current task details, Q1 acceptance criteria, active guardrails |
| **4 — Emergency** | ≥ 95% | Stage 3 + compress current task to acceptance criteria only. Flag to orchestration layer that context pressure is critical. | Acceptance criteria, active guardrails, most recent tool output |

Stage transitions are logged to `context_profile_json` on the work item (existing field from §3 pathway instrumentation). Each compaction event records: stage applied, tokens before, tokens after, content categories removed. This feeds `v_context_block_correlation` for Phase 2 analysis.

**Key constraint:** Q1 content (board-authored directives, acceptance criteria) is never compacted at any stage. Stages 1-3 compact Q4 → Q3 → Q2 content in the same priority order as the existing data quality tier truncation rule. Stage 4 compacts Q1 structure (task description prose) but preserves Q1 acceptance criteria.

**Implementation note:** Stages 0-3 are deterministic transformations — no LLM call required. Stage 4's task compression may use the utility agent for summarization. The cost impact of compaction itself is effectively zero for stages 0-3 and < $0.001 per invocation for Stage 4.

### Phase Activation

Phase 1 — implement alongside context loading in the orchestration layer. Stages 0-2 are sufficient for Phase 1 (executor tasks at 4,000 tokens rarely need aggressive compaction). Stages 3-4 activated when measurement data shows tasks routinely hitting 85%+ utilization.

### Measurement (P5)

- Track stage distribution per agent tier — what percentage of cycles hit each stage
- If Stage 3+ triggers exceed 10% of executor cycles, the `max_context_tokens_per_task` budget may need adjustment
- `v_context_block_correlation` should show: does task success rate hold steady through Stages 0-2? If it drops at Stage 2, the compression is too aggressive

### Ecosystem References

| Source | Key Takeaway | Applicability |
|--------|-------------|---------------|
| OpenDev §2.3.6 (Adaptive Context Compaction) | Progressive stages triggered by token pressure thresholds; 5-stage system in production | Direct — production-validated approach for terminal-native agent |
| AgentDiet (arxiv 2509.23586) | 40-60% input token reduction with no performance loss via removing useless/redundant/expired context | Validates aggressive pruning at higher stages |
| Prompt Compression Survey (NAACL 2025) | Extractive compression preserves structure; token pruning corrupts code/SQL | Informs decision: stages 0-3 use extractive/structural transforms, not token pruning |

---

## §4 Agent Runtime — Event-Driven System Reminders (AMEND)

> **Source:** OpenDev paper §2.3.4 (Context-Aware System Reminders), gap analysis session 2026-03-08
> **Spec section affected:** §4, Agent Runtime Loop (between steps 4 and 5, or integrated into step 4f)
> **Change type:** AMEND — adds a new mechanism to the runtime loop for combating instruction fade-out

### Problem

LLMs demonstrably lose adherence to system prompt instructions as conversation length increases — a well-documented phenomenon called "instruction fade-out" or the "Lost in the Middle" attention degradation pattern. For executor agents on multi-step tasks (the longest per-agent sessions in Optimus), this means guardrail compliance and behavioral accuracy drift over time, independent of prompt quality.

The current spec loads agent identity and guardrails once at step 4a/4e. There is no mechanism for re-injecting critical behavioral guidance mid-session when specific conditions arise.

### Proposed Amendment

Add to §4 Runtime Loop, as a new sub-step between 4f (SANITIZE) and 5 (EXECUTE):

**4g. SYSTEM REMINDER INJECTION (orchestration layer, not agent):**

The orchestration layer evaluates a set of **event detectors** against the current task state before each execution step. When a detector fires, a targeted reminder is injected into the agent's context for that cycle only. Reminders are ephemeral — they do not persist in the conversation history and do not consume permanent context budget.

**Phase 1 reminder catalog (minimum viable set):**

| Detector | Condition | Reminder |
|----------|-----------|---------|
| Stale-read | Agent's next action is a write operation on a resource not loaded in current context window | "You are about to modify a resource you haven't read in this session. Read the current state before editing." |
| Unchecked-output | Agent has completed 3+ tool calls without validating results against acceptance criteria | "Review your outputs against the task's acceptance criteria before continuing." |
| Budget-pressure | Agent has consumed > 70% of `max_budget_per_task_usd` | "You have used [X]% of the task budget. Prioritize completing the acceptance criteria over additional refinement." |
| Escalation-scope | Current task has `data_classification` ≥ CONFIDENTIAL | "This task involves confidential data. Verify that your output does not contain information beyond the task's data classification scope." |

**Architecture constraints (P2):**
- Detectors and reminders are defined by the orchestration layer configuration, not by agents. Agents cannot add, modify, or suppress reminders.
- Reminder content is deterministic (templated), not LLM-generated. No LLM call for reminder injection.
- Reminder injection is logged in `context_profile_json` (detector name, reminder text hash) for effectiveness measurement.
- Reminders are injected as the final context block before execution (recency bias ensures highest attention weight).

**Relationship to existing guardrails:** System reminders are defense-in-depth supplements to the pre-check (step 3) and post-check (step 6). Pre-checks enforce hard constraints (budget exceeded → block). Reminders enforce soft guidance (budget pressure → advise restraint). Post-checks validate outputs. The three layers address different failure modes: pre-checks catch unauthorized actions, reminders prevent avoidable mistakes, post-checks catch output quality issues.

### Phase Activation

Phase 1 — implement the four detectors above alongside the runtime loop. The reminder catalog is expected to grow based on Phase 1 failure pattern data. New detectors are added by board configuration, not agent request.

### Measurement (P5)

- Track detector fire rate per agent tier — which reminders fire most frequently?
- Correlate reminder injection with task success rate — do tasks with reminders succeed more often?
- Track "reminder followed" rate: when stale-read fires, does the agent actually read before editing? (Measurable via subsequent tool invocation log)
- If a reminder fires on > 50% of cycles for an agent tier, the underlying issue should be addressed structurally (e.g., fix the context loading order) rather than relying on reminders as a permanent crutch

### Ecosystem References

| Source | Key Takeaway | Applicability |
|--------|-------------|---------------|
| OpenDev §2.3.4 (Context-Aware System Reminders) | Event-driven behavioral guidance injected at decision points; production-validated approach to instruction fade-out | Direct — pattern adopted for Optimus agent runtime |
| "Lost in the Middle" (Liu et al., 2023) | LLMs attend to beginning and end of context, with significant degradation in the middle | Informs reminder placement: inject as final context block for recency bias |
| OpenDev §3.2 (Steering Behavior Over Long Horizons) | Explicit decision trees in prompts outperform implicit behavioral instructions for tool selection | Supports structured, templated reminders over general behavioral instructions |

---

## §11 Failure Modes — Doom-Loop Detection (AMEND)

> **Source:** OpenDev paper §2.2.6 Phase 3 (doom-loop detection), gap analysis session 2026-03-08
> **Spec section affected:** §11, Failure Modes table (row: "Garbage output") and §4 Runtime Loop step 6 (post-check)
> **Change type:** AMEND — adds a detection mechanism to existing retry logic

### Problem

The spec's retry mechanism (§11: `failed → assigned`, max 3 retries) counts failures but does not detect whether each retry attempt is substantively different from the last. An executor that encounters a compilation error, retries with identical code, encounters the identical error, and retries again will exhaust its retry budget having never attempted a different approach. This burns budget ($0.024 × 3 = $0.072 wasted) and delays task completion without improving outcomes.

The §4 Automated Reaction Loop (CI failure reaction) addresses this partially by loading `failure_context` into retried tasks, but does not detect when the agent ignores that context and repeats the same approach.

### Proposed Amendment

Add to §11 Failure Modes table, as a new row after "Garbage output":

| Failure | Detection | Response | Recovery |
|---------|-----------|----------|----------|
| Doom loop | Orchestration layer hashes `(tool_name, input_content_hash, failure_type)` per task. 3+ consecutive matches = doom loop. | Halt retry cycle. Inject structured intervention: prior failure summary + explicit directive to change approach. | If intervention succeeds → normal flow. If next attempt also matches hash → escalate to Reviewer with full loop history. Count intervention as 1 of max 3 retries. |

**Detection mechanism (add to §4, step 6 post-check):**

After each tool invocation failure, the orchestration layer computes a content-addressed hash of the triple `(tool_name, truncated_input_hash, failure_category)`. The `truncated_input_hash` uses the first 2,000 characters of the tool input to avoid false negatives from minor whitespace differences while catching substantively identical inputs.

If 3 consecutive invocations within the same task produce matching hashes:
1. The orchestration layer flags the task as `doom_loop_detected` (logged to `state_transitions.reason`)
2. A structured intervention is injected into the agent's context: all accumulated failure details + an explicit directive: "Your previous N attempts used the same approach and produced the same failure. You must try a fundamentally different strategy."
3. If the next attempt also matches the hash, the task transitions to `failed` with reason `doom_loop_unresolved` and escalates to the Reviewer with the complete loop history attached as Q2-tier context

**Relationship to existing mechanisms:**
- Doom-loop detection supplements, not replaces, the existing max-3-retry limit
- A doom-loop intervention counts as one retry attempt. An agent can have at most 1 doom-loop intervention before escalation (attempt 1 → fail, attempt 2 → fail, attempt 3 → doom-loop detected → intervention → attempt 4 → if same hash → escalate)
- Doom-loop events are written to `threat_memory` as `BEHAVIORAL_ANOMALY` / `LOW` severity. Repeated doom-loops by the same agent feed the graduated escalation system (§8)

### Phase Activation

Phase 1 — implement alongside the orchestration layer's post-check (step 6). The hashing mechanism is trivial (SHA-256 of concatenated fields). The intervention template is a static string. Zero additional LLM cost.

### Measurement (P5)

- Track doom-loop detection rate per agent tier and per task type
- If doom-loop rate exceeds 5% for any task type, investigate: is the task type underspecified? Is the executor model inadequate for this task complexity? Should the routing class be escalated?
- Track intervention success rate — what percentage of doom-loop interventions result in a different approach on the next attempt?
- Feed into `v_agent_efficiency_comparison`: agents with high doom-loop rates may need config adjustment or model upgrade

### Ecosystem References

| Source | Key Takeaway | Applicability |
|--------|-------------|---------------|
| OpenDev §2.2.6 Phase 3 (doom-loop detection) | Hash-based detection of repeated identical actions; production-validated in interactive coding agent | Direct — pattern adopted for Optimus executor retry logic |
| ComposioHQ/agent-orchestrator (CI failure reaction loops) | Automated feedback loops where failure context is structured and loaded into retry context | Validates §4 Automated Reaction Loop; doom-loop detection extends it |

---

## Merge Checklist

- [ ] Board reviewed all three entries
- [ ] No contradictions with existing SPEC-ADDENDUM entries (context optimization §4.4, TOON §4.5, three-build ladder §14.2, etc.)
- [ ] Progressive compaction stages are consistent with existing Q1-Q4 data quality tiers
- [ ] System reminders are consistent with P2 (infrastructure enforces, prompts advise)
- [ ] Doom-loop detection is consistent with existing retry logic (§11) and graduated escalation (§8)
- [ ] Version bump: v0.7.0 → v0.7.1 (PATCH — additive amendments, no breaking changes)
- [ ] CHANGELOG.md updated with all three entries
