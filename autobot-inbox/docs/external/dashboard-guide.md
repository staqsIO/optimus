---
title: "Dashboard Guide"
description: "Page-by-page guide to the AutoBot Inbox web dashboard."
---

# Dashboard Guide

The dashboard is a Next.js 15 web application that serves as the primary board interface for monitoring and controlling AutoBot Inbox. It runs at [http://localhost:3100](http://localhost:3100).

## Starting the Dashboard

```bash
cd dashboard && npm run dev
```

The dashboard connects to the API server (default port 3001), which must be running alongside the agent runtime (`npm start`).

## Pages

### Home (Daily Briefing)

**URL**: `/`

The landing page gives you a daily snapshot of system activity.

**What you see**:

- **Stat cards** -- Emails received today, action items requiring attention, drafts pending your review, and cost so far today
- **L0 exit criteria** -- Three progress bars tracking how close the system is to qualifying for L1 autonomy:
  - Drafts reviewed (target: 50 in 14 days)
  - Edit rate (target: below 10%)
  - Days active (target: 14)
- **Daily briefing** -- When available, a summary of the day's activity, action items that need attention, and extracted signals

**What to look for**: If "Drafts Pending" is nonzero, there are replies waiting for your review. Navigate to the Drafts page.

### Drafts (Review Queue)

**URL**: `/drafts`

This is the most frequently used page. Every AI-generated reply appears here for board review before it can be sent.

**What you see**:

- **Pipeline strip** -- Quick stats across the top: emails today, budget usage, L0 progress, and 14-day edit rate
- **Draft list** -- Each pending draft shows:
  - Sender name and how long ago the email arrived
  - Email subject line
  - Triage category badge (action required, needs response, FYI, noise)
  - Voice tone match percentage
  - Reviewer verdict badge (approved, flagged, rejected)
  - Gate indicator dots -- seven small dots representing G1 through G7 (green = passed, red = failed, gray = not applicable)

**Actions on each draft** (collapsed view):

| Button | What It Does |
|--------|-------------|
| **Send** | Approves the draft and sends it immediately via Gmail |
| **Draft** | Approves the draft and creates it in Gmail's Drafts folder for you to review there before sending |
| **Reject** | Discards the draft. No email is sent. |

**Expanded view**: Click any draft to expand it into a split-pane view:

- **Left pane**: The original email (body fetched on-demand from Gmail)
- **Right pane**: The AI-generated reply
- **Gate bar**: Shows pass/fail status for all seven constitutional gates with details on hover
- **Edit button**: Opens the draft text for inline editing. Your edits are saved as edit deltas (used to improve future drafts)

**Keyboard shortcuts**:

| Key | Action |
|-----|--------|
| `j` / `k` | Navigate up/down through the draft list |
| `x` | Toggle selection on the focused draft |
| `o` or `Enter` | Expand/collapse the focused draft |
| `Escape` | Close expanded view, or clear selection |

**Bulk actions**: Select multiple drafts using checkboxes or the `x` key, then use the bulk action bar that appears at the bottom to approve-and-send, draft-only, or reject all selected items at once.

### Pipeline

**URL**: `/pipeline`

Shows the internal task graph -- every work item created by the Orchestrator and how it flows through agents.

**What you see**:

- **Work items** -- Each email creates a work item that moves through statuses: created, assigned, in progress, review, completed (or failed/blocked)
- **State transitions** -- A log of every status change, which agent triggered it, and when

**When to use this**: Useful for diagnosing why a particular email did not produce a draft, or why processing is stalled. If a work item is stuck in "in_progress" for more than 5 minutes, something may be wrong.

### Metrics

**URL**: `/metrics`

Displays the 13 Phase 1 success metrics defined in the Optimus spec. These are the numbers that determine whether the system is performing well enough to graduate autonomy levels.

**What you see**:

| Metric | Target | What It Measures |
|--------|--------|-----------------|
| M1: Inbox Zero Rate | 90%+ | Percentage of emails processed same-day |
| M2: Triage Latency | Under 5 min | Average time from email arrival to classification |
| M3: Draft Accuracy | 80%+ | Percentage of drafts approved without edits |
| M4: Edit Rate (14d) | Under 10% | How often the board edits vs. approves as-is |
| M5: Drafts Reviewed (14d) | 50+ | Total drafts the board has reviewed in 14 days |
| M6: Avg Daily Cost | Under $5 | Average LLM spend per day |
| M7: Budget Utilization | Under 80% | How much of the daily budget is consumed |
| M8: Hash Chain Valid | Yes | Audit trail integrity (append-only, no gaps) |
| M9: Gate Enforcement | 100% | Percentage of drafts that actually ran through all gates |
| M10: Total Halts | Low | Number of emergency halts (lower is better) |
| M11: Signals per Email | 0.5+ | Average number of actionable signals extracted |
| M12: Voice Samples | 50+ | Size of the voice profile training corpus |
| M13: L0 Exit Ready | Yes/No | Whether all L0 exit criteria are simultaneously met |

Each metric card shows the current value, the target, and whether it is met.

### Finance

**URL**: `/finance`

Financial overview including LLM costs, budget utilization, and organizational accounting.

**What you see**:

- **Cost digest** -- Today's total spend broken down by AI model and by agent
- **Budget status** -- Progress bar showing how much of the daily $20 ceiling has been used, with color warnings (green under 50%, yellow 50-80%, red over 80%)
- **Organizational finance** -- Revenue, expenses, reserve allocation, and distribution eligibility (when applicable)

**What to look for**: If the budget bar is approaching 80%, the system is processing more emails than usual or using more tokens per email. At 100%, the G1 gate will halt all processing.

### Stats

**URL**: `/stats`

Detailed agent-level performance data.

**What you see**:

- **Agent activity table** -- For each of the six agents: LLM calls today, cost today, tokens consumed, active tasks, and completed tasks
- **Budget breakdown** -- Per-scope budget utilization
- **Daily summary** -- Emails received, triaged, drafts created, and drafts pending review

### Signals

**URL**: `/signals`

Intelligence extracted from processed emails.

**What you see**:

- **Upcoming deadlines** -- Action items with due dates extracted from email content
- **Top contacts** -- Most frequent correspondents ranked by email volume
- **Trending topics** -- Recurring subjects and themes across recent emails, scored by trend relevance

**When to use this**: Check this page for a high-level picture of what is happening in the inbox -- who is emailing most, what topics are trending, and what deadlines are approaching.

### Audit

**URL**: `/audit`

System integrity and compliance monitoring.

**What you see**:

- **Audit findings** -- Results from automated audit runs, categorized by severity (critical, high, medium, low)
- **Constitutional evaluations** -- Records of gate enforcement on each draft, including whether any gates would have blocked
- **Board interventions** -- Log of every halt, resume, directive, and manual override the board has performed

**When to use this**: Periodic review to confirm the system is operating within its constitutional constraints. The hash chain validation (M8) confirms no audit records have been tampered with.

### Settings

**URL**: `/settings`

System configuration and Gmail connection management.

**What you see**:

- **Gmail connection status** -- Whether Gmail OAuth is active, which email account is connected
- **Connect/Disconnect Gmail** -- One-click OAuth flow to connect or disconnect the Gmail account
- **API key status** -- Whether the Anthropic API key is configured
- **Demo mode indicator** -- Whether the system is running in demo mode (synthetic emails)

### System

**URL**: `/system`

Runtime health, operational controls, and phase management.

**What you see**:

- **Current phase** -- Which operational phase the system is in (Phase 1, 2, etc.)
- **Dead man switch** -- Status of the periodic renewal check (ensures the board is still actively overseeing the system)
- **Gate status** -- Live pass/fail status of all seven constitutional gates
- **Phase readiness** -- Whether the system meets the criteria for advancing to the next phase
- **Exploration metrics** -- How much the system deviates from expected patterns (guards against drift)
- **Halt/Resume controls** -- Emergency halt and resume buttons
