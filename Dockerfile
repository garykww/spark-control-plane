# Multi-stage build. The DGX Spark is arm64, so build on the Spark itself or
# pass --platform linux/arm64 when building elsewhere.

FROM node:22-alpine AS build
WORKDIR /app

# Dependencies first, so a source-only change reuses the cached install layer.
COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
RUN npm run build


FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# openssh-client drives remote collection; sshpass is only needed for nodes
# configured with a password instead of a key.
RUN apk add --no-cache openssh-client sshpass tini

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
# The run planner's catalogue. Mount over it, or set RECIPES_FILE, to use your own.
COPY recipes.yaml ./recipes.yaml
COPY --from=build /app/dist ./dist

# Node config and encrypted secrets live here; mount a volume to persist them.
RUN mkdir -p /app/config

EXPOSE 5555
ENV PORT=5555 BIND_HOST=0.0.0.0

# tini reaps the ssh child processes the collectors spawn.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/index.js"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5555)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
