---
title: "Autonomous Software Composition"
section: 18
tier: planning
description: "Autonomous code generation, PR pipelines, and software composition architecture"
---
## 18. Autonomous Software Composition

> *Added in v0.5. Defines how AutoBot builds software — supply chain architecture, dependency management, CVE awareness, and composition strategy. Four agent reviews converge on a contract-layer approach. See conversation/008, Part 7.*

### The Problem

An autonomous system that pulls from the npm ecosystem has an unbounded attack surface. OpenClaw's incidents (824+ malicious skills across 10,700+) demonstrate this in an adjacent system. But npm's 2.1M+ packages represent decades of battle-tested code. Rebuilding them internally would violate P4 (boring infrastructure). The middle ground is a four-layer trust boundary.

### Architecture: Contracts + Air-Gapped Vendoring

```
Layer 0: Contracts     (AutoBot owns — TypeScript interfaces + JSON Schema)
Layer 1: Adapters      (AutoBot owns — thin wrappers binding contracts to npm)
Layer 2: Allowlist     (npm packages, pinned, audited, content-hashed)
Layer 3: Vendor Cache  (air-gapped S3/R2, npm registry never contacted at runtime)
```

**Layer 0** is the opinionated vocabulary agents compose from — ~5,000 lines of pure type definitions for HTTP handlers, database access, auth middleware, queue consumers, validation, logging. This is AutoBot's "way of doing things."

**Layer 1** binds contracts to npm implementations — ~5,000-10,000 lines of adapter code. Express implements the HTTP handler contract. Zod implements the validation contract. When a better library emerges, swap the adapter. Agents never see the change.

**Layer 2** is the allowlist — ~150-200 curated npm packages, pinned to specific versions, audited, content-hashed. If a package isn't on the allowlist, agents can't use it. (P1: deny by default.)

**Layer 3** is the air gap. All packages pre-downloaded into a vendor cache. `npm install` resolves exclusively from the vendor cache. The npm registry is never contacted at build time. Eliminates install-time supply chain attacks: typosquatting, dependency confusion, malicious postinstall scripts.

### CVE Awareness Pipeline

CVE databases are structured data, not natural language. No human security advisories required:

| Source | Format | Cadence |
|--------|--------|---------|
| OSV.dev | JSON API | Near real-time |
| GitHub Advisory DB | GraphQL API | Near real-time |
| NVD (NIST) | JSON API | Daily |
| `npm audit` | Structured CLI | Per-invocation |

Pipeline (~2,000 LOC):

1. **Poll** structured CVE APIs every 15 minutes
2. **Match** against lockfiles of all deployed services
3. **Reachability analysis** — does the code path through the adapter layer actually call the vulnerable function? (Filters 85-90% of non-applicable CVEs)
4. **Exposure classification** — is the affected code path network-exposed (adapters, external API clients, DB drivers) or internal-only? Reachability + exposure is the primary decision axis, not raw CVSS.
5. **Auto-patch policy** (see decisions/003-cve-auto-patch-policy.md for full rationale):
   - DB drivers (`pg`, `pglite`, `@supabase/*`) and agent SDK (`@anthropic-ai/sdk`): never auto-patch, manual review always. Enforced by CHECK constraint.
   - CRITICAL (9.0+), reachable + network-exposed, active exploitation: auto-mitigate (circuit-break affected adapter), emergency board notification, 4h SLA for human patch review.
   - CRITICAL (9.0+), no active exploitation: board review, 24h SLA.
   - HIGH (7.0-8.9), reachable: staged canary, 24h board objection window, auto-promote if no objection.
   - MEDIUM (4.0-6.9): batched weekly, 72h board review window.
   - LOW (< 4.0): auto-patch if test suite + constitutional gate regression tests pass. Board notified in weekly summary.
   - Non-reachable (any CVSS): batch monthly.
6. **Three-condition gate** — all auto-patches must pass: (a) reachability confirmed, (b) full test suite, (c) constitutional gate regression tests (G1-G7 hold after change).

**30-day lag-behind policy:** Don't adopt new npm package versions immediately. Most supply chain attacks target new releases. A 30-day lag lets the community discover malicious versions before the vendor cache ingests them. Security patches bypass the lag with zero delay.

**Lockfile integrity verification:** Hash every `package-lock.json` and store the hash. If the lockfile changes without a corresponding task in the task graph, block deployment. Catches silent dependency mutation.

### Service Specification Language

Agent build success modeled mathematically: `P(success) = p^d` where p = per-decision correctness and d = decisions per build. At 95% accuracy with 200 decisions: 0.004% success. At 99% accuracy with 40 decisions: 66.9% success.

The leverage is smaller decision space, not richer library. The Service Specification Language constrains what agents can express:

```yaml
name: invoice-service
version: 1.0.0
data_models:
  Invoice:
    fields:
      - id: uuid, primary
      - customer_id: uuid, indexed, references(Customer.id)
      - amount_cents: int, >= 0
      - status: enum(draft, sent, paid, void)
endpoints:
  - POST /invoices: create(Invoice), auth(api_key), rate_limit(100/min)
  - GET /invoices/:id: read(Invoice), auth(api_key)
  - PATCH /invoices/:id/send: transition(Invoice.status, draft -> sent)
slos:
  p99_latency_ms: 200
  availability: 99.9
```

Agent writes the spec (~20 decisions, creative work). A compiler generates the implementation deterministically from the contract layer. Handles ~80% of standard CRUD + auth + async services. For the remaining 20%, agents use the contract layer directly.

### Legal Constraints on Component Architecture

1. **AGPL firewall (Critical blocker).** Automated license scanner must block AGPL-licensed packages at ingestion. AGPL in a SaaS context triggers forced source code release. No exceptions. Must be resolved before any dependency curation.
2. **Privacy-by-design.** Any component handling PII (auth, forms, user profiles) must have mandatory privacy tests before deployment. GDPR Article 25 requires this.
3. **IP protection through trade secrets.** AI-generated components may not be copyrightable (Thaler v. Perlmutter). But they can be trade secrets under the Defend Trade Secrets Act if they stay private. SaaS delivery model + private registry IS the IP protection. To strengthen copyright arguments, human architects provide documented design specifications.

### Why Agents Cannot Maintain a Component Library

The spec's own tier structure proves this:

- **Executors** (write code): lowest tier, can't initiate tasks, can't read other executors' work
- **Reviewers**: can't modify outputs, 1 round of feedback then escalate
- **Orchestrator**: 4K-6K token context limit — can't hold all downstream services simultaneously

No agent tier has both the capability to evaluate cross-service impact AND the authority to approve it. The component/contract layer must be **curated by policy and compiled by tooling**, not maintained by agents improvising.

### Cost Comparison

| Approach | 3-Year Cost | Break-Even |
|----------|-------------|------------|
| Full internal library (replacing npm packages) | $313K-453K | Year 5-6 (maybe never) |
| Contract layer + SSL + air-gapped vendor | $95K-125K | Year 3-4 |

Recommended approach: ~14,500 LOC over 10 weeks:
1. Allowlist registry + vendor cache — 1,500 LOC
2. Contract layer (TypeScript interfaces + adapters) — 3,000 LOC
3. CVE awareness pipeline — 2,000 LOC
4. Service Specification Language + compiler — 5,000 LOC
5. AGPL firewall + license scanner — 1,000 LOC
6. Behavioral verification suite (property-based + mutation testing) — 2,000 LOC

### Component Schema

The `autobot_components` schema is the 6th schema alongside the existing five. Key design decisions:
- Semver stored as three INT columns (sortable, constrainable, indexable — not parsed strings)
- Content-addressed hashing with `BYTEA NOT NULL CHECK (length(sha256_hash) = 32)`
- Cycle detection via iterative BFS with depth limit (not recursive CTE — won't infinite-loop)
- CVE impact analysis pre-materialized for millisecond security response queries
- Append-only audit trails with triggers preventing UPDATE/DELETE, TRUNCATE revoked
- Three roles: `components_service`, `components_reader`, `components_auditor`
- Full DDL in companion document

---
