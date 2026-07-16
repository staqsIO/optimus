# CLAUDE.md

Instructions for Claude Code agents working in this repository.

## Repository Purpose

This is a collaborative architecture specification for Optimus (governed agent organization) and AutoBot (autonomous constitutional agent organization). It is NOT a code repository — it is a design document repository.

## Two Collaborators

- **Eric** (Formul8 / Staqs.io) — focuses on infrastructure enforcement, buildability, data governance (Pentland framework)
- **Dustin** — focuses on governance design, constitutional architecture, the Three Laws, autonomy vision

## Key Files

- `SPEC.md` — the current canonical specification. This is the single source of truth.
- `CHANGELOG.md` — version history with semantic versioning.
- `conversation/` — chronological thread of proposals and responses (001-NNN).
- `decisions/` — Architecture Decision Records capturing why specific choices were made.
- `open-questions/` — tracked questions that need resolution.
- `reviews/` — outputs from agent reviews (Liotta, Linus, DBA, Compliance, etc.).

## Workflow

When asked to work on this spec:

1. **Read `SPEC.md` first** — understand the current canonical state before proposing changes.
2. **Read recent `conversation/` entries** — understand the context and evolution.
3. **Check `open-questions/`** — see what's unresolved before adding more.
4. **Propose changes as diffs to `SPEC.md`** — not as new documents.
5. **If creating a new conversation entry**, name it `NNN-author-description.md` where NNN is the next number.
6. **If making a decision**, create an ADR in `decisions/` following the format of existing ADRs.
7. **Update `CHANGELOG.md`** when `SPEC.md` changes.

## Conventions

- Semantic versioning: `MAJOR.MINOR.PATCH` for the spec
- MAJOR = fundamental architectural change
- MINOR = new section, significant revision, new constitutional article
- PATCH = clarification, typo, formatting
- All markdown files use standard GitHub-flavored markdown
- No emojis in spec documents
- Agent review outputs go in `reviews/` with the format `YYYY-MM-DD-agent-topic.md`

## Design Principles (from the spec)

These govern all architectural decisions:

1. **Deny by default** — no agent has any capability unless explicitly granted
2. **Infrastructure enforces; prompts advise** — constitutional rules enforced by DB roles, JWT scoping, credential isolation
3. **Transparency by structure** — every state transition logged automatically
4. **Boring infrastructure** — Postgres, SQL, hash chains, JWT. No novel infrastructure.
5. **Measure before you trust** — capability gates, not calendar gates
6. **Familiar interfaces for humans** — system adapts to humans, not vice versa

## What NOT to Do

- Do not create implementation code in this repo — this is spec only
- Do not modify `conversation/` files after they're committed — they are historical record
- Do not merge to main without the other collaborator's review
- Do not add files outside the established directory structure without updating README.md

## Documentation Agents (Scribe & Herald)

Spec-specific additions to the root CLAUDE.md guidance:

### Scribe

- `SPEC.md` is the single source of truth. Scribe updates to the spec must be proposed as diffs, not new documents.
- `CHANGELOG.md` must be updated whenever `SPEC.md` changes (semantic versioning rules in Conventions above).
- Architecture decisions go in `decisions/` using the ADR format (see existing entries for template). Number sequentially from the last entry.
- When an open question in `open-questions/` is resolved, move it to a "Resolved" section within the same file or note the resolution. Do not delete resolved questions.
- `conversation/` entries are immutable after commit — Scribe never modifies them.

### Herald

- Herald's scope for spec changes is limited to `autobot-inbox/docs/external/` — the implementation changelog and product docs.
- When the spec version bumps, Herald should note the spec version alignment in the implementation changelog entry (e.g., "Aligns with spec v0.7.0").
