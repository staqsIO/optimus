## Reconciliation Report — 2026-05-30

**Verified against repo:** migration max = 130 (not 128), agents = 20 (not 18), `lib/runtime/{phase1-metrics,campaign-promoter}.js` already relocated, `lib/contracts/*` + `lib/wiki/compiler.js` still coupled, `/observability` is a redirect, no `/github` page, `.github/workflows/agent-identity.yml` exists.

**Proposed changes:**
- **5 doc fixes** to root `CLAUDE.md`: migration range, agent count, two completed coupling-roadmap items, observability-page status. (A 6th discrepancy — "Five schemas" — lives in `autobot-inbox/CLAUDE.md`, flagged in STATE but not auto-patched since task scoped docFixes to root.)
- **1 markDone:** STAQPRO-16 (agent-identity CI check) — workflow file now exists; conservative, needs a glance to confirm it's the intended check.
- **0 closeStale:** no issue meets the evidence bar for obsolete/duplicate with confidence. The dormant Apr-07 roadmap cluster (85–98) is flagged for triage, not auto-closed.
- **7 create:** the multi-tenant scoping fix (Phase 2, Urgent) + 6 surface-the-backend issues (Phase 1, High/Medium): GitHub PR view, Telegram panel, signal-briefing display, TLDv browse depth, Calendar connection settings, wire `/observability`.
- **Triage:** recommendations for the 3 unassigned Urgent/High (85, 86, 322) plus the stale roadmap epics.

**Headline:** Phase 1 is 56% done and healthy on the pipeline side; the real gap is that several working backends are invisible in the UI, and the company-brain claim is blocked by a confirmed cross-user data leak. Close the leak first, then surface what's already built.
