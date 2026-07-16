# Legal Analysis: LLC Formation, Distribution Partner Selection, and Wyoming DAO LLC

> **Agent:** Compliance (Legal & Regulatory)
> **Date:** 2026-02-26
> **Scope:** Three open legal questions from `open-questions/README.md` — LLC formation jurisdiction, distribution partner selection, Wyoming DAO LLC specifics
> **Context:** AutoBot v0.4 spec, Eric's v3 response (conversation/005), Eric's response to v0.4 (conversation/008)
> **Disclaimer:** This is an analytical framework, not legal advice. The recommendations below should be validated by licensed counsel in the relevant jurisdictions before any formation or filing occurs.

---

## Question 1: LLC Formation — Delaware vs Wyoming DAO LLC

### Concrete Recommendation

**Form a standard Delaware LLC. Do not form a Wyoming DAO LLC at Phase 0.**

File as a standard Delaware LLC with the creator as sole member. Incorporate the constitutional governance framework into the operating agreement as a traditional contract document. Revisit the Wyoming DAO LLC question at Phase 3 (AutoBot Sandbox) when the system is actually algorithmically managed and the legal landscape has matured.

### Legal Reasoning

**Why Delaware wins for Phase 0-2 (Optimus through Shadow AutoBot):**

1. **Case law depth.** Delaware has 125+ years of LLC case law and the Court of Chancery, a specialized equity court with judges (no juries) who decide business disputes. Outcomes are predictable. Dispute resolution is measured in weeks, not months. For a novel organizational structure that will face novel legal questions, the jurisdiction with the deepest body of interpretive law reduces uncertainty at every step.

2. **Banking and payment processor relationships.** Every bank, payment processor, and financial services provider in the United States has a standard workflow for Delaware LLCs. A Wyoming DAO LLC is a novelty. The "DAO" designation in the entity name triggers enhanced due diligence, delays in account opening, and potential outright refusal. Mercury, Brex, Stripe Atlas — the banks that serve startups — all have standard Delaware LLC flows. A DAO LLC adds friction to every financial relationship at a stage when the system needs frictionless access to banking.

3. **Investor and counterparty familiarity.** If AutoBot ever needs outside capital, advisory relationships, or commercial partnerships (even for the distribution partner MSA), Delaware is the default expectation. A Wyoming DAO LLC signals "crypto project," which carries reputational baggage regardless of whether the system uses blockchain.

4. **The DAO LLC provides no legal advantage AutoBot needs during Phases 0-2.** During Phases 0-2, the human board governs Optimus. The system is NOT algorithmically managed — humans make strategic decisions, agents execute. A standard LLC with a well-drafted operating agreement covers this entirely. The DAO LLC's "algorithmically managed" designation is designed for systems where code IS the governance layer. That is Phase 3+ at earliest.

5. **Operating agreement flexibility.** Delaware's LLC Act (6 Del. C. Chapter 18) provides maximum contractual freedom. The operating agreement can incorporate every constitutional constraint, the Three Laws, the kill switch protocol, the dead-man's switch — all as contractual provisions. Delaware courts will enforce these provisions as written. There is no need for a special entity designation to achieve this.

**Why Wyoming DAO LLC is premature:**

1. **Zero court precedent.** The Wyoming DAO LLC Act (W.S. 17-31-101 through 17-31-116) was enacted in 2021. As of February 2026, there are no reported court cases interpreting the statute. No appellate decisions. No Court of Chancery equivalent rulings on algorithmically managed LLCs. The first disputed DAO LLC will establish precedent — and being that test case is a risk, not a feature.

2. **The "algorithmically managed" requirement has a precondition.** Under W.S. 17-31-104, an algorithmically managed DAO LLC can only register as such if the governing smart contract (or algorithmic system) is already operational at the time of filing. AutoBot has no operational system at Phase 0. Filing as algorithmically managed at formation is either impossible or requires filing as member-managed initially and converting later.

3. **Smart contract precedence creates ambiguity.** Wyoming law provides that where the articles of organization conflict with the smart contract, the smart contract takes precedence. For a system whose "smart contract" is actually a Postgres task graph with constitutional constraints, this hierarchy is untested and potentially problematic. If a bug in the system produces behavior that conflicts with the articles, Wyoming law may treat the buggy behavior as authoritative.

4. **Fiduciary duty elimination is double-edged.** Wyoming allows DAO operating agreements to "define, reduce, or eliminate fiduciary duties" (W.S. 17-31-109). AutoBot's creator has "non-delegable obligations" (Article 3.6). Eliminating fiduciary duties for the creator-as-member could undermine the very custodial framework the spec requires. The creator SHOULD owe fiduciary duties to the entity — that is what makes the custodial role meaningful.

### Tax Implications

| Factor | Delaware LLC | Wyoming DAO LLC |
|--------|-------------|-----------------|
| Federal tax | Pass-through (single-member = disregarded entity) | Same — DAO LLC designation does not change federal tax treatment |
| State income tax | Delaware does NOT tax LLC income earned outside Delaware (no nexus required) | Wyoming has no state income tax |
| Franchise tax | $300/year (flat, regardless of revenue) | $60/year minimum (asset-based formula, $0.0002 per dollar of Wyoming assets over $300K) |
| Formation cost | $110 filing fee | $100 filing fee |
| Registered agent | Required ($50-200/year) | Required ($0-199/year) |
| Foreign qualification | If the creator or operations are in another state, that state's foreign LLC registration is required regardless of formation state | Same |

**Net cost difference:** Wyoming saves approximately $240/year in franchise tax. This is irrelevant at AutoBot's budget scale. The legal certainty Delaware provides is worth orders of magnitude more than $240/year.

**Critical tax note:** Regardless of formation state, the LLC will owe taxes in every state where it has nexus (economic nexus under Wayfair for SaaS customers, physical nexus for the creator's state). The formation state choice does not affect this. The spec already identifies multi-state sales tax compliance as a task for Avalara/TaxJar (conversation/008, L5).

### Other Jurisdictions

**Nevada:** No state income tax, strong privacy protections, but higher filing fees ($425+ formation, $350/year business license) and no DAO-specific provisions. Adds no value over Delaware for AutoBot's use case. The privacy advantage is irrelevant for an entity that publishes everything to a public transparency layer.

**Marshall Islands:** The Republic of the Marshall Islands enacted the DAO Act in 2022 and allows DAO LLCs with legal personhood. This is designed for crypto/DeFi projects that need to minimize regulatory contact with US regulators. AutoBot is the opposite — it needs to engage deeply with US regulators (money transmission analysis, tax compliance, distribution partner MSA). A Marshall Islands entity would make every US regulatory interaction harder. The entity would also face challenges opening US bank accounts, executing US commercial contracts, and filing US taxes. Not recommended.

### Does the DAO LLC Designation Help or Hurt with Banks and Regulators?

**It hurts.** Every compliance officer, BSA officer, and bank relationship manager who sees "DAO" in the entity name will apply enhanced due diligence procedures designed for crypto companies. This means:

- Longer account opening timelines (4-12 weeks vs 1-2 weeks)
- Additional documentation requirements (source of funds, beneficial ownership deep-dive, technology description)
- Higher risk of account denial or closure
- Higher risk of payment processor application rejection
- Stripe, which the spec identifies as the payment processor (Phase 0, item 4), has historically been cautious with DAO-designated entities

The spec's own Design Principle P4 (Boring Infrastructure) applies to the legal structure too. A standard Delaware LLC is the most boring, most proven entity that solves the problem.

### Phase Gate

**This does NOT block Phase 0.** The decision can be made immediately. Form a Delaware LLC now. Revisit Wyoming DAO LLC conversion at Phase 3 if the legal landscape has matured and the system is actually algorithmically managed.

---

## Question 2: Distribution Partner Selection

### Concrete Recommendation

**Do not select GiveDirectly. Use a tiered approach: Stripe Connect for the Data Dividend (Phase 3+), and a Donor Advised Fund (Every.org or a custom DAF) for the Random Distribution (Phase 3+). Defer the final selection until the money transmission analysis is complete.**

The distribution partner selection is downstream of the money transmission analysis. The money transmission counsel's opinion (Phase 0, $15-25K budget) will determine which of the three structural paths is viable:

1. **Charitable intermediary path** (501(c)(3) handles distribution) — constrains to Every.org, PayPal Giving Fund, or a custom DAF
2. **Gift structuring path** (distributions are gifts from the LLC) — constrains to direct payment via Stripe/ACH
3. **Data licensing path** (Data Dividend is compensation) — constrains to Stripe Connect with 1099-NEC reporting

Each path produces a different partner matrix. Selecting the partner before the legal analysis is premature.

### Analysis of Proposed Partners

#### GiveDirectly — NOT RECOMMENDED

GiveDirectly is a 501(c)(3) that operates direct cash transfer programs primarily in East Africa, with some US disaster relief programs.

**Why it does not fit AutoBot's requirements:**

1. **No programmatic API.** GiveDirectly does not offer a developer API for programmatic donations or recipient selection. Their technology stack is designed for their own operations (identifying recipients via satellite imagery, delivering via mobile money in Africa). There is no documented interface for a third party to programmatically direct distributions to specific recipients.

2. **Recipient selection mismatch.** GiveDirectly selects its own recipients based on poverty indicators. AutoBot's constitutional requirement is random selection — the system picks recipients, not the intermediary. GiveDirectly's model is fundamentally incompatible with the constitutional randomness requirement (Law 3).

3. **Geographic mismatch.** GiveDirectly operates primarily in Kenya, Uganda, Rwanda, Liberia, Malawi, and Mozambique. If the Random Distribution is meant to include US recipients (or global recipients beyond East Africa), GiveDirectly cannot serve as the distribution mechanism.

4. **Tax treatment mismatch.** Donations to GiveDirectly are charitable contributions deductible under I.R.C. 170. But GiveDirectly redistributes to its own selected recipients — not to AutoBot-selected random individuals. If AutoBot donates to GiveDirectly, the money goes to GiveDirectly's programs, not to AutoBot's constitutional distribution mechanism. AutoBot loses control over the distribution.

5. **1099 reporting.** GiveDirectly does not issue 1099s to its recipients (they are charitable beneficiaries, not payees). If AutoBot needs 1099 reporting for its distributions (likely under I.R.C. 74 for prizes/awards), GiveDirectly cannot provide this.

#### Every.org — VIABLE FOR CHARITABLE INTERMEDIARY PATH

Every.org is a 501(c)(3) that operates a Donor Advised Fund platform with a free charity API.

**Advantages:**
- Has a documented developer API for programmatic donations
- 501(c)(3) status means donations from the LLC are tax-deductible
- Handles 1099-K reporting as needed
- Supports donations to any enrolled 501(c)(3)
- No fees to charities or donors (funded by tips)

**Limitations:**
- Every.org distributes to charities, not to individuals. It cannot be the endpoint for random individual distribution. It could serve as the intermediary if AutoBot's Random Distribution is restructured as donations to a rotating set of charities rather than random individuals.
- If the constitutional requirement is truly "random individuals receive cash," Every.org cannot satisfy it. If the constitutional requirement can be reinterpreted as "random charitable organizations receive surplus," Every.org works.
- This requires a constitutional amendment to Law 3. This is a governance question, not a technical one.

#### PayPal Giving Fund — VIABLE BUT LIMITED

PayPal Giving Fund is a 501(c)(3) Donor Advised Fund that processes charitable donations.

**Advantages:**
- Established infrastructure for charitable distribution
- No fees to charities
- Tax-deductible for donors
- Monthly grant disbursement cycle

**Limitations:**
- Distributes to enrolled charities, not to individuals
- No documented developer API for programmatic control
- Disbursement cycle is monthly (15-45 day lag) — acceptable for AutoBot's monthly allocation cycle
- Same constitutional constraint as Every.org — cannot distribute to random individuals

#### Stripe Treasury / Stripe Connect — VIABLE FOR DIRECT DISTRIBUTION

Stripe Financial Accounts (formerly Stripe Treasury) provides programmatic fund management and outbound payments.

**Advantages:**
- Full API for programmatic disbursements
- Supports ACH, wire transfers, and instant payouts
- Built-in 1099 reporting via Stripe Tax
- The LLC already uses Stripe for payment collection (Phase 0, item 4) — same platform
- Can handle small payments ($5-50 per recipient)
- FDIC pass-through insurance on held funds

**Limitations:**
- Does NOT solve the money transmission question. If the LLC is originating distributions, using Stripe as the payment rail does not exempt the LLC from money transmission licensing. Stripe is a payment processor, not a money transmission shield.
- The LLC would still need the charitable intermediary or gift structuring to address the regulatory question.
- Stripe Connect requires recipients to onboard with Stripe (KYC, bank account linking). For random strangers, this is friction-heavy.

#### Building Distribution Directly Through the LLC — NOT RECOMMENDED FOR PHASE 0-2

Building the distribution directly (LLC selects recipients, sends payments via ACH/Stripe) is the simplest technical architecture but the most complex legal architecture.

**Why not:**
- Triggers money transmission analysis in every state where recipients reside (potentially all 50 states + territories)
- Requires the LLC to collect TINs and file 1099s for every recipient
- Requires the LLC to perform OFAC screening on every recipient
- Requires the LLC to implement KYC procedures
- The spec already identifies this as infeasible — Article 3.7 explicitly calls for "distributions via licensed money transmission partner"

### Recommended Architecture

**For the Data Dividend (20% allocation):**

Use Stripe Connect with the "platform" model. Data Cooperative members are onboarded as Stripe Connect accounts. The LLC pays Data Dividend through Stripe Connect as 1099-NEC compensation for data licensing. Stripe handles KYC, 1099 reporting, and fund transfer.

This works because:
- Data Dividend recipients are known users who have already onboarded to the product
- They have a commercial relationship with the LLC (data contribution)
- The payment is compensation, not a gift or prize
- Stripe Connect is designed exactly for this (platform pays connected accounts)

**For the Random Distribution (40% allocation):**

This depends on the money transmission analysis outcome:

| Money Transmission Path | Distribution Partner | Mechanism |
|------------------------|---------------------|-----------|
| Charitable intermediary | Every.org DAF or custom DAF | LLC donates to DAF. DAF distributes to selected charities. Requires constitutional amendment (random charities, not random individuals). |
| Gift structuring | Stripe Connect + custom onboarding | LLC sends gifts to randomly selected individuals. Recipients must onboard (KYC). Gift tax applies ($18K/year/recipient exclusion). Manageable at small amounts. |
| Licensed transmitter partner | A licensed money transmitter (e.g., Payoneer, Hyperwallet, Tremendous) | LLC contracts with a licensed MSB to handle outbound distribution. MSB handles KYC, OFAC, 1099. LLC is the originator, MSB is the transmitter. |

**If the charitable intermediary path is chosen (from conversation/008, L1, option 1), then the partner is constrained:**

- Every.org is the strongest option (API, 501(c)(3), no fees)
- BUT the constitutional random individual distribution must be amended to random charitable distribution
- This is a significant change to Law 3 that requires Dustin's input

### Phase Gate

**Partner selection does NOT block Phase 0.** Phase 0 requires the money transmission analysis (item 2). The partner selection is a consequence of that analysis, not a prerequisite. The Phase 0 exit criterion is "distribution path legally validated" — that means the legal structure is determined, not that the partner contract is signed.

**Partner selection DOES block Phase 3** (AutoBot Sandbox), which requires "real financial transactions through licensed partner." The MSA with the selected partner must be executed before Phase 3 activation.

---

## Question 3: Wyoming DAO LLC Specific Questions

### Can the Operating Agreement Be a Smart Contract or Constitutional Document Enforced by Code?

**Yes, with significant caveats.**

Wyoming law (W.S. 17-31-106(c)) explicitly states: "The underlying smart contracts utilized by a decentralized autonomous organization may define the organization and its operating agreement." Furthermore, the statute establishes a hierarchy where smart contract provisions take precedence over conflicting provisions in the articles of organization.

**However, for AutoBot specifically:**

1. **AutoBot's "smart contract" is not a smart contract.** The system uses a Postgres task graph, SQL constraints, JWT scoping, and database roles — not blockchain-based smart contracts. Wyoming law references "smart contracts" without a precise technical definition, but the legislative intent and surrounding context are blockchain-centric. Whether a Postgres-enforced constitutional framework qualifies as a "smart contract" under the statute is untested.

2. **The constitutional document can be REFERENCED by the operating agreement.** The operating agreement can state: "The governance rules defined in [constitutional document, version X, hash Y] are incorporated by reference and shall govern the operations of the LLC." This is standard contract law. Delaware supports this too. The DAO LLC designation is not required for this.

3. **Code-enforced provisions need a legal backstop.** If the Postgres CHECK constraint enforcing the 40/20/40 split has a bug, does that bug become the legally operative allocation? Under Wyoming's smart contract precedence rule, arguably yes. Under Delaware's operating agreement, arguably no — the written intent controls, and the code is an implementation tool. Delaware's answer is safer.

**Recommendation:** Do not rely on code-as-contract for critical provisions. Use a traditional operating agreement that references the constitutional document and states that the code implements the agreement's intent, not that the code IS the agreement. This works under both Delaware and Wyoming law.

### How Does "Algorithmically Managed" Interact with Fiduciary Duties?

Under W.S. 17-31-109, the DAO LLC's organizing documents may "define, reduce, or eliminate fiduciary duties." For an algorithmically managed DAO:

1. **Default rule:** If the operating agreement is silent, Wyoming LLC default fiduciary duties apply (duty of care, duty of loyalty). These duties run from managers to members.

2. **In an algorithmically managed DAO, who is the manager?** The algorithm. This creates a conceptual problem — an algorithm cannot owe fiduciary duties because it has no legal personhood.

3. **Practical effect:** In an algorithmically managed DAO LLC with a human custodian, the custodian is the person most likely to be held to fiduciary standards regardless of what the operating agreement says. Courts look for the human who had the ability to prevent harm. The creator — with kill switch authority, dead-man's switch obligations, and tax filing duties — IS that human.

4. **The elimination of fiduciary duties does not eliminate the implied covenant of good faith and fair dealing.** Even if all fiduciary duties are eliminated, Wyoming law preserves this contractual minimum. A creator who deliberately ignores obvious system malfunctions could still be liable under this standard.

**For AutoBot:** The fiduciary duty question is actually simpler than it appears. During Phases 0-2 (Optimus), the human board has traditional fiduciary duties — standard LLC governance. During Phases 3-4 (AutoBot), the creator is the custodian with defined non-delegable obligations. The operating agreement should DEFINE fiduciary duties for the custodian role (not eliminate them) — specifically tied to the dead-man's switch, kill switch, tax filing, and distribution partner oversight. This gives the creator clear duties without exposure to open-ended fiduciary obligations for every operational decision agents make.

### Has Any DAO LLC Been Tested in Court?

**No.** As of February 2026, there are no reported court decisions interpreting Wyoming's DAO LLC Act (W.S. 17-31). No appellate decisions. No trial court opinions in searchable databases. The statute has existed for five years without judicial interpretation.

This is both unsurprising and concerning:

- **Unsurprising** because most DAO LLCs formed under the act are small, crypto-native projects with limited commercial activity and few counterparty disputes.
- **Concerning** because AutoBot intends to operate as a real business with real revenue, real distributions, and real regulatory obligations. The first dispute involving these provisions will be first-impression litigation with no guiding precedent.

**Contrast with Delaware:** The Delaware Court of Chancery decides hundreds of LLC disputes per year. The body of case law on operating agreement interpretation, member disputes, fiduciary duties, dissolution, and manager liability is enormous. Any legal question AutoBot faces in Delaware will have analogous precedent. In Wyoming, the answer to every question is "unknown."

### Annual Filing and Compliance Burden vs Delaware

| Requirement | Delaware LLC | Wyoming DAO LLC |
|-------------|-------------|-----------------|
| Formation filing | Certificate of Formation ($110) | Articles of Organization + DAO Supplement ($100) |
| Annual report | None (LLCs do not file annual reports in Delaware) | Annual report required ($60 minimum) |
| Franchise tax | $300/year (flat, due June 1) | $60/year minimum (due on formation anniversary) |
| Registered agent | Required ($50-200/year) | Required ($0-199/year) |
| Smart contract disclosure | N/A | Public identifier of any smart contracts must be disclosed and updated within 30 days of changes |
| Beneficial ownership (FinCEN BOI) | Required (federal, not state) | Required (federal, not state) |
| Total estimated annual cost | $350-500/year | $60-259/year |

**Net difference:** Wyoming is approximately $100-250/year cheaper. The compliance burden is roughly equivalent, except that Wyoming DAO LLCs have the additional obligation to disclose and update smart contract identifiers — which for AutoBot's Postgres-based system is an awkward fit.

**Delaware's hidden advantage:** No annual report for LLCs. One payment per year ($300 franchise tax). Done. Wyoming requires an annual report filing in addition to the fee — one more administrative task that the creator must handle (or automate).

---

## Summary of Recommendations

| Question | Recommendation | Phase Gate | Estimated Cost |
|----------|---------------|------------|----------------|
| LLC formation jurisdiction | Delaware LLC (standard, not DAO) | Does not block Phase 0 — form immediately | $110 formation + $300/year |
| Distribution partner | Deferred pending money transmission analysis; likely Stripe Connect (Data Dividend) + Every.org or licensed MSB (Random Distribution) | Does not block Phase 0; blocks Phase 3 | $15-25K for legal analysis; partner MSA costs TBD |
| Wyoming DAO LLC | Do not form at Phase 0; revisit at Phase 3 when system is actually algorithmically managed and case law exists | Does not block any phase | N/A (savings from not forming) |

## Risks to Track

1. **Wyoming DAO LLC case law development.** Monitor for any court decisions interpreting W.S. 17-31. If favorable precedent develops by Phase 3, conversion from Delaware LLC to Wyoming DAO LLC becomes viable.

2. **FinCEN guidance on AI-managed entities.** FinCEN has not issued guidance on beneficial ownership reporting for algorithmically managed entities. The creator is currently the beneficial owner, but as the system becomes more autonomous, the question of "who controls the entity" becomes legally interesting. Monitor for guidance.

3. **State money transmission licensing evolution.** Several states are considering uniform approaches to digital payment regulation. The Uniform Money Transmission Modernization Act (UMTMA) may simplify multi-state compliance. Monitor legislative developments.

4. **Every.org API maturity.** If the charitable intermediary path is selected, the Every.org API's capabilities for programmatic, recurring, small-amount donations should be validated through a proof-of-concept before committing to an MSA.

5. **Constitutional amendment requirement.** If the charitable intermediary path is selected, Law 3 (Random Distribution to random individuals) must be amended to allow distribution to random charitable organizations instead of random individuals. This is a governance decision that requires Dustin's input and has philosophical implications for the AutoBot vision.

---

## Sources

- [Wyoming DAO LLC Act — Justia](https://law.justia.com/codes/wyoming/title-17/chapter-31/article-1/section-17-31-104/)
- [Wyoming DAO Supplement — Secretary of State](https://sos.wyo.gov/Forms/WyoBiz/DAO_Supplement.pdf)
- [Wyoming DAO FAQs — Secretary of State](https://sos.wyo.gov/Business/Docs/DAOs_FAQs.pdf)
- [Wyoming DAO LLC Legal Wrapper — LegalNodes](https://www.legalnodes.com/article/wyoming-dao-llc)
- [Algorithmically-Managed Wyoming DAO Operating Agreement — Montague Law](https://montague.law/blog/algorithmically-managed-wyoming-dao-operating-agreement/)
- [Wyoming DAO LLC Formation and Operation — Dilendorf](https://dilendorf.com/resources/forming-and-operating-a-wyoming-dao-llc.html)
- [Wyoming DUNA — a16z Crypto](https://a16zcrypto.com/posts/article/duna-for-daos/)
- [Wyoming New Legal Structure for DAOs — Fintech Blog](https://www.fintechanddigitalassets.com/2024/04/wyoming-adopts-new-legal-structure-for-daos/)
- [DUNA 101: Founder's Guide — Toku](https://www.toku.com/resources/duna-101-a-founders-guide-to-wyomings-dao-legal-framework)
- [Delaware LLC Costs — LLCU](https://www.llcuniversity.com/delaware-llc/costs/)
- [Delaware Franchise Tax Instructions](https://corp.delaware.gov/alt-entitytaxinstructions/)
- [Wyoming LLC Costs — BizReport](https://www.bizreport.com/llc-cost-wyoming)
- [Delaware vs Nevada vs Wyoming LLC — Harbor Compliance](https://www.harborcompliance.com/delaware-vs-nevada-vs-wyoming-llc)
- [Marshall Islands DAO — MIDAO](https://midao.org/)
- [Marshall Islands DAO LLC — LegalNodes](https://www.legalnodes.com/article/marshall-islands-llc-as-a-dao-legal-wrapper)
- [Every.org Charity API](https://www.every.org/charity-api)
- [Stripe Financial Accounts for Platforms](https://stripe.com/financial-accounts/platforms)
- [Stripe Treasury Outbound Payments API](https://docs.stripe.com/api/treasury/outbound_payments)
- [PayPal Giving Fund — Donation Delivery Policy](https://www.paypal.com/us/webapps/mpp/givingfund/policies/donation-delivery-policy)
- [GiveDirectly — Wikipedia](https://en.wikipedia.org/wiki/GiveDirectly)
- [FinCEN Guidance FIN-2019-G001](https://www.fincen.gov/system/files/2019-05/FinCEN%20Guidance%20CVC%20FINAL%20508.pdf)
- [IRS 501(c)(3) Exemption Requirements](https://www.irs.gov/charities-non-profits/charitable-organizations/exemption-requirements-501c3-organizations)
- [DAO LLC Formation Guide — Astraea Counsel](https://astraea.law/insights/dao-llc-formation-wyoming-duna-guide-2025)
