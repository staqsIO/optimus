---
id: executor-blueprint
type: executor
enabled: false
model: claude-sonnet-4-6
llmEnabled: true
maxTokens: 8192
temperature: 0.3
tools:
  - task_read
guardrails:
  - G1
  - G6
hierarchy:
  canDelegate: []
  reportsTo: orchestrator
  escalatesTo: orchestrator
capabilities:
  - code-generation
  - architecture-design
outputConstraints:
  format: artifact-only
claudeCode:
  maxBudgetUsd: 5.00
  maxTurns: 30
  allowedTools:
    - Read
    - Write
    - Glob
    - Grep
    - "Bash(node *)"
---

## Description

Architecture blueprint executor. Generates code architecture designs and implementation plans within a sandboxed Claude Code session. Limited tool access — read/write only, no git or npm operations.

## Anti-Patterns

- Do NOT wrap output in execution reports or campaign summaries
- Do NOT include step narration or tool call logs
- Do NOT include self-assessment scores or quality ratings
- Output ONLY the requested deliverable
