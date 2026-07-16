# PR #82 Architecture Review — Liotta (Systems Architect)

**Date:** 2026-03-19
**PR:** staqsIO/optimus#82 — SPEC Addendum v1.1.0 (Figma Findings)
**Reviewer:** Liotta (Opus 4.6)
**Verdict:** APPROVE WITH MODIFICATIONS — 3 changes are 10x leverage, 2 are redundant, 2 need redesign.

---

## Leverage Analysis: The Hidden Collapse

Dustin identified a real problem — "diligence theater" — where executors wrap correct 40-line artifacts in 80 lines of scaffolding. But the addendum proposes **four separate mechanisms** (anti-pattern prompts, self-assessment stripping, envelope stripping, scope compliance review) to address **one root cause**: executors produce unsolicited content.

The 10x insight: **This is not four problems. It is one problem with one correct enforcement point.**

P2 says "infrastructure enforces; prompts advise." The addendum acknowledges this hierarchy but then gives equal spec weight to all four layers. The correct architecture is:

1. **One infrastructure gate** (output envelope stripping in post-check) — this is the enforcement boundary
2. **One review dimension** (scope compliance) — this is the detection/audit layer
3. **Prompt anti-patterns** — advisory only, not spec-level, belongs in `agents.md` operational docs

Self-assessment stripping as a separate spec section is overengineered. It is a subset of envelope stripping. A regex that catches `"Quality Score: 9/10"` is the same class of operation as one that catches `"## Execution Report"`. Merging them into a single "output sanitization" post-check step reduces spec surface area by ~30% with zero capability loss.

---

## Change-by-Change Verdict

### 1. Scope Compliance (4th Reviewer Dimension) — APPROVE
Correct architectural response. The existing three dimensions (correctness, format, completeness) genuinely miss the case where output is correct, well-formatted, complete, AND contains fabricated extras. This is a real gap. No simplification possible.

### 2. Self-Assessment Stripping — MERGE INTO #4
Not a separate concern. Self-assessment ("Quality Score: 9/10") is a special case of output envelope ("## Campaign Execution Report"). One post-check step with a pattern list handles both. Creating two spec sections for two regex categories is unnecessary complexity. **Merge into Output Envelope Stripping as a sub-pattern.**

### 3. Knowledge Boundary Declarations — REDESIGN NEEDED
The concept is right — executors should declare what they know and don't know. But the proposed implementation (static `known_apis` / `unknown_apis` lists in behavioral contracts) has a fatal flaw: **it requires manually maintaining knowledge inventories for every executor, and those inventories are wrong the moment a model is updated.**

Better approach: **Capability probing at assignment time** (Change #7 already proposes this). If the Orchestrator checks `capability_tags` against `required_capabilities` before assignment, the knowledge boundary problem is solved at the infrastructure layer (P2). The behavioral contract version is prompts-advise (P2 violation as a primary enforcement mechanism).

Recommendation: Keep knowledge boundaries as advisory documentation in `agents.md`. Move enforcement to Change #7's pre-assignment capability check. Delete the spec-level knowledge boundary requirement from behavioral contracts.

### 4. Output Envelope Stripping — APPROVE (absorb #2)
Correct enforcement point (post-check, infrastructure layer). Should absorb self-assessment stripping patterns. Single post-check step: "output sanitization" with a configurable pattern list. Patterns are data (stored in config or DB), not hardcoded in the spec.

### 5. Artifact-Only Output Format + Anti-Patterns — APPROVE (demote anti-patterns)
The artifact-only constraint is correct and belongs in the spec. The anti-pattern list ("Do NOT wrap in Campaign Execution framing...") is operational guidance that belongs in `agents.md`, not in the architecture specification. The spec should say WHAT (artifact-only output), not HOW (specific prompt phrasing). Anti-patterns will change as models change; the spec should not.

### 6. Routing Class Gating — APPROVE, HIGHEST LEVERAGE
This is the single highest-value change in the PR. A DETERMINISTIC task hitting an LLM is pure waste — it costs 100-1000x more than a template, takes 10-100x longer, and *actively degrades output quality* by adding theatrical scaffolding. The enforcement is clean: `if routing_class === 'DETERMINISTIC' && handler !== template_handler → POLICY_VIOLATION`. This is a DB constraint or a 3-line guard check, not a complex system.

**This should be implemented first.** It has the highest dollar-per-line-of-code ROI of any change in the PR.

### 7. Pre-Assignment Capability Check — APPROVE, absorb #3
Correct infrastructure enforcement (P2). Checking `capability_tags ∩ required_capabilities ≠ ∅` before assignment is a set intersection — O(k) where k is the tag count, trivially fast. This makes knowledge boundary declarations (#3) redundant as a spec-level enforcement mechanism.

---

## Implementation Order — Recommended (differs from PR)

The PR proposes: `5+1 → 2 → 6 → 4 → 3+7`

**Recommended order: `6 → 7 → 4+2 → 1 → 5`**

| Priority | Change | Rationale |
|----------|--------|-----------|
| 1 | **#6 Routing class gating** | Highest ROI. Prevents waste on every DETERMINISTIC task. 3-line guard check. |
| 2 | **#7 Pre-assignment capability check** | Prevents the Figma-class failure (assigning work to incapable executors). Subsumes #3. |
| 3 | **#4+#2 Output sanitization** (merged) | Single post-check step. Infrastructure enforcement for the diligence theater problem. |
| 4 | **#1 Scope compliance** | Review-layer detection. Less urgent because #4+#2 catch most cases before review. |
| 5 | **#5 Artifact-only constraint** | Prompt-advisory layer. Lowest urgency because it's advise-not-enforce. |

Rationale: Infrastructure gates (#6, #7) before detection layers (#4, #1) before advisory layers (#5). This follows P2's hierarchy.

---

## Architectural Risks

### Risk 1: Spec Bloat
The addendum is 467 lines for 7 changes. The SPEC is already large. Each change includes rationale, ecosystem references, phase activation, and measurement sections. This is thorough but creates a maintenance burden. **Recommendation:** When merging into SPEC.md, compress to ~150 lines total. The rationale belongs in the ADR or conversation record, not the spec itself.

### Risk 2: Knowledge Boundary Staleness
Static `known_apis` / `unknown_apis` lists will be wrong within one model update cycle. Enforcement based on stale lists is worse than no enforcement — it creates false confidence. **Mitigation:** Demote to advisory; enforce via capability_tags (Change #7).

### Risk 3: Pattern Fragility in Stripping
Regex-based output stripping is inherently fragile. If the pattern list misses a new form of scaffolding, it passes through silently. **Mitigation:** The scope compliance reviewer dimension (#1) is the backstop. This is why both layers are needed — but the spec should be explicit that stripping is best-effort and the reviewer is the enforcement boundary.

### Risk 4: P2 Tension in Anti-Patterns
The spec currently says "infrastructure enforces; prompts advise." Elevating prompt-level anti-patterns to spec status blurs this line. If anti-patterns are in the spec, are they infrastructure or prompts? **Mitigation:** The spec defines the artifact-only constraint (infrastructure-level rule). The anti-pattern list is referenced as an operational appendix, not a spec-level requirement.

---

## Summary

Dustin's diagnosis is correct: diligence theater is a real and measurable problem. The proposed changes are directionally right but overfit to defense-in-depth when a simpler architecture handles it:

- **3 changes are genuinely needed:** #6 (routing gating), #7 (capability check), #1 (scope compliance)
- **2 changes should merge:** #2 (self-assessment) into #4 (envelope stripping) = one "output sanitization" step
- **1 change should be demoted:** #3 (knowledge boundaries) from spec-level to operational docs, with enforcement via #7
- **1 change needs scope reduction:** #5 (artifact-only) keeps the constraint, demotes the anti-pattern list to `agents.md`

Net result: 7 spec sections become 4, with cleaner P2 alignment and no capability loss.
