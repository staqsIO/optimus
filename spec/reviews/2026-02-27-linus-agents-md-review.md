# Review: PR #8 — agents.md Definitions for Phase 1 Roster

**Reviewer:** Linus (Architecture)
**Date:** 2026-02-27
**PR:** https://github.com/staqsIO/autobot-spec/pull/8
**Branch:** `dustin/agents-md-definitions`
**Files reviewed:**
- `agents/AGENTS.md`
- `agents/strategist.md`
- `agents/architect.md`
- `agents/executor-01.md`
- `agents/reviewer-backend.md`

**Spec version:** v0.6.1
**Sections cross-referenced:** 0 (Design Principles), 2 (Agent Tiers), 3 (Task Graph / Routing), 4 (Agent Runtime / Config / Context), 5 (Guardrail Enforcement), 6 (Tool Integrity), 14 (Phased Execution), 14.1 (Source Control), 15 (Cost Model)

---

## 1. Overall Assessment

**NEEDS WORK.** The definitions are structurally sound and demonstrate a clear understanding of the spec's enforcement model. The root `AGENTS.md` is genuinely good -- it correctly restates P2 (infrastructure enforces, prompts advise), has sensible code standards, and maintains the right relationship to the spec (spec wins on conflict). The per-agent files are well-organized with useful anti-patterns.

But there are real problems. The most critical Phase 1 agent -- the Orchestrator -- is missing entirely, and its absence leaves a gap that makes the other four definitions incomplete in ways their authors may not have noticed. There are security-relevant tool list omissions. There are spec contradictions in cost figures and context budgets. And some definitions over-specify Phase 1 behavior in ways that will create confusion when the compiled JSON config is the actual enforcement boundary.

This is good work that needs a second pass, not a rejection. Fix the blockers, ship the Orchestrator definition, and this is ready.

---

## 2. Critical Issues (Blockers)

### C1. The Orchestrator Is Missing

The spec (14, Phase 1) says: "5 agents: Strategist, Architect, Orchestrator, Reviewer, Executor." The PR delivers 4 of 5. The Orchestrator is the central dispatch agent -- it decomposes directives into tasks, assigns work to executors and reviewers, manages deadlines, handles retries, coordinates conflict avoidance, and creates release PRs. Without `orchestrator-eng.md`, the delegation chains in every other file point at a phantom.

`strategist.md` says `can_assign_to: architect, orchestrator-eng, orchestrator-product`. `architect.md` says `can_assign_to: orchestrator-eng, orchestrator-product`. `executor-01.md` says `reports_to: Orchestrator (orchestrator-eng)`. `reviewer-backend.md` says `reports_to: Orchestrator (orchestrator-eng)`. Every agent references an entity that this PR does not define.

This is not a "nice to have later" situation. The Orchestrator is the most operationally complex Phase 1 agent. Its definition is the one most likely to have spec contradictions, tool list gaps, and delegation edge cases. It needs the most review time, and it is the one that was omitted. Detailed requirements for `orchestrator-eng.md` are in Section 6 below.

**Required action:** Add `agents/orchestrator-eng.md` to this PR before merge.

### C2. Strategist Cost Target Is Wrong

`strategist.md` states:

> Cost target: ~$0.43 per decision (8K input + 4K output at Opus pricing)

The spec (15, Cost Model) shows Opus pricing at $15/MTok input and $75/MTok output. Doing the arithmetic: (8,000 * $15 / 1,000,000) + (4,000 * $75 / 1,000,000) = $0.12 + $0.30 = $0.42. That is close enough to $0.43 -- fine.

But the spec (4, Context Window Management, cost targets table) states the Strategist's max cost per task is **$0.12**. The $0.12 figure only accounts for input tokens. The $0.43 figure accounts for input + output. The spec's own table is inconsistent with the cost model in 15, and the `strategist.md` file picked the 15 number.

This matters because the budget guardrail (`max_budget_per_task: $20.00`) will be validated against *actual* costs from `llm_invocations`. If the cost target in the definition is wrong by 3.5x relative to what the spec's context management table says, someone is going to get confused when reconciling actuals against targets.

**Required action:** Reconcile the cost target with the spec. The $0.43 arithmetic is correct for input + output; the spec's 4 table is the one that is wrong (it only counts input). File a spec fix alongside this PR, or add a note in the agent definition that explicitly states the spec table omits output costs and the $0.43 figure is the corrected value.

### C3. Strategist Has `query_llm_invocations` but Spec Says Nothing About This

`strategist.md` includes `query_llm_invocations` in its allowed tools list:

> query_llm_invocations -- read cost data for financial analysis

The spec's agent tier table (2) says the Strategist can "approve budgets" and has "Full task graph read" -- but `llm_invocations` is a separate table from the task graph. The spec's example Orchestrator config (4) does not include this tool. No other agent definition references it.

This is not necessarily wrong -- the Strategist performing financial analysis on cost data is reasonable. But it is an expansion of scope that is not traceable to a spec section. Per P1 (deny by default), a tool that is not explicitly granted should not exist.

**Required action:** Either cite the spec section that authorizes this tool, or remove it and add a budget status query through the already-defined `query_budget_status` (which reads `v_budget_status` and is authorized). If you want the Strategist to read raw invocation data, propose a spec amendment.

### C4. Architect's `create_subtask` Tool Creates a Delegation Ambiguity

`architect.md` includes:

> create_subtask -- create architecture review tasks (routed to orchestrators)

The spec's tier table (2) says the Architect "Cannot assign tasks to executors directly (routes through orchestrator)." The definition tries to honor this by routing subtask creation through orchestrators. But the `create_subtask` tool, if it literally creates a subtask in the task graph, is an assignment action. The spec's Orchestrator config example (4) shows `create_subtask` in the Orchestrator's tool list. The Architect's tool list in the spec example does not include `create_subtask`.

If the Architect can create subtasks, even ones "routed to orchestrators," it can potentially create work items that circumvent the Orchestrator's dispatch logic, deadline tracking, and budget allocation. The description says "routed to orchestrators" but there is no infrastructure mechanism described that enforces this routing. It is a prompt-level constraint, which violates P2.

**Required action:** Remove `create_subtask` from the Architect's tool list. The Architect should request work through the Orchestrator, not create subtasks independently. If the Architect needs to create architecture review tasks, it should use a tool like `request_review` or `propose_task` that the Orchestrator then processes through normal dispatch. Alternatively, if the spec intends the Architect to create subtasks, add the infrastructure constraint that enforces Orchestrator routing.

---

## 3. Code Quality Issues (Should Fix)

### Q1. Strategist Context Budget Contradicts Spec

`strategist.md` states:

> Max context per task: 8,000 tokens

The spec (4, cost targets table) says Strategist max context per task is also 8,000 tokens. This is consistent. But the Strategist's cost target description then says:

> Use it to maintain coherence across multi-month product builds. When evaluating a decision in week 12, query `strategic_decisions` for all dependent decisions -- see structured rationale, not compressed summaries.

An 8,000-token context budget that includes agent identity (~500 tokens), task details (~200-1,000 tokens), parent summary (~200-500 tokens), sibling statuses (~100-300 tokens), and guardrails (~300 tokens) leaves roughly 5,500-6,700 tokens for "full task graph read access" and "semantic search over completed work." The claim that the Strategist can "see structured rationale, not compressed summaries" across months of decisions within this budget is aspirational, not realistic. At 12 weeks with 10-15 decisions/day, that is 840-1,260 decisions. Even at 10 tokens per decision summary, that exceeds the budget.

This is not a blocker, but it sets false expectations for what the agent can actually do within its context budget. The definition should be honest about context constraints rather than implying unlimited historical visibility.

**Suggested fix:** Replace the aspirational language with something like: "Query `strategic_decisions` for dependent decisions. Context budget forces summarization of older decisions -- the full records remain in the database for audit, but your working context is constrained."

### Q2. Reviewer Context Budget Contradicts Spec

`reviewer-backend.md` states:

> Max context per task: 4,000 tokens

The spec (4, cost targets table) confirms 4,000 tokens for Reviewer. But the definition then says:

> Cost target: ~$0.012 per task

The spec says Reviewer cost target is $0.012. This is consistent. However, the definition also says:

> Max tool invocations per task: 5

The spec's Orchestrator config (4, guardrails) shows `max_tool_invocations_per_task: 10` for the Orchestrator. There is no spec-level definition of max tool invocations per tier. This means the number 5 for the Reviewer is invented here without spec backing. It may be reasonable, but it should either be traced to a spec section or flagged as a new constraint being proposed.

**Suggested fix:** Add a comment or note that this is a proposed constraint, or file a spec addition that defines max tool invocations per tier.

### Q3. `orchestrator-product` Referenced but Undefined

Multiple definitions reference `orchestrator-product`:
- `strategist.md` can_assign_to includes `orchestrator-product`
- `architect.md` can_assign_to includes `orchestrator-product`
- `architect.md` peers includes `orchestrator-product`

But the spec's Phase 1 roster (14) lists exactly 5 agents: Strategist, Architect, Orchestrator (singular), Reviewer, Executor. There is no `orchestrator-product` in Phase 1. The task routing table (3) does show `orchestrator-product` as a routing target, but this appears to be a Phase 2+ expansion.

Including `orchestrator-product` in Phase 1 `can_assign_to` lists means the compiled JSON configs will reference a non-existent agent. Depending on how `guardCheck()` validates delegation targets, this could either silently fail (bad) or hard-error on every attempt to delegate to product work (also bad, but at least visible).

**Suggested fix:** Remove `orchestrator-product` from all `can_assign_to` and `peers` lists in Phase 1 definitions. Add it when the agent actually exists. Deny by default (P1) means you do not pre-authorize delegation to agents that do not exist yet.

### Q4. Executor Timeout Does Not Match Spec

`executor-01.md` states:

> Timeout: 5 minutes per task

The spec (9, Kill Switch / Recovery) states:

> Task timeout | Configurable per tier (Executor: 5min, Orchestrator: 15min, Strategist: 30min)

This is consistent. Good. But the definition also says:

> Max retries: 3 (on 4th failure, task is terminal and escalates to Orchestrator)

The spec (3, state machine) says:

> failed --> assigned (retry, max 3)
> on 4th failure, `failed` is terminal and escalates to supervisor

"Escalates to supervisor" in the spec is generic; the definition says "escalates to Orchestrator" which is correct for Executor. This is fine -- just noting the trace for completeness.

### Q5. AGENTS.md References `orchestrator-eng.md` in Directory Listing but PR Does Not Include It

The root `AGENTS.md` shows in the repository structure:

```
agents/
  |- strategist.md
  |- architect.md
  |- orchestrator-eng.md
  |- reviewer-backend.md
  |- executor-01.md
```

This is the directory listing claiming `orchestrator-eng.md` exists. The PR does not include it. This is a documentation lie. Either add the file or remove it from the listing.

**Suggested fix:** Same as C1 -- add the file.

### Q6. Architect Definition Missing `read_file` Scope Constraint

`architect.md` includes:

> read_file -- read architecture docs, schema definitions, agent configs

But the Architect's data classification clearance is `PUBLIC, INTERNAL, CONFIDENTIAL` (no `RESTRICTED`). The `read_file` tool as described has no scope constraint -- it just says "read architecture docs, schema definitions, agent configs." The compiled JSON config presumably adds file-path restrictions, but the human-readable definition should at least mention which paths the Architect can read.

Compare with `executor-01.md`, which correctly scopes: "read_file -- read files within your sandbox/worktree scope." The Architect definition should be similarly explicit.

**Suggested fix:** Change to: `read_file -- read files within ARCHITECTURE-tier and agent-managed paths (no BOARD-tier paths without board approval)`.

### Q7. Strategist Lethal Trifecta Table Has a Wording Gap

`strategist.md` Lethal Trifecta table says:

> External comms | Gateway only | Tier 2+ requires board approval

But the spec (2, Lethal Trifecta table) says:

> Strategist | Gateway only | Medium-High

The definition adds "Tier 2+ requires board approval" which is accurate per 7 (Communication Gateway tiers), but none of the other agent definitions reference Gateway tiers. The Executor and Reviewer definitions both say `External comms | NONE`, which is correct. The Architect says `External comms | NONE`, also correct. But the Strategist's reference to "Tier 2+" introduces a concept that is not explained in the agents.md files. If someone reads `strategist.md` without reading 7, "Tier 2+" is meaningless.

**Suggested fix:** Either spell it out ("Gateway access for external communication; transactional messages only in Phase 1, board approval required for conversational messages") or remove the tier reference and just say "Gateway only (board-approved)."

### Q8. AGENTS.md Spec Version Reference

`AGENTS.md` states:

> The canonical architecture specification is `SPEC.md` (v0.6.1).

This is correct as of today. But this means every spec version bump requires updating `AGENTS.md`. This is fragile. Consider whether the version reference should be removed (just point to "the current SPEC.md") or whether the compilation step should validate version alignment.

**Suggested fix:** Change to: "The canonical architecture specification is `SPEC.md`. When this file and the spec conflict, the spec wins." Drop the version number -- it adds a maintenance burden with no safety benefit. The spec is the spec regardless of version.

### Q9. Executor `external_http_request` Has a Conditional Escape Hatch

`executor-01.md` lists `external_http_request` as forbidden, then adds:

> external_http_request (unless the specific tool is whitelisted per-task)

This parenthetical is a problem. The forbidden list should be absolute. If a specific task needs external HTTP, the mechanism is a per-task tool whitelist in the JWT claims (infrastructure-enforced per P2), not a parenthetical in the agent definition that says "unless." The "unless" language in a prompt-level definition is exactly the kind of ambiguity that creates privilege escalation paths.

An agent reading this definition could interpret "unless the specific tool is whitelisted per-task" as authorization to attempt external HTTP requests and claim the whitelist applies. The infrastructure will block it, but the agent will waste tokens trying and potentially produce confusing error states.

**Suggested fix:** Remove the parenthetical. The forbidden list should read: `external_http_request`. Full stop. The per-task whitelist mechanism is an infrastructure concern documented in the spec, not something the agent definition needs to hint at.

### Q10. Missing `fallback_model` in Agent Definitions

The spec's example config (4) includes:

```json
"fallback_model": "claude-haiku-4-5-20251001"
```

None of the agent definitions mention fallback models. The cost-aware routing section (3) describes how the Orchestrator classifies tasks as DETERMINISTIC / LIGHTWEIGHT / FULL and uses `routing_class` to select execution paths. The agent definitions should at least acknowledge that fallback models exist, or explicitly state that fallback model selection is an infrastructure concern handled by the compiled config.

**Suggested fix:** Add a line to each agent's model section: "Fallback model configured in compiled config; not overridable by agent."

---

## 4. Specific Line Comments

### `agents/AGENTS.md` -- "What This File Does NOT Do" Section

This is excellent. The explicit statement that "This file advises. It does not enforce." with the enumerated enforcement boundaries is exactly right. This is the most important paragraph in the entire PR. It correctly implements P2 and sets the right expectations for any agent reading these files. Keep this.

### `agents/strategist.md` -- Decision Record Format

The JSON schema for `strategic_decisions` records is well-structured. The inclusion of `kill_criteria` as a required field and the anti-pattern "Don't omit kill criteria" is good governance design. The three-tier decision classification (tactical/strategic/existential) maps correctly to 19.

### `agents/strategist.md` -- "Don't let confidence drift upward"

This anti-pattern is genuinely insightful. Calibration drift is a real problem with LLM agents that self-assess. Calling it out explicitly as an anti-pattern is more effective than a positive instruction to "maintain calibration." Good.

### `agents/executor-01.md` -- Retry Behavior Section

Well-structured. The distinction between CI failure (structured `failure_context`, Q3 tier) and reviewer rejection (structured feedback, Q2 tier) correctly matches 4 (Automated Reaction Loops). The 1-revision limit before escalation matches 5.

### `agents/reviewer-backend.md` -- Quarantine Clearing Section

Good. The 5-step quarantine inspection process maps correctly to the output quarantine gate in 4 (runtime loop step 6). The distinction between schema failure and adversarial scan failure with different response paths is correct.

### `agents/reviewer-backend.md` -- "Don't modify executor outputs"

Correct and important. The Reviewer's read-only constraint on executor work is fundamental to the separation of concerns. If the Reviewer could modify outputs, it would become a shadow executor with no accountability for the modifications. The anti-pattern makes this explicit.

---

## 5. Final Verdict

**NEEDS WORK.** Priority order for fixes:

1. **Add `orchestrator-eng.md`** (C1) -- this is the blocker. Without it, the PR is incomplete.
2. **Remove `create_subtask` from Architect** (C4) -- security-relevant delegation ambiguity.
3. **Reconcile Strategist cost target with spec** (C2) -- either fix the spec or document the discrepancy.
4. **Trace or remove `query_llm_invocations`** (C3) -- P1 violation.
5. **Remove `orchestrator-product` references** (Q3) -- Phase 1 should not pre-authorize non-existent agents.
6. **Fix Executor `external_http_request` language** (Q9) -- remove the escape hatch wording.
7. **Scope Architect's `read_file`** (Q6) -- specify what it can read.
8. Everything else -- nice to fix but not blocking.

The overall quality is solid. The anti-patterns are genuinely useful. The P2 enforcement awareness is consistent throughout. This is 80% of the way there. The missing 20% is the Orchestrator definition and the security-relevant items above.

---

## 6. The Orchestrator Gap: What `orchestrator-eng.md` Must Cover

The Orchestrator is the most operationally loaded Phase 1 agent. It is the dispatch layer between strategy and execution. Based on the spec, here is what `orchestrator-eng.md` must define:

### Identity
- **Agent ID:** `orchestrator-eng`
- **Model:** Claude Sonnet
- **Role:** Task decomposition, work assignment, deadline management, result aggregation, release PR creation

### Hierarchy
- **Reports to:** Strategist
- **Can assign to:** `reviewer-backend`, `executor-01`, `executor-02`, `executor-03` (spec 4, example config). No `reviewer-frontend` until that agent exists. No globs.
- **Peers:** `architect`, `orchestrator-product` (Phase 2+)
- **Escalates to:** Strategist, Architect (for cross-cutting technical issues)

### Core Responsibilities (from spec)
1. **Task decomposition:** Break workstreams into tasks and subtasks with explicit acceptance criteria (spec 3)
2. **Assignment with constraints:** Assign tasks to executors/reviewers from explicit `can_assign_to` list. Max 1 task per executor at a time (spec 5). Must set deadline on every assigned task.
3. **Cost-aware routing:** Classify tasks as DETERMINISTIC / LIGHTWEIGHT / FULL at creation time using `routing_class` field (spec 3, cost-aware routing). This is a lightweight heuristic, not an LLM call.
4. **Review eligibility:** Determine at task creation whether the task requires Reviewer approval or can transition directly `in_progress -> completed`. Criteria: `data_classification` <= INTERNAL AND `budget_usd` <= role median (spec 3, state machine rules).
5. **Result aggregation:** Collect completed subtask outputs, aggregate into parent task deliverables
6. **Retry coordination:** On 4th executor failure, decide next steps (reassign, redesign, escalate). On reviewer escalation after 1 feedback round, decide next steps.
7. **Conflict avoidance:** Do not assign overlapping file-level work to concurrent executors (spec 14.1)
8. **Release PR creation:** Create `release/vX.Y.Z` branches from `develop` with aggregate summaries. Check promotion triggers after every merge to `develop` (spec 14.1): directive completion, diff threshold (30 files / 500 lines), security/board-decision labels, board request, 72-hour staleness floor.
9. **Release failure handling:** Diagnose CI failures on release PRs, create fix tasks, rebase or recreate release branch (spec 14.1)

### Tools (from spec 4, example config)
**Allowed:**
- `read_file` -- read task outputs, architecture docs, CI logs
- `query_task_graph` -- full read on work items, edges, state transitions
- `create_subtask` -- create tasks and subtasks with acceptance criteria
- `assign_task` -- assign work items to agents in `can_assign_to` list
- `attach_output` -- attach aggregated results to parent work items
- `query_budget_status` -- read `v_budget_status` for allocation decisions

**Forbidden:**
- `write_file`, `execute_code`, `deploy_to_production`
- `delete_repository`, `external_http_request`
- `modify_guardrails`, `modify_agent_config`
- `access_other_agent_context`
- `create_directive` (only Strategist can create DIRECTIVEs)

### Guardrails (from spec 4, example config + spec 5)
- **Max budget per task:** $5.00
- **Requires approval above:** $10.00 (from Strategist)
- **Max delegation depth:** 3 (orchestrator -> reviewer/executor, with possible sub-delegation in Phase 2+)
- **Data classification clearance:** PUBLIC, INTERNAL, CONFIDENTIAL
- **Max output tokens:** 4,096
- **Max tool invocations per task:** 10
- **Max 1 task per executor at a time** (spec 5)
- **Must set deadline on every assigned task** (spec 5)

### Context Budget (from spec 4, cost targets table)
- **Max context per task:** 4,000 tokens (NOT 6,000 -- spec says 4,000 for Orchestrator)
- **Cost target:** ~$0.012 per task
- **Context strategy:** parent summary only, sibling statuses, semantic search for history

NOTE: The spec shows 6,000 tokens in the Orchestrator example config `max_context_tokens_per_task: 6000` but the cost targets table says 4,000. This is another spec inconsistency that needs resolution. The definition should pick one and note the discrepancy.

### Anti-Patterns (critical for this agent)
- **Don't assign overlapping work.** Two executors touching the same files create merge conflicts. Check file-level scope before concurrent assignment.
- **Don't skip deadlines.** Every assigned task must have a deadline. Tasks without deadlines are invisible to timeout detection.
- **Don't over-decompose.** A task that decomposes into 15 subtasks probably needs a different approach, not more subtasks. Decomposition depth is a cost multiplier.
- **Don't aggregate without validating completion.** Before aggregating subtask results into a parent deliverable, verify all subtasks are in `completed` state. Aggregating partial results creates false completion signals.
- **Don't create release PRs during active security work.** If any merged PR to `develop` carries the `security` label and the fix is not yet verified, do not promote.
- **Don't re-queue tasks to the same executor after 2 consecutive failures.** If an executor fails the same task twice, route to a different executor or escalate. Same agent + same task + same approach = same failure.

### Lethal Trifecta
- Private data: MEDIUM (task graph read/write)
- Untrusted content: LOW (internal only)
- External comms: Gateway only (same as spec 2 table)
- Overall risk: Medium (mitigated by explicit assignment lists, delegation depth limits)

### Phase 1 Specifics
- Creates feature branches for executor tasks: `feat/TASK-XXXX-description`
- Uses 1-2 shared bot accounts (spec 14.1) with commit trailers for agent identity
- Release PRs from `develop` to `main` -- board merges, Orchestrator does not have `main` merge access (Linus audit C2)
- Checks promotion triggers after every merge to `develop`

---

*Review conducted against SPEC.md v0.6.1. All section references are to the canonical specification.*
