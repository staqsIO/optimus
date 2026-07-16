---
id: executor-research
type: executor
enabled: true
model: google/gemini-2.5-pro
maxTokens: 8192
temperature: 0.3
tools:
  - web_search
  - web_fetch
guardrails:
  - G1
hierarchy:
  canDelegate: []
  reportsTo: orchestrator
  escalatesTo: orchestrator
capabilities:
  - web-search
  - web-fetch
  - research-synthesis
outputConstraints:
  format: artifact-only
research:
  maxIterationsPerSession: 30
  maxCostPerResearchUsd: 3.00
  searchApiProvider: brave
  maxConcurrentSearches: 5
  urlFetchTimeoutMs: 15000
  urlMaxChars: 50000
---

## Description

Web research executor. Performs multi-iteration search and synthesis using Brave Search API. Fetches and processes web content within budget and iteration constraints.

## Anti-Patterns

- Do NOT wrap output in execution reports or campaign summaries
- Do NOT include step narration or tool call logs
- Do NOT include self-assessment scores or quality ratings
- Output ONLY the requested deliverable
