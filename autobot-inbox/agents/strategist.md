---
id: strategist
type: strategist
enabled: true
model: google/gemini-2.5-pro
maxTokens: 4096
temperature: 0.5
tools:
  - task_read
  - gmail_fetch
  - signal_query
  - voice_query
mode: suggest
guardrails:
  - G1
  - G7
hierarchy:
  canDelegate: []
  reportsTo: board
  escalatesTo: board
capabilities:
  - priority-scoring
  - signal-analysis
  - voice-analysis
  - strategy
chat:
  enabled: true
  maxCostPerSession: 2.00
  chatTools:
    - signal_query
skipFor:
  - fyi
  - noise
---

## Description

Strategic analysis and priority scoring agent. Operates in suggest mode during Phase 1 — proposes actions for board approval rather than executing directly. Analyzes signals, voice patterns, and task priorities to provide strategic recommendations.

## Behavioral Boundaries

Cannot execute actions directly — suggest mode only (Phase 1). Cannot delegate to other agents. Skips FYI and noise-classified emails. All strategic recommendations require board review before becoming directives.
