# OPT-83 — Structured Agent Behavioral Contracts: agents.md Schema Expansion

**Status:** PENDING BOARD REVIEW — SPEC changes require both board members (Dustin + Eric) per CLAUDE.md. Do NOT edit SPEC.md until both approve.
**Companion issue:** OPT-83 (Linear). Paired with the agents.md compiler (separate issue — not in scope here).
**Design principles cited:** P2 (infrastructure enforces), P3 (transparency by structure), P5 (measure before you trust).

---

## 1. Problem Statement

`agents.json` today captures tier/subTier, model, tools, guardrails, and hierarchy — the *capability* envelope. It does not capture:

1. **Communication style** — tone, formality, and structural conventions for agent-authored output (drafts, plans, task comments). Enforcement today is prompt-only. Prompt-only = unenforced (P2 violation; Runlayer Feb 2026: 91.3% injection bypass rate on prompt-layer-only controls).
2. **Workflow phases** — the explicit, observable stages an agent traverses for a work item. Without them, phase transitions are invisible to the Reviewer and to the audit log (P3 gap).
3. **Tool invocation expectations** — which tools are required vs optional per phase. Today `tools` is a flat allow-list. The Reviewer has no structured basis for scoring whether an agent invoked the right tools in the right phase.

The origin pattern: agency-agents persona-depth approach adapted for P2 enforcement — behavioral contracts that live in config (infra layer), not in system prompts (advisory layer).

---

## 2. Proposed SPEC §2 Amendment (Agent Configuration Schema)

> SPEC §2 ("Agent Tiers") currently defines sub-tiers as "implementation-defined — they do not alter the infrastructure constraints of the parent tier." This amendment adds a new sub-section to §2 defining the `behavioral_contract` block as a required field in every `agents.json` entry. It does not change the Task Graph (§3) — it adds a new config schema layer consumed by the Reviewer and logged to `agent_graph.state_transitions`.

### 2.1 New Schema Fields

Each agent entry in `autobot-inbox/config/agents.json` gains a top-level `behavioral_contract` object:

```jsonc
"behavioral_contract": {
  // ── Communication style ──────────────────────────────────────────────────
  "communication": {
    "tone": "direct | advisory | inquisitive | neutral",
    "formality": "formal | semi-formal | informal",
    "structure": "bullet | prose | structured-report | json-only",
    "max_output_tokens_soft": 512,          // advisory ceiling; Reviewer flags overruns
    "prohibited_patterns": [               // regex list; Reviewer scores violations
      "\\bI think\\b",
      "\\bmaybe\\b"
    ]
  },
  // ── Workflow phases ───────────────────────────────────────────────────────
  "phases": [
    {
      "name": "ingest",                    // machine-readable; logged to state_transitions
      "label": "Ingest & Classify",        // human-readable for board UI
      "required_tools": ["task_read"],     // must be called; Reviewer fails conformance if absent
      "optional_tools": ["message_fetch"], // may be called; flagged if called outside this phase
      "max_duration_s": 30,               // per-phase timeout; infra enforces via task_events
      "exit_condition": "classification_label IS NOT NULL"  // DB-observable predicate
    }
    // ...additional phases
  ],
  // ── Reviewer scoring weights ──────────────────────────────────────────────
  "conformance_weights": {
    "phase_sequence": 0.40,   // phases executed in declared order
    "tool_coverage": 0.35,    // required tools called in correct phase
    "communication": 0.25     // output matches tone/structure/prohibited_patterns
  }
}
```

**Field types:**

| Field | Type | Required | Notes |
|---|---|---|---|
| `communication.tone` | enum string | yes | One of four values; drives Reviewer rubric |
| `communication.formality` | enum string | yes | |
| `communication.structure` | enum string | yes | `json-only` signals machine-output agents |
| `communication.max_output_tokens_soft` | integer | no | Default: tier ceiling |
| `communication.prohibited_patterns` | string[] (regex) | no | Empty = no pattern check |
| `phases[].name` | string | yes | Logged as `phase` in `state_transitions.metadata` |
| `phases[].label` | string | yes | Board display only |
| `phases[].required_tools` | string[] | yes | Subset of agent's top-level `tools` allow-list |
| `phases[].optional_tools` | string[] | no | |
| `phases[].max_duration_s` | integer | no | Default: tier timeout |
| `phases[].exit_condition` | string | no | SQL-observable predicate (P3); logged, not evaluated live |
| `conformance_weights` | object | yes | Must sum to 1.0 |

### 2.2 Example Agent Contract — `executor-responder`

```jsonc
"executor-responder": {
  "id": "executor-responder",
  "type": "executor",
  "tier": "Executor",
  "subTier": "responder",
  "enabled": true,
  "model": "claude-haiku-4-5-20251001",
  "maxTokens": 2000,
  "temperature": 0.3,
  "tools": ["task_read", "task_update", "draft_create", "voice_query"],
  "guardrails": ["G1", "G3", "G4", "G5"],
  "hierarchy": {
    "canDelegate": [],
    "reportsTo": "orchestrator",
    "escalatesTo": "reviewer"
  },
  "behavioral_contract": {
    "communication": {
      "tone": "advisory",
      "formality": "semi-formal",
      "structure": "prose",
      "max_output_tokens_soft": 400,
      "prohibited_patterns": ["\\bI am an AI\\b", "\\bAs an AI\\b"]
    },
    "phases": [
      {
        "name": "load_context",
        "label": "Load Task + Voice Profile",
        "required_tools": ["task_read", "voice_query"],
        "optional_tools": [],
        "max_duration_s": 15,
        "exit_condition": "task metadata and voice tone loaded"
      },
      {
        "name": "draft",
        "label": "Draft Response",
        "required_tools": ["draft_create"],
        "optional_tools": [],
        "max_duration_s": 45,
        "exit_condition": "action_proposals row created with status=draft"
      },
      {
        "name": "mark_complete",
        "label": "Mark Task Complete",
        "required_tools": ["task_update"],
        "optional_tools": [],
        "max_duration_s": 5,
        "exit_condition": "work_item.status = 'review'"
      }
    ],
    "conformance_weights": {
      "phase_sequence": 0.40,
      "tool_coverage": 0.35,
      "communication": 0.25
    }
  }
}
```

---

## 3. Reviewer Conformance Scoring

The Reviewer (`agents/reviewer.js`) already gates work items in the `review` state. With this amendment it gains a **behavioral conformance score** alongside its existing quality checks.

### 3.1 Scoring Algorithm (infrastructure-observable, P2/P3)

The Reviewer reads the agent's `behavioral_contract` from `agent_graph.agent_configs` (already versioned by `config_hash`) and scores the completed work item against three dimensions:

**A. Phase Sequence (40%)**
Source: `agent_graph.state_transitions` rows for the work item, ordered by `created_at`.
Score: fraction of declared phases that appear in declared order (longest-increasing-subsequence match, not strict contiguous).
Fail condition: required phase `name` absent from transitions entirely → phase_sequence = 0.

**B. Tool Coverage (35%)**
Source: `agent_graph.action_log` (tool invocations, already logged per P3).
Score: for each phase, `required_tools` called in that phase window → fraction covered.
Fail condition: required tool called in wrong phase → 0.5 credit (called but misphased).

**C. Communication (25%)**
Source: `agent_graph.action_proposals.body` (the draft text) or `task_comments`.
Score: prohibited_pattern violations → each match deducts `1/len(prohibited_patterns)` from 1.0. Output token count vs `max_output_tokens_soft` → soft warning logged, no deduction unless 2x overage.

**Composite score = weighted sum.** Thresholds:
- `≥ 0.85` → pass, work item advances to `completed`
- `0.60–0.85` → conditional pass + Reviewer comment logged to `state_transitions.metadata`
- `< 0.60` → fail, work item returns to `in_progress`, retry counter incremented (existing retry logic, max 3)

The score and per-dimension breakdown are written to `state_transitions.metadata` as `{"conformance": {"score": 0.91, "phase_sequence": 1.0, "tool_coverage": 0.86, "communication": 0.88}}` — observable in the audit log without any new tables (P3).

### 3.2 What the Reviewer Does NOT Do

- Does not re-read agent system prompts. The contract is in `agent_configs`, not prompts.
- Does not score subjective quality (that remains the existing Reviewer LLM pass).
- Does not block on `exit_condition` predicates — those are logged as metadata for future tooling, not evaluated live in Phase 1.

---

## 4. P2 / P3 Alignment

| Principle | How this amendment satisfies it |
|---|---|
| **P2 — Infrastructure enforces** | Contract lives in `agent_configs` (versioned, hash-checked). Reviewer reads `state_transitions` + `action_log` (DB records), not agent self-reports. Prompt restates the contract advisory-only. |
| **P3 — Transparency by structure** | Phase names are written to `state_transitions.metadata` as a side effect of the agent loop's existing `transition_state()` call — zero new logging code. Conformance score is appended to the Reviewer's `state_transitions` row automatically. |
| **P5 — Measure before you trust** | Conformance score history per agent enables a data-driven capability gate: sustained `score ≥ 0.85` over N work items can unlock sub-tier promotion without a calendar gate. |

**What is still prompt-advised (not infra-enforced):**
- The agent knowing its phase name to log it. The agent loop injects the declared phase list into context at task-claim time; the agent stamps the phase in its tool call metadata. A future hardening pass (post-Phase 1) can enforce phase tagging at the `transition_state()` boundary.

---

## 5. Migration / Rollout

This amendment is **additive and backward-compatible**:

1. `behavioral_contract` is a new optional top-level key in `agents.json`. Agents without it skip the conformance scoring step (Reviewer falls through to existing quality check only).
2. No new DB migrations required. All data lands in existing `state_transitions.metadata` jsonb and `action_log`.
3. Rollout order: add contracts to `reviewer.js` and one executor (e.g., `executor-responder`) first; run two weeks of scoring in observe-only mode (score logged but threshold not enforced); then enable enforcement.
4. The **agents.md compiler** (paired issue, not this ticket) reads `behavioral_contract` and generates per-agent Markdown documentation. Until that compiler ships, the `example agent contract` block above serves as the live reference.
5. Phase 1 exit condition: `exit_condition` field is logged but not evaluated. Evaluation (DB-observable predicate check) is a Phase 2 hardening item.

---

## 6. Board Decision Required

This is a SPEC §2 amendment. Both board members must approve before `behavioral_contract` fields are added to `agents.json` or the Reviewer scoring logic is merged.

**Questions for board:**

1. **Score thresholds** (0.85 pass / 0.60 conditional) — acceptable, or tighten to 0.90/0.70?
2. **Communication dimension** — is prohibited_patterns regex the right mechanism, or should pattern violations be a hard-fail (return-to-in_progress) rather than a weighted deduction?
3. **Rollout gate** — observe-only for 2 weeks before enforcement: acceptable, or shorter?
4. **Scope of Phase 1** — start with `executor-responder` only, or add all executors simultaneously?
