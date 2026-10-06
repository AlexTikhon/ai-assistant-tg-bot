# Production image of the Telegram RAG bot.
#
#   docker build -t telegram-rag-bot .
#   docker run -d --name rag-bot --init --restart unless-stopped --env-file .env -v rag-bot-data:/data telegram-rag-bot
#
# Debian slim, not Alpine: better-sqlite3 is a native module with prebuilt binaries for glibc. On musl it would have to be
# compiled, which is slower, larger and a frequent source of build failures; the glibc prebuild just works.
# The Node major version is the one the project is tested with (see "engines" in package.json and .github/workflows/ci.yml).

# ---- build: all dependencies from the lockfile, compile TypeScript, then drop the development dependencies ----
FROM node:24-bookworm-slim AS build
WORKDIR /app

# Only needed if no prebuilt better-sqlite3 binary exists for the platform (it then compiles); not part of the final image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build \
    && npm prune --omit=dev \
    && npm cache clean --force

# ---- runtime: compiled code and production dependencies only ----
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    DATA_DIR=/data
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# One data root: the SQLite database (/data/app.db) and the uploaded originals (/data/files). It is a volume so that nothing
# important lives in the container's own filesystem, and it belongs to the unprivileged user the bot runs as.
# No secret is baked in: TELEGRAM_BOT_TOKEN and OPENAI_API_KEY are passed at run time (--env-file / -e / compose).
RUN mkdir -p /data && chown node:node /data && chmod 700 /data
VOLUME ["/data"]

USER node

# The bot stops polling, finishes the updates in flight and closes the database on SIGTERM (docker stop), within 15 seconds.
STOPSIGNAL SIGTERM

# Telegram long polling is the only thing this process does: there is no HTTP port and so no HEALTHCHECK (see docs/operations.md).
CMD ["node", "--enable-source-maps", "dist/index.js"]
