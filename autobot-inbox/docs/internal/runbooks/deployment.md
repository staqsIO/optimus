---
title: "Deployment Runbook"
description: "Step-by-step guide for deploying and updating autobot-inbox from scratch or after changes."
---

# Deployment Runbook

Last updated: 2026-02-28

## Prerequisites

1. **Node.js >= 20.0.0** -- ES modules throughout (`"type": "module"`)
2. **Docker** -- for the Postgres container (production mode)
3. **npm** -- package manager (no yarn, no pnpm)
4. **Gmail OAuth credentials** -- client ID and secret from Google Cloud Console
5. **Anthropic API key** -- from console.anthropic.com

Note: For demo/dev mode without real Postgres, Docker is not required. The system falls back to PGlite (in-process WASM Postgres) when `DATABASE_URL` is unset.

## Environment Setup

### 1. Clone and Install

```bash
cd autobot-inbox
npm install
cd dashboard && npm install && cd ..
```

### 2. Configure Environment Variables

```bash
cp .env.example .env
```

Edit `.env` with required values:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | Yes (prod) | -- | Claude API key |
| `GMAIL_CLIENT_ID` | Yes (prod) | -- | Google OAuth client ID |
| `GMAIL_CLIENT_SECRET` | Yes (prod) | -- | Google OAuth client secret |
| `GMAIL_REFRESH_TOKEN` | Yes (prod) | -- | OAuth refresh token (via `npm run setup-gmail`) |
| `GMAIL_USER_EMAIL` | Yes (prod) | -- | Inbox owner email address |
| `DATABASE_URL` | No | -- | Postgres connection string. Omit for PGlite mode |
| `DAILY_BUDGET_USD` | No | `20` | Daily LLM spend ceiling (G1 gate) |
| `AUTONOMY_LEVEL` | No | `0` | 0 = all drafts need approval, 1 = auto-archive noise, 2 = full autonomy except G2 |
| `GMAIL_POLL_INTERVAL` | No | `60` | Gmail poll interval in seconds |
| `API_PORT` | No | `3001` | HTTP API server port |
| `DASHBOARD_PORT` | No | `3100` | Next.js dashboard port |

### 3. Gmail OAuth Setup

If credentials are not yet configured:

```bash
npm run setup-gmail
```

This launches an OAuth flow. Alternatively, the dashboard provides a browser-based OAuth flow at `GET /api/auth/gmail-url` that writes the refresh token directly to `.env`.

## Database Setup

### Option A: Docker Postgres (Production)

1. Start the container:

```bash
docker run -d \
  --name autobot-postgres \
  -e POSTGRES_USER=autobot \
  -e POSTGRES_PASSWORD=autobot \
  -e POSTGRES_DB=autobot \
  -p 5432:5432 \
  pgvector/pgvector:pg17
```

2. Set the connection string in `.env`:

```
DATABASE_URL=postgresql://autobot:autobot@localhost:5432/autobot
```

3. Run migrations:

```bash
npm run migrate
```

This applies all SQL files in `sql/` (000 through 022) in order. Migrations are tracked in a `public._migrations` table and are idempotent -- safe to run repeatedly.

4. Seed initial data:

```bash
npm run seed
```

This inserts agent configs, valid state transitions, routing rules, and the initial daily budget into the database (see `sql/008-seed.sql`).

### Option B: PGlite (Demo/Dev)

Omit `DATABASE_URL` from `.env`. The system automatically uses PGlite, an in-process WASM Postgres that persists to `data/pglite/`. Migrations run automatically on first start. No Docker required.

## Starting the System

### 1. Start the Agent Runtime

```bash
npm start
```

This starts:
- All six agent loops (orchestrator, strategist, executor-triage, executor-responder, reviewer, architect) staggered 2 seconds apart
- Gmail polling (60-second interval, if `GMAIL_REFRESH_TOKEN` is set)
- HTTP API server on port 3001 (configurable via `API_PORT`)
- Reaper process (sweeps stuck tasks every 60 seconds, 5-minute timeout threshold)
- Periodic services: tier-2 auditor, dead-man switch, financial sync, exploration monitor, merkle publisher

For development with auto-restart on file changes:

```bash
npm run dev
```

For demo mode with synthetic emails (no Gmail or Anthropic key required):

```bash
npm run demo
```

### 2. Start the Dashboard

```bash
cd dashboard && npm run dev
```

Runs the Next.js 15 dashboard on port 3100.

### 3. Start the Desktop App (Optional)

```bash
npm run electron
```

## Verification

### 1. Check API Status

```bash
curl http://localhost:3001/api/status
```

Expected response:

```json
{
  "gmail_connected": true,
  "gmail_credentials": true,
  "anthropic_configured": true,
  "demo_mode": false,
  "gmail_email": "eric@example.com"
}
```

### 2. Check Agent Logs

On startup, the console should show:

```
AutoBot Inbox v0.1.0
====================

Database connected
[config] Updated orchestrator config_hash -> <hash>
Gmail polling started (60s interval)
[api] Dashboard API listening on http://localhost:3001
6 agents started. Use CLI (npm run cli) for board operations.
Periodic services scheduled (reaper, tier2-audit, dead-man-switch, finance-sync, exploration-monitor, merkle-publisher)
```

Each agent should log its startup:

```
[orchestrator] Starting agent loop (model: claude-sonnet-4-6)
[strategist] Starting agent loop (model: claude-opus-4-6)
[executor-triage] Starting agent loop (model: claude-haiku-4-5-20251001)
...
```

### 3. Verify Pipeline Health

```bash
curl http://localhost:3001/api/debug/pipeline
```

Returns recent work items, task events, and state transitions. In a fresh deployment, these will be empty until emails start flowing.

### 4. Verify Gmail Polling

Watch for log lines:

```
[orchestrator] Gmail poll: 3 new messages
```

If `GMAIL_REFRESH_TOKEN` is not set, the log will show:

```
GMAIL_REFRESH_TOKEN not set -- Gmail polling disabled
```

## Common Issues

### Port Conflicts

The system uses three ports:

| Service | Default Port | Env Var |
|---------|-------------|---------|
| API server | 3001 | `API_PORT` |
| Dashboard | 3100 | `DASHBOARD_PORT` |
| Postgres | 5432 | (in `DATABASE_URL`) |

If a port is in use, the API server will log `Port XXXX is already in use` and exit. Either kill the conflicting process or change the port in `.env`.

### Docker Not Running

Symptom: `npm run migrate` fails with connection refused.

Fix: Start Docker and verify the container is running:

```bash
docker ps | grep autobot-postgres
```

If the container does not exist, create it with the `docker run` command above.

### Gmail Token Expired

Symptom: `[orchestrator] Gmail poll error: invalid_grant` in logs.

Fix:

```bash
npm run setup-gmail
```

Or use the dashboard OAuth flow. The new refresh token is written to `.env` and takes effect immediately (the API writes to both the file and `process.env`).

### Config Hash Mismatch

Symptom: All tasks get blocked with `config_hash_mismatch` in guard-check logs.

Cause: The `config_hash` in `agent_graph.agent_configs` does not match the SHA-256 hash computed at runtime from `config/agents.json`.

Fix: This is auto-synced on startup via `syncConfigHashes()` in `src/index.js`. If it persists, restart the runtime. The startup sequence updates the DB to match the current config.

### PGlite Contention (Dev Mode)

Symptom: Slow API responses, dashboard loading delays, `[db] Slow query` warnings.

Cause: PGlite is single-connection WASM. Six agents plus the API server contend for the single connection.

Fix: This is expected in PGlite mode. The API server uses a 60-second cache (`_cache` in `src/api.js`) to reduce contention. For production workloads, use real Postgres via `DATABASE_URL`.

## Updating

### Standard Update

```bash
git pull
npm install
npm run migrate    # Only needed if sql/ files changed
# Restart the runtime
```

### Database Migrations

Migrations are numbered sequentially (000 through 022). The `npm run migrate` command applies any not yet tracked in `public._migrations`. It is idempotent.

### Applying SQL Patches

For hotfix patches outside the migration sequence:

```bash
docker exec -i autobot-postgres psql -U autobot -d autobot < sql/patches/<filename>.sql
```

Current patches in `sql/patches/`:
- `fix-transition-state-routing.sql`

### Dashboard Update

```bash
cd dashboard
npm install
npm run build    # For production
npm run dev      # For development
```

## Graceful Shutdown

Send `SIGINT` or `SIGTERM` to the process. The shutdown handler:

1. Stops Gmail polling
2. Stops the reaper and all periodic services
3. Stops all six agent loops
4. Unsubscribes all event bus listeners
5. Closes the API server
6. Waits 2 seconds for in-flight operations to complete
7. Closes the database connection pool
