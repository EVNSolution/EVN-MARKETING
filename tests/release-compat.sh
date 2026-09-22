#!/usr/bin/env bash
set -euo pipefail
# CI-only, no published app ports and no external network for app/proxy/browser containers.
release_a="${GITHUB_SHA:?}"
release_b=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
compat_dir="$(mktemp -d "${RUNNER_TEMP:-/tmp}/marketing-compat.XXXXXX")"
chmod 777 "$compat_dir"
mkdir "$compat_dir/data" "$compat_dir/control" "$compat_dir/nginx"
chmod 777 "$compat_dir/data" "$compat_dir/control"
cleanup() {
  if [ "$?" -ne 0 ]; then
    for slot in blue green proxy; do docker logs --tail 40 "marketing-compat-$slot" 2>&1 || true; done
    docker exec marketing-compat-blue node -e "fetch('http://127.0.0.1:3000/api/readyz').then(async r => console.log('direct readiness:', r.status, await r.text())).catch(e => console.log(e.message))" || true
  fi
  docker rm -f marketing-compat-test marketing-compat-proxy marketing-compat-blue marketing-compat-green >/dev/null 2>&1 || true
  docker network rm marketing-compat >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker pull nginx:1.28-alpine
docker build --build-arg MARKETING_BUILD_REVISION="$release_b" -t evn-marketing:compat-b .
docker network create --internal marketing-compat
docker run --rm --network none -v "$PWD:/src:ro" -v "$compat_dir/data:/data" evn-marketing:ci node /src/tests/release-setup.mjs
for slot in blue green; do
  image=evn-marketing:ci
  revision="$release_a"
  if [ "$slot" = green ]; then image=evn-marketing:compat-b; revision="$release_b"; fi
  docker run -d --name "marketing-compat-$slot" --network marketing-compat --network-alias "$slot" \
    -v "$compat_dir/data:/data" \
    -e AUTH_SECRET=synthetic-compat-secret-at-least-32-characters \
    -e AUTH_TRUST_HOST=true -e AUTH_URL=http://proxy:8080 \
    -e DATABASE_URL=file:/data/marketing.db -e UPLOADS_DIR=/data/uploads \
    -e MARKETING_REVISION="$revision" -e MARKETING_VOLUME_ID=synthetic-compat-volume \
    -e MARKETING_IMAGE_DIGEST=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
    -e WARP_DELIVERY_ENABLED=false "$image"
done
node --input-type=module - "$compat_dir" "$release_a" <<'NODE'
import { writeFileSync } from 'node:fs';
import { renderNginx } from './deploy/nginx-config.mjs';
writeFileSync(`${process.argv[2]}/nginx/nginx.conf`, renderNginx({ active: { id: process.argv[3], slot: 'blue' } }));
NODE
docker run -d --name marketing-compat-proxy --network marketing-compat --network-alias proxy \
  -v "$compat_dir/nginx:/etc/nginx:ro" nginx:1.28-alpine nginx -g 'daemon off;'
docker exec marketing-compat-proxy nginx -t
docker run -d --name marketing-compat-test --network marketing-compat \
  -v "$PWD:/src:ro" -v "$compat_dir/data:/data" -v "$compat_dir/control:/control" \
  -e RELEASE_A="$release_a" -e RELEASE_B="$release_b" evn-marketing:ci node /src/tests/release-browser.mjs
for phase in switch expire; do
  reached=false
  for attempt in $(seq 1 900); do
    if [ "$(docker inspect -f '{{.State.Running}}' marketing-compat-test)" != true ]; then
      docker logs marketing-compat-test
      exit 1
    fi
    if [ -f "$compat_dir/control/$phase" ]; then reached=true; break; fi
    sleep 0.2
  done
  test "$reached" = true
  node --input-type=module - "$compat_dir" "$release_a" "$release_b" "$phase" <<'NODE'
import { writeFileSync, renameSync } from 'node:fs';
import { renderNginx } from './deploy/nginx-config.mjs';
const [directory, a, b, phase] = process.argv.slice(2);
const previous = { id: a, slot: 'blue', expiresAt: phase === 'switch' ? Date.now() + 30 * 60_000 : Date.now() - 1 };
writeFileSync(`${directory}/nginx/next.conf`, renderNginx({ active: { id: b, slot: 'green' }, previous }));
renameSync(`${directory}/nginx/next.conf`, `${directory}/nginx/nginx.conf`);
NODE
  docker exec marketing-compat-proxy nginx -t
  docker exec marketing-compat-proxy nginx -s reload
  touch "$compat_dir/control/$phase.done"
done
result="$(docker wait marketing-compat-test)"
docker logs marketing-compat-test
test "$result" = 0
docker rm -f marketing-compat-blue
docker exec marketing-compat-proxy nginx -t
docker restart marketing-compat-proxy
active_only=false
for attempt in $(seq 1 30); do
  if docker exec marketing-compat-green node -e "fetch('http://proxy:8080/api/readyz').then(async r => process.exit(r.ok && (await r.json()).revision === process.env.MARKETING_REVISION ? 0 : 1)).catch(() => process.exit(1))"; then active_only=true; break; fi
  sleep 1
done
test "$active_only" = true
