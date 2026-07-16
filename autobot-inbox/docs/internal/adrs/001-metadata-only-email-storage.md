---
title: "ADR-001: Metadata-Only Email Storage"
description: "Never store email body in the database; fetch on-demand from Gmail API"
---

# ADR-001: Metadata-Only Email Storage

**Date**: 2026-02-28
**Status**: Accepted
**Spec Reference**: SPEC.md -- Design Decision D1

## Context

The inbox schema needs to store information about emails for triage, routing, and draft generation. The question is how much of the email to persist in our database.

Storing full email bodies creates three problems:

1. **Privacy exposure**: A database breach would expose the full text of every email ever processed. Eric's inbox contains confidential investor communications, legal documents, and personal correspondence.
2. **Storage costs**: At ~100 emails/day with an average body of 5KB, full-body storage grows at ~180MB/year before attachments. Not large in absolute terms, but unnecessary when Gmail already stores it.
3. **Compliance surface**: Storing email bodies makes the database subject to data retention and deletion obligations that Gmail already handles.

Gmail API provides reliable on-demand access to any message by `gmail_id`. The API is free within quota limits and retrieval latency (~200ms) is acceptable for agent processing pipelines that are not latency-sensitive.

## Decision

Store metadata only: `gmail_id`, `thread_id`, `message_id`, `from_address`, `from_name`, `to_addresses`, `cc_addresses`, `subject`, `snippet`, `received_at`, `labels`, `has_attachments`, `in_reply_to`. Never store the email body in the database.

When an agent needs the full body (triage classification, strategy analysis, draft response), it calls `fetchEmailBody(gmail_id)` which retrieves it from Gmail API on demand.

The `inbox.emails` table schema enforces this -- there is no `body` column. The comment `-- D1: no body stored` appears in the orchestrator's INSERT statement as a reminder.

## Alternatives Considered

| Alternative | Pros | Cons | Why Rejected |
|-------------|------|------|-------------|
| Full body storage | Faster agent processing (no API call); works offline | Privacy risk on breach; storage growth; compliance surface; redundant with Gmail | Privacy and compliance costs outweigh the ~200ms saved per agent call |
| Encrypted body storage | Breach-resistant; offline capable | Key management complexity; still subject to retention obligations; encryption at rest already handled by Supabase/Postgres | Added complexity for a problem we can avoid entirely by not storing |
| S3 for attachments only | Handles large attachments; offloads from Postgres | Another service to manage; still stores content outside Gmail; partial solution | Violates P4 (boring infrastructure) by adding S3; Gmail already stores attachments |

## Consequences

### Positive
- Minimal breach impact: leaked database contains only metadata (subjects, addresses, timestamps)
- No storage growth for email content
- Gmail handles retention, deletion, and legal hold compliance
- Simpler backup and migration story

### Negative
- Every agent processing step requires a Gmail API call (~200ms latency each)
- Processing fails if Gmail API is down (no cached fallback)
- `snippet` field (first ~200 chars) is stored and may contain sensitive content

### Neutral
- Voice schema (`voice.sent_emails`) stores outbound email bodies for embedding generation -- this is an intentional exception for the voice learning system, not inbox storage

## Affected Files

- `sql/002-email.sql` -- `inbox.emails` table has no body column
- `src/agents/orchestrator.js` -- Inserts metadata only (comment: `D1: no body stored`)
- `src/agents/executor-triage.js` -- Calls `fetchEmailBody()` on demand before classification
- `src/agents/strategist.js` -- Calls `fetchEmailBody()` on demand before analysis
- `src/gmail/client.js` -- Provides `fetchEmailBody(gmailId)` for on-demand retrieval
