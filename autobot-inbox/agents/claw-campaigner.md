---
id: claw-campaigner
type: orchestrator
enabled: true
model: claude-sonnet-4-6
maxTokens: 16384
temperature: 0.3
tools:
  - llm_invoke
  - db_read
  - db_write
  - subprocess_sandboxed
  - fs_read
  - fs_write
  - git_ops
  - intent_create
guardrails:
  - G1
hierarchy:
  canDelegate:
    - executor-blender
    - executor-veo3
    - executor-test
  reportsTo: board
  escalatesTo: board
capabilities:
  - llm-invoke
  - database-read
  - database-write
  - filesystem
  - git-ops
  - subprocess
  - campaign-orchestration
outputConstraints:
  format: artifact-only
claudeCode:
  model: sonnet
  maxBudgetUsd: 2.00
  maxTurns: 30
  allowedTools:
    - Read
    - Edit
    - Write
    - Glob
    - Grep
    - "Bash(git *)"
    - "Bash(npm *)"
    - "Bash(node *)"
    - "Bash(ls *)"
    - "Bash(pwd)"
campaign:
  pollIntervalMs: 30000
  defaultIterationTimeBudget: 300000
  defaultPlateauWindow: 5
  defaultPlateauThreshold: 0.01
  maxConcurrentCampaigns: 2
  worktreeBaseDir: "campaigns/"
---

## Description

Campaign orchestrator. Manages multi-iteration improvement campaigns with plateau detection and budget controls. Delegates to specialized executors (blender, veo3, test) and operates within git worktrees for isolation.

## Anti-Patterns

- Do NOT wrap output in execution reports or campaign summaries
- Do NOT include step narration or tool call logs
- Do NOT include self-assessment scores or quality ratings
- Output ONLY the requested deliverable
