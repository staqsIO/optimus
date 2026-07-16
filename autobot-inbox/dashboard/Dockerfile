FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# NEXT_PUBLIC_* vars are inlined at build time by Next.js.
# Pass via Railway service variables with the same names — Railway
# automatically exposes service variables as both build and runtime env vars.
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_BASE_URL

# Ensure public/ exists so standalone copy doesn't fail
RUN mkdir -p public && npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 nextjs
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3100
ENV PORT=3100
ENV HOSTNAME="0.0.0.0"
CMD ["node", "server.js"]
