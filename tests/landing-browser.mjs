import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { randomBytes } from 'node:crypto'

// Run in an isolated checkout; this script always creates its own synthetic DB.
const root = process.cwd()
const require = createRequire(path.join(root, 'package.json'))
const Database = require('better-sqlite3')
const bcrypt = require('bcryptjs')
const { chromium } = require('playwright-core')
const directory = await fs.mkdtemp(path.join(tmpdir(), 'evn-public-form-'))
const database = path.join(directory, 'synthetic.db')
const db = new Database(database)
const password = randomBytes(18).toString('hex')
const migrations = path.join(root, 'prisma/migrations')
for (const name of (await fs.readdir(migrations)).filter(name => /^\d{14}_/.test(name)).sort()) db.exec(await fs.readFile(path.join(migrations, name, 'migration.sql'), 'utf8'))
db.prepare('INSERT INTO User(id,name,email,password,role,updatedAt) VALUES(?,?,?,?,?,?)').run('landing-test-admin', '합성 관리자', 'landing-admin@example.invalid', bcrypt.hashSync(password, 4), 'admin', new Date().toISOString())
const socket = createServer().listen(0, '127.0.0.1')
await once(socket, 'listening')
const port = socket.address().port
await new Promise(resolve => socket.close(resolve))
const base = `http://127.0.0.1:${port}`
execFileSync(process.execPath, ['scripts/build-landing-public.mjs'], { cwd: root, stdio: 'pipe' })
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--webpack', '-H', '127.0.0.1', '-p', String(port)], { cwd: root, windowsHide: true, env: {
  ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`, NODE_ENV: 'development',
  DATABASE_URL: `file:${database}`, AUTH_URL: base, NEXTAUTH_URL: base, AUTH_SECRET: randomBytes(32).toString('hex'), AUTH_TRUST_HOST: 'true',
  LANDING_INTAKE_ENABLED: 'true', INQUIRY_COLLECTOR_ENABLED: 'false', WARP_DELIVERY_ENABLED: 'false',
  MLEVERAGE_USERNAME: '', MLEVERAGE_PASSWORD: '', WARP_MARKETING_API_KEY: '', LEADS_INTAKE_API_KEY: '', MARKETING_BUILD_REVISION: '',
}, stdio: ['ignore', 'pipe', 'pipe'] })
let log = '', browser
server.stdout.on('data', data => { log = (log + data).slice(-10000) })
server.stderr.on('data', data => { log = (log + data).slice(-10000) })
try {
  let ready = false
  for (let i = 0; i < 100; i++) {
    assert.equal(server.exitCode, null)
    try { ready = (await fetch(`${base}/landing`, { signal: AbortSignal.timeout(1000) })).ok } catch {}
    if (ready) break
    await delay(500)
  }
  assert.ok(ready, 'isolated preview must start')
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || 'C:/Program Files/Google/Chrome/Application/chrome.exe' })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort())
  const page = await context.newPage()
  page.setDefaultNavigationTimeout(90000)
  const errors = [], external = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', req => { if (new URL(req.url()).origin !== base) external.push(req.url()) })
  const output = process.env.LANDING_SCREENSHOT_DIR
  if (output) await fs.mkdir(output, { recursive: true })
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 })
    await page.goto(`${base}/landing`, { waitUntil: 'networkidle' })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width)
    assert.equal(await page.evaluate(() => [...document.images].filter(img => !img.complete || !img.naturalWidth).length), 0)
    const form = page.locator('#contact form:visible').first()
    await form.locator('[name="name"]').fill(`합성 상담 ${width}`)
    await form.locator('[name="phoneMiddle"]').fill('0000')
    await form.locator('[name="phoneLast"]').fill(String(width).padStart(4, '0'))
    await form.locator('[name="privacy"]').check()
    const saved = page.waitForResponse(res => res.url().endsWith('/api/external/landing-inquiries') && res.request().method() === 'POST')
    await form.locator('button[type="submit"]').click()
    const response = await saved
    assert.equal(response.status(), 200)
    await form.locator('[data-state="success"]').waitFor()
    assert.match(await form.locator('[role="status"]').innerText(), /접수되었습니다/)
    assert.equal(await form.locator('button[type="submit"]').isDisabled(), true)
    if (output) await page.screenshot({ path: path.join(output, `public-${width}-submitted.png`) })
    await form.getByRole('button', { name: '내용보기', exact: true }).click()
    const policy = page.getByRole('dialog', { name: '개인정보 수집·이용 안내' })
    assert.match(await policy.innerText(), /이브이앤솔루션/)
    assert.doesNotMatch(await policy.innerText(), /루센트|채용|로컬/)
    assert.equal(await policy.evaluate(el => el.scrollWidth <= el.clientWidth), true, 'privacy text must fit the dialog')
    if (output && width === 390) await page.screenshot({ path: path.join(output, 'public-privacy-mobile.png') })
    await page.keyboard.press('Escape')
  }
  assert.equal(db.prepare('SELECT count(*) AS n FROM Inquiry WHERE source = ?').get('evn-landing').n, 3)
  assert.equal(db.prepare('SELECT count(*) AS n FROM Customer').get().n, 0)
  const unauth = await context.request.get(`${base}/api/inquiries`, { maxRedirects: 0 })
  assert.ok([302, 307].includes(unauth.status()))
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto(`${base}/login`)
  await page.locator('input[name="email"]').fill('landing-admin@example.invalid')
  await page.locator('input[name="password"]').fill(password)
  await page.getByRole('button', { name: '로그인', exact: true }).click()
  await page.waitForURL('**/inquiries')
  await page.getByLabel('문의 경로', { exact: true }).selectOption('landing')
  await page.getByText('합성 상담 1440', { exact: true }).filter({ visible: true }).waitFor()
  assert.equal(await page.locator('tbody tr').count(), 3)
  if (output) await page.screenshot({ path: path.join(output, 'inquiries-landing.png') })
  await page.getByRole('button', { name: '상담 종료·개인정보 삭제', exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: '상담을 종료하고 개인정보를 삭제할까요?' })
  await dialog.waitFor()
  await dialog.getByRole('button', { name: '취소', exact: true }).click()
  assert.equal(db.prepare('SELECT count(*) AS n FROM Inquiry WHERE source = ?').get('evn-landing').n, 3)
  await page.getByRole('button', { name: '상담 종료·개인정보 삭제', exact: true }).first().click()
  await dialog.getByRole('button', { name: '상담 종료 및 삭제', exact: true }).click()
  await dialog.waitFor({ state: 'detached' })
  assert.equal(db.prepare('SELECT count(*) AS n FROM Inquiry WHERE source = ?').get('evn-landing').n, 2)
  assert.deepEqual(errors, [])
  assert.deepEqual(external, [])
  console.log(JSON.stringify({ ok: true, widths: [1440, 390, 320], submissions: 3, customerWrites: 0, inquiriesVisible: true, closeCancelled: true, closeDeleted: true, externalRequests: 0, browserErrors: 0 }))
} catch (error) { console.error(log); throw error }
finally {
  await browser?.close()
  server.kill('SIGTERM')
  await Promise.race([once(server, 'exit'), delay(5000)])
  db.close()
}
