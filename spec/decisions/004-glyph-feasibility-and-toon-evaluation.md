# ADR-004: Reject Glyph, Adopt TOON for Context Encoding, Confirm SSL Compiler for Phase 1

**Status:** Accepted
**Date:** 2026-03-02
**Decided by:** Eric + Dustin (informed by Liotta, Linus, DBA, Compliance agent reviews + SSL compiler audit)
**Spec reference:** §3 (Cost-Aware Routing), §4 (Context Window Management), §15 (Operating Cost Model), §18 (Autonomous Software Composition), §20 (Deferred Items)

## Context

Dustin proposed Glyph, a purpose-built programming language designed to minimize LLM token consumption across all agent tiers in Optimus. The proposal targets Phase 4 and claims 60-80% reduction in per-invocation token costs ($7,200-15,900/year savings).

Separately, Dustin identified TOON (Token-Oriented Object Notation), an existing open-source data serialization format optimized for LLM input, as a potential immediate win.

Both were evaluated against the existing SSL compiler (`ssl-compiler-autobot`, ~8K LOC TypeScript) which was concurrently audited by four agents (Linus, Liotta, DBA, Compliance). The SSL compiler was found to be architecturally sound with fixable bugs — no material changes to the application needed. The compiler already implements §18 items 2 and 4 (contract layer + SSL compiler), representing 8,000 of the 14,500 LOC budgeted for the full §18 approach.

## Decision

1. **Reject Glyph.** Do not build a custom programming language. The economics do not justify it, the zero-training-data risk is unacceptable, and it violates P4 (boring infrastructure).
2. **Adopt TOON** as the encoding format for agent context loading in the orchestration layer (§4 step 4). Implement in Phase 1, A/B test against JSON using pathway analytical views (§8).
3. **Extend the existing YAML SSL** with `rules`, `guards`, and `pipelines` sections to expand deterministic compilation coverage from ~80% to ~90%.
4. **Confirm the SSL compiler for Phase 1 use.** §3 already assumes deterministic bypass routing exists — the compiler enables it. Fix critical bugs (C1-C6) and deploy.

## Rationale

### 1. Glyph's Economics Are Wrong by ~3 Orders of Magnitude

Glyph claims $7,200-15,900/year in token savings. This requires SSL spec tokens to consume 75-100% of the total Optimus token budget ($800-1,760/month from §15). That is mathematically impossible — agents do far more than read service specs.

The proposal's cost table compares Glyph against raw TypeScript+Prisma+Express+Zod (800-1,200 tokens per service). But **the YAML SSL compiler already eliminates that cost**. Agents already write the compact YAML (~554 tokens for the invoice service), not verbose TypeScript. Glyph claims credit for savings the existing compiler already delivers.

Actual spec-token math:

| Metric | Raw TS (no compiler) | YAML SSL (current) | Glyph (proposed) |
|--------|-----:|-----:|-----:|
| Tokens per invoice service | ~800-1,200 | ~554 | ~321 |
| Monthly spec-token cost (5-10 services, 5-10 refs/mo each) | $0.07-$0.36 | $0.04-$0.15 | $0.02-$0.09 |
| Annual spec-token cost | $0.86-$4.32 | $0.48-$1.80 | $0.27-$1.08 |
| Build cost | $0 | $0 (built) | $2,400-$4,800 |

The Glyph proposal's broader context-loading savings (agent identity ~500 tokens, task descriptions ~500 tokens, prior work ~2,000 tokens) are real costs, but Glyph doesn't control those formats. Those are structured JSON/text stored in the `work_items` table and loaded by the orchestration layer. This is where TOON is relevant (see §5 below).

### 2. The Zero Training Data Problem Is Fatal

LLMs have billions of tokens of YAML training data — Kubernetes manifests, GitHub Actions, Docker Compose, Ansible, Helm, OpenAPI, CloudFormation. Error rates on LLM-generated YAML against a known schema are very low.

Glyph has zero training data. The proposal acknowledges this as HIGH risk and suggests few-shot examples as mitigation. This is insufficient:

- **Novel keyword semantics** — `guard`, `pipeline`, `sanitize`, `escalate` have English meaning but no established programming language semantics. LLMs will map to the closest known semantics, which may be subtly wrong.
- **Implicit scoping rules** — What scope does `deny delete Invoice` apply to? Indentation-based scoping creates ambiguity LLMs resolve using Python priors (different semantics) or YAML priors (different structure).
- **Domain-specific operators** — `->` for transitions, `~` for validation patterns, `..` for ranges. Each has different meaning in different existing languages. LLMs will hallucinate the wrong interpretation.
- **Convention-heavy syntax** — `model Customer [internal]` where `[internal]` is a data classification annotation, not an array or optional marker. This overloads syntax LLMs associate with other meanings.

The 2023-2025 literature on LLMs and novel programming languages consistently shows that LLM performance degrades on languages with novel keyword semantics, implicit scoping, and domain-specific operators. The failure mode isn't syntax errors — it's **plausible but subtly wrong** output that compiles but generates incorrect behavior.

**Perverse token outcome:** Few-shot examples consume 500-1,500 tokens per agent invocation. This offsets the ~230-token savings per spec. Net token impact may be negative.

In a system where correctness is a hard requirement (P2: infrastructure enforces), a specification language that degrades agent accuracy is worse than no new specification language at all.

### 3. P4 Violation

Principle 4: *"Boring infrastructure. Every component should be the most proven, most boring technology that solves the problem."*

A custom programming language requires: custom lexer, custom parser, custom type system, custom semantic analyzer, three code generators, source map support, migration tooling, editor support (LSP), and ongoing language governance.

The existing SSL compiler uses the standard `yaml` npm library (37M weekly downloads) and gets a battle-tested, spec-compliant parser with source position tracking for free. Glyph throws that away.

The proposal acknowledges P4 tension as HIGH risk and argues Phase 4 timing justifies it. But the economic justification that would make a non-boring choice worthwhile does not survive scrutiny (see §1).

### 4. Phase Timing

Glyph is proposed for Phase 4. Optimus hasn't started Phase 1. The project needs $3,600-7,000/month revenue to sustain operations on a $25-35K capitalization. Building a custom programming language before there is revenue, before there is operational data to validate the token cost thesis, is premature optimization.

The proposal's own decision gate requires:
- Pathway analytical views (§8) confirming token cost is the dominant optimization lever remaining
- `v_cost_per_task_type_trend` showing costs plateauing despite other optimizations
- SSL coverage data confirming the 80% deterministic compilation threshold

These gates will not be met. The math above shows spec-token costs are negligible relative to total operating costs. The dominant cost levers are model selection (Opus/Sonnet/Haiku routing), context window management (§4), and retry reduction.

### 5. TOON Addresses the Real Token Cost — Context Loading

The Glyph proposal's cost table identifies real token costs in context loading (agent identity, task descriptions, sibling statuses, prior work). These total ~3,500 tokens per invocation. But these are **task graph data loaded as JSON**, not service specs. Glyph doesn't control this format. TOON does.

TOON (Token-Oriented Object Notation) is an existing open-source format with:
- ~40% fewer tokens than JSON (benchmarked, not claimed)
- 73.9% accuracy vs JSON's 69.7% on data retrieval tasks (benchmarked across Claude, GPT, Gemini, Grok)
- 88.0% structure awareness vs JSON's 83.0%
- Lossless round-trip JSON conversion (deterministic)
- TypeScript, Python, Go, Rust, .NET implementations already available
- P4 compliant — existing open format, existing libraries

Integration point is narrow: the orchestration layer (§4 step 4) already assembles context as structured JSON before loading into prompts. Add a `toon.encode()` step between JSON assembly and prompt construction. ~50 LOC change.

**TOON math for Optimus:**

| Context Block | JSON (current) | TOON | Savings |
|---|--:|--:|--:|
| Agent identity + guardrails | ~500 tokens | ~300 tokens | 40% |
| Task details + acceptance criteria | ~500 tokens | ~300 tokens | 40% |
| Parent task summary | ~300 tokens | ~180 tokens | 40% |
| Sibling statuses (tabular) | ~200 tokens | ~100 tokens | 50% |
| Prior work (semantic search) | ~2,000 tokens | ~1,200 tokens | 40% |
| **Total per invocation** | **~3,500 tokens** | **~2,080 tokens** | **~41%** |

At 150 tasks/day: ~6.4M tokens/month saved. At blended pricing (~$5/MTok): ~$32/month, ~$384/year in direct token savings.

The larger impact is accuracy. TOON's benchmarked accuracy improvement means fewer context misunderstandings, fewer failed tasks, fewer retries. §15 budgets $110-230/month for retries. A 10-15% retry reduction from better context comprehension saves $11-35/month on top of token savings. Conservative annual estimate: **$500-800/year** from TOON adoption.

This is not $7,200-15,900. But it's real, benchmarked, available immediately, and costs nothing to build.

### 6. The SSL Compiler Is Already Built and §3 Assumes It Exists

The spec's cost-aware routing (§3) explicitly assumes deterministic bypass via the SSL compiler during Phase 1:

> *"Deterministic bypass — if the task matches a known deterministic template (e.g., Service Specification Language compile from §18), execute without any LLM invocation. Cost: $0."*

> *"At Phase 1 volumes (100-300 executor tasks/day), if 30-40% of executor tasks can be handled deterministically... the executor cost line drops from $40-80/month to $15-35/month."*

The SSL compiler (`ssl-compiler-autobot`) already implements two of the six §18 components:

| §18 Component | Budgeted | Status |
|---|---|---|
| 1. Allowlist registry + vendor cache | 1,500 LOC | Not built |
| 2. Contract layer (interfaces + adapters) | 3,000 LOC | **Built** — `src/contracts/` (10 files) + `src/adapters/` (9 files) |
| 3. CVE awareness pipeline | 2,000 LOC | Not built |
| 4. SSL compiler | 5,000 LOC | **Built** — ~8K LOC |
| 5. AGPL firewall + license scanner | 1,000 LOC | Not built |
| 6. Behavioral verification suite | 2,000 LOC | Partial — determinism tests exist |

That's 8,000 of 14,500 LOC (55%) already done. The contract/adapter layer that the spec describes as §18 Layer 0 and Layer 1 is inside the compiler.

Without the SSL compiler in Phase 1, the §18 math breaks: P(success) = p^d. At 95% per-decision accuracy with 200 decisions (writing a service by hand): 0.004% success rate. With the SSL compiler reducing decisions to ~20: 81.8% first-attempt success rate. This is how you hit the Phase 1 success metric of >90% task success rate and <$3.00 total cost per directive.

Items 1, 3, and 5 (allowlist, CVE pipeline, AGPL scanner) protect the supply chain but are not prerequisites for the compiler itself. Dependencies can be curated manually in Phase 1; automated supply chain management can follow in Phase 2.

### 7. Extend the YAML SSL Instead

The functional coverage Glyph promises (rules, guards, pipelines) can be achieved by extending the existing YAML format:

**Rules section:**
```yaml
rules:
  - when: Invoice.amount_cents > 1000000
    require: board_approval
  - when: Customer.tier = free
    limit: 5 invoices/month
  - deny: delete(Invoice)
```

**Guards section:**
```yaml
guards:
  budget_per_task: 5.00
  classification: confidential
  escalation_threshold: 10.00
  escalation_target: strategist
```

**Pipelines section:**
```yaml
pipelines:
  - trigger: on_transition(Invoice.status, sent -> paid)
    steps: [validate, credit_balance, generate_receipt, notify_customer]
    on_failure: retry(3, escalate)
```

All valid YAML. LLMs have deep priors for these structures. The existing event parser already handles `on_transition` triggers.

**Build cost:** ~1,200 LOC (parser extensions + 3 new generator modules + tests). ~40-60 agent hours. ~$200-300.

| | Glyph | Extend YAML SSL | TOON (context) |
|---|---|---|---|
| What it does | Replace spec format + context format | Expand spec coverage | Compress context loading |
| Build cost | $2,400-$4,800 | ~$200-300 | ~$0 (npm install) |
| New LOC | ~5,000-8,000 | ~1,200 | ~50 |
| LLM error rate | High (zero training data) | Low (YAML) | Benchmarked improvement |
| Time to usable | Months (6 phases) | 1-2 weeks | Days |
| P4 compliance | Violates | Compliant | Compliant |
| Coverage gain | 80% -> ~90% | 80% -> ~90% | N/A (different problem) |
| Token savings | Claimed 60-80% | Negligible (YAML already compact) | ~41% on context loads |
| Accuracy impact | Unknown (risk of degradation) | Neutral | +4.2pp (benchmarked) |
| Migration required | All existing specs | None | None |
| Risk | HIGH | LOW | LOW |

## SSL Compiler Audit Summary

The existing `ssl-compiler-autobot` was audited concurrently. Architecture is sound — 5-stage pipeline, contract/adapter separation, determinism testing, exhaustive discriminated union handling, zero `any` usage. The following bugs need fixing but require no architectural changes:

### Critical

| # | Issue |
|---|-------|
| C1 | SQL injection via raw CHECK constraint passthrough in migration generator |
| C2 | Double DEFAULT clause for UUID/timestamptz fields (`mapType` bakes DEFAULT into type string) |
| C3 | Cursor pagination off-by-one (reads `rows[safeLimit]` instead of `rows[safeLimit - 1]`) |
| C4 | Rate limiter SQL returns stale token count (reads from `refilled` CTE, not `consumed`) |
| C5 | FK constraints generated with no ON DELETE/ON UPDATE actions |
| C6 | FK columns not auto-indexed unless spec explicitly includes `indexed` modifier |

### High

| # | Issue |
|---|-------|
| H1 | `toSnakeCase` has 4 different implementations — migration and query generators can produce different table names |
| H2 | 30+ duplicated utility functions across generators (toSnakeCase x6, toKebabCase x7, compareEndpoints x5) |
| H3 | State machine hardcodes `"id"` as primary key column |
| H4 | Planner computes a generation plan that no generator consumes |
| H5 | All generated queries use `SELECT *` / `RETURNING *` |
| H6 | BFS cycle detector is O(V * 2^V) worst case; DFS version in validator is O(V+E) |
| H7 | 16 stale compiled .js files committed in src/ directory |
| H8 | Nested savepoints all reuse the name `ssl_nested_tx` |

### Medium

| # | Issue |
|---|-------|
| M1 | Multi-statement migrations not wrapped in BEGIN/COMMIT |
| M2 | No rollback migrations generated |
| M3 | No `updated_at` trigger (application-only enforcement) |
| M4 | No filtered indexes for soft-deleted tables |
| M5 | Validator restricts `auto` to uuid/timestamptz but migration generator handles int/bigint |
| M6 | Auth adapter reads headers outside the RequestContext contract |
| M7 | AuditLog and HealthChecker contracts defined but never implemented |
| M8 | `@types/express` in dependencies instead of devDependencies |

None of these require a new language. They require bug fixes and ~400 LOC of shared utility extraction.

## Glyph Ideas Worth Preserving

The Glyph proposal contains good ideas that should be incorporated into the YAML SSL extension:

1. **Data classification as a first-class field** — Add a `classification` key to YAML model definitions. Compile to RLS policies, encryption config, GDPR deletion cascades, and audit logging.
2. **Deny-by-default for transitions** — Add `default: deny` to YAML transition blocks. Already philosophically present in P1.
3. **Guard co-location** — Make the `guards` section required in the YAML schema. Service cannot compile without security configuration.
4. **Three compilation targets** — Extend the compiler to emit task graph records and guardrail JSON in addition to TypeScript+SQL. This is a generator addition, not a language change.

These ideas are language-agnostic. They work as well in YAML as they would in Glyph, without the training data risk, the P4 violation, or the build cost.

## Implementation Plan

### Pre-Phase 1 (Immediate — Before Agents Go Live)

1. **Fix SSL compiler critical bugs** (C1-C6) — ~2-3 days of agent work
   - C1: Sanitize CHECK constraint expressions (whitelist safe SQL patterns)
   - C2: Separate DEFAULT from type mapping in `mapType()`
   - C3: Fix cursor pivot to `rows[safeLimit - 1]`
   - C5: Add ON DELETE/ON UPDATE to FK generation, default to RESTRICT
   - C6: Auto-index all FK columns
   - H1/H2: Extract shared utilities into `src/utils/` (eliminates 30+ duplicates, fixes `toSnakeCase` divergence)
2. **Validate compiler output** against a real PostgreSQL instance — generated migrations must execute without errors. Add as a CI step.

### Phase 1 Week 1

3. **Integrate SSL compiler into deterministic bypass routing** (§3) — when orchestrator classifies a task as `routing_class: DETERMINISTIC` and it matches an SSL-compilable pattern, invoke the compiler directly. Cost: $0 per service generated.
4. **Implement TOON context encoding** in the orchestration layer (§4 step 4):
   - `npm install @toon-format/toon`
   - Add `toon.encode()` between JSON context assembly and prompt construction (~50 LOC)
   - Populate `context_profile_json` with both JSON and TOON token counts for A/B comparison

### Phase 1 Week 2-3

5. **A/B test TOON vs JSON** using pathway analytical views (§8):
   - `v_context_block_correlation`: compare task outcomes for TOON-encoded vs JSON-encoded context
   - `v_cost_per_task_type_trend`: measure actual token cost reduction
   - Decision gate: if TOON accuracy >= JSON accuracy AND token savings >= 30%, adopt TOON as default encoding. If accuracy degrades, revert to JSON.
6. **Add `rules`, `guards`, `pipelines` sections** to YAML SSL schema — ~1,200 LOC:
   - Parser extensions (~200 LOC)
   - 3 new generator modules: rules → middleware/DB constraints, guards → §5-compatible JSON, pipelines → event handler chains (~600 LOC)
   - Tests (~400 LOC)
7. **Add `classification` key** to YAML model definitions — compiles to RLS policies, audit triggers, and data classification tags on generated `work_items`

### Phase 1 Week 4+

8. **Add second and third compilation targets** — extend the compiler to emit:
   - Task graph records (`work_items` row format with acceptance criteria, routing class, context profile)
   - Guardrail configs (§5-compatible JSON)
   - This enables the full loop: agent writes YAML spec → compiler generates service code + task graph entries + guardrail enforcement
9. **Make `guards` section required** in the YAML schema — service cannot compile without security configuration (Glyph's guard co-location idea, implemented in YAML)

### Phase 2+ (Data-Gated)

10. If `v_cost_per_task_type_trend` shows token costs plateauing despite routing + TOON + context optimizations, revisit compression strategies. Based on the analysis in this document, the answer will be expanded TOON adoption or better YAML schemas — not a custom language.

## Consequences

**Positive:**
- SSL compiler enables §3 deterministic bypass from Phase 1 day one — executor costs drop from $40-80/month to $15-35/month
- TOON addresses the actual token cost problem (context loading, not spec encoding) with benchmarked ~40% reduction and +4.2pp accuracy improvement
- P4 compliance preserved — YAML (spec format) and TOON (context encoding) are both existing, proven, boring formats
- No LLM training data risk — agents continue using formats they know deeply
- SSL compiler coverage expands from ~80% to ~90% at 1/10th the cost of Glyph
- Revenue-generating product work is not blocked by language development
- 55% of §18's budgeted LOC (8,000 of 14,500) already built

**Negative:**
- ~233-token gap per service spec vs Glyph's hypothetical compression (immaterial at projected volumes)
- The "5x more context per invocation" benefit from extreme compression is not realized (TOON's ~41% + YAML's existing compactness is the realistic ceiling with proven formats)
- TOON adds a serialization step to the context loading path — minor latency impact (benchmark against §1 success metric: task dispatch latency < 2s p99)

**Risks:**
- TOON is a young format — benchmarks may not hold across all Optimus context structures. **Mitigated:** A/B test with pathway views before full adoption; revert path is trivial (remove `toon.encode()` call).
- YAML SSL extensions may not cover all rule/guard/pipeline patterns Glyph envisioned. **Mitigated:** Escape hatch to direct TypeScript for complex cases (already the §18 approach for the 20% case).
- SSL compiler has known bugs that could generate incorrect code if not fixed before deployment. **Mitigated:** Fix C1-C6 before Phase 1 go-live; add PostgreSQL migration execution as CI gate.

## Spec Updates Required

This decision requires the following updates to SPEC.md:

1. **§3 (Cost-Aware Routing):** Add TOON as the encoding format for context loading in the deterministic bypass and lightweight routing tiers. Reference this ADR.
2. **§4 (Context Window Management):** Add a step between context assembly and prompt construction: "Encode assembled context as TOON (ADR-004) for token efficiency and accuracy improvement."
3. **§15 (Operating Cost Model):** Add TOON token savings to the executor and orchestrator cost lines. Note subscription vs API token cost arbitrage as a Phase 1 measurement item.
4. **§18 (Autonomous Software Composition):** Note that items 2 (contract layer) and 4 (SSL compiler) are implemented by `ssl-compiler-autobot`. Update LOC estimates to reflect actual build.
5. **§20 (Deferred Items):** Archive the Glyph proposal reference. Add "YAML SSL extension with rules/guards/pipelines" as a Phase 1 week 2-3 deliverable.

## Subscription vs API Token Cost Arbitrage

Dustin noted potential for gaming monthly subscription vs API token cost differences across models. This is worth modeling but is orthogonal to the Glyph/TOON decision. Recommended: map projected invocation patterns against both pricing models once Phase 1 operational data is available. Add to §15 as a cost optimization item.
