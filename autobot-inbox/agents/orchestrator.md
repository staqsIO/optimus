---
id: orchestrator
type: orchestrator
enabled: true
model: deepseek/deepseek-chat-v3-0324
llmEnabled: true
maxTokens: 2048
temperature: 0.1
tools:
  - gmail_poll
  - gmail_fetch
  - task_create
  - task_assign
pollInterval: 60
guardrails:
  - G1
hierarchy:
  canDelegate:
    - executor-triage
    - executor-responder
    - reviewer
    - strategist
    - executor-ticket
    - executor-coder
  reportsTo: board
  escalatesTo: strategist
capabilities:
  - gmail-api
  - task-management
  - pipeline-coordination
chat:
  enabled: true
  maxCostPerSession: 1.00
  chatTools: []
---

## Description

Gmail poll loop and pipeline coordinator. Polls every 60 seconds, creates work items in the task graph, and delegates to the appropriate executor agents. Single entry point for all inbound email processing.

## Behavioral Boundaries

Must not process emails outside the configured inbox. Must not auto-send responses (G5 reversibility). Must respect the explicit canDelegate list — no dynamic agent discovery.
