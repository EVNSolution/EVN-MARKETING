import assert from 'node:assert/strict'
import { renderNginx } from '../deploy/nginx-config.mjs'

const active = { id: 'b'.repeat(40), slot: 'green' }
const previous = { id: 'a'.repeat(40), slot: 'blue', expiresAt: 20_000 }
const valid = renderNginx({ active, previous }, 10_000)
assert.ok(valid.includes(`"1:${previous.id}:0" blue;`))
assert.ok(!renderNginx({ active, previous }, 20_000).includes(`"1:${previous.id}:0" blue;`), 'expired release is removed, never mapped to active')
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
  { active, previous: { ...previous, expiresAt: 2_000_001 } },
]) assert.throws(() => renderNginx(bad, 10_000), /invalid_release_mapping/)
console.log('release mapping validation and exact expiry boundary passed; actual routing is covered by the two-image browser test')
