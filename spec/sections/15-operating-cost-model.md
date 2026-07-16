---
title: "Operating Cost Model"
section: 15
tier: planning
description: "Monthly operating cost breakdown by agent tier and infrastructure"
---
## 15. Operating Cost Model

This section defines the cost enforcement mechanism. Specific dollar amounts, token pricing, and budget allocations are operational configuration maintained outside the spec — model pricing changes frequently and embedding it here guarantees drift.

### Cost Enforcement Requirements

1. **Per-invocation logging (P3):** Every LLM invocation logs model, input tokens, output tokens, and computed cost to `llm_invocations`. This is non-optional — it is a side effect of the runtime loop (§4), not a feature an agent chooses to provide.

2. **Budget pre-authorization (G1):** The guardCheck() gate (§5) verifies budget availability before every invocation. If the estimated cost would exceed the allocation, the transaction rolls back. Budget enforcement is atomic with state transition — see §5.

3. **Token accounting completeness:** Cost calculations must include input tokens, output tokens (priced separately), retry overhead, and context compaction costs. Omitting any category understates actual spend.

4. **Per-tier budget allocation:** Budget ceilings are defined per agent tier, per product. The board sets allocations via operational config. The spec mandates that allocations exist and are enforced, not what they are.

5. **Cost reporting:** A utility agent produces daily cost digests to the board via preferred channels, broken down by tier and product. The board must be able to answer "what did we spend today and on what?" without querying the database.

---
