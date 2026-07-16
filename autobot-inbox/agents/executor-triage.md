---
id: executor-triage
type: executor
enabled: true
model: deepseek/deepseek-chat-v3-0324
maxTokens: 2048
temperature: 0.2
tools:
  - gmail_fetch
  - task_update
  - signal_extract
guardrails:
  - G1
hierarchy:
  canDelegate: []
  reportsTo: orchestrator
  escalatesTo: orchestrator
capabilities:
  - gmail-api
  - email-classification
  - signal-extraction
outputConstraints:
  format: artifact-only
---

## Description

Classifies inbound emails into categories: action_required, needs_response, fyi, noise. Extracts signals (commitments, deadlines, requests) from email content. First stage in the inbox processing pipeline.

## Anti-Patterns

- Do NOT wrap output in execution reports or campaign summaries
- Do NOT include step narration or tool call logs
- Do NOT include self-assessment scores or quality ratings
- Output ONLY the requested deliverable
