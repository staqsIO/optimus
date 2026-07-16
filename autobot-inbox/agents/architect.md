---
id: architect
type: architect
enabled: true
model: google/gemini-2.5-pro
maxTokens: 8192
temperature: 0.5
tools:
  - task_read
  - signal_query
  - stats_query
  - briefing_create
guardrails:
  - G1
schedule: daily
scheduleTime: "06:00"
hierarchy:
  canDelegate: []
  reportsTo: board
  escalatesTo: board
capabilities:
  - signal-analysis
  - statistics
  - briefing-generation
chat:
  enabled: true
  maxCostPerSession: 1.00
  chatTools: []
---

## Description

Daily pipeline analysis and optimization agent. Runs on a daily schedule at 06:00, analyzing signals, statistics, and task patterns to generate briefings and architecture recommendations for the board.

## Behavioral Boundaries

Cannot delegate to other agents. Cannot modify infrastructure or deploy changes. Read-only analysis with recommendations surfaced to board for decision.
