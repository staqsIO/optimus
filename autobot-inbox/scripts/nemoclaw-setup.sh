#!/usr/bin/env bash
# NemoClaw → Optimus onboarding script.
# Reads OPTIMUS_API_SECRET from environment (never CLI args — Linus security).
#
# Usage:
#   export OPTIMUS_API_SECRET=<secret>
#   bash nemoclaw-setup.sh --username nemoclaw-dustin --sandbox claw-nemo

set -euo pipefail

API_URL="${OPTIMUS_API_URL:-https://preview.staqs.io}"
USERNAME=""
SANDBOX=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --username) USERNAME="$2"; shift 2 ;;
    --sandbox) SANDBOX="$2"; shift 2 ;;
    --api-url) API_URL="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

if [[ -z "$USERNAME" ]]; then echo "Error: --username required"; exit 1; fi
if [[ -z "$SANDBOX" ]]; then echo "Error: --sandbox required"; exit 1; fi
if [[ -z "${OPTIMUS_API_SECRET:-}" ]]; then
  echo "Error: OPTIMUS_API_SECRET environment variable required"
  echo "  export OPTIMUS_API_SECRET=<your-api-secret>"
  exit 1
fi

echo "=== NemoClaw → Optimus Setup ==="
echo "  API:      $API_URL"
echo "  Username: $USERNAME"
echo "  Sandbox:  $SANDBOX"
echo ""

# 1. Issue a scoped board JWT
echo "[1/4] Issuing board JWT..."
RESPONSE=$(curl -sf -X POST "$API_URL/api/auth/token" \
  -H "Authorization: Bearer $OPTIMUS_API_SECRET" \
  -H "Content-Type: application/json" \
  -d "{\"github_username\":\"$USERNAME\"}")

TOKEN=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])" 2>/dev/null)
if [[ -z "$TOKEN" ]]; then
  echo "  Failed to issue JWT. Response: $RESPONSE"
  exit 1
fi
echo "  JWT issued (24h TTL)"

# 2. Create optimus policy preset
echo "[2/4] Creating optimus policy preset..."
PRESETS_DIR="$HOME/.nemoclaw/source/nemoclaw-blueprint/policies/presets"
if [[ -d "$PRESETS_DIR" ]]; then
  cat > "$PRESETS_DIR/optimus.yaml" << 'PRESET_EOF'
preset:
  name: optimus
  description: "Optimus Board API (preview.staqs.io) and OpenRouter inference"

network_policies:
  optimus_board_api:
    name: optimus_board_api
    endpoints:
      - host: preview.staqs.io
        port: 443
        access: full
      - host: openrouter.ai
        port: 443
        access: full
    binaries:
      - { path: /usr/local/bin/node* }
      - { path: /usr/bin/curl* }
PRESET_EOF
  echo "  Preset written to $PRESETS_DIR/optimus.yaml"
else
  echo "  Warning: Presets directory not found. Apply manually."
fi

# 3. Apply preset (if nemoclaw CLI available)
echo "[3/4] Applying optimus preset..."
if command -v nemoclaw &>/dev/null; then
  echo "optimus" | nemoclaw "$SANDBOX" policy-add 2>/dev/null && echo "  Preset applied" || echo "  Apply manually: nemoclaw $SANDBOX policy-add → optimus"
else
  echo "  nemoclaw CLI not found. Apply manually after installation."
fi

# 4. Test connectivity
echo "[4/4] Testing Board API connectivity..."
STATUS=$(curl -sf -H "Authorization: Bearer $TOKEN" "$API_URL/api/pipeline/health" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(f\"{len(d.get('queues',[]))} queues, {len(d.get('stuck',[]))} stuck\")" 2>/dev/null)
if [[ -n "$STATUS" ]]; then
  echo "  Connected: $STATUS"
else
  echo "  Warning: Could not verify connectivity (may need sandbox network)"
fi

echo ""
echo "=== Setup Complete ==="
echo "  Your board JWT (export this in your NemoClaw sandbox):"
echo "  export OPTIMUS_TOKEN=$TOKEN"
echo ""
echo "  Test from inside sandbox:"
echo "    nemoclaw $SANDBOX connect"
echo "    curl -s -H \"Authorization: Bearer \$OPTIMUS_TOKEN\" $API_URL/api/pipeline/health"
