# 015 — Governance Framework Extraction: Scoping Document

**Author:** Eric
**Date:** 2026-03-08
**Context:** Alex Mach review + Liotta architectural analysis
**Status:** Board review required before any extraction work

---

## Thesis

The Optimus governance layer — the `agent_graph` schema + runtime primitives — is the monetizable IP. Not the inbox tooling. Alex identified this during live review; Liotta's analysis confirms the architecture already supports clean extraction.

**What we'd ship:** `@optimus/governance` — an open-source reference implementation of governed agent organizations. Postgres-backed task graph, constitutional gates, graduated escalation, unified permissions, append-only audit trails.

**Business model:** Open-source the framework (marketing + de-risks sales). Sell consulting: "We design your agent organization spec, configure governance for your domain." Unit economics: $15-25K per engagement (2-3 weeks).

---

## What's Portable Today (Zero Refactoring)

### Runtime Core: 1,663 LOC across 8 files

| File | LOC | What It Does |
|------|-----|-------------|
| `state-machine.js` | 230 | Work item lifecycle, hash-chained state transitions, HMAC agent identity |
| `agent-loop.js` | 428 | Generic claim-execute-transition loop, LLM invocation tracking, retry logic |
| `event-bus.js` | 222 | Dual-mode dispatch (in-process + pg_notify), halt signals |
| `permissions.js` | 90 | Unified permission grants (ADR-017), tool invocation audit |
| `sanitizer.js` | 439 | Injection defense, PII detection, versioned rule sets |
| `escalation-manager.js` | 121 | 5-level graduated threat tracking, hash-chained threat memory |
| `infrastructure.js` | 149 | Public event logging, cross-schema reconciliation, tool registry verification |
| `reaper.js` | 154 | Task timeout recovery, orphaned budget reclamation |

**External dependencies:** `pg`, `@anthropic-ai/sdk`, `crypto` (stdlib). Nothing exotic (P4).

### Schema Core: `agent_graph` (49 tables)

The entire `agent_graph` schema is domain-agnostic. No cross-schema foreign keys (by design — SPEC §12). Tables cover:

- **Task graph:** work_items, edges, state_transitions, task_events
- **Agent control:** agent_configs, agent_assignment_rules
- **Resource governance:** budgets, tool_invocations, permission_grants, tool_registry
- **Safety:** threat_memory, escalation_levels, sanitization_rule_sets, constitutional_evaluations
- **Audit:** llm_invocations, prompt_drift_log, suggest_mode_log, board_interventions
- **Coordination:** halt_signals, deploy_events

**Schema DDL:** ~500 LOC of SQL, extractable from `sql/002-schemas-and-tables.sql` + subsequent migrations.

---

## What Needs Extraction Work (~6h total)

### 1. `guard-check.js` — Split core from product gates (3h)

**Portable (80%):** `guardCheck()` — budget, halt, config hash, assignment validation, delegation depth, constitutional evaluation, escalation check. Pure governance, zero product references.

**Product-specific (20%):** `checkDraftGates()` — G2 (commitment scan), G3 (voice tone matching via `voice.sent_emails`), G5 (reply-all detection), G6 (rate limiting via `action_proposals`), G7 (precedent scan). Email-centric.

**Extraction plan:**
- Move `guardCheck()` to `@optimus/governance/guard-check.js` (unchanged)
- Move `checkDraftGates()` to product layer as a pluggable "action gate" callback
- Pattern: `guardCheck()` calls optional `actionGates(draft, config)` if provided

### 2. `context-loader.js` — Extract tier system from email enrichment (3h)

**Portable (60%):** Tier system (Q1-Q4 context budgets per agent), sanitization integration, PII detection.

**Product-specific (40%):** Email metadata fetching, adapter-based body retrieval, signal/contact/voice profile enrichment.

**Extraction plan:**
- `@optimus/governance/context-loader.js` — tier orchestrator, calls pluggable `enrichContext(tier, workItem)` callback
- Product layer implements `enrichContext()` with email/signal/voice logic
- Config-driven tier mapping stays in core

---

## What's NOT Portable (and shouldn't be)

| Component | Why It Stays in Product |
|-----------|----------------------|
| `src/agents/*.js` | Agent handlers are domain-specific (triage email, draft replies, create tickets) |
| `src/adapters/*.js` | Channel I/O is product-specific (Gmail, Slack, Telegram adapters) |
| `src/gmail/`, `src/slack/`, `src/drive/` | Provider integrations |
| `src/voice/` | Voice learning system — email sender corpus analysis |
| `src/signal/` | Signal extraction from email content |
| `inbox`, `voice`, `signal`, `content` schemas | Product data models |
| `config/gates.json` | Gate parameters are domain-specific (commitment patterns, tone thresholds) |

---

## Package Structure (Proposed)

```
@optimus/governance/
├── runtime/
│   ├── state-machine.js     # Task graph lifecycle
│   ├── agent-loop.js        # Generic agent event loop
│   ├── event-bus.js          # Postgres-backed coordination
│   ├── guard-check.js        # Core guardrail enforcement
│   ├── permissions.js        # Unified permission model
│   ├── sanitizer.js          # Input sanitization + PII
│   ├── escalation-manager.js # Graduated threat response
│   ├── infrastructure.js     # Audit + reconciliation
│   └── reaper.js             # Task timeout recovery
├── sql/
│   └── agent_graph.sql       # Schema DDL (single file, idempotent)
├── config/
│   └── schema.json           # Tier definitions, escalation thresholds
└── index.js                  # Public API surface
```

**Extension points (callbacks/hooks):**
- `onContextEnrich(tier, workItem)` — product-specific context assembly
- `onActionGateCheck(draft, config)` — product-specific draft/action gates
- `onAgentHandler(task, context, agent)` — the actual agent logic
- `onPublicEvent(event)` — custom event routing

---

## Consulting Engagement Template

Based on the extractable framework, a consulting engagement looks like:

1. **Discovery (2-3 days):** Map client's agent organization — roles, tiers, capabilities, constraints
2. **Spec authoring (3-5 days):** Produce a filled SPEC.md with their domain model, constitutional gates, escalation policies, budget controls
3. **Configuration (2-3 days):** Set up `agent_graph` schema, configure agents.json, define permission grants, write custom gate checks
4. **Handoff (1-2 days):** Documentation, training, first agent pipeline running

**Deliverables:** Customized SPEC.md, configured governance schema, working agent pipeline with 2-3 agents, runbook.

**Price point:** $15-25K depending on complexity. Recurring: $3-5K/month for governance monitoring + optimization.

---

## Risks & Considerations

1. **Open-sourcing timing:** Too early = gives away methodology before we have consulting pipeline. Too late = someone else builds the commodity version. Recommendation: open-source after first paid engagement validates the model.

2. **Spec as IP:** The SPEC.md template (fillable guided sections) is the real differentiator. The code is the reference implementation. Don't open-source the template — that's the consulting deliverable.

3. **Entity resolution dependency:** Context-loader extraction doesn't require entity resolution (#56). Single `from_address` matching handles 80%+ of cases. Don't block on this.

4. **Naming:** `@optimus/governance` vs `@autobot/governance` vs something neutral. Board decision — affects brand positioning.

---

## Immediate Next Steps (Not Extraction — Just Clarity)

- [ ] Board reviews this document
- [ ] Validate price point with Nova Farms Tuesday call
- [ ] Validate framework applicability with a recruiting agency engagement
- [ ] If both validate: create GitHub issue for extraction work (est. 8-12h total)
- [ ] Decide: open-source before or after first paid engagement?

---

## Key Quote

> "The runtime is boring (and should be open-sourced as marketing). The value is in the customization." — Liotta
