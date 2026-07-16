---
title: "Strategy Evaluation Protocol"
section: 19
tier: planning
description: "Strategist evaluation framework for market analysis and strategic recommendations"
---
## 19. Strategy Evaluation Protocol

> *Added in v0.5.1. Closes the product strategy gap identified by three-agent review: the spec had 90 pages of enforcement architecture and zero architecture for deciding what to build. Design converged from Liotta (architecture evaluation) and Linus (code review) — Liotta proved the distributed protocol wins long-term; Linus proved the implementation must start simple and earn its complexity.*

### The Problem

The Strategist (Claude Opus, 8K context per decision) cannot fit the inputs for a single product strategy decision into one context window. A strategy decision requires ~15,000-43,000 tokens of context: market signal, competitive landscape, user behavior, financial constraints, legal constraints, capability assessment, constitutional compliance. At 50 decisions/day over a multi-month product build, the Strategist loses architectural coherence around week 6.

Strategy is not a role. **Strategy is a protocol.**

### Tiered Decision-Making

Not every decision needs the same scrutiny. Tiering prevents the protocol from consuming the entire operating budget.

| Tier | Frequency | Trigger | Mechanism | Cost |
|------|-----------|---------|-----------|------|
| **Tactical** | ~90% of decisions | Task prioritization, resource allocation within established strategy | Single-pass structured evaluation | $0.03-0.08 |
| **Strategic** | ~9% of decisions | New product, market entry, architecture pivot, significant resource commitment | Three-perspective evaluation + compliance gate | $0.40-0.80 |
| **Existential** | ~1% of decisions | Product pivot, constitutional amendment, bet-the-org commitment | Full protocol with debate + human escalation if irreconcilable | $2.00+ |

Classification rule: DIRECTIVEs default to Strategic tier. Workstreams default to Tactical. The board can flag any decision as Existential. An agent can escalate Tactical → Strategic if its confidence score is < 3.

### Single-Pass Evaluation (Tactical Tier)

The default for 90% of decisions. One agent, one structured prompt, one pass:

```
DECISION: [proposed action]

Evaluate across three dimensions (1-5 score + 2 sentences max each):

1. OPPORTUNITY: What is the upside? Revenue impact, user value,
   competitive advantage.
2. RISK: What breaks? Probability of failure, blast radius,
   reversibility.
3. FEASIBILITY: Can we build this? Timeline, capability,
   dependencies.

COMPLIANCE CHECK: Violates constitutional constraints? YES = hard stop.

RECOMMENDATION: PROCEED / DEFER / REJECT
KILL CRITERIA: Measurable conditions under which to reverse this.
CONFIDENCE: 1-5. If < 3, escalate to Strategic tier.
```

Output is a structured record, not prose. Stored in the task graph as a decision record (see Decision Record Schema below).

### Three-Perspective Evaluation (Strategic Tier)

Three perspectives evaluate the same gathered signals independently. Each perspective commits its recommendation **before** seeing the others (no anchoring).

| Perspective | Optimizes For | Structural Role |
|-------------|--------------|-----------------|
| **Opportunity Assessor** | Value ratio (Law 1) and revenue potential (Law 2). Combines short-term revenue and long-term value into a single upside assessment. | What should we build? |
| **Risk Assessor** | Failure probability, blast radius, reversibility, legal exposure. Produces hard scores, not qualitative hedging. | What kills us? |
| **Capability Assessor** | Build velocity, agent error rates, technical dependencies, timeline realism. Grounds the discussion in what the system can actually deliver. | Can we actually do this? |

Each perspective outputs structured data:

```json
{
  "perspective": "risk",
  "recommendation": "DEFER",
  "confidence": 4,
  "scores": {
    "probability_of_failure": 0.35,
    "impact": "HIGH",
    "reversibility": "LOW"
  },
  "rationale": "Payment processing requires money transmission license we don't have.",
  "kill_criteria": "If legal counsel confirms MTL requirement by Phase 2, abandon this product line.",
  "counter_evidence_required": true
}
```

**Synthesis step:** The Strategist receives all three structured evaluations (~2,000 tokens total, not prose summaries) and produces a decision. If perspectives are irreconcilable (e.g., Opportunity says PROCEED, Risk says REJECT with P(failure) > 0.3 AND impact = HIGH), the decision is **not synthesized into a mediocre compromise** — it is escalated to the board with the specific disagreement summarized.

**Hard thresholds (non-overridable):**
- Risk Assessor assigns P(failure) > 0.3 AND impact = HIGH → auto-blocked, no debate override
- Compliance gate returns YES (violates constitutional constraints) → hard stop
- All three perspectives agree on REJECT → rejected without Strategist synthesis

**Compliance gate:** Constitutional compliance is NOT a perspective in the debate. It runs after the Strategist's decision as a validation step. It can hard-block. It cannot be outvoted.

### Full Protocol (Existential Tier)

For the ~1% of decisions that are genuinely bet-the-org: the three-perspective evaluation runs, followed by a structured adversarial debate (max 2 rounds). If still irreconcilable after 2 rounds, the system explicitly escalates to the human board with the disagreement documented. The system is designed to say "I cannot decide this" rather than being forced to produce an answer.

### Decision Record Schema

Every strategic decision is stored as a structured record in the task graph, not as LLM debate transcripts. The schema of what you store matters more than the number of agents reading it.

**ADR alignment (v0.6 note):** This schema is functionally an Architecture Decision Record (ADR) system. The ecosystem consensus from ruflo/claude-flow and AndrewAltimit/template-repo is that agents referencing structured decision records produce more consistent, aligned code than agents given freeform instructions. The `strategic_decisions` table serves this purpose — when an executor works on a task, it can query the decision records that led to this task's existence and understand the rationale, constraints, and kill criteria. See §20 for deferred ADR formalization work.

```
strategic_decisions (in agent_graph schema):

  id                    -- UUID
  decision_type         -- ENUM: tactical, strategic, existential
  proposed_action       -- TEXT (one sentence)
  rationale             -- TEXT (two sentences max)
  alternatives_rejected -- JSONB (array of {option, reason})
  kill_criteria         -- JSONB (array of measurable conditions)
  perspective_scores    -- JSONB (opportunity, risk, capability scores)
  confidence            -- INTEGER (1-5)
  recommendation        -- ENUM: proceed, defer, reject, escalate
  outcome               -- ENUM: NULL (pending), succeeded, failed, reversed
  superseded_by         -- UUID (FK to a later decision that overrode this)
  dependent_decisions   -- UUID[] (decisions that depend on this rationale)
  created_at            -- TIMESTAMPTZ
  decided_by            -- TEXT (agent_id or 'board')
```

This is the persistent memory for multi-month product builds. When the Strategist evaluates a decision in week 12, it queries `strategic_decisions` for all decisions tagged as dependencies of the current product. It sees structured rationale and kill criteria — not compressed summaries of forgotten conversations.

### Signal Gathering

Strategic and Existential decisions require structured input signals before evaluation. These are gathered as parallel Executor-tier tasks:

| Signal | Source | Output Schema | Frequency |
|--------|--------|---------------|-----------|
| Market opportunity | Web search via Gateway (structured output) | `{ market_size, growth_rate, competition_density, entry_barriers }` | Per DIRECTIVE |
| Competitive landscape | Web search (mandatory counter-evidence for opportunity claims) | `{ competitors[], feature_gaps[], pricing_range }` | Per DIRECTIVE |
| Build capability | Task graph query (historical velocity, error rates, agent performance) | `{ avg_build_time, p95_error_rate, available_capacity }` | Computed |
| Financial constraints | Financial Script output (SELECT only) | `{ monthly_burn, runway_months, budget_available }` | Computed |
| Legal constraints | Static knowledge + §17 obligation matrix | `{ blocked_by[], requires_counsel[] }` | Per DIRECTIVE |
| User demand (Phase 2+) | Data Cooperative signals | `{ demand_score, willingness_to_pay, unmet_needs[] }` | Monthly |

### Measuring Strategy Quality (P5)

The protocol includes measurement infrastructure from day one. The key metric is **decision reversal rate** — how often a decision is later superseded or reversed.

```sql
SELECT
  decision_type,
  COUNT(*) as total_decisions,
  COUNT(*) FILTER (WHERE superseded_by IS NOT NULL) as reversals,
  ROUND(100.0 * COUNT(*) FILTER (WHERE superseded_by IS NOT NULL)
    / COUNT(*), 2) as reversal_pct
FROM strategic_decisions
WHERE created_at > NOW() - INTERVAL '90 days'
GROUP BY decision_type;
```

Additional metrics tracked:
- **Downstream task failure rate**: decisions whose dependent tasks fail at > 30%
- **Kill criteria trigger rate**: how often kill criteria are hit (too frequent = bad decisions; never = criteria too loose)
- **Confidence calibration**: decisions with confidence 5 should succeed > 90%; confidence 2 should succeed ~50%
- **Perspective divergence**: how often the three perspectives disagree (too little = groupthink; too much = poor signal quality)

### Phase Activation

| Phase | Strategy Protocol | Measurement |
|-------|------------------|-------------|
| **Phase 1** | Single-pass structured evaluation for all decisions. Board sets product strategy via DIRECTIVEs. | Instrument decision reversal rate from day one. Track all Strategist recommendations vs board decisions. |
| **Phase 1, week 4+** | Three-perspective evaluation runs in **shadow mode** for DIRECTIVE-level decisions. Compares protocol recommendations to board decisions. | Shadow divergence rate. If protocol agrees with board > 80% → G4 progressing. |
| **Phase 2** | Three-perspective evaluation active for Strategic tier. Single-pass for Tactical. | Decision reversal rate comparison: single-pass vs three-perspective. Prediction accuracy (Brier scores). |
| **Phase 3+** | Full tiered protocol active. Model diversity for perspectives when budget allows. | Autonomous decision quality. Kill criteria effectiveness. |

### Scaling with Model Capability

The protocol is designed to become MORE valuable as models improve, not obsolete:

- Better models → better individual perspectives → better ensemble quality (super-linear scaling)
- Larger context windows do NOT eliminate the protocol's advantage: attention quality degrades in long contexts ("Lost in the Middle"), while each perspective agent maintains dense, domain-relevant context
- Phase 3+: different model families for different perspectives (e.g., one model fine-tuned on risk analysis, another on market analysis) to ensure genuine perspective independence

**The risk to monitor:** If all perspectives converge to the same answer on every decision, perspective independence has collapsed. The perspective divergence metric above detects this. Mitigation: introduce model diversity or restructure perspective prompts.

### Cost Impact

| Scenario | Monthly Cost | % of Operating Budget |
|----------|-------------|----------------------|
| All tactical (single-pass, 50/day) | ~$75-120 | 2-3% |
| 90% tactical / 9% strategic / 1% existential | ~$145 | 3-7% |
| All strategic (NOT recommended) | ~$900-1,200 | 20-27% |

The tiered approach keeps strategy evaluation at 3-7% of the operating budget.

---
