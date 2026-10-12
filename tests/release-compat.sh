#!/usr/bin/env bash
set -euo pipefail
# CI-only, no published app ports and no external network for app/proxy/browser containers.
# The required unchanged-schema bridge. Rebuild its actual committed application.
# This commit must pass its own CI and be deployed before this feature release.
release_a=d6d7df889f1a1ca52769a1615e352034f09c3bb8
release_b="${GITHUB_SHA:?}"
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
docker image inspect evn-marketing:proxy-ci >/dev/null
mkdir "$compat_dir/previous"
git archive "$release_a" | tar -x -C "$compat_dir/previous"
test "$(docker image inspect evn-marketing:compat-a --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = "$release_a"
# Read the capability from the real image; never manufacture it for an old image.
docker run --rm --network none --entrypoint cat evn-marketing:compat-a /app/schema-manifest.json > "$compat_dir/previous-manifest.json"
chmod 644 "$compat_dir/previous-manifest.json"
docker network create --internal marketing-compat
# Begin with the baseline database and the bridge's exact synthetic fixture.
mkdir "$compat_dir/previous/node_modules"
docker run --rm --network none -v "$compat_dir/previous:/src:ro" -v "$PWD/node_modules:/src/node_modules:ro" -v "$compat_dir/data:/data" evn-marketing:compat-a node /src/tests/release-setup.mjs
# Restore a coherent offline bundle before all existing real browser checks.
mkdir "$compat_dir/rehearsal" "$compat_dir/restored"
chmod 777 "$compat_dir/rehearsal" "$compat_dir/restored"
docker run --rm --network none -v "$compat_dir/data:/data" -v "$compat_dir/rehearsal:/rehearsal" \
  evn-marketing:compat-a node data-backup.mjs snapshot /data /rehearsal/backup > "$compat_dir/rehearsal/snapshot-result.json"
summary_hash="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).summarySha256)' "$compat_dir/rehearsal/snapshot-result.json")"
docker run --rm --network none -v "$compat_dir/rehearsal/backup:/backup:ro" -v "$compat_dir/restored:/restore" \
  evn-marketing:compat-a node data-backup.mjs restore /backup /restore "$summary_hash" > "$compat_dir/rehearsal/restore-result.json"
docker run --rm --network none -v "$compat_dir/restored:/data" evn-marketing:compat-a node data-backup.mjs audit /data > "$compat_dir/rehearsal/before.json"
docker run --rm --network none -v "$compat_dir/restored:/data" -e DATABASE_URL=file:/data/marketing.db \
  evn-marketing:ops npx --no-install prisma migrate deploy
docker run --rm --network none -v "$compat_dir/restored:/data" evn-marketing:ci node data-backup.mjs audit /data > "$compat_dir/rehearsal/after.json"
docker run --rm --network none -v "$compat_dir/restored:/data" -v "$compat_dir/rehearsal:/rehearsal" \
  evn-marketing:ci node data-backup.mjs snapshot /data /rehearsal/expanded > "$compat_dir/rehearsal/expanded-result.json"
docker run --rm --network none -v "$PWD:/src:ro" -v "$compat_dir/rehearsal:/rehearsal:ro" \
  evn-marketing:ci node /src/tests/landing-migration-preservation.mjs /rehearsal/backup /rehearsal/expanded
docker run --rm --network none --entrypoint cat evn-marketing:ci /app/schema-manifest.json > "$compat_dir/current-manifest.json"
chmod 644 "$compat_dir/current-manifest.json"
# Exercise the actual bridge checker for rollback and self-recovery on expanded data.
docker run --rm --network none -v "$compat_dir/restored:/data" -v "$compat_dir/current-manifest.json:/candidate.json:ro" \
  -e DATABASE_URL=file:/data/marketing.db evn-marketing:compat-a node schema-check.mjs check schema-manifest.json /candidate.json
docker run --rm --network none -v "$compat_dir/restored:/data" \
  -e DATABASE_URL=file:/data/marketing.db evn-marketing:compat-a node schema-check.mjs check schema-manifest.json schema-manifest.json
cp "$compat_dir/data/.marketing-volume-id" "$compat_dir/restored/.marketing-volume-id"
mv "$compat_dir/data" "$compat_dir/original"
mv "$compat_dir/restored" "$compat_dir/data"
docker run --rm --network none -v "$compat_dir/data:/data" -v "$compat_dir/previous-manifest.json:/previous.json:ro" \
  -e DATABASE_URL=file:/data/marketing.db evn-marketing:ci node schema-check.mjs check schema-manifest.json /previous.json
for slot in blue green; do
  image=evn-marketing:compat-a
  revision="$release_a"
  if [ "$slot" = green ]; then image=evn-marketing:ci; revision="$release_b"; fi
  docker run -d --name "marketing-compat-$slot" --network marketing-compat --network-alias "$slot" \
    -v "$compat_dir/data:/data" \
    -e AUTH_SECRET=synthetic-compat-secret-at-least-32-characters \
    -e AUTH_TRUST_HOST=true -e AUTH_URL=http://proxy:8080 \
    -e DATABASE_URL=file:/data/marketing.db -e UPLOADS_DIR=/data/uploads \
    -e MARKETING_REVISION="$revision" -e MARKETING_VOLUME_ID=synthetic-compat-volume \
    -e MARKETING_IMAGE_DIGEST=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
    -e WARP_DELIVERY_ENABLED=false "$image"
done
# Chromium can leave speculative sockets with no HTTP headers. Bound only their
# idle lifetime in this fixture; request-body/read/drain deadlines stay unchanged.
node --input-type=module - "$compat_dir" "$release_a" <<'NODE'
import { writeFileSync } from 'node:fs';
import { renderNginx } from './deploy/nginx-config.mjs';
writeFileSync(`${process.argv[2]}/nginx/nginx.conf`, renderNginx({ active: { id: process.argv[3], slot: 'blue' } }).replace('http {', 'http {\n  client_header_timeout 5s;'));
NODE
docker run -d --name marketing-compat-proxy --network marketing-compat --network-alias proxy \
  -v "$compat_dir/nginx:/etc/nginx:ro" evn-marketing:proxy-ci nginx -g 'daemon off;'
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
writeFileSync(`${directory}/nginx/next.conf`, renderNginx({ active: { id: b, slot: 'green' }, previous }).replace('http {', 'http {\n  client_header_timeout 5s;'));
renameSync(`${directory}/nginx/next.conf`, `${directory}/nginx/nginx.conf`);
NODE
  docker exec marketing-compat-proxy nginx -t
  # Reload is asynchronous. Existing browser connections can still reach old workers.
  # Acknowledge switch/expiry only after they drain; never retry a failed browser assertion.
  python3 - "$phase" <<'PY'
import subprocess, sys, time
def workers():
    command = "for p in /proc/[0-9]*/cmdline; do case $(tr '\\0' ' ' < \"$p\") in 'nginx: worker process'*) echo \"$p\";; esac; done"
    return set(subprocess.check_output(['docker','exec','marketing-compat-proxy','sh','-c',command],text=True).splitlines())
old = workers()
subprocess.run(['docker','exec','marketing-compat-proxy','nginx','-s','reload'],check=True)
deadline = time.monotonic() + (120 if sys.argv[1] == 'expire' else 20)
while old & workers():
    if time.monotonic() >= deadline: raise RuntimeError('compatibility proxy drain timed out')
    time.sleep(0.2)
PY
  touch "$compat_dir/control/$phase.done"
done
result="$(docker wait marketing-compat-test)"
docker logs marketing-compat-test
test "$result" = 0
python3 - "$compat_dir" <<'PY'
import json, os, pathlib, subprocess
directory = pathlib.Path(os.sys.argv[1])
peaks = json.loads((directory/'control/browser-memory.json').read_text())
for slot in ('blue','green'):
    name = 'marketing-compat-' + slot
    peaks[slot] = int(subprocess.check_output(['docker','exec',name,'cat','/sys/fs/cgroup/memory.peak'],text=True))
for name in ('marketing-compat-blue','marketing-compat-green','marketing-compat-test'):
    state = json.loads(subprocess.check_output(['docker','inspect',name],text=True))[0]['State']
    assert not state['OOMKilled']
assert all(value > 0 for value in peaks.values())
summary = {'ok':True,'synthetic':True,'sourceSha':os.environ['GITHUB_SHA'],
           'restore':json.loads((directory/'rehearsal/restore-result.json').read_text()),
           'migrationUnchanged':False,'landingExpansionRehearsed':True,'existingDataPreserved':True,
           'bridgeRollbackSchemaVerified':True,'restoredBrowserChecks':True,
           'componentPeakBytes':peaks,'sumOfComponentPeaksBytes':sum(peaks.values()),
           'measurement':'cgroup-v2 high-water sum; not simultaneous usage or production sizing',
           'runtimeImage':subprocess.check_output(['docker','image','inspect','evn-marketing:ci','--format','{{.Id}}'],text=True).strip(),
           'opsImage':subprocess.check_output(['docker','image','inspect','evn-marketing:ops','--format','{{.Id}}'],text=True).strip()}
(pathlib.Path(os.environ['RUNNER_TEMP'])/'marketing-recovery-summary.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps(summary))
PY
docker run --rm --network none -v "$compat_dir/data:/data" -v "$compat_dir/previous-manifest.json:/previous.json:ro" \
  -e DATABASE_URL=file:/data/marketing.db evn-marketing:ci node schema-check.mjs check schema-manifest.json /previous.json
docker rm -f marketing-compat-blue
docker exec marketing-compat-proxy nginx -t
docker restart marketing-compat-proxy
active_only=false
for attempt in $(seq 1 30); do
  if docker exec marketing-compat-green node -e "fetch('http://proxy:8080/api/readyz').then(async r => process.exit(r.ok && (await r.json()).revision === process.env.MARKETING_REVISION ? 0 : 1)).catch(() => process.exit(1))"; then active_only=true; break; fi
  sleep 1
done
test "$active_only" = true
