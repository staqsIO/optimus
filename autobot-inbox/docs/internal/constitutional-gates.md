---
title: "Constitutional Gates"
description: "G1 through G7 gates: enforcement mechanisms, parameters, failure behavior"
---

# Constitutional Gates

## Overview

Seven constitutional gates govern what the system can do. The core design principle is P2: **infrastructure enforces; prompts advise**. Gate checks are implemented as database constraints, SQL functions, and deterministic code checks -- not as LLM prompt instructions alone. Prompts reinforce the rules but are not trusted as the sole enforcement mechanism.

Gates are checked at two points in the pipeline:

1. **Pre-execution (`guardCheck`)** -- Called within the same transaction as `claimAndStart()`. Checks G1 (budget), halt signals, config hash, assignment validation, data classification, and constitutional evaluation.

2. **Post-execution (`checkDraftGates`)** -- Called by the reviewer agent on action proposals. Checks G2, G3, G5, G6, G7 against the proposal content. Gate applicability is config-driven: each gate declares which action types it applies to via an `applicableTo` array in `config/gates.json`. Gates that do not apply to the current action type auto-pass with `{ passed: true, skipped: true }`.

## Gate Summary

| Gate | Name | Check Point | On Violation | Enforcement Layer |
|------|------|------------|-------------|-------------------|
| G1 | Financial | Every LLM call (pre-execution) | Halt all non-critical | DB constraint + SQL function |
| G2 | Legal | Reviewer (post-execution) | Flag for board | Regex patterns + LLM review |
| G3 | Reputational | Reviewer (post-execution) | Reject draft | pgvector cosine similarity + LLM review |
| G4 | Autonomy | Board approval | Require board approval | Application-level check |
| G5 | Reversibility | Reviewer (post-execution) | Flag for board | DB constraint + code check |
| G6 | Stakeholder | Reviewer (post-execution) | Reject draft | SQL count query |
| G7 | Precedent | Reviewer + strategist (post-execution) | Flag for board | Regex patterns + LLM review |

## Gate Applicability by Action Type

With multi-channel support (adapters for email, Slack, LinkedIn content), not all gates are relevant to all action types. The `applicableTo` field in `config/gates.json` declares which action types each post-execution gate applies to. G1 and G4 are checked at different pipeline stages (pre-execution budget check and board approval, respectively) and do not use the `applicableTo` mechanism.

| Gate | `email_draft` | `content_post` | Config Key |
|------|:---:|:---:|------------|
| G1 Financial | n/a | n/a | *(checked pre-execution, not in `checkDraftGates`)* |
| G2 Legal | Yes | Yes | `"applicableTo": ["email_draft", "content_post"]` |
| G3 Reputational | Yes | -- | `"applicableTo": ["email_draft"]` |
| G4 Autonomy | n/a | n/a | *(checked at board approval, not in `checkDraftGates`)* |
| G5 Reversibility | Yes | -- | `"applicableTo": ["email_draft"]` |
| G6 Stakeholder | Yes | -- | `"applicableTo": ["email_draft"]` |
| G7 Precedent | Yes | Yes | `"applicableTo": ["email_draft", "content_post"]` |

**Rationale for the split:**

- **G2 (Legal) and G7 (Precedent)** apply broadly because commitment language and precedent-setting are risks regardless of channel.
- **G3 (Reputational)** is email-only because the voice profile and pgvector corpus are built from sent emails. Content posts will need a separate voice/tone system (Phase 1.5).
- **G5 (Reversibility)** is email-only because its checks (reply-all, recipient count) are email-specific concepts.
- **G6 (Stakeholder)** is email-only because its per-recipient-per-day rate limit is an email spam prevention measure.

**Adding new action types:** To extend gate coverage to a new action type (e.g., `slack_message`), add the type string to the relevant gates' `applicableTo` arrays in `config/gates.json`. No code changes are required -- the `isApplicable()` helper in `checkDraftGates()` reads the config at runtime.

Source: `config/gates.json` (`applicableTo` arrays), `src/runtime/guard-check.js` (`isApplicable()` helper, lines 199-202)

## G1: Financial

**What it checks:** Daily LLM spend ceiling ($20/day default).

**Parameters** (from `config/gates.json`):

```json
{
  "dailyCeilingUsd": 20.00,
  "warningThresholdPct": 80
}
```

**Enforcement:**

- **DB constraint:** `budgets_no_overspend CHECK (spent_usd + reserved_usd <= allocated_usd)` on `agent_graph.budgets`
- **SQL function:** `reserve_budget()` uses atomic `UPDATE...WHERE` -- two concurrent agents cannot both pass the budget check
- **Auto-halt:** When `spent_usd >= allocated_usd`, `reserve_budget()` inserts a `financial` halt signal into `agent_graph.halt_signals`

**Failure behavior:** All agents stop processing. The system enters a halted state. Requires human intervention to clear the halt or adjust the budget.

**Warning:** At 80% utilization, a `_budgetWarning` flag is set on the guard check context. This is informational only and does not block execution.

**Budget lifecycle:**
1. `reserve_budget(estimated_cost)` -- Atomic reservation before LLM call
2. `commit_budget(estimated_cost, actual_cost)` -- Convert reservation to actual spend after call
3. `release_budget(estimated_cost)` -- Free reservation on failure

Source: `src/runtime/guard-check.js` (lines 34-64), `sql/005-functions.sql` (reserve/commit/release)

## G2: Legal

**What it checks:** Commitment, contract, or binding language in drafts.

**Applies to:** `email_draft`, `content_post`

**Parameters:**

```json
{
  "patterns": [
    "\\b(commit|promise|guarantee|agree|contract|binding|warrant)\\b",
    "\\b(by \\w+ \\d+|within \\d+ (days|weeks|months))\\b",
    "\\$\\d+",
    "\\b(we will|I will|we can|I can) (deliver|complete|ship|pay|refund)\\b"
  ]
}
```

**Enforcement:**

- **Automated check:** Regex scan in `checkDraftGates()`. Any match fails the gate.
- **LLM review:** The reviewer agent evaluates for subtle commitment language that regex may miss.
- **One-way merge:** If the automated regex check fails, the LLM cannot override it. The LLM can only flag additional concerns on passing automated checks.

**Failure behavior:** Draft is flagged for board review. Not auto-rejected -- the board can still approve if the match is a false positive.

Source: `src/runtime/guard-check.js` (lines 204-218)

## G3: Reputational

**What it checks:** Tone match between the draft and the inbox owner's voice profile. Minimum score: 0.80.

**Applies to:** `email_draft` only (voice corpus is email-derived; content channels will need a separate tone system)

**Parameters:**

```json
{
  "minScore": 0.80,
  "dimensions": ["formality", "warmth", "directness", "vocabulary"]
}
```

**Enforcement:**

- **Infrastructure (primary):** pgvector cosine similarity against the top 10 most similar sent emails in `voice.sent_emails`. The average cosine similarity must be >= 0.80. This is computed using the database, not the LLM.
- **LLM review (supplement):** The reviewer also rates tone 0.0-1.0. If the LLM score is below 0.80, the draft is rejected regardless of the automated score.
- **Fail-closed:** If the embedding API is unavailable, the gate fails (returns `passed: false`).

**Failure behavior:** Draft is rejected. The responder would need to generate a new draft.

**Edge case:** If no embeddings exist yet (fresh system), the gate passes with a warning note. This allows the system to bootstrap before the voice corpus is populated.

Source: `src/runtime/guard-check.js` (lines 223-279)

## G4: Autonomy

**What it checks:** Whether the current autonomy level permits the action without board approval.

**Parameters:**

```json
{
  "L0": {
    "behavior": "require_approval_for_all",
    "exitCriteria": {
      "minDrafts": 50,
      "maxEditRatePct": 10,
      "minDays": 14
    }
  },
  "L1": {
    "behavior": "auto_send_routine",
    "exitCriteria": {
      "minDays": 90,
      "maxErrorRatePct": 5
    }
  },
  "L2": {
    "behavior": "auto_send_except_g2_flagged"
  }
}
```

**Enforcement:** Application-level. The `AUTONOMY_LEVEL` environment variable and the DB constraint on `inbox.drafts` (`drafts_g5_require_board_approval`) together enforce that drafts cannot be sent without board action.

**Failure behavior:** Requires board approval (approval_needed event emitted).

See [Graduated Autonomy](./graduated-autonomy.md) for full details.

Source: `config/gates.json` (G4 params)

## G5: Reversibility

**What it checks:** Whether the action is reversible. Flags reply-all and large recipient lists.

**Applies to:** `email_draft` only (reply-all and recipient count are email-specific concepts)

**Parameters:**

```json
{
  "preferDraft": true,
  "flagReplyAll": true,
  "flagLargeRecipientList": 5
}
```

**Enforcement:**

- **Code check:** In `checkDraftGates()`, the total recipient count (to + cc) is compared against the threshold. If it exceeds 5, the gate fails.
- **DB constraint:** `drafts_g5_require_board_approval CHECK (send_state != 'sent' OR board_action IS NOT NULL)` -- a draft cannot reach `sent` state without board action.
- **Design decision D2:** In L0, the system creates Gmail drafts, not sends. The human must explicitly send.

**Failure behavior:** Draft is flagged for board review with `isReplyAll: true` and `recipientCount` details.

Source: `src/runtime/guard-check.js` (lines 282-291), `sql/002-email.sql` (constraint)

## G6: Stakeholder

**What it checks:** Per-recipient-per-day email rate limit to prevent spam.

**Applies to:** `email_draft` only (rate limit is an email spam prevention measure)

**Parameters:**

```json
{
  "maxEmailsPerRecipientPerDay": 3,
  "requireAiDisclosure": true
}
```

**Enforcement:**

- **SQL query:** Counts proposals in `agent_graph.action_proposals` with `send_state IN ('delivered', 'reviewed')` for the current date and matching recipients using the `&&` array overlap operator.
- **Fail-closed:** If the rate check query fails (database error), the gate blocks the draft.

**Failure behavior:** Draft is rejected. Cannot be overridden without clearing previous sends for that recipient.

Source: `src/runtime/guard-check.js` (lines 294-326)

## G7: Precedent

**What it checks:** Whether the draft sets pricing, timeline, or policy precedent.

**Applies to:** `email_draft`, `content_post`

**Parameters:**

```json
{
  "patterns": [
    "\\b(price|pricing|cost|rate|fee|discount)\\b.*\\$?\\d+",
    "\\b(deadline|timeline|eta|delivery date|launch date|ship by)\\b",
    "\\b(policy|procedure|standard|requirement|rule)\\b.*(change|update|new)"
  ]
}
```

**Enforcement:**

- **Automated check:** Regex scan in `checkDraftGates()`. Any match fails the gate.
- **LLM review:** Both the reviewer and strategist (via guardrails config) evaluate for precedent-setting language.
- **One-way merge:** Same as G2 -- automated failures cannot be overridden by the LLM.

**Failure behavior:** Draft is flagged for board review. The board can approve if the precedent is intentional.

Source: `src/runtime/guard-check.js` (lines 329-342)

## Board Intervention Classification Protocol

When the board overrides an agent action (via dashboard or CLI), the intervention is classified as either **constitutional** or **judgment** in `agent_graph.board_interventions`. This classification feeds G1 (Constitutional Coverage) — the gate passes when judgment-type interventions average < 2/month over 3 months.

### Definitions

| Type | Definition | Examples |
|------|-----------|----------|
| **Constitutional** | The override could have been derived from existing rules (gates G1-G7, SPEC principles, or documented policy). The system should have caught this automatically. | Draft contained commitment language (G2 should have flagged). Budget exceeded but halt didn't trigger. Tone score was below threshold but gate passed due to missing embeddings. |
| **Judgment** | The override required human judgment that no existing rule covers. This represents a gap in the constitutional framework or a genuinely novel situation. | Board disagrees with the strategic priority ranking. Response strategy is technically correct but contextually wrong. Email should have been handled differently based on relationship nuance the system can't know. |

### Classification Decision Tree

1. **Was a gate supposed to catch this?** (G1-G7 patterns or documented policy) → **Constitutional**
2. **Is there a documented precedent or rule that should have applied?** → **Constitutional**
3. **Is this a novel situation or a subjective call?** → **Judgment**
4. **When in doubt**, classify as **judgment** — it's better to overcount judgment interventions (which trigger framework improvements) than to undercount them.

### How to Record

**CLI**: When using the `decide` command, interventions are auto-logged for strategic decisions. For draft reviews, the `review` command logs board actions but does not currently classify intervention type — classification happens in the dashboard.

**Dashboard**: The GovernanceFeed component records board actions on strategic decisions. The `intervention_type` field should be set when the board modifies or rejects an agent recommendation.

**API**: `POST /api/governance/decide` records the verdict. A separate `POST` to `agent_graph.board_interventions` should be made when the board action contradicts the agent recommendation (i.e., `verdict = 'rejected'` or `verdict = 'modified'`).

### Why This Matters

- **Constitutional interventions** reveal enforcement gaps — things the system should catch automatically (P2). Each one should spawn a follow-up task to add or fix the relevant gate/rule.
- **Judgment interventions** are expected and healthy in early phases. A high judgment rate (> 2/month sustained) signals the constitutional framework isn't mature enough for the current autonomy level.
- G1 measurement uses these classifications directly. Getting this wrong distorts the Phase 1 exit criteria.

Source: `sql/011-constitutional-layer.sql` (board_interventions table), `src/runtime/capability-gates.js` (measureG1)

## Pre-Execution Guard Check (`guardCheck`)

Called atomically within the `claimAndStart()` transaction. Checks:

| Check | What | Failure Code |
|-------|------|-------------|
| G1 Budget | `reserve_budget()` returns false | `G1_budget_exceeded` |
| Halt signal | Active halt in `task_events` or `halt_signals` | `halt_active` |
| Config hash | Agent config hash matches DB | `config_hash_mismatch` |
| Assignment | Agent can only claim tasks assigned to it | `can_assign_to_violation` |
| Data classification | CONFIDENTIAL/RESTRICTED require board approval | `data_classification_confidential` / `data_classification_restricted` |
| Constitutional | Constitutional engine evaluation (shadow or active mode) | `constitutional_violation` / `constitutional_check_error` |

If any check fails, the task transitions to `blocked` and `guardCheck` returns `{ allowed: false }`.

Source: `src/runtime/guard-check.js` (lines 20-152)

### Architect Routing Constraint (DB Trigger)

Separately from `guardCheck`, the architect agent is constrained at the database layer via `enforce_architect_routing()`. This trigger on `agent_graph.work_items` prevents the architect from assigning work items to any agent other than `orchestrator` (or leaving them unassigned). This ensures the architect cannot bypass the orchestrator's routing logic -- a P2 enforcement that was previously only a prompt-level convention (issue #37).

Source: `sql/024-tool-sandboxing.sql`

### Tool Execution Enforcement

Tool invocations are governed by a 4-layer enforcement model in `tools/registry.js` (see [System Architecture](./system-architecture.md) for the full layer table). Every tool call is audited in the append-only `agent_graph.tool_invocations` table. Tool source integrity is verified at startup via SHA-256 hashes stored in `agent_graph.tool_registry`.

Source: `tools/registry.js`, `src/runtime/infrastructure.js`

## Reviewer Gate Check (`checkDraftGates`)

Called by the reviewer agent on each action proposal (draft email, content post, etc.). Evaluates gates G2, G3, G5, G6, G7 against the proposal content.

**Signature:**

```js
checkDraftGates(draft, voiceProfile, txClient, senderRegister, actionType)
```

The `actionType` parameter (defaults to `'email_draft'`) determines which gates are evaluated. The reviewer reads `action_type` from the `agent_graph.action_proposals` row and passes it through. Each gate's `applicableTo` array in `config/gates.json` is checked via the internal `isApplicable()` helper:

- If a gate's `applicableTo` includes the current `actionType`, the gate runs normally.
- If `applicableTo` does not include the current `actionType`, the gate returns `{ passed: true, skipped: true, reason: "Not applicable for <actionType>" }`.
- If a gate has no `applicableTo` field at all, it runs for all action types (fail-open). This is a safety design: G1 and G4 never reach `checkDraftGates` (they are checked at earlier pipeline stages), and any new gate added to this function without an `applicableTo` declaration will apply universally until explicitly scoped.

**Return value:**

```js
{ passed: boolean, gates: { G2: {...}, G3: {...}, G5: {...}, G6: {...}, G7: {...} } }
```

Each gate result includes `passed`, gate-specific details, and optionally `skipped: true` when the gate was not applicable.

Source: `src/runtime/guard-check.js` (lines 191-347), `src/agents/reviewer.js` (line 34-35)

## Post-Execution Check (`postExecutionChecks`)

Called by the `AgentLoop` after the handler returns successfully. Checks:

| Check | What |
|-------|------|
| Result shape | Handler returned a valid object (not null/undefined) |
| Subtask assignment | Any created subtasks reference valid agent IDs |
| Quarantine | Work item was not quarantined during execution |

Source: `src/runtime/agent-loop.js` (lines 252-286)
