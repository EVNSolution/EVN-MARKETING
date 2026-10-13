import assert from 'node:assert/strict'
import { renderNginx } from '../deploy/nginx-config.mjs'

const active = { id: 'b'.repeat(40), slot: 'green' }
const previous = { id: 'a'.repeat(40), slot: 'blue' }
const valid = renderNginx({ active, previous })
assert.ok(valid.includes(`"1:${previous.id}:0" blue;`))
assert.ok(!renderNginx({ active }).includes(`"1:${previous.id}:0" blue;`), 'retired release is removed, never mapped to active')
assert.ok(renderNginx({ active, previous: {...previous, expiresAt: 0} }).includes(`"1:${previous.id}:0" blue;`), 'legacy timestamps cannot expire a retained release')
assert.ok(!valid.includes('Max-Age=1800'), 'routing has no time-based release cookie')
assert.ok(!renderNginx({ active }).includes('server blue:'), 'retired container DNS is not required')
const production = renderNginx({ active, publicUrl: 'https://marketing.example.invalid' })
assert.ok(production.includes('if ($http_host != "marketing.example.invalid") { return 421; }'))
assert.ok(production.includes('proxy_set_header X-Forwarded-Proto https;'))
assert.throws(() => renderNginx({ active, publicUrl: 'https://example.invalid; injection' }), /invalid_public_url/)
for (const bad of [
  { active: { id: 'untrusted$request', slot: 'green' } },
  { active: { ...active, slot: 'external.example' } },
  { active, previous: { ...previous, id: active.id } },
  { active, previous: { ...previous, slot: active.slot } },
]) assert.throws(() => renderNginx(bad), /invalid_release_mapping/)
console.log('explicit release retention and retirement passed; actual routing is covered by the two-image browser test')
