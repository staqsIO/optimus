---
title: "Graduated Autonomy"
description: "L0, L1, L2 autonomy levels: behaviors, exit criteria, metric tracking"
---

# Graduated Autonomy

## Overview

The system operates at one of three autonomy levels. Progression is metric-based, not calendar-based (design principle P5: measure before you trust). The current level is set via the `AUTONOMY_LEVEL` environment variable and is evaluated daily by the architect agent.

## Autonomy Levels

### L0: Human-in-the-Loop (Current)

**Behavior:** All drafts require board approval before any action is taken.

| Action | Permitted? |
|--------|-----------|
| Triage classification | Yes (automatic) |
| Signal extraction | Yes (automatic) |
| Draft generation | Yes (automatic) |
| Noise archival | Logged, but automatic |
| Draft send | No -- requires board approval |
| Reply-all | No -- requires board approval + G5 flag |

**What happens in practice:**
1. The pipeline runs automatically through triage, strategy, drafting, and review
2. Approved/flagged drafts emit an `approval_needed` event
3. Eric reviews via CLI or dashboard
4. Eric can approve, edit, or reject each draft
5. Edits are recorded in `voice.edit_deltas` (append-only) as training data

**Exit criteria:**

| Metric | Threshold | Rationale |
|--------|-----------|-----------|
| Minimum drafts reviewed | 50 | Sufficient sample size for edit rate |
| Maximum edit rate | 10% | System must demonstrate it matches Eric's voice |
| Minimum days | 14 | Calendar floor to catch edge cases |

All three criteria must be met simultaneously.

### L1: Semi-Autonomous

**Behavior:** Auto-archive noise, auto-label FYI, auto-send routine responses. G2-flagged drafts still require board approval.

| Action | Permitted? |
|--------|-----------|
| Triage classification | Yes (automatic) |
| Signal extraction | Yes (automatic) |
| Draft generation | Yes (automatic) |
| Noise archival | Yes (automatic) |
| FYI labeling | Yes (automatic) |
| Routine response send | Yes (automatic, unless G2-flagged) |
| G2-flagged draft send | No -- requires board approval |
| Reply-all | No -- requires board approval |

**Exit criteria:**

| Metric | Threshold | Rationale |
|--------|-----------|-----------|
| Minimum days | 90 | Extended observation period |
| Maximum error rate | 5% | Includes false positives, missed flags, board rejections |

### L2: Full Autonomy

**Behavior:** Handle all emails autonomously except G2-flagged items (commitment/contract language). This is the steady-state target.

| Action | Permitted? |
|--------|-----------|
| All routine actions | Yes (automatic) |
| G2-flagged draft send | No -- always requires board approval |

No exit criteria. L2 is the terminal level. G2 flags always require human review because the system cannot authorize legal commitments.

## Metric Tracking

### Edit Rate

The primary L0 exit metric. Tracked by `voice/edit-tracker.js`:

```javascript
// getEditRate(days = 14) returns:
{
  edited: 5,    // drafts Eric modified
  total: 55,    // total drafts with board_action
  rate: 0.09    // 9% edit rate (below 10% threshold)
}
```

Query:
```sql
SELECT
  COUNT(*) FILTER (WHERE board_action = 'edited') AS edited,
  COUNT(*) AS total
FROM inbox.drafts
WHERE board_action IS NOT NULL
  AND acted_at >= CURRENT_DATE - 14 * interval '1 day';
```

### Edit Classification

Each edit is classified by type and magnitude:

| Edit Type | Definition |
|-----------|-----------|
| minor | < 10% of lines changed |
| tone | > 70% word overlap but different arrangement |
| structure | > 90% word overlap, structural changes only |
| content | 70-90% word overlap, substantive changes |
| major | > 50% of lines changed |

Edit magnitude is a 0.0-1.0 score approximating character-level change ratio.

### Daily Evaluation

The architect agent evaluates autonomy exit criteria daily by:

1. Querying the `signal.v_daily_briefing` view for aggregate metrics
2. Calling `evaluateAutonomy()` from `src/runtime/autonomy-evaluator.js`
3. Logging readiness status: `L0 -> EXIT READY` or `not ready`

The architect does not automatically promote the autonomy level. Promotion requires explicit human decision (changing `AUTONOMY_LEVEL` env var).

## Database Enforcement

### G5 Constraint

Regardless of autonomy level, the database enforces that drafts cannot be sent without board action:

```sql
ALTER TABLE inbox.drafts ADD CONSTRAINT drafts_g5_require_board_approval
  CHECK (send_state != 'sent' OR board_action IS NOT NULL);
```

This constraint is the infrastructure-level backstop (P2). Even if the application code had a bug that tried to auto-send at L0, the database would reject it.

### Draft Send State Flow

```
pending -> reviewed -> board_approved -> draft_created -> sent
```

At L0, all transitions past `reviewed` require the board to act. At L1/L2, some transitions can be automated based on the triage category and gate results.

## Current Status

The system is currently at **L0**. All drafts require board approval. The architect agent tracks progress toward L0 exit criteria in the daily briefing.
