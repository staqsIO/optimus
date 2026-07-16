# ADR-021: `lib/` substrate — complete the extraction, do NOT collapse to single-product

- **Status**: Proposed
- **Date**: 2026-06-14
- **Deciders**: Board (Dustin + Eric)
- **Supersedes / relates**: ADR-002 (individual-install over multi-tenant), ADR-008 (agent-native governed operating layer), Plan `plans/009-spike-validate-lib-second-product.md`, `shadcn/improve` audit finding DIR-A, OPT-145
- **Spike note**: This ADR answers the board's question from a *static coupling audit* (Step 1 of plan 009). It argues the throwaway product-#2 prototype (Step 2) is **not worth building** — see §6.

---

## Decision (lead with the recommendation)

**Adopt Option A: complete the extraction toward a product-neutral substrate.** Do *not* collapse `lib/` into `autobot-inbox`.

But adopt it for the **unsexy reason**, not the architecture-astronaut one: the coupling tax is already 80% paid, the residual is small and mechanical, and the *governance substrate* (task graph, hash-chained audit, constitutional gates, JWT/RLS tenancy) is the defensible thesis of the entire company — and it is **valuable single-product regardless of whether product #2 ever ships**. Collapsing would retire scaffolding that costs almost nothing while gaining nothing measurable.

This is **not** an endorsement of building product #2 soon. It is a recommendation to finish a near-done cleanup and then *stop*, leaving a validated seam dormant.

---

## Context: the real coupling number is not 32

The headline — "32 `lib/` files hardcode `autobot-inbox`" — overstates the tax by ~3x. Static classification of all 32 (`file:line` evidence):

| Bucket | Count | Files | Real runtime coupling? | Cost to neutralize |
|---|---:|---|---|---|
| **A. Config-path duplication** | 6 | `lib/engagements/{synth,client-search,proposal-template,contract-drafter}.js`, `lib/runtime/verification/scenario-factory.js`, `lib/db.js`* | Yes — each re-implements `join(__dirname,'..','..','autobot-inbox','config','agents.json')` + `process.cwd()` fallback + throw | **Mechanical.** The seam exists: `lib/config/loader.js` (`getConfig`/`getConfigPath` + `setConfigBaseDir`). 16 lib/ files already adopt it. |
| **B. Runtime imports into the product** | 4 | `lib/engagements/auto-build.js`→`gmail/client.js`, `lib/engagements/gdoc-export.js`→`drive/service-auth.js`, `lib/runtime/meeting-classifier.js` + `lib/runtime/signals/artifact-enrichment-worker.js`→`autobot-inbox/agents/flow-agents/*` | Yes — the genuine CG-1 leak | **Hard residual.** Needs the channel/agent registry (roadmap item 3). |
| **C. Comment-only references** | 21 | `lib/linear/*` (6), `lib/runtime/signals/*` (8), `lib/runtime/state/*`, `lib/runtime/governance/*`, `lib/content/create-artifact.js`, etc. | **No.** `autobot-inbox` appears only in docstrings (`PRD: autobot-inbox/docs/...`), prose ("mirrors the resolver in..."), or comments. Zero import, zero path resolution. | A `sed` pass on comments, or leave them. **Not a coupling tax.** |
| **D. By-design default** | 1 | `lib/config/loader.js` `FALLBACK_BASE_DIR` | No — the *intended* overridable shim default | Keep as-is. |

*`lib/db.js` straddles A (comment refs to autobot-inbox handlers) and is effectively comment-only for coupling purposes; its real config read is via the loader path.

**Conclusion: the genuine substrate-neutrality debt is 6 + 4 = 10 files, not 32.** Of those, 6 are a find-and-replace against an existing seam and 4 need one new registry. The "abstraction tax" the audit flagged is largely a *documentation* artifact (21 comment-only files) plus a half-finished, well-scoped cleanup.

---

## The contrarian-scaling question (where is the 10x?)

The board's framing — "is the leverage in the substrate or in shipping autobot-inbox?" — is a **false binary**. The leverage is in the substrate *as the thing that makes autobot-inbox defensible*, and product #2 is a red herring for this decision.

1. **The 10x is not "reuse across N products."** Optimus has 1 product with revenue intent and 3 markdown stubs with zero `src/`. Betting the architecture on a hypothetical product #2 is exactly the "we'll scale later" anti-pattern — paying complexity now for demand that isn't measured. If that were the only argument for `lib/`, I would recommend collapse.

2. **The 10x is the governance substrate itself.** Task graph as single source of truth, append-only hash-chained audit, infrastructure-enforced constitutional gates (G1–G11), JWT/RLS tenancy — *this is the product thesis* ("a governed agent organization"). It is what makes autobot-inbox trustworthy enough to run unsupervised, and it is the AutoBot endgame. This value is **fully realized at N=1 product.** It does not need a second product to justify itself.

3. **Therefore the architecture-neutrality of `lib/` and the value of `lib/` are decoupled.** You keep 100% of the substrate value whether or not you neutralize the last 10 files. Neutralization is cheap insurance, not the thesis.

This is why collapse loses on cost-benefit, not on principle: **collapse spends effort to delete optionality that is nearly free to keep.**

---

## Options considered

### Option A — Complete the extraction (RECOMMENDED)

Finish the in-flight roadmap to its natural stopping point, then freeze.

**Sizing (concrete, from the 10 real-coupling files):**

| Work item | Files | Effort | Risk |
|---|---|---|---|
| A1. Migrate the 6 config-dup sites to `getConfig`/`getConfigPath` | 6 (bucket A) | **~0.5 day.** Mechanical; pattern proven by 16 existing adopters. This is the tail of plan 005 (OPT-141 did the `autobot-inbox/src/*` sites; these lib/ sites were left). | LOW — same fallback path, behavior-preserving. |
| A2. Channel/agent registry (`lib/adapters/channel-registry.js`) for the 4 runtime imports | 4 (bucket B) | **~1.5–2 days.** This is the genuinely hard residual: gmail/drive senders + flow-agent handlers must become registered capabilities the product injects, not static imports. Roadmap item 3. | MEDIUM — touches live enrichment + meeting-classifier paths; needs the existing CG-1 ratchet + tests to fence regressions. |
| A3. Relocate product-coupled files (`lib/contracts/*`, `lib/wiki/compiler.js`) back to `autobot-inbox/` | ~3–4 | **~0.5 day.** Pure move + re-export shims (pattern already used for `phase1-metrics.js`, `campaign-promoter.js`). Roadmap item 4. | LOW. |
| A4. (Optional) comment hygiene on the 21 bucket-C files | 21 | **~0.25 day or skip.** Cosmetic; lowers future false-positive grep noise. | NONE. |

**Total: ~2.5–3 days**, of which **only A2 (~1.5–2 days) is non-trivial.** The residual that is "genuinely hard" is exactly one thing: the channel/agent injection registry. Everything else is mechanical against seams that already exist.

**Keep regardless:** the entire governance substrate (graph, audit, gates, tenancy, runtime loop) and the `setConfigBaseDir` seam (it is already built and free to retain).

### Option B — Collapse to single-product

Fold `lib/` governance into a leaner shared core inside `autobot-inbox`, retire `products/` scaffolds, delete the neutrality roadmap + `setConfigBaseDir`.

**What you'd retire:** `products/{deep-thought,ssl-compiler,umb-website}` (5 markdown files), roadmap items 2/3/4, the loader override seam.
**What you'd KEEP regardless:** all of the substrate (it's valuable at N=1), which means the "collapse" is mostly *moving directories and deleting 5 stub specs* — it does **not** simplify the hard part (the substrate stays).

**Why B loses:**
- It deletes ~free optionality (`setConfigBaseDir` is 30 lines, already shipped, zero runtime cost when unused).
- The "tax" it removes is the 21 comment-only files + a half-day config migration — i.e. it does not remove the substrate complexity, only the *aspiration* of reuse.
- It re-introduces the lib↔product↔agents flattening as a **new** large refactor (the directory move itself), trading a 2.5-day finish for a multi-day teardown that produces no new capability and forecloses AutoBot's multi-product endgame.
- Net: B spends *more* effort than A to deliver *less* (no neutral seam, same substrate, fewer options).

---

## §6 — Is the throwaway product-#2 prototype (plan 009 Step 2) worth building?

**No. The coupling analysis already answers the board's question; skip the prototype.**

Plan 009's prototype was designed to "reveal what lib/ forces you to fork or parameterize." The static audit already enumerated that exhaustively with `file:line` evidence: the answer is **the 10 files in buckets A+B, and nothing else.** A throwaway product wired to one governed path would, by construction, hit exactly A (config resolution) and B (channel/agent imports) — the two leaks we've already found and sized. It would cost ~1–2 days to re-derive a conclusion we hold on stronger evidence (the *whole* `lib/` surface, not one path).

Build the prototype **only if** Option A's A2 (the registry) turns out to be harder than the 1.5–2 day estimate — i.e. use a real product as the *acceptance test for the registry*, not as a discovery spike. Sequence it *after* A2, not before. (This also satisfies P5 "measure before you trust": the registry's value is measured by a real consumer, not asserted.)

---

## Migration sequence (Option A)

1. **A1 — config-dup migration (0.5d).** One Linear issue. Replace the 6 `join(__dirname...)` blocks with `getConfig('agents')`. Behavior-preserving; CI green via existing config-loader tests. *Closes the tail of plan 005.*
2. **A3 — relocations (0.5d).** Move `lib/contracts/*`, `lib/wiki/compiler.js` → `autobot-inbox/src/`; leave re-export shims (proven pattern). Updates `autobot-inbox/CLAUDE.md` roadmap item 4 → done.
3. **A2 — channel/agent registry (1.5–2d).** Build `lib/adapters/channel-registry.js`; product registers gmail/drive/flow-agent capabilities at startup; the 4 bucket-B files consume the registry. Gate with the CG-1 ratchet (expect baseline to *drop*) + targeted tests on enrichment + meeting-classifier.
4. **Freeze.** After A2, declare `lib/` neutral-enough; `setConfigBaseDir` stays dormant. Do **not** build product #2 to prove the point.
5. **A4 — optional comment hygiene** whenever convenient.

**Risks & mitigations:**
- *A2 regresses live enrichment/meeting paths* → land behind tests + CG-1 ratchet; the registry is additive (register the same impls) so the diff is import-rewiring, not logic change.
- *Eager-evaluation ordering* (loader docstring warns: `getConfig()` runs at module load) → product entry must call `setConfigBaseDir` before importing lib runtime, or dynamic-import after override. A1 inherits the existing fallback so this only matters for a real second product (deferred).
- *Scope creep into "real" product #2* → STOP condition: A2 is done when the registry passes existing tests, not when a second product runs.

---

## Board-facing summary

**Recommendation: finish the `lib/` extraction (Option A), then stop. Do not collapse, and do not build a throwaway second product.**

- The scary "32 coupled files" is really **10**: six are a half-day find-and-replace against a seam we already built, four need one small registry (~2 days), and **21 are comments** — not coupling at all.
- The substrate (governed task graph + hash-chained audit + constitutional gates + JWT/RLS tenancy) is the company's actual moat and is **fully valuable with one product**. Reuse across future products is a *bonus option*, not the justification.
- **Total cost to finish: ~2.5–3 days, only ~2 of which are non-trivial.** Collapsing would cost *more* (a directory teardown) and deliver *less* (it can't remove the substrate, only the cheap optionality on top of it).
- The throwaway prototype plan 009 proposed is **not worth building** — the static audit already produced its findings with broader evidence. Use a real product later as the registry's acceptance test, not as a discovery spike now.

**Decision requested:** approve Option A + the A1→A3→A2→freeze sequence, and explicitly decline the Step-2 prototype.
