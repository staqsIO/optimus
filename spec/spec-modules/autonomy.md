# Autonomy Operating Model (Draft)

> Proposed new SPEC module. Documents current autonomy defaults and operational decisions.
> Status: Draft — needs board review.

## Current State (as of 2026-03-28)

### What Agents Do Autonomously (L1)

| Action | Agent | Gate | Board Involvement |
|--------|-------|------|-------------------|
| Archive noise emails | orchestrator | None (deterministic) | Daily digest only |
| Archive FYI emails | orchestrator | Inner-circle guard | Daily digest only |
| Archive GitHub CI notifications | executor-intake | None (deterministic) | None |
| Archive newsletters/promotions | executor-intake | Gmail label fast-path | None |
| Triage all emails | executor-intake | G1 budget | None |
| Extract signals | executor-triage | G1 budget | Visible on Signals page |
| Generate draft replies | executor-responder | G1 budget, G3 tone | Draft in review queue |
| Review drafts (gate check) | reviewer | G2 legal, G3 tone, G7 precedent | Verdict shown on draft |

### What Requires Board Approval (L0)

| Action | Why | Channel |
|--------|-----|---------|
| Send any email reply | G4 autonomy level = L0 | Web drafts page or Telegram |
| Create external commitments | G2 legal gate | Must be reviewed |
| Set pricing/timeline precedent | G7 precedent gate | Must be reviewed |
| Modify agent configuration | Board-tier change | Web agents page |
| Halt/resume system | Kill switch | Telegram or web |

### What's NOT Automated Yet

| Action | Current State | Target |
|--------|---------------|--------|
| Auto-send high-confidence routine replies | L0 blocks all sends | L1: auto-send if confidence > 0.8 AND no G2/G7 flags |
| Daily digest via Telegram | Not implemented | Morning summary of what agents did overnight |
| Auto-create Linear issues from emails | Manual via executor-ticket | Deterministic for feedback pipeline |
| Contact tier auto-update | Computed but not used for routing | Use tier for notification priority |

## Promotion Criteria

### L0 → L1 (Partial — noise/FYI already enabled)

**SPEC says**: 50 drafts, <10% edit rate, 14 days.

**Reality**: Zero drafts were ever generated before 2026-03-28. The 50-draft threshold is meaningless. L1 was enabled for noise/FYI immediately. Draft responses still require L0 approval.

**Proposed**: Enable L1 for `needs_response` category when:
- 20+ drafts approved with <15% edit rate
- No G2/G7 flags in the last 14 days
- Board explicitly approves promotion via Telegram command

### L1 → L2

**SPEC says**: 90 days, <5% error rate.

**Reality**: Not relevant yet. L1 needs to run long enough to collect data.

## Guards

### Inner-Circle Guard (added 2026-03-28)
Emails from `inner_circle` or `active` contacts are NEVER auto-archived, even if classified as noise/FYI. Queries live `signal.contacts.contact_tier`. Unknown contacts (no tier) are allowed to be archived.

### Pipeline Canary (added 2026-03-28)
Every 6 hours, checks if actionable emails are arriving but no drafts are being created. Alerts via Telegram if pipeline appears dead. Catches the scenario where bugs compound into total pipeline failure without anyone noticing.
