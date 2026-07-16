## 6. Tool Integrity Layer

### The Problem

The tool supply chain is the primary attack vector in agent systems (see §0 P1 for OpenClaw threat data). The Tool Integrity Layer ensures no tool can be invoked unless registered, hash-verified, and sandboxed.

### Architecture

```
+---------------------------------------------------------------+
|                   TOOL INTEGRITY LAYER                        |
|                                                                |
|  Tool Registry (MCP-compatible — v0.5)                         |
|    - Every tool is stored as a content-addressed artifact:     |
|      the SHA-256 hash IS the lookup key (not hash-then-load,   |
|      but load-BY-hash — eliminates TOCTOU race conditions)     |
|    - Tool declaration follows MCP protocol (tool schemas,      |
|      capability negotiation, standardized invocation)          |
|    - Tools are registered by the board or by an authorized     |
|      agent with board approval                                 |
|    - Registration includes: hash, description, input schema,   |
|      output schema, required permissions, risk classification  |
|    - No tool may be invoked unless it exists in the registry   |
|      AND it is loaded by its content-addressed hash             |
|    - Config pipeline integrity: every agent config change is   |
|      signed by the board's cryptographic key and verified by   |
|      the orchestration layer before loading (prevents          |
|      ClawHavoc-style memory file attacks)                      |
|                                                                |
|  Sandboxed Execution                                           |
|    - All tool invocations run in an isolated environment       |
|      (container or process sandbox)                            |
|    - Tool process has no access to agent credentials,          |
|      other agent contexts, or the orchestration layer          |
|    - Network access: denied by default. Whitelisted per-tool   |
|      if the tool requires external data (e.g., web search)     |
|    - Filesystem access: scoped to a temporary directory.       |
|      No access to agent state, config, or other tool outputs   |
|                                                                |
|  Behavioral Monitoring                                         |
|    - Tool output is validated against the registered output    |
|      schema before being returned to the agent                 |
|    - Output size limits enforced (prevent context flooding)    |
|    - Anomaly detection: if a tool that normally returns JSON   |
|      starts returning freeform text, flag for review           |
|    - All tool invocations logged: tool_hash, input_hash,       |
|      output_hash, execution_time, resource_usage               |
|                                                                |
|  CI/CD Execution Model                                         |
|    - When agents produce code that needs testing/deployment,   |
|      execution runs through GitHub Actions with the same       |
|      read-only-by-default posture as GitHub's own Agentic      |
|      Workflows (github/gh-aw). Write operations only through   |
|      sanitized safe-outputs. This extends P1 (deny by default) |
|      to the CI/CD layer — agents cannot push to protected      |
|      branches, modify workflow definitions, or access secrets   |
|      unless explicitly granted per-task.                        |
+---------------------------------------------------------------+
```

### Tool Classification

| Risk Class | Description | Registration | Execution |
|-----------|-------------|-------------|-----------|
| Internal | Reads from task graph, formats data | Board or Strategist approval | Sandboxed, no network |
| Computational | Runs calculations, transformations | Board approval | Sandboxed, no network, resource limits |
| External-Read | Fetches data from external sources | Board approval + security review | Sandboxed, whitelisted network, output sanitized |
| External-Write | Sends data to external systems | Board approval only | Sandboxed, whitelisted network, audited, rate-limited |

### Automated Tool Pre-Screening

At scale, the board becomes a bottleneck for tool registration (OpenClaw's malicious skill count grew from 341 to 824+ across 10,700+ skills). New tool registrations undergo automated static analysis before board review:

1. Sandboxed execution with synthetic inputs — tool must produce expected output format
2. Network traffic monitoring — flag any unexpected outbound connections
3. Output schema validation — verify output matches registered schema
4. Resource usage profiling — flag excessive CPU, memory, or disk usage
5. Results presented to board with pass/fail summary for final approval

This does not remove the board from the approval chain — it reduces the review burden by filtering obviously malicious or broken tools before a human sees them.

### Tool Acceptance Policy (Phase 1 deliverable)

Before any non-core tools are registered, the board co-authors a written tool acceptance policy defining approval criteria per risk class. This prevents the Treasure Data pattern — opening a tool contribution pipeline without defining what gets approved, leading to wasted effort and security risk.

The policy must define, at minimum:
- What qualifies a tool for each risk class (Internal / Computational / External-Read / External-Write)
- Which approval path each risk class follows (Strategist-only vs. board-required)
- What pre-screening results (see above) constitute automatic rejection
- What documentation is required at registration (description, schema, test cases, risk justification)
- How tool deregistration works (who can revoke, under what conditions)

This is a Phase 1 deliverable. No non-core tools may be registered until the policy is approved by the board.

### Dependency Management Policy

- **30-day lag-behind** for non-security npm package updates. New versions are not ingested into the vendor cache (§18) until 30 days after publication. This protects against supply chain attacks targeting new releases.
- **Zero lag for security patches.** Patches addressing known CVEs bypass the lag — a 30-day delay on a known vulnerability is worse than supply chain risk.
- **CVE awareness pipeline:** OSV.dev as primary structured feed (covers NVD + GitHub Advisory DB). Daily polling. Auto-create task in task graph for any CVE affecting a dependency. Auto-patch policy: reachability + exposure based — LOW auto-patched, DB drivers never auto-patched, CRITICAL auto-mitigated (circuit-break, not auto-patch). See §18 for full pipeline architecture and decisions/003-cve-auto-patch-policy.md for rationale.
