## 20. What This Document Does Not Cover

The following are addressed in companion documents or deferred to later versions:

- **Full AutoBot constitutional text** — see v3 response document
- **Data Cooperative legal structure** — deferred to Phase 3 legal counsel
- **Pentland framework deep analysis** — see `autobot-pentland-data-commons-framework.md`
- **Social physics observability metrics** — defined in v3, tracked from Phase 2
- **Research questions (RQ-01 through RQ-26)** — see `research-questions/REGISTRY.md` for full registry with phase assignments, gate mappings, and measurement plans
- **Specific product strategy** — the Strategy Evaluation Protocol (§19) defines how strategic decisions are made; specific product choices remain empirical, determined by the protocol's signal gathering and perspective evaluation
- **Detailed Postgres DDL** — deferred to implementation phase; schema described structurally in this document
- **A2A protocol integration** — Google's Agent-to-Agent protocol is v0.3 as of July 2025; evaluate when mature. MCP adopted for tool declaration protocol (see §6). Gong's Feb 2026 production MCP deployment signals faster adoption than expected — MCP interoperability evaluation should occur in Phase 2, specifically when Optimus builds products that must integrate with enterprise customer systems. A2A remains deferred until semantic-layer protocols mature beyond syntactic message passing.
- **Mesh vs. hierarchy architectural rationale (deferred):** Document why hierarchical orchestration is required for governed/constitutional agent organizations — the constitutional governance requirement demands explicit, auditable task decomposition and approval chains that mesh architectures cannot structurally enforce.
- **Vendor independence strategy (deferred):** Document why Optimus uses open infrastructure (Postgres, JWT, SQL, standard APIs) and define migration strategies if any model provider deprecates or restricts API access. The spec's tier-specific model assignments (§2) already enable multi-vendor operation.
- **Multi-tenant agent identity model (deferred to Phase 4+):** If Optimus/AutoBot products serve enterprise customers deploying their own agent workforces, a scalable identity model beyond the current single-organization JWT scheme will be required.
- **DMS / KV cache compression for local executors (deferred to Phase 2-3):** NVIDIA's Dynamic Memory Sparsification achieves 5-8x KV cache compression. Evaluate for Ollama executor tier once Phase 1 is stable.
- **Fine-tuning on task patterns (deferred to Phase 4+):** Not appropriate for Phase 1-3 (P4: boring infrastructure), but evaluate once Optimus has sufficient task history to train on.
- **GitHub Agent HQ governance integration (deferred to Phase 3-4):** When Optimus becomes a product serving enterprise customers, they will expect it to integrate with Agent HQ as a control plane for agent authorization and monitoring. Evaluate alongside the multi-tenant identity model.
- **ADR-driven specification formalization:** The `strategic_decisions` table (§19) is functionally an ADR system. Consider formalizing it as an explicit ADR format compatible with industry-standard tooling, and extending the pattern to architectural decisions.
- **ComposioHQ agent-orchestrator as reference implementation (evaluate for Phase 1):** Agent-agnostic, runtime-agnostic orchestration CLI. Evaluate whether studying this tool can accelerate Phase 1 agent lifecycle management. Key capabilities: git worktree management per agent, automated CI failure → agent fix loops, web dashboard.
- **Reinforcement learning for agent sequencing (deferred to Phase 4+):** ChatDev v2.0 uses RL to optimize agent sequencing. Not appropriate until Optimus has substantial task history, but the `state_transitions` audit log already captures the training data.
