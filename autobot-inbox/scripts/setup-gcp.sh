#!/usr/bin/env bash
set -euo pipefail

# AutoBot Inbox — Google Cloud Project Setup
# Automates: project creation, Gmail API, OAuth consent screen, OAuth credentials.
# Requires: gcloud CLI (https://cloud.google.com/sdk/docs/install)
#
# Usage:
#   ./scripts/setup-gcp.sh                    # interactive — prompts for project ID
#   ./scripts/setup-gcp.sh my-project-id      # non-interactive
#   ./scripts/setup-gcp.sh --add-user user@gmail.com  # add a test user to existing project

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"

# ─── Helpers ───────────────────────────────────────────────────────────────────

info()  { echo -e "\033[1;34m→\033[0m $*"; }
ok()    { echo -e "\033[1;32m✓\033[0m $*"; }
warn()  { echo -e "\033[1;33m!\033[0m $*"; }
fail()  { echo -e "\033[1;31m✗\033[0m $*" >&2; exit 1; }

check_gcloud() {
  if ! command -v gcloud &>/dev/null; then
    fail "gcloud CLI not found. Install: https://cloud.google.com/sdk/docs/install"
  fi
  # Verify logged in
  if ! gcloud auth list --filter="status:ACTIVE" --format="value(account)" 2>/dev/null | head -1 | grep -q '@'; then
    fail "Not logged in to gcloud. Run: gcloud auth login"
  fi
  ok "gcloud CLI authenticated as $(gcloud auth list --filter='status:ACTIVE' --format='value(account)' 2>/dev/null | head -1)"
}

# ─── Add test user mode ───────────────────────────────────────────────────────

if [[ "${1:-}" == "--add-user" ]]; then
  EMAIL="${2:-}"
  if [[ -z "$EMAIL" ]]; then
    fail "Usage: $0 --add-user user@gmail.com"
  fi
  check_gcloud
  PROJECT_ID=$(gcloud config get-value project 2>/dev/null)
  if [[ -z "$PROJECT_ID" ]]; then
    fail "No active project. Run: gcloud config set project <project-id>"
  fi
  info "Adding $EMAIL as test user on project $PROJECT_ID..."

  # Get current test users, append new one
  CURRENT=$(gcloud alpha iap oauth-brands list --format="value(name)" 2>/dev/null | head -1)
  if [[ -n "$CURRENT" ]]; then
    # Use REST API to update OAuth consent screen test users
    ACCESS_TOKEN=$(gcloud auth print-access-token)
    # Fetch current consent screen config
    BRAND=$(curl -s -H "Authorization: Bearer $ACCESS_TOKEN" \
      "https://oauth2.googleapis.com/v1/projects/$PROJECT_ID/brands" 2>/dev/null || echo "")
    warn "Test user management via CLI is limited."
    echo ""
    echo "  Add test users manually:"
    echo "  https://console.cloud.google.com/apis/credentials/consent?project=$PROJECT_ID"
    echo ""
    echo "  Under 'Test users', click 'Add users' and enter: $EMAIL"
  else
    warn "No OAuth brand found. Run full setup first: $0"
  fi
  exit 0
fi

# ─── Main setup ───────────────────────────────────────────────────────────────

echo ""
echo "  AutoBot Inbox — Google Cloud Setup"
echo "  ==================================="
echo ""

check_gcloud

# Project ID
if [[ -n "${1:-}" ]]; then
  PROJECT_ID="$1"
else
  DEFAULT_PROJECT="autobot-inbox-$(whoami | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9' | head -c8)"
  read -rp "  Project ID [$DEFAULT_PROJECT]: " PROJECT_ID
  PROJECT_ID="${PROJECT_ID:-$DEFAULT_PROJECT}"
fi

# ─── Step 1: Create project ──────────────────────────────────────────────────

info "Step 1: Creating project '$PROJECT_ID'..."
if gcloud projects describe "$PROJECT_ID" &>/dev/null; then
  ok "Project already exists"
else
  gcloud projects create "$PROJECT_ID" --name="AutoBot Inbox" --quiet
  ok "Project created"
fi

gcloud config set project "$PROJECT_ID" --quiet
ok "Active project: $PROJECT_ID"

# Check billing (Gmail API requires a billing account, even on free tier)
BILLING=$(gcloud billing projects describe "$PROJECT_ID" --format="value(billingAccountName)" 2>/dev/null || echo "")
if [[ -z "$BILLING" ]]; then
  warn "No billing account linked. Gmail API requires billing (free tier is fine)."
  echo ""
  echo "  Link billing: https://console.cloud.google.com/billing/linkedaccount?project=$PROJECT_ID"
  echo ""
  read -rp "  Press Enter after linking billing (or Ctrl+C to abort)..."
fi

# ─── Step 2: Enable Gmail API ────────────────────────────────────────────────

info "Step 2: Enabling Gmail API..."
gcloud services enable gmail.googleapis.com --quiet
ok "Gmail API enabled"

# ─── Step 3: OAuth consent screen ────────────────────────────────────────────

info "Step 3: Configuring OAuth consent screen..."

# Get the user's email for the consent screen
USER_EMAIL=$(gcloud auth list --filter="status:ACTIVE" --format="value(account)" 2>/dev/null | head -1)

# Check if consent screen already exists
EXISTING_BRAND=$(gcloud alpha iap oauth-brands list --format="value(name)" 2>/dev/null | head -1 || echo "")

if [[ -n "$EXISTING_BRAND" ]]; then
  ok "OAuth consent screen already configured"
else
  # The consent screen must be configured via the API or console.
  # gcloud doesn't have a direct command for all consent screen fields.
  # We use the OAuth2 API directly.
  ACCESS_TOKEN=$(gcloud auth print-access-token)

  # Create OAuth brand (consent screen)
  RESPONSE=$(curl -s -X POST \
    "https://iap.googleapis.com/v1/projects/$PROJECT_ID/brands" \
    -H "Authorization: Bearer $ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{
      \"applicationTitle\": \"AutoBot Inbox\",
      \"supportEmail\": \"$USER_EMAIL\"
    }" 2>/dev/null || echo "")

  if echo "$RESPONSE" | grep -q "applicationTitle"; then
    ok "OAuth consent screen created"
  else
    warn "Could not auto-configure consent screen."
    echo ""
    echo "  Configure manually:"
    echo "  https://console.cloud.google.com/apis/credentials/consent?project=$PROJECT_ID"
    echo ""
    echo "  Settings:"
    echo "    App name: AutoBot Inbox"
    echo "    User support email: $USER_EMAIL"
    echo "    App type: External (or Internal if Google Workspace)"
    echo "    Scopes: gmail.readonly, gmail.compose, gmail.modify"
    echo "    Test users: $USER_EMAIL"
    echo ""
    read -rp "  Press Enter after configuring (or Ctrl+C to abort)..."
  fi
fi

# ─── Step 4: Create OAuth credentials ────────────────────────────────────────

info "Step 4: Creating OAuth 2.0 client credentials..."

# Check if credentials already exist
EXISTING_CLIENTS=$(gcloud alpha iap oauth-clients list "projects/$PROJECT_ID/brands/-" --format="value(name)" 2>/dev/null || echo "")

if [[ -n "$EXISTING_CLIENTS" ]]; then
  warn "OAuth clients already exist. Skipping creation."
  echo ""
  echo "  View existing credentials:"
  echo "  https://console.cloud.google.com/apis/credentials?project=$PROJECT_ID"
  echo ""
else
  # Create OAuth client via REST API
  ACCESS_TOKEN=$(gcloud auth print-access-token)

  CRED_RESPONSE=$(curl -s -X POST \
    "https://oauth2.googleapis.com/v1/projects/$PROJECT_ID/oauthClients" \
    -H "Authorization: Bearer $ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{
      \"displayName\": \"AutoBot Inbox\",
      \"allowedGrantTypes\": [\"AUTHORIZATION_CODE\"],
      \"allowedRedirectUris\": [\"http://localhost:3456/callback\"],
      \"allowedScopes\": [
        \"https://www.googleapis.com/auth/gmail.readonly\",
        \"https://www.googleapis.com/auth/gmail.compose\",
        \"https://www.googleapis.com/auth/gmail.modify\"
      ]
    }" 2>/dev/null || echo "")

  # The REST API for creating OAuth clients is not always available.
  # Fall back to console instructions.
  if echo "$CRED_RESPONSE" | grep -q "clientId"; then
    CLIENT_ID=$(echo "$CRED_RESPONSE" | grep -o '"clientId":"[^"]*"' | cut -d'"' -f4)
    CLIENT_SECRET=$(echo "$CRED_RESPONSE" | grep -o '"clientSecret":"[^"]*"' | cut -d'"' -f4)
    ok "OAuth credentials created"
  else
    warn "Auto-creation not available. Creating via console..."
    echo ""
    echo "  1. Go to: https://console.cloud.google.com/apis/credentials?project=$PROJECT_ID"
    echo "  2. Click '+ CREATE CREDENTIALS' → 'OAuth client ID'"
    echo "  3. Application type: Web application"
    echo "  4. Name: AutoBot Inbox"
    echo "  5. Authorized redirect URIs: http://localhost:3456/callback"
    echo "  6. Click 'Create'"
    echo ""
    read -rp "  Paste Client ID: " CLIENT_ID
    read -rp "  Paste Client Secret: " CLIENT_SECRET
    echo ""
  fi
fi

# ─── Step 5: Add test users ──────────────────────────────────────────────────

info "Step 5: Test users"
echo ""
echo "  Your app is in 'Testing' mode. Only listed test users can authorize."
echo "  Add test users at:"
echo "  https://console.cloud.google.com/apis/credentials/consent?project=$PROJECT_ID"
echo ""
echo "  Add these emails as test users:"
echo "    - $USER_EMAIL (you)"

read -rp "  Any other test users? (comma-separated, or Enter to skip): " EXTRA_USERS
echo ""

# ─── Step 6: Write .env ──────────────────────────────────────────────────────

if [[ -n "${CLIENT_ID:-}" && -n "${CLIENT_SECRET:-}" ]]; then
  info "Step 6: Writing credentials to .env..."

  # Create .env from example if it doesn't exist
  if [[ ! -f "$ENV_FILE" ]]; then
    cp "$SCRIPT_DIR/../.env.example" "$ENV_FILE"
  fi

  # Update or append values
  update_env() {
    local key="$1" val="$2"
    if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
      # macOS-compatible sed
      sed -i '' "s|^${key}=.*|${key}=${val}|" "$ENV_FILE"
    else
      echo "${key}=${val}" >> "$ENV_FILE"
    fi
  }

  update_env "GMAIL_CLIENT_ID" "$CLIENT_ID"
  update_env "GMAIL_CLIENT_SECRET" "$CLIENT_SECRET"

  ok "Credentials written to .env"
else
  warn "No credentials captured. Add GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET to .env manually."
fi

# ─── Done ─────────────────────────────────────────────────────────────────────

echo ""
echo "  ╔═══════════════════════════════════════╗"
echo "  ║  Google Cloud setup complete!         ║"
echo "  ╠═══════════════════════════════════════╣"
echo "  ║  Next steps:                          ║"
echo "  ║                                       ║"
echo "  ║  1. npm run setup-gmail               ║"
echo "  ║     (authorize Gmail + get token)     ║"
echo "  ║                                       ║"
echo "  ║  2. npm run bootstrap-voice           ║"
echo "  ║     (import sent emails for voice)    ║"
echo "  ║                                       ║"
echo "  ║  3. npm start                         ║"
echo "  ║     (run for real)                    ║"
echo "  ╚═══════════════════════════════════════╝"
echo ""
