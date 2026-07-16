# ADR-030: Pipeline Unblock — Architectural Review

**Status:** Accepted (post-hoc review of 2026-03-28 emergency fixes)
**Date:** 2026-03-28
**Reviewer:** Liotta (Systems Architect)

## Context

The Optimus agent pipeline was completely dead — executor-responder never received work, draft queue permanently empty. Three root causes were identified and fixed in a single session, producing the first drafts ever. This ADR evaluates the six architectural decisions made.

---

## Decision 1: claim_next_task SQL — exempt state_changed from status filter

**Verdict: CORRECT. This is the right fix.**

The task_events table serves two distinct purposes that were conflated:
1. **Task events** (task_assigned, task_created) — the work_item IS the work. Status filter makes sense.
2. **Routing events** (state_changed) — the work_item is ALREADY DONE. The event exists to trigger downstream routing.

The fix correctly recognizes this semantic split. The alternative — firing state_changed events with a NEW work item ID — would require the orchestrator to create a placeholder work item before it knows what to route, which is worse (phantom work items, orphan cleanup, extra writes).

**Risk to monitor:** state_changed events for cancelled/timed_out work items are now also claimable. The handler checks `to_state === 'completed'` and ignores others, so this is safe today. But if someone adds a handler for `to_state === 'failed'` that creates downstream work, the cleanup query (which now exempts ALL state_changed from garbage collection) could accumulate stale events. Add a TTL sweep for state_changed events older than 1 hour.

**Recommended follow-up:** Add a partial index on task_events for unprocessed state_changed events to keep the claim query fast as volume grows:
```sql
CREATE INDEX CONCURRENTLY idx_task_events_state_changed_unprocessed
ON agent_graph.task_events (priority DESC, created_at)
WHERE event_type = 'state_changed' AND processed_at IS NULL;
```

---

## Decision 2: notify() in .then() after withTransaction()

**Verdict: CORRECT and SAFE.**

The code:
```js
return withTransaction(async (client) => {
  // ... transaction work ...
  return { success, toState, workItemId };
}).then(({ success, toState: st, workItemId: wid }) => {
  if (success && (st === 'completed' || st === 'failed')) {
    notify({ ... }).catch(() => {});
  }
  return success;
});
```

`withTransaction()` returns a Promise that resolves AFTER the transaction commits (the pg client.query('COMMIT') completes before the promise resolves). The `.then()` chain executes after that resolution. This is the correct pattern — notify fires after commit, not before.

The `.catch(() => {})` is also correct — pg_notify is a performance optimization (wake the poller immediately instead of waiting up to 3s), not a correctness requirement. Silent failure is the right behavior.

**One subtlety:** If `withTransaction` uses a connection pool and the COMMIT succeeds but the connection is returned to the pool before pg_notify fires on the LISTEN side, there's a theoretical race where the orchestrator claims the event before the notify arrives. This is harmless — it just means the notify is redundant. No bug here.

---

## Decision 3: Two classification systems with normalization layer

**Verdict: ACCEPTABLE SHORT-TERM. Unify within 2 weeks.**

The normalization in `tryDeterministicRoute` (lines 123-153) maps executor-intake's `{complexity, recommended_action, confidence}` to executor-triage's `{category, needs_strategist}`. This works but has three problems:

1. **Semantic drift risk.** The mapping `RESOLVE_DIRECT -> noise` and `TRIVIAL + high confidence -> fyi` embeds business logic in the router that belongs in the classifier. If executor-intake's LLM prompt changes its vocabulary, routing silently breaks.

2. **Two sources of truth.** Future developers will see `triage_result` in some work items and `intake_classification` in others, with no obvious connection.

3. **Testing surface.** You need to test both schemas through all 7 routing rules — combinatorial explosion.

**Recommended fix:** Have executor-intake write BOTH its native schema AND the normalized `triage_result` in metadata. The normalization happens once, at classification time, not at routing time. The router only reads `triage_result`. executor-triage becomes a fallback, not a parallel path.

```js
// In executor-intake, after LLM classification:
metadata.intake_classification = { complexity, recommended_action, confidence };
metadata.triage_result = {
  category: normalizeCategory(recommended_action, complexity, confidence),
  needs_strategist: complexity === 'COMPLEX' || complexity === 'SPECIALIZED',
  pipeline: detectPipeline(intake),
  quick_score: confidence
};
```

---

## Decision 4: Sibling-based dedup

**Verdict: CORRECT with one edge case to handle.**

Checking `siblingAgents.has(route.agent)` before creating a work item prevents the common failure mode: orchestrator claims a state_changed event, creates a subtask, the event gets re-delivered (PGlite quirk, crash recovery, etc.), and a duplicate subtask appears.

**The edge case:** Multi-step pipelines where the same agent legitimately processes the same email twice (e.g., executor-responder drafts, reviewer rejects, executor-responder re-drafts). In this case, the second executor-responder task IS a sibling of the first under the same parent.

**Current behavior:** The second routing would be blocked by dedup. This is a bug waiting to happen.

**Fix:** Check sibling status, not just existence. A completed or failed sibling should not block a new task for the same agent:
```js
const activeSiblingAgents = new Set(
  siblings.filter(s => !['completed', 'failed', 'cancelled'].includes(s.status))
    .map(s => s.assigned_to)
);
```

This preserves dedup for in-flight duplicates while allowing re-routing after completion.

---

## Decision 5: L1 autonomy for noise/FYI (auto-archive)

**Verdict: CORRECT. The SPEC supports this and the alternative is worse.**

The SPEC's Graduated Autonomy Model (lines 1330-1335) defines L0 as "Board decides everything. Agents propose." But the autobot-inbox CLAUDE.md's own Graduated Autonomy table says L1 includes "Auto-archive noise, auto-label FYI."

The key insight: **L0 was designed for a working system.** When the pipeline produces zero drafts, L0 means "board approves nothing" — which is indistinguishable from "system is broken." The SPEC's exit condition for L0 is "50+ drafts, <10% edit rate, 14 days." You can't reach 50 drafts if the board has to approve archiving 200 noise emails first.

**The pragmatic read of P5 (Measure before you trust):** You're not trusting the agent to make high-stakes decisions. You're trusting a deterministic pattern match (from_address contains 'noreply@') to archive spam. This is closer to a Gmail filter than an AI decision. No LLM is involved. No commitment language. No reputational risk.

**Governance recommendation:** Log every auto-archive to the event stream (you're already doing this via `publishEvent`). Add a weekly digest that shows the board what was auto-archived. If the board spots a false positive, add the sender to an exception list. This is L1 with training wheels — exactly what the SPEC intended.

**One thing to NOT auto-archive:** Emails from known contacts (contact_tier = inner_circle or active) should never be auto-archived regardless of classification. A noise classification on an inner_circle sender is a classifier error, not a routing decision.

---

## Decision 6: Reorientation plan (Telegram primary, dashboard unification, RAG)

**Verdict: Phase ordering is correct. Two concerns.**

**What's right:**
- Telegram as primary board interface is the 10x leverage play. Zero auth infrastructure, instant multi-user, mobile-native. The bot is already built. Activation cost is near-zero.
- Dashboard unification (P2) is correctly deferred — it's polish, not pipeline.
- RAG integration (P3) is correctly deferred — you need a working pipeline generating data before RAG has anything to retrieve.

**Concern 1: Telegram as SOLE approval channel.** The plan correctly makes Telegram primary, but ensure the web dashboard retains full approval capability. Telegram is great for `approve 42` but terrible for reviewing a 500-word draft with formatting. The board will want both channels, with Telegram for quick actions and web for detailed review.

**Concern 2: Dashboard unification scope creep.** Merging autobot-inbox dashboard (port 3100) into the board workstation (port 3200) is architecturally clean but operationally risky. The inbox dashboard has inbox-specific API routes, SSE for real-time updates, and page-level state. Migrating these is a week of work minimum. Consider the proxy approach first: board dashboard at 3200 proxies `/inbox/*` to 3100. Same URL, zero migration. Unify the nav chrome only. Migrate pages incrementally.

---

## Summary Scorecard

| Decision | Verdict | Risk | Follow-up |
|----------|---------|------|-----------|
| 1. claim_next_task SQL fix | Correct | Low | Add TTL sweep + partial index |
| 2. notify() in .then() | Correct and safe | None | None needed |
| 3. Classification normalization | Acceptable | Medium | Unify at agent level within 2 weeks |
| 4. Sibling dedup | Correct with edge case | Medium | Filter by active status, not existence |
| 5. L1 for noise/FYI | Correct | Low | Exempt known contacts, add weekly digest |
| 6. Reorientation plan | Correct phasing | Low | Keep web approval, proxy before migrate |

**Overall assessment:** The session found and fixed the right root causes. The three breaks (claim_next_task filter, missing notify, missing permission grants) were independent failures that compounded into total pipeline death — a classic latent fault chain. The fixes are minimal, correct, and don't introduce new architectural debt. The normalization layer and dedup logic need refinement but are acceptable for the "get it working" phase.

The biggest systemic lesson: **the pipeline was dead for an unknown period and nothing alerted anyone.** The reaper, heartbeat, and dashboard all existed but didn't surface "zero drafts produced in N days" as an anomaly. Recommendation: add a canary metric — if `action_proposals` count doesn't increase for 24 hours while `inbox.messages` count does, fire a Telegram alert. This is the observability gap that let these bugs hide.
