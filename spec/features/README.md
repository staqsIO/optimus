# Feature Specs

Per-feature specifications written via the `/feature-spec` skill. Each spec captures **what** a feature does and **why** — before anyone decides how to build it.

## Filename convention

`NNN-<kebab-case-slug>.md` — zero-padded 3-digit ID, monotonic, slug ≤ 40 chars.

## When to write one

| Situation | Action |
|---|---|
| Multi-issue feature without acceptance criteria | Write a feature spec |
| Non-trivial scope, vague "done" | Write a feature spec |
| Architectural decision (new service, schema, framework) | Write an ADR in `spec/decisions/` instead |
| One-line fix, bug, or already-clear ticket | Skip — go straight to Linear / `/gsd` |

## Relationship to other artifacts

See the "Feature Specs" section in the repo-root `CLAUDE.md` for the full artifact hierarchy.

## How to write one

Invoke `/feature-spec` and the skill will:
1. Pick the next NNN
2. Elicit any missing user stories / scope / acceptance criteria
3. Write `NNN-<slug>.md` from the template
4. Run the self-review checklist at the bottom of the template
5. Suggest the next handoff step (Plan, Linear, `/gsd`)
