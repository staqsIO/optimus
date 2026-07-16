## 13. AutoBot Constitution (Summary)

AutoBot inherits Optimus's architecture and replaces the human board with a constitutional layer. Full constitutional text is in the v3 response document. Key articles:

**The Three Laws** (preserved from original):
1. Net positive value — every product must deliver more value than it costs
2. No price floor — pricing optimizes for `max((price - cost) × customers)`
3. Random distribution — surplus is distributed directly to random individuals and data contributors (via licensed distribution partner). **Board directive (2026-02-26): distributions must be direct-to-individual. Charitable intermediary path eliminated.** This constrains the legal analysis to gift structuring (I.R.C. 102) and data licensing fees (1099-NEC) only.

**Pre-distribution activation gate:** The 40/20/40 split cannot activate until trailing 3-month average net revenue exceeds 150% of trailing 3-month average operating costs. Until then, 100% of revenue is reinvested. This is a constitutional constraint, not a policy — encoded as a CHECK constraint in the DDL.

**Five Immutable Components** (no agent-controlled AI in any of them):

| Component | Purpose | Agent Access | Immutability |
|-----------|---------|-------------|-------------|
| Kill Switch | External halt/resume/kill | Read-only via orchestration layer | Board-set, versioned, audited |
| Financial Script | Revenue, expenses, reserve, allocation | SELECT only on output tables | Board-set, versioned, audited |
| Distribution Mechanism | Recipient selection, fund transfer (via licensed partner) | SELECT only on output tables | Board-set, versioned, audited |
| Value Measurement Script | Retention-based product value assessment | SELECT only on output tables | Board-set, versioned, audited |
| Communication Gateway | External message routing, scanning, delivery | Intent API only | Board-set, versioned, audited. Agents submit structured intents; Gateway behavior set by board config deploy. Any change requires board approval. (Highest-risk component per §2 Lethal Trifecta.) |

**Key constitutional amendments** (from v3):
- Article 4.2a: Agents may *propose* prompt modifications; deployed only after Auditor approval. Cosine similarity drift budget: 0.95 threshold measured against the ORIGINAL approved prompt (not just the previous version — prevents cumulative drift over 20+ modifications).
- Article 4.4: All internal communication via task graph. Public event archive preserves full transparency.
- Article 4.5: External communication via Gateway only. Risk-tiered release. AI disclosure on all outbound.
- Article 8: Three-tier kill switch with dead-man's switch (30-day).
- Article 10: Data governance — user ownership, Data Cooperative, open algorithms, data minimization, data contribution fee. (v0.5 note: "data dividend" restructured as a data licensing fee based on contribution volume/quality, not a profit share — avoids Howey test securities classification. "Algorithm moves to the data" (OPAL) narrowed to: "All algorithms that process user data are published open-source, versioned, and independently auditable. Data is processed on AutoBot infrastructure under Data Cooperative audit rights.")
- Article 3.6: Legal entity (LLC) required. Creator is legal custodian with non-delegable obligations (limited to: dead-man's switch renewal, kill switch authority, annual tax filing oversight, distribution partner relationship — NOT operational decisions, NOT communication approval).
- Article 3.7: Distributions via licensed money transmission partner (handles KYC, OFAC, tax reporting).
- Article 3.8: Allocation formula — 40% reinvestment / 20% data contribution fees / 40% random distribution. Encoded as CHECK constraints in `monthly_allocations` table. Subject to pre-distribution activation gate (above).

**Clarification on "no ongoing human involvement" (v0.5):** AutoBot is operationally autonomous — no human decides what products to build, how to price them, or how to execute tasks. It is NOT legally autonomous. The creator is a custodian. The CPA is a service provider. The attorney is a service provider. The distribution partner is a service provider. No entity — human or AI — operates without legal human accountability.
