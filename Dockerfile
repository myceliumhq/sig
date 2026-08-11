# Standalone MCP server image for sig (src/mcp-server.ts) -- see AGENTS.md
# and README's "Standalone MCP server" section.
#
#   docker build -t sig-mcp .
#
# The MCP server is READ-side only: it reads whatever the ingestion daemon
# (`sig daemon`, run separately) has written to the SQLite store, and talks to
# that same daemon's signal-cli JSON-RPC socket to send. Bind-mount both the
# store and the socket from the host where the daemon runs.
#
# Run (stdio, the default transport):
#
#   docker run -i --rm \
#     -e SIGNAL_ACCOUNT=+491700000000 \
#     -e SIGNAL_DB=/data/messages.db \
#     -e SIGNAL_SOCKET=/run/sig/signal-cli.sock \
#     -v /host/state/sig:/data \
#     -v /host/run/sig:/run/sig \
#     sig-mcp
#
# Or Streamable HTTP (loopback-only by default; expose on all interfaces via
# MCP_HOST=0.0.0.0, e.g. behind a reverse proxy on a bridged network). The
# app has NO built-in auth -- only expose non-loopback behind an authenticated
# proxy (Caddy Basic auth), list the proxy's public hostname in
# MCP_ALLOWED_HOSTS (DNS-rebinding protection), and prefer SIGNAL_READ_ONLY.
#
# To keep the account out of plaintext env, SIGNAL_ACCOUNT_FILE takes a path to
# a (Docker-secret) file whose trimmed contents are used instead.

FROM node:22-slim AS build
RUN corepack enable
# Without this, pnpm treats node_modules as stale after the later `COPY . .`
# resets file mtimes (even though content is unchanged) and blocks on an
# interactive re-install confirmation that has no TTY to answer it.
ENV CI=true
WORKDIR /app
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml* ./
RUN pnpm install --frozen-lockfile --prod=false
COPY . .
RUN pnpm run build
RUN pnpm install --frozen-lockfile --prod

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
EXPOSE 3000
USER node
ENTRYPOINT ["node", "dist/mcp-server.js"]
