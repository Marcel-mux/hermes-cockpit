# syntax=docker/dockerfile:1

# ------------------------------------------------------------------------------
# Stage 1: Build React Native Web / Expo PWA Bundle
# ------------------------------------------------------------------------------
FROM node:22-alpine AS builder

WORKDIR /app

# Install build dependencies
COPY package*.json ./
RUN npm ci

# Copy sources and build web dist
COPY . .
RUN npm run build:web

# ------------------------------------------------------------------------------
# Stage 2: Minimal Production Runtime (Zero External Dependencies)
# ------------------------------------------------------------------------------
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production \
    PORT=8088 \
    HOST=0.0.0.0 \
    HERMES_HOST=127.0.0.1 \
    HERMES_PORT=9119 \
    HERMES_PROFILE=hermes-cockpit

# server.mjs is purely powered by Node.js built-ins (http, net, zlib, node:sqlite)
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server.mjs ./server.mjs
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/web ./web
COPY --from=builder /app/package.json ./package.json

EXPOSE 8088

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:${PORT}/ || exit 1

CMD ["node", "server.mjs"]
