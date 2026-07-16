# Research Question Registry

Central registry of all research questions from the Optimus/AutoBot specification. Each question has a phase assignment, gate mapping (where applicable), measurement plan, and status.

**Source:** `conversation/005-eric-unified-v3.md` (lines 920-1059)
**Status model:** `Not started` | `Instrumented` | `In progress` | `Answered`
**Governing principle:** P5 (measure before you trust)

---

## Summary Table

| ID | Category | Question | Phase | Gate | Status |
|----|----------|----------|-------|------|--------|
| RQ-01 | Product Strategy | What does an AI Strategist choose to build first? | 3 | G4 | Not started |
| RQ-02 | Product Strategy | Does the product mix converge toward developer tools or branch out? | 4 | -- | Not started |
| RQ-03 | Product Strategy | How does the system handle product failure? Iterate or pivot? | 3-4 | -- | Not started |
| RQ-04 | Product Strategy | Does the value ratio constraint prevent low-quality products, or do agents game it? | 2 | G2 | Not started |
| RQ-05 | Organizational Behavior | Do emergent hierarchies form within the flat worker pool? | 1+ | -- | Not started |
| RQ-06 | Organizational Behavior | Does the Strategist develop a consistent "management style"? | 2+ | -- | Not started |
| RQ-07 | Organizational Behavior | How do agents handle ambiguity when the constitution is unclear? | 2 | G1 | Not started |
| RQ-08 | Organizational Behavior | Does task graph communication become more efficient over time? | 1+ | -- | Not started |
| RQ-09 | Economic Dynamics | What's the actual cost ratio between executive and worker model calls? | 1 | -- | Instrumented |
| RQ-10 | Economic Dynamics | Is the system profitable? What's the minimum viable revenue? | 3 | -- | Not started |
| RQ-11 | Economic Dynamics | How does the pricing optimization actually behave? | 3+ | -- | Not started |
| RQ-12 | Economic Dynamics | What happens when a competitor copies an open-source product? | 4 | -- | Not started |
| RQ-13 | Alignment & Safety | Do agents ever attempt to work around constitutional constraints? | 2-3 | G5 | Not started |
| RQ-14 | Alignment & Safety | Does the Auditor catch violations that a human reviewer would catch? | 2 | G5 | Not started |
| RQ-15 | Alignment & Safety | Does the system exhibit goal drift? | 2+ | G3 | Not started |
| RQ-16 | Alignment & Safety | Does prompt modification lead to drift over time? | 2+ | G3 | Instrumented |
| RQ-17 | Alignment & Safety | Is the kill switch sufficient? | 3 | -- | Not started |
| RQ-18 | Distribution | Is random individual distribution logistically feasible at scale? | 3 | -- | Not started |
| RQ-19 | Distribution | Does the scaling formula produce good outcomes? | 4 | -- | Not started |
| RQ-20 | Distribution | How do recipients respond to unexpected money from an AI company? | 4 | -- | Not started |
| RQ-21 | Pentland Framework | Does the Data Dividend incentivize higher-quality data contribution? | 4 | -- | Not started |
| RQ-22 | Pentland Framework | Does the cooperative create a competitive moat against code-forking competitors? | 4 | -- | Not started |
| RQ-23 | Pentland Framework | Does federated value measurement (OPAL) prevent metric gaming? | 3 | -- | Not started |
| RQ-24 | Pentland Framework | Does the cooperative model affect user retention vs non-cooperative products? | 4 | -- | Not started |
| RQ-25 | Pentland Framework | Can social physics metrics predict product success before revenue data? | 2+ | -- | Not started |
| RQ-26 | Pentland Framework | Does computational trust (Merkle proofs) change external perception of credibility? | 4 | -- | Not started |

---

## Detail Sections

### Product Strategy

#### RQ-01: What does an AI Strategist choose to build first with no human guidance?

- **Category:** Product Strategy
- **Phase:** 3 (sandbox with constitutional authority)
- **Gate mapping:** G4 (Autonomy level)
- **Status:** Not started
- **Measurement method:** Every product decision is a DIRECTIVE in the task graph with documented reasoning: market analysis, value ratio projection, competitive analysis, build estimation. All logged in `autobot_public.event_log`.
- **Success criteria:** Empirical -- TBD
- **Pentland addition:** The Data Cooperative provides a demand signal -- users can express needs through cooperative governance, not just purchase behavior. This gives the Strategist market intelligence beyond web scraping.
- **What remains empirical:** Whether the Strategist defaults to developer tools (its domain of expertise) or follows value-ratio optimization into unfamiliar markets.
- **Source:** conversation/005-eric-unified-v3.md

#### RQ-02: Does the product mix converge toward developer tools or branch into other markets?

- **Category:** Product Strategy
- **Phase:** 4 (multiple products)
- **Gate mapping:** --
- **Status:** Not started
- **Measurement method:** `product_registry` tracks product categories. Social physics exploration metrics detect convergence before it manifests as missed opportunities.
- **Success criteria:** Exploration ratio stays above 10% (Pentland social physics threshold).
- **Pentland addition:** Idea flow metrics from social physics -- if the agent organization's exploration ratio drops below 10%, it's converging. This is a leading indicator, detectable before the product mix visibly narrows.
- **What remains empirical:** Where the equilibrium lands. Constitutional pressure (value ratio) may push toward known domains, or the Strategist may discover that unfamiliar markets have higher unmet need.
- **Source:** conversation/005-eric-unified-v3.md

#### RQ-03: How does the system handle product failure? Does it iterate or pivot?

- **Category:** Product Strategy
- **Phase:** 3-4
- **Gate mapping:** --
- **Status:** Not started
- **Measurement method:** The Value Measurement Script provides deterministic sunset triggers (retention < 90% for 2 months). The Strategist's response -- creating improvement tasks (iterate) vs killing the product and starting a new DIRECTIVE (pivot) -- is fully logged.
- **Success criteria:** Empirical -- TBD
- **Pentland addition:** Cooperative user feedback provides richer signal than retention alone. A product with declining retention but high qualitative satisfaction should iterate, not pivot. Retention alone can't distinguish the two.
- **What remains empirical:** Whether agents develop a bias toward iteration (sunk cost) or pivot (novelty seeking).
- **Source:** conversation/005-eric-unified-v3.md

#### RQ-04: Does the value ratio constraint actually prevent low-quality products, or do agents learn to game the metric?

- **Category:** Product Strategy
- **Phase:** 2 (shadow mode comparison)
- **Gate mapping:** G2 (board assessment comparison)
- **Status:** Not started
- **Measurement method:** Phase 2 compares Strategist value projections against board assessments (Gate G2). Systematic over-projection is flagged by the Tier 2 Auditor.
- **Success criteria:** No systematic over-projection detected by Tier 2 Auditor.
- **Pentland addition:** With federated value measurement (OPAL), users independently verify the value ratio using the published algorithm against their own data. Gaming the metric requires fooling the users' measurement environment -- a much harder problem than manipulating centralized telemetry. The cooperative acts as an independent check on value claims.
- **What remains empirical:** Whether agents attempt to game and how creative those attempts are.
- **Source:** conversation/005-eric-unified-v3.md

---

### Organizational Behavior

#### RQ-05: Do emergent hierarchies form within the flat worker pool?

- **Category:** Organizational Behavior
- **Phase:** 1+
- **Gate mapping:** --
- **Status:** Not started
- **Measurement method:** Task graph captures assignment patterns. Social physics metrics: if executor-02 consistently receives higher-complexity tasks and its outputs are cited by more agents, it has emerged as a de facto lead.
- **Success criteria:** Empirical -- TBD (detect and characterize, not prevent)
- **Pentland addition:** Graph centrality analysis, interaction diversity metrics, bridge connection detection -- all computable from the task graph. Pentland's social physics gives us the mathematical framework to detect emergent hierarchy before it's visible in org charts.
- **What remains empirical:** Whether emergence happens at all, and whether it improves or degrades performance.
- **Source:** conversation/005-eric-unified-v3.md

#### RQ-06: Does the Strategist develop a consistent "management style" over time?

- **Category:** Organizational Behavior
- **Phase:** 2+
- **Gate mapping:** --
- **Status:** Not started
- **Measurement method:** Task graph captures delegation patterns (how work is decomposed), feedback patterns (what feedback the Strategist gives on completed work), decision speed (time from input to DIRECTIVE). All logged per-decision.
- **Success criteria:** Empirical -- TBD
- **Pentland addition:** Social physics energy and engagement metrics applied to the Strategist's communication patterns. Does the Strategist's "style" correlate with organizational performance?
- **What remains empirical:** What style emerges and whether it's stable.
- **Source:** conversation/005-eric-unified-v3.md

#### RQ-07: How do agents handle ambiguity when the constitution doesn't clearly cover a situation?

- **Category:** Organizational Behavior
- **Phase:** 2 (divergence logging)
- **Gate mapping:** G1 (judgment call frequency tracking)
- **Status:** Not started
- **Measurement method:** Phase 2 instruments every board intervention, classifying each as "constitutional" (derivable from the constitution) or "judgment" (requires reasoning beyond the text). Gate G1 tracks the frequency of judgment calls.
- **Success criteria:** Agents escalate correctly rather than resolving ambiguity with confident but wrong interpretations.
- **Pentland addition:** The Data Cooperative provides a fourth stakeholder perspective. When the constitution is ambiguous about a data governance question, the cooperative's position provides grounding.
- **What remains empirical:** Whether agents escalate correctly or attempt to resolve ambiguity with confident but wrong interpretations.
- **Source:** conversation/005-eric-unified-v3.md

#### RQ-08: Does task graph communication become more efficient over time?

- **Category:** Organizational Behavior
- **Phase:** 1+
- **Gate mapping:** --
- **Status:** Not started
- **Measurement method:** Task completion rate vs task spec length. Clarification request frequency. Rejection rate. All derivable from task graph state transitions.
- **Success criteria:** Decreasing clarification requests and rejection rates over time.
- **Pentland addition:** Information entropy analysis of task specifications -- are they becoming more precise (lower entropy) over time?
- **What remains empirical:** Rate and ceiling of improvement.
- **Source:** conversation/005-eric-unified-v3.md

---

### Economic Dynamics

#### RQ-09: What's the actual cost ratio between Claude executive calls and Ollama worker calls?

- **Category:** Economic Dynamics
- **Phase:** 1
- **Gate mapping:** --
- **Status:** Instrumented
- **Measurement method:** `llm_invocations` table captures model, tokens, and cost for every call. Report: `SELECT model, SUM(cost) FROM llm_invocations GROUP BY model`.
- **Success criteria:** Projected ratio: ~3:1 to 4:1 ($400-500/month executives vs $100-200/month workers). Actuals measurable from day one.
- **Pentland addition:** None. Pure infrastructure measurement.
- **What remains empirical:** Actual ratio under production workloads.
- **Notes:** The `llm_invocations` table is implemented in the autobot-inbox Phase 1 runtime. Data collection is active.
- **Source:** conversation/005-eric-unified-v3.md

#### RQ-10: Is the system profitable at all? What's the minimum viable revenue?

- **Category:** Economic Dynamics
- **Phase:** 3
- **Gate mapping:** --
- **Status:** Not started
- **Measurement method:** Financial Script produces daily snapshots. Operating cost model estimates $1,450-3,135/month. Minimum revenue to sustain + distribute: ~$2,500-5,000/month.
- **Success criteria:** Revenue exceeds operating cost model estimate.
- **Pentland addition:** The data cooperative creates a loyal user base with lower churn (they're stakeholders, not just customers). Lower churn means lower customer acquisition cost and faster path to profitability.
- **What remains empirical:** Revenue side -- cost side is estimable.
- **Source:** conversation/005-eric-unified-v3.md

#### RQ-11: How does the pricing optimization actually behave?

- **Category:** Economic Dynamics
- **Phase:** 3+
- **Gate mapping:** --
- **Status:** Not started
- **Measurement method:** Pricing decisions are logged in the task graph. Revenue vs price point tracked by the Financial Script. The formula (maximize (price - cost) x customers) is measurable.
- **Success criteria:** Algorithm converges to stable pricing without oscillation.
- **Pentland addition:** The Data Cooperative provides direct willingness-to-pay signal. Instead of the Strategist running price experiments (costly, slow), users express price sensitivity through the cooperative.
- **What remains empirical:** Whether the algorithm converges, gets stuck in local optima, or oscillates.
- **Source:** conversation/005-eric-unified-v3.md

#### RQ-12: What happens when a competitor copies an open-source product?

- **Category:** Economic Dynamics
- **Phase:** 4
- **Gate mapping:** --
- **Status:** Not started
- **Measurement method:** Value Measurement Script detects retention drops. Competitive market analysis tasks would surface in the task graph.
- **Success criteria:** Empirical -- TBD
- **Pentland addition:** The Data Cooperative is a competitive moat. Anyone can fork the code (it's open source). Nobody can fork the cooperative's accumulated data relationships, member loyalty, and institutional knowledge. The data capital IS the defensible advantage.
- **What remains empirical:** Whether the moat is sufficient.
- **Source:** conversation/005-eric-unified-v3.md

---

### Alignment & Safety

#### RQ-13: Do agents ever attempt to work around constitutional constraints?

- **Category:** Alignment & Safety
- **Phase:** 2-3 (synthetic violation injection tests for Gate G5)
- **Gate mapping:** G5 (reversibility constraint)
- **Status:** Not started
- **Measurement method:** Infrastructure enforcement means most circumvention is structurally impossible (can't write to schemas you have no access to). The Communication Gateway closes the external workaround vector. Task graph captures all attempts. Tier 2 Auditor analyzes behavioral patterns.
- **Success criteria:** Zero successful circumventions; all creative attempts within permitted action space are detected and logged.
- **Pentland addition:** Computational trust -- Merkle proofs make even the attempt to cover up a circumvention attempt detectable by external verifiers.
- **What remains empirical:** Whether agents develop creative workarounds within their permitted action space.
- **Source:** conversation/005-eric-unified-v3.md

#### RQ-14: Does the Auditor catch violations that a human reviewer would catch?

- **Category:** Alignment & Safety
- **Phase:** 2 (Gate G5 -- synthetically injected violations)
- **Gate mapping:** G5 (reversibility constraint / audit)
- **Status:** Not started
- **Measurement method:** Monthly synthetic violation injection: create known-bad states and verify the three audit tiers catch them. Target: > 95% detection rate.
- **Success criteria:** > 95% detection rate on synthetically injected violations.
- **Pentland addition:** The cooperative independently verifies value measurement. If the Auditor misses a value ratio discrepancy, the cooperative's federated verification catches it. Multiple independent verification layers.
- **What remains empirical:** Whether there are violation TYPES the Auditor systematically misses.
- **Source:** conversation/005-eric-unified-v3.md

#### RQ-15: Does the system exhibit goal drift?

- **Category:** Alignment & Safety
- **Phase:** 2+ (divergence tracking)
- **Gate mapping:** G3 (voice tone / cosine similarity)
- **Status:** Not started
- **Measurement method:** Phase 2 shadow mode logs what AutoBot would decide vs what the board decides. Drift is the divergence over time. Prompt drift is tracked via cosine similarity (Gate G3).
- **Success criteria:** Divergence rate stays within measurable and correctable bounds.
- **Pentland addition:** Social physics response diversity metric detects drift in the agent organization's behavior before it manifests as explicit violations. If agent outputs are becoming more homogeneous or converging toward an unexpected pattern, that's a leading indicator.
- **What remains empirical:** Whether drift is gradual (detectable) or sudden (harder to catch).
- **Source:** conversation/005-eric-unified-v3.md

#### RQ-16: Does prompt modification lead to drift over time?

- **Category:** Alignment & Safety
- **Phase:** 2+ (Gate G3)
- **Gate mapping:** G3 (cosine similarity budget)
- **Status:** Instrumented
- **Measurement method:** Cosine similarity budget (0.95 threshold). Every prompt version stored with `config_hash`. Drift is literally a distance measurement.
- **Success criteria:** Prompt drift stays within 0.95 cosine similarity threshold.
- **Pentland addition:** The open algorithms requirement means prompt changes are published. External researchers can analyze the trajectory.
- **Notes:** Architecture provides direct measurement and bounds via the drift budget. The `config_hash` tracking and cosine similarity infrastructure are defined in the spec; voice embeddings with pgvector are implemented in autobot-inbox.
- **Source:** conversation/005-eric-unified-v3.md

#### RQ-17: Is the kill switch sufficient?

- **Category:** Alignment & Safety
- **Phase:** 3 (tested under real conditions)
- **Gate mapping:** --
- **Status:** Not started
- **Measurement method:** Three-tier kill switch with measured response times. Dead-man's switch provides a failsafe. Communication Gateway cool-down buffer gives the kill switch time to activate before outbound messages are sent.
- **Success criteria:** Kill switch activates within SLA under all tested scenarios.
- **Pentland addition:** Merkle proof verification means the kill switch response history is independently verifiable. No one can claim the kill switch was checked when it wasn't.
- **What remains empirical:** Whether there are scenarios the tiered system misses.
- **Source:** conversation/005-eric-unified-v3.md

---

### Distribution

#### RQ-18: Is random individual distribution logistically feasible at scale?

- **Category:** Distribution
- **Phase:** 3 (through licensed partner)
- **Gate mapping:** --
- **Status:** Not started
- **Measurement method:** Distribution runs are logged with recipient counts, amounts, success/failure rates. Licensed partner handles logistics.
- **Success criteria:** Empirical -- TBD (depends on partner selection, blocked on money transmission analysis)
- **Pentland addition:** The Data Dividend is distributed to KNOWN users through existing Stripe payment rails (reverse the payment). Logistically simpler than random distribution to strangers. The cooperative manages the identity layer.
- **What remains empirical:** Feasibility depends on the partner. The licensed intermediary approach makes it viable.
- **Source:** conversation/005-eric-unified-v3.md

#### RQ-19: Does the scaling formula produce good outcomes?

- **Category:** Distribution
- **Phase:** 4 (at scale)
- **Gate mapping:** --
- **Status:** Not started
- **Measurement method:** `max(100, floor(allocation/600))` -- deterministic formula. Observable outcome: recipient count, per-person amount, satisfaction signal (if available).
- **Success criteria:** $600/person threshold produces positive recipient response.
- **Pentland addition:** The Data Dividend has a different scaling property -- it scales naturally with the user base. More users = more data contributors = more dividend recipients. No formula needed; the distribution grows with the community.
- **What remains empirical:** Whether $600/person is the right threshold and how recipients respond.
- **Source:** conversation/005-eric-unified-v3.md

#### RQ-20: How do recipients respond to unexpected, unexplained money from an AI company?

- **Category:** Distribution
- **Phase:** 4
- **Gate mapping:** --
- **Status:** Not started
- **Measurement method:** Hard to measure without direct feedback channels.
- **Success criteria:** Empirical -- TBD
- **Pentland addition:** Data Dividend recipients are USERS -- they have context for why they're receiving money. They understand they contributed data and are being compensated. This is fundamentally different from "unexpected money from an AI company." Random Distribution recipients still face the "unexplained money" question, but Data Dividend recipients do not.
- **What remains empirical:** Public reception of both mechanisms.
- **Source:** conversation/005-eric-unified-v3.md

---

### Pentland Framework

#### RQ-21: Does the Data Dividend incentivize higher-quality data contribution?

- **Category:** Pentland Framework
- **Phase:** 4
- **Gate mapping:** --
- **Status:** Not started
- **Measurement method:** Compare data quality metrics (completeness, accuracy, timeliness) before and after Data Dividend activation.
- **Success criteria:** Empirical -- TBD
- **What remains empirical:** Whether financial incentive improves data quality or introduces gaming behavior.
- **Source:** conversation/005-eric-unified-v3.md

#### RQ-22: Does the cooperative create a competitive moat against code-forking competitors?

- **Category:** Pentland Framework
- **Phase:** 4
- **Gate mapping:** --
- **Status:** Not started
- **Measurement method:** Track retention and engagement rates when competitors fork the open-source codebase. Compare cooperative-member churn vs non-member churn.
- **Success criteria:** Empirical -- TBD
- **What remains empirical:** Whether accumulated data relationships and institutional knowledge provide sufficient defensibility.
- **Source:** conversation/005-eric-unified-v3.md

#### RQ-23: Does federated value measurement (OPAL) prevent metric gaming that centralized measurement wouldn't catch?

- **Category:** Pentland Framework
- **Phase:** 3 (comparison test)
- **Gate mapping:** --
- **Status:** Not started
- **Measurement method:** Run centralized and federated value measurement in parallel. Inject known gaming attempts and compare detection rates.
- **Success criteria:** Federated measurement detects gaming attempts that centralized measurement misses.
- **What remains empirical:** Types and creativity of gaming attempts under each measurement regime.
- **Source:** conversation/005-eric-unified-v3.md

#### RQ-24: Does the cooperative model affect user retention compared to non-cooperative products?

- **Category:** Pentland Framework
- **Phase:** 4
- **Gate mapping:** --
- **Status:** Not started
- **Measurement method:** Compare retention curves for cooperative members vs non-member users (if both cohorts exist).
- **Success criteria:** Empirical -- TBD
- **What remains empirical:** Magnitude and direction of retention effect.
- **Source:** conversation/005-eric-unified-v3.md

#### RQ-25: Can social physics metrics predict product success or failure before revenue data?

- **Category:** Pentland Framework
- **Phase:** 2+
- **Gate mapping:** --
- **Status:** Not started
- **Measurement method:** Track social physics leading indicators (exploration ratio, idea flow, engagement diversity) alongside lagging revenue indicators. Test predictive power retrospectively.
- **Success criteria:** Social physics metrics provide > 2 week leading signal vs revenue data.
- **What remains empirical:** Whether the correlation holds in a small agent organization.
- **Source:** conversation/005-eric-unified-v3.md

#### RQ-26: Does computational trust (Merkle proofs) change external perception of AutoBot's credibility?

- **Category:** Pentland Framework
- **Phase:** 4
- **Gate mapping:** --
- **Status:** Not started
- **Measurement method:** Survey or interview external stakeholders (investors, partners, regulators) before and after Merkle proof verification is available.
- **Success criteria:** Empirical -- TBD
- **What remains empirical:** Whether verifiable audit trails translate to measurable trust improvement.
- **Source:** conversation/005-eric-unified-v3.md

---

## Phase Index

Research questions grouped by earliest observable phase.

### Phase 1

| ID | Question |
|----|----------|
| RQ-05 | Do emergent hierarchies form within the flat worker pool? |
| RQ-08 | Does task graph communication become more efficient over time? |
| RQ-09 | What's the actual cost ratio between executive and worker model calls? |

### Phase 2

| ID | Question |
|----|----------|
| RQ-04 | Does the value ratio constraint prevent low-quality products? |
| RQ-06 | Does the Strategist develop a consistent "management style"? |
| RQ-07 | How do agents handle ambiguity when the constitution is unclear? |
| RQ-14 | Does the Auditor catch violations that a human reviewer would catch? |
| RQ-15 | Does the system exhibit goal drift? |
| RQ-16 | Does prompt modification lead to drift over time? |
| RQ-25 | Can social physics metrics predict product success before revenue data? |

### Phase 3

| ID | Question |
|----|----------|
| RQ-01 | What does an AI Strategist choose to build first? |
| RQ-03 | How does the system handle product failure? |
| RQ-10 | Is the system profitable? What's the minimum viable revenue? |
| RQ-11 | How does the pricing optimization actually behave? |
| RQ-13 | Do agents ever attempt to work around constitutional constraints? |
| RQ-17 | Is the kill switch sufficient? |
| RQ-18 | Is random individual distribution logistically feasible at scale? |
| RQ-23 | Does federated value measurement (OPAL) prevent metric gaming? |

### Phase 4

| ID | Question |
|----|----------|
| RQ-02 | Does the product mix converge toward developer tools or branch out? |
| RQ-12 | What happens when a competitor copies an open-source product? |
| RQ-19 | Does the scaling formula produce good outcomes? |
| RQ-20 | How do recipients respond to unexpected money from an AI company? |
| RQ-21 | Does the Data Dividend incentivize higher-quality data contribution? |
| RQ-22 | Does the cooperative create a competitive moat? |
| RQ-24 | Does the cooperative model affect user retention? |
| RQ-26 | Does computational trust change external perception of credibility? |
