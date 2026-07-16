---
title: "Getting Started"
description: "How to set up and run AutoBot Inbox from scratch."
---

# Getting Started

## Prerequisites

Before starting, you will need:

| Requirement | Details |
|-------------|---------|
| **Node.js 20+** | The runtime requires Node.js version 20 or higher. Check with `node --version`. |
| **Docker** | Used for running Postgres locally during development. Not required for PGlite mode. |
| **Gmail OAuth credentials** | A Google Cloud project with the Gmail API enabled and OAuth 2.0 client credentials (client ID + client secret). |
| **Anthropic API key** | An API key from Anthropic for the Claude models that power all six agents. |
| **Git** | To clone the repository. |

## Setup Steps

### Step 1: Clone the repository

```bash
git clone <repository-url>
cd autobot-inbox
```

### Step 2: Install dependencies

```bash
npm install
```

The dashboard is a separate package. Install its dependencies too:

```bash
cd dashboard && npm install && cd ..
```

If you plan to use the Electron desktop app:

```bash
cd electron && npm install && cd ..
```

### Step 3: Configure environment variables

Copy the example environment file and fill in your credentials:

```bash
cp .env.example .env
```

Required variables:

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Your Anthropic API key |
| `GMAIL_CLIENT_ID` | OAuth client ID from Google Cloud Console |
| `GMAIL_CLIENT_SECRET` | OAuth client secret |
| `GMAIL_REFRESH_TOKEN` | Obtained during Gmail setup (Step 4) |
| `GMAIL_USER_EMAIL` | The inbox email address (e.g., eric@staqs.io) |
| `DAILY_BUDGET_USD` | Daily LLM spend ceiling (default: 20) |
| `AUTONOMY_LEVEL` | 0, 1, or 2 (start with 0) |

### Step 4: Connect Gmail

You can set up Gmail OAuth in two ways:

**Option A: Via the dashboard (recommended)**

Start the system first (Steps 5-6), then open the dashboard. Go to Settings and click "Connect Gmail". This will walk you through the OAuth flow in your browser and automatically save the refresh token to your `.env` file.

**Option B: Via the command line**

```bash
npm run setup-gmail
```

Follow the prompts. This will open a browser window for Google OAuth and save the refresh token.

### Step 5: Initialize the database

Run the database migrations to create all required tables:

```bash
npm run migrate
```

Then seed the initial configuration (agent configs, default budget, etc.):

```bash
npm run seed
```

### Step 6: Bootstrap voice profiles (optional but recommended)

To teach the system Eric's writing style, import sent emails and build voice profiles:

```bash
npm run bootstrap-voice
```

This analyzes sent mail from Gmail to build per-recipient and global voice profiles. Drafts will be more accurate with profiles in place.

### Step 7: Start the system

```bash
npm start
```

This starts the agent runtime (poll loop) and the API server. You will see logs in the terminal as agents process emails.

For development with auto-restart on file changes:

```bash
npm run dev
```

## Accessing the System

There are three ways to interact with AutoBot Inbox:

### Web Dashboard

Start the dashboard in a separate terminal:

```bash
cd dashboard && npm run dev
```

Open [http://localhost:3100](http://localhost:3100) in your browser. See the [Dashboard Guide](./dashboard-guide.md) for a page-by-page walkthrough.

### Command-Line Interface

```bash
npm run cli
```

This opens an interactive REPL where you can review drafts, check stats, issue directives, and halt/resume the system. See the [CLI Guide](./cli-guide.md) for available commands.

### Electron Desktop App

```bash
npm run electron
```

This launches a native desktop window that wraps the dashboard. Useful if you prefer a standalone app over a browser tab.

## Demo Mode

If you want to try the system without connecting a real Gmail account, use demo mode:

```bash
npm run demo
```

This starts the runtime with synthetic emails injected into the pipeline. You can also run the stress test to inject a batch of test emails:

```bash
node tools/stress-test.js
```

## Verifying Everything Works

After starting the system, check these:

1. **Terminal**: You should see agent startup logs and "Gmail poll" messages every 60 seconds
2. **Dashboard home page**: Should show today's stats (emails received, cost, etc.)
3. **CLI `stats` command**: Should display agent activity and budget status
4. **API health check**: Visit [http://localhost:3001/api/status](http://localhost:3001/api/status) -- should return JSON with connection status

If the dashboard shows "API unavailable", confirm the runtime is running and the API port (default 3001) is not blocked by another process.

## API reference (documents and search)

See **[Knowledge base and RAG API](./api-knowledge-base.md)** for how board JWTs, API secrets, and request bodies scope document list, ingest, vector search, and RAG completion when more than one board member shares the same database.
