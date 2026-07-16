# Liotta Systems Architect Review: PR #8 -- agents.md Definitions

**Date:** 2026-02-27
**Reviewer:** Liotta (Systems Architect agent)
**PR:** #8 `agents: add agents.md definitions for Phase 1 roster`
**Branch:** `dustin/agents-md-definitions`
**Author:** Dustin

---

## CRITICAL FINDING: This PR Is Not What the Title Says

Before evaluating the agents.md files on their merits, I need to flag a structural problem with this PR that changes the entire evaluation.

**The PR title says:** "agents: add agents.md definitions for Phase 1 roster"
**The PR body describes:** Adding 5 agent definition files (837 additions, 0 deletions).

**What the PR actually does:**

| Change | Lines Added | Lines Deleted | Net |
|--------|------------|--------------|-----|
| agents/ directory (5 files) | 837 | 0 | +837 |
| SPEC.md rollback (v0.6.1 to v0.5.1) | ~35 | ~382 | -347 |
| CHANGELOG.md (delete 4 versions) | 0 | 83 | -83 |
| conversation/ (delete 2 entries) | 0 | 866 | -866 |
| reviews/ (delete 2 reviews) | 0 | 518 | -518 |
| **Total** | **873** | **1,814** | **-941** |

This PR deletes 1,814 lines of previously committed work -- including conversation entries (which per CLAUDE.md "are historical record" and must not be modified after commit), review outputs, the entire v0.5.2/v0.6.0/v0.6.1 changelog, and substantial SPEC.md content including:

- The Graduated Autonomy Model (v0.5.2)
- Strategist suggest mode
- Section 14.1 Source Control and Code Review Architecture
- Cost-aware routing (v0.6)
- Executor filesystem isolation (v0.6)
- Automated reaction loops (v0.6)
- The agents.md standard integration section in SPEC.md (v0.6)
- Four deferred items from v0.6
- CI enforcement checks (C1-C4 from Linus audit)

The branch appears to be based on a pre-v0.5.2 state of SPEC.md and has not been rebased onto the current main. This means the PR, if merged as-is, would revert agreed-upon work from v0.5.2, v0.6.0, and v0.6.1 -- including security fixes from the Linus audit.

**Recommendation:** Split this PR. The agents.md files should be a clean addition on top of current main. The SPEC.md regression must not merge. If Dustin has concerns about v0.6 content, those should be separate, explicitly discussed changes with their own PR and rationale. Bundling deletions of reviewed, committed work under a title that says "add agents.md definitions" is exactly the kind of oversight that CODEOWNERS config-isolation checks (Linus C3) were designed to prevent.

The remainder of this review evaluates the agents.md files themselves, assuming the SPEC.md/CHANGELOG/conversation deletions are an accidental branching artifact and will not be merged.

---

## 1. Leverage Analysis: Does This Abstraction Layer Earn Its Keep?

### The Question

We have a 5-agent Phase 1 roster with a well-defined hierarchy. The agents.md files add 837 lines of Markdown across 6 files (1 root + 4 agent definitions, with orchestrator-eng referenced but absent from the PR). The SPEC.md already defines agent tiers, configs, guardrails, and context budgets in approximately 200 lines. Does duplicating and expanding this into a separate file tree add 10x value, or does it add 1x value at 4x maintenance cost?

### What These Files Actually Are

Strip away the ecosystem branding and these files are system prompts with structured metadata. Specifically:

1. **AGENTS.md (root)**: A 308-line CLAUDE.md-equivalent. Contains design principles (duplicated from SPEC.md section 0), tech stack, repo structure, commands, hierarchy, task graph overview, guardrails summary, data quality tiers, git workflow, code standards, testing, and boundaries.

2. **Per-agent files** (strategist, architect, executor-01, reviewer-backend): Role definitions with identity, hierarchy, responsibilities, tools (allowed/forbidden), guardrails, anti-patterns, and Lethal Trifecta assessments.

### The Duplication Problem

The root AGENTS.md duplicates substantial content from SPEC.md:

| Content | Source in SPEC.md | Source in AGENTS.md | Identical? |
|---------|-------------------|---------------------|------------|
| Design Principles P1-P6 | Section 0 | "Design Principles" section | Near-identical, abbreviated |
| Agent hierarchy | Section 2 (Agent Tiers table) | "Agent Hierarchy" section | Same structure, different format |
| Task graph schema | Section 3 | "Task Graph" section | Summarized |
| Context budgets | Section 4 (table) | Per-agent files | Same numbers |
| Guardrail architecture | Section 5 | "Guardrails" section | Summarized |
| Data quality tiers | Section 4 (Q1-Q4) | "Data Quality Tiers" section | Near-identical |
| Tool allowed/forbidden lists | Section 4 (agent config JSON) | Per-agent files | Expanded |

When you have two sources for the same truth, one of them will eventually be wrong. The spec already says "When this file and the spec conflict, the spec wins" -- which means AGENTS.md is by definition the less authoritative source. The question is whether the convenience of having a self-contained agent instruction document justifies the maintenance cost of keeping it synchronized.

### The 10x Opportunity They Missed

The real leverage in agent definitions is not in the Markdown -- it is in the compilation step. The spec (section 4) already describes a deterministic compiler that translates agents.md into JSON config rows. If that compiler existed, the agents.md files would be the single source of truth for behavioral instructions, and the JSON configs would be the infrastructure-enforced subset.

But the compiler does not exist. Without it, these files are just documentation that agents might read -- which makes them P2-violating by nature (prompts advise; infrastructure enforces). The 10x move would be:

1. Define a strict schema for agent definitions (not free-form Markdown).
2. Build the compiler that produces `agent_configs` JSON from the schema.
3. Make the compiled JSON the enforcement boundary (JWT claims, RLS policies, tool allow-lists).
4. Let the Markdown be a human-readable view generated from the schema, not the source.

This inverts the current proposal: instead of humans writing Markdown that compiles to JSON, the schema IS the source and Markdown is a derived artifact. The schema is machine-verifiable; the Markdown is not.

**Verdict:** The files have value as agent system prompts. They do not have value as an "abstraction layer" because they lack the compiler that would make them authoritative. Without the compiler, they are documentation with aspirations.

---

## 2. Measurable Impact: How Do You Know These Work?

### The Feedback Loop Gap

The PR adds agent definitions but defines no mechanism to measure whether they improve agent behavior. Consider the executor anti-pattern: "Don't silently skip acceptance criteria." How do you know if the executor is obeying this?

**Current answer:** The Reviewer catches it during review. But the Reviewer catches it regardless of whether the anti-pattern is in the prompt -- the Reviewer's job is to check completeness against acceptance criteria. The anti-pattern in the executor prompt is defense-in-depth, which is fine, but it has no independent measurement.

**What measurement would look like:**

| Anti-Pattern | How to Measure Compliance | Infrastructure Enforcement |
|-------------|--------------------------|---------------------------|
| Executor: Don't skip acceptance criteria | Count tasks rejected for incompleteness (should trend toward 0) | Structured acceptance criteria checklist in output schema; Reviewer validates each item |
| Executor: Don't ignore failure context | Compare retry success rate WITH vs WITHOUT failure context loading | Context loader always loads failure_context; measurable via retry success rate delta |
| Reviewer: Don't approve incomplete work | Count tasks completed that later fail downstream due to missing criteria | Post-completion integration test failures traced to specific acceptance criteria gaps |
| Strategist: Don't omit kill criteria | Count decisions in strategic_decisions with empty kill_criteria | Schema constraint: kill_criteria NOT NULL, array length >= 1 |
| Strategist: Don't let confidence drift upward | Distribution of confidence scores over time (should approximate calibration curve) | Weekly histogram of confidence vs outcomes; alert if >40% are confidence 5 |

Without these measurements, the anti-patterns are aspirational text, not operational constraints.

### The Suggest-Mode Calibration Gap

The strategist file specifies: "match rate >80% AND decision reversal rate <15% over rolling 90 days before Phase 2 tactical autonomy activates." This is G4 from the spec. Good -- it is the right metric. But the strategist file also says the cost target is "$0.43 per decision." This creates a measurable link between the context budget and the decision quality.

**The question nobody is asking:** What is the relationship between context budget and decision quality? If you give the strategist 16K tokens instead of 8K, does the match rate go from 80% to 90%? If so, the $0.43 per decision is the wrong number -- you should spend $0.86 for a 12.5% improvement in strategic alignment. If not, 8K is correct and you can potentially go lower. The only way to know is to measure it, and the files define no experiment to do so.

---

## 3. Cost Analysis: Context Budget Arithmetic

### Token Budget Numbers

| Agent | Max Context/Task | Model | Input Cost/MTok | Max Input Cost/Task | Output (4K) | Total/Task |
|-------|-----------------|-------|----------------|--------------------|-----------|----|
| Strategist | 8,000 | Opus | $15 | $0.12 | $0.30 | $0.42 |
| Architect | 6,000 | Sonnet | $3 | $0.018 | $0.06 | $0.078 |
| Executor | 4,000 | Haiku 4.5 | $1 | $0.004 | $0.004* | $0.008 |
| Reviewer | 4,000 | Sonnet | $3 | $0.012 | $0.06 | $0.072 |

*Haiku 4.5 output: $5/MTok. 4K output = $0.02. The file says $0.004/task total, which implies ~1K output tokens, not 4K. The stated cost target in executor-01.md is internally inconsistent with the max_output_tokens of 4,096 and should be $0.008-$0.024 depending on actual output length.

### Root File Context Cost

AGENTS.md is 308 lines. At approximately 1.3 tokens per word and ~2,500 words, the root file consumes ~3,250 tokens of context. For an executor with a 4,000-token budget, loading AGENTS.md alone consumes 81% of the budget before the agent even sees its task.

**This is a critical design flaw.** The root file contains information the executor does not need: strategy evaluation protocol details, agent hierarchy above the executor's reporting line, git workflow conventions, code standards (useful but available via linting), data quality tier explanations, and guardrail architecture summaries.

**The fix:** Context loading should be tier-aware. The executor loads:
1. Its own agent definition file (~142 lines, ~800 tokens)
2. The task details + acceptance criteria (variable)
3. Failure context / reviewer feedback if applicable

The executor should never load the root AGENTS.md. The architect and strategist might benefit from portions of it, but even they should receive a trimmed version. A 3,250-token fixed overhead on a 4,000-token budget is not viable.

### Are the Context Budgets Right?

The budgets match the SPEC.md section 4 table exactly. Whether they are right depends on task complexity:

- **Strategist at 8K**: This is tight for strategic decisions that reference prior decisions, budget status, and cross-domain patterns. The spec says strategic decisions (9% of volume) use three-perspective evaluation. Loading three perspective evaluations plus decision history into 8K tokens will force aggressive summarization. For suggest mode in Phase 1, 8K is adequate because the board is making the actual decisions. For Phase 2 tactical autonomy, this may need to increase to 12-16K.

- **Executor at 4K**: Correct for Phase 1. Most executor tasks are well-scoped implementation units. 4K is enough for task + acceptance criteria + failure context. If executors consistently hit the budget ceiling and quality suffers, increase to 6K -- but measure first.

- **Reviewer at 4K**: Potentially too low. The reviewer needs the task output (which could be substantial code), the acceptance criteria, and parent task context. A code review of 200 lines of TypeScript with 5 acceptance criteria could easily exceed 4K tokens. Recommend monitoring truncation frequency and quality correlation.

---

## 4. First-Principles Challenge: Is agents.md the Right Standard?

### The Standard's Origin

The agents.md standard is designed for open-source repositories where:
- External contributors (who may be agents) need to understand project conventions
- Multiple independent teams/agents interact without a central orchestrator
- The Markdown file IS the primary instruction mechanism (there is no orchestration layer)

### How Optimus Differs

Optimus is none of these things:
- It is a closed system where the board controls all agents
- There is a central orchestrator that manages all task dispatch
- The orchestration layer (guardCheck, JWT, RLS) is the enforcement boundary
- Agents do not read their own config files to determine their capabilities -- the JWT determines capabilities

In open-source repos, agents.md is the security perimeter. In Optimus, agents.md is defense-in-depth. This is a fundamental difference in the role of the file.

### Where the Standard Adds Value Anyway

Despite the mismatch in primary use case, the format provides three genuine benefits:

1. **Human readability for board review.** When the board needs to understand what an agent can and cannot do, a well-structured Markdown file is faster to review than JSON config. This is real value -- board members should not need to parse JSON to understand agent boundaries.

2. **Onboarding documentation.** If the board adds members, new contributors, or auditors, the agent definition files provide a self-contained explanation of each agent's role. This is better than pointing someone at SPEC.md section 4 and saying "figure out what the executor does."

3. **Ecosystem compatibility (speculative).** The spec argues that as GitHub Agent HQ and Claude Code's plugin system mature, they will expect agents.md format. This is plausible but speculative -- the standard is 6 months old and its adoption trajectory is unclear. Betting on ecosystem compatibility is reasonable but should be flagged as a bet, not a certainty.

### Where It Does Not Add Value

1. **Enforcement.** These files enforce nothing. The JWT, RLS policies, and guardCheck enforce everything. This is by design (P2), but it means the files are documentation, not architecture.

2. **Agent behavior modification.** The claim that anti-patterns "improve agent performance more than positive instructions" cites "analysis of 2,500+ repos." This may be true for open-source repos where the anti-patterns are the only behavioral guidance. In a system with guardCheck, structured output schemas, and a Reviewer agent, the marginal improvement from prompt-level anti-patterns is much smaller. Not zero, but smaller.

3. **Configuration management.** Until the deterministic compiler exists, the agents.md files are a parallel configuration surface that must be manually synchronized with the JSON configs in agent_configs. This is a maintenance liability, not an asset.

### Verdict

Adopt the format for human readability and board review. Do not treat it as an architectural layer until the compiler exists. Do not load the root AGENTS.md into agent context -- it costs too many tokens relative to its value.

---

## 5. The Anti-Patterns Question: Can Any Be Infrastructure-Enforced?

This is the most important question in the evaluation. The anti-patterns sections are genuinely the best part of these files. They encode hard-won operational wisdom. The question is whether any of them can graduate from prompt-level advice to infrastructure-level enforcement.

### Audit

| Anti-Pattern | P2 Enforceable? | How |
|-------------|----------------|-----|
| **Strategist: Don't omit kill criteria** | YES | `strategic_decisions` table: `kill_criteria JSONB NOT NULL CHECK (jsonb_array_length(kill_criteria) >= 1)` |
| **Strategist: Don't create DIRECTIVEs without budget** | YES | `guardCheck()` validates budget availability before DIRECTIVE creation; already specified in section 5 |
| **Strategist: Confidence drift** | PARTIALLY | Weekly query on `strategic_decisions`: alert if mean confidence > 4.0 or >40% of decisions at confidence 5 |
| **Strategist: Prompt drift measurement** | YES | `cosine_similarity(current_config, ORIGINAL_config) < threshold` check on config change. Already mentioned in spec. |
| **Executor: Don't skip acceptance criteria** | PARTIALLY | Structured output schema with per-criterion completion flags. Reviewer validates but could also be schema-enforced at output attachment time. |
| **Executor: Don't interpolate SQL** | YES | Static analysis CI check (already standard practice). AST-based detection in PR review. |
| **Executor: Don't submit without tests** | YES | CI gate. PR cannot merge without passing test suite. Already enforced by branch protection. |
| **Executor: Scope discipline** | NO | This is inherently a judgment call. File-level isolation (worktrees) provides partial enforcement. |
| **Reviewer: Don't approve incomplete work** | PARTIALLY | Structured review output schema with per-criterion pass/fail. If any criterion is `pass: false`, the review cannot output `verdict: approved`. Schema constraint. |
| **Reviewer: Don't enter feedback loops** | YES | `guardCheck()` enforces max 1 revision round. Already in spec (section 5). Counter on work item: `revision_count CHECK (revision_count <= 1)`. |
| **Reviewer: Don't modify executor outputs** | YES | RLS policy: reviewer role has SELECT only on task outputs, no UPDATE/INSERT. Already implied by spec. |
| **Architect: Don't design without spec reference** | NO | Inherently a judgment call. Could require `spec_sections_referenced` field in output schema, but cannot verify quality of reference. |
| **Architect: Don't bypass orchestrators** | YES | `can_assign_to` list does not include executors. JWT-enforced. Already in spec. |

**Result:** 7 of 14 audited anti-patterns are fully or partially infrastructure-enforceable. 5 are already enforced by existing spec mechanisms. The remaining 2 that COULD be infrastructure-enforced but currently are not:

1. **Kill criteria NOT NULL constraint on strategic_decisions** -- trivial to add. Do it.
2. **Structured review output with schema-enforced completeness** -- the reviewer output format is defined in the PR but not schema-enforced. Making the review verdict a function of per-criterion flags (if ANY criterion is `pass: false`, verdict cannot be `approved`) would eliminate the single highest-risk reviewer anti-pattern at the infrastructure level.

**Recommendation:** Add these two infrastructure constraints to the spec. They cost nothing to implement and convert the two most impactful anti-patterns from prompt-level advice to database-level enforcement.

---

## 6. Scaling Analysis: Phase 2 Maintenance Cost

### What Changes at Phase 2

Phase 2 ("Tactical Autonomy") activates:
- Additional executors (executor-02, executor-03)
- Reviewer-frontend
- Orchestrator-product
- Agent replacement protocol with shadow mode
- Three-perspective strategy evaluation

### File Changes Required

| Change | Files Affected | Effort |
|--------|---------------|--------|
| Add executor-02.md, executor-03.md | 2 new files (copy executor-01 with different agent_id) | Trivial |
| Add reviewer-frontend.md | 1 new file (variant of reviewer-backend) | Low |
| Add orchestrator-product.md | 1 new file | Moderate (different scope than orchestrator-eng) |
| Update orchestrator-eng can_assign_to | 1 file edit | Trivial |
| Update AGENTS.md hierarchy diagram | 1 file edit | Low |
| Strategist exits suggest mode | 1 file edit (remove Phase 1 specifics section) | Low |
| Context budget adjustments | Up to 5 file edits | Depends on measurement results |

Total Phase 2 effort: 4 new files + 8-10 edits. Not onerous. The per-agent file pattern scales linearly with agent count, which is the correct scaling behavior for a system with <20 agents.

### The Real Scaling Concern

The scaling problem is not file count -- it is synchronization. At Phase 2, you have:
- SPEC.md (canonical architecture)
- AGENTS.md root (operational summary)
- 8-10 per-agent files (behavioral definitions)
- agent_configs JSON rows (infrastructure-enforced config)

Four representations of agent capabilities. Without the compiler, any change to agent capabilities requires updating 2-4 locations. At 5 agents this is manageable. At 10-15 agents in Phase 3-4, it becomes a reliability hazard.

**The lever:** Build the compiler before Phase 2. The agents.md files should be the ONLY place humans edit agent definitions. The JSON configs should be a build artifact. The SPEC.md should reference the agents.md files, not duplicate their content. This reduces the synchronization points from 4 to 1.

---

## 7. Missing File: orchestrator-eng.md

The PR references `orchestrator-eng.md` in the AGENTS.md hierarchy and repository structure but does not include it. The Phase 1 roster lists 5 agents: Strategist, Architect, Orchestrator, Reviewer, Executor. The PR delivers definitions for 4 of 5.

This is not a blocking issue -- the orchestrator definition should be straightforward to write. But shipping 4/5 of a Phase 1 roster is incomplete work, and the PR should either include it or explicitly state it is deferred.

---

## 8. Specific Technical Issues

### 8.1. Strategist Cost Target Inconsistency

The strategist file states: "~$0.43 per decision (8K input + 4K output at Opus pricing)."

At current Opus pricing ($15/MTok input, $75/MTok output):
- 8K input: $0.12
- 4K output: $0.30
- Total: $0.42

The file says $0.43. Close enough, but the rounding should be explicit. More importantly, the SPEC.md v0.5.1 cost model (which this branch rolls back to) shows $640-800/month for the Strategist at 50 decisions/day, which is $0.43-0.53/decision. The agents.md files reference suggest mode at 10-15 proposals/day ($130-195/mo), which is consistent with the v0.5.2 cost model that this branch deletes. There is a version coherence problem that traces back to the branching artifact identified in Section 0.

### 8.2. Executor Model Notation

executor-01.md says: "Haiku 4.5 (Phase 1); Ollama evaluated Phase 2+ when tasks exceed 12,500/mo."

The current SPEC.md (v0.6.1 on main) says the same. The 12,500/mo threshold for GPU evaluation should be justified: at Haiku 4.5 pricing of $1/MTok input, 12,500 tasks/month at 4K tokens each = $50/month. A dedicated GPU instance for local inference costs $200-400/month minimum. The crossover point is not 12,500 tasks but closer to 50,000-100,000 tasks depending on hardware. The number should either be corrected or annotated with the cost justification.

### 8.3. Reviewer Quarantine Handling

The reviewer-backend.md describes quarantine clearing in detail. This is good -- it is one of the most complex workflows in the system. However, it references `output_quarantined = true` as a flag on the work item, which is the v0.5.2 resolution. The branch's SPEC.md rollback changes this to `status: quarantined` as a workflow state, which contradicts the reviewer file. Another version coherence problem from the branching issue.

### 8.4. AGENTS.md Repository Structure Is Aspirational

The repo structure in AGENTS.md describes directories that do not exist yet: `spec/`, `guardrails/`, `kill-switch/`, `gateway/`, `schemas/`, `orchestration/`, `audit/`, `tools/`, `src/`, `tests/`, `dashboard/`, `infra/`. This is a spec repo. None of these directories exist. The AGENTS.md is written as if it will be placed in the production Optimus repository, not in autobot-spec.

This is actually fine -- the agents.md files SHOULD be written for the production repo, not for the spec repo. But the PR adds them to autobot-spec, which means they are currently documentation about a system that does not exist yet. The README or PR description should be explicit about this: these files are pre-authored for deployment into the production repo when it is created.

---

## 9. Summary Recommendations

### Merge Blockers (must fix before merge)

1. **Rebase onto current main.** The SPEC.md rollback, CHANGELOG deletions, conversation/review deletions must not merge. This is either an accidental branching artifact or an intentional reversion of agreed-upon work -- either way, it needs to be resolved before the agents.md files are evaluated for merge.

2. **Add orchestrator-eng.md.** Ship the complete Phase 1 roster or explicitly defer it.

### Should Fix Before Merge

3. **Document that AGENTS.md root file should NOT be loaded into executor/reviewer context.** At 3,250 tokens, it consumes 81% of a 4K budget. Per-agent files are the correct context load unit for lower-tier agents.

4. **Resolve the quarantine representation.** The reviewer file says `output_quarantined = true` (flag). The branch's SPEC.md says `status: quarantined` (state). Pick one. The flag approach (v0.5.2) is architecturally cleaner because it avoids polluting the state machine.

### Should Do Soon After Merge

5. **Add kill_criteria NOT NULL constraint to strategic_decisions schema.** Infrastructure-enforce the strategist's most important anti-pattern.

6. **Add schema-enforced review completeness.** If any per-criterion flag in the review output is `pass: false`, the verdict field cannot be `approved`. Enforce at the output schema level.

7. **Build the compiler.** Until agents.md files compile deterministically to agent_configs JSON, they are documentation, not architecture. The compiler is the lever that makes this abstraction layer earn its keep.

### Acknowledge and Defer

8. **Context budget optimization is a Phase 1 measurement task, not a design-time decision.** The 8K/6K/4K/4K numbers are reasonable starting points. Instrument context truncation frequency and downstream quality metrics. Adjust based on data, not intuition.

9. **Ecosystem compatibility is a bet.** The agents.md standard may or may not become dominant. Adopting the format costs little and may pay off. Do not over-invest in format compliance until the ecosystem trajectory is clearer.

---

## 10. Overall Assessment

**The agents.md files are good system prompts.** The anti-patterns sections are excellent. The tool allow/forbid lists are comprehensive. The hierarchy definitions are clear. The Lethal Trifecta assessments per agent are a valuable addition not present in the SPEC.md.

**They are not yet an architectural layer.** Without the compiler, they are a parallel documentation surface that must be manually synchronized with the SPEC.md and the agent_configs JSON. This is a known gap that the spec explicitly calls out.

**The PR has a serious packaging problem.** The agents.md additions are buried alongside a SPEC.md regression that reverts 5 versions of agreed-upon work. This must be separated before review can proceed on the agents.md content alone.

**The 10x insight:** The maximum leverage from this work is not in the Markdown files themselves -- it is in the two infrastructure constraints (kill_criteria NOT NULL, schema-enforced review completeness) that emerge from analyzing the anti-patterns. Those two constraints, implemented as database CHECK constraints, would provide more behavioral improvement than all 837 lines of Markdown combined. That is P2 in action: infrastructure enforces, prompts advise.

---

*Reviewed by Liotta Systems Architect agent. Model: Claude Opus 4.6.*
