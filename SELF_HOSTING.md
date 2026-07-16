# Self-Hosting Optimus

This is a tiered guide for running a fork of Optimus, from a zero-config demo
boot up to the full multi-channel production configuration. Each tier is
strictly additive — nothing in a lower tier stops working when you add a
higher one.

## Minimum: zero-config demo boot

Runs the **entire agent org** — intake → triage → responder → review pipeline
— end-to-end against seeded demo emails, using a single Anthropic API key.
No Gmail, Slack, Telegram, Linear, tl;dv, or OpenRouter credentials required.

**Requirements:**
- A Postgres database (`DATABASE_URL`), or omit it entirely to fall back to
  PGlite (in-process, ephemeral — fine for a demo, not for anything you want
  to keep).
- An [Anthropic API key](https://console.anthropic.com/).

```bash
git clone https://github.com/staqsIO/optimus.git
cd optimus
npm install

cd autobot-inbox
cp .env.example .env
# Edit .env and set:
#   ANTHROPIC_API_KEY=sk-...
#   DEMO_MODE=1

npm start
```

What this gets you:
- All 20 agents boot and run their loops.
- `DEMO_MODE=1` skips Gmail/Drive/Calendar/tl;dv polling entirely and loads
  synthetic demo emails instead (`autobot-inbox/src/demo.js`).
- `DEMO_MODE=1` also defaults `LLM_SINGLE_PROVIDER=anthropic`, which remaps
  every agent's configured model (including the ones `config/agents.json`
  points at `openrouter` models like Gemini/DeepSeek) onto an Anthropic model
  instead. You'll see a one-time `[llm] LLM_SINGLE_PROVIDER=anthropic →
  remapping ...` warning per remapped model — that's expected, not an error.
- The pipeline runs against the demo emails: intake classifies them, the
  responder drafts replies, the reviewer gate-checks them. Watch it with
  `npm run cli` or the dashboard (`cd dashboard && npm run dev`, port 3100).

You can also force single-provider mode outside of `DEMO_MODE` by setting
`LLM_SINGLE_PROVIDER=anthropic` directly — useful if you want real channels
(Gmail, Slack, ...) wired up but still don't want to manage an OpenRouter key.

## Optional add-ons

Each of these needs its own credentials from **your own** accounts — none of
this is bundled or shared.

### Gmail (advanced)

Full (non-demo) Gmail polling requires your own Google Cloud project with the
Gmail API enabled and an OAuth client (`GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`,
`GMAIL_REFRESH_TOKEN`). This is the most involved add-on — expect to walk
through Google's OAuth consent screen setup and, if you want it outside
"Testing" publishing status, an app verification review. If Gmail isn't
configured, the poller now fails soft (logs an error and a hint, doesn't
crash-loop the whole process) rather than requiring you to get this right on
day one.

### Slack

Needs a Slack app with Socket Mode enabled: `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN`.

### Telegram

Needs a bot token from [@BotFather](https://t.me/botfather): `TELEGRAM_BOT_TOKEN`,
plus `TELEGRAM_BOARD_USER_IDS` to allow-list who the bot listens to.

### Linear

Needs a Linear API key + team ID for issue mirroring/ticketing.

### tl;dv

Needs a tl;dv workspace API key for meeting transcript ingestion.

### OpenRouter (multi-provider production config)

Prod's default `config/agents.json` routes Strategist/Architect/Orchestrator
tiers to `openrouter`-hosted models (Gemini 2.5 Pro, DeepSeek) for cost/latency
reasons. To run that default configuration as-is, get an
[OpenRouter API key](https://openrouter.ai/keys) and set `OPENROUTER_API_KEY`.
This is **not required** if you leave `LLM_SINGLE_PROVIDER=anthropic` set —
see the Minimum tier above.

## See also

- `autobot-inbox/.env.example` — every environment variable, with
  `[REQUIRED]`/`[RECOMMENDED]`/`[optional]` markers.
- Root `README.md` Quick Start — Docker Compose path for the full local stack
  (Postgres + Redis + all services).
