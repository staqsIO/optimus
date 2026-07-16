## 11. Failure Modes

| Failure | Detection | Response | Recovery |
|---------|-----------|----------|----------|
| Agent crash | Reaper query every 60s: tasks stuck in `in_progress` beyond deadline | Re-queue task (max 3 retries) | On 4th failure: mark `failed`, escalate to supervisor |
| Task timeout | Configurable per tier (Executor: 5min, Orchestrator: 15min, Strategist: 30min) | Mark `timed_out`, re-queue or escalate | Same as crash recovery |
| Garbage output | Schema validation failure, Reviewer rejection | 1 retry with feedback → reassign to different Executor → escalate | Pattern detection: Executor failing > 30% triggers quality alert |
| DAG cycle | `would_create_cycle()` before every edge INSERT | Reject the subtask creation, return error to creating agent | Agent must decompose differently |
| Cascading failure | Multiple tasks failing in same workstream | Orchestration layer (not agents) transitions all descendant tasks | Running tasks get soft-halt; completed tasks preserved |
| Budget exceeded | Real-time check via `v_budget_status` | Halt new task creation for that budget scope | Board notified; must approve additional budget |
| Content poisoning | Sanitization flags at context-load time | Flagged content quarantined; reviewer alerted | Manual review before content enters any agent context |
| Tool integrity failure | Hash mismatch on tool invocation | Tool invocation blocked; event logged | Board alerted; tool must be re-registered |
| Agent replacement | Board decision (poor performance, model upgrade) | New agent config deployed with fresh `config_hash` | Replacement agent loads task history via semantic search; runs in shadow mode with measurement-based exit criteria (see §11) |

### Agent Replacement Protocol

When an agent is replaced (model swap, prompt rewrite, or full replacement):

1. Board updates `agent.config.json` and deploys new agent process
2. New agent's `config_hash` is recorded; old agent's config is archived in `agent_config_history`
3. New agent runs in **shadow mode** until measurement-based exit criteria are met (P5: measure before you trust):
   - Minimum tasks processed: N (configurable per tier, default 50)
   - Minimum coverage: agent must encounter all task categories it handles
   - Maximum divergence rate from expected outputs: < 10%
   - Upper time bound: 7 days (prevents indefinite shadow mode)
   - Shadow mode exits when ALL conditions are met, not after a clock expires
4. Orchestration layer compares shadow outputs to what the old agent would have produced (for tasks with known-good outputs)
5. After all exit criteria pass with no quality flags, shadow mode is lifted and the agent enters **graduated trust escalation**:
   - **Level 1 — Suggest-with-review:** Agent outputs are committed to the task graph but flagged for mandatory Reviewer approval before downstream agents consume them. Duration: until agent completes 25 tasks with < 5% rejection rate.
   - **Level 2 — Autonomous-on-low-risk:** Agent operates autonomously on tasks with `data_classification` ≤ INTERNAL and `budget_usd` ≤ role median. Higher-risk tasks still require Reviewer approval. Duration: until agent completes 100 tasks with < 3% rejection rate across all risk levels.
   - **Level 3 — Full autonomous:** Normal operation per role constraints. No additional review overhead.
   - Trust level is tracked in the agent's runtime state and enforced by the orchestration layer (P2). An agent cannot self-promote. Trust level resets to Level 1 if: the agent's config_hash changes (prompt rewrite), the underlying model version changes, or the agent's rejection rate exceeds 10% in any 7-day window.
6. Full replacement history (old config, new config, shadow mode results, trust escalation progression) is logged in the audit trail

This is the v0.4 equivalent of v0.1's "replacement agent reads the email backlog." The task graph provides the work history; shadow mode provides the safety net.

### Component Maturity Gates

Components built by agents progress through maturity levels. Deployment count is rejected as a vanity metric — quality gates are measurement-based:

| Level | Name | Requirements |
|-------|------|-------------|
| 0 | Draft | Code exists, compiles, basic tests pass |
| 1 | Provisional | > 90% test coverage, passes property-based tests for its invariants, schema validation |
| 2 | Shadow | Running in shadow mode for 7+ days with zero failures |
| 3 | Mastered | All Level 2 criteria + mutation testing score > 80% + no regressions for 30 days |

No component may be used as a dependency by another component unless it is at Level 1 (Provisional) or above. Level 0 components may only run in isolation or shadow mode.
