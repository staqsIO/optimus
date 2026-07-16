# ADR-003 — Route and API contract for `/board`

**Status:** Accepted
**Date:** 2026-05-11

## Context

The Kanban needs a frontend route, an API endpoint, and a path through the existing `inbox-proxy` allowlist. We want to:

- Avoid disrupting `/pipeline` (different audience: dev/debug vs board flow view).
- Match existing API conventions (Map-based `routes.set` registry in `autobot-inbox/src/api.js`, Bearer auth, `cachedQuery` caching, parameterized queries).
- Reuse the existing SSE bus (`useEventStream` on `state_changed` / `task_assigned`) — do not introduce a second realtime channel.

## Decision

**Frontend route:** `/board` — new page at `board/src/app/board/page.tsx`.

**Backend endpoint:** `GET /api/board` in `autobot-inbox/src/api.js`, registered alongside `/api/debug/pipeline`. Bearer auth (existing handler), 30s `cachedQuery` TTL matching pipeline.

**Proxy allowlist:** `'/api/board'` added to `ALLOWED_PATHS` in `board/src/app/api/inbox-proxy/route.ts`.

**Response shape:**

```ts
{
  lanes: {
    needs_you:   NeedsYouCard[];
    created:     WorkItemCard[];
    assigned:    WorkItemCard[];
    in_progress: WorkItemCard[];
    review:      WorkItemCard[];
    completed:   WorkItemCard[];
  }
}

type WorkItemCard = {
  kind: "work_item";
  id: string;
  type: "directive" | "workstream";
  title: string;
  status: "created" | "assigned" | "in_progress" | "review" | "completed";
  assigned_to: string | null;
  created_by: string;
  created_at: string;     // ISO
  updated_at: string;     // ISO
};

type NeedsYouCard =
  | { kind: "proposal";  id: string; title: string; action_type: string; work_item_id: string | null; created_at: string }
  | { kind: "attention"; id: string; title: string; signature: string;   work_item_id: string | null; created_at: string };
```

Notes:

- `created` and `completed` lanes are capped at the 50 most recent rows each (avoids unbounded growth; older items remain visible in `/pipeline`).
- `completed` filter window: items whose latest `updated_at` is within the last 14 days. Older completions drop off the board.
- `needs_you` is unbounded in v1 (these are real human-blocking items — we want them all visible).

**SSE:** the page re-fetches `/api/board` on `state_changed` and `task_assigned` events from the existing `autobot_events` channel. No new event types.

## Consequences

- Pipeline view is undisturbed; can be retired or evolved independently.
- The 14-day `completed` window is a v1 heuristic — board members should re-evaluate after one week of use.
- Adding a new card type (e.g. `inbox.messages` per ADR-002 reversal) is an additive change to `NeedsYouCard` union.
- The endpoint runs three queries per call (work_items, action_proposals, needs_attention_log). With the 30s cache and PG indexes already present (`idx_needs_attention_log_unack`), this is acceptable.
