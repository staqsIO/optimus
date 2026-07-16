#!/bin/bash
# Wrapper invoked by launchd for the M1 satellite runner.
# Changes into the app directory and execs node; `.env` is loaded by
# `src/runner.js` via `dotenv/config`, not by sourcing it in bash.
# This keeps the runner as PID 1 of the launchd job so KeepAlive
# respawns the actual process, not a shell wrapping it.

set -euo pipefail

REPO_DIR="${OPTIMUS_REPO_DIR:-$HOME/Optimus}"
APP_DIR="$REPO_DIR/autobot-inbox"
NODE_BIN="${NODE_BIN:-/opt/homebrew/bin/node}"
AGENTS="${OPTIMUS_AGENTS:-executor-coder,executor-redesign,executor-blueprint,claw-workshop,claw-campaigner,executor-research,executor-writer,content-atomizer,executor-contract}"

cd "$APP_DIR"

# .env is loaded by `import 'dotenv/config'` at the top of src/runner.js.
# Don't `source .env` here — bash's word-splitting trips on legitimate
# values containing $, backticks, parens, *, etc. (caused launchd exit
# code 127 during initial install). Node's dotenv parser handles them.

# RUNNER_ID is what surfaces on /runners — make it stable across restarts.
export RUNNER_ID="${RUNNER_ID:-m1-macbook}"

exec "$NODE_BIN" src/runner.js --agents="$AGENTS"
