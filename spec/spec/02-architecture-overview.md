## 2. Architecture Overview

### Optimus (Governed)

```
+---------------------------------------------------------------+
|                      HUMAN BOARD                               |
|  (Strategy, Ethics, Budget, Legal, Oversight)                  |
|                                                                |
|  Interacts via:                                                |
|    - Dashboard (task graph + audit log + cost tracking)        |
|    - Event digests (email, Slack, RSS — their choice)          |
|    - Direct task injection (create DIRECTIVE in task graph)    |
|    - Lightweight command interface (Slack/email — approve/     |
|      reject tasks, inject directives, trigger HALT from        |
|      whichever channel the board member is already using.      |
|      P6: system adapts to humans, not the reverse.)            |
|  Reviews via:                                                  |
|    - Public event archive (searchable, filterable)             |
|    - Agent config history (every prompt version tracked)       |
|    - Cost dashboards (real-time burn rate + budget status)     |
+----------------------------+----------------------------------+
                             |
                             v
+---------------------------------------------------------------+
|                  ORCHESTRATION LAYER                           |
|  (Postgres task graph — single source of truth)               |
|                                                                |
|  +-- guardCheck() on every action (pre + post execution)      |
|  +-- JWT-scoped agent identity + tool allow-lists             |
|  +-- Postgres RLS for agent data isolation                    |
|  +-- pg_notify + outbox for event-driven dispatch             |
|  +-- Content sanitization on context load (P2)                |
|  +-- Kill switch integration (board-triggered HALT)           |
|  +-- Tool integrity verification (hash check before invoke)   |
+---------------------------------------------------------------+
           |              |              |
           v              v              v
    +-----------+  +------------+  +------------+
    | Strategist|  | Orchestrator|  |  Executor  |
    | (Claude   |  | (Claude    |  | (Haiku     |
    |  Opus)    |  |  Sonnet)   |  |  4.5)      |
    +-----------+  +-----+------+  +------------+
                         |
                    +----+----+
                    |         |
               +--------+ +--------+
               |Reviewer| |Executor|
               |(Sonnet)| |(Haiku) |
               +--------+ +--------+

+---------------------------------------------------------------+
|                   PUBLIC TRANSPARENCY LAYER                    |
|  Every state transition → structured event → public archive   |
|  Deterministic renderer (no AI) → human-readable messages     |
|  Searchable at optimus.ai/archive/                            |
|  Event digests pushed to board via preferred channels          |
+---------------------------------------------------------------+

+---------------------------------------------------------------+
|                   TOOL INTEGRITY LAYER                        |
|  Tool registry with content-addressed hashes                  |
|  Sandboxed execution for all tool invocations                 |
|  Behavioral monitoring (output anomaly detection)             |
|  No tool may be invoked unless registered + hash-verified     |
+---------------------------------------------------------------+
```

### Agent Tiers

| Tier | Roles | Model | Capabilities | Constraints |
|------|-------|-------|-------------|-------------|
| Strategist | Strategic planning, cross-domain synthesis | Claude Opus | Full task graph read, create DIRECTIVEs, approve budgets, propose prompt modifications | Cannot deploy, cannot modify infrastructure, cannot communicate externally except via Gateway |
| Architect | Technical architecture, system design | Claude Sonnet | Read task graph, create architecture documents, review technical decisions | Cannot assign tasks to executors directly (routes through orchestrator) |
| Orchestrator | Task decomposition, work assignment, result aggregation | Claude Sonnet | Create subtasks, assign to executors/reviewers, aggregate results, report to strategist | Cannot create DIRECTIVEs, explicit `can_assign_to` list (no globs) |
| Reviewer | Quality assurance, output validation | Claude Sonnet | Read task outputs, approve/reject with feedback, flag quality patterns | Cannot assign tasks, cannot modify task outputs, read-only on executor work. **Acceptance criteria (v0.5.1):** Reviewer evaluates three dimensions — *correctness* (is the output factually/technically right?), *format compliance* (does it match the expected schema?), and *completeness* (does it address ALL acceptance criteria, not just some? — an accurate but incomplete output is flagged for rework, not approved). |
| Executor | Implementation, testing, data processing | Haiku 4.5 (Phase 1); Ollama evaluated Phase 2+ when tasks > 12,500/mo | Execute assigned task, attach output, reply to assigning agent | Cannot initiate tasks, cannot read other executors' work, cannot access production, hard output token limit |
| Utility | Cost tracking, format conversion, log analysis | Smallest viable model | Mechanical transformations, no reasoning required | Cannot communicate with any agent except its configured target |

### Behavioral Contracts

Each agent declares a behavioral contract specifying its expected outputs, success criteria, and interaction norms. Reviewers validate agent work against these contracts rather than subjective judgment. The contract schema is implementation-defined but must be machine-readable and versioned alongside agent configuration. At minimum, a behavioral contract must include measurable success criteria (P5: measure before you trust).

### Lethal Trifecta Assessment

Every component is evaluated against Simon Willison's risk framework: access to private data + exposure to untrusted content + ability to communicate externally = maximum risk.

| Component | Private Data | Untrusted Content | External Comms | Risk | Mitigation |
|-----------|-------------|-------------------|----------------|------|------------|
| Strategist | HIGH (full graph) | LOW (internal only) | Gateway only | Medium-High | Budget limits, board approval gates, prompt drift monitoring |
| Orchestrator | MEDIUM (task graph) | LOW (internal only) | Gateway only | Medium | Explicit assignment lists, delegation depth limits |
| Executor | LOW (assigned task) | VARIABLE (may process external data) | NONE | Medium | Sandboxed tool execution, output schema validation, token limits |
| Reviewer | MEDIUM (task outputs) | MEDIUM (reads executor output) | NONE | Medium | Content sanitization on context load, read-only access |
| Financial Script | HIGH (financial data) | NONE | NONE | Low | Deterministic (no AI), separate credentials, append-only ledger |
| Communication Gateway | LOW (message content) | HIGH (inbound messages) | HIGH (outbound) | **Critical** | Deterministic sanitizer, credential isolation, rate limits, risk-tiered release, cool-down buffer |
| Auditor (Tier 2) | HIGH (full read access) | NONE | NONE | Medium | Separate infrastructure, different cloud account, no inbound path from agents |

The Communication Gateway is the highest-risk component. It gets the most security investment. See §7.
