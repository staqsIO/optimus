#!/usr/bin/env bash
# Sync documentation from autobot-inbox/docs and autobot-spec into content/docs/
# Runs as predev and prebuild hook (see package.json)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DOCS_SITE="$(dirname "$SCRIPT_DIR")"
REPO_ROOT="$(dirname "$DOCS_SITE")"

# Spec workspace: renamed autobot-spec/ -> spec/ in the monorepo. The Docker
# image still mounts ./spec at /repo/autobot-spec, so accept either path.
SPEC_SRC="$REPO_ROOT/spec"
[ -d "$SPEC_SRC" ] || SPEC_SRC="$REPO_ROOT/autobot-spec"

echo "[prebuild] Syncing documentation content..."

# Clean and recreate content directory
rm -rf "$DOCS_SITE/content/docs"
mkdir -p "$DOCS_SITE/content/docs"

# Copy autobot-inbox docs (external + internal sections)
cp -r "$REPO_ROOT/autobot-inbox/docs/external" "$DOCS_SITE/content/docs/external"
cp -r "$REPO_ROOT/autobot-inbox/docs/internal" "$DOCS_SITE/content/docs/internal"

# Copy the spec workspace as the spec section
mkdir -p "$DOCS_SITE/content/docs/spec"
# SPEC.md (~150KB, ~300 headings) OOMs the Next.js page renderer (unbounded
# memory growth in the docs page machinery even though the markdown itself
# compiles and renders fine standalone). Ship a stub that links to the source
# file instead of syncing the full document.
cat > "$DOCS_SITE/content/docs/spec/SPEC.md" <<'EOF'
# Architecture Specification (SPEC.md)

The full specification (~150 KB) is too large for the docs renderer and is
not synced into this site.

Read it in the repository: [`spec/SPEC.md`](https://github.com/staqsIO/optimus/blob/main/spec/SPEC.md)

Companion documents in this section — agent definitions, architectural
decisions, research questions, and the changelog — are synced in full.
EOF
cp "$SPEC_SRC/CHANGELOG.md" "$DOCS_SITE/content/docs/spec/"
cp "$SPEC_SRC/ONBOARDING.md" "$DOCS_SITE/content/docs/spec/"
cp "$SPEC_SRC/meta.json" "$DOCS_SITE/content/docs/spec/meta.json"
cp -r "$SPEC_SRC/agents" "$DOCS_SITE/content/docs/spec/agents"
cp -r "$SPEC_SRC/decisions" "$DOCS_SITE/content/docs/spec/decisions"
cp -r "$SPEC_SRC/research-questions" "$DOCS_SITE/content/docs/spec/research-questions"
cp -r "$SPEC_SRC/open-questions" "$DOCS_SITE/content/docs/spec/open-questions"

# Copy top-level meta.json
cp "$DOCS_SITE/content-meta.json" "$DOCS_SITE/content/docs/meta.json"

echo "[prebuild] Content sync complete."
