---
id: scaffold-repo
name: Scaffold Repository
description: Create a new private GitHub repo under staqsIO with Node.js ESM scaffolding
default_budget_usd: 2
max_turns: 20
session_timeout_ms: 300000
model: sonnet
extra_allowed_tools: Bash(gh repo *),Bash(cd *),Bash(mkdir *)
output_type: pr
---

You are creating a new GitHub repository. This playbook ignores the cloned execution-context repo — it creates a brand new one.

## Phase 1: Parse & Validate

1. Read the Linear issue body. Extract the `repo-name:` field value.
2. Validate the repo name:
   - Must match `[a-z0-9-]+` (lowercase alphanumeric and hyphens only)
   - Maximum 50 characters
   - Must not be empty
3. If `repo-name:` is missing or invalid, STOP and print an error message explaining the expected format:
   ```
   ERROR: Issue body must contain a `repo-name:` field with a valid name.
   Format: repo-name: my-project-name
   Rules: lowercase letters, numbers, hyphens only. Max 50 chars.
   ```

**Output:** Validated repo name stored for next phases.

## Phase 2: Check Existence

1. Run: `gh repo view staqsIO/<repo-name>`
2. If the repo already exists, STOP and print:
   ```
   ERROR: Repository staqsIO/<repo-name> already exists.
   ```

**Output:** Confirmation that the repo does not exist.

## Phase 3: Create Repository

1. Run: `gh repo create staqsIO/<repo-name> --private --clone`
2. `cd` into the cloned directory.

**Output:** Empty private repo cloned locally.

## Phase 4: Scaffold Files

Create these files in the new repo directory:

### README.md
```markdown
# <repo-name>

<issue-title from the Linear issue>
```

### CLAUDE.md
```markdown
# CLAUDE.md — <repo-name>

## Overview

<issue-title from the Linear issue>

## Commands

\`\`\`bash
npm install        # Install dependencies
npm start          # Start the application
npm test           # Run tests
\`\`\`

## Conventions

- ES modules (`"type": "module"`)
- Node >= 20.0.0
- Package manager: npm
```

### .gitignore
```
node_modules/
.env
.env.*
dist/
coverage/
.DS_Store
*.log
```

### package.json
```json
{
  "name": "<repo-name>",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": {
    "start": "node src/index.js",
    "test": "echo \"No tests yet\" && exit 0"
  },
  "engines": {
    "node": ">=20.0.0"
  }
}
```

**Output:** Four files created in the repo directory.

## Phase 5: Commit & Push

1. `git add README.md CLAUDE.md .gitignore package.json`
2. `git commit -m "chore: initial scaffold"`
3. `git push -u origin main`

**Output:** Initial commit pushed to remote.

## Phase 6: Report

Print the result to stdout:
```
Repo created: staqsIO/<repo-name>
URL: https://github.com/staqsIO/<repo-name>

Next step: Add `"repo:<repo-name>": "staqsIO/<repo-name>"` to `linear-bot.json` repoMapping to enable future workshop triggers.
```

## Rules

- ALWAYS create repos as `--private`. Never create public repos.
- Never modify `linear-bot.json` or any config files — that is a human-only action (P2).
- Never create repos outside the `staqsIO` organization.
- If any step fails, STOP and report the error. Do not retry repo creation.
- Do not install dependencies or run npm install — just scaffold the files.
