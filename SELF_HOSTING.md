# Self-Hosting Ephor

This is a tiered guide for running a fork of Ephor (formerly Optimus), from a zero-config demo
boot up to the full multi-channel production configuration. Each tier is
strictly additive — nothing in a lower tier stops working when you add a
higher one.

> **Shortcut:** `npm run setup` (from the repo root) is a guided wizard that
> walks you through every service in this guide — with signup links — writes
> `autobot-inbox/.env`, and generates the internal secrets. It is re-runnable:
> existing values are kept unless you replace them. The sections below are the
> reference for doing it by hand or going deeper.

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
git clone https://github.com/staqsIO/ephor.git
cd ephor
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
  Agents that hard-require a provider you don't have (e.g. `executor-research`
  requires the Claude Code CLI provider) log a `Skipping: requires provider...`
  warning and sit out — the rest of the org runs normally.
- The pipeline runs against the demo emails: intake classifies them, the
  responder drafts replies, the reviewer gate-checks them. Watch it with
  `npm run cli` or the dashboard (`cd dashboard && npm run dev`, port 3100).

You can also force single-provider mode outside of `DEMO_MODE` by setting
`LLM_SINGLE_PROVIDER=anthropic` directly — useful if you want real channels
(Gmail, Slack, ...) wired up but still don't want to manage an OpenRouter key.

## Integration matrix — every external service, at a glance

Ephor talks to a lot of services in its full production configuration.
**Almost all of them are optional.** Each integration detects missing
credentials and skips itself (a log line, not a crash). Bring your own keys
for whatever you actually want — nothing is bundled or shared.

| Service | What it's for | Needed? | Key env vars | When unset |
|---|---|---|---|---|
| **Anthropic** | Baseline LLM provider for every agent tier | **Yes** (the only hard key) | `ANTHROPIC_API_KEY` | Nothing works — this is the one non-negotiable |
| **Postgres** | Task graph, audit log, all state | Production yes; demo no | `DATABASE_URL` | Falls back to PGlite (in-process, ephemeral) |
| | | | | TLS: any non-local hostname gets SSL by default. If your Postgres doesn't speak TLS (docker service name, LAN host), append `?sslmode=disable` to `DATABASE_URL` — the compose file already does this. |
| **OpenRouter** | Routes non-Anthropic models (Gemini, DeepSeek, Qwen tiers in the default `agents.json`) | Production default config only | `OPENROUTER_API_KEY` | Set `LLM_SINGLE_PROVIDER=anthropic` and it's not needed at all |
| **OpenAI** | RAG embeddings + Responses-API web search for the research pipeline | Optional | `OPENAI_API_KEY` | RAG indexing/search and research web-search degrade or skip |
| **Google Gemini (direct)** | Direct Gemini API access (alternative to routing Gemini via OpenRouter) | Optional | `GEMINI_API_KEY` | Gemini-configured agents route via OpenRouter or get remapped |
| **Voyage AI** | Alternative embedding provider + RAG reranker | Optional | `VOYAGE_API_KEY` | Reranking is skipped; default embedder used |
| **AssemblyAI** | Voice-memo transcription + speaker resolution | Optional | `ASSEMBLYAI_API_KEY`, `WEBHOOK_AUTH_ASSEMBLYAI_VALUE` | Voice-memo ingestion is off |
| **S3-compatible object storage** (Cloudflare R2, AWS S3, MinIO…) | Voice-memo audio + generated-artifact storage. The `AWS_*` names are the S3 SDK convention — our reference deploy uses **Cloudflare R2**, not AWS | Optional | `AWS_S3_ENDPOINT`, `AWS_S3_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_S3_REGION` | Storage-backed features error only if actually invoked; everything else unaffected |
| **JWT signing keys** | Agent / board / customer identity (RS256). See [JWT key generation](#jwt-key-generation) below | Production yes; demo no | `AGENT_JWT_KEY_PEM` (or `_PATH`), `BOARD_JWT_KEY_PEM`, `CUSTOMER_JWT_KEY_PEM` | Dev/demo auto-generates an ephemeral in-memory keypair at boot |
| **`API_SECRET`** | Legacy bearer auth for the HTTP API (dashboard/CLI/ops calls) | Recommended | `API_SECRET` | Bearer-secret auth is disabled (deny-by-default, P1). Board/agent/customer JWTs and public/health/webhook routes still work |
| **GitHub** | executor-coder PRs + executor-ticket issue creation | Optional | GitHub App: `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY[_PATH]`; or fallback `GITHUB_TOKEN` / `GITHUB_PAT` | Code/ticket executors can't push to GitHub; rest of org unaffected |
| **Gmail (OAuth)** | Real inbox polling — the flagship channel | Optional (advanced) | `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`, `GMAIL_USER_EMAIL` | Poller fails soft with a setup hint; use `DEMO_MODE=1` instead |
| **Google Workspace (service account)** | Drive folder watching, Calendar, transcript ingestion (domain-wide delegation) | Optional | `GOOGLE_SERVICE_ACCOUNT_KEY[_PATH]`, `GOOGLE_IMPERSONATE_EMAIL`, `SHARED_DRIVE_FOLDER_ID` | Drive/Calendar pollers skip |
| **Linear** | Issue mirroring + ticketing pipeline | Optional | `LINEAR_API_KEY`, `LINEAR_TEAM_ID`, `LINEAR_BOT_TOKEN` | Linear features skip |
| **Neo4j** | Knowledge graph (learning/connection features) | Optional | `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD` | Logs `NEO4J_URI not set — knowledge graph disabled`; clean skip |
| **Resend** | Outbound notification email (demo/redesign notifications) | Optional | `RESEND_API_KEY`, `RESEND_FROM` | Outbound notification email is off |
| **Slack** | Slack channel adapter (Socket Mode Bolt app) | Optional | `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_APP_TOKEN` | Slack adapter skips |
| **Telegram** | Telegram bot channel for board members | Optional | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOARD_USER_IDS` | Telegram adapter skips |
| **tl;dv** | Meeting transcript ingestion | Optional | `TLDV_API_KEY` | Transcript poller skips |
| **Model Armor (GCP)** | G8 prompt-injection screening on inbound content | **Production requirement** | `MODEL_ARMOR_TEMPLATE`, `MODEL_ARMOR_MODE=block` | Non-production: warn mode. `NODE_ENV=production` **refuses to boot** without it (fail-closed by design) |
| **Redis** | Board Workstation KV cache | Optional (board only) | `REDIS_URL` | Board falls back / cache disabled |

The full variable reference — including tuning knobs not listed here — is
`autobot-inbox/.env.example`, which is generated from actual `process.env.*`
consumers in the code and carries `[REQUIRED]`/`[RECOMMENDED]`/`[optional]`
markers per key.

### JWT key generation

Agent, board, and customer identities are signed with RS256 JWTs. In dev and
demo mode you don't need to do anything — an ephemeral RSA keypair is
generated in-memory at boot. For production (or any deploy where tokens must
survive a restart, or where the board UI and the API run as separate
services), generate persistent keys:

```bash
# One keypair per identity domain (agent / board / customer):
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out agent-jwt.pem
```

Then either point at the file (`AGENT_JWT_KEY_PATH=/path/agent-jwt.pem`) or
inline it (`AGENT_JWT_KEY_PEM="$(cat agent-jwt.pem)"` — `\n` escapes are
handled). Repeat for `BOARD_JWT_KEY_PEM` and `CUSTOMER_JWT_KEY_PEM` as needed.

> **Important:** `BOARD_JWT_KEY_PEM` must be the **same keypair** on the Board
> Workstation and the API service — the board signs, the API verifies. If they
> differ, every board user gets a 401.

### API access (`API_SECRET`)

The HTTP API (`autobot-inbox/src/api.js`, port 3001) is deny-by-default:
authenticated routes accept a board/agent/customer JWT or a bearer
`API_SECRET`, and with no `API_SECRET` set the bearer path rejects everything
(public, health, and webhook endpoints have their own auth and stay
reachable). If you want to curl the API yourself without setting up JWTs,
generate a secret and set it on both the server and your client:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Satellite runners (multi-machine)

The org doesn't have to run on one machine. The main process (`npm start`)
handles channels, the API, and the core pipeline agents; heavy executor
agents can run on **satellite runner machines** that share nothing with the
main process except the Postgres database. This is how the reference deploy
works: the pipeline runs in the cloud, while code-generation and
campaign agents run on a Mac on a desk.

Start a runner on any machine that can reach your Postgres:

```bash
git clone https://github.com/staqsIO/ephor.git && cd ephor && npm install
cd autobot-inbox
cp .env.runner.example .env   # only DATABASE_URL is required
bash scripts/setup-runner.sh  # prerequisite checker (node, git, gh, keys)
npm run runner                # default agent set: executor-coder, claw-campaigner
```

- **Pick the agent set** with `node src/runner.js --agents=executor-coder,claw-workshop`.
  Available runner agents: `executor-coder`, `executor-redesign`,
  `executor-blueprint`, `executor-research`, `claw-campaigner`,
  `claw-workshop`, `issue-triage`, `executor-writer`, `content-atomizer`,
  `executor-contract`. An unknown name fails fast and prints this list.
- **Runners are safe to multiply.** Task claiming uses
  `SELECT … FOR UPDATE SKIP LOCKED` and cross-process wake-up rides
  `pg_notify`, so several runners (and the main process) never double-claim
  a work item. Set `RUNNER_ID=my-mac-studio` for a friendly name in logs and
  the audit trail (auto-generated from hostname + pid otherwise).
- **Partition, don't duplicate.** On the main process, `AGENTS_ENABLED`
  (comma-separated agent IDs) overrides `config/agents.json` — use it to
  keep the runner-hosted agents *out* of the main process's set so each
  agent lives in exactly one place.
- **Runner env is minimal** — see `autobot-inbox/.env.runner.example`:
  `DATABASE_URL` (required), GitHub auth if you run `executor-coder`
  (GitHub App, `gh auth login`, or a PAT), `ANTHROPIC_API_KEY` if you run
  `executor-research`. No Gmail/Slack/Telegram/API-server vars needed.
- **Run it as a service.** `infra/m1/` has a macOS launchd wrapper
  (`bash infra/m1/install.sh`) that auto-restarts the runner on crash and
  reboot, pins one canonical agent list in `infra/m1/runner.sh`, and logs to
  `~/Library/Logs/staqs-optimus-runner.{log,err}`. On Linux, the equivalent
  is a small systemd unit around `npm run runner`.

## Optional add-on setup notes

Each of these needs its own credentials from **your own** accounts — none of
this is bundled or shared.

### Gmail (advanced)

Full (non-demo) Gmail polling requires your own Google Cloud project with the
Gmail API enabled and an OAuth client (`GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`,
`GMAIL_REFRESH_TOKEN`). This is the most involved add-on — expect to walk
through Google's OAuth consent screen setup and, if you want it outside
"Testing" publishing status, an app verification review. If Gmail isn't
configured, the poller fails soft (logs an error and a hint, doesn't
crash-loop the whole process) rather than requiring you to get this right on
day one. `npm run setup-gmail` walks the OAuth flow.

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
- `autobot-inbox/.env.runner.example` — the minimal env for a satellite
  runner machine.
- `infra/m1/README.md` — the macOS launchd wrapper for running a satellite
  runner as an auto-restarting service.
- Root `README.md` Quick Start — Docker Compose path for the full local stack
  (Postgres + Redis + all services).
