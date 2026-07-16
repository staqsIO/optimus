## 21. Changelog

Full version history is maintained in `CHANGELOG.md`. See that file for detailed entries for all versions from v0.1.0 through v1.0.0.

### v1.0.0 (2026-03-10)

Board decision review. 11 decisions (D1-D11) resolved from consolidated conversation audit. See `SPEC-v1.0-DECISIONS.md`.

- **D1 (MAJOR):** Removed specific dollar amounts from §15 Operating Cost Model. Spec now mandates the cost enforcement mechanism (G1 budget gate, per-invocation token logging, per-tier allocation) without embedding pricing that goes stale. Actual budget numbers are operational config.
- **D2 (verified):** Guard check atomicity (§5) — already correct in spec since v0.5. No change needed.
- **D3 (verified):** Kill switch fail-closed (§9) — already correct in spec. No change needed.
- **D4 (MINOR):** Content sanitization specification (§5) — replaced inline pattern categories, rule set versioning, and testing methodology with implementation-defined ADR reference. Spec mandates the requirement (infrastructure-enforced, versioned, tested, audited); implementation details evolve via ADR.
- **D7 (MINOR):** Added Behavioral Contracts subsection to §2 Agent Tiers. Each agent must declare measurable success criteria, expected outputs, and interaction norms. Schema is implementation-defined.
- **D5, D6, D9, D10:** Ruled out of spec scope — product-level concerns for autobot-inbox.
- **D8:** Spec freeze lifted. v1.0.0 released.
- **D11:** ADR-002 (individual install) unchanged — revisit trigger at 3+ users remains.
