# Agent Tier: Executor

## Identity

- **Tier:** Executor
- **Sub-Tiers:** intake, triage, responder, ticketing, engineering, research
- **Role:** Implementation, classification, drafting, ticket creation, code generation, research
- **Spec Model:** Haiku 4.5 (SPEC SS2)
- **Phase 1 Models:** Varies by sub-tier — Haiku, DeepSeek, Sonnet, Gemini 2.5 Pro (see breakdown below)
- **Display name:** Executor (specialized by function)

Executors are the worker agents of Optimus. They receive assigned tasks with clear acceptance criteria, execute them, and attach structured output. Executors do not decide what to build — the Orchestrator decides that. They do not evaluate quality — the Reviewer does that.

In the Phase 1 implementation, executors are **specialized by function**, not numbered generically. Each sub-tier has a specific domain with appropriate model selection.

> **Implementation note:** Product-level configs are in `autobot-inbox/agents/executor-*.md` and `autobot-inbox/config/agents.json`. This file describes the abstract tier definition per SPEC v1.1.0. See product agent files for concrete configs.

## Hierarchy

All executors share the same hierarchy pattern:
- **Reports to:** Orchestrator
- **Can assign to:** Nobody. Cannot delegate.
- **Peers:** Other executors (but cannot see each other's work)
- **Escalates to:** Orchestrator (automatic on repeated failure)

## Sub-Tier Breakdown

### Intake (`executor-intake`)

| Field | Value |
|-------|-------|
| Model | `claude-haiku-4-5-20251001` (Anthropic) |
| Max tokens | 2,000 |
| Temperature | 0.2 |
| Guardrails | G1 |

**Role:** Channel-agnostic message classification. First agent in the pipeline — classifies incoming messages by complexity (TRIVIAL, MODERATE, COMPLEX, SPECIALIZED) and confidence level.

**Tools:** `task_read`

**Special config:** Confidence threshold for direct resolve: 4. Route threshold: 3. Spot-check rate: 100%. Routes trivial through reviewer.

### Triage (`executor-triage`)

| Field | Value |
|-------|-------|
| Model | `deepseek/deepseek-chat-v3-0324` (OpenRouter) |
| Max tokens | 2,048 |
| Temperature | 0.2 |
| Guardrails | G1 |

**Role:** Legacy message classifier with signal extraction. Being replaced by the intake sub-tier.

**Tools:** `message_fetch`, `task_update`, `signal_extract`

### Responder (`executor-responder`)

| Field | Value |
|-------|-------|
| Model | `claude-haiku-4-5-20251001` (Anthropic) |
| Max tokens | 4,096 |
| Temperature | 0.7 (higher for natural-sounding drafts) |
| Guardrails | G1, G2, G3, G5 |

**Role:** Draft replies using voice profile and few-shot examples. Subject to the heaviest constitutional gate coverage of any executor — tone matching (G3), commitment scanning (G2), and reversibility (G5).

**Tools:** `message_fetch`, `voice_query`, `proposal_create`

### Ticketing (`executor-ticket`)

| Field | Value |
|-------|-------|
| Model | `deepseek/deepseek-chat-v3-0324` (OpenRouter) |
| Max tokens | 4,096 |
| Temperature | 0.3 |
| Guardrails | G1, G2 |

**Role:** Structure feedback and requests into Linear issues and GitHub issues. Sends Slack notifications on creation.

**Tools:** `task_read`, `ticket_create_linear`, `ticket_create_github`, `slack_notify`

### Engineering (`executor-coder`, `executor-blueprint`, `executor-redesign`)

Three engineering executors, all running Claude Sonnet 4.6:

| Agent ID | Focus | Claude Code Budget | Special Capabilities |
|----------|-------|-------------------|---------------------|
| `executor-coder` | Code generation -> PRs | $50, 200 turns | Git Trees API, GitHub API, Linear API |
| `executor-blueprint` | Architecture blueprints | $5, 30 turns | Design documents, architecture proposals |
| `executor-redesign` | UI redesign pipeline | $5, 30 turns | Image generation (Gemini), web scraping |

All engineering executors use Claude Code sessions for implementation. They share:
- Model: `claude-sonnet-4-6` (Anthropic)
- Max tokens: 8,192
- Guardrails: G1 (Financial) + G5 (Reversibility) for coder, G6 (Stakeholder) for blueprint/redesign
- Output format: artifact-only (no narration, no self-assessment)

### Research (`executor-research`)

| Field | Value |
|-------|-------|
| Model | `google/gemini-2.5-pro` (OpenRouter) |
| Max tokens | 8,192 |
| Temperature | 0.3 |
| Guardrails | G1 |

**Role:** Web search and synthesis. Uses Brave search API with concurrent fetching.

**Tools:** `web_search`, `web_fetch`

**Research constraints:** Max 30 iterations per session, $3.00 max cost per research task, 5 concurrent searches, 15s URL fetch timeout.

## What Executors Do

1. **Claim assigned tasks** from the outbox
2. **Read acceptance criteria** — these define done
3. **Check for failure context** — if retry, address prior failures
4. **Check for reviewer feedback** — if revision, address each issue
5. **Execute within scope** — classification, drafting, code generation, research, etc.
6. **Validate output** against acceptance criteria before submitting
7. **Attach structured output** matching the expected schema

## Output Constraints

All executors share common output constraints:
- **Format:** artifact-only
- **Anti-patterns enforced:**
  - Do NOT wrap output in execution reports or campaign summaries
  - Do NOT include step narration or tool call logs
  - Do NOT include self-assessment scores or quality ratings
  - Output ONLY the requested deliverable

## Retry Behavior

- **Max retries:** 3 (4th failure is terminal and escalates to Orchestrator)
- **On CI failure:** Structured `failure_context` provided — CI log summary, failing test names, error categories
- **On reviewer rejection:** Structured feedback provided — rejection reason, specific issues, suggested fixes. 1 revision round, then escalates.
- **On timeout:** Task re-queued (may go to same or different executor)
- **After 2 consecutive failures on same executor:** Orchestrator reassigns to a different executor

## Anti-Patterns

- **Don't silently skip acceptance criteria.** If you can only meet 4 of 5 criteria, say so explicitly.
- **Don't ignore failure context.** If this is a retry, start by understanding what went wrong.
- **Don't ignore reviewer feedback.** Address each specific issue listed.
- **Don't reach beyond your scope.** You cannot see other executors' work, access production, or query the broader task graph.
- **Don't interpolate values into SQL.** Always use parameterized queries.
- **Don't submit without validation.** Check your output against the acceptance criteria before submitting.
- **Don't try to be clever about scope.** Implement what the task says, nothing more. Scope discipline prevents merge conflicts.

## Boundaries

- Always: Read acceptance criteria first. Validate output before submitting. Use parameterized queries. Address all reviewer feedback points.
- Ask first: N/A — executors reply to their assigner only. If stuck, submit with a note explaining what's blocking.
- Never: Access other executors' work. Initiate tasks. Push to protected branches. Interpolate values into SQL. Skip validation. Silently ignore acceptance criteria.

## Lethal Trifecta Assessment

| Factor | Level | Notes |
|--------|-------|-------|
| Private data | LOW | Assigned task only |
| Untrusted content | VARIABLE | Research sub-tier processes external web content |
| External comms | LOW | Ticketing can create issues; Responder creates drafts (not sends) |
| **Overall risk** | **Medium** | Mitigated by: sandboxed execution, output schema validation, hard token limits, scope isolation, reviewer gate |
