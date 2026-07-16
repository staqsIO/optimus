---
title: "CLI Guide"
description: "Guide to the AutoBot Inbox command-line interface for quick board operations."
---

# CLI Guide

The CLI is an interactive command-line interface for board operations. It is the fastest way to review drafts, check system status, and issue emergency commands without opening a browser.

## Starting the CLI

```bash
npm run cli
```

You will see:

```
AutoBot Inbox -- Board CLI
Type "help" for commands, "quit" to exit

autobot>
```

Type any command at the `autobot>` prompt.

## Available Commands

| Command | Description |
|---------|-------------|
| `inbox` | View triaged emails and pending items |
| `review` | Approve, edit, reject, or send pending drafts |
| `send` | Send previously approved drafts |
| `briefing` | View today's daily briefing |
| `stats` | Cost, throughput, and autonomy metrics |
| `halt` | Emergency stop all agents |
| `resume` | Resume operations after a halt |
| `directive` | Create a board directive (inject a priority) |
| `voice` | Voice profile management and training stats |
| `help` | Show all available commands |
| `quit` | Exit the CLI |

## Command Details

### inbox

View recent emails and their triage status.

```
autobot> inbox
```

Each email is displayed with its triage category, sender, subject, time, priority score, signal count, and whether a draft is ready for review.

**Filters**: You can filter by category:

```
autobot> inbox pending      # Emails not yet triaged
autobot> inbox action       # Action required
autobot> inbox response     # Needs response
autobot> inbox fyi          # FYI only
autobot> inbox noise        # Noise (newsletters, notifications)
```

Without a filter, it shows all non-archived emails (up to 25).

### review

Step through each pending draft one at a time. For every draft, the CLI shows the recipient, subject, reviewer verdict, tone score, any gate flags, and the full draft text.

```
autobot> review
```

For each draft, you are prompted:

```
[a]pprove (draft) / [s]end (approve+send) / [e]dit / [r]eject / [S]kip:
```

| Option | What Happens |
|--------|-------------|
| `a` (approve) | Marks the draft as approved and creates it in Gmail's Drafts folder. You can send it later from Gmail or using the `send` command. |
| `s` (send) | Approves the draft and sends it immediately via Gmail. This is the board approval check -- once you press `s`, the email goes out. |
| `e` (edit) | Opens a multi-line editor. Type your revised text, then enter a line containing just `.` (period) to finish. The original and edited versions are both saved. The edited version is sent. |
| `r` (reject) | Prompts for a rejection reason, then discards the draft. No email is sent. |
| `S` (skip) | Skips this draft without taking action. It remains in the queue. |

Gate flags are shown in red if any gates failed (e.g., G2 for commitment language, G7 for pricing/timeline content). Pay extra attention to flagged drafts.

### send

Send drafts that were previously approved but not yet sent (e.g., those approved with `a` in the review flow or via the "Draft Only" button on the dashboard).

```
autobot> send
```

For each unsent approved draft, you are shown the draft text and prompted to send or skip.

### briefing

Display the daily briefing with today's key numbers.

```
autobot> briefing
```

Shows:

- **Today's activity**: Emails received, triaged, action required, needs response, drafts created, drafts approved, drafts edited, cost
- **Queue status**: Items awaiting triage, items awaiting review, upcoming deadlines
- **L0 exit criteria**: Edit rate and drafts reviewed over the last 14 days
- **Briefing summary**: When available, the AI-generated daily summary with action items and signals

### stats

Detailed system performance data.

```
autobot> stats
```

Shows:

- **Agent activity**: For each agent -- LLM calls today, cost, tokens consumed, active tasks, completed tasks
- **Budget status**: Spend vs. allocated budget with utilization percentage (color-coded: green is healthy, yellow is elevated, red is approaching the ceiling)
- **Autonomy metrics**: Current autonomy level, L0 exit criteria progress (drafts reviewed, edit rate, days active)

### halt

Emergency stop all agent processing. Takes effect immediately.

```
autobot> halt
autobot> halt Investigating unexpected behavior
```

You can optionally include a reason. Once halted:

- All agents stop picking up new tasks
- In-progress tasks will complete but no new ones will start
- The halt is recorded in the audit log

Use this if you see anything unexpected -- costs spiking, strange draft content, or agents behaving in ways you did not anticipate. It is always safe to halt; the system is designed for it.

### resume

Clear a halt and resume normal operations.

```
autobot> resume
```

The system will immediately begin processing the task queue again. All pending work items will be picked up by their assigned agents.

### directive

Inject a board-level priority into the task graph.

```
autobot> directive Prioritize investor emails this week
autobot> directive Deprioritize newsletter processing until further notice
```

The directive is created as a top-level work item attributed to the board. Agents will factor it into their processing priorities.

### voice

Manage and inspect the voice profile system that teaches the AI to write like Eric.

```
autobot> voice              # Show voice profiles (same as 'voice profiles')
autobot> voice profiles     # List all voice profiles with style details
autobot> voice edits        # Show recent edit deltas (board corrections)
autobot> voice status       # Corpus stats: sent emails imported, embeddings, profile count
autobot> voice rebuild      # Rebuild all voice profiles with latest edit corrections
```

**voice profiles** shows per-recipient and global profiles including formality score, average message length, common greetings and closings, and sample count.

**voice edits** shows the 14-day edit rate and recent edits the board has made. These edit deltas are the most valuable training data in the system -- they teach the AI where its drafts missed the mark.

**voice status** shows the overall health of the voice learning system: how many sent emails have been imported, how many have embeddings, and how many profiles exist.

**voice rebuild** triggers an immediate rebuild of all voice profiles, incorporating the latest edit corrections. Profiles are rebuilt automatically after every 5 edits, but this command lets you force a rebuild on demand -- useful after a batch of corrections or when you want immediate effect. The rebuild analyzes all recorded edit deltas (greeting preferences, closing preferences, vocabulary overrides, formality adjustments) and merges the patterns into each profile.

## Tips

- The CLI connects directly to the database, so it works even if the dashboard API is down
- You can run the CLI alongside the runtime and dashboard -- they do not conflict
- For the fastest draft review workflow, use the CLI: `review` lets you step through each draft with single-keystroke actions
- The `halt` command is the fastest way to stop the system in an emergency -- faster than navigating to the dashboard
