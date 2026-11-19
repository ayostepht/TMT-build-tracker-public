# syntax=docker/dockerfile:1
# Base image pinned by digest (node:22-bookworm-slim); bump it deliberately to take Node/Debian updates.
FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS builder
WORKDIR /app
# No native build tools: every dependency is pure JavaScript or WebAssembly (postgres-js, occt-import-js).
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# Kit packs (MakeGood's converted files, CC0, plus jeepxj's one-piece push handle, CC BY-NC): fetched and sha256-verified against
# kitpacks/index.json. A pack file in the build context's kitpacks/ is used as is (local
# builds). In CI the release asset is read through the GitHub API with the build secret
# gh_token (`--secret id=gh_token,...`; needed only for a private fork, the plain release URL works
# on the public repository). If the download fails the build fails,
# unless --build-arg KITPACK_OPTIONAL=1 (the app then tries again at first start).
FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS kitpack
ARG KITPACK_URL=""
ARG KITPACK_OPTIONAL=0
ARG KITPACK_REPO=ayostepht/TMT-Build-Tracker
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY scripts/fetch-kitpacks.sh /usr/local/bin/fetch-kitpacks
COPY kitpacks /kitpacks-context
RUN --mount=type=secret,id=gh_token,required=false \
    KITPACK_URL="$KITPACK_URL" KITPACK_OPTIONAL="$KITPACK_OPTIONAL" KITPACK_REPO="$KITPACK_REPO" \
    GH_TOKEN_FILE=/run/secrets/gh_token \
    fetch-kitpacks /kitpacks-context/index.json /kitpacks-context /kitpacks

FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS runtime
# Hosted-site image. Settings that belong to the host (DATABASE_URL, BETTER_AUTH_SECRET, PUBLIC_URL,
# ADMIN_EMAILS, OAuth keys) are never baked in: set them in the host's secret store.
# BODY_SIZE_LIMIT / MAX_3MF_MB: Cloudflare's free plan refuses request bodies over 100 MB, so a
# 3MF is capped at 95 MB and the body limit sits just above it (the server warns if it is lower).
ENV NODE_ENV=production \
    BODY_SIZE_LIMIT=100M \
    MAX_3MF_MB=95 \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    KITPACK_DIR=/app/kitpacks
WORKDIR /app
RUN mkdir -p /data && chown node:node /data
COPY --from=builder --chown=node:node /app/build ./build
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/package.json ./package.json
COPY --from=builder --chown=node:node /app/drizzle ./drizzle
COPY --from=builder --chown=node:node /app/scripts/proxy-origin.mjs /app/scripts/response-defaults.mjs /app/scripts/import-print-geometry.mjs /app/scripts/build-kit-pack.mjs ./scripts/
COPY --from=kitpack --chown=node:node /kitpacks ./kitpacks
# Non-root. A volume mounted at /data must be writable by uid 1000 (the node user).
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "./scripts/proxy-origin.mjs", "build"]
