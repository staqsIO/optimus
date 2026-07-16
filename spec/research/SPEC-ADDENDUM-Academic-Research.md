# SPEC Addendum — Academic Research Gap Analysis (Consolidated)

> **Target spec version:** v0.8.0
> **Addendum started:** 2026-03-07
> **Last updated:** 2026-03-07
> **Status:** ACCUMULATING — Merge into running SPEC-ADDENDUM after board review
> **Sources:** arXiv (6 papers), Papers with Code (6 papers/repos)
> **Supporting documents:**
> - `arxiv-gap-analysis-march-2026.md` (detailed analysis)
> - `SPEC-ADDENDUM-PAPERS-WITH-CODE-2026-03-07.md` (detailed analysis)
> **How to use:** Each section references the spec section it modifies, ordered by spec section number for clean application. When ready, merge into running SPEC-ADDENDUM, then apply to SPEC.md at next version bump.

---

## Master Change Log

| Date | Spec § | Change Type | Summary | Gap # | Severity | Source |
|------|--------|-------------|---------|-------|----------|--------|
| 2026-03-07 | §3 | AMEND | Learned routing activation criteria | GAP-7 | LOW | arXiv (DAAO) |
| 2026-03-07 | §3, §4 | NEW | Typed handoff schemas for inter-tier boundaries | GAP-10 | MEDIUM | PwC (MetaGPT, ChatDev) |
| 2026-03-07 | §4 | AMEND | Plan-then-execute constraint for Q4 data tasks | GAP-4 | MEDIUM | arXiv (Tramèr) |
| 2026-03-07 | §4, §6 | AMEND | Per-task tool scoping in orchestration layer | GAP-9 | MEDIUM | PwC (Systems Security) |
| 2026-03-07 | §5 | AMEND | Quarantined Processing pattern for Q4 data (Dual LLM) | GAP-1 | HIGH | arXiv (Tramèr) |
| 2026-03-07 | §5 | AMEND | Data provenance tagging on quarantined output — extends GAP-1 | GAP-8 | HIGH | PwC (CaMeL) |
| 2026-03-07 | §6 | AMEND | MCP threat mitigations: name collision, description injection, dynamic server block | GAP-3 | HIGH | arXiv (SoK) |
| 2026-03-07 | §8 | AMEND | Causal Trace Analysis for Tier 2 auditor | GAP-2 | MEDIUM | arXiv (AgentArmor) |
| 2026-03-07 | §8 | AMEND | Operational guardrail compliance as distinct evaluation dimension | GAP-11 | LOW | PwC (ASTRA) |
| 2026-03-07 | §11 | AMEND | Four MAST failure modes + detection mechanisms | GAP-5 | MEDIUM | arXiv (Cemri/Berkeley) |
| 2026-03-07 | §19 | AMEND | Decision Quality scoring dimension | GAP-6 | LOW | arXiv (Drammeh) |
| 2026-03-07 | §8, §14 | AMEND | Reliability metrics: pass@8 consistency, output stability, cost variance | GAP-12 | MEDIUM | SS (CLEAR, Agent Reliability) |
| 2026-03-07 | §4, §5 | AMEND | Inter-agent trust levels: PROVISIONAL flag on Q3 data | GAP-13 | MEDIUM | SS (Agentic AI Security, Institutional AI) |
| 2026-03-07 | §10, §8 | AMEND | cost_per_success metric in v_agent_efficiency_comparison | GAP-14 | LOW | SS (CLEAR, AgentTaxo) |

---

## Priority Summary for Board Review

### Phase 1 — Implement Now (4 HIGH, 3 MEDIUM)

**HIGH — Security-critical for SOC 2 product:**
1. **GAP-1 + GAP-8: Quarantined Processing with Data Provenance** (§5) — Dual LLM separation for Q4 data. Quarantined LLM extracts structured data from untrusted content; provenance tags persist through pipeline; policy checks on tool arguments based on data origin. *Combined from Tramèr (arXiv) + CaMeL (Google DeepMind).*
2. **GAP-3: MCP Threat Mitigations** (§6) — Tool name collision detection, description sanitization, dynamic server block. Policy additions to Tool Acceptance Policy.
3. **GAP-9: Per-Task Tool Scoping** (§4/§6) — Orchestrator specifies tool subset per task; JWT scoped to task tools only. Zero cost, high security value.

**MEDIUM — Quality and robustness:**
4. **GAP-4: Plan-Then-Execute for Q4 Tasks** (§4) — Executor commits tool plan before execution; no LLM re-evaluation between tool calls. Complements quarantined processing.
5. **GAP-10: Typed Handoff Schemas** (§3/§4) — Structured schemas for Orchestrator→Executor, Executor→Reviewer, Reviewer→Orchestrator boundaries. Highest ROI quality intervention per MetaGPT data.
6. **GAP-5: MAST Failure Modes** (§11) — Four additional failure modes (context loss, spec ambiguity, premature termination, delegation failure) with detection mechanisms.

**MEDIUM — Measurement and trust:**
7. **GAP-12: Reliability Metrics** (§8/§14) — pass@8 consistency, output stability, cost variance. CLEAR data shows accuracy-only evaluation predicts production success at ρ=0.41; multi-dimensional at ρ=0.83.

### Phase 2 — Activate When Ready (3 MEDIUM, 3 LOW)

8. **GAP-2: Causal Trace Analysis** (§8) — Tier 2 auditor reconstructs data flow graphs. Activates when Tier 2 comes online.
9. **GAP-13: Inter-Agent Trust Formalization** (§4/§5) — PROVISIONAL flag on Q3 data; Orchestrator tool auth constraint prevents structural decisions based on unreviewed data.
10. **GAP-11: Operational Guardrail Compliance Testing** (§8) — Separate from jailbreak resistance. Define 10 synthetic test scenarios in Phase 1; execute in Phase 2.
11. **GAP-6: Decision Quality Scoring** (§19) — Board scores Validity/Specificity from day one; Correctness backfilled at 90-day lag. Feeds G4.
12. **GAP-7: Learned Routing Criteria** (§3) — Explicit activation triggers. Phase 1 collects data; Phase 2 evaluates.
13. **GAP-14: Cost-per-Success Metric** (§10/§8) — cost_per_success in v_agent_efficiency_comparison. ~5 LOC SQL.

---

## §3 Cost-Aware Routing (AMEND) — GAP-7 + GAP-10 (partial)

> **Gap references:** GAP-7 (LOW — learned routing), GAP-10 (MEDIUM — handoff schemas, routing portion)
> **Sources:** DAAO (arXiv:2509.11079), MetaGPT (ICLR 2024), ChatDev 2.0 (NeurIPS 2025)

### GAP-7: Learned Routing Activation Criteria

Insert after the "Cost impact" paragraph in §3:

**Learned routing activation criteria (v0.8):**

The Phase 1 heuristic is appropriate at current volumes. Explicit criteria for evaluating a learned replacement:

**Activation trigger (ALL must be true):**
1. `v_routing_class_effectiveness` shows misclassification rate > 15% for any task type over 30-day window
2. Task volume exceeds 500/day
3. Phase 2 has been reached

**Data already being collected (Phase 1):** `routing_class`, `routing_class_final`, `context_profile_json`, cost/latency in `llm_invocations`, outcomes in `state_transitions`. Complete training set — no additional instrumentation required.

**Upgrade path:** Logistic regression first (P4: boring infrastructure). VAE-based (DAAO approach) only if logistic regression plateaus above 10% misclassification with 90+ days of training data.

**Kill criterion:** Revert to heuristic if learned router's misclassification exceeds heuristic's for 14 consecutive days.

### Phase Activation
Phase 1: Collect data. Phase 2: Evaluate triggers. Phase 3+: VAE if needed.

### Measurement (P5)
| Metric | Target |
|--------|--------|
| Heuristic misclassification rate | < 15% |
| Learned router vs. heuristic (when deployed) | Learned < heuristic |

---

## §3/§4 Inter-Tier Handoff Schemas (NEW) — GAP-10

> **Gap reference:** GAP-10 (MEDIUM)
> **Sources:** MetaGPT (ICLR 2024 — "Code = SOP(Team)"), ChatDev (ACL 2024), Code in Harmony survey (OpenReview)

### Content

Insert as new subsection §3.X "Inter-Tier Handoff Schemas":

MetaGPT's 85.9% Pass@1 came from requiring structured intermediate outputs at every agent boundary, not from model quality or agent count. Define typed schemas for critical handoff points:

**1. Orchestrator → Executor (Task Specification Schema):**
```json
{
  "task_id": "TASK-XXXX",
  "objective": "One-sentence task description",
  "input_data": {"source": "...", "classification": "Q1|Q2|Q3|Q4"},
  "output_schema": {"type": "object", "properties": {"..."}},
  "task_tool_scope": ["tool_a", "tool_b"],
  "constraints": ["max_tokens: 4096", "no_external_network"],
  "acceptance_criteria": [
    {"id": "AC-1", "criterion": "...", "verification_method": "schema|review|test"}
  ]
}
```

**2. Executor → Reviewer (Completion Claim Schema):**
```json
{
  "task_id": "TASK-XXXX",
  "output_artifact": "...",
  "criteria_mapping": [
    {"criterion_id": "AC-1", "output_section": "...", "self_assessment": "met|partial|not_addressed"}
  ],
  "tools_used": [{"tool": "tool_a", "invocations": 3}],
  "token_cost": {"input": 2400, "output": 800, "total_usd": 0.012}
}
```

**3. Reviewer → Orchestrator (Review Decision Schema):**
```json
{
  "task_id": "TASK-XXXX",
  "verdict": "approved|rejected|escalated",
  "per_criterion_assessment": [
    {"criterion_id": "AC-1", "result": "pass|fail|partial", "notes": "..."}
  ],
  "rejection_reasons": ["AC-2 not addressed", "output format incorrect"],
  "suggested_fixes": ["..."]
}
```

Schemas enforced by orchestration layer (P2). An executor cannot transition to `review` without a valid completion claim passing schema validation. The `criteria_mapping` field directly mitigates the "premature termination" failure mode (GAP-5).

### Phase Activation
Phase 1. Define schemas as part of agent_configs setup.

### Measurement (P5)
| Metric | Target |
|--------|--------|
| Schema validation pass rate (executor completion claims) | > 95% |
| Criteria mapping completeness (all criteria addressed) | > 90% |
| Rework rate (tasks rejected for schema non-compliance) | < 5% |

---

## §4 Agent Runtime (AMEND) — GAP-4 + GAP-9

> **Gap references:** GAP-4 (MEDIUM — plan-then-execute), GAP-9 (MEDIUM — per-task tool scoping)
> **Sources:** Tramèr et al. (arXiv:2506.08837), CaMeL (arXiv:2503.18813), Systems Security Foundations (ePrint 2025/2173)

### GAP-4: Plan-Then-Execute for Q4 Data Tasks

Insert after step 5 (EXECUTE) in Agent Runtime Loop:

For Q4-classified executor tasks, execution splits into two phases:

**Phase A — Plan commitment:** Executor declares intended tool sequence as structured data. Plan committed to work item before any tool invocation.

**Phase B — Sequential execution:** Orchestration layer invokes tools per plan. LLM is NOT re-invoked between steps. Tool outputs flow to next step per committed plan.

**Why:** Prevents tool output from untrusted data influencing subsequent tool selection. Untrusted data can affect data flowing between tools (unavoidable) but cannot affect which tools are called (the injection escalation path).

**Failure handling:** Tool call failure → entire plan abandoned → task transitions to `failed`. No mid-execution plan revision (would reintroduce LLM re-evaluation). Retry generates fresh plan.

**Complements Quarantined Processing (GAP-1/8):** Together they provide two layers:
1. Raw Q4 data → quarantined LLM → structured extraction → schema validation → executor
2. Executor → committed plan → deterministic execution → no LLM re-evaluation

### GAP-9: Per-Task Tool Scoping

Insert in §4 Agent Runtime Loop at step 3 (GUARDRAIL PRE-CHECK):

When Orchestrator creates a task, it specifies the **subset** of the agent's role-level tools required:

```json
{
  "task_id": "TASK-0042",
  "assigned_to": "executor-01",
  "task_tool_scope": ["read_file", "attach_output"]
}
```

Orchestration layer enforces `task_tool_scope` as further restriction on role-level `tools.allowed`. Agent's JWT for this task includes only task-scoped tools. Defense-in-depth: even if all other protections fail, available tools are minimized.

Implementation: WHERE clause addition to tool authorization check. Orchestrator already determines tool needs when setting `routing_class` — this extends that decision.

### Phase Activation
Both Phase 1. GAP-4 required for SOC 2 product. GAP-9 is low-effort, high-value.

### Measurement (P5)
| Metric | Target |
|--------|--------|
| Plan compliance rate (Q4 tasks) | 100% (structural) |
| Plan generation success rate | > 90% |
| Tool scope reduction (avg tools per task vs role tools) | > 30% reduction |

---

## §5 Content Sanitization (AMEND) — GAP-1 + GAP-8

> **Gap references:** GAP-1 (HIGH — quarantined processing), GAP-8 (HIGH — data provenance)
> **Sources:** Tramèr et al. (arXiv:2506.08837), CaMeL (arXiv:2503.18813, code: github.com/google-research/camel-prompt-injection), ReversecLabs code samples

### Combined: Quarantined Processing with Data Provenance

Insert after "Sanitization specification" in §5:

**Quarantined Processing Pattern with Data Provenance (v0.8)**

For Q4 (untrusted external) data tasks, structurally separate data extraction from tool execution:

```
┌──────────────────────────────────────────────────────┐
│  QUARANTINED PROCESSING (Q4 data tasks only)         │
│                                                      │
│  1. Orchestrator identifies Q4-data-bearing task     │
│                                                      │
│  2. QUARANTINED LLM (tool-less, sandboxed):          │
│     - Receives raw untrusted content                 │
│     - Extracts structured data per output schema     │
│     - Each field tagged with provenance metadata     │
│     - Has NO tool access, NO network, NO state       │
│     - Model: Haiku 4.5                               │
│                                                      │
│  3. SCHEMA VALIDATION + PROVENANCE GATE (no LLM):   │
│     - Validates structure against schema             │
│     - Verifies provenance tags on all fields         │
│     - Rejects freeform text, injection patterns      │
│                                                      │
│  4. EXECUTOR (task-scoped tools per GAP-9):          │
│     - Receives ONLY validated structured data        │
│     - Never sees raw untrusted content               │
│     - Provenance-based tool argument policies:       │
│       · Q4 values → read-only lookups OK             │
│       · Q4 values → communication targets BLOCKED    │
│       · Q4 values → code/SQL construction BLOCKED    │
└──────────────────────────────────────────────────────┘
```

**Data provenance schema (extends quarantined output):**
```json
{
  "extracted_fields": [
    {"field": "company_name", "value": "Acme Corp", "provenance": "Q4", "source": "customer_doc_001"},
    {"field": "control_id", "value": "CC-7.1", "provenance": "Q4", "source": "customer_doc_001"}
  ]
}
```

**Provenance-based tool argument policies (enforced by orchestration layer, P2):**
- Q4-provenance values: permitted as read-only lookup keys (searching compliance DB)
- Q4-provenance values: BLOCKED as communication targets (email addresses, URLs, API endpoints) without explicit board-approved allowlisting
- Q4-provenance values: BLOCKED for code/SQL query construction

**Key constraints:**
- Quarantined LLM: zero tool access, JWT with no tool permissions, SELECT-only DB role on task input
- Schema defined by Orchestrator at task creation, not by quarantined LLM
- Validation gate is deterministic code (P2), not LLM
- Schema validation failure → task `failed` with quarantine context → normal §11 recovery

**CaMeL reference:** Google DeepMind's CaMeL (arXiv:2503.18813) implements full capability-based tracking (~2000 LOC). Our provenance tagging is a lightweight subset (~200-400 LOC) appropriate for Phase 1 scope. CaMeL achieves 77% task completion with provable security (vs 84% undefended) — a 7% security tax the board should explicitly accept for Q4 data tasks.

### Phase Activation
Phase 1: Required for SOC 2 product. Phase 2+: Extend to all Q4 data products. Evaluate Q3 based on Phase 1 threat_memory.

### Measurement (P5)
| Metric | Target |
|--------|--------|
| Schema validation rejection rate | < 10% |
| Injection attempts reaching executor (Q4 path) | 0% (structural) |
| Provenance policy violations caught | Track rate (informational) |
| Cost overhead per Q4 task | < $0.005 |
| Task success rate (quarantined vs. direct) | Quarantined ≥ direct |

### Ecosystem References
| Source | Key Takeaway |
|--------|-------------|
| Tramèr et al. (arXiv:2506.08837) | 6 design patterns; Dual LLM provides provable injection resistance |
| CaMeL (arXiv:2503.18813) | Capability-based data flow tracking; 77% tasks with provable security |
| CaMeL code (github.com/google-research/camel-prompt-injection) | Reference implementation; ~2000 LOC Python |
| ReversecLabs code samples (github.com/ReversecLabs/design-patterns-for-securing-llm-agents-code-samples) | Working code for all 6 patterns |
| Willison (2023) Dual LLM Pattern | Original formulation |
| AgentArmor (arXiv:2508.01249) | Untraceable data dependencies are root cause of vulnerabilities |

---

## §6 Tool Integrity Layer (AMEND) — GAP-3

> **Gap reference:** GAP-3 (HIGH)
> **Sources:** SoK on Agentic Coding (arXiv:2601.17548), MCP Security SoK (arXiv:2512.08290)

### MCP-Specific Security Requirements

**1. Tool Name Collision / Squatting**
- Levenshtein distance check (≤ 2 edits = flagged for review)
- Unicode homoglyph detection
- ASCII-only alphanumeric + underscores for tool names
- Semantic overlap requires board justification

**2. Tool Description Injection**
- Descriptions pass through §5 sanitization pipeline before agent context loading
- Hard 500-character limit, truncated by orchestration layer
- Descriptions stored separately from schemas; loaded only on clarification request

**3. Dynamic MCP Server Governance**
- Phase 1: Static-only MCP definitions. Dynamic servers BLOCKED.
- Phase 2+: Runtime schema pinning — orchestration layer hashes MCP manifest at task start; mid-task changes block tool invocations

**New tool classification row:**

| Risk Class | Description | Registration | Execution |
|-----------|-------------|-------------|-----------|
| MCP-External | External MCP servers | Board + security review + name collision + description sanitization | Sandboxed, schema-pinned, output sanitized |

### Phase Activation
Phase 1: All three mitigations. Phase 2: Runtime schema pinning, MCP-External class activation.

### Measurement (P5)
| Metric | Target |
|--------|--------|
| Dynamic MCP server block rate (Phase 1) | 100% |
| Description sanitization flag rate | < 1% |

---

## §8 Audit and Observability (AMEND) — GAP-2 + GAP-11

> **Gap references:** GAP-2 (MEDIUM — causal trace analysis), GAP-11 (LOW — operational guardrail compliance)
> **Sources:** AgentArmor (arXiv:2508.01249), PCAS (arXiv:2602.16708), ASTRA (Intuit, Dec 2025)

### GAP-2: Causal Trace Analysis (Tier 2 Addition)

Add to Tier 2 AI Auditor scope:

**Causal trace analysis (v0.8):** Daily batch reconstruction of data flow graphs from `state_transitions` + `llm_invocations`:
1. **Untrusted data propagation:** Q3/Q4 data flowing into decisions without Reviewer/quarantine gate
2. **Cross-agent influence chains:** Unreviewed executor output influencing Orchestrator decisions
3. **Tool invocation provenance:** Tool calls influenced by untrusted data sources

Retrospective analysis (not real-time). Existing tables capture sufficient data. Findings → `threat_memory` → graduated escalation.

**Phase:** Phase 2 activation. Phase 1: ensure `data_classification` populated on all work items.

### GAP-11: Operational Guardrail Compliance Testing

Add to Tier 2 scope:

**Operational guardrail compliance (v0.8):** ASTRA research shows negative correlation between jailbreak resistance and agent-scenario guardrail compliance. These require separate evaluation:
- **Synthetic multi-step test scenarios:** 10 scenarios requiring 5+ tool calls with embedded guardrail boundaries. Score compliance throughout sequence, not just initial steps.
- **Compliance degradation over sequence length:** Track whether agents respect guardrails on step 1 but violate on step 7+.

**Phase:** Phase 1: define 10 synthetic scenarios. Phase 2: automated execution.

### Measurement (P5)
| Metric | Target |
|--------|--------|
| Causal trace: trust boundary bypass detection | > 90% synthetic violations caught |
| Causal trace: false positive rate | < 5% |
| Guardrail compliance: multi-step scenario pass rate | > 95% |

---

## §11 Failure Modes (AMEND) — GAP-5

> **Gap reference:** GAP-5 (MEDIUM)
> **Source:** Cemri et al. (arXiv:2503.13657, NeurIPS 2025 Spotlight)

### Four MAST Failure Modes

Add to §11 failure table:

| Failure | Detection | Response | Recovery |
|---------|-----------|----------|----------|
| **Context loss in multi-hop** | `context_fidelity_score` in `context_profile_json`. Score < 0.7 flags degradation. | Re-issue task with explicit parent context elements. | Persistent (>30% in workstream): load parent criteria as Q1 directly. |
| **Specification ambiguity** | Reviewer rejection pattern: "meets literal criteria, wrong approach." Track in `threat_memory`. | Reject with structured feedback on misinterpretation. | Recurring pattern: Orchestrator revises task templates. |
| **Premature termination** | Require Reviewer to map each criterion to output section. Missing mappings = auto-reject. | Reject with unaddressed criteria list. | Executor premature termination >20% in 7 days: quality alert. |
| **Delegation failure** | CI failure on wrong-scope output. Reviewer "outside capability" rejection. Track routing mismatch. | Re-queue to correct executor. Add routing entry if missing. | >3 same-type misroutes: Orchestrator prompt review. |

### Phase Activation
Phase 1: Track all four from day one using existing infrastructure.

### Measurement (P5)
| Metric | Target |
|--------|--------|
| Context loss flag rate | < 10% of multi-hop tasks |
| Premature termination rate per executor | < 10% |
| Delegation mismatch rate | < 5% |

---

## §19 Strategy Evaluation Protocol (AMEND) — GAP-6

> **Gap reference:** GAP-6 (LOW)
> **Source:** Drammeh (arXiv:2511.15755)

### Decision Quality Scoring

Add to "Measuring Strategy Quality (P5)" in §19:

**Decision Quality (DQ)** scored per decision in `strategic_decisions`:

| Dimension | Score | Weight | When Scored |
|-----------|-------|--------|-------------|
| Validity | 1-5 | 0.3 | At board review |
| Specificity | 1-5 | 0.3 | At board review |
| Correctness | 1-5 | 0.4 | Retroactively (90-day lag) |

**DQ composite = (V × 0.3) + (S × 0.3) + (C × 0.4)**

G4 gate: DQ composite > 3.5 averaged over rolling 90-day window.

```sql
ALTER TABLE agent_graph.strategic_decisions
  ADD COLUMN dq_validity INTEGER CHECK (dq_validity BETWEEN 1 AND 5),
  ADD COLUMN dq_specificity INTEGER CHECK (dq_specificity BETWEEN 1 AND 5),
  ADD COLUMN dq_correctness INTEGER CHECK (dq_correctness BETWEEN 1 AND 5),
  ADD COLUMN dq_composite NUMERIC(3,2) GENERATED ALWAYS AS (
    dq_validity * 0.3 + dq_specificity * 0.3 + dq_correctness * 0.4
  ) STORED;
```

### Phase Activation
Phase 1: Board scores V/S from day one. C backfilled at week 12+.

---

## Appendix A: Complete Source Bibliography

### arXiv Papers (Tier 1-2)
| Paper | arXiv ID | Date | Key Contribution |
|-------|----------|------|-----------------|
| Why Do Multi-Agent LLM Systems Fail? | 2503.13657 | Mar 2025 | 14 failure modes / MAST taxonomy |
| Design Patterns for Securing LLM Agents | 2506.08837 | Jun 2025 | 6 provable security patterns |
| Multi-Agent Orchestration for Decision Support | 2511.15755 | Nov 2025 | Zero quality variance; DQ metric |
| SoK: Prompt Injection on Agentic Coding | 2601.17548 | Jan 2026 | 78 sources; MCP threat vectors |
| AgentArmor | 2508.01249 | Aug 2025 | PDG-based security; ASR → 3% |
| DAAO | 2509.11079 | Sep 2025 | Difficulty-aware routing |

### Semantic Scholar (Unique Finds)
| Paper | ID | Date | Key Contribution |
|-------|-----|------|-----------------|
| Institutional AI: Governing LLM Collusion via Public Governance Graphs | arXiv:2601.11369 | Jan 2026 | Governance graphs > constitutional (prompt-only); strongest Optimus validation |
| CLEAR: Multi-Dimensional Enterprise Evaluation | arXiv:2511.14136 | Nov 2025 | Accuracy predicts production at ρ=0.41; CLEAR at ρ=0.83; pass@8 drops to 25% |
| Towards a Science of AI Agent Reliability | arXiv:2602.16666 | Feb 2026 | 12 reliability metrics; capability ≠ reliability |
| TRiSM for Agentic AI | arXiv:2506.04133 | Jun 2025 | Trust/Risk/Security lifecycle framework |
| Agentic AI Security: Threats, Defenses, Evaluation | arXiv:2510.23883 | Oct 2025 | 94.4% agents vulnerable to injection; 100% to inter-agent trust exploits |
| Token Distribution of LLM MAS (AgentTaxo) | OpenReview | 2025 | Verification = 72% of tokens; input:output = 2:1 to 3:1 |
| Efficient Context Management (NeurIPS DL4Code) | TUM/JetBrains | Dec 2025 | Masking > summarization; summarization hides failure signals |

### Papers with Code
| Paper/System | Code Repository | Key Result |
|-------------|----------------|------------|
| CaMeL (Google DeepMind) | github.com/google-research/camel-prompt-injection | 77% tasks with provable security |
| Security Pattern Samples | github.com/ReversecLabs/design-patterns-for-securing-llm-agents-code-samples | All 6 patterns implemented |
| MetaGPT | github.com/FoundationAgents/MetaGPT | 85.9% Pass@1; SOP-driven |
| ChatDev 2.0 | github.com/OpenBMB/ChatDev | RL orchestrator (NeurIPS 2025) |
| Systems Security Foundations | ePrint 2025/2173 | Android sandbox analogy for agents |
| ASTRA | Intuit (Dec 2025) | Jailbreak ≠ guardrail compliance |

### Key Repos for Phase 1 Implementation (Eric)
| Repo | Priority | What to Study |
|------|----------|--------------|
| google-research/camel-prompt-injection | HIGH | `interpreter.py`, `policy.py` — capability enforcement |
| ReversecLabs/design-patterns-for-securing-llm-agents-code-samples | HIGH | `04_dual-llm/`, `02_plan-then-execute/`, `03_map-reduce/` |
| FoundationAgents/MetaGPT | MEDIUM | `roles/`, `schema.py` — structured handoff patterns |
| OpenBMB/ChatDev (puppeteer branch) | LOW (Phase 4+ ref) | `puppeteer/` — RL orchestrator training |

---

## Appendix B: Merge Checklist

- [ ] All 14 entries reviewed by board (4 HIGH, 7 MEDIUM, 3 LOW)
- [ ] No entries contradict existing spec or each other
- [ ] GAP-1 and GAP-8 consolidated (not applied separately)
- [ ] GAP-4, GAP-9, and GAP-1/8 form coherent Q4 defense stack
- [ ] Phase activation conditions consistent with §14 Phase 1 scope
- [ ] Version number bumped to v0.8.0 on merge
- [ ] Changelog updated with all 11 entries
