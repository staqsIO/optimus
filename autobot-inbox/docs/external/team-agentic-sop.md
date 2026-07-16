# Team Agentic Engineering SOP

**Audience:** Staqs + UMB Advisors team members onboarding onto the shared way of working.
**Date:** 2026-06-02
**Companion docs:** `spec/strategy-onboarding-roundout.md`, `spec/features/003-meeting-to-work.md`

This is how we work. It is distilled from how Eric and Keenan (Parslee) actually
ship, and from Matt Van Horn's "Every Agentic Engineering Hack I Know." The goal is
that **anyone can pick up any task and produce the same quality of outcome**, and
that **everything we do compounds into Optimus** (our shared brain).

> **The one rule: always more loops.** Nothing is "done" until a verifier that
> never saw the work confirms it against criteria you wrote *before* you started.
> The *verifier* differs by role — for a **Builder** it's a fresh-context test agent;
> for an **Advisory** member it's the human review-and-comment loop on the board.
> The discipline is the same: criteria first, independent check before done.

> **Two tracks.** This SOP has a **shared core** (everyone) and two role tracks —
> **Builder** (Staqs + technical UMB: terminal-native, ships code/flows) and
> **Advisory** (UMB advisory: push transcript → review on board → comment). If you
> never touch a terminal, the Builder-only sections (parallel sessions, runners,
> Codex, Playwright verifier) are **not required of you** — your loop is the shared
> core plus board review. Sections below are tagged **[core]**, **[builder]**, or
> **[advisory]**.

---

## 0. The mindset

- **You are the signal, not the hands.** The agents supply volume; you supply
  taste, direction, and the react-and-redirect loop. "Option 2 is closer, but use
  the language from option 1." The rare valuable thing is your judgment.
- **CEO-level ownership.** Own a project or a milestone end-to-end. File bugs and
  walk away — don't get into the weeds solving things an agent can solve.
- **Forward-only.** We don't revert; we fix forward. Rollback (Vercel/Railway) is
  the safety net for deploys, not a daily tool.

---

## 1. Plan first — always a plan.md

The moment you have an idea, a bug, an error, or a meeting transcript: **make a
plan before doing the work.** Unless it's literally a one-line change, there is
always a plan first.

- Fuzzy idea → brainstorm with the agent first, then plan once it's sharp.
- Deep non-code work (proposals, strategy, board updates) → **"make a plan for the
  plan."** Hand the agent your context + the raw transcript and say: *do not write
  the document now; first plan how you'll read everything and produce it.* This is
  the single best trick for making the agent not lazy.
- **The plan is the leash.** A coding agent with a plan ships finished work; without
  one it cuts corners and stops early.
- **You don't have to read the plan.** Skim the title, ask inline ("TLDR?",
  "eli5 this plan", "wait, why this approach?"), then run it. The plan is the
  agent's homework.

In this repo: write PRD-style specs, drop them into **Linear** as epics with
milestones and issue tags (issue-tagged work stops/starts far more fluidly than a
single MD file). Define **success criteria** in every issue — that's where your
time goes.

## 2. Feed the raw transcript

Record meetings (TLDV/Granola/Gemini). **Drop the raw transcript in — do not
summarize first.** The agent extracts against our codebase + prior plans + the KB.
Tangents and all; the model ignores the noise. Raw + context = gold.

For Optimus: push the transcript into the brain (see §6) so extraction runs against
the full org context, and so the meeting compounds for everyone.

## 3. More loops (the quality backbone)

Every unit of work runs the **dual loop**:

- **Inner loop:** implement a unit → code review (Linus + Neo) → fix → repeat until
  both approve → next unit.
- **Outer loop:** once units exist, a **context-isolated verifier** — a fresh
  session that never saw the implementation — tests the app against your upfront
  **success criteria** (browser automation for UI, terminal for CLI, API for
  services). It finds what's broken, sends it back to the inner loop, and repeats
  until *all* criteria pass.

The verifier never seeing the code is the point — it can't mark its own homework.

## 4. Run many sessions in parallel

- Keep several sessions going: one planning, one building, one running tests, one
  fixing a bug you just found. While one researches, switch to another.
- Reduce friction so starting a session costs one keystroke (terminal opens into
  the agent; reuse skills).
- With many sessions you can't babysit each edit — use a sound/notify hook so you
  know which one finished, and be deliberate about permission mode.
- **Two engines:** Claude plans and keeps taste; Codex can build in parallel. Push
  big parallel builds to the second engine when it helps throughput.

## 5. Research before you plan

Before planning a library choice, a feature, or even a partner meeting, do a quick
multi-source research pass (`/deep-research` here; "last30days"-style elsewhere) and
feed the result into the plan so it's grounded in what's true *now*, not stale
training data.

## 6. Everything compounds into Optimus (the shared brain)

Optimus is our org-level "notes are your agent's KB." Point your agent at it.

- **MCP server** (rolling out — STAQPRO-581): from your own Claude, push your
  outputs into Optimus — `optimus_ingest_document` (PRDs, specs, research),
  `optimus_ingest_transcript` (raw meeting transcripts), `optimus_push_summary`
  (a daily summary of what you did). Set up a scheduled daily task so yesterday's
  work lands automatically.
- **Ownership matters:** your pushes are stamped with you (`owner_user_id`) and your
  org (`owner_org_id`). Staqs and UMB share the brain but stay correctly scoped.
- **Why:** the research, drafts, and decisions you make in Claude/Slack are exactly
  what the org should be learning from. Capture them without breaking your flow.

### The `optimus` CLI (OPT-95)

The same captures, from your terminal — point scripts, cron jobs, and watched
folders at them. Auth is identical to the MCP server: `OPTIMUS_TOKEN` (minted via
`tools/optimus-mcp/issue-token.js`) + `OPTIMUS_API_URL` (default `preview.staqs.io`).
Ownership (your user + org) is derived from the token. Every write prints a receipt
(`stored · <id> · enrichment: <status>`).

```
optimus ingest <file|->                        push a doc into the KB
optimus artifact add --kind <kind> [--title T] <file|->   typed artifact
optimus capture <url> [--kind K]               capture a web / Drive URL
optimus push-summary [file|-]                  push a daily summary
optimus search <query>                         search the shared brain
optimus enrich contact|project <id>            show captured links + facts
optimus watch <folder>                         auto-push new/changed files
optimus capture-session                        SessionEnd hook backend (stdin)
```

Artifact kinds: `prd | proposal | spec | adr | brief | deck | transcript | summary | doc | other`.

### Passive session capture (Claude Code hook)

Don't rely on remembering to push. Install a **SessionEnd hook** and every Claude
Code session is captured automatically when it ends — extracted to a clean digest
(your prompts + the assistant's text, tool noise stripped, capped under the ingest
limit) and pushed as a `summary` artifact owned by you. The enrichment worker
(OPT-93) then links it to the right contacts/projects.

**Installing the hook IS the opt-in.** Once you add it, every session is captured
passively under *your* `OPTIMUS_TOKEN`. That is the consent model — if you don't
want a session captured, don't install the hook (or unset the token for that run).
The hook is fail-safe: no token, empty digest, or a failed push all exit 0 and
never block or break your session.

Add to your `.claude/settings.json` (assuming `optimus` is on your `PATH`):

```json
{
  "hooks": {
    "SessionEnd": [
      {
        "hooks": [
          { "type": "command", "command": "optimus capture-session" }
        ]
      }
    ]
  }
}
```

No-install fallback (run it straight from the repo, no global `bin`):

```json
{
  "hooks": {
    "SessionEnd": [
      {
        "hooks": [
          { "type": "command", "command": "node /ABSOLUTE/PATH/TO/optimus/tools/optimus-cli/index.js capture-session" }
        ]
      }
    ]
  }
}
```

## 7. Sharing with non-terminal humans

A plan.md is perfect for you and useless to a colleague who doesn't live in a
terminal. The **Optimus board** is our human-readable surface over agent work —
engagements, proposals, today/standup, signals. Share work there (or via Proof for
raw plan files), let people comment, and pull the comments back into the loop.

## 8. Write your own skills

Anything you do more than twice, turn into a skill. Don't write from scratch —
point the agent at a skill that already works and say "make one like this for X."
In Optimus, the in-product version of this is **flows** (Daniel's flow-natives):
small, single-purpose, chainable agents/tools.

---

## Role tracks

Same shared core; the day-to-day differs. Map yourself to a track.

| | **Builder** (Staqs + technical UMB) | **Advisory** (UMB advisory) |
|---|---|---|
| Daily surface | Linear + flows + runners + code | engagements / proposals / contracts / research, on the **board** |
| Loop | plan → build → inner review (Linus+Neo) → **fresh-context verifier** → done | plan → draft (Claude) → **push to Optimus** → **review + comment on board** → done |
| "more loops" verifier | a context-isolated test agent | the human board-comment review (you are the oracle) |
| MCP pushes | PRDs, specs, code-context | meeting transcripts, research, daily summaries |
| "on behalf of" | Stacks / Formulate | UMB |
| Terminal-native? | yes | not required |
| Shared core (both) | plan-first, feed the raw transcript, everything compounds into Optimus, the board is where work is reviewed | |

---

## Onboarding checklist (per person)

**Core (everyone)**
- [ ] Optimus MCP server configured (`OPTIMUS_TOKEN` issued; identity = your user + org)
- [ ] optimus CLI installed + SessionEnd hook enabled (passive session capture)
- [ ] Voice-to-LLM set up (Monologue / Wispr Flow on Mac; phone dictation)
- [ ] Daily-summary scheduled task pushing yesterday's work into Optimus
- [ ] Knows to write criteria first and where to get work reviewed (the board)

**Builder (additional)**
- [ ] Shared `.claude` config + skill set installed (tracked in the team setup repo)
- [ ] Spare laptop registered as a runner, reachable remotely
- [ ] Runs the dual loop: inner review (Linus+Neo) + fresh-context verifier before done

**Advisory (additional)**
- [ ] Comfortable pushing transcripts/research to Optimus and reviewing/commenting on the board
- [ ] Knows the board is the human review-and-comment loop (your "more loops")

## A note on sustainability

The loop is genuinely addictive — that's a feature and a risk. Take breaks. Talk to
the people around you. Build things people actually want (even if "people" is just
us). Shipping more is the goal; vanishing into the build is not.
