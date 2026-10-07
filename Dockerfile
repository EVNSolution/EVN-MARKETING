FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS nodebin

FROM ubuntu:24.04@sha256:008173c23f95b170204355c12626cb5a965d779a7e1283b09e9cffbb1bf33ca3 AS base
COPY --from=nodebin /usr/local /usr/local
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl \
    && groupmod -n node ubuntu && usermod -l node -d /home/node -m ubuntu \
    && rm -rf /var/lib/apt/lists/*

FROM base AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY prisma.config.ts tsconfig.json next.config.ts postcss.config.mjs ./
COPY prisma/schema.prisma prisma/schema.prisma
COPY prisma/migrations prisma/migrations
COPY app app
COPY components components
COPY lib lib
COPY workers workers
COPY scripts/warp-delivery.ts scripts/warp-delivery.ts
COPY scripts/warp-recovery.ts scripts/warp-recovery.ts
COPY scripts/schema-check.mjs scripts/schema-check.mjs
COPY scripts/schema-compatibility.mjs scripts/schema-compatibility.mjs
COPY scripts/landing-schema-policy.json scripts/landing-schema-policy.json
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
    && ./node_modules/.bin/esbuild workers/health.ts --bundle --platform=node --format=esm --packages=external --outfile=worker-health.mjs

FROM base AS operations
WORKDIR /app
COPY --from=build /app ./
USER node
CMD ["npx", "--no-install", "prisma", "migrate", "status"]

FROM base AS runtime
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/ms-playwright HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build /app/node_modules/playwright-core ./node_modules/playwright-core
RUN node node_modules/playwright-core/cli.js install --with-deps chromium \
    && chmod -R a+rX /ms-playwright
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /app/app/fonts/licenses ./licenses/fonts
COPY --from=build /app/worker.mjs ./worker.mjs
COPY --from=build /app/worker-health.mjs ./worker-health.mjs
COPY --from=build /app/warp-delivery.mjs ./warp-delivery.mjs
COPY --from=build /app/warp-recovery.mjs ./warp-recovery.mjs
COPY --from=build /app/scripts/data-backup.mjs ./data-backup.mjs
COPY --from=build /app/scripts/schema-check.mjs ./schema-check.mjs
COPY --from=build /app/scripts/schema-compatibility.mjs ./schema-compatibility.mjs
COPY --from=build /app/scripts/landing-schema-policy.json ./landing-schema-policy.json
COPY --from=build /app/schema-manifest.json ./schema-manifest.json
COPY --from=build /app/worker-activation.version ./worker-activation.version
COPY --from=build /app/node_modules/dotenv ./node_modules/dotenv
COPY --from=build /app/node_modules/@prisma/adapter-better-sqlite3 ./node_modules/@prisma/adapter-better-sqlite3
COPY --from=build /app/node_modules/@prisma/driver-adapter-utils ./node_modules/@prisma/driver-adapter-utils
COPY --from=build /app/node_modules/@prisma/debug ./node_modules/@prisma/debug
RUN mkdir -p /data/uploads && chown -R node:node /data
USER node
CMD ["node", "server.js"]
