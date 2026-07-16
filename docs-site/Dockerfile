# Build context must be the repo root (.) — prebuild.sh reads from autobot-inbox/docs and autobot-spec

FROM node:20-alpine AS deps
WORKDIR /repo/docs-site
COPY docs-site/package*.json ./
RUN npm ci

FROM node:20-alpine AS builder
RUN apk add --no-cache bash
WORKDIR /repo
# Copy only the monorepo parts needed by docs-site/scripts/prebuild.sh
COPY autobot-inbox/docs ./autobot-inbox/docs
COPY autobot-spec ./autobot-spec
COPY docs-site ./docs-site
COPY --from=deps /repo/docs-site/node_modules ./docs-site/node_modules
WORKDIR /repo/docs-site
# Ensure public/ exists so standalone COPY doesn't fail
RUN mkdir -p public && npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 nextjs
COPY --from=builder --chown=nextjs:nodejs /repo/docs-site/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /repo/docs-site/.next/static ./.next/static
USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
CMD ["node", "server.js"]
