import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// Only these two private upstreams exist. Request values never become hostnames or paths.
export function renderNginx({ active, previous = null }, now = Date.now()) {
  const valid = item => item && /^[0-9a-f]{40}$/.test(item.id) && ['blue', 'green'].includes(item.slot)
  if (!valid(active) || (previous && (!valid(previous) || previous.id === active.id || previous.slot === active.slot
    || !Number.isSafeInteger(previous.expiresAt) || previous.expiresAt > now + 30 * 60_000))) throw new Error('invalid_release_mapping')
  const releases = [active, ...(previous && previous.expiresAt > now ? [previous] : [])]
  const identities = releases.flatMap(({ id }) => [`"${id}:" ${id};`, `":${id}" ${id};`, `"${id}:${id}" ${id};`]).join('\n    ')
  const slots = releases.map(({ id, slot }) => `"1:${id}:0" ${slot};`).join('\n    ')
  return `worker_processes 1;
events { worker_connections 256; }
http {
  access_log off;
  server_tokens off;
  ${releases.map(({ slot }) => `upstream ${slot} { server ${slot}:3000; }`).join('\n  ')}
  map "$arg_dpl:$http_x_deployment_id" $marketing_id {
    default invalid;
    ":" missing;
    ${identities}
  }
  map $args $duplicate_dpl {
    default 0;
    "~*(^|&)dpl=[^&]*&([^&]*&)*dpl=" 1;
  }
  map $uri $version_path {
    default 0;
    ~^/_next/static/ 1;
    /api/release 1;
  }
  map "$request_method:$uri" $version_write {
    default 0;
    "~^POST:/(?!api/)" 1;
    "~^(POST|PUT|PATCH|DELETE):/api/(customers|inquiries)(/|$)" 1;
  }
  map "$version_path:$version_write:$http_rsc:$http_next_action" $version_required {
    "0:0::" 0;
    default 1;
  }
  map "$version_required:$marketing_id:$duplicate_dpl" $marketing_slot {
    default rejected;
    ~^0: ${active.slot};
    ${slots}
  }
  map "$request_method:$http_accept:$version_required" $release_cookie {
    default "";
    "~^GET:.*text/html.*:0$" "marketing_release=${active.id}; Path=/; Max-Age=1800; HttpOnly; SameSite=Lax; Secure";
  }
  map $http_accept $release_error_type {
    default "application/json; charset=utf-8";
    "~*text/html" "text/html; charset=utf-8";
  }
  map $http_accept $release_error_body {
    default '{"code":"release_expired","error":"화면을 새로고침한 뒤 다시 시도해 주세요."}';
    "~*text/html" '<!doctype html><html lang="ko"><meta charset="utf-8"><title>화면 갱신이 필요합니다</title><h1>화면 갱신이 필요합니다</h1><p>요청은 실행되지 않았습니다. 뒤로 돌아가 입력 내용을 확인한 뒤 새 화면을 열어 주세요.</p><a href="/">새 화면 열기</a></html>';
  }
  server {
    listen 8080;
    client_max_body_size 10551296;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_next_upstream off;
    error_page 409 = @release_expired;
    location = /api/readyz {
      proxy_pass http://${active.slot};
    }
    location / {
      if ($marketing_slot = rejected) { return 409; }
      add_header X-Marketing-Slot $marketing_slot always;
      add_header Set-Cookie $release_cookie;
      proxy_pass http://$marketing_slot;
    }
    location @release_expired {
      internal;
      default_type "";
      add_header Content-Type $release_error_type always;
      add_header Cache-Control no-store always;
      add_header X-Marketing-Release-Error expired always;
      return 409 $release_error_body;
    }
  }
}
`
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(renderNginx(JSON.parse(readFileSync(process.argv[2], 'utf8'))))
}
