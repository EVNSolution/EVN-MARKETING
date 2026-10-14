FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS nodebin

FROM ubuntu:24.04@sha256:008173c23f95b170204355c12626cb5a965d779a7e1283b09e9cffbb1bf33ca3 AS base
COPY --from=nodebin /usr/local /usr/local
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl \
    && groupmod -n node ubuntu && usermod -l node -d /home/node -m ubuntu \
    && rm -rf /var/lib/apt/lists/*

FROM base AS dependencies
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build
COPY prisma.config.ts tsconfig.json next.config.ts postcss.config.mjs ./
COPY prisma/schema.prisma prisma/schema.prisma
COPY prisma/migrations prisma/migrations
COPY app app
COPY components components
COPY lib lib
COPY workers workers
COPY scripts/warp-delivery.ts scripts/warp-delivery.ts
COPY scripts/warp-recovery.ts scripts/warp-recovery.ts
COPY scripts/ad-spend.ts scripts/ad-spend.ts
COPY scripts/schema-check.mjs scripts/schema-check.mjs
COPY scripts/schema-compatibility.mjs scripts/schema-compatibility.mjs
COPY scripts/landing-schema-policy.json scripts/landing-schema-policy.json
COPY scripts/landing-expansion-audit.mjs scripts/landing-expansion-audit.mjs
COPY scripts/data-backup.mjs scripts/data-backup.mjs
COPY scripts/build-landing-public.mjs scripts/build-landing-public.mjs
COPY previews/evn-landing previews/evn-landing
COPY types types
COPY auth.ts proxy.ts ./
ARG MARKETING_BUILD_REVISION
RUN test -n "$MARKETING_BUILD_REVISION" \
    && node scripts/schema-check.mjs manifest /app "$MARKETING_BUILD_REVISION" /app/schema-manifest.json \
    && chmod 644 /app/schema-manifest.json \
    && printf '1\n' > /app/worker-activation.version \
    && npx prisma generate && DATABASE_URL=file:/tmp/evn-build-placeholder.db npm run build \
    && ./node_modules/.bin/esbuild workers/inquiry-sync.ts --bundle --platform=node --format=esm --packages=external --outfile=worker.mjs \
    && ./node_modules/.bin/esbuild scripts/warp-delivery.ts --bundle --platform=node --format=esm --packages=external --outfile=warp-delivery.mjs \
    && ./node_modules/.bin/esbuild scripts/warp-recovery.ts --bundle --platform=node --format=esm --packages=external --outfile=warp-recovery.mjs \
    && ./node_modules/.bin/esbuild scripts/ad-spend.ts --bundle --platform=node --format=esm --packages=external --outfile=ad-spend.mjs \
    && ./node_modules/.bin/esbuild workers/health.ts --bundle --platform=node --format=esm --packages=external --outfile=worker-health.mjs

FROM dependencies AS migration-dependencies
COPY scripts/migration-dependencies.mjs scripts/migration-dependencies.mjs
RUN node scripts/migration-dependencies.mjs prepare \
    && npm prune --omit=dev --ignore-scripts --offline --no-audit --no-fund \
    && node scripts/migration-dependencies.mjs verify

FROM base AS operations
WORKDIR /app
COPY --from=migration-dependencies /app/node_modules ./node_modules
COPY --from=migration-dependencies /app/package.json /app/package-lock.json ./
COPY prisma.config.ts ./
COPY prisma/schema.prisma prisma/schema.prisma
COPY prisma/migrations prisma/migrations
COPY scripts/schema-check.mjs scripts/schema-compatibility.mjs scripts/landing-schema-policy.json ./scripts/
ARG MARKETING_BUILD_REVISION
RUN node scripts/schema-check.mjs manifest /app "$MARKETING_BUILD_REVISION" /app/schema-manifest.json \
    && chmod 644 /app/schema-manifest.json
USER node
CMD ["npx", "--no-install", "prisma", "migrate", "status"]

FROM base AS browser
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/ms-playwright HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=dependencies /app/node_modules/playwright-core ./node_modules/playwright-core
RUN node node_modules/playwright-core/cli.js install --with-deps chromium \
    && chmod -R a+rX /ms-playwright
# Refresh fixed browser libraries after any cached Chromium dependencies.
# Ubuntu USN-8913-1 fixes CVE-2026-88806 in libx11.
RUN apt-get update \
    && apt-get install -y --no-install-recommends --only-upgrade libpng16-16t64 libx11-6 libx11-data libx11-xcb1 \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' libpng16-16t64)" ge 1.6.43-5ubuntu0.7 \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' libx11-6)" ge 2:1.8.7-1ubuntu0.1 \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' libx11-data)" ge 2:1.8.7-1ubuntu0.1 \
    && rm -rf /var/lib/apt/lists/*
# Chromium resolves download names through the Linux native filesystem encoding.
# The bare Ubuntu C locale can discard Korean names and fall back to "download".
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8

# The controller lab replaces the collector with a synthetic worker. Its image
# uses the exact same application files and base OS, without unused browsers.
FROM base AS application
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /app/app/fonts/licenses ./licenses/fonts
COPY --from=build /app/worker.mjs ./worker.mjs
COPY --from=build /app/worker-health.mjs ./worker-health.mjs
COPY --from=build /app/warp-delivery.mjs ./warp-delivery.mjs
COPY --from=build /app/warp-recovery.mjs ./warp-recovery.mjs
COPY --from=build /app/ad-spend.mjs ./ad-spend.mjs
COPY --from=build /app/scripts/data-backup.mjs ./data-backup.mjs
COPY --from=build /app/scripts/schema-check.mjs ./schema-check.mjs
COPY --from=build /app/scripts/schema-compatibility.mjs ./schema-compatibility.mjs
COPY --from=build /app/scripts/landing-schema-policy.json ./landing-schema-policy.json
COPY --from=build /app/scripts/landing-expansion-audit.mjs ./landing-expansion-audit.mjs
COPY --from=build /app/schema-manifest.json ./schema-manifest.json
COPY --from=build /app/worker-activation.version ./worker-activation.version
COPY --from=build /app/node_modules/dotenv ./node_modules/dotenv
COPY --from=build /app/node_modules/@prisma/adapter-better-sqlite3 ./node_modules/@prisma/adapter-better-sqlite3
COPY --from=build /app/node_modules/@prisma/driver-adapter-utils ./node_modules/@prisma/driver-adapter-utils
COPY --from=build /app/node_modules/@prisma/debug ./node_modules/@prisma/debug
RUN mkdir -p /data/uploads && chown -R node:node /data
USER node
CMD ["node", "server.js"]

FROM browser AS runtime
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000
COPY --from=application /app /app
RUN mkdir -p /data/uploads && chown -R node:node /data
USER node
CMD ["node", "server.js"]
