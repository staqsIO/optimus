# Hermes Agent Integration: Architectural Assessment for Optimus

**Date:** 2026-04-11
**Requested by:** Eric Gang
**Assessment type:** Semantic architectural analysis

---

## 1. Layer Mapping: Hermes Five Layers vs. Optimus Existing Architecture

| Hermes Layer | Optimus Equivalent | Coverage | Gap Analysis |
|---|---|---|---|
| **Skill Layer** (self-evolving MCP-compatible tools) | `lib/runtime/tool-registry.js` (FlowToolRegistry) + `lib/runtime/tool-executor.js` | **Partial.** Optimus has tool dispatch with function/agent/hybrid modes and pre/post hooks enforcing permissions (P2). But tools are statically registered — no self-evolution, no auto-generation, no skill improvement over time. | **Major gap:** Optimus tools don't learn. A failing tool stays failing until a human edits the code. Hermes' auto-generation would mean an agent that encounters a missing capability can propose (and with approval, create) a new tool. |
| **Memory Layer** (session / persistent / skill-level + Honcho user modeling) | `lib/runtime/agent-memory.js` (4 types: pattern, preference, context, failure) + `consolidateMemory()` | **Solid foundation, missing depth.** Optimus has DB-backed append-only memory with hash-chaining (P3), deduplication, consolidation via LLM, and Markdown export. But it's single-tier (persistent only) — no session-scoped memory, no skill-level memory, no user modeling. | **Medium gap:** Session memory is implicit (the LLM context window). Skill-level memory doesn't exist because skills are static. User modeling (Honcho) has no equivalent — Optimus' `voice/` system learns communication style but not user behavioral models. |
| **Feedback Layer** (auto-retrospective after each task) | `lib/runtime/self-improve-scanner.js` (weekly scan) + `agent-memory.js` `saveMemory({ type: 'failure' })` | **Weakest area.** Optimus captures failures passively — agents can call `saveMemory()` but nothing forces them to. `self-improve-scanner` runs weekly with 3 checks (failures, budget, stale config) plus exploration domains. No per-task retrospective, no automatic performance evaluation, no adjustment loop. | **Critical gap.** This is the biggest delta. Hermes runs a self-evaluation after EVERY task and adjusts behavior. Optimus only reflects weekly and only at the infrastructure level, not the agent level. |
| **Constraint Layer** (tool permissions + sandbox + on-demand toolsets) | `lib/runtime/guard-check.js` (G1-G10) + `lib/runtime/permissions.js` + `lib/runtime/hooks.js` (pre/post hooks) + `lib/runtime/capability-gates.js` | **Strongest area — likely superior to Hermes.** Optimus has atomic Postgres-transactional guard checks, constitutional gates enforced at the DB layer (not prompts — P2), pre-hook permission checks on every tool invocation, budget pre-authorization (G1), prompt injection screening (G6), rate limiting (G7), and the `auto-classifier.js` (G9) for autonomy level enforcement. This is deeper than what Hermes describes. | **No gap.** Optimus' constraint layer is more rigorous than Hermes' sandbox-based approach. Hermes uses runtime sandboxing; Optimus uses database-enforced constraints with hash-chained audit trails. This is a clear Optimus advantage. |
| **Orchestration Layer** (multi-agent pipeline + cron + sub-agent delegation) | `lib/runtime/agent-loop.js` (claim-execute-transition) + `lib/runtime/state-machine.js` + `agents/claw-campaigner/` + `agents/claw-workshop/` + `lib/runtime/executor-adapter.js` | **Comparable, different model.** Optimus uses a Postgres task graph where agents claim work items via atomic state transitions — no direct agent-to-agent communication. Hermes uses direct sub-agent delegation. Optimus has cron via `self-improve-scanner` and campaign scheduling. The Claw system (campaigner + workshop) handles multi-step autonomous work. | **Small gap:** Optimus lacks native sub-agent delegation within a single execution context. Agents coordinate through the task graph (async), not through direct invocation (sync). This is a deliberate design choice (P4: boring infrastructure) but limits real-time multi-agent collaboration. |

### Summary Scorecard

| Layer | Optimus Maturity | Hermes Would Add |
|---|---|---|
| Skill | 40% | Self-evolving tools, auto-generation |
| Memory | 60% | Session + skill-level memory, user modeling |
| Feedback | 20% | Per-task retrospective, auto-adjustment |
| Constraint | 95% | Nothing — Optimus is stronger |
| Orchestration | 75% | Synchronous sub-agent delegation |

---

## 2. Integration Surface: Fourth Driver vs. Deeper Replacement

### Option A: Hermes as a Fourth Driver (`hermes` driver in executor-adapter.js)

The `executor-adapter.js` pattern is perfectly suited for this. The current architecture:

```
DRIVER_MAP = {
  cli:     () => import('./drivers/cli-driver.js'),      // Claude Code CLI
  managed: () => import('./drivers/managed-driver.js'),   // In-process LLM
  api:     () => import('./drivers/api-driver.js'),       // HTTP API calls
  hermes:  () => import('./drivers/hermes-driver.js'),    // NEW
}
```

Each driver exports `run(options)` returning `{ costUsd, numTurns, durationMs, result, isError, error }`. A Hermes driver would:
1. Translate Optimus work item context into a Hermes task
2. Invoke Hermes' orchestration layer
3. Collect results + cost metrics
4. Return in the normalized shape

**This is the right first step.** It's non-disruptive, reversible, and lets you A/B test Hermes-backed executors against CLI-backed ones using the existing `executor_driver` field in `agents.json`.

### Option B: Hermes Replacing the Agent Loop

This would mean replacing `agent-loop.js` (the claim-execute-transition cycle) with Hermes' orchestration layer. **This is premature and risky:**

- Optimus' agent loop is tightly coupled to Postgres state machine semantics (`claimAndStart`, `transitionState`, `guardCheck` — all atomic transactions)
- Hermes' orchestration assumes it owns the execution lifecycle; Optimus' task graph owns it
- You'd lose P2 enforcement (infrastructure enforces) because Hermes' constraint layer operates at runtime, not at the database level
- The hash-chained audit trail (P3) depends on `state_transitions` being written by the agent loop

### Recommendation: **Option A (fourth driver), with a migration path**

Start with `hermes` as a driver for Executor-tier agents only. The Executor tier is the natural fit because:
- Executors are stateless task processors (no long-running state)
- They already run via `runExecutor()` which normalizes the output shape
- Their `can_assign_to` constraints are enforced by the Orchestrator tier above them, not by the executor itself

Over time, if Hermes proves reliable, you could promote it to handle Orchestrator-tier agents (the Claw system), where its sub-agent delegation would replace the current campaign-loop.js orchestration.

---

## 3. Self-Improving Loop: Impact on Governance

This is the most consequential question. Hermes' auto-retrospective means agents modify their own behavior without explicit human approval. Here's how that intersects with Optimus:

### Current State

Optimus has three feedback mechanisms:
1. **`agent-memory.js`**: Passive. Agents _can_ save learnings but nothing requires it. No behavioral modification.
2. **`self-improve-scanner.js`**: Weekly. Infrastructure-level (not agent-level). Two-track routing: tactical changes auto-route, strategic changes need board approval.
3. **`consolidateMemory()`**: Compresses old memories via LLM. Runs during idle time. Doesn't change behavior.

### What Hermes' Feedback Loop Would Mean

Hermes runs a retrospective after every task:
- "Did I succeed?"
- "What could I have done better?"
- "What should I remember for next time?"

Then it _actually adjusts_ — updating skill parameters, memory weights, and approach strategies.

### Governance Tension

This directly conflicts with **P1 (deny by default)** and **P2 (infrastructure enforces)**:

| Hermes Behavior | Optimus Principle | Conflict Level |
|---|---|---|
| Agent auto-generates new skills | P1: Nothing permitted unless explicitly granted | **HIGH.** New skills = new capabilities. P1 says capabilities must be explicitly granted. |
| Agent adjusts its own approach | P2: Infrastructure enforces, prompts advise | **MEDIUM.** If "adjustments" are prompt-level (e.g., "next time, ask clarifying questions first"), that's fine — it's advisory. If adjustments modify tool parameters or execution paths, that's infrastructure change without gate check. |
| Agent self-evaluates performance | P3: Transparency by structure | **LOW.** Self-evaluation is additional transparency. Good alignment. |
| Agent updates memory weights | P5: Measure before you trust | **LOW.** Memory updates are data, not capability changes. Consistent with P5 if evaluation criteria are well-defined. |

### Proposed Governance Wrapper

Adopt Hermes' feedback loop BUT route all behavioral changes through Optimus' existing two-track system from `self-improve-scanner.js`:

```
After each task:
  1. Hermes runs auto-retrospective (unchanged)
  2. Retrospective produces "learnings" and "proposed adjustments"
  3. Learnings → saveMemory() (always allowed, P3 compliant)
  4. Proposed adjustments → classifyAction() from auto-classifier.js:
     - Tactical (prompt-level, memory-only) → auto-apply
     - Strategic (new skill, parameter change, execution path) → board approval queue
```

This preserves P1/P2 while getting 80% of the benefit. The "adjustments need approval" path aligns with the existing `agent_intents` table and the exploration system's two-track routing.

---

## 4. Skill Interoperability: agentskills.io Impact

### Current Optimus Tool Architecture

Optimus tools are registered via `FlowToolRegistry` with three dispatch modes:
- **function**: Direct function call (most current tools)
- **agent**: Delegate to another agent via task graph
- **hybrid**: Try function first, delegate to agent if confidence < threshold

Tools are defined in code, not as portable artifacts. There's no standard skill format.

### What agentskills.io Would Enable

If Optimus tools were packaged as agentskills.io-compatible skills:

1. **Cross-framework portability**: Skills developed in Claude Code sessions (which Eric already uses heavily) could be imported directly into Optimus agents. Currently, knowledge from Claude Code sessions is manual — Eric has to translate insights into code changes.

2. **Claw system leverage**: The `claw-workshop` agent spawns Claude Code CLI sessions to implement Linear issues. If those sessions produce agentskills.io skills as artifacts, the skills could be auto-registered in Optimus' tool registry.

3. **Community ecosystem**: Optimus agents could use community-contributed skills without custom integration code.

### Architectural Changes Required

| Change | Effort | Value |
|---|---|---|
| Skill manifest parser (agentskills.io JSON schema) | Small | Enables skill import |
| `FlowToolRegistry.registerFromManifest()` | Small | Auto-registration from skill packages |
| Skill sandbox (Hermes provides this) | Medium | Required for untrusted community skills |
| Skill versioning + hash verification | Medium | P2 compliance — tool integrity check |
| Skill auto-generation pipeline (Hermes feedback loop) | Large | The "self-evolving" piece |

### Recommendation

Adopt the agentskills.io manifest format for new Optimus tools. Retrofit existing tools gradually. This is low-risk, high-optionality — even without Hermes, having a standard skill format improves portability and testing.

---

## 5. Risk Assessment: Hermes Philosophy vs. Optimus Design Principles

### P1: Deny by Default — **HIGH RISK**

Hermes' core philosophy is "you set the rules, it learns the rules, then it gets better and better." The implicit assumption is that the agent's learning is _within_ the rules. But Optimus P1 says nothing is permitted unless explicitly granted.

**Specific risk**: Hermes' skill auto-generation creates new capabilities that were never explicitly granted. In Optimus, every tool invocation goes through the pre-hook permission check in `agent-loop.js`:

```javascript
registerPreHook('*', async (ctx) => {
  const allowed = await checkPermission(ctx.agentId, ctx.resourceType, ctx.resourceName);
  return allowed ? { allowed: true } : { allowed: false, reason: `Permission denied...` };
}, 'permission_check');
```

A self-generated skill would fail this check because no `permission_grant` exists for it. **This is actually a safety feature** — P1 catches exactly this case. The mitigation is that new skills require a permission grant before they can execute, which means board approval for any non-trivial new capability.

**Verdict**: P1 acts as a natural firewall. The risk is manageable IF Hermes skill generation routes through the permission system rather than bypassing it.

### P2: Infrastructure Enforces; Prompts Advise — **MEDIUM RISK**

Hermes' constraint layer operates at the runtime level (process sandboxing, tool permissions). Optimus enforces at the database level (Postgres transactions, RLS, schema constraints). These are different enforcement boundaries.

**Specific risk**: If Hermes is a driver (Option A), it operates _inside_ the executor — below the infrastructure enforcement layer. But Hermes has its own constraint layer that might conflict with or duplicate Optimus' guards.

**Mitigation**: The Hermes driver should strip Hermes' built-in constraint layer and rely on Optimus' guards. Hermes handles execution; Optimus handles governance. Clear boundary.

### P3: Transparency by Structure — **LOW RISK / ALIGNMENT**

Hermes' feedback loop generates structured retrospectives. This is _more_ transparency, not less. If retrospectives are stored in `agent_memories` (append-only, hash-chained), they enhance P3 compliance.

**Opportunity**: Hermes' per-task retrospectives could feed the `self-improve-scanner`'s exploration system, providing richer signal for the weekly scan.

### P4: Boring Infrastructure — **MEDIUM RISK**

Hermes is a framework. Optimus deliberately avoids frameworks ("No framework. No orchestration library. Just Postgres + an event loop" — comment in `agent-loop.js`). Adding Hermes as a dependency introduces framework risk: version coupling, API surface area, opinionated patterns that may conflict with Optimus conventions.

**Mitigation**: Use Hermes as a driver, not a framework. The driver boundary in `executor-adapter.js` isolates Hermes behind a thin interface. If Hermes breaks or goes in a different direction, you swap the driver. This is exactly what ADR-006's driver pattern was designed for.

### P5: Measure Before You Trust — **ALIGNMENT**

Hermes' feedback loop produces measurable performance data. This directly supports P5. You can set capability gates that require demonstrated performance (e.g., "this agent must complete 10 tasks with >80% success before gaining access to the `deploy` skill").

### P6: Familiar Interfaces for Humans — **LOW RISK**

Hermes operates below the human interface layer. Board Workstation and CLI remain unchanged. Hermes is invisible to board members — they see the same task graph, the same audit trail, the same governance dashboard.

---

## 6. Strategic Recommendation

### Phase 1: Hermes Driver (Low Risk, High Signal)

1. Implement `lib/runtime/drivers/hermes-driver.js` following the existing driver pattern
2. Configure 2-3 Executor-tier agents to use `"executor_driver": "hermes"` in `agents.json`
3. Run in parallel with CLI driver for the same task types — compare cost, quality, speed
4. Strip Hermes' built-in constraint layer; rely on Optimus guards

### Phase 2: Feedback Loop Adoption (Medium Risk, High Value)

1. Wrap Hermes' auto-retrospective to produce `saveMemory()` calls after each task
2. Route proposed behavioral adjustments through `classifyAction()` two-track system
3. Measure: do agents with Hermes feedback loop outperform agents without?

### Phase 3: Skill Ecosystem (Medium Risk, High Optionality)

1. Adopt agentskills.io manifest format for new Optimus tools
2. Build `registerFromManifest()` in `FlowToolRegistry`
3. Enable skill import from Claude Code sessions into Optimus runtime
4. Gate skill auto-generation behind board approval (P1 compliance)

### What NOT to Do

- Do NOT replace `agent-loop.js` with Hermes orchestration. The Postgres task graph is Optimus' core architectural advantage — it provides atomicity, auditability, and governance enforcement that Hermes' orchestration layer cannot match.
- Do NOT adopt Hermes' constraint layer. Optimus' DB-enforced gates (G1-G10) are stronger than runtime sandboxing.
- Do NOT enable ungated skill auto-generation. P1 requires explicit capability grants. Auto-generated skills must go through the permission system.

---

## Appendix: Component Reference

| Optimus Component | File | Relevance to Hermes |
|---|---|---|
| Agent Loop | `lib/runtime/agent-loop.js` | Keep as-is. Hermes operates inside drivers, not here. |
| Executor Adapter | `lib/runtime/executor-adapter.js` | Integration point. Add `hermes` to `DRIVER_MAP`. |
| Guard Check | `lib/runtime/guard-check.js` | Hermes driver must pass through guards before execution. |
| Agent Memory | `lib/runtime/agent-memory.js` | Receives Hermes retrospective output as memories. |
| Self-Improve Scanner | `lib/runtime/self-improve-scanner.js` | Hermes feedback enriches exploration system signal. |
| Tool Registry | `lib/runtime/tool-registry.js` | Add `registerFromManifest()` for agentskills.io import. |
| Auto-Classifier | `lib/runtime/auto-classifier.js` | Routes Hermes behavioral adjustments (tactical vs strategic). |
| Permission System | `lib/runtime/permissions.js` | Gates all Hermes-generated skills. P1 enforcement. |
| Hooks | `lib/runtime/hooks.js` | Pre/post hooks catch unauthorized Hermes skill invocations. |
| Claw Campaigner | `agents/claw-campaigner/` | Future candidate for Hermes orchestration (Phase 3+). |
