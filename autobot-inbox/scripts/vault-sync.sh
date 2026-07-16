#!/usr/bin/env bash
# Wrapper that launchd calls every 15 min. Sources .env so we don't have
# to bake API_SECRET into the plist. Logs go to launchd's StandardOutPath.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUTOBOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$AUTOBOT_DIR/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "[$(date -u +%FT%TZ)] missing .env at $ENV_FILE" >&2
  exit 1
fi

# Pull just the API_SECRET line; strip surrounding quotes.
API_SECRET="$(grep '^API_SECRET=' "$ENV_FILE" | cut -d= -f2- | sed -E 's/^"|"$//g; s/^'"'"'|'"'"'$//g')"
if [[ -z "${API_SECRET:-}" ]]; then
  echo "[$(date -u +%FT%TZ)] API_SECRET empty" >&2
  exit 1
fi

VAULT_PATH="${VAULT_PATH:-$HOME/vault}"
VAULT_OWNER="${VAULT_OWNER:-eric}"
OPTIMUS_API_URL="${OPTIMUS_API_URL:-https://preview.staqs.io}"

# `node` may not be on launchd's stripped PATH — use absolute path or fail loudly.
NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node" "$HOME/.nvm/versions/node/v20.19.6/bin/node"; do
    if [[ -x "$candidate" ]]; then NODE_BIN="$candidate"; break; fi
  done
fi
if [[ -z "$NODE_BIN" ]]; then
  echo "[$(date -u +%FT%TZ)] node not found on PATH or known locations" >&2
  exit 1
fi

echo "[$(date -u +%FT%TZ)] vault-sync starting (vault=$VAULT_PATH owner=$VAULT_OWNER api=$OPTIMUS_API_URL)"

OPTIMUS_API_URL="$OPTIMUS_API_URL" \
  OPTIMUS_API_SECRET="$API_SECRET" \
  VAULT_PATH="$VAULT_PATH" \
  VAULT_OWNER="$VAULT_OWNER" \
  "$NODE_BIN" "$SCRIPT_DIR/ingest-vault.mjs"

echo "[$(date -u +%FT%TZ)] vault-sync complete"
