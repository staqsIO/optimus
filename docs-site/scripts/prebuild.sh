#!/usr/bin/env bash
# Sync documentation from autobot-inbox/docs and autobot-spec into content/docs/
# Runs as predev and prebuild hook (see package.json)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DOCS_SITE="$(dirname "$SCRIPT_DIR")"
REPO_ROOT="$(dirname "$DOCS_SITE")"

echo "[prebuild] Syncing documentation content..."

# Clean and recreate content directory
rm -rf "$DOCS_SITE/content/docs"
mkdir -p "$DOCS_SITE/content/docs"

# Copy autobot-inbox docs (external + internal sections)
cp -r "$REPO_ROOT/autobot-inbox/docs/external" "$DOCS_SITE/content/docs/external"
cp -r "$REPO_ROOT/autobot-inbox/docs/internal" "$DOCS_SITE/content/docs/internal"

# Copy autobot-spec as the spec section
mkdir -p "$DOCS_SITE/content/docs/spec"
cp "$REPO_ROOT/autobot-spec/SPEC.md" "$DOCS_SITE/content/docs/spec/"
cp "$REPO_ROOT/autobot-spec/CHANGELOG.md" "$DOCS_SITE/content/docs/spec/"
cp "$REPO_ROOT/autobot-spec/ONBOARDING.md" "$DOCS_SITE/content/docs/spec/"
cp "$REPO_ROOT/autobot-spec/meta.json" "$DOCS_SITE/content/docs/spec/meta.json"
cp -r "$REPO_ROOT/autobot-spec/agents" "$DOCS_SITE/content/docs/spec/agents"
cp -r "$REPO_ROOT/autobot-spec/decisions" "$DOCS_SITE/content/docs/spec/decisions"
cp -r "$REPO_ROOT/autobot-spec/research-questions" "$DOCS_SITE/content/docs/spec/research-questions"
cp -r "$REPO_ROOT/autobot-spec/open-questions" "$DOCS_SITE/content/docs/spec/open-questions"

# Copy top-level meta.json
cp "$DOCS_SITE/content-meta.json" "$DOCS_SITE/content/docs/meta.json"

echo "[prebuild] Content sync complete."
