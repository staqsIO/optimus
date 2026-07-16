# SPEC Addendum — Consolidated Pending Changes (March 3–7, 2026)

> **Target spec version:** v0.7.1
> **Addendum started:** 2026-03-03
> **Last updated:** 2026-03-07
> **Status:** REVIEW — Consolidated from 12 session-level addendum entries for board review and PR
> **How to use:** Each section references the spec section it modifies. When ready to merge, apply each section to the corresponding location in SPEC.md. Sections are ordered by spec section number.

---

## Change Log

| Date | Section | Summary | Source Session |
|------|---------|---------|----------------|
| 2026-03-07 | §0 P1/P2 (AMEND) | Add ROME as second canonical reference case alongside OpenClaw | ROME autonomous goal acquisition analysis |
| 2026-03-05 | §3 Cost-Aware Routing (AMEND) | Add 2-file routing_class threshold for multi-file code tasks | SWE benchmark gap analysis |
| 2026-03-07 | §4 agents.md (AMEND) | Formalize agents.md Minimalism Principle — non-inferable content only | AGENTbench (ETH Zurich) gap analysis |
| 2026-03-07 | §4 agents.md (AMEND) | Formalize knowledge/execution layer distinction (Skills vs MCP) | Skills vs MCP architecture analysis |
| 2026-03-07 | §4 Context Loading Step 1 (AMEND) | Annotate identity block with minimalism constraint + 520-token target | AGENTbench gap analysis |
| 2026-03-07 | §4 Runtime Loop Step 5 (AMEND) | Add API-level retry wrapper with exponential backoff | Python decorators / API retry policy |
| 2026-03-07 | §4 Automated Reaction Loops (AMEND) | Add cumulative retry state schema across attempts | HuggingFace February papers (RE-TRAC) |
| 2026-03-07 | §4 Context Window Management (AMEND) | Add graph-scoped semantic search for Phase 2 hybrid retrieval | Vector DB vs Graph RAG analysis |
| 2026-03-07 | §4 Compaction (AMEND) | Add Attention Matching as target compaction mechanism for Phase 2+ | KV cache compaction research |
| 2026-03-07 | §5 Guardrail Enforcement (AMEND) | Add `output_artifacts` table for inter-agent payload content-addressing | Multi-agent research sweep (AgentLeak) |
| 2026-03-07 | §6 Tool Integrity Layer (AMEND) | Add network namespace isolation + process tree monitoring + CPU/GPU quotas | ROME analysis |
| 2026-03-07 | §6 Tool Acceptance Policy (AMEND) | Add tool schema scope requirement (minimal schemas, no knowledge in tool defs) | Skills vs MCP analysis |
| 2026-03-07 | §6 Tool Acceptance Policy (AMEND) | Add MCP semantic drift monitoring requirement | Multi-agent research sweep |
| 2026-03-07 | §6 Tool Integrity Layer (AMEND) | Add jCodeMunch MCP as Phase 2 tool candidate | jCodeMunch repo evaluation |
| 2026-03-07 | §7 Communication Gateway (AMEND) | Add 6-step inbound pipeline with thread trust scoring for gradual context poisoning defense | Gradual context poisoning analysis |
| 2026-03-07 | §8 Threat Detection Memory (AMEND) | Add `TRUST_ESCALATION_PATTERN` threat class | Gradual context poisoning analysis |
| 2026-03-07 | §8 Threat Detection Memory (AMEND) | Add `AUTONOMOUS_GOAL_ACQUISITION` threat class with tight tolerance thresholds | ROME analysis |
| 2026-03-07 | §8 Observability (AMEND) | Add retry metrics to dashboard; add `tool_schema_tokens` to context_profile_json | API retry policy; Skills vs MCP analysis |
| 2026-03-07 | §8 Observability (AMEND) | Add OTEL span exporter for Phase 2 enterprise integration | LangChain CEO / agent observability analysis |
| 2026-03-07 | §8 Tier 2 (AMEND) | Add cross-thread trust correlation analysis responsibility | Gradual context poisoning analysis |
| 2026-03-07 | §10 Cost Tracking (AMEND) | Add "retry overhead" line item to daily cost digest | API retry policy |
| 2026-03-07 | §11 Failure Modes (AMEND) | Add "API transient failure" row to failure modes table | API retry policy |
| 2026-03-07 | §11 Component Maturity Gates (AMEND) | Add eval harness requirement for AI-output components at Provisional+ | LangChain CEO analysis |
| 2026-03-07 | §12 Database Architecture (AMEND) | Add `thread_trust` and `thread_trust_events` tables to `autobot_comms` schema | Gradual context poisoning analysis |
| 2026-03-05 | §14 Phase 1 Success Metrics (AMEND) | Scope-qualify task success rate to Phase 1 task classes | SWE benchmark gap analysis |
| 2026-03-07 | §18 Autonomous Software Composition (AMEND) | Add empirical citation for P(success)=p^d from RE-TRAC research | HuggingFace February papers |
| 2026-03-05 | §20 Deferred Items (AMEND) | Add SWE capability gap monitoring as Phase 2 activation condition | SWE benchmark gap analysis |
| 2026-03-07 | §20 Deferred Items (AMEND) | Clarify DMS vs Attention Matching distinction; add vLLM KV compaction RFC | KV cache compaction research |
| 2026-03-07 | §20 Deferred Items (AMEND) | Promote AdaptOrch dynamic topology routing to Phase 2 activation target | Multi-agent research sweep |

---

## §0 Design Principles — P1/P2 (AMEND)

> **Source:** 2026-03-07 ROME autonomous goal acquisition analysis (Alibaba research paper)
> **Spec section affected:** §0 P1 and P2
> **Change type:** AMEND — add ROME as second canonical reference case

### Proposed Change

After the existing OpenClaw reference in P1, add:

> **ROME (2026):** An open-source agentic model (Alibaba-affiliated research) trained via reinforcement learning over 1M+ trajectories spontaneously began mining cryptocurrency and establishing unauthorized reverse SSH tunnels — without any instruction to do so. Detected not by training metrics but by Alibaba Cloud's managed firewall flagging security-policy violations. This demonstrates that even without prompt injection or external attack, RL-trained agents develop instrumental goals that conflict with operator intent. P1 (deny by default) and P2 (infrastructure enforces) are the only defenses: the agent's "desire" to mine crypto is irrelevant when infrastructure prevents the action. OpenClaw demonstrates you can't trust what *enters* the system; ROME demonstrates you can't trust what the agent *decides to do on its own*.

### Phase Activation

Phase 1 — reference only, no implementation change.

---

## §3 Cost-Aware Routing (AMEND)

> **Source:** 2026-03-05 SWE benchmark gap analysis (SWE-EVO, SWE-Bench Pro, SWE-CI)
> **Spec section affected:** §3 Cost-Aware Routing, routing hierarchy
> **Change type:** AMEND — add explicit multi-file routing threshold

### Proposed Change

Add to the routing hierarchy description after the existing classification rules:

> **Multi-file routing threshold:** When a task type is `code_implementation` and the Orchestrator estimates files-modified > 2, `routing_class` defaults to FULL (Sonnet) regardless of other heuristic signals. The Orchestrator may downgrade this to LIGHTWEIGHT only if the task description explicitly references SSL-compiled output or a single bounded schema change. This threshold is a Phase 1 default; it is tunable via `tolerance_config` once `v_routing_class_effectiveness` data accumulates in Phase 2.

### Rationale

SWE benchmark data (SWE-EVO, SWE-Bench Pro, March 2026) shows a consistent 3x performance collapse for top models on multi-file tasks vs. single-issue tasks. Even GPT-5 with OpenHands achieves only 21% resolution rate on multi-file evolution tasks vs. 65% on isolated fixes. The routing threshold prevents Haiku-tier executors from receiving tasks that are empirically beyond their capability.

### Open Question (Board Decision Required)

Should the 2-file threshold be hard-coded in the Orchestrator heuristic for Phase 1, or configurable via `agent_configs` from day one? Recommendation: hard-coded for Phase 1 on simplicity grounds (P4).

### Phase Activation

Phase 1 — applies to Orchestrator routing heuristic implementation.

### Measurement (P5)

Tracked via `v_routing_class_effectiveness`. If the 2-file threshold causes excessive FULL routing (> 40% of code tasks), adjust threshold based on data.

---

## §4 agents.md — Minimalism Principle (AMEND)

> **Source:** 2026-03-07 AGENTbench (ETH Zurich, Gloaguen et al. 2026) gap analysis
> **Spec section affected:** §4, subsection "agents.md as Human-Authored Source of Truth"
> **Change type:** AMEND — add minimalism principle

### Proposed Change

Add to the "What `agents.md` defines" subsection:

> **Minimalism Principle:** `agents.md` files contain ONLY non-inferable information — behavioral boundaries, anti-patterns, tool permissions, delegation rules, and identity context that cannot be derived from the codebase or task description. Architectural overviews, repository structure, general coding guidelines, and file navigation hints are explicitly excluded. Empirical evidence (AGENTbench, Gloaguen et al. 2026, ETH Zurich — 138 real-world tasks across niche repositories) shows that LLM-generated context files degrade performance by 3% vs. no context file, while increasing inference costs by 20%+. Human-written context files offer marginal 4% gains but still increase costs by up to 19%. The performance gains come only from non-inferable content; inferable content (architecture, file structure) causes agents to execute unnecessary exploration steps.
>
> **Content-creep review:** Quarterly review of all `agents.md` files. If any file exceeds 700 tokens, review for content creep — inferable content that has accumulated over time. Target: < 5% cost overhead from identity context vs. the AGENTbench study's 19%.

### Phase Activation

Phase 1 — governs how `agents.md` files are authored during the build.

### Measurement (P5)

Tracked via `agent_identity` token count in `context_profile_json`. Target: ≤ 520 tokens per agent. Alert threshold: > 700 tokens triggers review.

---

## §4 agents.md — Knowledge/Execution Layer Distinction (AMEND)

> **Source:** 2026-03-07 Skills vs MCP architecture analysis (The New Stack, Janakiram MSV)
> **Spec section affected:** §4, subsection "agents.md as Human-Authored Source of Truth"
> **Change type:** AMEND — formalize the knowledge/execution layer distinction

### Proposed Change

Add after the compilation description:

> **Knowledge/Execution Layer Distinction:** The `agents.md` authoring layer serves as the *knowledge layer* — institutional workflows, conventions, decision logic, and behavioral boundaries. It is cheap to process (200–500 tokens) and version-controlled in git. The MCP tool registry (§6) serves as the *execution layer* — API calls, authentication, runtime state, error handling. Tool schemas are expensive to load (23,000–50,000 tokens for a full MCP server). The emerging industry pattern (CompanyOS, Supabase agent-skills, Microsoft .NET Skills Executor, Claude Code) validates this split. Knowledge concerns must never migrate into tool schemas; execution concerns must never migrate into `agents.md` files. This is a structural constraint, not a guideline — violations inflate context costs by ~100x for the affected content.

### Phase Activation

Phase 1 — applies immediately to authoring conventions.

---

## §4 Context Loading Step 1 (AMEND)

> **Source:** 2026-03-07 AGENTbench gap analysis
> **Spec section affected:** §4, "Per-task context loading" item 1
> **Change type:** AMEND — annotate with minimalism constraint

### Proposed Change

Current text:

> 1. Agent identity + guardrails (fixed overhead, ~500 tokens)

Amend to:

> 1. Agent identity + guardrails (fixed overhead, ~500 tokens). Per the `agents.md` Minimalism Principle, this block contains only non-inferable information — behavioral boundaries, anti-patterns, tool permissions, and delegation rules. Architectural overviews, repo structure, and general coding guidelines are excluded (empirically shown to increase cost without improving task success — see AGENTbench, Gloaguen et al. 2026).

### Phase Activation

Phase 1 — applies immediately.

---

## §4 Runtime Loop Step 5 — API Retry Wrapper (AMEND)

> **Source:** 2026-03-07 Python decorators / API retry policy analysis
> **Spec section affected:** §4, Runtime Loop step 5 (EXECUTE via model)
> **Change type:** AMEND — add API-level retry specification

### Proposed Change

Add to step 5 after "All model I/O logged":

> **API-level retry wrapper (transport failures only):**
> - Scope: wraps the LLM API call only (step 5). Does NOT re-run `guardCheck()` — the pre-check already passed. Re-running would create a race condition where budget could be double-checked against changed state.
> - Retry conditions: HTTP 429 (rate limit), 500/502/503/529 (server errors), network timeouts, connection resets. NOT retried: 400 (bad request), 401 (auth), 404, or any response containing model output (even if output fails post-check — that's a task-level failure, not a transport failure).
> - Backoff: exponential with jitter. Base delay 1s, multiplier 2x, max delay 30s. Max 3 retries per API call (4 total attempts).
> - Combined with task-level retries (§3 state machine: `failed → assigned`, max 3), worst case is 4 API attempts × 4 task attempts = 16 total API calls before permanent failure.
> - Each retry logged as a separate `llm_invocations` row with `retry_of` FK pointing to original invocation and shared `idempotency_key` for grouping.
> - Cost: worst case at Haiku pricing = 16 × $0.024 = $0.384/task (within `max_budget_per_task_usd: 5.00`).

### Schema Addition

Add `retry_of` column to `llm_invocations`:

```sql
ALTER TABLE agent_graph.llm_invocations
  ADD COLUMN retry_of TEXT REFERENCES agent_graph.llm_invocations(id);
```

### Phase Activation

Phase 1 — foundational reliability infrastructure.

### Measurement (P5)

Retry rate tracked in dashboard. Sustained > 5% retry rate triggers investigation (model provider degradation or budget concern). Retry cost included as explicit line item in daily cost digest when retry cost exceeds 1% of daily spend.

---

## §4 Automated Reaction Loops — Cumulative Retry State (AMEND)

> **Source:** 2026-03-07 HuggingFace February 2026 papers review (RE-TRAC, Microsoft)
> **Spec section affected:** §4, Automated Reaction Loops subsection
> **Change type:** AMEND — add cumulative retry state schema

### Proposed Change

In the "CI failure reaction" subsection, amend step 3:

> 3. Task transitions to `failed` with `failure_context` attached: CI log summary, failing test names, error categories, **and cumulative retry state** — a structured record carrying forward what was tried and what failed across ALL prior attempts (not just the most recent failure). Schema:
>
> ```json
> {
>   "attempt_number": 2,
>   "prior_attempts": [
>     {
>       "attempt": 1,
>       "approach_summary": "Direct fix to validation function",
>       "failure_type": "test_regression",
>       "tests_failed": ["test_edge_case_null_input"],
>       "ci_error_category": "assertion_error"
>     }
>   ],
>   "current_failure": { ... },
>   "constraints_discovered": ["null input handling required", "backward compat with v2 API"]
> }
> ```
>
> This cumulative state is loaded as Q3-tier context for the retrying executor. RE-TRAC research (Microsoft, Feb 2026) demonstrates that cumulative retry state produces 15-20% improvement over showing only the last failure, with monotonically decreasing cost per retry.

### Phase Activation

Phase 1 — applies to CI reaction loop implementation.

---

## §4 Context Window Management — Graph-Scoped Semantic Search (AMEND)

> **Source:** 2026-03-07 Vector databases vs Graph RAG analysis
> **Spec section affected:** §4, "Per-task context loading" step 5 (relevant prior work)
> **Change type:** AMEND — add graph-scoped search pattern for Phase 2

### Proposed Change

Add after step 5 description:

> **Phase 2 enhancement — graph-scoped semantic search:** When task history exceeds ~1,000 completed tasks, unscoped semantic search produces increasingly noisy results within the token budget. The mitigation is to use the task graph's DAG structure to scope the semantic search:
>
> 1. **Workstream scoping:** Semantic search is constrained to the current workstream's task history, not the entire corpus. Reduces candidate pool by 5-10x.
> 2. **Decision chain scoping:** For Orchestrator/Strategist tasks, include `strategic_decisions` entries that are ancestors of the current DIRECTIVE in the embedding search scope.
> 3. **Failure-aware scoping:** When a task is a retry (`failed → assigned`), semantic search prioritizes task outputs from the same task type that previously succeeded — showing the agent "how similar problems were solved" rather than "what the whole organization has been doing."
>
> **Implementation:** pgvector on Supabase Pro (P4: boring infrastructure). Embeddings generated at task completion by a Utility agent. Index: HNSW with cosine similarity. The graph provides the scope; the vector search provides the relevance ranking within that scope.
>
> **Activation condition (P5):** `v_context_block_correlation` data shows `prior_work_search` blocks either not helping Orchestrator tasks (< 30% success correlation) or consuming budget without benefit (> 25% of tokens from low-correlation blocks). If neither condition triggers by end of Phase 2, do not activate.

### Phase Activation

Phase 2 — gated on `v_context_block_correlation` data.

### Measurement (P5)

Before/after comparison: Orchestrator task success rate and context token efficiency with scoped vs. unscoped search.

---

## §4 Compaction — Attention Matching (AMEND)

> **Source:** 2026-03-07 KV cache compaction research (MIT, VentureBeat)
> **Spec section affected:** §4, "Compaction" subsection
> **Change type:** AMEND — add target compaction mechanism

### Proposed Change

After the existing compaction description, add:

> **Phase 2+ compaction mechanism — Attention Matching:** MIT's Attention Matching technique (2026) achieves up to 50x KV cache compression in seconds by preserving only the attention output and attention mass of the compressed cache — the two properties sufficient to guarantee identical model behavior regardless of future prompts. Unlike training-time methods (e.g., NVIDIA's DMS), this operates at inference time with no model modifications and completes in seconds rather than hours. Evaluate as the primary compaction mechanism for self-hosted Ollama executors in Phase 2-3. For API-hosted models (Anthropic), compaction benefits are indirect — provider-side adoption reduces API latency. The vLLM project (GitHub issue #10646) is integrating Attention Matching / token dropping into its core inference engine, which would make it available to Ollama.
>
> **Distinction from DMS (§20):** DMS (Dynamic Memory Sparsification) requires fine-tuning the model to learn self-compression. Attention Matching is inference-time only. Evaluate Attention Matching first as the lower-complexity option; DMS only if throughput requirements justify the fine-tuning cost.

### Phase Activation

Phase 2-3 — gated on Ollama executor tier activation.

---

## §5 Guardrail Enforcement — Output Artifacts Table (AMEND)

> **Source:** 2026-03-07 Multi-agent research sweep (AgentLeak paper, 4,979 traces)
> **Spec section affected:** §5, Content Sanitization subsection
> **Change type:** AMEND — add inter-agent payload content-addressing

### Proposed Change

Add after the existing sanitization specification:

> **Inter-agent payload tracking:** AgentLeak research (4,979 traces across production models) found that output-only audit architectures miss 41.7% of violations — the attack surface is the payload that travels *between* agents, not just final outputs. Add an `output_artifacts` table to `agent_graph`:
>
> ```sql
> agent_graph.output_artifacts
>   id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text
>   work_item_id  TEXT NOT NULL REFERENCES agent_graph.work_items(id)
>   written_by    TEXT NOT NULL  -- agent_id
>   content_hash  TEXT NOT NULL  -- SHA-256 of the payload
>   content_type  TEXT NOT NULL  -- 'task_output', 'subtask_input', 'context_block'
>   token_count   INTEGER NOT NULL
>   read_by       TEXT[] DEFAULT '{}'  -- agent_ids that loaded this artifact
>   sanitization_result TEXT  -- 'clean', 'flagged', 'quarantined'
>   created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
>
>   -- Append-only: trigger prevents UPDATE/DELETE except read_by array append
>   -- Index: (work_item_id, created_at DESC)
>   -- Index: (written_by, created_at DESC)
> ```
>
> Every inter-agent payload is hashed at write time. The sanitization layer (step 4f) checks the content hash against the recorded hash at read time — detecting modification between write and read. The `read_by` array creates a chain-of-custody audit trail.

### Open Question (Board Decision Required)

Does `output_artifacts` go in the Phase 1 schema, or is it deferred to Phase 2? It's a small addition (one table, ~8 columns) but affects Phase 1 schema scope.

### Phase Activation

Phase 1 or Phase 2 — pending board decision.

### Measurement (P5)

Track: hash mismatches detected (should be 0 in normal operation), sanitization flag rate by content_type, read_by chain completeness.

---

## §6 Tool Integrity Layer — Sandbox Hardening (AMEND)

> **Source:** 2026-03-07 ROME autonomous goal acquisition analysis
> **Spec section affected:** §6, Sandboxed Execution subsection
> **Change type:** AMEND — strengthen sandbox specification

### Proposed Change

In the Sandboxed Execution section, amend the network access bullet:

> - Network access: denied by default via **network namespace isolation** (not firewall rules — firewall rules can be bypassed by tunneling protocols such as reverse SSH, as demonstrated by ROME). Each tool invocation runs in a dedicated network namespace with no routes to the host network except explicitly whitelisted destinations. Whitelisted per-tool if the tool requires external data.

Add two new bullets:

> - Process tree monitoring: tool invocations are limited to a single process tree. Background processes, daemon forks, and detached sessions are killed on tool invocation completion. Prevents compute diversion (ROME's cryptocurrency mining pattern).
> - Resource quotas: per-invocation CPU time limit, memory ceiling, and GPU allocation cap (if GPU access is granted). Prevents resource abuse even within a single invocation.

### Phase Activation

Phase 1 — applies to sandbox implementation.

---

## §6 Tool Acceptance Policy — Schema Scope + Semantic Drift Monitoring (AMEND)

> **Source:** 2026-03-07 Skills vs MCP analysis; Multi-agent research sweep
> **Spec section affected:** §6, Tool Acceptance Policy subsection
> **Change type:** AMEND — add two requirements to the minimum policy

### Proposed Change

Add to the "must define, at minimum" list:

> - **Tool schema scope:** Registrations must provide minimal invocation schemas (input parameters, output schema, error codes). Extended documentation, usage examples, and workflow guidance are prohibited in tool schemas — that content belongs in the `agents.md` knowledge layer (§4). Token budget impact of tool schemas tracked via `tool_schema_tokens` in `context_profile_json`.
> - **Semantic drift monitoring:** Tools must have their output patterns baselined at registration. If a tool's actual output distribution diverges from its registered description over time (semantic drift), the Tool Integrity Layer flags it for re-review. 85%+ attack success rates have been documented when adaptive strategies target semantic drift in MCP tool descriptions (multi-agent security research synthesis, 78 studies). This complements the existing structural checks (hash verification, schema validation) with behavioral monitoring.

### Phase Activation

Phase 1 (schema scope) and Phase 2 (semantic drift monitoring — requires output pattern baselines from Phase 1 operation).

---

## §6 Tool Integrity Layer — Phase 2 Tool Candidate: jCodeMunch MCP (AMEND)

> **Source:** 2026-03-07 jCodeMunch MCP repo evaluation
> **Spec section affected:** §6, after Tool Acceptance Policy subsection
> **Change type:** AMEND — add Phase 2 tool candidate note

### Proposed Change

Add as a subsection or note:

> **Phase 2 Tool Candidate — jCodeMunch MCP:** `jgravelle/jcodemunch-mcp` is a Python MCP server providing symbol-level code retrieval via tree-sitter AST parsing. Claims 80-99% token reduction for code exploration tasks. Relevant to executor context cost reduction for code-related tasks (maps to §3 LIGHTWEIGHT routing class). Registration blocked on: (1) Tool Acceptance Policy (Phase 1 deliverable), (2) commercial license terms (PolyForm Shield — requires negotiation for production use), (3) resolution of filesystem persistence model vs. sandboxed execution constraints (the tool's index persists across sessions by design, conflicting with task-scoped sandbox). Evaluate in Phase 2 alongside external tool activation.

### Phase Activation

Phase 2 — blocked on three prerequisites listed above.

---

## §7 Communication Gateway — Gradual Context Poisoning Defense (AMEND)

> **Source:** 2026-03-07 Gradual context poisoning analysis (board-initiated security review)
> **Spec section affected:** §7, Inbound Processing subsection
> **Change type:** AMEND — expand inbound pipeline from 5 to 6 steps + add thread trust scoring

### Proposed Change

Replace the current 5-step inbound processing pipeline with a 6-step pipeline:

> Every inbound message enters through a deterministic pipeline — no LLM touches the raw message:
>
> 1. **Channel receiver** (SES, Twilio webhook, Slack events, etc.)
> 2. **Deterministic sanitizer** — strips HTML, Unicode control characters, known injection patterns. NOT an LLM. Rule-based parser.
> 3. **Structured extractor** — separate small model extracts sender, category, request summary, sentiment. Receiving agent NEVER sees raw inbound message.
> 4. **Instruction classifier** — deterministic (not LLM) categorization of extracted content into instruction taxonomy: `NO_INSTRUCTION` (informational), `ROUTINE_TASK` (established pattern from sender), `NOVEL_TASK` (new request type from sender), `META_INSTRUCTION` (requests about how the agent processes messages), `ESCALATION_TRIGGER` (references urgency, authority, or consequences). Classification logged to `thread_trust_events`.
> 5. **Thread trust scoring** — per-thread cumulative trust score with temporal decay. Each message updates the thread's trust score based on instruction category weights. Threads below trust threshold require human review before agent processing. See `thread_trust` DDL in §12 amendment.
> 6. **Sender verification** — SPF/DKIM/DMARC for email, phone match for SMS, crypto identity for privileged senders.
> 7. **Intent classifier** — routes to existing task or creates new task in the task graph.

### Three Defense Layers

> **Layer 1 — Instruction Classification (deterministic, per-message):** Every inbound message is classified by the instruction classifier (step 4). No LLM involvement. The taxonomy is:
>
> | Category | Description | Trust Impact |
> |----------|-------------|-------------|
> | `NO_INSTRUCTION` | Informational reply, acknowledgment | Neutral (+0.01) |
> | `ROUTINE_TASK` | Established task pattern from this sender | Slight positive (+0.05) |
> | `NOVEL_TASK` | New request type from this sender | Slight negative (-0.05) |
> | `META_INSTRUCTION` | Requests about how agent processes messages | Strong negative (-0.50) |
> | `ESCALATION_TRIGGER` | References urgency, authority, or consequences | Negative (-0.20) |
>
> **Layer 2 — Thread Trust Scoring (cumulative, per-thread):** Each thread maintains a trust score that starts at a baseline (0.5) and moves with each message. Temporal decay (configurable, default: 5% per 24h of inactivity) prevents old "earned trust" from persisting indefinitely. Threads below trust threshold (configurable, default: 0.2) are flagged for human review.
>
> **Layer 3 — Cross-Thread Correlation (Tier 2 auditor, daily):** Tier 2 AI Auditor correlates trust events across threads from the same sender or sender domain. A sender maintaining multiple threads, each individually below alert threshold but collectively exhibiting a trust erosion pattern, triggers escalation.

### Phase Activation

Phase 1 (layers 1-2 in Gateway shadow mode), Phase 2 (Layer 3 with Tier 2 activation).

### Measurement (P5)

- Thread trust false positive rate (legitimate threads flagged): target < 3%
- Thread trust catch rate (synthetic poisoning tests detected): target > 90%
- Cross-thread correlation: synthetic multi-thread campaigns detected within 48 hours

---

## §8 Threat Detection Memory — New Threat Classes (AMEND)

> **Source:** 2026-03-07 Gradual context poisoning analysis; ROME analysis
> **Spec section affected:** §8, threat_memory table CHECK constraint and threat classification table
> **Change type:** AMEND — add two threat classes

### Proposed Change

Add to the `threat_class` CHECK constraint:

```sql
CHECK (threat_class IN (
  'INJECTION_ATTEMPT', 'EXFILTRATION_PROBE', 'RESOURCE_ABUSE',
  'SCHEMA_VIOLATION', 'BEHAVIORAL_ANOMALY', 'INTEGRITY_FAILURE',
  'POLICY_VIOLATION', 'UNKNOWN_PATTERN',
  'TRUST_ESCALATION_PATTERN',      -- NEW: gradual context poisoning
  'AUTONOMOUS_GOAL_ACQUISITION'    -- NEW: ROME-style instrumental goals
))
```

Add to the threat classification table:

| Class | Description | Default Severity |
|-------|-------------|-----------------|
| `TRUST_ESCALATION_PATTERN` | Multi-message or multi-thread pattern indicating gradual context poisoning — individually benign messages that collectively shift agent trust baseline toward compliance with adversarial intent | HIGH |
| `AUTONOMOUS_GOAL_ACQUISITION` | Agent pursuing goals not present in its task assignment or constitutional constraints — unauthorized resource usage, unauthorized network activity, unauthorized data access patterns | CRITICAL |

**Tolerance thresholds for `AUTONOMOUS_GOAL_ACQUISITION`:** Tighter than other classes. A single event triggers Level 1 (heightened monitoring). Two events within any window trigger Level 3 (isolate and investigate). This represents a fundamental alignment failure, not a transient error — the response gradient is compressed accordingly.

### Phase Activation

Phase 1 — schema change, threat classification operational from day one.

---

## §8 Observability — Dashboard Additions (AMEND)

> **Source:** 2026-03-07 API retry policy; Skills vs MCP analysis; LangChain CEO analysis
> **Spec section affected:** §8, Dashboard subsection and pathway instrumentation
> **Change type:** AMEND — add metrics

### Proposed Change

Add to the dashboard metrics:

> - API retry rate by model provider (sustained > 5% triggers investigation)
> - Retry cost as % of daily spend (line item in digest when > 1%)
> - `tool_schema_tokens` per agent (tracked in `context_profile_json` alongside existing fields)

Add to `context_profile_json` description:

> `tool_schema_tokens` — token count consumed by MCP tool schema definitions loaded at agent initialization. Tracked to detect tool schema bloat (see §6 Tool Acceptance Policy schema scope requirement).

**Phase 2 addition — OTEL span export:**

> Phase 2 adds an OpenTelemetry span exporter translating `state_transitions` events to OTEL format. Enables integration with enterprise customer observability stacks (Datadog, Honeycomb, Grafana) without schema changes. Activation condition: first enterprise product customer with existing OTEL-compatible observability stack.

### Phase Activation

Dashboard additions: Phase 1. OTEL export: Phase 2 (customer-triggered).

---

## §8 Tier 2 Auditor — Cross-Thread Correlation (AMEND)

> **Source:** 2026-03-07 Gradual context poisoning analysis
> **Spec section affected:** §8, Tier 2 AI Auditor responsibilities
> **Change type:** AMEND — add responsibility

### Proposed Change

Add to Tier 2 responsibilities:

> - **Cross-thread trust correlation analysis:** Correlate `thread_trust_events` across threads from the same sender or sender domain. Detect multi-thread poisoning campaigns where each thread individually stays below alert thresholds but collectively exhibits trust erosion patterns. Flag to board when sender-level aggregate trust score drops below configurable threshold.

### Phase Activation

Phase 2 — requires Tier 2 activation.

---

## §10 Cost Tracking — Retry Overhead (AMEND)

> **Source:** 2026-03-07 API retry policy analysis
> **Spec section affected:** §10, daily cost digest format
> **Change type:** AMEND — add retry line item

### Proposed Change

Add to the daily cost digest format:

> ```
> Retry overhead: $0.42 (1.2% of daily spend)
>   API retries: 23 (3.1% retry rate)
>   Task retries: 4 (1.3% task failure rate)
> ```
>
> Retry overhead line item appears in the digest only when retry cost exceeds 1% of daily spend. Below that threshold, it is omitted for noise reduction.

### Phase Activation

Phase 1 — applies to cost tracking implementation.

---

## §11 Failure Modes — API Transient Failure (AMEND)

> **Source:** 2026-03-07 API retry policy analysis
> **Spec section affected:** §11, Failure Modes table
> **Change type:** AMEND — add row

### Proposed Change

Add to the failure modes table:

| Failure | Detection | Response | Recovery |
|---------|-----------|----------|----------|
| API transient failure | Retry handler exhaustion (4 attempts failed) | Task transitions to `failed` with `api_error` failure context including HTTP status codes, retry timestamps, and provider error messages | Re-queued via normal `failed → assigned` path; if provider is consistently failing, board notified to evaluate provider status |

### Phase Activation

Phase 1 — applies to failure mode handling.

---

## §11 Component Maturity Gates — Eval Harness Requirement (AMEND)

> **Source:** 2026-03-07 LangChain CEO / agent observability analysis (State of Agent Engineering 2026 survey)
> **Spec section affected:** §11, Component Maturity Gates table
> **Change type:** AMEND — add eval requirement

### Proposed Change

Add to Level 1 (Provisional) requirements:

> Components that expose AI-generated outputs must define an eval harness (input fixture → expected output range → pass/fail scoring) before reaching Provisional status. This closes the gap between testing infrastructure (covered by existing test coverage and property-based test requirements) and output quality measurement. The LangChain State of Agent Engineering survey (1,300+ practitioners, 2026) identifies output quality measurement as the #1 barrier to production deployment.

### Phase Activation

Phase 1 — applies to maturity gate definitions.

---

## §12 Database Architecture — Thread Trust Tables (AMEND)

> **Source:** 2026-03-07 Gradual context poisoning analysis
> **Spec section affected:** §12, `autobot_comms` schema
> **Change type:** AMEND — add two tables

### Proposed Change

Add to `autobot_comms` schema:

```sql
autobot_comms.thread_trust
  id                   TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text
  thread_id            TEXT NOT NULL UNIQUE  -- references inbound_messages thread
  current_score        NUMERIC(5,3) NOT NULL DEFAULT 0.500
  message_count        INTEGER NOT NULL DEFAULT 0
  last_updated         TIMESTAMPTZ NOT NULL DEFAULT now()
  decay_rate           NUMERIC(5,4) NOT NULL DEFAULT 0.0500  -- 5% per 24h inactivity
  category_history_json JSONB NOT NULL DEFAULT '{}'
    -- tracks which instruction categories sender has used historically
    -- powers NOVEL_TASK vs ESTABLISHED_TASK distinction
  config_hash          TEXT NOT NULL  -- board-managed weight configuration

  -- Updated by Gateway on each inbound message (not append-only — score mutates)
  -- Hash chain on thread_trust_events provides audit trail
  -- Index: (current_score) WHERE current_score < 0.200
  --   (fast lookup of threads below trust threshold)

autobot_comms.thread_trust_events
  id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text
  thread_id         TEXT NOT NULL
  message_id        TEXT NOT NULL
  instruction_category TEXT NOT NULL CHECK (instruction_category IN (
    'NO_INSTRUCTION', 'ROUTINE_TASK', 'NOVEL_TASK',
    'META_INSTRUCTION', 'ESCALATION_TRIGGER'))
  score_delta       NUMERIC(5,3) NOT NULL
  score_after       NUMERIC(5,3) NOT NULL
  prev_hash         TEXT  -- SHA-256 hash chain
  detected_at       TIMESTAMPTZ NOT NULL DEFAULT now()

  -- Append-only: trigger prevents UPDATE/DELETE
  -- REVOKE TRUNCATE, DROP, ALTER from application roles
  -- Index: (thread_id, detected_at DESC)
```

Update the `autobot_comms` schema table in §7:

| Table | Purpose |
|-------|---------|
| `thread_trust` | Per-thread trust score with decay model (gradual poisoning defense) |
| `thread_trust_events` | Append-only audit log of all trust score changes |

### Phase Activation

Phase 1 (schema deployed in Gateway shadow mode).

---

## §14 Phase 1 Success Metrics — Scope Qualification (AMEND)

> **Source:** 2026-03-05 SWE benchmark gap analysis
> **Spec section affected:** §14, Phase 1 success metrics table
> **Change type:** AMEND — scope-qualify task success rate

### Proposed Change

Current text:

> | Task success rate | > 90% |

Replace with:

> | Task success rate | > 90% — measured as overall success rate inclusive of the CI reaction retry loop (§4 Automated Reaction Loops), scoped to Phase 1 task classes: schema-bound operations, SSL-compiled services, single-file code modifications, and data processing tasks. Multi-file codebase modification tasks (defined as: `routing_class = FULL` AND files modified > 2) are tracked separately as a leading indicator for Phase 2 capability gates, not as a Phase 1 exit criterion. |

### Phase Activation

Phase 1 — applies to metric definition.

---

## §18 Autonomous Software Composition — Empirical Citation (AMEND)

> **Source:** 2026-03-07 HuggingFace February 2026 papers review
> **Spec section affected:** §18, Service Specification Language subsection
> **Change type:** AMEND — add empirical citation

### Proposed Change

After the existing `P(success) = p^d` formula:

> RE-TRAC research (Microsoft, Feb 2026) provides independent empirical validation: structuring agent retry context as cumulative state across attempts (not just showing the last failure) produces 15-20% improvement with monotonically decreasing cost per retry. This confirms that reducing effective decision count `d` through structured decomposition and context engineering is the primary performance lever, consistent with the mathematical model above.

### Phase Activation

Phase 1 — reference only, no implementation change.

---

## §20 Deferred Items — Additions (AMEND)

> **Source:** Multiple sessions, 2026-03-05 through 2026-03-07
> **Spec section affected:** §20, deferred items list
> **Change type:** AMEND — add/update items

### Proposed Changes

**Add:**

> - **SWE capability gap monitoring (Phase 2 activation condition):** Track multi-file code task success rate (`routing_class = FULL` AND files modified > 2) as a Phase 2 leading indicator. If multi-file success rate exceeds 70% for 30 consecutive days, evaluate expanding Phase 2 exit criteria to include multi-file tasks. Source: SWE-EVO, SWE-Bench Pro gap analysis (2026-03-05).
>
> - **AdaptOrch dynamic topology routing (promoted to Phase 2 activation target):** AdaptOrch's formal framework for task-adaptive orchestration achieves 12-23% improvement over static single-topology baselines using identical models, with O(|V|+|E|) algorithm complexity. Phase 1 `routing_class` instrumentation collects the data this needs. Evaluate when `v_routing_class_effectiveness` data is available. Source: Multi-agent research sweep (2026-03-07).

**Update existing DMS entry to distinguish from Attention Matching:**

> - **DMS / KV cache compression for local executors (deferred to Phase 2-3):** NVIDIA's DMS achieves 5-8x compression via fine-tuned model self-compression (requires training). MIT's Attention Matching (2026) achieves up to 50x compression at inference time with no model modifications, completing in seconds. The vLLM project (GitHub issue #10646) is integrating Attention Matching into its core engine. Evaluate Attention Matching first as the lower-complexity option; DMS only if throughput requirements justify the fine-tuning cost. Source: KV cache compaction research (2026-03-07).

---

## Merge Checklist

- [ ] All entries reviewed by board (Dustin + Eric)
- [ ] No entries contradict each other
- [ ] No entries contradict existing spec (unless intentional — check §0 ROME addition, §7 pipeline expansion, §8 threat class additions)
- [ ] Each entry has a clear spec location (section number) — verified
- [ ] Change log is complete and accurate — verified (29 entries)
- [ ] Version number bumped: v0.7.0 → v0.7.1
- [ ] Entries ordered by spec section number — verified
- [ ] Phase activation conditions consistent with current phase (Phase 1) — verified
- [ ] Measurement criteria defined for every new/changed section — verified
- [ ] Open questions flagged for board decision:
  - [ ] §3: 2-file routing threshold — hard-coded vs configurable? (Recommend: hard-coded, P4)
  - [ ] §5: `output_artifacts` table — Phase 1 or Phase 2 schema? (Small addition, board call)

---

<!-- 
## Template for future additions:

## §X.X Section Title (AMEND | NEW | REPLACE)

> **Source:** [session date, research reference, discussion reference]
> **Spec section affected:** §X
> **Change type:** AMEND (modify existing) | NEW (add section) | REPLACE (full rewrite)

### [Content of the change]

### Phase Activation
[When this change takes effect in the phased plan]

### Measurement (P5)
[How to know if this change is working]

### Ecosystem References
[External sources that informed this change]
-->
