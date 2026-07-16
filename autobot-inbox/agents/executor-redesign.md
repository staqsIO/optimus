---
id: executor-redesign
type: executor
enabled: false
model: claude-sonnet-4-6
llmEnabled: true
maxTokens: 8192
temperature: 0.3
tools:
  - task_read
  - web_scrape
  - design_system_extract
guardrails:
  - G1
  - G6
hierarchy:
  canDelegate: []
  reportsTo: orchestrator
  escalatesTo: orchestrator
capabilities:
  - code-generation
  - web-scrape
  - image-generation
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
imagegen:
  enabled: true
  maxImagesPerJob: 4
  maxBudgetUsd: 0.20
pipeline:
  blueprint:
    backend: claude
    model: claude-sonnet-4-6
    maxTurns: 35
    timeoutMs: 600000
    maxBudgetUsd: 2.50
    allowedTools:
      - Read
      - Write
      - Glob
      - Grep
firecrawl:
  enabled: true
  fallbackOnly: false
componentLibrary:
  enabled: true
  hashCheck: true
---

## Description

Single-pass blueprint redesign executor. Scrapes target URL (Playwright + optional Firecrawl enrichment), analyzes with Claude Sonnet, builds a structured design system, selects human-designed component references, then generates a complete redesign in a single Claude Code session using a self-verifying CLAUDE.md blueprint. Includes Lighthouse before/after auditing for quality assurance.

## Anti-Patterns

- Do NOT wrap output in execution reports or campaign summaries
- Do NOT include step narration or tool call logs
- Do NOT include self-assessment scores or quality ratings
- Output ONLY the requested deliverable
