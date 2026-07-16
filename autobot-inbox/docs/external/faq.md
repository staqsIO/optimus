---
title: "Frequently Asked Questions"
description: "Common questions about cost, safety, data storage, and operations."
---

# Frequently Asked Questions

## Cost and Budget

### How much does it cost to run?

The average cost per email processed is approximately $0.004 (four tenths of a cent). For a typical day with 30 emails, total LLM spend is in the range of $2-4. The daily budget ceiling is $20, which provides substantial headroom.

Cost varies by email complexity. Simple noise/FYI emails cost less (only the Triage agent runs). Emails that require a drafted reply cost more because they also pass through the Responder, Reviewer, and sometimes the Strategist.

### What happens if the budget is exceeded?

The G1 (Financial) gate halts all agent processing when daily LLM spend reaches the ceiling. No more API calls will be made until the next day's budget resets or the board manually adjusts the ceiling.

This is enforced at the database level through atomic budget reservations. Agents must reserve budget before making an LLM call, and the reservation fails if insufficient budget remains. This means the system cannot accidentally overshoot by running concurrent calls.

### Can I change the daily budget?

Yes. Set the `DAILY_BUDGET_USD` environment variable in your `.env` file and restart the runtime. The default is $20.

## Safety and Control

### Can it send emails without my approval?

Not at L0 (the current autonomy level). Every AI-generated draft requires explicit board approval before it can be sent. The system creates drafts -- it does not send them.

When you approve a draft, you choose whether to:
- Create it as a Gmail draft (you send it yourself from Gmail)
- Send it immediately (the system sends on your behalf)

At L1, the system would be able to auto-send routine replies (e.g., simple acknowledgments, scheduling confirmations). At L2, it could handle most emails autonomously. But graduating from L0 requires meeting measured performance targets -- it is not automatic.

### What if it drafts something wrong?

Multiple layers of protection exist:

1. **G2 (Legal)** scans every draft for commitment, contract, or agreement language and flags it for the board
2. **G7 (Precedent)** flags drafts that reference pricing, timelines, or policies
3. **G3 (Reputational)** checks that the draft's tone matches Eric's voice profile (must be at least 80% match)
4. **Reviewer agent** performs an independent assessment of every draft before it reaches the board
5. **L0 board review** -- at the current level, you see and approve every single draft

If a draft does contain errors and you catch them during review, you can edit it. Your edits are recorded as "edit deltas" and used to improve future drafts.

### How do I stop it?

Three ways, from fastest to most complete:

1. **CLI**: Type `halt` at the `autobot>` prompt. Takes effect in under a second.
2. **Dashboard**: Go to the System page and click the Halt button.
3. **Kill the process**: Press Ctrl+C in the terminal running `npm start`, or kill the Node.js process.

Halting stops all new task processing. Work items already in progress will finish their current step but will not advance further. Use `resume` (CLI) or the Resume button (dashboard) to restart.

### What if the AI tries to bypass the gates?

It cannot. The gates are enforced by database constraints and application logic, not by prompts. The AI agents never interact with the gate enforcement code -- they submit their output, and the infrastructure checks it. Even if an agent were to produce manipulated output (e.g., via a prompt injection from an email), the gates would still catch commitment language, tone mismatches, and budget violations.

## Data and Privacy

### What data does it store?

**Email metadata only**. The system stores sender, recipient, subject, timestamp, labels, and a short snippet. It never stores the full email body in the database. When a dashboard view or agent needs the email body, it fetches it on-demand from the Gmail API and discards it after use.

This is design decision D1, chosen to minimize the data footprint and reduce risk. If the database were compromised, no email content would be exposed.

The system does store:
- AI-generated draft text (these are created by the system, not user email content)
- Voice profile data (statistical patterns derived from sent mail, not the sent emails themselves, though the sent email corpus is stored for embedding generation)
- Edit deltas (the diff between original and board-edited drafts)
- Signal data (extracted contacts, topics, deadlines)
- Audit logs (every state transition, gate evaluation, and board action)

### Where is the data stored?

In a local PGlite database (an embedded Postgres instance) that lives on the same machine running the system. No data is sent to external databases. LLM requests go to the Anthropic API but do not include stored data -- only the current email being processed and relevant voice profile context.

### Can I delete everything and start fresh?

Yes. Stop the runtime, delete the PGlite data directory, and run `npm run migrate` followed by `npm run seed`. This gives you a clean database. Re-run `npm run bootstrap-voice` to rebuild voice profiles.

## Operations

### How do I add it to a new inbox?

This is not supported in Phase 1. The system is designed for a single inbox (Eric's work email). Multi-inbox support is planned for Phase 2.

### How do I update the system?

Pull the latest code, run `npm install` to update dependencies, and run `npm run migrate` to apply any new database migrations. Then restart the runtime with `npm start`.

### What happens if the system crashes?

The system is designed to be restart-safe. On startup, it:
1. Reconnects to the database
2. Picks up any incomplete work items where they left off
3. Resumes Gmail polling

No data is lost on crash. The task graph and audit trail are durable (persisted to disk). The worst case is that some emails get reprocessed, which is harmless (the system deduplicates by Gmail message ID).

### Can I run it on a server instead of my laptop?

Yes, though Phase 1 is designed for local operation. The system needs access to the `.env` file with credentials and a persistent filesystem for PGlite data. Any machine with Node.js 20+ and network access to the Gmail API and Anthropic API will work.

### How do I check if it is working?

Visit [http://localhost:3001/api/status](http://localhost:3001/api/status) for a quick JSON health check. It reports whether Gmail is connected, the API key is configured, and whether demo mode is active.

For a more thorough check, use the CLI `stats` command or the Dashboard home page. Both show live activity data. If emails are being received and triaged, the system is working.
