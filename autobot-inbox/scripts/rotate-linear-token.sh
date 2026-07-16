#!/usr/bin/env bash
#
# Rotate the Linear OAuth app token (client_credentials grant).
# The token expires after 30 days; this script runs every 28 days via cron.
#
# Requires:
#   LINEAR_OAUTH_CLIENT_ID    — from Linear OAuth app settings
#   LINEAR_OAUTH_CLIENT_SECRET — from Linear OAuth app settings
#   RAILWAY_TOKEN              — Railway API token (railway login, then check ~/.railway/config.json)
#   RAILWAY_PROJECT_ID         — Railway project ID
#   RAILWAY_SERVICE_ID         — Railway service ID for autobot-inbox-api
#   RAILWAY_ENVIRONMENT_ID     — Railway environment ID (production)
#
# Setup cron (every 28 days):
#   crontab -e
#   0 3 */28 * * $HOME/optimus/autobot-inbox/scripts/rotate-linear-token.sh >> /tmp/linear-token-rotate.log 2>&1

set -euo pipefail

LOG_PREFIX="[linear-token-rotate]"

# Source credentials from secure env file
ENV_FILE="${HOME}/.config/optimus/linear-rotate.env"
if [ -f "$ENV_FILE" ]; then
  set -a
  source "$ENV_FILE"
  set +a
else
  echo "$LOG_PREFIX ERROR: $ENV_FILE not found" >&2
  exit 1
fi

# Validate required env vars
for var in LINEAR_OAUTH_CLIENT_ID LINEAR_OAUTH_CLIENT_SECRET RAILWAY_TOKEN RAILWAY_PROJECT_ID RAILWAY_SERVICE_ID RAILWAY_ENVIRONMENT_ID; do
  if [ -z "${!var:-}" ]; then
    echo "$LOG_PREFIX ERROR: $var is not set" >&2
    exit 1
  fi
done

echo "$LOG_PREFIX $(date -Iseconds) Starting token rotation..."

# 1. Request new token via client_credentials grant
CREDENTIALS=$(echo -n "${LINEAR_OAUTH_CLIENT_ID}:${LINEAR_OAUTH_CLIENT_SECRET}" | base64)

RESPONSE=$(curl -s -X POST https://api.linear.app/oauth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -H "Authorization: Basic ${CREDENTIALS}" \
  -d "grant_type=client_credentials&scope=read,write,app:assignable,app:mentionable")

# Extract access_token from JSON response
ACCESS_TOKEN=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('access_token',''))" 2>/dev/null)

if [ -z "$ACCESS_TOKEN" ]; then
  echo "$LOG_PREFIX ERROR: Failed to get access token. Response: $RESPONSE" >&2
  exit 1
fi

echo "$LOG_PREFIX Got new access token (${#ACCESS_TOKEN} chars)"

# 2. Update LINEAR_API_KEY in Railway via API
UPDATE_RESPONSE=$(curl -s -X POST "https://backboard.railway.com/graphql/v2" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${RAILWAY_TOKEN}" \
  -d "$(cat <<GRAPHQL
{
  "query": "mutation { variableUpsert(input: { projectId: \"${RAILWAY_PROJECT_ID}\", environmentId: \"${RAILWAY_ENVIRONMENT_ID}\", serviceId: \"${RAILWAY_SERVICE_ID}\", name: \"LINEAR_API_KEY\", value: \"${ACCESS_TOKEN}\" }) }"
}
GRAPHQL
)")

# Check for errors
ERROR=$(echo "$UPDATE_RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('errors',[{}])[0].get('message',''))" 2>/dev/null || echo "")

if [ -n "$ERROR" ]; then
  echo "$LOG_PREFIX ERROR: Railway API failed: $ERROR" >&2
  exit 1
fi

echo "$LOG_PREFIX Updated LINEAR_API_KEY in Railway"

# 3. Trigger redeploy
REDEPLOY_RESPONSE=$(curl -s -X POST "https://backboard.railway.com/graphql/v2" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${RAILWAY_TOKEN}" \
  -d "$(cat <<GRAPHQL
{
  "query": "mutation { serviceInstanceRedeploy(environmentId: \"${RAILWAY_ENVIRONMENT_ID}\", serviceId: \"${RAILWAY_SERVICE_ID}\") }"
}
GRAPHQL
)")

echo "$LOG_PREFIX Triggered redeploy. Done."
echo "$LOG_PREFIX Next rotation due: $(date -v+28d -Iseconds 2>/dev/null || date -d '+28 days' -Iseconds 2>/dev/null || echo 'in 28 days')"
