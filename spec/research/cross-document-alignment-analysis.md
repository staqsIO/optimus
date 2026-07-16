# Cross-Document Alignment Analysis

> **Documents analyzed:** SPEC.md v0.7.0, CONTRIBUTING.md, CLAUDE.md, ONBOARDING.md, README.md
> **Date:** 2026-03-08
> **Purpose:** Identify contradictions, omissions, and drift across all five governing documents
> **Prior analysis:** contributing-vs-spec-gap-analysis.md (gaps G1–G14, still applicable)

---

## How to Read This

Each finding is tagged:

- **CONTRADICTION** — two documents say different things about the same topic
- **OMISSION** — a document is missing something it should cover given its audience
- **DRIFT** — a document uses outdated information that no longer matches the current state
- **INCONSISTENCY** — documents use different terminology or structure for the same concept

Severity: **High** (blocks work or creates confusion), **Medium** (causes friction), **Low** (cosmetic or minor).

---

## Findings

### F1. Branch model contradiction — ONBOARDING vs. CONTRIBUTING vs. SPEC
**Type:** CONTRADICTION | **Severity:** High

| Document | Branch Model |
|----------|-------------|
| **SPEC §14.1** | `main` ← `develop` ← feature branches. Both protected. PRs target `develop`. Promotion to `main` via release PRs. |
| **CONTRIBUTING.md** | PRs target `develop` (never `main` directly). Both protected. ✅ Matches spec. |
| **ONBOARDING.md** | "Branch from `main`, PR back into `main`." No mention of `develop`. |
| **CLAUDE.md** | Silent on branch model — defers to CONTRIBUTING. |
| **README.md** | Silent on branch model. |

**Impact:** New engineers (Steve, Alex) following ONBOARDING will PR directly to `main`, bypassing `develop` entirely. This contradicts the spec's promotion flow and the CONTRIBUTING's explicit "never `main` directly" rule.

**Resolution:** Fix ONBOARDING.md Git Workflow section to match CONTRIBUTING: branch from `develop`, PR into `develop`. Add a sentence about `main` being board-merge-only via release PRs.

---

### F2. Migration count contradiction — README vs. ONBOARDING vs. CLAUDE.md
**Type:** DRIFT | **Severity:** Low

| Document | Migration Count |
|----------|----------------|
| **CLAUDE.md** | "34 SQL migrations" |
| **ONBOARDING.md** | "Migrations 000-027" (28 migrations) |
| **README.md** | "22 SQL migrations" / "22 numbered migrations" |

Three documents, three different numbers. This is natural drift as migrations are added, but it creates confusion for newcomers who read multiple docs.

**Resolution:** Remove hardcoded migration counts from all documents. Replace with "see `sql/` directory for current migrations" or use a dynamic reference. Hardcoded counts will always drift.

---

### F3. Agent count / roster inconsistency
**Type:** INCONSISTENCY | **Severity:** Medium

| Document | Agent Count | Roster |
|----------|------------|--------|
| **SPEC §2** | 5 tiers defined (Strategist, Architect, Orchestrator, Reviewer, Executor) + Utility | No specific count for autobot-inbox |
| **CLAUDE.md** | "6-agent pipeline" | Lists: Orchestrator, Strategist, Executor-Triage, Executor-Responder, Reviewer, Architect |
| **ONBOARDING.md** | "6 agents" / "Six agents" | Same 6 as CLAUDE.md |
| **README.md** | "6 agents" / "six Claude-powered agents" | Same 6 as CLAUDE.md |

The product docs (CLAUDE/ONBOARDING/README) are internally consistent about the 6-agent roster. However, the mapping to SPEC tiers has a subtle issue: the spec defines the **Architect** as unable to "assign tasks to executors directly" and routing through the Orchestrator. But ONBOARDING describes the Architect as running "daily pipeline analysis and optimization" — which is a utility/operational role, not the architecture review role the spec defines.

Additionally, the spec's Executor tier is singular, but the product has two specialized executors (Triage and Responder). The spec doesn't address executor specialization — it treats executors as fungible workers assigned by the Orchestrator.

**Resolution:** Two actions:
1. The Architect agent in autobot-inbox appears to serve a different function than the Architect tier in the spec. Either rename the product agent (e.g., "Analyzer" or "Pipeline-Optimizer") or amend the spec to acknowledge that Architect agents can have operational duties in addition to design review. **Board decision.**
2. Add a note to the spec (§2 or §4) acknowledging that Executor agents can be specialized (e.g., Executor-Triage, Executor-Responder) while remaining within the Executor tier constraints. The specialization is in the task type, not in elevated permissions.

---

### F4. Constitutional gates naming and count
**Type:** INCONSISTENCY | **Severity:** Low

| Document | Gates |
|----------|-------|
| **SPEC §5** | Describes guardrail enforcement architecture but does NOT define G1–G7 by name. The spec uses "organizational guardrails," "role-level guardrails," and content sanitization — not numbered gates. |
| **CLAUDE.md** | "Constitutional gates G1-G7" — lists them by function (budget, commitment detection, voice tone, autonomy, etc.) |
| **ONBOARDING.md** | References G1-G7 but doesn't list them |
| **README.md** | Lists all 7 gates with descriptions (G1 Financial through G7 Precedent) |

The G1–G7 naming is a product-level convention (autobot-inbox) that doesn't exist in the spec. This is fine — the spec describes the framework, the product implements specific gates. But CLAUDE.md bridges both levels and should clarify this distinction.

**Resolution:** Add a sentence to CLAUDE.md: "G1–G7 are autobot-inbox's product-specific constitutional gates, implementing the guardrail framework described in SPEC §5." This prevents confusion about whether G1–G7 are spec-level or product-level constructs.

---

### F5. Autonomy levels — different naming across documents
**Type:** INCONSISTENCY | **Severity:** Medium

| Document | Autonomy Model |
|----------|---------------|
| **SPEC §14** | 4 levels: Level 0 (Full HITL) → Level 1 (Tactical autonomy) → Level 2 (Strategic autonomy) → Level 3 (Constitutional autonomy). Exit criteria are capability gates G1–G7 (different G1–G7 than the constitutional gates above — these are organizational capability gates). |
| **CLAUDE.md** | References "autonomy level checks" as part of G4 gate. No explicit level definitions. |
| **ONBOARDING.md** | Mentions "autonomy level L0" but doesn't define the levels. |
| **README.md** | 3 levels: L0 → L1 → L2, with specific exit criteria (50+ drafts, <10% edit rate, 14 days, etc.) |

Two problems:
1. The spec has 4 levels (0–3), README has 3 (L0–L2). README's L0–L2 are product-level (autobot-inbox email autonomy), while the spec's Levels 0–3 are organizational-level (Optimus governance autonomy). These are different autonomy scales applied at different scopes.
2. README's L0 exit criteria include "14 days elapsed" — which is a calendar gate, violating P5 ("measure before you trust; time teaches nothing"). The 50+ drafts and <10% edit rate are measurement gates (good), but the 14-day floor is a time gate (bad per spec philosophy).

**Resolution:**
1. Add a clarification to README and CLAUDE.md distinguishing **product autonomy** (L0–L2, per-product, governs what the product does without human approval) from **organizational autonomy** (Level 0–3, per the spec, governs what the Optimus organization does without board approval). These are orthogonal.
2. **Board decision on the 14-day floor:** Is the 14-day minimum in L0 a P5 violation or an intentional minimum observation window? If it's an observation window, reframe it: "minimum 14 days of data collection" rather than "14 days elapsed." The distinction matters — the former is about data sufficiency, the latter is about calendar time.

---

### F6. SPEC.md file location inconsistency
**Type:** INCONSISTENCY | **Severity:** Medium

| Document | Where SPEC.md Lives |
|----------|-------------------|
| **CLAUDE.md** | Root-level: "**`SPEC.md`** (v0.7.0) is the canonical architecture specification" — and the workspace structure shows `SPEC.md` at the repo root |
| **ONBOARDING.md** | Nested: "`autobot-spec/SPEC.md`" (linked twice) |
| **README.md** | Nested: "autobot-spec/SPEC.md" |

CLAUDE.md's workspace structure shows `SPEC.md` at the repo root AND `autobot-spec/` as a sub-project. ONBOARDING and README reference it inside `autobot-spec/`. If the monorepo consolidation (March 2026, mentioned in CLAUDE.md) moved SPEC.md to the root, the other documents haven't been updated. If it's still in `autobot-spec/`, CLAUDE.md's workspace diagram is wrong.

**Resolution:** Decide where SPEC.md canonically lives post-consolidation, then update all references. Given that CLAUDE.md's workspace shows it at root — and it's the governing document for the whole monorepo, not just one sub-project — root seems correct. Update ONBOARDING and README.

---

### F7. Dashboard port inconsistency
**Type:** CONTRADICTION | **Severity:** Low

| Document | Dashboard Port |
|----------|---------------|
| **CLAUDE.md** | "Next.js 15 on port 3100" |
| **CLAUDE.md (workspace)** | Also mentions "Board Workstation: Next.js 15, prompt-to-PR pipeline (port 3200)" — this is a different dashboard |
| **ONBOARDING.md** | "Next.js dev server on port 3100" |
| **README.md** | Silent on port |

There appear to be two dashboards: the autobot-inbox product dashboard (port 3100) and the Board Workstation (port 3200). This is fine if intentional, but CLAUDE.md's workspace structure should clarify which is which. Currently the `dashboard/` at root is described as the Board Workstation (3200), while `autobot-inbox/dashboard/` is the product dashboard (3100).

**Resolution:** Clarify in CLAUDE.md's workspace structure:
- `autobot-inbox/dashboard/` — Product dashboard (port 3100)
- `dashboard/` — Board Workstation (port 3200)

---

### F8. "Phase 1.5" exists in ONBOARDING but not in SPEC
**Type:** OMISSION (from spec) | **Severity:** Medium

ONBOARDING.md defines a "Phase 1.5" for Dustin's LinkedIn content automation with GitHub issues #22–#27. The spec's §14 defines Phase 1 → Phase 2 → Phase 3 → Phase 4 with no intermediate phases. Phase 1.5 is an operational convenience that creates ambiguity: is it part of Phase 1 (subject to Phase 1 exit criteria), or a separate phase with its own gate?

**Resolution:** Either:
- (a) Fold "Phase 1.5" work into Phase 1 scope and add the LinkedIn agents to Phase 1 deliverables in the spec, OR
- (b) Define Phase 1.5 formally in the spec with its own entry criteria (Phase 1 core pipeline stable) and exit criteria, OR
- (c) Remove the "Phase 1.5" label from ONBOARDING and call it what it is: a Phase 1 workstream for LinkedIn content automation.

**Board decision.** Option (c) is simplest and avoids spec amendment.

---

### F9. Contributor roster in ONBOARDING not reflected in spec or CONTRIBUTING
**Type:** OMISSION | **Severity:** Medium

ONBOARDING.md lists 5 contributors: Eric, Dustin, Steve (joining), Alex (joining), Mike (biz dev). The spec only references Eric and Dustin as board members. CONTRIBUTING.md's merge permissions and CODEOWNERS tiers don't account for non-board human contributors (Steve, Alex) or non-technical contributors (Mike).

Questions the CONTRIBUTING doesn't answer for Steve/Alex:
- What CODEOWNERS tier do they fall into? They're not board members and not agents.
- Can they approve PRs? Which paths?
- Can they merge to `develop`?
- Do they need to reference task graph work item IDs in branch names?

For Mike:
- ONBOARDING handles this well ("You don't need to write code to contribute") with GitHub web editor guidance. No gap here.

**Resolution:** Add a "Human contributor" row to CONTRIBUTING's merge permissions table. Engineers like Steve/Alex should likely have the same merge permissions as the Reviewer agent tier (can create PRs, can approve agent-tier paths, cannot merge, cannot modify board-tier paths). **Board decision** on whether human engineers get Orchestrator-level merge permissions or Reviewer-level.

---

### F10. README's "How It's Different" table references OpenClaw statistics from SPEC §0
**Type:** DRIFT risk | **Severity:** Low

README reproduces specific statistics from the spec: "CVE-2026-25253 (CVSS 8.8)", "800+ malicious skills", "8.7% injection resistance", "95% resistance." These are accurate per the spec but are frozen in time. If the OpenClaw situation evolves (more CVEs, updated benchmarks), the README will become stale while the spec gets updated.

**Resolution:** Keep the README's security comparison but add a date stamp: "As of February 2026, based on SPEC §0 threat analysis." This signals to readers that the data has a vintage.

---

### F11. ONBOARDING's "Spec vs. Implementation" guidance contradicts CONTRIBUTING
**Type:** CONTRADICTION | **Severity:** Medium

ONBOARDING says: "Spec changes require both collaborators' review."
CONTRIBUTING's CODEOWNERS puts `SPEC.md` under Board Tier (requires board member approval).

These say the same thing in different words, but "both collaborators" (ONBOARDING) and "board member approval" (CONTRIBUTING) could diverge as the contributor roster grows. If Steve or Alex are "collaborators" but not "board members," the rules produce different outcomes.

**Resolution:** Standardize language. Replace "both collaborators' review" in ONBOARDING with "both board members' review (Eric and Dustin)" to match CONTRIBUTING's CODEOWNERS model. "Collaborator" is ambiguous as the team grows.

---

### F12. ONBOARDING's database schema count doesn't match
**Type:** DRIFT | **Severity:** Low

| Document | Schema Count |
|----------|-------------|
| **SPEC §12** | 5 schemas: `agent_graph`, `autobot_finance`, `autobot_distrib`, `autobot_public`, `autobot_comms` |
| **ONBOARDING.md** | 5 schemas: `agent_graph`, `inbox`, `voice`, `signal`, `content` |
| **README.md** | Silent on full list but mentions `agent_graph` |

These are completely different schema sets. The spec describes the Optimus/AutoBot framework schemas. ONBOARDING describes the autobot-inbox product schemas. Both are correct at their respective scope — but no document explains the relationship.

**Resolution:** Add to CLAUDE.md (which bridges both scopes): "The spec's §12 defines Optimus framework schemas (`agent_graph`, `autobot_finance`, `autobot_distrib`, `autobot_public`, `autobot_comms`). The autobot-inbox product adds product-specific schemas (`inbox`, `voice`, `signal`, `content`) alongside `agent_graph`. Framework schemas beyond `agent_graph` are activated in Phase 2+."

---

### F13. `docs-site/` in ONBOARDING not mentioned anywhere else
**Type:** OMISSION | **Severity:** Low

ONBOARDING references a `docs-site/` directory with a Next.js documentation site ("Browse docs locally via `cd docs-site && npm install && npm run dev`"). This directory doesn't appear in CLAUDE.md's workspace structure or README's project structure.

**Resolution:** Add `docs-site/` to CLAUDE.md's workspace structure and README's project structure. If it's been removed or never created, remove the reference from ONBOARDING.

---

### F14. README roadmap items not traceable to spec phases
**Type:** OMISSION | **Severity:** Low

README lists 6 roadmap items (channel adapter extraction, webhook ingester, action proposals, LinkedIn/recruiting, CI pipeline, spec gap closures). None reference which spec phase they belong to or which Phase 1 exit criteria they satisfy. This makes it hard for external readers to understand prioritization.

**Resolution:** Add phase tags to each roadmap item, or restructure as a table with a "Phase" column.

---

### F15. CLAUDE.md references "prompt-to-PR pipeline" in Board Workstation — not in spec
**Type:** OMISSION (from spec) | **Severity:** Informational

The `dashboard/` Board Workstation is described as having a "prompt-to-PR pipeline (port 3200)." This is a significant capability (board members can issue natural language directives that generate PRs) that isn't described in the spec's §14 Phase 1 deliverables or the board command interface description.

**Resolution:** If this is a real, shipping feature, it should be referenced in the spec's board interaction model (§2, "Interacts via" section) as an additional interface. If it's aspirational, mark it as such in CLAUDE.md.

---

## Summary: Priority Actions

### Immediate (blocks contributor onboarding)

| # | Action | Owner | Docs Affected |
|---|--------|-------|---------------|
| F1 | **Fix ONBOARDING branch model** — change "branch from `main`" to "branch from `develop`, PR into `develop`" | Any contributor | ONBOARDING.md |
| F9 | **Define human engineer permissions** in CONTRIBUTING | Board decision | CONTRIBUTING.md |
| F11 | **Replace "collaborators" with "board members"** in ONBOARDING | Any contributor | ONBOARDING.md |

### Before Phase 1 promotion begins

| # | Action | Owner | Docs Affected |
|---|--------|-------|---------------|
| F6 | **Decide canonical SPEC.md location** and update all references | Board decision | CLAUDE.md, ONBOARDING.md, README.md |
| F8 | **Resolve Phase 1.5 status** — fold into Phase 1 or define separately | Board decision | ONBOARDING.md, possibly SPEC.md |

### Cleanup (do when convenient)

| # | Action | Owner | Docs Affected |
|---|--------|-------|---------------|
| F2 | Remove hardcoded migration counts | Any contributor | CLAUDE.md, ONBOARDING.md, README.md |
| F3 | Clarify Architect agent role vs. spec tier | Board discussion | CLAUDE.md, possibly SPEC.md |
| F4 | Add "G1–G7 are product-level" clarification | Any contributor | CLAUDE.md |
| F5 | Distinguish product autonomy (L0–L2) from org autonomy (Level 0–3); resolve 14-day P5 question | Board decision | README.md, CLAUDE.md |
| F7 | Clarify two dashboards in workspace structure | Any contributor | CLAUDE.md |
| F10 | Date-stamp OpenClaw comparison | Any contributor | README.md |
| F12 | Explain framework vs. product schemas | Any contributor | CLAUDE.md |
| F13 | Add or remove `docs-site/` references | Any contributor | CLAUDE.md, README.md, or ONBOARDING.md |
| F14 | Add phase tags to roadmap | Any contributor | README.md |
| F15 | Document or de-scope prompt-to-PR pipeline | Board decision | CLAUDE.md, possibly SPEC.md |

---

## Board Decisions Required

| # | Decision | Context |
|---|----------|---------|
| F1 | Confirm `develop`-based branch model applies to all contributors | ONBOARDING currently says `main` |
| F5 | Is the 14-day L0 floor a P5 violation or intentional observation window? | README autonomy criteria |
| F6 | Where does SPEC.md canonically live post-monorepo consolidation? | Root vs. `autobot-spec/` |
| F8 | Is "Phase 1.5" a formal phase or a Phase 1 workstream? | ONBOARDING references it; spec doesn't |
| F9 | What permissions do human engineers (Steve, Alex) get? | CONTRIBUTING doesn't cover them |
| F3 | Does the autobot-inbox Architect agent align with the spec's Architect tier? | Role mismatch |
| F15 | Is the Board Workstation prompt-to-PR pipeline shipping or aspirational? | CLAUDE.md references it; spec doesn't |
