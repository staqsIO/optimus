# autobot-spec

Architecture specification for **Optimus** (governed agent organization) and **AutoBot** (autonomous constitutional agent organization).

## What This Is

A collaborative design document between Eric and Dustin, evolving through iterative proposals and reviews — each informed by our own agent orchestras (Claude Code, etc.).

## Repository Structure

```
autobot-spec/
├── README.md                    # You are here
├── CLAUDE.md                    # Instructions for Claude Code agents working in this repo
├── SPEC.md                      # Current canonical specification (latest agreed state)
├── CHANGELOG.md                 # Version history of the specification
├── conversation/                # Full conversation thread (chronological)
│   ├── 001-dustin-agent-org-v0.1.md
│   ├── 002-eric-initial-response.md
│   ├── ...
│   └── NNN-author-description.md
├── decisions/                   # Architecture Decision Records (ADRs)
│   └── 001-email-vs-task-graph.md
├── open-questions/              # Tracked questions awaiting resolution
│   └── README.md
├── research-questions/          # Research question registry (RQ-01 through RQ-26)
│   └── REGISTRY.md
└── reviews/                     # Agent review outputs (Liotta, Linus, DBA, etc.)
    └── README.md
```

## How We Work

1. **Read the latest state** — `SPEC.md` is the canonical document.
2. **Create a branch** for your proposal — `dustin/topic` or `eric/topic`.
3. **Use your agents** — run the spec through Claude Code, custom agents, whatever you have. Put agent review outputs in `reviews/`.
4. **Open a PR** — the PR description is your reasoning. The diff IS the proposal.
5. **The other person reviews** — runs it through their agents, leaves comments, approves or requests changes.
6. **Merge** — the canonical spec updates. `CHANGELOG.md` records what changed and why.

## Current Status

- **Spec version:** 0.5.2 DRAFT
- **Stage:** Architecture design (pre-implementation)
- **Optimus:** Defined — governed agent organization with human board
- **AutoBot:** Defined — autonomous constitutional agent organization (built on Optimus)
- **Build order:** Legal foundation → Optimus MVP → Shadow AutoBot → AutoBot Sandbox → AutoBot Production

## Key Documents

| Document | Purpose |
|----------|---------|
| `SPEC.md` | The current canonical architecture specification |
| `conversation/008-eric-response-to-v0.4.md` | Eric's 10-part review of v0.4 (rationale for v0.5 changes) |
| `conversation/007-dustin-v0.4-canonical.md` | Dustin's v0.4 spec |
| `conversation/005-eric-unified-v3.md` | Eric's unified v3 response with Pentland framework |
| `CHANGELOG.md` | What changed in each version |
