# syntax=docker/dockerfile:1
# Build from the repository root: docker build -f apps/relay/Dockerfile -t caxri-relay .
# `Dockerfile.dockerignore` beside this file limits the context to the Relay and the one package it imports.

FROM node:24-slim AS build
WORKDIR /repo
COPY mise.toml ./
# mise.toml owns the pnpm version, so the image cannot drift from local and CI installs.
RUN pnpm_version="$(sed -n 's/^pnpm = "\(.*\)"$/\1/p' mise.toml)" && test -n "$pnpm_version" && \
    npm install --global --no-fund --no-audit "pnpm@$pnpm_version" bun@1.4.4
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY packages/mobile-transport/package.json ./packages/mobile-transport/
COPY apps/relay/package.json ./apps/relay/
# The lockfile is the only resolver; the filter installs just the Relay and its workspace dependency.
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter @caxri/relay...
COPY packages/mobile-transport ./packages/mobile-transport
COPY apps/relay ./apps/relay
RUN cd apps/relay && bun run build

# The bundle inlines every dependency, so the runtime image carries no node_modules.
FROM node:24-slim
ENV NODE_ENV=production CAXRI_RELAY_PORT=8080
WORKDIR /app
COPY --from=build /repo/apps/relay/dist/relay.mjs ./relay.mjs
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.CAXRI_RELAY_PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
STOPSIGNAL SIGTERM
CMD ["node", "relay.mjs"]
