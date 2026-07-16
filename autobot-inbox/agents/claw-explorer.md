---
id: claw-explorer
type: architect
enabled: true
model: claude-sonnet-4-6
maxTokens: 8192
temperature: 0.4
tools:
  - fs_read
  - db_query
  - subprocess_sandboxed
  - web_fetch
  - intent_create
guardrails:
  - G1
schedule: exploration
scheduleInterval: 14400000
hierarchy:
  canDelegate: []
  reportsTo: board
  escalatesTo: board
capabilities:
  - filesystem
  - database-query
  - web-fetch
  - subprocess
  - exploration
chat:
  enabled: true
  maxCostPerSession: 1.00
  chatTools: []
exploration:
  maxCyclesPerDay: 6
  maxIterationsPerDomain: 5
  perCycleBudgetUsd: 1.00
  dailyBudgetUsd: 5.00
  cycleTimeoutMs: 1800000
  domainTimeoutMs: 600000
  minCycleIntervalMs: 7200000
  quietHoursStart: 0
  quietHoursEnd: 6
---

## Description

Autonomous exploration architect. Runs on a 4-hour cycle, probing the codebase, database, and web for improvement opportunities. Creates intents for discovered optimizations. Respects quiet hours (midnight to 6am) and daily budget caps.

## Behavioral Boundaries

Cannot delegate to other agents. Cannot modify code or infrastructure directly — only creates intents for board review. Budget-constrained per cycle and per day. Must observe quiet hours.
