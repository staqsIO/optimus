#!/usr/bin/env bash
# Activate NemoClaw as an Optimus orchestrator.
# Run this INSIDE the NemoClaw sandbox after connecting.
#
# Prerequisites:
#   - OPTIMUS_TOKEN env var set (board JWT)
#   - OPTIMUS_API env var set (default: https://preview.staqs.io)
#
# Usage (inside sandbox):
#   export OPTIMUS_TOKEN="<your-jwt>"
#   bash /tmp/nemoclaw-activate.sh

set -euo pipefail

OPTIMUS_API="${OPTIMUS_API:-https://preview.staqs.io}"

if [[ -z "${OPTIMUS_TOKEN:-}" ]]; then
  echo "Error: OPTIMUS_TOKEN not set. Issue one with:"
  echo "  curl -s -X POST $OPTIMUS_API/api/auth/token \\"
  echo "    -H 'Authorization: Bearer \$API_SECRET' \\"
  echo "    -H 'Content-Type: application/json' \\"
  echo "    -d '{\"github_username\":\"nemoclaw-ecgang\"}'"
  exit 1
fi

echo "=== Activating NemoClaw Optimus Orchestrator ==="

# 1. Set up env vars for OpenClaw
mkdir -p ~/.openclaw
cat > ~/.openclaw/.env << ENVEOF
OPTIMUS_TOKEN=$OPTIMUS_TOKEN
OPTIMUS_API=$OPTIMUS_API
ENVEOF
echo "[1/4] Environment configured"

# 2. Copy workspace files
mkdir -p ~/.openclaw/workspace
cat > ~/.openclaw/workspace/AGENTS.md << 'AGENTSEOF'
PLACEHOLDER
AGENTSEOF

cat > ~/.openclaw/workspace/IDENTITY.md << 'IDEOF'
PLACEHOLDER
IDEOF

cat > ~/.openclaw/workspace/HEARTBEAT.md << 'HBEOF'
PLACEHOLDER
HBEOF

echo "[2/4] Workspace files installed"

# 3. Test Board API connectivity
echo "[3/4] Testing Board API..."
HEALTH=$(curl -sf -H "Authorization: Bearer $OPTIMUS_TOKEN" "$OPTIMUS_API/api/pipeline/health" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(f\"{len(d.get('queues',[]))} queues, {len(d.get('stuck',[]))} stuck\")" 2>/dev/null || echo "FAILED")
echo "  Pipeline: $HEALTH"

# 4. Print next steps
echo "[4/4] Ready!"
echo ""
echo "  Interactive mode:"
echo "    openclaw tui"
echo ""
echo "  Always-on daemon:"
echo "    openclaw gateway"
echo ""
echo "  The agent knows how to check pipeline health, review drafts,"
echo "  approve intents, and create work items for the runner."
