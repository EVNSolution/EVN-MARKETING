import assert from 'node:assert/strict'
import { rename } from 'node:fs/promises'

// Runs only in the isolated --network none CI container with synthetic /data.
const base = 'http://127.0.0.1:3000'
const ready = () => fetch(`${base}/api/readyz`, { redirect: 'manual' })
const response = await ready()
assert.equal(response.status, 200)
assert.equal(response.headers.get('cache-control'), 'no-store')
assert.deepEqual(await response.json(), {
  ok: true, revision: process.env.MARKETING_REVISION, imageDigest: process.env.MARKETING_IMAGE_DIGEST,
})
for (const pathname of ['/api/inquiries', '/api/customers', '/api/readyz/private']) {
  const protectedResponse = await fetch(base + pathname, { redirect: 'manual' })
  assert.equal(protectedResponse.status, 307, `${pathname} remains protected`)
  assert.equal(new URL(protectedResponse.headers.get('location'), base).pathname, '/login')
}
const marker = '/data/.marketing-volume-id'
await rename(marker, marker + '.synthetic-hidden')
try {
  const failed = await ready()
  assert.equal(failed.status, 503)
  assert.equal(failed.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await failed.json(), { ok: false })
} finally {
  await rename(marker + '.synthetic-hidden', marker)
}
assert.equal((await ready()).status, 200, 'readiness recovers without stale caching')
console.log('image HTTP readiness: healthy/unhealthy/recovered and business authentication boundary passed')
