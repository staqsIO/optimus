# Workstream Separation: Ship the Product, Then Build the Platform

**Date:** 2026-03-02
**Author:** Eric
**Status:** Proposal -- pending Dustin's review
**References:** SPEC.md v0.7.0, conversation/012 (LinkedIn automation), ADR-002 (individual install), issues #24-#27, #32, #41

---

## The Problem

We have a priority drift problem. Three things are pulling in different directions:

1. **autobot-inbox** (the product) -- 6-agent email pipeline, functional but not graduated. Triage + signal extraction is genuinely useful. The drafting pipeline is a complicated game of telephone that produces 15-second emails.

2. **autobot-spec** (the vision) -- 42 files, ~16,000 lines of spec. Covers everything from inbox management to autonomous constitutional organizations. Growing faster than we can implement.

3. **New product ideas accumulating** -- DeepThought (Mike, repo root), SSL compiler PRD (Dustin, 1,064 lines), code generation pipeline (Dustin, 544 lines), LinkedIn automation (4 open issues). None built. All spec.

The result: everyone is speccing and nobody is shipping. The spec describes an organization that won't exist for years. The inbox pipeline -- Phase 1 of Phase 0 of that vision -- hasn't graduated L0. Meanwhile three new root-level documents landed without any organizational home.

This entry proposes a concrete separation: define what "ship" means for autobot-inbox, freeze spec expansion until it ships, and organize the growing pile of product ideas so they don't create false urgency.

---

## Proposal: Two Workstreams, Separated Cleanly

### Workstream A: Ship the Product (autobot-inbox v1.0)

**Owner:** Eric
**Goal:** Make autobot-inbox useful enough that a real person opens it every day.
**Constraint:** No new agents, no new schemas, no spec work. Just make what exists actually good.
**Measure:** Eric uses it daily for his real inbox for 14 consecutive days without turning it off.

This is the only workstream that produces running software. Everything else is planning, governance, or spec work -- valuable, but not shipping.

### Workstream B: Build the Platform (Optimus org)

**Owner:** Dustin
**Goal:** Spec, governance, constitutional architecture, new product specs.
**Constraint:** No spec changes that require implementation until Workstream A ships.
**Measure:** Spec stays at v0.7.x until autobot-inbox v1.0 ships.

Dustin's strength is the governance model, the constitutional architecture, the vision. That work continues -- but it doesn't create implementation obligations until the first product is actually shipping.

---

## autobot-inbox v1.0: What "Ship" Means

The minimum set that makes this product worth using daily.

### Keep and Improve

| Component | Current State | v1.0 Target |
|-----------|---------------|-------------|
| **Triage** | Works. This is the real product. | Classify every inbound message across email + Slack |
| **Signal extraction** | Extracts deadlines, action items, questions, intros | Accuracy > 85% (measured via feedback loop) |
| **Daily briefing** | Generates but unreliably | Generates reliably every morning |
| **Contacts + relationship context** | Google Contacts synced, types stuck at "unknown" | Auto-classification working (contact_type populated) |
| **Dashboard signals page** | Functional | Primary user interface, mobile-responsive (#20) |

### Demote (Off by Default)

| Component | Rationale | Implementation |
|-----------|-----------|----------------|
| **Draft pipeline** (responder + reviewer + voice) | Complicated telephone for 15-second emails. Per-email cost too high for the value delivered. | Disabled by default via config flag. Code stays. Users opt-in to drafting. |
| **Strategist** (Opus) | Triage already produces priority scores. Opus adds ~$0.37/day for marginal strategic insight at L0. | Skip entirely at L0. Re-evaluate after graduation. |

This is not killing the draft pipeline. It is acknowledging that triage + signals is the product people will actually use, and drafting is a power feature that should be opt-in. Dropping Opus + default drafting brings per-day cost well under $1.

### Add

| Feature | Effort | Why |
|---------|--------|-----|
| **Slack as second channel** | Adapter exists (`src/adapters/slack.js`), needs wiring + credentials | Multi-channel is the triage value prop. Email-only is half a product. |
| **Triage feedback loop** | New: board can correct classifications via dashboard | Improves over time. Without it, accuracy is unmeasured and unimprovable. |
| **Contact auto-classification** | Fix: `contact_type` population from interaction patterns | "Unknown" contacts make relationship context useless. |
| **L0 exit tracking** | Fix: `daysActive` is hardcoded to 0 | Cannot graduate L0 if we can't measure L0 completion. |

### v1.0 Exit Criteria

All of the following must be true:

1. Email + Slack channels both processing inbound messages
2. Eric uses it daily for 14 consecutive days (real inbox, not test data)
3. Signal extraction accuracy > 85% (measured via triage feedback loop)
4. Daily briefing generates reliably (0 missed days in the 14-day window)
5. Cost < $1/day in triage + signals mode (no Opus, no default drafting)
6. Dashboard signals page is the primary interface (mobile-responsive)
7. L0 daysActive tracks correctly and reflects actual usage

---

## Spec Freeze

Proposal to Dustin:

- **SPEC.md stays at v0.7.0** until autobot-inbox v1.0 ships. Clarifications and typo fixes (PATCH bumps) are fine. No new sections, no architectural changes (MINOR/MAJOR bumps).

- **New product specs get organized, not blocked.** DeepThought, SSL compiler, and code-gen plan move to `products/` with a README that says "these are product ideas, not active development." Dustin can keep writing specs -- they just live in the right place and don't create implementation pressure.

- **Root-level docs get organized:**
  - `DeepThought_Product_Spec.md` --> `products/deep-thought/spec.md`
  - `prd-ssl-compiler.md` --> `products/ssl-compiler/prd.md`
  - `optimus-code-generation-plan.md` --> `products/ssl-compiler/code-gen-plan.md`

- **No new conversation entries about Phase 2+ architecture** until Phase 1 ships. Research questions (26, all "not started") stay parked -- they are interesting but premature.

- **conversation/ stays immutable.** The existing 12 entries are historical record. This entry (013) is the last one until v1.0 ships, unless something changes that requires board alignment.

---

## Phase 1.5 (LinkedIn Automation): Parked

LinkedIn automation (#24-#27) has real co-founder value. Dustin is burnt out on social media execution. The architecture analysis (entry 012) showed 70% code reuse and ~580 LOC of new code. It is the cheapest possible test of the generalization thesis.

But it is 4 new agents on a pipeline that hasn't graduated L0.

**Decision: Park until v1.0 ships.**

- Issues #24-#27 stay open, labeled `blocked-by-v1.0`
- No implementation work until autobot-inbox passes exit criteria
- Once inbox is shipping and stable, LinkedIn is the next priority -- it reuses existing infrastructure and gives Dustin his own reason to use the system daily

This is not saying LinkedIn doesn't matter. It is saying: prove the pipeline works for email first, then generalize. The architecture analysis already proved the design supports it. What hasn't been proven is that the pipeline itself works well enough to trust with more use cases.

---

## Open Issue Triage

19 open issues, categorized into four buckets.

### Do Now (Workstream A -- ship the product)

| Issue | Title | Why Now |
|-------|-------|---------|
| #10 | Extend reviewer to gate action proposal types | Directly improves triage quality |
| #16 | Source control governance (CODEOWNERS) | 1-day task, reduces coordination friction |
| #20 | Dashboard mobile responsive | Dashboard is the primary v1.0 interface |

### Do After v1.0 (Workstream B -- build the platform)

| Issue | Title | Why After |
|-------|-------|-----------|
| #24-#27 | LinkedIn content automation (4 issues) | Parked per above. Labeled `blocked-by-v1.0`. |
| #28 | ADR-002 individual install docs | Matters when there's a second user. Not before. |
| #36 | agents.md compiler | Aspirational tooling. Useful after the agent set stabilizes. |

### Board Decision Needed

| Issue | Title | Decision Required |
|-------|-------|-------------------|
| #32 | Phase 3 budget cap contradiction | BLOCKER -- numbers don't reconcile between spec sections. Need aligned budget model before Phase 3 planning. |
| #41 | Initial capitalization ($10-15K) | Real and urgent. Covers 2.5-4 months of operation. Need to decide before runway becomes a constraint. |
| #40 | Distribution partner + money transmission | Phase 2 legal. Long lead time, but no action needed until Phase 1 ships. Flag for awareness. |

### Correctly Parked

| Issue | Title | Status |
|-------|-------|--------|
| #39 | DEN/DOM executor network | Phase 3+. Trigger: executor costs > $K/mo. Nowhere near that. |
| #11-#15 | Recruiting pipeline (Bennett) | 5 issues. Deferred pending platform validation. Correct. |
| #29 | Contributor onboarding | When Steve/Alex actually join. Not before. |

---

## What This Changes

**For Eric:** Stop context-switching between spec work, new product ideas, and the inbox pipeline. Focus exclusively on making autobot-inbox work well enough to use daily. 14-day clock starts when exit criteria features are implemented.

**For Dustin:** Keep doing what you're best at -- governance, constitutional architecture, product specs. But the specs live in `products/` and `autobot-spec/`, not as implementation obligations. No spec change triggers engineering work until v1.0 ships.

**For the repo:** Clean separation between running product (autobot-inbox), spec/governance (autobot-spec), and product ideas (products/). Root stays clean. Issues are labeled by workstream so anyone looking at the board knows what's active vs. parked.

**For Optimus:** The vision is intact. The spec is intact. What changes is the sequencing: ship something real first, then expand. Phase 1 must actually complete before Phase 1.5, 2, or 3 start consuming engineering bandwidth.

---

## Open Questions for Dustin

1. **Are you comfortable with the spec freeze?** v0.7.0 stays until v1.0 ships. You can still write product specs in `products/` -- they just don't bump the main spec.

2. **LinkedIn timing.** Parking until v1.0 means weeks, not months. Is that acceptable given burnout timeline?

3. **Budget (#41).** $10-15K covers 2.5-4 months. Do we need to make this decision before the workstream split, or can it happen in parallel?

4. **Draft pipeline opt-in vs. off.** The proposal says disabled by default. An alternative: remove it entirely from v1.0 scope and add it back as v1.1. Cleaner, but loses the code. Preference?

---

*Next steps: Dustin reviews this proposal. If aligned, Eric begins Workstream A immediately -- no new spec work, no new agents, just shipping autobot-inbox v1.0. GitHub issues get labeled by workstream. Root docs move to `products/`.*
