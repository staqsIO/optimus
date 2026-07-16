# Spec Amendment: §19.1 Market Discovery Protocol

> **Target version:** v0.7.0
> **Section:** New subsection under §19 (Strategy Evaluation Protocol)
> **Status:** DRAFT — requires board review
> **Authors:** Dustin, Claude (drafting assistance)
> **Inputs:** GitHub ecosystem analysis (NioPD market-researcher agent, reddit-research-mcp server, BigIdeasDB pain point pipelines, Apify Reddit Pain Finder), gap analysis against §19 Signal Gathering table
> **Depends on:** §19 Strategy Evaluation Protocol, §6 Tool Integrity Layer, §7 Communication Gateway, §3 Cost-Aware Routing

---

## Problem Statement

The Strategy Evaluation Protocol (§19) defines rigorous architecture for *evaluating* strategic decisions once proposed, but is silent on *discovery* — how the system identifies opportunities worth evaluating in the first place.

The §19 Signal Gathering table specifies "web search via Gateway (structured output)" for market opportunity and competitive landscape signals, but provides no workflow, methodology, output schema, or cadence for research tasks. This gap means:

1. **No research decomposition pattern.** "Do market research" is not a task an Executor can act on. Research requires a chain of subtasks — source discovery, content extraction, signal synthesis, opportunity scoring — each with distinct acceptance criteria.
2. **No structured output for research findings.** §19 defines output schemas for strategic decisions but not for the research inputs that feed them. Research findings that arrive as prose summaries lose structure when loaded as context.
3. **No continuous environmental scanning.** Signal gathering is reactive (per-DIRECTIVE). The system cannot proactively surface opportunities it wasn't asked to find.
4. **No research-specific tool governance.** Market research depends on External-Read tools (§6 classification) — web search, community analysis, review aggregation — but the spec provides no guidance on which research tools to register, how to govern their output, or how to manage research context budgets.

The GitHub ecosystem has converged on solutions to each of these gaps. This amendment adopts the proven patterns.

---

## 19.1 Market Discovery Protocol

### Design Principles

This protocol is governed by the same principles as the rest of the system:

- **P1 (Deny by default):** Research tools are External-Read classified (§6) and require board approval before registration. No research tool is available unless explicitly allowed.
- **P2 (Infrastructure enforces):** Research output is validated against structured schemas by the orchestration layer, not by the researching agent's self-assessment.
- **P4 (Boring infrastructure):** Research runs through the existing task graph as Executor-tier tasks. No new infrastructure components. No custom research database. Findings are stored as structured records in the task graph, queryable by the Strategist.
- **P6 (Familiar interfaces):** Research findings are pushed to the board via the same event digest channels as everything else. The board doesn't need a separate research dashboard.

### Research Task Decomposition

Market research decomposes into five sequential subtasks within the task graph. This pattern is derived from NioPD's market-researcher agent (iflow-ai/NioPD, MIT license, 60K+ project ecosystem) and adapted to Optimus's task graph model.

Each subtask is an independent work item in the task graph, assigned to an Executor, with explicit acceptance criteria and a structured output schema. The Orchestrator creates the subtask chain when a research DIRECTIVE or workstream is initiated.

| Step | Task Type | Routing Class | Acceptance Criteria | Output Schema |
|------|-----------|---------------|---------------------|---------------|
| 1. **Scope Definition** | LIGHTWEIGHT | Clarify research topic, identify sub-topics, define relevance timeframe, generate 5-10 search queries | `research_scope` (see below) |
| 2. **Source Discovery** | FULL | Execute search queries via registered research tools, evaluate source credibility, select 5-8 highest-quality sources prioritizing data over opinion | `source_list` (see below) |
| 3. **Content Extraction** | FULL | For each source, extract quantitative data points (market size, growth rates, adoption rates), competitive signals, pain points, and conflicting viewpoints | `extracted_signals[]` (see below) |
| 4. **Signal Synthesis** | FULL | Cross-reference signals across sources, identify patterns, score opportunities, flag contradictions | `research_findings` (see below) |
| 5. **Opportunity Scoring** | LIGHTWEIGHT | Score each identified opportunity against Optimus's build capability and constitutional constraints; produce structured input for §19 evaluation | `scored_opportunities[]` (see below) |

**Key constraint:** Steps 2-3 involve External-Read tool invocations routed through the Communication Gateway (§7). The researching Executor never sees raw external content — it receives structured extractions produced by the Gateway's inbound processing pipeline (§7, step 3). This preserves the Lethal Trifecta mitigation: the Executor has LOW private data access and NONE external comms.

### Output Schemas

Research outputs are structured JSON records stored as task outputs in the task graph. They are queryable by the Strategist and loadable as Q2-tier context (reviewed AI output) once they pass Reviewer validation.

#### `research_scope`

```json
{
  "topic": "string — one-sentence research question",
  "sub_topics": ["string[] — 3-5 sub-topics to investigate"],
  "relevance_timeframe": "string — e.g., 'past 12 months'",
  "search_queries": ["string[] — 5-10 specific search queries"],
  "exclusions": ["string[] — topics/markets explicitly out of scope"],
  "target_customer_profile": "string — who would buy this (optional, for niche research)"
}
```

#### `source_list`

```json
{
  "sources": [
    {
      "url": "string",
      "title": "string",
      "source_type": "enum: industry_report | news | academic | community_discussion | product_review | government_data",
      "credibility_score": "integer 1-5",
      "credibility_rationale": "string — one sentence",
      "relevance_to_scope": "string — one sentence"
    }
  ],
  "queries_executed": ["string[] — actual queries run"],
  "tools_used": ["string[] — registered tool IDs used"]
}
```

#### `extracted_signals`

```json
{
  "source_url": "string",
  "data_points": [
    {
      "type": "enum: market_size | growth_rate | adoption_rate | competitor_count | pricing_data | pain_point | feature_gap | regulatory_change | technology_trend",
      "value": "string — the data point",
      "confidence": "enum: stated_fact | inferred | estimated",
      "date_of_data": "string — when this data was current"
    }
  ],
  "pain_points": [
    {
      "description": "string",
      "severity": "enum: mild | moderate | severe",
      "frequency_signal": "string — evidence of how common this is",
      "existing_solutions": ["string[] — current alternatives users mention"],
      "solution_gaps": ["string[] — what existing solutions fail to address"]
    }
  ],
  "competitive_signals": [
    {
      "competitor": "string",
      "strengths": ["string[]"],
      "weaknesses": ["string[]"],
      "pricing": "string — if available",
      "user_sentiment": "enum: positive | mixed | negative"
    }
  ],
  "contradictions": ["string[] — signals that conflict across sources"]
}
```

#### `research_findings`

```json
{
  "executive_summary": "string — 3 sentences max",
  "market_opportunities": [
    {
      "opportunity_id": "string — unique within this research",
      "description": "string — one sentence",
      "target_market": "string — who specifically has this problem",
      "estimated_market_size": "string — with confidence qualifier",
      "competition_density": "enum: none | low | medium | high | saturated",
      "entry_barriers": ["string[]"],
      "supporting_signals": ["reference to extracted_signals data_points"],
      "contradicting_signals": ["reference to extracted_signals contradictions"],
      "time_sensitivity": "enum: urgent | moderate | evergreen"
    }
  ],
  "key_trends": [
    {
      "trend": "string",
      "direction": "enum: growing | stable | declining",
      "relevance": "string — why this matters for Optimus"
    }
  ],
  "research_gaps": ["string[] — what we couldn't determine and why"]
}
```

#### `scored_opportunities[]`

```json
{
  "opportunity_id": "string — from research_findings",
  "build_feasibility": {
    "score": "integer 1-5",
    "rationale": "string",
    "estimated_build_weeks": "integer",
    "required_capabilities": ["string[] — what agents/tools are needed"],
    "capability_gaps": ["string[] — what we'd need to add"]
  },
  "revenue_potential": {
    "score": "integer 1-5",
    "pricing_model": "string — suggested pricing approach",
    "estimated_mrr_at_100_customers": "number",
    "path_to_first_customer": "string"
  },
  "constitutional_compliance": {
    "passes": "boolean",
    "issues": ["string[] — any constitutional constraints this triggers"],
    "law1_value_ratio": "string — preliminary net-positive assessment",
    "legal_requirements": ["string[] — from §17 matrix"]
  },
  "recommendation": "enum: evaluate_strategic | evaluate_tactical | defer | reject",
  "rationale": "string — 2 sentences max"
}
```

### Research Tool Governance

Research requires External-Read tools (§6 classification). These tools are registered in the Tool Integrity Layer following the standard approval path (board approval + security review). The following tool categories are relevant for market research:

| Tool Category | Example Tools | Risk Class | Registration Notes |
|---------------|--------------|------------|-------------------|
| Web search | Gateway web search (already in system) | External-Read | Already governed by Gateway inbound processing |
| Community analysis | MCP-compatible Reddit research servers (e.g., reddit-research-mcp pattern) | External-Read | Semantic search across community discussions; output must conform to `extracted_signals` schema; board approval required |
| Review aggregation | App store review APIs, G2/Capterra APIs | External-Read | Structured complaint/feature-request extraction; rate-limited |
| Job board analysis | Job posting APIs (proxy signal for market demand) | External-Read | Used to identify pain points and unmet needs by industry |
| Competitor analysis | Website intelligence tools (pricing, feature, positioning extraction) | External-Read | Structured extraction only; no credential-based access |

**MCP compatibility note:** The reddit-research-mcp server (king-of-the-grackles/reddit-research-mcp) demonstrates a three-layer MCP architecture (discover → schema → execute) that is directly compatible with our §6 Tool Integrity Layer. Its operations — subreddit discovery via semantic vector search, post search, comment analysis, and persistent feed management — map to the Source Discovery and Content Extraction steps above. If the board approves community analysis tools, MCP-compatible servers following this pattern are the preferred integration approach.

**Tool registration is a Phase 1 deliverable (per §6 Tool Acceptance Policy).** No research tools beyond the Gateway's built-in web search may be used until the board approves the tool acceptance policy. Phase 1 research uses web search only. Community analysis and other specialized tools are Phase 2 additions.

### Context Budget for Research

Research tasks generate substantial external content that must be compressed to fit agent context budgets (§4). Research-specific rules:

- **Raw source content** is Q4-tier (external/untrusted) per §4 data quality tiers. Capped at 15% of context budget.
- **Extracted signals** (post-Reviewer validation) are Q2-tier. Loaded with normal priority.
- **Scored opportunities** that feed into §19 evaluation are Q2-tier.
- **Source Discovery** (step 2) is the most token-expensive step. The Executor receives search result summaries, not full page content. Full page content is fetched only for the 5-8 selected sources in Content Extraction (step 3).
- **Content Extraction** output per source is capped at 1,000 tokens. The Executor must compress findings into the structured `extracted_signals` schema, not produce prose summaries.
- **Total research context** (all five steps combined) should remain under 8,000 tokens when loaded by the Strategist for evaluation. The `research_findings` schema is designed to be this summary layer.

### Phase 1: Board-Initiated Discovery (Option A)

In Phase 1 (Full HITL), research is initiated manually:

1. The board creates a DIRECTIVE with `type: research` in the task graph (e.g., "Research micro-SaaS opportunities in the $10-50/month range for underserved professional niches").
2. The Orchestrator decomposes the DIRECTIVE into the five-step research subtask chain.
3. Executors perform each step using web search via the Gateway.
4. The Reviewer validates each step's output against the defined schemas (structural validation) and acceptance criteria (quality validation — are the sources credible? Are the signals specific, not vague?).
5. The Strategist receives the scored opportunities and runs §19 evaluation (single-pass tactical for each opportunity; strategic tier for any that score ≥ 4 on both feasibility and revenue potential).
6. Results are pushed to the board via event digest.

**Phase 1 cost estimate:** A single research cycle (one topic, 5-8 sources) requires approximately 5-8 Executor tasks (Haiku) + 1 Reviewer pass (Sonnet) + 1 Strategist evaluation (Opus). Estimated cost: $0.50-1.50 per research cycle. At 2-3 research cycles per week: $4-18/month. Negligible relative to operating budget.

### Phase 2: Proactive Market Scanner (Option B)

In Phase 2 (Tactical Autonomy), add a recurring Market Scanner function:

1. **Scheduled scan task:** A recurring task in the task graph runs weekly (configurable), initiated by the Orchestrator without board intervention.
2. **Scan scope:** Defined by a board-approved `scan_config` specifying target markets, customer profiles, and competitive boundaries. The Strategist may propose scope expansions; the board approves.
3. **Scan sources:** In addition to web search, community analysis tools (if board-approved in Phase 2 tool acceptance) monitor target forums and review sites for pain point signals.
4. **Delta reporting:** The scanner compares new findings against previously scored opportunities in the task graph. Only *new* signals and *changed* scores are surfaced — the board doesn't re-read the entire market landscape weekly.
5. **Opportunity pipeline:** Scored opportunities accumulate in the task graph as a queryable pipeline. The Strategist queries this pipeline when evaluating DIRECTIVEs, providing persistent market intelligence that survives context window limits.
6. **Feed management:** Borrowing from the reddit-research-mcp pattern, research configurations are saved as persistent "feeds" — named collections of sources, queries, and subreddit lists that can be resumed without starting from scratch. Feeds are stored as task graph records, not in a separate database.

**Phase 2 cost estimate:** Weekly scans across 3-5 topic areas, each requiring a research cycle: $12-75/month. With community analysis tools adding 2-3 additional tool invocations per scan: $20-90/month. Still within 2-4% of operating budget.

### Phase 3+: Research Memory and Specialization (Option C — Deferred)

Deferred capabilities for evaluation once Phase 1-2 research produces sufficient history:

- **Research memory:** Accumulated market intelligence stored as structured records, queryable across research cycles. The Strategist references historical opportunity scores to detect trend changes.
- **Paid data sources:** Market research APIs, SEO tools, industry databases registered as External-Read tools when research volume justifies the cost.
- **Research specialization within Executor tier:** Dedicated research Executor(s) with higher context budgets and research-specific tool permissions, rather than using general-purpose Executors for all research tasks.
- **Automated opportunity-to-DIRECTIVE pipeline:** When a scored opportunity exceeds configurable thresholds on both feasibility and revenue, the Strategist automatically creates a DIRECTIVE for §19 strategic evaluation (with board approval in Phase 2; autonomous in Phase 3).

---

## Ecosystem References

| Reference | Relevance | License |
|-----------|-----------|---------|
| **NioPD market-researcher** (iflow-ai/NioPD) | Agent definition for structured market research with 6-step methodology (scope → search → extract → categorize → contextualize → report). Validates decomposition into sequential subtasks with structured outputs. | MIT |
| **reddit-research-mcp** (king-of-the-grackles/reddit-research-mcp) | MCP-compatible Reddit research server with semantic vector search across 20K+ subreddits, three-layer architecture (discover → schema → execute), and persistent feed management. Directly compatible with §6 Tool Integrity Layer. | MIT |
| **BigIdeasDB / Painpoint.space** | SaaS products validating the "continuous pain point monitoring" pattern — automated pipelines scanning Reddit, app stores, G2, ProductHunt for recurring complaints. Validates Option B (Market Scanner). | Commercial (pattern reference only) |
| **Apify Reddit Pain Finder** | Deterministic (no LLM) pain point classifier — rule-based classification of pain types (pricing, missing features, workflow friction, switching tools) with severity ranking. Validates DETERMINISTIC routing class for classification subtasks. | Commercial (pattern reference only) |
| **contains-studio/agents trend-researcher** | Claude Code subagent for market trend analysis specializing in viral opportunities and emerging user behaviors. Uses WebSearch + WebFetch tools. Validates the research-as-agent-definition pattern. | Open source |

---

## Changes to Existing Sections

### §19 Signal Gathering Table — Expanded

Replace the current Signal Gathering table with:

| Signal | Source | Output Schema | Frequency | Discovery Protocol Step |
|--------|--------|---------------|-----------|------------------------|
| Market opportunity | Discovery Protocol (§19.1) — research subtask chain | `research_findings` → `scored_opportunities` | Per DIRECTIVE (Phase 1); weekly scan (Phase 2+) | Steps 1-5 |
| Competitive landscape | Discovery Protocol (§19.1) — Content Extraction step | `extracted_signals.competitive_signals[]` | Per DIRECTIVE (Phase 1); weekly scan (Phase 2+) | Step 3 |
| Pain point analysis | Discovery Protocol (§19.1) — Content Extraction step | `extracted_signals.pain_points[]` | Per DIRECTIVE (Phase 1); weekly scan (Phase 2+) | Step 3 |
| Build capability | Task graph query (historical velocity, error rates, agent performance) | `{ avg_build_time, p95_error_rate, available_capacity }` | Computed | N/A (internal) |
| Financial constraints | Financial Script output (SELECT only) | `{ monthly_burn, runway_months, budget_available }` | Computed | N/A (internal) |
| Legal constraints | Static knowledge + §17 obligation matrix | `{ blocked_by[], requires_counsel[] }` | Per DIRECTIVE | N/A (internal) |
| User demand (Phase 2+) | Data Cooperative signals | `{ demand_score, willingness_to_pay, unmet_needs[] }` | Monthly | N/A (Phase 2+) |

### §14 Phase 1 Build List — Addition

Add to Phase 1 build list:
- Discovery Protocol research subtask chain (§19.1 steps 1-5) with structured output schemas
- Research scope and findings schemas in task graph

### §14 Phase 2 Build List — Addition

Add to Phase 2 build list:
- Market Scanner recurring task with board-approved scan configuration
- Community analysis tool evaluation and registration (MCP-compatible, per §6 tool acceptance policy)
- Research feed management (persistent research configurations)
- Delta reporting for research findings

### §15 Cost Model — Addition

Add line item:

| Component | Phase 1 | Phase 2+ | Notes |
|-----------|---------|----------|-------|
| Market Discovery Protocol | $4-18/month | $20-90/month | Phase 1: 2-3 board-initiated research cycles/week. Phase 2: weekly scans across 3-5 topics + community tools. |

### §20 Deferred Items — Addition

Add:
- **Research memory and cross-cycle intelligence (v0.7 — deferred to Phase 3+):** Accumulated market research findings as a persistent queryable corpus. The `research_findings` and `scored_opportunities` schemas already support this — the deferred work is building the retrieval and trend-detection layer that surfaces changes over time.
- **Automated opportunity-to-DIRECTIVE pipeline (v0.7 — deferred to Phase 3+):** When scored opportunities exceed configurable thresholds, automatically initiate §19 strategic evaluation. Requires Phase 2 capability gates to pass first.

---

## Changelog Entry

### v0.7.0 — [DATE] `DRAFT`

**Authors:** Dustin, Claude (drafting assistance)
**Inputs:** GitHub ecosystem analysis (NioPD, reddit-research-mcp, BigIdeasDB, Apify Reddit Pain Finder), gap analysis of §19 Signal Gathering
**Status:** Market discovery architecture. Adds §19.1 with structured research protocol, output schemas, tool governance, and phased activation.

**Added:**
- §19.1 Market Discovery Protocol — five-step research decomposition (scope definition → source discovery → content extraction → signal synthesis → opportunity scoring) with structured JSON output schemas at each step
- Research tool governance guidance — tool categories for market research mapped to §6 risk classes, MCP compatibility notes
- Context budget rules for research tasks — Q4 raw content caps, extraction token limits, summary layer design
- Phase 1 board-initiated discovery (Option A) — research as DIRECTIVE with full HITL
- Phase 2 proactive Market Scanner (Option B) — recurring scan function with delta reporting and persistent feeds
- Phase 3+ research memory and specialization (Option C) — deferred
- Ecosystem references: NioPD market-researcher, reddit-research-mcp, BigIdeasDB, Apify Reddit Pain Finder

**Changed:**
- §19 Signal Gathering table expanded with Discovery Protocol integration, pain point analysis as separate signal, and step references
- §14 Phase 1 and Phase 2 build lists updated with discovery protocol deliverables
- §15 Cost model updated with discovery protocol line item ($4-18/month Phase 1, $20-90/month Phase 2+)
- §20 Deferred items updated with research memory and automated opportunity pipeline
