import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

// Owns a fresh synthetic DB, a loopback-only web process and a temporary browser profile.
// Never starts a collector or uses the caller's database, credentials or browser session.
const require = createRequire(path.join(process.cwd(), 'package.json'))
const Database = require('better-sqlite3')
const { chromium } = require('playwright-core')
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bcrypt = createRequire(path.join(source, 'package.json'))('bcryptjs')
const directory = mkdtempSync(path.join(tmpdir(), 'marketing-mvp-'))
const dbPath = path.join(directory, 'synthetic.db')
const db = new Database(dbPath)
const password = randomBytes(24).toString('hex')
const at = new Date().toISOString()
const scope = ['mleverage-admin', '55f9a8bb-73f9-4316-bcd7-7dcdce0bdcc3', '5c7a6115-a0a9-4e8d-bf65-efce52195fa4']
let server, browser
try {
  const migrations = path.join(source, 'prisma/migrations')
  for (const name of readdirSync(migrations).filter(name => /^\d{14}_/.test(name)).sort()) {
    db.exec(readFileSync(path.join(migrations, name, 'migration.sql'), 'utf8'))
  }
  for (const role of ['admin', 'user']) {
    db.prepare('INSERT INTO User(id,name,email,password,role,updatedAt) VALUES(?,?,?,?,?,?)')
      .run(role, '합성 사용자', `${role}@example.invalid`, bcrypt.hashSync(password, 4), role, at)
  }
  for (let i = 1; i <= 23; i++) {
    db.prepare('INSERT INTO Inquiry(id,source,companyScopeId,homepageScopeId,sourceId,inquiryDate,inquiryTime,sourceStatus,name,phone,lastSeenAt,warpDeliveredAt,warpError) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(`synthetic-${i}`, ...scope, `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        '2026-09-28', '09:30', '접수', `합성 문의 ${i}`, `010-0000-${String(i).padStart(4, '0')}`, at,
        i === 1 ? at : null, i === 2 ? 'warp_customer_conflict' : i === 3 ? 'warp_unavailable' : null)
  }
  db.prepare('INSERT INTO InquirySyncState(id,source,companyScopeId,homepageScopeId,status,lastSuccessfulAt,nextRunAt,workerHeartbeatAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(scope.join(':'), ...scope, 'ready', at, new Date(Date.now() + 3_600_000).toISOString(), at, at)

  const socket = createServer()
  socket.listen(0, '127.0.0.1')
  await once(socket, 'listening')
  const port = socket.address().port
  await new Promise(resolve => socket.close(resolve))
  const base = `http://127.0.0.1:${port}`
  const args = existsSync('server.js') ? ['server.js'] : ['node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', String(port)]
  server = spawn(process.execPath, args, { stdio: 'ignore', env: {
    PATH: process.env.PATH, NODE_ENV: 'production', HOSTNAME: '127.0.0.1', PORT: String(port),
    DATABASE_URL: `file:${dbPath}`, UPLOADS_DIR: path.join(directory, 'uploads'),
    AUTH_URL: base, AUTH_TRUST_HOST: 'true', AUTH_SECRET: randomBytes(32).toString('hex'),
    INQUIRY_COLLECTOR_ENABLED: 'false', WARP_DELIVERY_ENABLED: 'true',
  } })
  let ready = false
  for (let attempt = 0; attempt < 60; attempt++) {
    assert.equal(server.exitCode, null, 'synthetic web must remain running')
    try { ready = (await fetch(base + '/login', { signal: AbortSignal.timeout(1000) })).ok } catch {}
    if (ready) break
    await delay(500)
  }
  assert.ok(ready, 'build the app before running the MVP browser check')
  browser = await chromium.launch({ headless: true, ...(process.platform === 'darwin' ? { channel: 'chrome' } : {}) })
  const errors = []
  async function login(role) {
    const context = await browser.newContext()
    await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort())
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(base + '/inquiries')
    await page.waitForURL('**/login')
    await page.locator('input[name=email]').fill(`${role}@example.invalid`)
    await page.locator('input[name=password]').fill(password)
    await page.getByRole('button', { name: '로그인', exact: true }).click()
    await page.waitForURL('**/inquiries')
    await page.locator('tbody tr').first().waitFor()
    return { context, page }
  }
  const { context, page } = await login('admin')
  assert.equal(await page.locator('nav a[href="/customers"]').count(), 0)
  assert.equal(await page.locator('nav a[href="https://warp.cleversystem.ai/customers"]').count(), 1)
  for (const route of ['/', '/login']) {
    await page.goto(base + route)
    await page.waitForURL('**/inquiries')
  }
  await page.locator('tbody tr').first().waitFor()
  assert.equal(await page.locator('tbody tr').count(), 20)
  await page.getByLabel('페이지당 문의 수').selectOption('200')
  await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 23)
  const payload = await (await context.request.get(base + '/api/inquiries?limit=200')).json()
  assert.equal(payload.warp.configured, true, 'web reports enabled intent without receiving a WARP key')
  assert.equal(payload.warp.delivered, 1)
  assert.equal(payload.warp.failed, 2)
  assert.ok(!JSON.stringify(payload).includes(password))
  const search = page.getByPlaceholder('성함 또는 연락처')
  await search.fill('010-0000-0002')
  await page.getByRole('button', { name: '조회', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 1)
  assert.match(await page.locator('tbody').innerText(), /010-0000-0002/)
  assert.match(await page.locator('tbody').innerText(), /보류|확인 필요/)
  assert.equal((await context.request.get(base + '/api/inquiries?from=2026-02-30')).status(), 400)
  assert.equal((await context.request.post(base + '/api/inquiries/sync', { headers: { Origin: 'https://wrong.example.invalid' } })).status(), 400)
  const queued = page.waitForResponse(response => response.url().endsWith('/api/inquiries/sync') && response.request().method() === 'POST')
  await page.getByRole('button', { name: '지금 가져오기', exact: true }).click()
  assert.equal((await queued).status(), 202)
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM InquirySyncRun WHERE trigger='manual' AND status='pending'").get().count, 1)
  await context.request.post(base + '/api/inquiries/sync', { headers: { Origin: base } })
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM InquirySyncRun').get().count, 1, 'repeated requests do not queue duplicate work')
  const ordinary = await login('user')
  assert.equal(await ordinary.page.getByRole('button', { name: '지금 가져오기', exact: true }).count(), 0)
  assert.equal((await ordinary.context.request.post(base + '/api/inquiries/sync', { headers: { Origin: base } })).status(), 403)
  await page.getByRole('button', { name: '로그아웃', exact: true }).click()
  await page.waitForURL('**/login')
  assert.equal((await context.request.get(base + '/api/inquiries', { maxRedirects: 0 })).status(), 307)
  assert.deepEqual(errors, [])
  console.log('MVP browser passed: login, inquiry landing/search/pagination, delivery status, manual queue/dedup, role/origin checks, logout; synthetic only')
} finally {
  if (browser) await browser.close()
  if (server && server.exitCode === null) {
    const stopped = once(server, 'exit')
    server.kill('SIGTERM')
    const kill = setTimeout(() => server.kill('SIGKILL'), 5000)
    await stopped
    clearTimeout(kill)
  }
  db.close()
  rmSync(directory, { recursive: true, force: true })
}
