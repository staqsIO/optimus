# Optimus: Inter-Organizational Governance Infrastructure

*A strategic vision document for the board — Dustin Powers and Eric Gang.*
*Last updated: 2026-05-11*

---

## What Optimus Is Becoming

Optimus started with a narrow question: can a small team govern an AI inbox at a company they actually run? Anyone can build an AI that sends emails. Governing one — with real legal exposure, reputational stakes, and a general counsel who needs to sleep at night — is different.

The answer so far is yes. The more important finding is what the infrastructure required to say yes actually looks like, and what else it is good for.

Optimus is becoming inter-organizational governance infrastructure: the layer that lets two companies' AI agents work together with verifiable provenance, auditable access policies, and instant revocation. Responsible single-organization governance compels you to build this anyway. Federation is not a new product — it is the natural extension of work already done.

---

## Why This Matters

Professional services firms routinely need agents at one organization to read documents, execute transactions, or share intelligence with agents at another — a PE firm onboarding an acquisition, two law firms on a joint venture, a portfolio company rolling up three HVAC businesses. Each case involves different data policies, different legal exposure, and a relationship that may not survive indefinitely.

Today this coordination happens over email threads, shared drives, and NDAs that nobody re-checks. There is no audit trail for what an AI touched. Revoked access has no enforcement mechanism. Errors surface at the next board meeting rather than at the moment they occur. The cost is accumulated drag — meetings that could have been avoided, commitments made without context, agreements that cannot be audited after the fact.

---

## The Primitive: Capability Receipts

Every time an agent at one organization reads a document, runs a query, or executes an action at another, the system produces a signed, replayable record: "Agent X at Org A read Document Y at Org B under Policy Z at time T." We call this a capability receipt.

A receipt is not a log entry. A log entry is internal evidence — it lives in your database and you control it. A receipt is external evidence — cryptographically signed at the moment of the action, verifiable by the counterparty without trusting your system, and immutable after the fact.

Think of SWIFT messages in international wire transfers. No individual bank invented SWIFT; it became standard because every participant needed the same boring, verifiable proof that a transfer happened. Capability receipts are that idea applied to inter-organizational AI actions: the compliance artifact a General Counsel can sign off on, the audit trail that survives a relationship breakdown, the revocation mechanism that actually works.

---

## Why Now

Two protocol families are converging on the agent coordination problem: Model Context Protocol (MCP) and Agent-to-Agent (A2A). Both define how agents discover capabilities and exchange information. Neither defines how organizations govern those exchanges — who authorized what, under which policy, for how long, and what happens when authorization ends.

That governance overlay does not yet exist as a standard. The window to build the first serious implementation is open now and probably not for long. The major cloud providers will bundle something into their default agent stacks within 18–24 months; whether that bundle meets the standard required for regulated industries is unlikely but not guaranteed.

The right response is to build the governance overlay on top of MCP and A2A — not compete with them on transport. Optimus's advantage is not the protocol. It is having built the governance layer before most competitors have recognized that the governance layer is the product.

---

## What Optimus Has Already Built That Compounds Toward This

Every architectural decision made during Phase 1 looks like infrastructure overhead for a single-company inbox. Each one is a federation primitive.

**Constitutional gates (G1–G11)** enforce budget limits, legal language detection, tone matching, and classification-aware access in the database — not in prompts. An AI cannot talk its way past them. When the counterparty is a different organization, that distinction is the whole game.

**Hash-chained audit trail.** Every state transition is appended to an immutable, hash-chained log. Tampering with any record breaks the chain visibly — making the audit trustworthy to a third party, not just to the organization that produced it.

**Classification-aware retrieval.** Access is scoped at the query layer, not filtered after the fact. An agent at Org A cannot read Org B's restricted documents by accident; it needs an explicit grant.

**Agent identity and revocation.** Every agent carries a signed credential establishing what it may do and when that expires. Revocation is immediate — not queued for the next policy review.

**Tier hierarchy with explicit grants.** Agents cannot escalate their own permissions. This extends naturally across organizations: Org A's orchestrator can receive specific capabilities at Org B without inheriting Org B's full permission structure.

None of this was built for federation. It was built because single-organization governance required it. The head start is having built it first, in the right order.

---

## The Adoption Arc

**Phase 1 — current (2026).** Autobot Inbox is live at UMB Advisors: one inbox, L0 autonomy, end-to-end pipeline operational. UMB is N=1, not validation — but N=1 with genuine legal and reputational stakes is worth more than N=0 with a polished demo.

**Phase 2 — repeatable install (target: first half of 2027).** A second organization running autobot-inbox on the same governance stack without Optimus engineers customizing the install. This is an infrastructure problem — configuration management, tooling, documentation — not a features problem. No second product before this milestone. No federation pitches before this milestone.

**Phase 3 — first federated grant (target: 2027).** Two organizations on the stack with at least one cross-organizational capability grant in production. The beachhead is vertical roll-ups: companies that have acquired others in the same vertical (HVAC, dental, MSP, professional services) where parent and acquired entity share customers, vendors, and operational concepts. Same beneficial owner, overlapping ontology, daily inter-company transactions — the conditions that make federation valuable immediately.

**Phase 4+ — network effects.** Once capability receipts are artifacts that General Counsels have reviewed and signed off on, the governance layer becomes a prerequisite for AI collaboration at regulated firms. Timeline is speculative and depends on how Phase 3 goes.

---

## What This Changes for the Board

**No second product before a second organization.** The risk of expanding autobot-inbox's capabilities at UMB before achieving a second install is that Optimus becomes a bespoke AI consulting shop. Phase 2's definition of success is "another company runs this," not "UMB runs more of it."

**Ride open protocols; do not compete with them.** No proprietary inter-agent transport. Build the governance overlay on MCP and A2A.

**Hold on Neo4j expansion.** The knowledge graph has value within a single organization. Expanding it before federation primitives are stable adds migration complexity without adding federation value.

**Phase 2 is "second org," not "more features."** The instinct after Phase 1 stabilizes will be to deepen UMB's installation. Defer it. Phase 2's metric is an external organization running a governed install.

---

## What Could Go Wrong

Four scenarios could invalidate this thesis.

MCP and A2A standardize fast enough that the governance overlay becomes commodity before Optimus has distribution. If the major cloud providers ship auditable, revocable, classification-aware inter-agent governance by default in 2027, the window closes. This is the most plausible threat.

Vertical roll-up CEOs don't want shared brains. The operational case is real, but "I don't want my acquisition to see my playbook" is also real. The intended beachhead — a single beneficial owner with no information asymmetry to protect — is the mitigation.

The runway to N=2 doesn't materialize. Phase 2 requires a second organization to trust the governance model enough to hand over their email pipeline. That trust is earned by track record, not architecture. If Phase 1 doesn't produce a demonstrably stable, auditable system, Phase 2 stalls.

Microsoft or Google bundles equivalent governance into their default stack. Less likely for regulated-industry requirements in the near term, but not zero.

---

## The Endgame Connection

The AutoBot thesis — replacing the human board with a constitutional layer — depends on something that does not yet exist: a demonstrated track record of governed AI organizations operating reliably across organizational boundaries.

You cannot write a constitution for a thing that has never been governed. The constitutional layer needs evidence that agents behave as specified when their actions have real external consequences. Phase 3 federation is what produces that evidence.

Phase 1 governance is not overhead. Phase 2 install is not a distribution exercise. Phase 3 federation is not a product milestone. They are the necessary preconditions for the constitutional layer to be credible — to the market, to regulators, and to both board members.

Govern one organization well. Then govern two together with verifiable proof. Then let the constitutional layer govern the governing. Skipping steps does not accelerate the endgame. It makes it impossible.

---

*Strategic companion to the federation engineering ADR, which covers identity architecture, protocol choices, and Phase 1 design constraints. For technical detail, see the ADR.*
