---
title: "Legal Compliance Architecture"
section: 17
tier: core
description: "Tax, liability, IP, employment law, and custodian responsibilities"
---
## 17. Legal Compliance Architecture

> *Added in v0.5. Every regulatory obligation mapped to a mechanism, responsible party, and phase. The compliance review (conversation/008, Part 5) found five risks that could individually kill this project — including one federal felony. Solving them is the moat.*

AutoBot is operationally autonomous but NOT legally autonomous. The legal architecture maps every regulatory obligation to a concrete mechanism:

| Obligation | Mechanism | Responsible Party | Phase |
|-----------|-----------|-------------------|-------|
| Money transmission analysis | Legal counsel opinion (budget $15-25K) | Creator | 0 |
| Entity formation (LLC) | Legal counsel — Delaware LLC, evaluate Wyoming DAO LLC at Phase 3 | Creator | 0 |
| MSA with distribution partner | Legal counsel + creator | Creator | 0 |
| DPA with all processors | Legal counsel (cloud hosting, model providers, distribution partner) | Creator | 0 |
| Privacy Impact Assessment | Legal counsel + privacy specialist | Creator | 0 |
| Insurance (E&O, cyber, D&O) | Insurance broker — budget $5-10K/year for bespoke D&O policy | Creator | 0 |
| Securities analysis (data contribution fee) | Securities counsel — structured as data licensing fee, not profit share (avoids Howey test) | Creator | 0 |
| DSAR fulfillment system | Built into Communication Gateway — 30-day SLA (GDPR), 45-day SLA (CCPA) | Automated | 1 |
| Tax reporting (1099) | Distribution partner MSA — partner collects TINs and issues 1099s | Distribution partner | 3 |
| Sales tax collection | Automated tool (Avalara/TaxJar) in tool registry — Wayfair nexus thresholds reviewed quarterly | Tool + creator oversight | 3 |
| Quarterly estimated payments | Financial Script calculates, creator reviews and approves | Creator | 1+ |
| Annual tax return | CPA | Creator + CPA | 1+ |
| Dead-man's switch renewal | Monthly renewal via dashboard | Creator | 3+ |
| Data retention schedule | 7 years financial, 3 years audit, 90 days telemetry (configurable per product) | Automated + creator oversight | 1 |
| Cross-border data transfer | Standard Contractual Clauses for EU data | Creator + legal counsel | 1 |
| CCPA non-discrimination (1798.125) | Users who opt out of data collection receive equal service. Methodology published. | Automated | 3 |

### Money Transmission — Resolution Paths

The LLC originating distributions (selecting recipients, determining amounts, initiating transfers) is likely money transmission under FinCEN's functional test (31 U.S.C. 5330, FIN-2019-G001). Operating unlicensed is a federal felony (18 U.S.C. 1960). Four resolution paths ranked by feasibility:

1. **Gift structuring.** If truly random and unconditional, analyze under I.R.C. 102. $18,000/year/recipient exclusion in 2026.
2. **Data licensing fees (Data Dividend).** Structured as compensation for data contribution — 1099-NEC income. Not a security, not money transmission.
3. **FinCEN no-action letter.** Formal guidance for the specific fact pattern. ~$20-40K in legal fees but provides definitive cover.

> *Note: Charitable intermediary path (routing through 501(c)(3)) was eliminated per board directive 2026-02-26. Law 3 requires direct-to-individual distribution.*

### Securities Risk — The Data Dividend

The Data Dividend satisfies all four Howey test prongs if structured as profit sharing. **Structural fix:** Restructure as a data licensing fee with a published rate schedule based on contribution volume and quality — not enterprise profitability. Users are service providers, not investors. If analysis concludes it IS a security: register under Regulation A+ (up to $75M annually with SEC qualification).

### Creator Liability Mitigation

"Non-delegable obligations" (Article 3.6) are limited to: dead-man's switch renewal, kill switch authority, annual tax filing oversight, distribution partner relationship. NOT operational decisions, NOT communication approval. Tier 3-4 communications reviewed by retained professional services firm (not creator). LLC capitalized at $30,000-40,000+ to reduce veil-piercing risk.

---
