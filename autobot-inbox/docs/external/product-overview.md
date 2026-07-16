---
title: "Product Overview"
description: "What AutoBot Inbox does, how emails flow through the pipeline, and the board's role."
---

# Product Overview

## What It Does

AutoBot Inbox is an AI-powered inbox management system. It monitors Eric's work email, classifies every incoming message, drafts replies in Eric's voice, and surfaces only the items that need human attention. The goal is inbox zero with minimal board effort -- the AI handles triage, drafting, and signal extraction while the board retains full control over what actually gets sent.

## How Emails Flow Through the Pipeline

Every inbound email passes through a six-agent pipeline, coordinated through a task graph (a queue of work items tracked in Postgres):

| Step | Agent | What It Does |
|------|-------|-------------|
| 1 | **Orchestrator** | Polls for new messages every 60 seconds across connected providers (Gmail, Outlook, Slack). Creates a work item in the task graph for each new message. |
| 2 | **Strategist** | Scores priority for high-importance emails (investor communications, contracts, board-related items). Recommends a handling strategy but does not act on it. |
| 3 | **Triage** | Classifies the email into one of four categories: action required, needs response, FYI, or noise. |
| 4 | **Responder** | For emails that need a reply, drafts a response using Eric's voice profile (learned from sent mail analysis and board edit corrections). |
| 5 | **Reviewer** | Checks every draft against seven constitutional gates before it reaches the board. Flags anything risky. |
| 6 | **Architect** | Runs daily pipeline analysis, identifies bottlenecks, and suggests optimizations. |

An email that arrives at 10:00 AM is typically triaged within 1-2 minutes and has a draft ready for review within 3-5 minutes.

## What the Board Does

At the current autonomy level (L0), the board's primary responsibilities are:

1. **Review drafts** -- Every AI-generated reply requires board approval before it can be sent. You can approve, edit, reject, or approve-and-send directly.
2. **Monitor gate flags** -- The system flags drafts that contain commitment language (G2), miss voice tone targets (G3), or reference pricing/timelines/policies (G7). These flags deserve closer review.
3. **Watch costs** -- The daily LLM spend is capped at $20. Current average is approximately $0.004 per email processed. The dashboard shows real-time spend.
4. **Issue directives** -- The board can inject priorities into the task graph (e.g., "prioritize investor emails this week") via the CLI.
5. **Emergency halt** -- If anything looks wrong, the board can immediately halt all agent processing via the dashboard or CLI.

## The Seven Constitutional Gates

Every draft passes through these gates before reaching the board. Gates are enforced in the database, not in prompts -- they cannot be bypassed by the AI.

| Gate | What It Checks | Why It Matters |
|------|---------------|----------------|
| G1 Financial | Daily LLM spend is under the $20 ceiling | Prevents runaway costs |
| G2 Legal | Scans for commitment, contract, or agreement language | Prevents accidental legal exposure |
| G3 Reputational | Voice tone match is at least 80% | Ensures replies sound like Eric, not a bot |
| G4 Autonomy | Board approval level is respected | Ensures human oversight at L0 |
| G5 Reversibility | Prefers drafts over direct sends; flags reply-all | Keeps actions reversible |
| G6 Stakeholder | No spam, no misleading content | Protects recipient relationships |
| G7 Precedent | Flags pricing, timeline, or policy commitments | Prevents setting unintended precedent |

## Graduated Autonomy

The system is designed to earn more independence over time, based on measured performance -- not a calendar. There are three levels:

| Level | What the AI Can Do Autonomously | What Still Needs Board Approval | Exit Criteria |
|-------|--------------------------------|-------------------------------|---------------|
| **L0** (current) | Nothing -- all drafts need approval | Everything | 50+ drafts reviewed, edit rate below 10%, 14 days of operation |
| **L1** | Auto-archive noise, auto-label FYI, auto-send routine replies | Action-required items, flagged drafts | 90 days, error rate below 5% |
| **L2** | Handle all emails except G2-flagged (legal/commitment) | Legal and commitment matters only | Ongoing |

The system tracks L0 exit criteria automatically. Progress is visible on the dashboard home page and the Metrics page.

## Design Principles

Six principles govern all decisions in the Optimus organization. Here is what each means for daily operations:

| Principle | What It Means for You |
|-----------|----------------------|
| **P1: Deny by default** | The system cannot do anything unless explicitly permitted. New capabilities require board sign-off. |
| **P2: Infrastructure enforces** | Safety checks are in the database, not in AI prompts. The AI cannot talk its way past a gate. |
| **P3: Transparency by structure** | Every action is logged, hash-chained, and auditable. No hidden state. |
| **P4: Boring infrastructure** | Standard tools only (Postgres, Node.js, Gmail API). No exotic dependencies that could break. |
| **P5: Measure before you trust** | Autonomy increases are based on metrics, not gut feel. The system proves it is ready. |
| **P6: Familiar interfaces** | You interact through tools you already use -- a web dashboard, a CLI, and Gmail itself. |

## Multi-Channel Architecture

The agent pipeline is fully provider-agnostic. Agents never interact with email providers directly -- an adapter registry resolves the correct provider adapter for each message, fetches the content, and delivers it to agents through a shared context object. This means adding a new message source requires only writing an adapter. The agents, constitutional gates, and board approval flow are completely unchanged regardless of which provider delivered the message.

Three providers are currently supported:

| Provider | Channel | Status |
|----------|---------|--------|
| **Gmail** | Email | Production -- primary inbox |
| **Outlook** | Email | Implemented -- OAuth setup, draft creation, send via Microsoft Graph API |
| **Slack** | Messaging | Implemented -- adapter conforming to InputAdapter/OutputAdapter interfaces |

LinkedIn content automation (Phase 1.5) is in progress with the database schema in place.

## Knowledge base (RAG) and multiple board members

The product stores ingested documents and vector chunks in Postgres (pgvector). **Org-wide** documents (`owner_id` unset) are visible to every board member; **private** documents are tied to a specific board member and are only visible to that member when using **board** authentication. Service credentials and agent tokens used for operations can see the full corpus unless they pass an explicit filter. Vector search and document APIs follow the same rules.

For integrators and dashboard authors, the HTTP behavior (auth, body parameters, error codes) is specified in **[Knowledge base and RAG API](./api-knowledge-base.md)**.

## Current Status

- **Phase**: 1 -- single inbox (Eric's work email), single operator setup. Phase 1.5 (LinkedIn content automation) groundwork in progress.
- **Autonomy Level**: L0 -- all drafts require board approval before sending
- **Average Cost**: approximately $0.004 per email processed
- **Pipeline**: end-to-end operational (triage, drafting, review, gate enforcement)
- **Voice Profiles**: built from sent mail analysis with a closed feedback loop -- board edits are analyzed and merged back into profiles automatically, and the responder sees past corrections when drafting
- **Multi-Channel**: provider-agnostic pipeline with three adapters (Gmail, Outlook, Slack); LinkedIn content schema deployed
