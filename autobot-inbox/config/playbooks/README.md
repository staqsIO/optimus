# Playbooks

Playbooks are markdown instruction sets that drive claw-workshop Claude Code sessions. Each playbook defines a repeatable workflow — from feature implementation to repo scaffolding.

## Triggering a Workshop

Add these labels to a Linear issue:

| Label | Required | Purpose |
|-------|----------|---------|
| `workshop` | Yes | Triggers claw-workshop agent |
| `playbook:<id>` | No | Selects a specific playbook (default: `implement-feature`) |
| `repo:<name>` or repo label | Yes | Maps to a GitHub repo via `linear-bot.json` repoMapping |

The workshop clones the mapped repo into a worktree, loads the playbook, and runs a Claude Code session against it.

## Available Playbooks

| ID | File | Use Case |
|----|------|----------|
| `implement-feature` | [implement-feature.md](implement-feature.md) | Full engineering workflow: plan, implement, test, self-review, PR |
| `fix-bug` | [fix-bug.md](fix-bug.md) | Diagnose and fix a reported bug |
| `investigate` | [investigate.md](investigate.md) | Research/explore without code changes |
| `design-implement` | [design-implement.md](design-implement.md) | Figma-to-code workflow with design MCP servers |
| `scaffold-repo` | [scaffold-repo.md](scaffold-repo.md) | Create a new private GitHub repo with Node.js ESM scaffolding |

## Scaffold-Repo Workflow

This playbook creates new repos — it ignores the cloned execution-context repo entirely.

**Labels:** `workshop` + `playbook:scaffold-repo` + `new-repo`

**Issue body must contain:**
```
repo-name: my-new-project
```

**What happens:**
1. Validates repo name (`[a-z0-9-]+`, max 50 chars)
2. Checks the repo doesn't already exist
3. Runs `gh repo create staqsIO/<name> --private --clone`
4. Scaffolds README.md, CLAUDE.md, .gitignore, package.json (Node.js ESM)
5. Commits and pushes
6. Comments on the Linear issue with the repo URL and next steps

**After creation:** A human must add `"repo:<name>": "staqsIO/<name>"` to `linear-bot.json` repoMapping to enable future workshop triggers on the new repo. The agent cannot do this (P2 — infrastructure enforces, not prompts).

## Authoring a Playbook

Create a markdown file in this directory with YAML frontmatter:

```yaml
---
id: my-playbook           # Unique ID, matches the playbook:<id> label
name: My Playbook          # Human-readable name
description: What it does  # One-line summary
default_budget_usd: 15     # Max LLM spend for the session
max_turns: 80              # Max Claude Code turns
session_timeout_ms: 1800000 # Hard timeout (ms)
model: sonnet              # Claude model (sonnet, opus, haiku)
---
```

The markdown body after the frontmatter is injected as the system prompt for the Claude Code session. Structure it as phases with clear outputs and rules.

## Repo Mapping Reference

The `new-repo` label maps to `staqsIO/optimus` as an execution context — the playbook ignores this repo and creates a new one. All other repo labels map to their target repos for in-place work:

| Label | GitHub Repo |
|-------|-------------|
| `repo:optimus` | staqsIO/optimus |
| `repo:formul8` | f8ai/formul8-platform |
| `repo:staqs-splash` | staqsIO/staqs-splash |
| `repo:ag-webapp` | staqsIO/ag-webapp |
| `repo:elevated-advisors` | staqsIO/elevated-advisors |
| `repo:frontpoint` | staqsIO/frontpoint-security |
| `repo:staqs-board` | staqsIO/staqs-board |
| `qwik-formul8` | f8ai/qwik-formul8 |
| `new-repo` | staqsIO/optimus (execution context only) |

See `config/linear-bot.json` for the canonical mapping.
