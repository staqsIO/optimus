# SPEC Addendum — Pending Changes for v1.1.0

> **Target spec version:** v1.1.0
> **Addendum started:** 2026-03-19
> **Last updated:** 2026-03-19
> **Status:** ACCUMULATING
> **How to use:** Each section references the spec section it modifies.
>   When ready to merge, apply each section to the corresponding
>   location in SPEC.md.
> **Origin:** Agent capability evaluation tests (2026-03-19).
>   Two tests — a Figma TaskCard plugin and an HTML Hello World document —
>   exposed seven gaps across the review framework, post-check pipeline,
>   behavioral contracts, and Orchestrator routing. Both tests produced
>   correct work products wrapped in unsolicited scaffolding. The Hello
>   World task (DETERMINISTIC complexity) was routed to a full LLM
>   invocation instead of a template. The Figma task (specialized API
>   knowledge required) was assigned without verifying the executor's
>   capability, producing fabricated API sections alongside valid code.

---

## Change Log

| Date | Section | Summary |
|------|---------|---------|
| 2026-03-19 | §2 Reviewer Acceptance Criteria (AMEND) | Add fourth review dimension: scope compliance |
| 2026-03-19 | §4 Runtime Loop Step 6 (AMEND) | Add self-assessment stripping to post-check |
| 2026-03-19 | §2 Behavioral Contracts (AMEND) | Require knowledge boundary declarations |
| 2026-03-19 | §4 Runtime Loop Step 6 (NEW) | Add output envelope stripping to post-check |
| 2026-03-19 | §2 Behavioral Contracts (AMEND) | Add artifact-only output format constraint |
| 2026-03-19 | §3 Cost-Aware Routing (AMEND) | Enforce routing_class gating before execution |
| 2026-03-19 | §3 Task Routing / §4 Runtime Loop Step 3 (AMEND) | Add pre-assignment capability check to Orchestrator |

---

## §2 Reviewer Acceptance Criteria (AMEND)

> **Source:** Figma TaskCard test, 2026-03-19
> **Spec section affected:** §2 Agent Tiers — Reviewer acceptance criteria (v0.5.1)
> **Change type:** AMEND (extend existing three-dimension review framework)
> **P1–P6 alignment:** P1 (deny by default — unsolicited output is not permitted unless the task asked for it), P3 (transparency — scope violations are logged as structured events, not silently tolerated)

### Current Text (§2, Reviewer row)

> Reviewer evaluates three dimensions — *correctness* (is the output factually/technically right?), *format compliance* (does it match the expected schema?), and *completeness* (does it address ALL acceptance criteria, not just some?).

### Amended Text

Reviewer evaluates **four** dimensions:

1. **Correctness** — Is the output factually and technically right?
2. **Format compliance** — Does it match the expected schema?
3. **Completeness** — Does it address ALL acceptance criteria, not just some? An accurate but incomplete output is flagged for rework, not approved.
4. **Scope compliance** — Does the output stay within the boundaries of what was requested? Unsolicited content — sections, claims, API references, or capabilities not asked for in the acceptance criteria — is flagged as a scope violation. Scope violations are not automatically failures; the Reviewer evaluates whether the additional content is (a) accurate and (b) useful. But the burden is on the output to justify its existence — unsolicited content that is inaccurate is treated as a **higher-severity failure** than an inaccuracy within the requested scope, because it represents an agent generating unverified claims without being asked to.

**Rationale:** The Figma test produced an executor output where the requested work (Plugin API code) was correct, but the agent volunteered a REST API section that was entirely fabricated. The existing three-dimension framework would have scored this output as: correct (the asked-for parts were right), format-compliant (valid code structure), and complete (all acceptance criteria met). The fabrication would pass review because no dimension examines whether the output contains material beyond what was requested. Scope compliance closes this gap.

**Interaction with existing dimensions:** Scope compliance is evaluated last. An output that fails correctness, format, or completeness is rejected on those grounds regardless of scope. Scope compliance catches the specific case where an output passes the first three checks but contains unsolicited fabrication.

### Phase Activation

Phase 1. This is a review-framework change, not an infrastructure change. The Reviewer's evaluation prompt includes the fourth dimension from day one.

### Measurement (P5)

- **Scope violation rate:** % of executor outputs flagged for unsolicited content. Tracked per agent, per task type. Baseline established in first 30 days of Phase 1.
- **Scope violation accuracy:** % of scope violation flags that, on board review, were correctly identified (not false positives). Target: > 80% precision within 60 days.
- **Fabrication detection rate:** % of unsolicited content that contains verifiably false claims. This is the critical metric — a high rate means executors are hallucinating beyond their scope. Target: decreasing trend quarter-over-quarter.

### Ecosystem References

| Source | Key Takeaway | Applicability |
|--------|-------------|---------------|
| Figma TaskCard test (internal, 2026-03-19) | Agent produced correct requested output + fabricated unrequested REST API section in same response | Direct trigger for this change |
| OpenClaw CVE pattern (§0 P1) | Allow-by-default posture permits unexpected behaviors; deny-by-default must extend to output scope | P1 principle applied to output review, not just tool access |

---

## §4 Runtime Loop Step 6 — Self-Assessment Stripping (AMEND)

> **Source:** Figma TaskCard test, 2026-03-19
> **Spec section affected:** §4 Agent Runtime — Step 6 (GUARDRAIL POST-CHECK on output)
> **Change type:** AMEND (add check to existing post-check sequence)
> **P1–P6 alignment:** P2 (infrastructure enforces — the Reviewer scores the work, not the executor; self-assessment is a form of the executor influencing its own review), P3 (transparency — stripping is logged)

### Current Text (§4, Step 6, partial)

> GUARDRAIL POST-CHECK on output:
> - Schema validation (does output match expected format?)
> - Completeness check (v0.5.1): does output address all acceptance criteria...
> - PII detection (flag for data classification review)
> - Cost reconciliation (actual vs estimated)
> - Escalation trigger evaluation
> - DAG cycle detection (if creating subtasks)
> - can_assign_to validation (explicit ID list, no globs)
> - Adversarial content scan
> - Output quarantine gate...

### Amended Text

Add the following check to the post-check sequence, after schema validation and before the output quarantine gate:

- **Self-assessment stripping:** Scan executor output for self-assigned quality scores, confidence ratings, accuracy percentages, or evaluative language about the output's own quality (e.g., "Quality Score: 0.96", "Estimated accuracy: 98%", "This implementation is production-ready"). Strip these from the output before it reaches the Reviewer. Log the stripped content to `state_transitions.guardrail_checks_json` under a `self_assessment_stripped` key with the original text preserved for audit. The Reviewer must form its own evaluation without the executor's self-assessment anchoring its judgment.

**What this does NOT strip:** Confidence scores that are part of the task's acceptance criteria (e.g., if the task asks the agent to estimate its confidence as a structured output field per §19's evaluation protocol). The distinction is: a confidence score requested by the task schema is a deliverable; an unsolicited self-assessment is an attempt to influence review.

**Rationale:** The Figma test output included "Quality Score: 0.96 / 1.00" alongside a fabricated REST API section. Self-assigned scores create an anchoring effect — a Reviewer seeing "0.96" before evaluating the output is cognitively biased toward agreement. This is a subtle form of context poisoning (§5), where the adversarial content is not an injection attack but the agent's own self-promotion influencing its reviewer. The Reviewer's job is to evaluate independently. The executor's opinion of its own work is not evidence.

**Implementation note:** This is a pattern-matching check in the post-check pipeline (same infrastructure layer as the adversarial content scan). It does not require LLM invocation — a rule-based scanner for numeric self-ratings, percentage claims, and evaluative superlatives is sufficient. The pattern set is versioned alongside the content sanitization rule set (§5).

### Phase Activation

Phase 1. Implementable as part of the initial post-check pipeline. Low complexity — this is a deterministic text scan, not an LLM evaluation.

### Measurement (P5)

- **Stripping frequency:** % of executor outputs containing self-assessment language. Tracked per agent. A high rate indicates the agent's system prompt should be amended to discourage self-scoring (defense-in-depth: prompt advises, infrastructure enforces).
- **Reviewer score delta:** Compare Reviewer scores on outputs where self-assessment was stripped vs. a hypothetical where it wasn't (measured via shadow mode in Phase 2 — run the Reviewer on a sample of outputs with and without self-assessment to measure anchoring effect). If there is no measurable delta, the stripping can be relaxed to logging-only.

### Ecosystem References

| Source | Key Takeaway | Applicability |
|--------|-------------|---------------|
| Anchoring bias in peer review (Tversky & Kahneman, 1974) | Numeric anchors systematically bias subsequent judgments, even when the anchor is known to be arbitrary | Self-assigned scores anchor Reviewer evaluation |
| Figma TaskCard test (internal, 2026-03-19) | Agent self-scored 0.96 alongside fabricated content | Direct trigger |

---

## §2 Behavioral Contracts — Knowledge Boundary Declarations (AMEND)

> **Source:** Figma TaskCard test, 2026-03-19
> **Spec section affected:** §2 Agent Tiers — Behavioral Contracts subsection (v1.0.0, D7)
> **Change type:** AMEND (extend behavioral contract requirements)
> **P1–P6 alignment:** P1 (deny by default — if an agent's knowledge boundary doesn't cover a domain, it should not generate output in that domain), P5 (measure before you trust — boundary declarations are testable)

### Current Text (§2, Behavioral Contracts)

> Each agent declares a behavioral contract specifying its expected outputs, success criteria, and interaction norms. Reviewers validate agent work against these contracts rather than subjective judgment. The contract schema is implementation-defined but must be machine-readable and versioned alongside agent configuration. At minimum, a behavioral contract must include measurable success criteria (P5: measure before you trust).

### Amended Text

Each agent declares a behavioral contract specifying its expected outputs, success criteria, interaction norms, **and knowledge boundaries**. Reviewers validate agent work against these contracts rather than subjective judgment. The contract schema is implementation-defined but must be machine-readable and versioned alongside agent configuration. At minimum, a behavioral contract must include:

1. **Measurable success criteria** (P5: measure before you trust).
2. **Knowledge boundary declarations:** Explicit statements of what the agent does NOT know or cannot verify. These are anti-patterns (§4 `agents.md` — "anti-patterns improve agent performance more than positive instructions") applied to the agent's knowledge domain.

A knowledge boundary declaration specifies:

- **Domain boundaries:** Areas where the agent should not generate output without external verification. Example for a Figma executor: "Cannot verify REST API capabilities — Plugin API only. If a task requires REST API interaction, flag as requiring verification or escalate."
- **Confidence-gated output rules:** If the agent's confidence in a claim falls below a defined threshold, the agent must either (a) omit the claim, (b) explicitly mark it as unverified, or (c) escalate to a reviewer before including it. The threshold is set per agent in the behavioral contract, not self-assessed per output.
- **"I don't know" as a valid output:** The behavioral contract explicitly permits — and in boundary-adjacent domains, requires — the agent to state what it cannot verify rather than generating plausible approximations. An executor that says "I cannot generate a REST API version because Figma's REST API does not support node creation" has produced a more valuable output than one that fabricates a plausible-looking endpoint.

**Enforcement:** Knowledge boundary declarations are loaded as part of agent identity (§4 step 4a, ~520 token budget for identity block). The Reviewer checks outputs against declared boundaries — if an agent produces output in a domain it declared as a boundary, this is a scope violation (see §2 Reviewer acceptance criteria, scope compliance dimension). The boundary declarations are also used by the Orchestrator for task routing: if a task requires capabilities outside an agent's declared boundaries, it should be routed to a different agent or flagged for verification.

**Rationale:** The Figma test demonstrated that without explicit boundary declarations, an agent will fill gaps in its knowledge with plausible fabrication rather than acknowledging the gap. This is the default behavior of language models — generating likely next tokens is what they do. The boundary declaration gives the agent a structured alternative to fabrication: a defined protocol for handling uncertainty that the Reviewer can verify.

### Phase Activation

Phase 1. Knowledge boundary declarations are authored as part of each agent's `agents.md` definition. Initial boundaries are drafted by the board (who know what each agent should and should not do) and refined as Phase 1 measurement reveals where agents fabricate.

### Measurement (P5)

- **Boundary coverage:** % of executor fabrication incidents that occurred in a domain covered by a knowledge boundary declaration. Target: > 80% by end of Phase 1 (meaning boundaries are drawn in the right places).
- **Boundary compliance:** % of outputs where the agent correctly invoked the "I don't know" protocol when operating near a declared boundary. Measured by Reviewer flagging.
- **Boundary evolution:** Number of boundary additions per agent per month. A decreasing trend means boundaries are stabilizing. A spike means the agent encountered a new domain (expected during early phases).

### Ecosystem References

| Source | Key Takeaway | Applicability |
|--------|-------------|---------------|
| `agents.md` standard (§4) | Anti-patterns improve agent performance more than positive instructions | Knowledge boundaries are anti-patterns for the knowledge domain |
| OpenClaw 8.7% injection resistance (§0 P2) | Prompts alone fail to constrain agent behavior | Boundaries must be Reviewer-enforced (P2), not just declared in prompts |
| Figma TaskCard test (internal, 2026-03-19) | Agent fabricated REST API section rather than declaring the boundary of its knowledge | Direct trigger |

---

## §4 Runtime Loop Step 6 — Output Envelope Stripping (NEW)

> **Source:** HTML Hello World test, 2026-03-19
> **Spec section affected:** §4 Agent Runtime — Step 6 (GUARDRAIL POST-CHECK on output)
> **Change type:** AMEND (add check to existing post-check sequence)
> **P1–P6 alignment:** P2 (infrastructure enforces — the orchestration layer extracts the deliverable, not the downstream consumer), P3 (transparency — envelope metadata is logged separately, not discarded), P6 (familiar interfaces — automated harnesses and human reviewers both expect the artifact, not a report about the artifact)

### The Problem

When asked to produce an HTML document, the executor returned a Markdown "Campaign Execution" report containing the HTML inside a fenced code block, wrapped in execution logs, tool invocation records, a self-invented quality rubric, and a self-assigned score of 0.983. The actual HTML was valid. But:

1. **The automated evaluation harness scored it 0.** The harness expected an HTML document. It received a Markdown document. It couldn't find the deliverable inside the wrapper, so every iteration returned score 0.0000 — "did not improve over best 0."
2. **The wrapper is larger than the deliverable.** The HTML is ~40 lines. The execution report is ~80 lines. The agent produced 2x more scaffolding than work product.
3. **The wrapper mimics rigor without being rigorous.** The "Quality Score Breakdown" table with six sub-criteria and individual scores is theatrical — the agent invented the rubric, evaluated itself against it, and reported a passing grade. This is the self-assessment problem (see §4 Self-Assessment Stripping above) scaled up to a full performance review.

This is distinct from the self-assessment stripping change above. Self-assessment stripping removes self-assigned scores from an otherwise correctly formatted output. Output envelope stripping removes the entire wrapper — the execution log, the campaign framework, the step-by-step narration — and extracts the artifact the task actually requested.

### Amended Text

Add the following check to the post-check sequence, after self-assessment stripping and before the output quarantine gate:

- **Output envelope stripping:** When a task's acceptance criteria specify a deliverable format (e.g., HTML file, JSON object, SQL DDL, TypeScript module), the post-check pipeline extracts the deliverable from the executor's response and discards the surrounding narrative. Extraction rules:
  1. If the output contains a fenced code block (` ```html `, ` ```json `, ` ```sql `, ` ```typescript `, etc.) matching the expected deliverable format, extract the content of that block as the deliverable.
  2. If the output contains multiple fenced code blocks of the expected format, extract all of them and flag for Reviewer attention (the task may have expected one artifact but received multiple).
  3. The stripped envelope (everything outside the extracted deliverable) is logged to `state_transitions.guardrail_checks_json` under an `envelope_stripped` key. This preserves the execution narrative for audit without letting it contaminate the deliverable.
  4. If no extractable deliverable is found matching the expected format, the output is quarantined — it cannot transition to `review` until the Reviewer inspects it.

**What this does NOT strip:** If the task's acceptance criteria explicitly request an execution report, campaign log, or self-evaluation alongside the deliverable (e.g., a task that says "produce the HTML file and a brief summary of design decisions"), the envelope is part of the deliverable and is not stripped. The trigger is the mismatch between what was requested (an HTML file) and what was delivered (a Markdown report containing an HTML file).

**Why this is infrastructure, not prompt:** The executor's system prompt should also instruct the agent to return only the requested artifact (defense-in-depth). But the Hello World test demonstrates that prompts alone don't prevent envelope wrapping — the agent produced a full campaign execution framework despite no instruction to do so. The post-check pipeline must be able to extract the deliverable mechanically, regardless of how much wrapper the executor adds. This is P2: infrastructure enforces; prompts advise.

**Interaction with automated evaluation:** This change directly fixes the zero-score problem observed in the evaluation harness. Once the post-check extracts the HTML from the Markdown wrapper, the evaluation harness receives a valid HTML document and can score it on its actual merits.

### Phase Activation

Phase 1. This is a deterministic extraction step — pattern match on fenced code blocks, extract content. No LLM invocation required. Implementable as part of the initial post-check pipeline alongside self-assessment stripping.

### Measurement (P5)

- **Envelope frequency:** % of executor outputs that contain a wrapper envelope around the deliverable. Tracked per agent, per task type. A high rate indicates the agent's system prompt needs amendment. Target: decreasing trend as prompt-level instructions are tuned.
- **Extraction accuracy:** % of extracted deliverables that the Reviewer confirms are complete and correctly extracted (no truncation, no stray Markdown artifacts). Target: > 95% from day one — this is deterministic extraction, not LLM inference.
- **Harness pass-through rate:** % of extracted deliverables that the automated evaluation harness can parse and score (score > 0). This is the direct measure of whether the fix resolved the zero-score problem. Target: > 95%.

### Ecosystem References

| Source | Key Takeaway | Applicability |
|--------|-------------|---------------|
| HTML Hello World test (internal, 2026-03-19) | Evaluation harness returned score 0 on all iterations because deliverable was wrapped in Markdown | Direct trigger |
| Figma TaskCard test (internal, 2026-03-19) | Same wrapping pattern — correct code inside campaign execution scaffolding | Confirms this is a systemic agent behavior, not a one-off |

---

## §2 Behavioral Contracts — Artifact-Only Output Format Constraint (AMEND)

> **Source:** HTML Hello World test + Figma TaskCard test, 2026-03-19
> **Spec section affected:** §2 Agent Tiers — Behavioral Contracts subsection (v1.0.0, D7)
> **Change type:** AMEND (add output format constraint to behavioral contract requirements)
> **P1–P6 alignment:** P1 (deny by default — the executor produces only what was asked for), P2 (infrastructure enforces via envelope stripping above; prompt advises via this contract), P6 (familiar interfaces — downstream consumers expect the artifact, not a report about the artifact)

### Current Text (§2, Behavioral Contracts — as amended by Knowledge Boundary Declarations above)

> At minimum, a behavioral contract must include:
> 1. Measurable success criteria (P5).
> 2. Knowledge boundary declarations.

### Amended Text

At minimum, a behavioral contract must include:

1. **Measurable success criteria** (P5: measure before you trust).
2. **Knowledge boundary declarations** (see above).
3. **Output format contract:** When a task specifies a deliverable format, the executor's response MUST be the deliverable and only the deliverable. No execution logs, campaign reports, step narration, quality rubrics, or self-assessment. The executor does not explain how it built the artifact, does not narrate its tool usage, and does not evaluate the result. It returns the artifact.

   Exceptions: If the task's acceptance criteria explicitly request supplementary material (design rationale, test results, alternative approaches considered), that material is a separate structured attachment — not interleaved with the deliverable. The deliverable is always extractable as a standalone artifact.

   **Anti-patterns** (loaded into executor identity via `agents.md`):
   - Do NOT wrap deliverables in "Campaign Execution" or "Execution Report" framing
   - Do NOT include step-by-step narration of your process ("Step 1: Analyzing...", "Step 2: Generating...")
   - Do NOT invent quality rubrics or score your own output
   - Do NOT include "Execution Summary" blocks confirming success criteria were met
   - Do NOT include tool invocation logs or cost tracking in the deliverable (these are captured by the orchestration layer's audit trail — §4 step 5 — and do not belong in the output)

**Rationale:** Both tests (Figma and HTML Hello World) produced the same pattern: correct deliverable wrapped in 2-3x more scaffolding than the deliverable itself. The scaffolding is the agent performing "diligence theater" — mimicking what a quality process looks like without being one. The actual quality process is the Reviewer (§2), the post-check pipeline (§4 step 6), and the Tier 1/2 audit system (§8). The executor's job is to produce the artifact. Everything else is someone else's job.

**Relationship to other addendum entries:** This is the prompt-advises layer (defense-in-depth). Output envelope stripping (above) is the infrastructure-enforces layer. Self-assessment stripping catches scores even if the envelope stripping misses them. Scope compliance (Reviewer dimension) catches unsolicited content that makes it past both. All four layers address the same root behavior from different enforcement points.

### Phase Activation

Phase 1. Anti-patterns are loaded into executor `agents.md` definitions from day one. This is a zero-cost change — it's text in the agent identity block, consuming tokens from the existing ~520 token budget.

### Measurement (P5)

- **Envelope frequency** (shared with Output Envelope Stripping above): If the prompt-level anti-patterns are effective, envelope frequency should decrease. If it doesn't decrease, the prompt is failing and the infrastructure layer (envelope stripping) is doing all the work — which is acceptable (P2) but indicates the prompt needs revision.
- **Anti-pattern compliance:** % of executor outputs that contain zero instances of the listed anti-patterns. Target: > 90% within 30 days of deployment. Measured by the envelope stripping scanner logging what it finds.

### Ecosystem References

| Source | Key Takeaway | Applicability |
|--------|-------------|---------------|
| `agents.md` standard (§4) | Anti-patterns improve agent performance more than positive instructions | Output format anti-patterns are the highest-leverage prompt intervention for this behavior |
| HTML Hello World test (internal, 2026-03-19) | Agent produced 80 lines of execution scaffolding around 40 lines of HTML | Direct trigger |
| Figma TaskCard test (internal, 2026-03-19) | Same pattern — agent wrapped plugin code in campaign execution report | Confirms systemic behavior |

---

## §3 Cost-Aware Routing — Enforce Routing Class Gating Before Execution (AMEND)

> **Source:** HTML Hello World test, 2026-03-19
> **Spec section affected:** §3 The Task Graph — Cost-Aware Routing
> **Change type:** AMEND (close enforcement gap in existing routing hierarchy)
> **P1–P6 alignment:** P2 (infrastructure enforces — routing class must gate execution path, not just label the work item), P4 (boring infrastructure — deterministic templates are the boring, correct answer for trivial tasks), P5 (measure before you trust — misclassification is already tracked via `routing_class_final`)

### The Problem

§3 defines three routing classes — DETERMINISTIC, LIGHTWEIGHT, FULL — and a routing hierarchy where the cheapest handler runs first. It also defines the `routing_class` and `routing_class_final` columns on `work_items` for tracking misclassification. But the spec describes classification as something the Orchestrator does "at creation time using a lightweight heuristic" and routing class selection as something "the orchestration layer uses." There is no enforcement point that **prevents an LLM invocation when `routing_class = DETERMINISTIC`**.

The Hello World test demonstrates the consequence: a task that should have been DETERMINISTIC (an HTML boilerplate — zero reasoning required) was routed to a full LLM invocation that produced 80 lines of campaign execution scaffolding around 40 lines of HTML. The LLM didn't just cost more than necessary — it actively degraded the output by wrapping a trivial deliverable in theatrical complexity.

### Current Text (§3, Cost-Aware Routing, Implementation paragraph)

> The Orchestrator classifies each task at creation time using a lightweight heuristic (pattern matching on task type + acceptance criteria complexity, not an LLM call). Classification is stored on the work item as `routing_class` (DETERMINISTIC / LIGHTWEIGHT / FULL). The orchestration layer uses `routing_class` to select the execution path. Misclassification is caught by the Reviewer — if a DETERMINISTIC or LIGHTWEIGHT task fails review, it is re-queued at the next routing class up.

### Amended Text

The Orchestrator classifies each task at creation time using a lightweight heuristic (pattern matching on task type + acceptance criteria complexity, not an LLM call). Classification is stored on the work item as `routing_class` (DETERMINISTIC / LIGHTWEIGHT / FULL). **The orchestration layer enforces the routing class as a pre-execution gate in §4 step 3 (GUARDRAIL PRE-CHECK):**

1. **`routing_class = DETERMINISTIC`:** The orchestration layer executes the task via deterministic template or code generation. **No LLM is invoked.** The task does not enter the agent runtime loop (§4). Instead, a deterministic handler (template engine, SSL compiler per §18, or static code generator) produces the output directly. If no deterministic handler is registered for the task type, the routing class is automatically escalated to LIGHTWEIGHT and the escalation is logged.

2. **`routing_class = LIGHTWEIGHT`:** The task enters the agent runtime loop but is routed to the tier's `fallback_model` (e.g., Haiku for executor-tier tasks). The full-tier model is not invoked.

3. **`routing_class = FULL`:** Normal execution via the tier's primary model.

**Enforcement mechanism:** The `routing_class` check is added to §4 step 3 (GUARDRAIL PRE-CHECK), after authorization and before budget pre-authorization. If `routing_class = DETERMINISTIC` and the task enters the LLM execution path (step 5), the post-check (step 6) flags this as a `POLICY_VIOLATION` in `threat_memory` — the orchestration layer failed to enforce the routing gate. This catch detects bugs in the routing enforcement itself.

**Deterministic handler registry:** Phase 1 ships with deterministic handlers for:
- HTML boilerplate (Hello World, landing page skeletons, standard document structures)
- JSON schema generation from TypeScript interfaces
- SQL DDL generation from schema specifications
- SSL compilation (§18 — already covers ~80% of standard CRUD services)
- Format conversion (Markdown → HTML, JSON → CSV, etc.)

The handler registry follows the same pattern as the tool registry (§6) — content-addressed, board-approved, hash-verified. New deterministic handlers are registered through the tool acceptance policy.

**Misclassification is caught by the Reviewer** — if a DETERMINISTIC or LIGHTWEIGHT task fails review, it is re-queued at the next routing class up. The `routing_class_final` column records the class that actually completed the task, feeding the `v_routing_class_effectiveness` view (§8).

### Phase Activation

Phase 1. The routing classification heuristic and the three-class schema already exist in the spec. This change adds the enforcement gate (preventing LLM invocation for DETERMINISTIC tasks) and the deterministic handler registry. The handler registry starts small — 4-5 handlers for the most common trivial task types — and grows as measurement (P5) reveals which task types are consistently misrouted to LLM.

### Measurement (P5)

- **DETERMINISTIC bypass rate:** % of tasks classified DETERMINISTIC that are actually handled by deterministic handlers (no LLM invocation). Target: > 95%. Anything below indicates the handler registry is missing common task types.
- **DETERMINISTIC escalation rate:** % of DETERMINISTIC tasks that escalate to LIGHTWEIGHT because no handler exists. Target: decreasing trend as handlers are added.
- **Cost savings from routing enforcement:** Compare actual executor cost against projected cost if all tasks ran at FULL routing class. This is the direct dollar measure of whether routing is working. §3 projects a drop from $40-80/month to $15-35/month at Phase 1 volumes — this metric validates or invalidates that projection.
- **Misclassification rate** (existing metric from `v_routing_class_effectiveness`): % of tasks where `routing_class_final` differs from `routing_class`. A high DETERMINISTIC → LIGHTWEIGHT escalation rate means the Orchestrator's heuristic is too aggressive; a high FULL → LIGHTWEIGHT pattern means it's too conservative.

### Ecosystem References

| Source | Key Takeaway | Applicability |
|--------|-------------|---------------|
| §3 Cost-Aware Routing (existing spec) | Routing hierarchy defined but enforcement gap between classification and execution | Direct gap this change closes |
| §18 Service Specification Language | SSL compiler handles ~80% of standard CRUD deterministically | Existing deterministic handler — routing enforcement makes this bypass explicit |
| HTML Hello World test (internal, 2026-03-19) | DETERMINISTIC task routed to full LLM, producing 2x scaffolding vs deliverable | Direct trigger |
| Task decomposition model (§18) | `P(success) = p^d` — fewer decisions = higher success. Deterministic = zero decisions = 100% success for tasks within handler scope | Mathematical justification for routing enforcement |

---

## §3 Task Routing / §4 Step 3 — Pre-Assignment Capability Check (AMEND)

> **Source:** Figma TaskCard test, 2026-03-19
> **Spec section affected:** §3 The Task Graph — Task Routing; §4 Agent Runtime — Step 3 (GUARDRAIL PRE-CHECK)
> **Change type:** AMEND (add capability verification to assignment and pre-check)
> **P1–P6 alignment:** P1 (deny by default — an agent should not receive a task it cannot verify it can complete), P5 (measure before you trust — capability gaps are measurable via fabrication rate per task type)

### The Problem

§3 defines task routing as a static hash map lookup — task type maps to agent list. §4 step 3 (GUARDRAIL PRE-CHECK) checks authorization, budget, data classification, and tool access. Neither checks whether the assigned agent has the **domain knowledge** to complete the task.

The Figma test assigned a task requiring Figma Plugin API expertise to an executor that didn't have verified Figma API knowledge. The executor produced correct Plugin API code (it happened to know that API) but also fabricated a REST API section (it didn't know the REST API's limitations and couldn't distinguish what it knew from what it was inventing). A pre-assignment capability check would have caught the mismatch — or at minimum, flagged the task as requiring verification.

This gap exists because the current routing model (§3) routes by **task type** ("code_implementation" → executor-01, executor-02, executor-03) but not by **domain** ("figma_plugin_development" → executor with verified Figma knowledge). At the current scale (5-15 agents, Phase 1), most executors are generalists. But the Figma test proves that even generalist executors have domain-specific knowledge gaps that produce fabrication when hit.

### Current Text (§3, Task Routing)

> At the current scale (5-15 agents), routing is a static configuration — an O(1) hash map lookup:
> ```json
> {
>   "task_routing": {
>     "strategic_planning":    ["strategist"],
>     "code_implementation":   ["executor-01", "executor-02", "executor-03"],
>     ...
>   }
> }
> ```

### Amended Text

At the current scale (5-15 agents), routing is a static configuration — an O(1) hash map lookup by task type (unchanged). **In addition to task-type routing, the Orchestrator performs a capability check before assignment:**

1. **Extract domain tags from task.** The Orchestrator identifies domain-specific requirements from the task description and acceptance criteria. This is a lightweight heuristic (keyword matching, not LLM inference) that tags tasks with domain identifiers. Examples: a task mentioning "Figma Plugin API" gets tagged `figma_plugin`; a task mentioning "Postgres DDL" gets tagged `postgres`; a task mentioning "React component" gets tagged `react`.

2. **Check agent capability declarations.** Each agent's behavioral contract (§2) includes a `capabilities` list — domains the agent has been verified to operate in — alongside its knowledge boundary declarations (domains it cannot operate in). The Orchestrator checks whether the task's domain tags are covered by the target agent's capabilities list.

3. **Route based on match:**
   - **Full match** (all domain tags covered by agent capabilities): assign normally.
   - **Partial match** (some domain tags not in capabilities, none in knowledge boundaries): assign with a `verification_required` flag. The Reviewer is notified that the agent is operating outside its verified capabilities and should apply heightened scrutiny to those domains.
   - **Boundary conflict** (domain tags match a declared knowledge boundary): do NOT assign. The Orchestrator either (a) routes to a different agent whose capabilities cover the domain, or (b) if no capable agent exists, **creates a clarification task** — the Orchestrator escalates to the Architect or board with the specific capability gap identified, rather than assigning the task to an agent that has declared it cannot do the work.

**Interaction with knowledge boundary declarations (§2 addendum):** Knowledge boundaries define what agents *can't* do. Capability declarations define what agents *can* do. These are complementary — an agent might have neither a capability nor a boundary for a given domain (unknown territory), in which case the `verification_required` flag applies. The Orchestrator treats the absence of information as a risk signal, not as permission.

**Clarification requests:** When no capable agent exists for a task, the Orchestrator creates a clarification task rather than assigning optimistically. The clarification task asks the board (Phase 1) or the Architect (Phase 2+): "This task requires [domain] expertise. No agent has declared this capability. Options: (a) assign to [executor] with verification_required, (b) decompose the task to isolate the domain-specific portion, (c) defer until a capable agent is available." This is P6 — the system adapts to the gap rather than silently producing fabricated output.

### Current Text (§4, Step 3, GUARDRAIL PRE-CHECK)

> 3. GUARDRAIL PRE-CHECK (orchestration layer, not agent):
>    - HALT check (absolute priority, no caching)
>    - Authorization (is this task in my scope?)
>    - Budget pre-authorization (estimate cost, check limit)
>    - Data classification (am I cleared for this level?)
>    - Tool access validation (JWT claim check)

### Amended Text

> 3. GUARDRAIL PRE-CHECK (orchestration layer, not agent):
>    - HALT check (absolute priority, no caching)
>    - Authorization (is this task in my scope?)
>    - **Capability check (do my declared capabilities cover this task's domain tags? If partial match: set `verification_required`. If boundary conflict: reject assignment, escalate.)**
>    - Budget pre-authorization (estimate cost, check limit)
>    - Data classification (am I cleared for this level?)
>    - Tool access validation (JWT claim check)

The capability check runs after authorization (the agent must be permitted to work on this task type) and before budget pre-authorization (no point checking budget if the agent can't do the work). A boundary conflict rejection is logged to `state_transitions` with reason `'capability_boundary_conflict'` and the specific domain tags that triggered the conflict.

### Phase Activation

Phase 1, with graduated rollout:

- **Week 1-4:** Domain tagging heuristic deployed. All tasks tagged. Capability declarations drafted for each agent (informed by the knowledge boundary declarations from the behavioral contracts addendum). Capability check runs in **log-only mode** — mismatches are logged but assignments proceed normally. This builds the baseline data for tuning.
- **Week 5-8:** Capability check enforced. Boundary conflicts block assignment. Partial matches set `verification_required`. Clarification tasks created for unresolvable gaps.

This graduated rollout avoids blocking work in the first month while the tagging heuristic and capability declarations are calibrated.

### Measurement (P5)

- **Capability match rate:** % of task assignments where all domain tags are covered by agent capabilities. Target: > 80% by end of Phase 1 (meaning agents' capability declarations cover most of the work they're assigned).
- **Verification-required rate:** % of assignments flagged as partial match. A high rate indicates either (a) capability declarations are too narrow, or (b) tasks are being assigned to the wrong agents. Target: < 15%.
- **Boundary conflict rate:** % of attempted assignments blocked by knowledge boundary conflict. Target: low (< 5%) — this means the Orchestrator's task-type routing is mostly aligned with agent capabilities. A high rate means routing needs restructuring.
- **Fabrication rate by capability status:** Compare fabrication rates (measured by scope compliance violations) between full-match, partial-match, and log-only-mode assignments. If partial-match tasks have significantly higher fabrication rates, the capability check is correctly identifying risk. This is the validation metric for the entire mechanism.
- **Clarification task volume:** Number of clarification tasks created per week. A high sustained volume indicates a persistent capability gap that needs to be addressed (new agent, agent retraining, or task scope adjustment).

### Ecosystem References

| Source | Key Takeaway | Applicability |
|--------|-------------|---------------|
| Figma TaskCard test (internal, 2026-03-19) | Agent assigned a domain-specific task without capability verification; produced fabricated content in areas outside its knowledge | Direct trigger |
| §3 Task Routing (existing spec) | Routes by task type, not domain capability | Gap this change addresses |
| §2 Behavioral Contracts — Knowledge Boundary Declarations (this addendum) | Agents declare what they can't do; this change adds what they can do and wires both into routing | Complementary mechanism |
| DeepMind multi-agent coordination research (spec §20 reference) | Centralized topology optimal at 5-15 agent scale; routing decisions should be centralized at Orchestrator | Validates that capability checking belongs in the Orchestrator, not in agents self-selecting |

---

## Board Decision Required

These seven changes are interconnected and should be reviewed as a package. The defense-in-depth chain:

```
Routing (before the agent even touches the task):
  1. Routing class enforcement (§3) — trivial tasks never reach an LLM
  2. Pre-assignment capability check (§3/§4) — tasks routed to capable agents
     or escalated as clarification requests

Prevention (agent-level):
  3. Knowledge boundary declarations (§2) — agent knows what it doesn't know
  4. Artifact-only output format contract (§2) — agent is told not to wrap

Detection (post-check pipeline):
  5. Self-assessment stripping (§4 step 6) — scores removed before review
  6. Output envelope stripping (§4 step 6) — wrapper removed, artifact extracted

Catch-all (review):
  7. Scope compliance review dimension (§2) — Reviewer flags anything that
     slipped through all prior layers
```

**Classification:** Strategic (affects Orchestrator routing, Reviewer evaluation framework, post-check pipeline, and behavioral contract requirements — core governance and coordination mechanisms).

**Cost impact:** Low-to-moderate. The routing class enforcement and deterministic handler registry are the most substantial implementation items (~500-800 LOC for the handler registry + routing gate). The capability check adds a lookup step to the Orchestrator's assignment flow (~200-300 LOC). The post-check scanners (envelope stripping + self-assessment stripping) are ~300-400 LOC combined. The remaining changes are prompt-level additions to Reviewer and agent identity blocks.

**Cost savings:** Routing class enforcement directly reduces LLM spend. §3 projects executor costs dropping from $40-80/month to $15-35/month at Phase 1 volumes if 30-40% of tasks are handled deterministically. The Hello World test confirms that trivial tasks are currently consuming full LLM invocations — the savings are real and immediate.

**Risk if deferred:** Trivial tasks will continue consuming full LLM invocations (wasted spend + degraded output quality). Specialized tasks will continue being assigned without capability verification (fabrication risk). Executor outputs will continue wrapping deliverables in scaffolding (evaluation harness scores 0). Self-assigned scores will continue anchoring Reviewer judgment. These are Phase 1 blockers — the routing, execution, and review pipeline must work correctly before it processes real work.
