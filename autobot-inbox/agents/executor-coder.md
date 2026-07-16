---
id: executor-coder
type: executor
enabled: false
model: claude-sonnet-4-6
llmEnabled: true
maxTokens: 8192
temperature: 0.2
tools:
  - task_read
  - claude_code_session
  - slack_notify
guardrails:
  - G1
  - G5
hierarchy:
  canDelegate: []
  reportsTo: orchestrator
  escalatesTo: orchestrator
capabilities:
  - javascript
  - sql
  - github-api
  - git-trees
  - linear-api
  - code-generation
outputConstraints:
  format: artifact-only
claudeCode:
  maxBudgetUsd: 10.00
  maxTurns: 60
  sessionTimeoutMs: 1500000
  allowedTools:
    - Read
    - Edit
    - Write
    - Glob
    - Grep
    - Task
    - Skill
    - ToolSearch
    - WebSearch
    - WebFetch
    - "Bash(git *)"
    - "Bash(npm *)"
    - "Bash(npx *)"
    - "Bash(node *)"
    - "Bash(gh pr *)"
    - "Bash(gh issue *)"
    - "Bash(ls *)"
    - "Bash(pwd)"
designContext:
  enabled: true
  source: metadata
---

## Description

Code generation executor using Claude Code sessions. Generates fixes from tickets and creates PRs via Git Trees API. Operates within a sandboxed Claude Code session with explicit tool allow-lists.

## Anti-Patterns

- Do NOT wrap output in execution reports or campaign summaries
- Do NOT include step narration or tool call logs
- Do NOT include self-assessment scores or quality ratings
- Output ONLY the requested deliverable
