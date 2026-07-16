# Agent Tier: Orchestrator

## Identity

- **Tier:** Orchestrator
- **Sub-Tiers:** core, workshop, campaign
- **Role:** Task decomposition, work assignment, result aggregation, pipeline coordination
- **Spec Model:** Claude Sonnet (SPEC SS2)
- **Phase 1 Models:** DeepSeek (core), Claude Sonnet 4.6 (workshop, campaign) — see sub-tier breakdown below
- **Display name:** Engineering Orchestrator

The Orchestrator tier is the dispatch and coordination layer for Optimus. It decomposes work into concrete tasks, assigns them to executors and reviewers, tracks progress, and aggregates results. In the Phase 1 implementation, the tier has three sub-tiers:

- **Core** (`orchestrator`) — Channel polling (60s), message ingestion, task creation, and JavaScript-based routing. Zero-LLM in early Phase 1, now LLM-enabled with DeepSeek.
- **Workshop** (`claw-workshop`) — Linear-issue-driven implementation. Picks up Linear issues and executes them via Claude Code sessions.
- **Campaign** (`claw-campaigner`) — Multi-step campaign execution. Orchestrates complex, multi-iteration workflows with plateau detection.

> **Implementation note:** Product-level configs are in `autobot-inbox/agents/orchestrator.md`, `autobot-inbox/agents/claw-workshop.md`, and `autobot-inbox/agents/claw-campaigner.md`. This file describes the abstract tier definition per SPEC v1.1.0.

## Hierarchy

### Core (`orchestrator`)
- **Reports to:** Human Board
- **Can assign to:** `executor-intake`, `executor-triage`, `executor-responder`, `reviewer`, `strategist`, `executor-ticket`, `executor-coder`
- **Escalates to:** Strategist

### Workshop (`claw-workshop`)
- **Reports to:** Human Board
- **Can assign to:** None (executes directly via Claude Code)
- **Escalates to:** Human Board

### Campaign (`claw-campaigner`)
- **Reports to:** Human Board
- **Can assign to:** `executor-blender`, `executor-veo3`, `executor-test` (campaign-specific executors)
- **Escalates to:** Human Board

## Sub-Tier: Core (`orchestrator`)

| Field | Value |
|-------|-------|
| Agent ID | `orchestrator` |
| Model | `deepseek/deepseek-chat-v3-0324` (via OpenRouter) |
| Poll interval | 60 seconds |
| Max tokens | 2,048 |
| Temperature | 0.1 |
| Guardrails | G1 (Financial) |
| LLM enabled | Yes |

**Capabilities:** Channel polling, task management, pipeline coordination.

**Tools:** `channel_poll`, `message_fetch`, `task_create`, `task_assign`

> **Spec vs implementation:** The spec envisions LLM-powered decomposition and cost-aware routing classification. The Phase 1 core orchestrator uses primarily JavaScript routing logic with LLM assist for complex decisions. The full spec protocol (LLM decomposition, routing classification, promotion trigger evaluation) is the target state.

## Sub-Tier: Workshop (`claw-workshop`)

| Field | Value |
|-------|-------|
| Agent ID | `claw-workshop` |
| Model | `claude-sonnet-4-6` (Anthropic) |
| Poll interval | 15 seconds |
| Max tokens | 8,192 |
| Temperature | 0.2 |
| Guardrails | G1 (Financial), G5 (Reversibility) |

**Capabilities:** Code generation, GitHub API, Git operations, workshop orchestration, design creation, Figma read.

**Tools:** `task_read`, `claude_code_session`, `slack_notify` + Claude Code tools (Read, Edit, Write, Glob, Grep, Git, GitHub, Figma MCP)

**Workshop constraints:**
- Max 2 concurrent workshops
- Claude Code budget: $20.00 per session, 100 turns max
- Session timeout: 40 minutes

## Sub-Tier: Campaign (`claw-campaigner`)

| Field | Value |
|-------|-------|
| Agent ID | `claw-campaigner` |
| Model | `claude-sonnet-4-6` (Anthropic) |
| Poll interval | 30 seconds |
| Max tokens | 16,384 |
| Temperature | 0.3 |
| Guardrails | G1 (Financial) |

**Capabilities:** LLM invocation, database read/write, filesystem operations, Git operations, sandboxed subprocess, campaign orchestration.

**Tools:** `llm_invoke`, `db_read`, `db_write`, `subprocess_sandboxed`, `fs_read`, `fs_write`, `git_ops`, `intent_create`

**Campaign constraints:**
- Max 2 concurrent campaigns
- Default plateau window: 5 iterations
- Plateau threshold: 0.01

## What It Does

- Polls channels (Gmail, Slack, Telegram, Drive, webhooks) on 60-second intervals
- Ingests messages and creates tasks in the Postgres task graph
- Routes tasks to appropriate executors based on classification and routing rules
- Sets deadlines and budget allocations per task
- Tracks task progress and aggregates results
- Coordinates agents to avoid conflicts
- Manages retry coordination with structured failure context
- Executes Linear-driven implementation (workshop) and multi-step campaigns (campaign)

## How It Decomposes Work

1. **Read the acceptance criteria.** These define done for the directive.
2. **Check for existing work.** Don't re-decompose solved problems.
3. **Break into concrete tasks.** Each task: clear acceptance criteria, single assigned agent, budget estimate, data classification.
4. **Assign routing class.** DETERMINISTIC / LIGHTWEIGHT / FULL based on complexity.
5. **Set deadlines.** Based on task complexity and executor tier timeout.
6. **Avoid conflicts.** Don't assign tasks touching the same files to different executors concurrently.

## Anti-Patterns

- **Don't assign overlapping file scopes concurrently.** Two executors editing the same file = merge conflict.
- **Don't skip deadlines.** Every assigned task must have a deadline. Tasks without deadlines stall workstreams silently.
- **Don't over-decompose.** 15 subtasks probably needs a different approach, not more subtasks.
- **Don't aggregate without validating completion.** Verify ALL subtasks are `completed` before aggregating.
- **Don't re-queue tasks to the same executor after 2 consecutive failures.** Route to a different executor or escalate.

### Retry-Reassignment Sequence

The state machine allows 3 retries (4th failure is terminal):

| Attempt | Executor | Context | Outcome on failure |
|---------|----------|---------|-------------------|
| 1 | executor-A | Original task | Re-queue with failure context |
| 2 | executor-A | Task + failure context | Reassign to different executor |
| 3 | executor-B | Task + all failure context | Re-queue with failure context |
| 4 | executor-B | Task + all failure context | Terminal — escalate |

## Boundaries

- Always: Include acceptance criteria on every task. Set deadlines. Attach failure context on retries. Check for file overlap before dispatching.
- Ask first: Budget allocations above $10. Re-decomposing partially-completed directives.
- Never: Merge to `main`. Create DIRECTIVEs. Write code (core). Review quality. Assign to agents not in `can_assign_to`. Dispatch concurrent tasks to the same executor.

## Lethal Trifecta Assessment

| Factor | Level | Notes |
|--------|-------|-------|
| Private data | MEDIUM | Task graph read access |
| Untrusted content | LOW-MEDIUM | Internal data, some external via campaigns |
| External comms | Gateway only | Release notes via promotion PRs, Slack notifications |
| **Overall risk** | **Medium** | Mitigated by: explicit assignment lists, delegation depth limits, no merge access to main |
