#!/usr/bin/env bash
#
# Optimus Runner — Setup Checker
# Run on a new machine to verify all prerequisites are installed.
#
# Usage: bash scripts/setup-runner.sh
#

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

PASS=0
FAIL=0
WARN=0

pass() { echo -e "  ${GREEN}[PASS]${NC} $1"; PASS=$((PASS + 1)); }
fail() { echo -e "  ${RED}[FAIL]${NC} $1"; FAIL=$((FAIL + 1)); }
warn() { echo -e "  ${YELLOW}[WARN]${NC} $1"; WARN=$((WARN + 1)); }

echo ""
echo "Optimus Runner — Setup Check"
echo "============================"
echo ""

# 1. Node.js >= 20
echo "Prerequisites:"
if command -v node &> /dev/null; then
  NODE_VERSION=$(node --version | sed 's/v//')
  NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
  if [ "$NODE_MAJOR" -ge 20 ]; then
    pass "Node.js $NODE_VERSION"
  else
    fail "Node.js $NODE_VERSION (need >= 20.0.0)"
  fi
else
  fail "Node.js not found (install: https://nodejs.org/)"
fi

# 2. Git
if command -v git &> /dev/null; then
  GIT_VERSION=$(git --version | awk '{print $3}')
  pass "Git $GIT_VERSION"
else
  fail "Git not found (install: https://git-scm.com/)"
fi

# 3. GitHub CLI
if command -v gh &> /dev/null; then
  GH_VERSION=$(gh --version | head -1 | awk '{print $3}')
  pass "GitHub CLI $GH_VERSION"

  # Check gh auth
  if gh auth status &> /dev/null; then
    pass "GitHub CLI authenticated"
  else
    fail "GitHub CLI not authenticated (run: gh auth login)"
  fi
else
  fail "GitHub CLI not found (install: https://cli.github.com/)"
fi

# 4. Claude Code CLI
if command -v claude &> /dev/null; then
  pass "Claude Code CLI found"
else
  fail "Claude Code CLI not found (install: https://docs.anthropic.com/en/docs/claude-code)"
  echo "         Requires Claude Max subscription for runner billing"
fi

echo ""
echo "Configuration:"

# 5. .env file
if [ -f .env ]; then
  pass ".env file exists"

  # 6. DATABASE_URL
  if grep -q "^DATABASE_URL=" .env 2>/dev/null; then
    DB_URL=$(grep "^DATABASE_URL=" .env | cut -d= -f2-)
    if [ "$DB_URL" != "postgresql://autobot:password@your-db-host:5432/autobot" ]; then
      pass "DATABASE_URL configured"
    else
      fail "DATABASE_URL is still the placeholder — update it"
    fi
  else
    fail "DATABASE_URL not set in .env (required for runner mode)"
  fi
else
  fail ".env file not found (copy .env.runner.example to .env)"
fi

# 7. npm dependencies
if [ -d node_modules ]; then
  pass "node_modules installed"
else
  warn "node_modules not found (run: npm install)"
fi

echo ""
echo "Connectivity:"

# 8. Database connectivity
if [ -f .env ] && grep -q "^DATABASE_URL=" .env 2>/dev/null; then
  DB_URL=$(grep "^DATABASE_URL=" .env | cut -d= -f2-)
  if DATABASE_URL="$DB_URL" node -e "
    import('pg').then(async ({default: pg}) => {
      const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
      await pool.query('SELECT 1');
      await pool.end();
      process.exit(0);
    }).catch(() => process.exit(1));
  " 2>/dev/null; then
    pass "Database connection successful"
  else
    fail "Database connection failed — check DATABASE_URL and network"
  fi
else
  warn "Skipping DB check (no DATABASE_URL)"
fi

# 9. GitHub repo access
if command -v gh &> /dev/null && gh auth status &> /dev/null; then
  if gh repo view staqsIO/optimus --json name &> /dev/null; then
    pass "GitHub repo access (staqsIO/optimus)"
  else
    fail "Cannot access staqsIO/optimus — check permissions"
  fi
fi

echo ""
echo "──────────────────────────────────"
echo -e "  ${GREEN}Passed: $PASS${NC}  ${RED}Failed: $FAIL${NC}  ${YELLOW}Warnings: $WARN${NC}"
echo "──────────────────────────────────"

if [ $FAIL -gt 0 ]; then
  echo ""
  echo "Fix the failures above, then run this script again."
  echo "Once all checks pass: npm run runner"
  exit 1
else
  echo ""
  echo "All checks passed! Start the runner with: npm run runner"
fi
