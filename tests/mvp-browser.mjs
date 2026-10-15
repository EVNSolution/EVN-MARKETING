import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { checkLandingWarpUi } from './landing-warp-browser.mjs'
import { checkExternalDashboardUi } from './external-dashboard-browser.mjs'
import { checkAdBillingUi } from './ad-billing-browser.mjs'
import { checkRepresentativeUi } from './inquiry-representative-browser.mjs'
import { checkCustomerNameUi } from './customer-name-browser.mjs'

// Owns a fresh synthetic DB, a loopback-only web process and a temporary browser profile.
// Never starts a collector or uses the caller's database, credentials or browser session.
const require = createRequire(path.join(process.cwd(), 'package.json'))
const Database = require('better-sqlite3')
const { chromium } = require('playwright-core')
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bcrypt = createRequire(path.join(source, 'package.json'))('bcryptjs')
// macOS aliases /var to /private/var; storage correctly requires a canonical root.
const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'marketing-mvp-')))
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
        [1, 5, 6].includes(i) ? at : null, i === 2 ? 'warp_customer_conflict' : i === 3 ? 'warp_registration_guard_unavailable'
          : i === 4 ? 'warp_manual_confirmed' : i === 5 ? 'warp_existing_customer' : i === 6 ? 'warp_receipt_unverified' : null)
  }
  db.prepare("UPDATE Inquiry SET phone='+82 10-0000-0001' WHERE id='synthetic-22'").run()
  db.prepare("UPDATE Inquiry SET warpCustomerId='existing-customer',warpActivityId='existing-activity' WHERE id='synthetic-5'").run()
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
  assert.equal(payload.warp.delivered, 2)
  assert.equal(payload.warp.pending, 18)
  assert.equal(payload.warp.duplicates, 3)
  assert.equal(payload.warp.failed, 2)
  const manuallyConfirmed = page.getByRole('row').filter({ hasText: '010-0000-0004' })
  assert.match(await manuallyConfirmed.innerText(), /등록완료/)
  assert.equal(await manuallyConfirmed.getByRole('button', { name: '등록하기' }).count(), 0)
  assert.match(await manuallyConfirmed.getByText('등록완료').getAttribute('title'), /직접 등록/)
  for (const [id, text] of [[2, 'WARP 고객 또는 리드와 연락처가 중복'], [5, '기존 고객의 문의 이력에 연결'], [22, 'EV&Marketing에 같은 연락처의 문의가 여러 건']]) {
    const row = page.getByRole('row').filter({ has: page.getByText(`합성 문의 ${id}`, { exact: true }) })
    assert.equal(await row.getByText('중복확인', { exact: true }).evaluate(el => el.tagName), 'SPAN')
    assert.equal(await row.getByRole('button', { name: '등록하기' }).count(), 0, 'duplicate marker is noninteractive')
    assert.equal(await row.getByRole('button', { name: '검토하기' }).count(), 1)
    assert.match(await row.innerText(), new RegExp(text))
    if (id !== 22) assert.match(await row.innerText(), /WARP에서 해당 연락처로 기존 고객과 리드를 확인/)
  }
  for (const [id, label] of [[3, '등록 보류'], [6, '등록 확인 필요']]) {
    const row = page.getByRole('row').filter({ has: page.getByText(`합성 문의 ${id}`, { exact: true }) })
    assert.equal(await row.getByText(label, { exact: true }).evaluate(el => el.tagName), 'SPAN')
    assert.equal(await row.getByRole('button').count(), 0, 'blocked marker is noninteractive')
  }
  assert.match(await page.getByRole('row').filter({ has: page.getByText('합성 문의 3', { exact: true }) }).innerText(), /중복 방지 연동 업데이트가 필요/)
  const resolved = await context.request.post(base + '/api/inquiries/synthetic-5/warp-registration', { headers: { Origin: base } })
  assert.equal(resolved.status(), 409)
  assert.match((await resolved.json()).error, /중복된 연락처/)
  assert.equal(db.prepare("SELECT warpError FROM Inquiry WHERE id='synthetic-5'").get().warpError, 'warp_existing_customer')
  const reviewUrl = base + '/api/inquiries/synthetic-22/duplicate-review'
  const review = await (await context.request.get(reviewUrl)).json()
  assert.equal(review.state.label, '중복확인')
  assert.equal(review.peerCount, 1)
  const decision = { action: 'hold', reviewToken: review.reviewToken }
  assert.equal((await context.request.post(reviewUrl, { headers: { Origin: 'https://wrong.example.invalid' }, data: decision })).status(), 400)
  assert.equal((await context.request.post(reviewUrl, { headers: { Origin: base }, data: { ...decision, padding: 'x'.repeat(1100) } })).status(), 400)
  assert.equal((await context.request.post(reviewUrl, { headers: { Origin: base }, data: decision })).status(), 200)
  assert.equal(db.prepare("SELECT warpError FROM Inquiry WHERE id='synthetic-22'").get().warpError, 'warp_duplicate_reviewed')
  assert.equal((await context.request.post(reviewUrl, { headers: { Origin: base }, data: decision })).status(), 409, 'stale decision cannot overwrite a review')
  const reviewed = await (await context.request.get(base + '/api/inquiries?review=reviewed')).json()
  assert.equal(reviewed.pagination.total, 1)
  assert.equal(reviewed.rows[0].id, 'synthetic-22')
  assert.equal((await context.request.get(base + '/api/inquiries?review=invalid')).status(), 400)
  assert.ok(!JSON.stringify(payload).includes(password))
  const search = page.getByPlaceholder('성함 또는 연락처')
  await search.fill('010-0000-0002')
  await page.getByRole('button', { name: '조회', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 1)
  assert.match(await page.locator('tbody').innerText(), /010-0000-0002/)
  assert.match(await page.locator('tbody').innerText(), /중복/)
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
  assert.equal((await ordinary.context.request.get(reviewUrl)).status(), 200)
  assert.equal((await ordinary.context.request.post(reviewUrl, { headers: { Origin: base }, data: decision })).status(), 403)
  await checkRepresentativeUi({ page, context, ordinary, db, base, output: process.env.MARKETING_UI_OUTPUT })
  await checkCustomerNameUi({ page, context, ordinary, db, base, uploads: path.join(directory, 'uploads'), output: process.env.MARKETING_UI_OUTPUT })
  await checkLandingWarpUi({ page, context, db, base })
  await checkExternalDashboardUi({ page, context, db, base, uploads: path.join(directory, 'uploads') })
  await checkAdBillingUi({ page, context, db, base, uploads: path.join(directory, 'uploads') })
  await page.getByRole('button', { name: '로그아웃', exact: true }).click()
  await page.waitForURL('**/login')
  assert.equal((await context.request.get(base + '/api/inquiries', { maxRedirects: 0 })).status(), 307)
  assert.equal((await context.request.get(reviewUrl, { maxRedirects: 0 })).status(), 307)
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
