# Build context: repo root (.)
# Railway: set Root Directory to "/" and Dockerfile path to "autobot-inbox/Dockerfile"
#
# Base: node:20-bookworm-slim (Debian, full glibc). Switched from alpine because
# native modules with FORTIFY_SOURCE (onnxruntime-node) reference glibc-only
# symbols like __vsnprintf_chk that gcompat doesn't implement.

FROM node:20-bookworm-slim AS deps

# Playwright's bundled Chromium is a glibc binary; on Debian it would work,
# but we install Debian's chromium package in the runner stage to keep
# the deps image lean. Skip the postinstall download here.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Install product dependencies
WORKDIR /app/autobot-inbox
COPY autobot-inbox/package*.json ./
RUN npm ci

# Install lib dependencies
WORKDIR /app/lib
COPY lib/package*.json ./
RUN npm ci

# Install agents dependencies
WORKDIR /app/agents
COPY agents/package*.json ./
RUN npm ci

FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV SQL_DIR=/app/autobot-inbox/sql

# System deps:
#  - chromium + nss/fonts/etc.: PDF renderer (lib/contracts/pdf-render.js)
#  - ffmpeg: voice-print enrollment audio decode
# All glibc-native, no shims required.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      libnss3 \
      libfreetype6 \
      libharfbuzz0b \
      ca-certificates \
      fonts-freefont-ttf \
      ffmpeg \
    && rm -rf /var/lib/apt/lists/*
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

RUN groupadd --system --gid 1001 nodejs \
    && useradd --system --uid 1001 --gid 1001 --create-home autobot

# Copy dependencies
COPY --from=deps --chown=autobot:nodejs /app/autobot-inbox/node_modules ./autobot-inbox/node_modules
COPY --from=deps --chown=autobot:nodejs /app/lib/node_modules ./lib/node_modules
COPY --from=deps --chown=autobot:nodejs /app/agents/node_modules ./agents/node_modules

# Copy source
COPY --chown=autobot:nodejs lib/ ./lib/
COPY --chown=autobot:nodejs agents/ ./agents/
COPY --chown=autobot:nodejs autobot-inbox/src/ ./autobot-inbox/src/
# flow-agents was moved here from repo-root flow-agents/ (commit 25bbab0); it is
# imported by autobot-inbox/src/flow-wrappers/index.js. Without this COPY the
# runtime crashes with ERR_MODULE_NOT_FOUND on agents/flow-agents/index.js.
COPY --chown=autobot:nodejs autobot-inbox/agents/ ./autobot-inbox/agents/
COPY --chown=autobot:nodejs autobot-inbox/config/ ./autobot-inbox/config/
COPY --chown=autobot:nodejs autobot-inbox/sql/ ./autobot-inbox/sql/
COPY --chown=autobot:nodejs autobot-inbox/tools/ ./autobot-inbox/tools/
COPY --chown=autobot:nodejs autobot-inbox/package.json ./autobot-inbox/

USER autobot
WORKDIR /app/autobot-inbox
EXPOSE 3001
CMD ["node", "src/index.js"]
