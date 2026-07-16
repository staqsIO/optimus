# ADR-005 — Skip-with-reason for "Needs you" items

**Status:** Accepted
**Date:** 2026-05-11

## Context

The `/board` Kanban surfaces items needing human attention in a "Needs you" lane (per ADR-002): pending `action_proposals` and unacknowledged `needs_attention_log` rows. Today the board can only act on these by routing out (`/drafts`, `/activity`) and using the existing surfaces — but those surfaces are designed for *acting on* the item, not *deciding it doesn't need action*.

Reality: many surfaced items were superseded, handled outside the system, or just stopped mattering. Without a "skip" path:

- `action_proposals` accumulate indefinitely with `board_action IS NULL` until the board takes a quality verdict (approved / edited / rejected) — which is the wrong shape for "this stopped being relevant".
- `needs_attention_log` rows have `acknowledged_at` semantics but no record of *why* — making it indistinguishable from "the board hit the wrong button" later.

## Decision

Introduce a **Skip** action on Needs-you cards with an optional reason. Wording: "Skip" (matches the board's mental model; distinct from quality verdicts).

### Storage

**For `action_proposals`:**

1. Extend the `board_action` CHECK constraint to include `'skipped'`. New set: `('approved', 'edited', 'rejected', 'skipped')`.
2. Reuse the existing `board_notes TEXT` column for the skip reason text. No new column.
3. On skip: set `board_action = 'skipped'`, `board_notes = <reason or NULL>`, `acted_at = now()`, `acted_by = <board member identity>`.

**For `needs_attention_log`:**

1. Add a new column `acknowledgment_reason TEXT` (nullable). Migration is additive — no constraint changes.
2. On skip: set `acknowledged_at = now()`, `acknowledged_by = <board member identity>`, `acknowledgment_reason = <reason or NULL>`.

Both write paths are best-effort idempotent (re-skipping an already-skipped item updates the reason and timestamp).

### Endpoints

- `POST /api/board/proposals/:id/skip` — body `{ reason?: string }`. 404 if not found. 409 if `board_action` is already non-null and ≠ `'skipped'` (don't overwrite a real verdict).
- `POST /api/board/attention/:id/skip` — body `{ reason?: string }`. 404 if not found. Re-skip is allowed (updates reason).

Both require board-role auth. Identity captured from the request session (or Bearer subject for legacy compat).

### Metric impact

M3 / M4 already filter `board_action IN ('approved', 'edited', 'rejected')` (migration 093). Adding `'skipped'` to the CHECK constraint does **not** affect those metrics — they continue to ignore skipped proposals, which is the right behaviour (skip is not a quality signal).

### Why "Skip" and not "Done" / "Dismiss"

- **Done** implies the work was completed, raising the obvious follow-up: "by whom, where?". Misleading for "I'm ignoring this".
- **Dismiss** implies the item itself was invalid (spam, false-positive). Some skipped items are legitimate but no longer worth acting on — Dismiss overstates the judgment.
- **Skip** is neutral about the item's quality and explicit about the board's choice. Reason text exists precisely so the board can record *why* — was it superseded, handled in another channel, deprioritised? — without forcing that into a fixed enum.

### Why reason is optional

The board needs the affordance to be low-friction. A required reason creates pressure to type filler ("nvm", "skip") which is worse than nothing. Optional + a placeholder hint ("Why are you skipping? Future-you will thank you.") encourages reason capture without blocking.

## Consequences

- Skipped proposals stop appearing in `/board` `needs_you` lane (same query already excludes `board_action IS NOT NULL`).
- Skipped attention rows stop appearing (same query already excludes `acknowledged_at IS NOT NULL`).
- The CHECK constraint change requires a forward migration. PGlite-test compatibility: confirm the constraint syntax matches what migration 001 already does; `ALTER TABLE … DROP CONSTRAINT … ADD CONSTRAINT …` works on both.
- The `acknowledgment_reason` column is purely additive — backfill is not required (NULL is meaningful: "skipped before reasons were captured" or "no reason given").
- Future analysis: skip reasons become a corpus we can read to spot patterns ("the board keeps skipping draft replies to vendor X" → maybe stop drafting them).
- Out of scope for this ADR: unskip / unwind. If a skip was a mistake, the board edits the row in SQL or via a follow-up tool. Not optimising for that path in v1.
