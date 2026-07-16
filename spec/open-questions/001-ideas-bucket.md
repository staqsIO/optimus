# Ideas Bucket

Raw product and project ideas surfaced during board conversations. Not spec-level, not actionable yet — just captured so they don't get lost. Ideas graduate to GitHub issues when someone wants to build them.

---

## GitHub Social Feed Intelligence / "Repo Drops"

**Source:** Eric + Dustin conversation, 2026-03-09
**Status:** Dustin building "The Smasher" as side project

### Three connected ideas:

1. **Influencer Repo Drops** — A network where GitHub influencers (Theo/T3, OpenClock, etc.) do PRs on repos as a distribution/marketing mechanism. Like influencer marketing but for open-source stars. Eric: "What if we started a connected dots network for doing repo drops? Where you get influencers to go and do a PR on your repo, so you get stars."

2. **The Smasher** (Dustin's build) — Grabs 2-3 random or curated repos, combines them, generates a summary of what it thinks it could build by mashing them together, then actually builds it. Gamified. Dustin is at end-of-plan stage, building after ski trip. Uses Claude Agent SDK to run on subscription (no API tokens).

3. **GitHub Activity Intelligence Feed** — Mine GitHub's social feed (follows, stars, forks, PRs) to track what top developers and influencers are actually working on. Surface trending repos/patterns before they blow up.

### Why it matters for Optimus:
- Automated competitive intelligence (the Paperclip analysis in 016 was done manually — this automates it)
- Watches the agent framework space for relevant patterns that could feed into spec evolution
- If open-sourcing `@optimus/governance`, this is the distribution channel

### Open questions:
- Is this an Optimus product, a Stacks product, or Dustin's personal project?
- GitHub API rate limits on social feed data?
- How does curation work — fully automated or human-curated influencer lists?

---

## Subscription-Routed Agent Processing

**Source:** Eric + Dustin conversation, 2026-03-09
**Status:** Concept, partially implemented

Route agent tasks to individual team members' machines running Claude Code on subscription plans instead of burning API tokens. Eric already has coding tasks routing to his machine. Vision: finance tasks route to Mike's machine, research tasks to Dustin's, etc.

### Why it matters:
- Dramatically reduces API costs for development work
- Each person's subscription absorbs their domain's compute
- "Planes" model — different specialties on different machines

### Open questions:
- How does this interact with Optimus's task graph? (Tasks assigned but executed locally)
- Reliability — what happens when someone's machine is offline?
- Long-term: VPS ($5/month) vs personal machines vs dedicated hardware

---

## Spec-as-Constitution: Tier-Based Visibility

**Source:** Eric + Dustin conversation, 2026-03-09
**Status:** Both agree it needs to happen, no plan yet

Break the spec into sections where different agent tiers only see what's relevant to their authority level. Executors see their constraints. Orchestrators see delegation rules. Strategists see everything. Aligns with P1 (deny by default).

Eric: "We need to break it up so that we can start actually referencing it for governance."
Dustin: "Who sees what parts of it? ...Why have that in the context if it doesn't matter? As long as the orchestrator is delegating properly."

### Why it matters:
- Reduces context window waste (agents loading full spec when they only need their section)
- Enforces information boundaries — executors shouldn't know about budget strategy
- Natural extension of the tier system already in the spec

### Open questions:
- How to split? By section? By tier? By role?
- Does this become a compiler step (spec.md -> per-tier config)?
- Relationship to the agents.md compilation pipeline proposed in 017?

---

## Automated PR Code Review Comments

**Source:** Dustin's reaction to PR #60, 2026-03-09
**Status:** Dustin wants it, Eric did it manually once

Dustin saw the detailed code review on PR #60 and loved it. Wants every PR to get that level of automated review with verdicts, specific feedback, and actionable items. Currently inconsistent — some PRs get deep review, others don't.

### Why it matters:
- Dustin feeds review comments back to his Claude to improve future PRs
- Creates a learning loop between contributors
- Board visibility into what's being proposed and why it's accepted/rejected

### Open questions:
- GitHub Actions workflow vs board workstation integration?
- Token cost per review (PR #60 review was manual, likely expensive)
- Review depth: every PR or only PRs touching certain paths?

---

## Cost Model: Time vs Dollars vs Tokens

**Source:** Eric + Dustin conversation, 2026-03-09
**Status:** Unresolved, needs ADR

Both agree dollar amounts should leave the spec (they go stale). Dustin proposed measuring in time. Eric pushed back: time is model-agnostic but doesn't map to financial budgets. A minute of Opus and a minute of Haiku cost wildly different amounts.

Eric's analysis: "Tokens don't equal time. Time is only relevant if we're operating the system itself. Tooling can take time but doesn't cost money until tokens are used."

### Candidate approaches:
- Token-budget units (composite of model tier + token count)
- Cost-per-task-type (unit economics, not absolute dollars)
- Operational doc with live numbers, spec with formulas only

### Why it matters:
- Spec §10 (Cost Tracking) needs a stable measurement unit
- Cost attribution view (016 Proposal 2, accepted) needs to know what unit to report in
- Board budget decisions need a metric that doesn't go stale monthly

---

## Fork Paperclip as GTM

**Source:** Dustin's proposal, 2026-03-09
**Status:** Proposed, not decided

Dustin: "I would say we fork Paperclip and harden it. And that's our GTM real quick right now. While we sit back on Optimus and keep focused on its governance thing."

### The argument for:
- Paperclip has 14.3K stars and brand recognition
- Fast path to a shippable product while Optimus governance matures
- "Apply a couple guardrails to Paperclip, you could set that up for people right now on contract"

### The argument against (from 016 audit):
- Paperclip's architecture is shallow — advisory governance, raceable budget checks, mutable audit log
- Inheriting their technical debt to save time may cost more than extracting from Optimus
- Brand confusion — are we Optimus or Paperclip-plus?

### Needs: Board decision (Eric + Dustin)
