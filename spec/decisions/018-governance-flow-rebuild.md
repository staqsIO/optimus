# ADR-018: Governance Flow Rebuild — Deterministic OS, Not Review Screen

**Date**: 2026-06-13
**Status**: PENDING BOARD DECISION
**Issue**: OPT-66 (Linear STAQPRO-559)
**Related**: Phase 5 of the Proper Path plan; ADR-011 (autobot-inbox voice-edit delta — unrelated); ADR-009 (board backend authz)

---

## Context

### What this document is

ADR-011 in `autobot-inbox/docs/internal/adrs/` covers the voice-edit delta feedback loop — it is unrelated to governance. There is no existing spec-level ADR for the governance surface rebuild. This document is that ADR.

### The current state (grounded in the codebase)

The governance surface lives at `board/src/app/governance/page.tsx` and its components. As of 2026-06-13:

**Three tabs (`page.tsx:12-18`):**
- `overview` — `HaltResumeControl`, `DeadManSwitchControl`, `DirectiveForm`, `SubmissionInbox`
- `decisions` — `StrategicDecisions`
- `intents` — `AgentIntents`

**The `SubmissionInbox`** is an LLM-scored queue of human-submitted governance proposals. This is the named anti-pattern the plan calls out: a human-review screen that puts the governance burden on board members reviewing AI-scored proposals rather than on the infrastructure.

**`StrategicDecisions`** is a separate panel that the plan intends to re-source from the live `guardCheck` gated queue — decisions that the system itself surfaces because an agent action was blocked or escalated, not because a human submitted it.

**The `guardCheck` function** lives at `lib/runtime/governance/guard-check.js` (re-exported via `lib/runtime/guard-check.js:1-2`). It runs atomically within `transition_state`. Gates G1-G11 include budget checks, commitment detection, tone matching, autonomy-level checks, rate limiting, prompt injection screening (Model Armor), and spend-cap enforcement. Any gate failure today results in the action being blocked; escalation routing exists (`lib/runtime/escalation-manager.js`) but does not currently feed the governance board surface.

**`+ New Directive`** currently appears as a co-equal affordance with the halt switch on the overview tab. It creates directives that guide agent behavior — but placing it at the same visual weight as the halt mechanism mis-signals its authority level.

**The dead-man switch** (`DeadManSwitchControl`) exists in the component tree but is not surfaced in the Overview header. It should be the first thing a board member sees.

### The structural problem

The current governance surface treats governance as **pre-execution human review**: humans approve or reject proposals before agents act. This creates:

1. **Queue rot**: 141+ "Needs You" items pile up because humans can't review fast enough.
2. **Perverse incentives**: agents that want to act learn to frame proposals to pass LLM scoring, not to genuinely seek human judgment.
3. **Wrong escalation trigger**: the queue is populated by human submissions, not by the infrastructure detecting a genuine irreversibility threshold.
4. **Blind spot on reversibility**: reversible work (drafts, analysis, research) should run at machine speed. Only genuine irreversibility — `touches_money`, `touches_legal`, committed external communication — should require human review.

The reframe in Phase 5 of the Proper Path plan: **governance is the deterministic OS, not a human-review screen**. The `guardCheck` gates already implement this for pre-execution enforcement. The governance board surface should surface what the OS surfaces, not what humans submit.

---

## Decision

### 1. Kill the LLM-scored submissions queue

Remove `SubmissionInbox` from the governance surface. Human-initiated strategy submissions belong on a Strategy page, not in the governance inbox. The governance inbox should show what the **infrastructure** surfaced, not what humans submitted.

This is not removing human input — it is routing it correctly. A board member who wants to propose a strategic change uses the existing `DirectiveForm` (demoted affordance, see below), not a submissions queue.

### 2. Re-source Strategic Decisions from the live `guardCheck` gated queue

The `StrategicDecisions` panel re-sources from `agent_graph.action_proposals WHERE guard_failed = true OR escalation_required = true` — i.e., decisions the system itself determined needed human review. The existing escalation manager (`lib/runtime/escalation-manager.js`) already has the routing logic; this change wires it to the board surface.

This makes the governance inbox a **post-infrastructure escalation queue**: the board sees only items the deterministic OS could not resolve autonomously. Every item in the queue has a `failed_gate`, an `agent_id`, a `task_id`, and an estimated cost — full provenance, no LLM scoring needed.

### 3. `decision_deadline` + default-deny-on-timeout reconciler

Add a `decision_deadline TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '60 days'` column to `agent_graph.action_proposals` (or a new `governance_escalations` table). A nightly reconciler marks any unreviewed escalation past its deadline as `denied` (fail-closed) and fires an audit event. A 60-day-stale queue becomes structurally impossible.

This requires a new migration (number TBD, follows migration 158/159 per the current sequence).

### 4. Convert Agent Intents → capability-receipt audit feed

`AgentIntents` becomes a **post-execution audit feed**, not a pre-execution review queue. Each agent action that completed successfully emits a capability receipt: `{agent_id, action, task_id, cost_usd, guard_gates_passed[], timestamp, hash}`. These are hash-chained (consistent with P3 transparency-by-structure). The board can audit what ran; it is not asked to approve what already ran.

The "Intents" tab is renamed to "Activity" or "Audit Feed" to signal the semantic change.

### 5. Demote `+ New Directive`

Move `DirectiveForm` out of the overview affordance co-equal with the halt switch. It becomes a secondary action on a "Strategy" sub-section or a dedicated `/strategy` page. The overview tab should be: dead-man switch status → system state → escalation queue → halt/resume control.

### 6. Surface the dead-man switch in the Overview header

`DeadManSwitchControl` moves to the Overview header — the first element after the page title. If the switch is armed (within the 72-hour window), a persistent banner is shown. This is the most important board affordance and must not be buried.

---

## Implementation Sequencing

This is a board surface change with a backend migration dependency. The sequencing:

1. **After ADR-018 PR-B is merged** (RLS live, `autobot_agent` role): the governance surface's backend routes need RLS-compatible queries. Surface changes before PR-B would be reverted by the role flip.
2. **After Phase 4 bridge dry-run sign-off** (OPT-56): the escalation queue will include bridge-related guard failures; the new surface should be ready to display them.
3. **Migration**: `decision_deadline` column + reconciler job. File as a separate Linear issue with explicit dependency on PR-B.
4. **Frontend**: `SubmissionInbox` removal → `guardCheck`-sourced escalation panel → capability-receipt feed → header affordance reorder. Can be built against a stub API while the migration is in progress.
5. **RLS gate on `+ New Directive`**: the directive write endpoint should be gated by `board_members` role (already in ADR-009's authz model); verify this survives PR-B.

---

## Tradeoffs

| What we lose | What we gain |
|---|---|
| Human-submitted governance queue | Queue that only contains genuine infrastructure escalations (no rot) |
| LLM-scored proposals | Deterministic gate metadata (which gate failed, at what cost) |
| Pre-execution approval for reversible work | Machine-speed reversible work; board attention focused on irreversible decisions |
| Familiar "inbox" metaphor | Accurate "OS escalation" metaphor — more honest about what governance actually is |

The only genuine loss is the ability for board members to submit proposals into a governance queue. The replacement is `DirectiveForm` (strategy layer) + the `guardCheck` escalation queue (infrastructure layer). These are cleaner separations.

---

## Risks

- **Escalation queue silence**: if no actions trip `guardCheck`, the board governance screen shows nothing. This is correct behavior (the OS is running clean) but could be mistaken for a broken UI. Mitigation: show a "last checked" timestamp and a count of actions processed since last escalation.
- **Migration timing**: `decision_deadline` column must be added before the escalation panel goes live (or the panel must handle NULL gracefully).
- **Directive authz**: verify `DirectiveForm` write path has `board_members` RLS after PR-B. If it doesn't, board members could lose the ability to create directives post-flip.

---

## Decision

**PENDING BOARD DECISION.**

The recommendation is to proceed with all six changes above after PR-B validation. No individual change requires a separate ADR; this document covers the full governance surface rebuild.

Board must explicitly confirm: (a) removal of the LLM-scored submissions queue is acceptable, (b) default-deny-on-timeout is the correct failure mode for stale escalations, (c) the dead-man switch header placement is correct.
