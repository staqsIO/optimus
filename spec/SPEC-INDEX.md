# SPEC Quick Reference Index

> Navigate the monolithic SPEC.md by topic. Each section links to the line number in SPEC.md.
> Future: split into separate module files per the reorientation plan.

## Core (Rigid — changes need board review)

| Section | Lines | Topic |
|---------|-------|-------|
| §0 | 18-35 | Design Principles (P1-P6) |
| §1 | 36-47 | The Core Idea |
| §2 | 48-148 | Architecture Overview (tiers, capabilities) |
| §3 | 149-297 | Task Graph (work items, edges, state machine) |
| §5 | 535-641 | Guardrail Enforcement (G1-G7, guard-check) |
| §13 | 1272-1306 | AutoBot Constitution |
| §17 | 1566-1610 | Legal Compliance |

## Operations (Iterates fast — board-approved changes OK)

| Section | Lines | Topic |
|---------|-------|-------|
| §4 | 298-534 | Agent Runtime (tiers, models, loops) |
| §5a | 642-733 | Knowledge Graph Layer (Neo4j) |
| §6 | 734-835 | Tool Integrity Layer (sandboxing, registry) |
| §7 | 836-892 | Communication Gateway (adapters, channels) |
| §8 | 893-1088 | Audit and Observability |
| §9 | 1089-1119 | Kill Switch |
| §10 | 1120-1162 | Cost Tracking |
| §11 | 1163-1213 | Failure Modes |
| §12 | 1214-1271 | Database Architecture |

## Planning (Iterates fast)

| Section | Lines | Topic |
|---------|-------|-------|
| §14 | 1307-1532 | Phased Execution Plan |
| §15 | 1533-1550 | Operating Cost Model |
| §16 | 1551-1565 | Open Questions Resolved |
| §18 | 1611-1737 | Autonomous Software Composition |
| §19 | 1738-1918 | Strategy Evaluation Protocol |

## Missing (Proposed in reorientation plan)

- **Board Experience** — How board members interact day-to-day. Morning routine, async notifications, weekly reviews.
- **Channel Architecture** — Email, Linear, Slack, Telegram, webhook intake patterns. What works, what doesn't.
- **Autonomy Operating Model** — When to use L0 vs L1 vs L2. Current defaults. Promotion criteria that actually work.
- **Multi-User Governance** — Individual identity on actions, domain delegation, shared activity feed.
