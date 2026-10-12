#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$RUNNER_TEMP/marketing-smoke"
chmod 777 "$RUNNER_TEMP/marketing-smoke"
docker run --rm --network none -v "$PWD:/src:ro" -v "$RUNNER_TEMP/marketing-smoke:/data" evn-marketing:ci node /src/tests/container-smoke.mjs
docker run --rm --network none evn-marketing:ci node worker.mjs
docker run -d --name marketing-smoke --network none -v "$RUNNER_TEMP/marketing-smoke:/data" -v "$PWD:/src:ro" \
  -e AUTH_SECRET=synthetic-ci-only-secret-at-least-32-characters \
  -e AUTH_TRUST_HOST=true -e AUTH_URL=http://127.0.0.1:3100 \
  -e DATABASE_URL=file:/data/marketing.db -e UPLOADS_DIR=/data/uploads \
  -e MARKETING_REVISION=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  -e MARKETING_IMAGE_DIGEST=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
  -e MARKETING_VOLUME_ID=synthetic-volume-ci \
  -e WARP_DELIVERY_ENABLED=false evn-marketing:ci
trap 'docker logs marketing-smoke; docker rm -f marketing-smoke' EXIT
started=false
for _attempt in $(seq 1 30); do
  if docker exec marketing-smoke node -e "fetch('http://127.0.0.1:3000/login').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"; then started=true; break; fi
  sleep 2
done
test "$started" = true
docker exec marketing-smoke node /src/tests/readiness-http.mjs
docker exec marketing-smoke node /src/tests/mvp-browser.mjs
