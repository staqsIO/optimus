# DEN and DOM Proposals -- Evaluated and Deferred

**Date:** 2026-03-01
**Author:** Dustin (proposals), Eric (evaluation and decision)
**Status:** EVALUATED -- deferred, not accepted into spec
**Origin:** iMessage group chat "Pinkies" (RCS) + two attached .md proposal documents

---

## Context

On Sun Mar 1 2026 at 8:57 AM, Dustin shared two proposals in the "Pinkies" group chat (participants: Eric, Dustin Powers, Mike Maibach). The proposals were generated through the collaboration workflow Dustin described: "Idea > talk to Claude about it > ask for .md report > upload here > everyone else then can take that file back to their own LLM > discuss with chat > refine > repeat."

The group chat also covered broader topics: current system status, per-task cost benchmarks, stigmergy optimization, monorepo consolidation, and a personal side project (referenced but details not captured).

Both proposals were submitted to Liotta (economics/architecture evaluation) and Linus (code quality/engineering evaluation) for independent review before any planning. Both evaluators independently recommended REJECT for spec integration.

---

## Broader Discussion Context (iMessage)

### System Status (Eric)

- State machine with DAG (not a queue) and polling system in place
- Gates checking how automatic-ready any given message is
- Everything requires approval to send until autonomy is graduated
- Email only today; ready to accept other messaging and task channels
- Multiple accounts can be hooked up

### Per-Task Cost Benchmarks

- Current: ~$0.01 per task (down from $0.018)
- Expected to come down further with optimizations and fine-tuning
- Using different models for different tiers (already on right path)

### Stigmergy Optimization

Dustin: "We learned some cool stuff from slime mold, and ants" -- referenced Wikipedia article on stigmergy. The concept was applied to the Postgres task graph to reduce token usage. Eric: "Yes, it dropped all of the metaphor and stripped it down to hey this actually will optimize how we're hitting the DB."

### "Most Governance Per Dollar" Positioning (Dustin)

"The pitch isn't 'most advanced technology' -- it's 'most governance per dollar.' Every alternative either sacrifices auditability for throughput, sacrifices security for convenience, or adds complexity that doesn't earn its keep at our scale. And our spec already has pretty dope forward looking ideas for phase 3 and 4+."

### Collaboration Workflow (Dustin)

"Idea > talk to Claude about it > ask for .md report > upload here > everyone else then can take that file back to their own LLM > discuss with chat > refine > repeat. You, or any individual, are valuable because your unique insights and questions to your chat potentially unlock a new way of thinking about the problem that may not have been exposed previously."

### Other Topics

- **[Personal topic redacted for the public archive.]**
- **Free AWS tier:** Eric: "I have a dream where we create a network of always-free tier aws nodes and use them as a compute network when not being used for the core functions." Dustin: "Ohhh all the non LLM compute could be outsourced to free AWS instances." Eric referenced a Google Sheets page breaking down all AWS always-free-tier services.
- **Monorepo consolidation:** Eric reorganized git -- spec and inbox repos merged into the Optimus monorepo via subtree merge.

---

## Proposal 1: Decentralized Executor Network (DEN)

**Source files:** `/Downloads/2393118981672564948.md` (16 KB, DEN-only) and `/Downloads/5715510001648894451.md` (22 KB, DEN + DOM combined)

### Concept

Hub-and-spoke platform where Optimus (central hub) retains ALL governance: strategy, orchestration, review, guardrails, task graph state machine, budget tracking, and public transparency layer. Tiers 1-4 (Strategist, Architect, Orchestrator, Reviewer) remain centralized. AutoBot executor nodes (decentralized spokes) run on external GPU hardware contributed by network participants. Each node runs a lightweight executor runtime (local LLM inference via Ollama or equivalent) that pulls tasks, executes them, and submits outputs for central review.

The crypto mining analogy is intentional: existing GPU infrastructure (NVIDIA 3090s, 4090s, A100s) purchased for proof-of-work mining is increasingly underutilized as mining profitability fluctuates. This network redirects that hardware toward "useful AI labor."

### Economic Flywheel

Optimus currently bears 100% of executor compute costs ($40-80/month at Phase 1; scaling linearly with task volume). DEN creates a flywheel: more successful products -> more revenue -> higher compensation rates -> more contributors -> more capacity -> more products.

### Architecture

Central hub (Strategist, Architect, Orchestrator, Reviewer -> Task Graph Postgres -> Task Broker API Gateway) connected to external AutoBot Nodes (each with Ollama + Local LLM, doing Pull -> Run -> Submit).

**Task Broker (new component):** Three operations:
1. **Pull** -- node requests next available task (authenticated, rate-limited)
2. **Submit** -- node submits output for a claimed task
3. **Heartbeat** -- node confirms liveness (tasks re-queued on heartbeat timeout)

Thin API layer over existing `claim_next_task()` function. Adds authentication, network transport, and contributor identity. Task assignment logic, state machine transitions, and guardrail enforcement remain in Postgres.

### Compensation Model

Fixed-rate per validated task (not profit share -- profit share triggers Howey test and likely creates a security):

| Task Complexity | Payment per Validated Task |
|----------------|---------------------------|
| DETERMINISTIC (template-match) | $0.001 |
| LIGHTWEIGHT (simple reasoning) | $0.005 |
| FULL (complex reasoning) | $0.02-0.05 |

Rates set by the board. Payments processed through existing distribution partner with KYC, OFAC screening, and tax reporting (1099-NEC). Monthly payment cycle.

### Output Validation

Every submission from a decentralized node treated as Q4 data (untrusted, external, requiring full sanitization). Central Reviewer validates every output. Failed outputs re-queued to different node (max 3 retries).

### Phase 1 Recommendations (from proposal)

1. **Executor API boundary:** Define executor contract as API from Phase 1, even if initial implementation wraps direct Postgres calls. "This is the difference between 'decentralization is a deployment choice' and 'decentralization requires a rewrite.'"
2. **Contributor identity schema:** `contributor_id` field (nullable, unused in Phase 1) on `work_items` and `state_transitions`.
3. **Per-contributor quality metrics:** `llm_invocations` table supports attribution to external contributor.

### Not Covered by Proposal

Specific GPU hardware requirements, node onboarding/verification, network protocol selection, token economics (explicitly NOT recommended due to securities risk), geographic distribution (data residency, GDPR), competitive landscape deep-dive.

---

## Proposal 2: Deterministic Operations Mesh (DOM)

### Concept

Pool of minimal compute nodes (AWS free tier t2/t3.micro, AWS Lambda always-free tier, Oracle Cloud free tier, GCP Cloud Functions) that handle all non-LLM workloads. Central Postgres on Supabase handles task graph, state machine, and governance. LLM calls go to API providers. Everything else -- monitoring, CI, audit checks, sanitization, health checks, event digests -- runs on the mesh.

### Eligible Workloads (all NO LLM, fit within 1 vCPU / 1 GB RAM)

| Workload | Spec Reference | Compute Profile |
|----------|---------------|-----------------|
| Deterministic bypass tasks (template match, schema validation, format conversion) | S3 cost-aware routing | CPU, milliseconds, < 100 MB |
| SSL compilation (Service Specification Language -> code) | S18 | CPU, seconds, < 500 MB |
| Tier 1 audit checks (hash verification, financial rules, budget enforcement) | S8 | CPU + SQL, milliseconds |
| CVE awareness pipeline (API polling, lockfile matching, reachability analysis) | S18 | CPU + network, seconds |
| Cross-schema reconciliation job | S12 | SQL, runs every 5 min |
| Content sanitization rule execution | S5 | CPU, milliseconds |
| Event digest generation and delivery | S8 | CPU + network, seconds |
| Health monitoring and heartbeat checking | S9, S11 | CPU + network, continuous |
| CI/CD runners (test suites, linting, static analysis) | S6, S14.1 | CPU, seconds to minutes |
| Merkle root computation and hash chain verification | S8, S12 | CPU, seconds |
| Tool pre-screening (sandboxed execution with synthetic inputs) | S6 | CPU, seconds |

### Cost Projections

Hosting and infrastructure line item in S15 is $150-300/month. Supabase Pro ($25/month base + PITR add-on) is the task graph database and cannot move to free tier. Supporting services (monitoring, CI, audit, digests, sanitization) represent estimated $50-100/month that the DOM could absorb. As task volume scales in Phase 2+, deterministic workload scales with it -- on paid infra cost grows linearly, on DOM marginal cost stays near zero until free tier limits hit.

### Free Tier Options

| Option | Specs | Cost | Duration | Best For |
|--------|-------|------|----------|----------|
| AWS free tier EC2 (t2/t3.micro) | 1 vCPU, 1 GB RAM | $0/month | 12 months per account | Long-running services |
| AWS Lambda (always-free) | 1M requests/month, 400K GB-seconds | $0/month | Permanent | Event-driven tasks |
| AWS SQS + SNS (always-free) | 1M requests/month | $0/month | Permanent | Task distribution, event routing |
| Oracle Cloud free tier | 4 ARM cores, 24 GB RAM | $0/month | Permanent | Heavier workloads (CI, SSL compilation) |
| GCP Cloud Functions (always-free) | 2M invocations/month | $0/month | Permanent | Event-driven tasks |

### Relationship to DEN

- DOM (Phase 2-3): Moves deterministic workloads off paid infrastructure -> reduces $150-300/month hosting line
- DEN (Phase 4+): Moves LLM executor workloads to decentralized GPU contributors -> reduces $40-80/month executor line + enables scale
- Together: only paid infrastructure = Postgres (task graph) + governance-tier LLM calls (Strategist, Orchestrator, Reviewer)

---

## Liotta Evaluation

### DEN Economics

- Current executor costs: Haiku 4.5 API at 100-300 tasks/day = $24-54/month
- DEN savings claim: cut that in half = save ~$27/month
- DEN operational costs NOT accounted for:
  - Task Broker API development and maintenance
  - Contributor onboarding, identity, and authentication infrastructure
  - Quality validation pipeline for contributor outputs
  - Legal review of fixed-rate compensation model: $5-15K
  - Network monitoring and dispute resolution tooling
  - Contributor payout infrastructure (payment processing, tax reporting for 1099-NEC)
- **Break-even calculation:** $5K legal review alone / $27/month savings = 185 months (over 15 years)
- "Saving $27/month does not justify building a distributed compute network. The numbers are off by two orders of magnitude from being interesting."
- DEN math works when executor costs reach $5,000+/month (10,000+ tasks/day sustained). Currently at zero tasks/day in production.

### DEN Architecture Concerns

- Introduces untrusted compute into a system whose entire security model (P1, P2) is built around trusted, auditable execution
- Constitutional gates (G3 voice tone match, G2 commitment detection, G7 policy commitment detection) assume LLM output from known, consistent model
- Contributor-run Ollama instances with unknown quantization, unknown fine-tuning, unknown inference parameters break this assumption
- "Central review" step means paying for LLM inference twice -- eliminates cost savings

### DOM Economics

- Claim: $50-100/month savings from infrastructure costs
- Target workloads already essentially free on Supabase:
  - Template matching: string comparison, milliseconds
  - Schema validation: JSON schema validation, nanoseconds
  - Audit checks: "$0/month, milliseconds"
  - Hash chain verification: SHA-256, microseconds
  - CI/CD: already on GitHub Actions (2,000 minutes/month free)
  - Sanitization, event digests, health monitoring: negligible
- "$150-300/month Supabase cost is for the database instance itself (compute, storage, PITR backups), not for running these lightweight operations. Moving template matching to Oracle Cloud does not reduce the Supabase bill by a single dollar."
- **"DOM does not save $50-100/month. It saves approximately $0/month"** while adding 3-5 new deployment targets, monitoring endpoints, and failure modes.

### DOM P4 Violation

"A mesh of free-tier compute nodes across AWS Lambda, Oracle Cloud, and possibly others is the opposite of boring infrastructure. It is a multi-cloud orchestration problem for $0 in savings."

### Spec Bloat Warning

Spec is 1,861 lines. Phase 1 not shipped. No revenue. No product. 21 sections, 14 deferred items, 4-phase roadmap. "The team is writing governance frameworks for a system that does not yet govern anything."

### Liotta Verdict

"Both proposals should be rejected from the spec. Neither earns its place. One is premature by at least 18 months (DEN). The other solves a problem that does not exist at current scale (DOM)."

Recommended trigger: evaluate cost optimization when executor costs exceed $2,000/month. Priority order: (1) local Ollama inference via DMS/KV cache compression, (2) prompt caching and batch API for Anthropic, (3) fine-tuned smaller models on accumulated task history. Decentralized compute and multi-cloud orchestration evaluated only if options 1-3 are insufficient.

---

## Linus Evaluation

### Overall Assessment

"REJECT both proposals for spec integration. Neither belongs in SPEC.md at this stage." Called both proposals "architecture astronautics -- the disease I have seen kill more projects than bad code ever has."

### DEN -- Executor API Boundary

- "No. It is a textbook premature abstraction."
- Actual code: `claim_next_task()` and `transition_state()` in `sql/005-functions.sql` are clean atomic Postgres functions. RLS policies in `sql/006-rls.sql` enforce executors can only see own work. "This is correct, minimal, and works."
- What the abstraction means for Phase 1: build HTTP/gRPC service wrapping two Postgres function calls -> internal executors don't use it -> nobody external uses it -> now have TWO code paths -> must maintain/test/secure both -> requirements will be different when actually needed
- Cited spec line 1422: "Phase 1 threat model does not include untrusted contributors -- all service accounts are board-controlled."
- "Building an API boundary to protect against a threat model that does not apply, for a feature that does not exist, for users that you do not have. That is the definition of YAGNI."
- Key insight: "The hard part -- the atomic state machine, the RLS isolation, the hash chain verification -- is already done correctly at the database layer. The API boundary is the EASY part. You do not need to 'prepare' for it."

### DEN -- Nullable contributor_id Columns

- "They are schema pollution."
- Every query plan considers a column that is NULL for 100% of rows
- RLS policies need to account for it (or leave a gap)
- `transition_state()` function either ignores it (dead code path) or handles it (complexity for non-existent feature)
- `state_transitions` is append-only and partitioned -- schema change permanent
- Flagged existing codebase disease: `sql/019-phase3-activation.sql` and `sql/022-phase4-autonomy.sql` create tables for phases that are at minimum a year away. "You already have this disease. Adding more nullable columns makes it worse."

### DOM -- Architecture

- Separating deterministic from LLM workloads is "sound in principle"
- Spec already describes this -- cost-aware routing hierarchy on SPEC.md line 280 defines "deterministic bypass." `routing_class` field on `work_items` already supports `DETERMINISTIC`. "This is not a new idea."
- Free tier feasibility: computational requirements fit. "The problem is not whether it fits. The problem is operational complexity."
- Two-person board with no shipped product. Every deployment target is operational burden. AWS Lambda: IAM, API Gateway, CloudWatch, deployment pipeline, cold starts. Oracle Cloud: different cloud provider, different tooling, different failure modes. Supabase: where actual data lives.
- "You now have THREE cloud providers for a system that serves ONE user's inbox."
- "P4 says 'boring infrastructure.' Multi-cloud deployment for an inbox management system is not boring."

### DOM Caveat

"Design deterministic services as stateless, independently deployable units" is just good engineering advice. "You do not need a 'Deterministic Operations Mesh' concept in the spec to justify writing pure functions. Just write pure functions." The code already implements this: `tier1-deterministic.js`, `sanitizer.js`, `guard-check.js`, `infrastructure.js` are all already stateless pure functions.

### Spec Weight

"Worse. Unambiguously worse. Every line is cognitive load. The deferred items list is growing faster than the implemented features list. That is a warning sign. It means the specification is outrunning the implementation. Eventually the spec becomes fiction -- a description of a system that does not exist and may never exist as described."

### Linus Verdict

"Both proposals should be REJECTED for spec integration. They should not even be deferred items. Deferred items in a specification still carry weight -- they shape how people think about the current architecture. They create the temptation to 'prepare' for features that may never ship."

Belong in `conversation/` as exploration documents -- historical records of ideas considered.

What should happen instead:
1. Ship Phase 1. Spec defines 8-week Phase 1 timeline.
2. Stop pre-building future phase schemas. Migrations 019-022 (Phase 3-4 schemas) should not exist yet. "Dead code masquerading as infrastructure."
3. Write pure functions because it is good engineering, not because of a "Deterministic Operations Mesh."
4. If executor API boundary ever needed, build it in two days.

"The most dangerous thing a small team can do is confuse planning with progress. These proposals are planning for problems that are 12-18 months away, at the expense of solving the problems that are here right now. Kill them both. Ship the product."

---

## Board Decision Items (All DEFERRED or REJECTED)

| # | Item | Decision |
|---|------|----------|
| 1 | Accept DEN as S20 deferred item | **DEFERRED** -- capture as conversation entry, not in spec. Revisit when executor costs exceed $2,000/month. |
| 2 | Accept DOM as S20 deferred item | **DEFERRED** -- capture as conversation entry, not in spec. Revisit when infrastructure costs exceed $1,000/month OR task volume exceeds 10,000/day. |
| 3 | Phase 1 schema prep (contributor_id, API boundary, quality metrics) | **REJECTED** -- YAGNI per Linus review. Nullable columns are schema pollution. API boundary is the easy part and trivial to add later. |
| 4 | Phase 1 design principle (stateless deterministic services) | **ALREADY DONE** -- code already implements this (`tier1-deterministic.js`, `sanitizer.js`, `guard-check.js`, `infrastructure.js`). No spec change needed. |
| 5 | Eric to review API boundary feasibility | **N/A** -- proposal not accepted, review not needed. |

---

## Summary of Economics

| Proposal | Claimed Savings | Actual Savings | Rationale |
|----------|----------------|----------------|-----------|
| DEN | ~$27/month (halve executor costs) | Net negative | Legal review alone ($5-15K) = 15+ year break-even. Plus double LLM inference cost for central review of untrusted outputs. |
| DOM | $50-100/month from infrastructure | ~$0/month | Target workloads already negligible cost on Supabase. Moving template matching to Oracle Cloud does not reduce the Supabase bill. Adds 3-5 new deployment targets for $0 savings. |

---

## What Happens Next

1. Both proposals captured here as immutable historical record per autobot-spec workflow.
2. Neither proposal enters SPEC.md or the deferred items list (S20).
3. Trigger conditions documented in `open-questions/README.md` under "Evaluated and Deferred."
4. Revisit DEN when executor costs exceed $2,000/month sustained. Evaluate in priority order: (1) local Ollama inference, (2) prompt caching and batch API, (3) fine-tuned smaller models, (4) decentralized compute only if 1-3 insufficient.
5. Revisit DOM when infrastructure costs exceed $1,000/month OR task volume exceeds 10,000/day.
6. Ship Phase 1.
