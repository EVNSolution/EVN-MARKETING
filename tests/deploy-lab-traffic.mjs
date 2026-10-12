// Synthetic authenticated API load on the isolated internal network. Never logs a session.
import assert from 'node:assert/strict'
import http from 'node:http'
import { createRequire } from 'node:module'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
const require = createRequire('/app/package.json')
// Next standalone bundles auth internally; the fixture uses the installed test dependency.
const { encode } = await import(createRequire('/src/package.json').resolve('next-auth/jwt'))
const cookie = '__Secure-authjs.session-token'
const token = await encode({ secret: 'synthetic-lab-secret-at-least-32-characters', salt: cookie,
  token: { sub: 'synthetic-user', id: 'synthetic-user', role: 'admin', email: 'synthetic@example.invalid' } })
const headers = { Host: 'localhost:3443', Cookie: `${cookie}=${token}` }
const counters = { reads: 0, saves: 0, uploads: 0, downloads: 0, errors: 0, expiredReleaseReloads: 0, maxRequestMs: 0 }
let failedStatus = null

function request(path, method = 'GET', body, extra = {}, hold = false) {
  return new Promise((resolve, reject) => {
    const started = performance.now()
    const req = http.request({ hostname: 'evn-marketing-proxy', port: 8080, path, method,
      headers: { ...headers, ...extra, ...(body && { 'content-length': body.length }), ...(hold && { Expect: '100-continue' }) } }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('error', reject)
      response.on('end', () => {
        counters.maxRequestMs = Math.max(counters.maxRequestMs, performance.now() - started)
        if (response.statusCode !== 200) {
          failedStatus = response.statusCode
          const error = new Error('synthetic_http_failure')
          error.releaseExpired = response.statusCode === 409
            && response.headers['x-marketing-release-error'] === 'expired'
            && Buffer.concat(chunks).toString().includes('"code":"release_expired"')
          return reject(error)
        }
        resolve({ body: Buffer.concat(chunks), headers: response.headers })
      })
    })
    req.setTimeout(hold ? 30_000 : 5_000, () => req.destroy(new Error('synthetic_request_timeout')))
    req.on('error', reject)
    if (!hold) req.end(body)
    else {
      req.on('continue', async () => {
        req.write(body.subarray(0, body.length - 1))
        writeFileSync('/control/held', 'ready\n')
        const deadline = Date.now() + 25_000
        while (!existsSync('/control/finish-held') && Date.now() < deadline) await delay(20)
        if (!existsSync('/control/finish-held')) req.destroy(new Error('held_request_timeout'))
        else req.end(body.subarray(-1))
      })
      req.flushHeaders()
    }
  })
}

// A failed candidate is retired immediately on rollback. Model one explicit page
// reload after its proxy rejects an unexecuted write; all other failures remain fatal.
async function writeRequest(path, method, body, extra) {
  try {
    return await request(path, method, body, extra)
  } catch (error) {
    if (!error.releaseExpired) throw error
    const revision = JSON.parse((await request('/api/readyz')).body).revision
    assert.match(revision, /^[ab]{40}$/)
    assert.notEqual(revision, extra['x-deployment-id'])
    counters.expiredReleaseReloads++
    return request(path, method, body, { ...extra, 'x-deployment-id': revision })
  }
}

function multipart(payload) {
  const boundary = 'synthetic-marketing-upload'
  return { body: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="type"\r\n\r\n계좌정보\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="synthetic.pdf"\r\nContent-Type: application/pdf\r\n\r\n${payload}\r\n--${boundary}--\r\n`),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } }
}

try {
  if (process.argv[2] === 'hold') {
    const revision = process.argv[3]
    assert.match(revision, /^[ab]{40}$/)
    const { body, headers: extra } = multipart('%PDF-synthetic-held-across-retirement')
    const result = await request('/api/customers/synthetic-held/documents', 'POST', body,
      { ...extra, 'x-deployment-id': revision }, true)
    const doc = JSON.parse(result.body).doc
    assert.equal((await request(doc.path)).body.toString(), '%PDF-synthetic-held-across-retirement')
    writeFileSync('/control/held-result.json', JSON.stringify({ ok: true, slot: result.headers['x-marketing-slot'] }))
  } else {
    const Database = require('better-sqlite3')
    const db = new Database('/data/marketing.db', { readonly: true })
    let cycle = 0
    while (!existsSync('/control/stop')) {
      const revision = JSON.parse((await request('/api/readyz')).body).revision
      assert.match(revision, /^[ab]{40}$/)
      await Promise.all([0, 1].map(async index => {
        const id = `synthetic-load-${index}`, memo = `synthetic-cycle-${cycle}`
        await writeRequest(`/api/customers/${id}`, 'PUT', Buffer.from(JSON.stringify({ memo })),
          { 'content-type': 'application/json', 'x-deployment-id': revision })
        counters.saves++
        assert.equal(JSON.parse((await request(`/api/customers/${id}`)).body).memo, memo)
        counters.reads++
        const payload = `%PDF-synthetic-${index}-${cycle}`
        const { body, headers: extra } = multipart(payload)
        const uploaded = JSON.parse((await writeRequest(`/api/customers/${id}/documents`, 'POST', body,
          { ...extra, 'x-deployment-id': revision })).body).doc
        counters.uploads++
        assert.equal((await request(uploaded.path)).body.toString(), payload)
        counters.downloads++
        const row = db.prepare('SELECT memo, documentsJson FROM Customer WHERE id=?').get(id)
        assert.equal(row.memo, memo)
        assert.equal(JSON.parse(row.documentsJson)[0].path, uploaded.path)
        assert.equal(readFileSync('/data/uploads/' + uploaded.path.replace('/api/uploads/', '')).toString(), payload)
      }))
      cycle++
      writeFileSync('/control/traffic-ready', 'ready\n')
      await delay(1000)
    }
    assert.ok(cycle > 0)
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok')
    db.close()
    writeFileSync('/control/traffic-result.json', JSON.stringify({ ...counters, cycles: cycle }))
  }
} catch (error) {
  const known = new Set(['held_request_timeout', 'synthetic_request_timeout', 'synthetic_http_failure'])
  console.error(JSON.stringify({ ok: false, httpStatus: failedStatus, errorType: error.name,
    reason: known.has(error.message) ? error.message : 'synthetic_request_failed',
    code: ['ECONNRESET', 'EPIPE', 'ECONNREFUSED'].includes(error.code) ? error.code : null }))
  writeFileSync('/control/traffic-failed', 'synthetic_traffic_failed\n')
  process.exitCode = 1
}
