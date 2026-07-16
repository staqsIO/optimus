#!/usr/bin/env bash
# Wrapper for gws MCP server that auto-refreshes gcloud ADC token.
# Usage: ./gws-mcp.sh [services]
# Default services: gmail,drive,calendar

set -euo pipefail

export PATH="/opt/homebrew/share/google-cloud-sdk/bin:$PATH"
export CLOUDSDK_PYTHON=/opt/homebrew/bin/python3.13

# Refresh token from gcloud ADC
export GOOGLE_WORKSPACE_CLI_TOKEN=$(gcloud auth application-default print-access-token 2>/dev/null)

if [ -z "$GOOGLE_WORKSPACE_CLI_TOKEN" ]; then
  echo "ERROR: Failed to get access token. Run: gcloud auth application-default login --client-id-file=~/.config/gws/client_secret.json --scopes=..." >&2
  exit 1
fi

SERVICES="${1:-gmail,drive,calendar}"
exec gws mcp -s "$SERVICES"
