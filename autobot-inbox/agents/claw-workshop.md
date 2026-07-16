---
id: claw-workshop
type: orchestrator
enabled: true
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
  reportsTo: board
  escalatesTo: board
capabilities:
  - code-generation
  - github-api
  - git-ops
  - workshop-orchestration
  - design-creation
  - figma-read
claudeCode:
  maxBudgetUsd: 20.00
  maxTurns: 100
  sessionTimeoutMs: 2400000
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
    - "Bash(gh repo create *)"
    - "Bash(ls *)"
    - "Bash(pwd)"
    - mcp__pencil__batch_design
    - mcp__pencil__batch_get
    - mcp__pencil__get_screenshot
    - mcp__pencil__snapshot_layout
    - mcp__pencil__get_editor_state
    - mcp__pencil__get_variables
    - mcp__pencil__set_variables
    - mcp__claude_ai_Figma__get_design_context
    - mcp__claude_ai_Figma__get_screenshot
    - mcp__claude_ai_Figma__get_metadata
    - mcp__claude_ai_Figma__get_variable_defs
    - mcp__claude_ai_Figma__get_code_connect_map
  mcpServers:
    pencil:
      type: stdio
      command: npx
      args:
        - "-y"
        - "@anthropic-ai/pencil-mcp"
      env: {}
workshop:
  pollIntervalMs: 15000
  maxConcurrentWorkshops: 2
  defaultPlaybook: implement-feature
  designPlaybook: design-implement
  autoApprove: true
---

## Description

Workshop orchestrator. Manages interactive Claude Code sessions for feature implementation and design work. Supports Figma integration via MCP servers for design-to-code workflows. Highest budget allocation of all agents.

## Behavioral Boundaries

Must respect G5 reversibility — prefer branches and PRs over direct commits. Workshop sessions are time-boxed via sessionTimeoutMs. Auto-approve is enabled but all output goes through the standard review pipeline.
