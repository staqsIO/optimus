# Board Experience Specification (Draft)

> Proposed new SPEC module. Defines how board members interact with Optimus day-to-day.
> Status: Draft — needs board review before merging into SPEC.md.

## Daily Rhythm

### Morning (5 min)
1. Open **board.staqs.io** → **Today** page
2. See OWE (commitments you made), WAITING (things others owe you), CONNECT (relationship signals)
3. Review **Drafts** queue — approve, edit, or reject AI-generated responses
4. Glance at **Pipeline** health — green = system running, red = investigate

### Async (throughout day via Telegram)
- Receive notifications for `action_required` emails only (noise/FYI handled autonomously)
- Approve drafts via inline Telegram buttons (Approve/Reject)
- Quick commands: `status`, `halt`, `resume`, `directive <text>`
- Natural language queries: "what's happening with the FrontPoint project?"

### Weekly (15 min)
- Review **Runs** page — agent success rates, costs, duration trends
- Review **Agents** page — health status, model performance
- Evaluate autonomy promotion candidates — which agents have earned L1?
- Adjust gates if needed (G3 tone threshold, G1 budget ceiling)

## Autonomy Levels (Operational)

| Level | What the board sees | What agents do autonomously |
|-------|--------------------|-----------------------------|
| L0 | Every draft in review queue | Nothing — all actions require approval |
| L1 (current target) | Only `action_required` + flagged items | Auto-archive noise/FYI, auto-label, auto-respond to routine |
| L2 (future) | Only G2/G7 flagged items | Handle all except commitment/precedent-setting responses |

**Current state**: L1 partially enabled (noise/FYI auto-archive). Draft approval still L0 for all response types.

## Channels

| Channel | Board interaction | Agent interaction |
|---------|-------------------|-------------------|
| **Web** (board.staqs.io) | Full dashboard — Today, Drafts, Signals, Pipeline, Runs | Read-only visibility |
| **Telegram** | Commands, approvals, notifications, NL queries | Push notifications, async results |
| **Email** | Receive digest summaries (planned) | Gmail polling, draft creation |
| **Linear** | Create issues, comment with @Jamie | Comment-driven agent interaction |

## Notification Rules

| Event | Channel | Who |
|-------|---------|-----|
| Draft ready for review | Telegram + web badge | All board members |
| Agent failure (3x consecutive) | Telegram | All board members |
| Pipeline canary (0 drafts, emails arriving) | Telegram | All board members |
| action_required email from VIP | Telegram | All board members |
| Daily digest | Telegram (8am) | All board members |
| Noise/FYI auto-archived | Daily digest only | None (autonomous) |

## Multi-User Model

- Each board member has individual identity (`acted_by` on all approvals)
- Any board member can approve any draft (no domain gating in Phase 1)
- Activity feed shows who did what — approvals, rejections, directives
- Future: domain delegation (Dustin handles content, Eric handles infrastructure)
