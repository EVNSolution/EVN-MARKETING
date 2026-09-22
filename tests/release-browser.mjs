import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

const require = createRequire('/app/package.json')
const { chromium } = require('playwright-core')
const Database = require('better-sqlite3')
const base = 'http://proxy:8080'
const a = process.env.RELEASE_A
const b = process.env.RELEASE_B
assert.match(a, /^[0-9a-f]{40}$/)
assert.match(b, /^[0-9a-f]{40}$/)
const db = new Database('/data/marketing.db', { readonly: true })
const browser = await chromium.launch({ headless: true })
const errors = []
const actions = []
const writes = []
const nativePosts = []
let unloadPrompts = 0
const contexts = []
const deadline = setTimeout(() => { throw new Error('compatibility browser test timed out') }, 150_000)

async function until(check) {
  let lastError
  for (let n = 0; n < 300; n++) {
    try { if (await check()) return } catch (error) { lastError = error }
    await delay(100)
  }
  throw new Error('compatibility condition timed out', { cause: lastError })
}

async function context(options = {}) {
  const ctx = await browser.newContext(options)
  contexts.push(ctx)
  await ctx.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort())
  ctx.on('page', page => {
    page.on('dialog', dialog => { if (dialog.type() === 'beforeunload') unloadPrompts++; return dialog.dismiss() })
    page.on('pageerror', error => errors.push(error.message))
    page.on('response', response => {
      const request = response.request()
      const url = new URL(response.url())
      const record = { status: response.status(), release: response.headers()['x-marketing-release'], path: url.pathname }
      if (request.headers()['next-action']) actions.push(record)
      if (request.method() === 'POST' && !request.headers()['next-action'] && !url.pathname.startsWith('/api/')) nativePosts.push(record)
      if (['PUT', 'POST', 'DELETE'].includes(request.method()) && url.pathname.startsWith('/api/customers')) writes.push(record)
      if (url.pathname.startsWith('/_next/static/') && response.status() >= 400) errors.push(`asset HTTP ${response.status()}`)
    })
  })
  return ctx
}

async function loginPage(ctx) {
  const page = await ctx.newPage()
  await page.goto(`${base}/login`)
  await page.waitForLoadState('networkidle')
  return page
}
async function login(page) {
  await page.locator('input[name=email]').fill('synthetic@example.invalid')
  await page.locator('input[name=password]').fill('synthetic-compat-only')
  await page.getByRole('button', { name: '로그인', exact: true }).click()
  await page.waitForURL('**/customers')
  await page.waitForLoadState('networkidle')
}
async function phase(name) {
  writeFileSync(`/control/${name}`, '')
  await until(() => existsSync(`/control/${name}.done`))
}
const requestHeaders = id => ({ 'x-deployment-id': id })

try {
  await until(async () => (await fetch(`${base}/api/readyz`)).status === 200)
  const authenticated = await context()
  const edit = await loginPage(authenticated)
  await login(edit)
  await edit.goto(`${base}/customers/synthetic-edit`)
  await edit.waitForLoadState('networkidle')
  await edit.locator('textarea[rows="4"]').fill('saved from old tab after switch')
  const oldLogout = await authenticated.newPage()
  await oldLogout.goto(`${base}/customers`)
  await oldLogout.waitForLoadState('networkidle')
  const logoutRaceContext = await context()
  const logoutRace = await loginPage(logoutRaceContext)
  await login(logoutRace)
  await logoutRace.goto(`${base}/customers/synthetic-edit`)
  await logoutRace.waitForLoadState('networkidle')
  await logoutRace.locator('textarea[rows="4"]').fill('keep draft after rejected logout action')
  const jsContext = await context()
  const oldLogin = await loginPage(jsContext)
  const nativeContext = await context({ javaScriptEnabled: false })
  const nativeLogin = await loginPage(nativeContext)
  const nativeExpiredPage = await loginPage(nativeContext)
  const nativeLogoutContext = await context({ javaScriptEnabled: false })
  const nativeLogout = await loginPage(nativeLogoutContext)
  await login(nativeLogout)
  const unloadedContext = await context()
  await unloadedContext.route('**/*.js*', route => route.abort())
  const unloadedLogin = await loginPage(unloadedContext)
  for (const page of [nativeLogin, nativeLogout, unloadedLogin]) {
    assert.equal(new URL(await page.locator('form').getAttribute('action'), base).searchParams.get('dpl'), a, 'native form pins the rendered release')
    assert.ok(await page.locator('input[name^="$ACTION_"]').count(), 'React SSR action encoding is retained')
  }
  const oldEncoding = await nativeLogin.locator('input[name^="$ACTION_"]').evaluateAll(inputs => inputs.map(input => input.value))

  await phase('switch')
  await until(async () => (await (await fetch(`${base}/api/readyz`)).json()).revision === b)
  const newLogin = await loginPage(jsContext)
  assert.equal(await newLogin.locator('html').getAttribute('data-dpl-id'), b)
  const newNative = await loginPage(nativeContext)
  const newEncoding = await newNative.locator('input[name^="$ACTION_"]').evaluateAll(inputs => inputs.map(input => input.value))
  assert.notDeepEqual(newEncoding, oldEncoding, 'two independently built images have distinct action encodings')
  // HTTPS makes this cookie secure in production. Explicitly change it in this isolated HTTP fixture.
  for (const ctx of contexts) await ctx.addCookies([{ name: 'marketing_release', value: b, domain: 'proxy', path: '/' }])
  await login(oldLogin)
  await login(nativeLogin)
  await login(unloadedLogin)
  assert.equal(actions.at(-1).release, a, 'hydrated old login reaches its original image despite the new tab/cookie')
  assert.ok(nativePosts.filter(record => record.release === a && record.status < 400).length >= 3, 'native/no-JS/unloaded old forms reached the original image')
  await nativeLogout.getByRole('button', { name: '로그아웃', exact: true }).click()
  await nativeLogout.waitForURL('**/login')
  assert.equal(nativePosts.at(-1).release, a, 'old native logout remains pinned after cookie changes')
  const signedOut = await nativeLogoutContext.request.get(`${base}/api/customers`, { maxRedirects: 0 })
  assert.equal(signedOut.status(), 307)

  const saved = edit.waitForResponse(response => response.url().endsWith('/api/customers/synthetic-edit') && response.request().method() === 'PUT')
  await edit.getByRole('button', { name: '저장하기', exact: true }).click()
  const savedResponse = await saved
  assert.equal(savedResponse.status(), 200)
  assert.equal(savedResponse.headers()['x-marketing-release'], a)
  assert.equal(db.prepare('SELECT memo FROM Customer WHERE id = ?').get('synthetic-edit').memo, 'saved from old tab after switch')
  const file = { name: 'synthetic.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-synthetic-browser-upload') }
  const uploaded = edit.waitForResponse(response => response.url().endsWith('/documents') && response.request().method() === 'POST')
  await edit.locator('input[type=file][accept^=".pdf"]').first().setInputFiles(file)
  assert.equal((await uploaded).status(), 200)
  const document = JSON.parse(db.prepare('SELECT documentsJson FROM Customer WHERE id = ?').get('synthetic-edit').documentsJson)[0]
  const downloaded = await authenticated.request.get(base + document.path)
  assert.equal(downloaded.status(), 200)
  assert.ok(downloaded.headers()['cache-control'].includes('no-store'))
  assert.equal((await downloaded.body()).toString(), file.buffer.toString())

  // A fresh query distinguishes a real post-switch RSC request from an already prefetched cache entry.
  await edit.locator('a[href="/inquiries"]').evaluate(anchor => { anchor.href = '/inquiries?compat-window=1' })
  const navigation = edit.waitForResponse(response => new URL(response.url()).pathname === '/inquiries' && response.request().headers().rsc === '1')
  await edit.getByRole('link', { name: '문의 내역', exact: true }).click()
  assert.equal((await navigation).headers()['x-marketing-release'], a, 'old-tab RSC/lazy navigation stays on old image')
  await edit.waitForURL(url => url.pathname === '/inquiries')
  await edit.waitForLoadState('networkidle')
  const fresh = await authenticated.newPage()
  await fresh.goto(`${base}/customers/synthetic-edit`)
  assert.equal(await fresh.locator('html').getAttribute('data-dpl-id'), b, 'ordinary documents go to active while sharing session')

  const pdf = Buffer.alloc(6 * 1024 * 1024)
  pdf.write('%PDF-synthetic-quota')
  const upload = (id, type) => authenticated.request.post(`${base}/api/customers/synthetic-quota/documents`, {
    headers: requestHeaders(id), multipart: { type, file: { name: 'quota.pdf', mimeType: 'application/pdf', buffer: pdf } },
  })
  const parallelWrites = async () => {
    for (let n = 0; n < 12; n++) {
      const id = n % 2 ? a : b
      const response = await authenticated.request.put(`${base}/api/customers/synthetic-parallel`, { headers: requestHeaders(id), data: { memo: `synthetic-${n}` } })
      assert.equal(response.status(), 200, 'concurrent SQLite customer write succeeds')
      assert.equal((await authenticated.request.get(`${base}/api/customers/synthetic-parallel`)).status(), 200)
    }
  }
  const [first, second] = await Promise.all([upload(a, '사업자등록증'), upload(b, '계좌정보'), parallelWrites()])
  assert.deepEqual([first.status(), second.status()].sort(), [200, 413], 'two web processes cannot both consume the last 6MiB')
  const directory = '/data/uploads/customers/synthetic-quota'
  const names = readdirSync(directory)
  assert.equal(names.reduce((sum, name) => sum + statSync(`${directory}/${name}`).size, 0), 50 * 1024 * 1024)
  for (let n = 0; n < 5; n++) assert.ok(names.includes(`existing-${n}.pdf`))
  assert.equal(JSON.parse(db.prepare('SELECT documentsJson FROM Customer WHERE id = ?').get('synthetic-quota').documentsJson).length, 1)
  assert.equal(db.prepare('SELECT memo FROM Customer WHERE id = ?').get('synthetic-parallel').memo, 'synthetic-11')
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok')
  const tooLarge = await authenticated.request.post(`${base}/api/customers/synthetic-edit/documents`, {
    headers: requestHeaders(b), multipart: { type: '사업자등록증', file: { ...file, buffer: Buffer.alloc(11 * 1024 * 1024) } },
  })
  assert.equal(tooLarge.status(), 413, 'proxy rejects oversized body')

  for (const [query, header] of [[a, b], ['c'.repeat(40), ''], ['', ''], [`${a}&dpl=${b}`, a]]) {
    const rejected = await authenticated.request.post(`${base}/login${query ? `?dpl=${query}` : ''}`, { headers: { ...requestHeaders(header), cookie: `marketing_release=${a}` }, form: {} })
    assert.equal(rejected.status(), 409, 'conflicting, unknown, missing or duplicate IDs cannot execute an action')
  }
  const publicReady = await fetch(`${base}/api/readyz?dpl=${a}`, { headers: { ...requestHeaders('c'.repeat(40)), rsc: '1', 'next-action': 'invalid', cookie: `marketing_release=${a}` } })
  assert.equal((await publicReady.json()).revision, b, 'public readiness always observes active')
  await oldLogout.getByRole('button', { name: '로그아웃', exact: true }).click()
  await oldLogout.waitForURL('**/login')
  assert.equal(actions.at(-1).release, a, 'hydrated old logout reached old image')
  assert.equal((await authenticated.request.get(base + document.path, { maxRedirects: 0 })).status(), 307, 'saved upload becomes inaccessible after logout')

  // This other context still has the session created by its old login action.
  await oldLogin.locator('a[href="/customers/synthetic-edit"]').evaluate(anchor => { anchor.href = '/customers/synthetic-edit?returnTo=%2Finquiries' })
  await oldLogin.locator('a[href^="/customers/synthetic-edit?"]').click()
  await oldLogin.waitForURL(url => url.pathname === '/customers/synthetic-edit')
  await oldLogin.waitForLoadState('networkidle')
  assert.equal(await oldLogin.locator('html').getAttribute('data-dpl-id'), a)
  await oldLogin.locator('textarea[rows="4"]').fill('keep unsaved after expiry')
  const lastSavedMemo = db.prepare('SELECT memo FROM Customer WHERE id = ?').get('synthetic-edit').memo
  assert.deepEqual(errors, [], 'compatible window has no browser or asset errors')
  assert.ok(actions.length >= 3 && actions.every(record => record.status < 400), 'hydrated actions all completed successfully')
  const beforeExpireWrites = writes.length
  const beforeRaceUrl = oldLogin.url()
  const beforeRacePrompts = unloadPrompts
  let releaseLogout
  const heldLogout = new Promise(resolve => { releaseLogout = resolve })
  let capturedLogout
  const logoutCaptured = new Promise(resolve => { capturedLogout = resolve })
  await logoutRace.route('**/customers/synthetic-edit', async route => {
    if (route.request().headers()['next-action']) {
      capturedLogout()
      await heldLogout
    }
    await route.continue()
  })
  await logoutRace.getByRole('button', { name: '로그아웃', exact: true }).click()
  await logoutCaptured
  await oldLogin.locator('a[href="/inquiries"]').evaluate(anchor => { anchor.href = '/inquiries?compat-race=1' })
  await oldLogin.route('**/inquiries?compat-race=1*', async route => {
    if (route.request().headers().rsc === '1') {
      await phase('expire')
      await until(async () => (await fetch(`${base}/api/release`, { headers: requestHeaders(a) })).status === 409)
    }
    await route.continue()
  })
  await oldLogin.getByRole('link', { name: '문의 내역', exact: true }).click()
  await until(() => unloadPrompts > beforeRacePrompts)
  releaseLogout()
  await logoutRace.getByRole('alert').filter({ hasText: '로그아웃을 완료하지 못했습니다' }).waitFor()
  assert.equal(await logoutRace.locator('textarea[rows="4"]').inputValue(), 'keep draft after rejected logout action', 'action failure is isolated from the customer editor')
  assert.equal((await logoutRaceContext.request.get(`${base}/api/customers/synthetic-edit`)).status(), 200, 'rejected logout action preserves its session')
  assert.equal(oldLogin.url(), beforeRaceUrl, 'post-probe expiry fallback cannot silently discard a draft')
  assert.equal(await oldLogin.locator('textarea[rows="4"]').inputValue(), 'keep unsaved after expiry')
  const rejectedSave = oldLogin.waitForResponse(response => response.url().endsWith('/api/customers/synthetic-edit') && response.request().method() === 'PUT')
  await oldLogin.getByRole('button', { name: '저장하기', exact: true }).click()
  assert.equal((await rejectedSave).status(), 409)
  await oldLogin.getByRole('alert').waitFor()
  assert.equal(await oldLogin.locator('textarea[rows="4"]').inputValue(), 'keep unsaved after expiry')
  assert.equal(db.prepare('SELECT memo FROM Customer WHERE id = ?').get('synthetic-edit').memo, lastSavedMemo)
  assert.equal(writes.length, beforeExpireWrites + 1, 'expired write was attempted once, never automatically replayed')
  const currentUrl = oldLogin.url()
  const rejectedNavigation = oldLogin.waitForResponse(response => response.url().endsWith('/api/release'))
  await oldLogin.getByRole('link', { name: '문의 내역', exact: true }).click()
  assert.equal((await rejectedNavigation).status(), 409)
  assert.equal(oldLogin.url(), currentUrl, 'expired navigation does not discard the editing page')
  assert.equal(await oldLogin.locator('textarea[rows="4"]').inputValue(), 'keep unsaved after expiry')
  const rejectedReturn = oldLogin.waitForResponse(response => response.url().endsWith('/api/release'))
  await oldLogin.getByRole('button', { name: '← 리드로 돌아가기', exact: true }).click()
  assert.equal((await rejectedReturn).status(), 409)
  assert.equal(oldLogin.url(), currentUrl, 'return button also preserves the expired editor')
  const beforeLogout = actions.length
  const rejectedLogout = oldLogin.waitForResponse(response => response.url().endsWith('/api/release'))
  await oldLogin.getByRole('button', { name: '로그아웃', exact: true }).click()
  assert.equal((await rejectedLogout).status(), 409)
  assert.equal(actions.length, beforeLogout, 'expired hydrated form does not invoke its action')
  const nativeExpired = await nativeContext.request.post(`${base}/customers?dpl=${a}`, { headers: { accept: 'text/html' }, form: {} })
  assert.equal(nativeExpired.status(), 409)
  assert.ok((await nativeExpired.text()).includes('요청은 실행되지 않았습니다'))
  assert.equal((await fetch(`${base}/_next/static/nonexistent.js?dpl=${a}`)).status, 409, 'retired ID cannot be remapped to another slot')
  assert.equal((await jsContext.request.get(`${base}/api/customers/synthetic-edit`)).status(), 200, 'expired logout kept the session')
  const loginActionsBefore = actions.length
  await oldLogout.locator('input[name=email]').fill('synthetic@example.invalid')
  await oldLogout.locator('input[name=password]').fill('synthetic-compat-only')
  const rejectedLogin = oldLogout.waitForResponse(response => response.url().endsWith('/api/release'))
  await oldLogout.getByRole('button', { name: '로그인', exact: true }).click()
  assert.equal((await rejectedLogin).status(), 409)
  assert.equal(actions.length, loginActionsBefore)
  assert.equal(await oldLogout.locator('input[name=email]').inputValue(), 'synthetic@example.invalid')
  await nativeExpiredPage.locator('input[name=email]').fill('synthetic@example.invalid')
  await nativeExpiredPage.locator('input[name=password]').fill('synthetic-compat-only')
  const nativeRejection = nativeExpiredPage.waitForResponse(response => response.request().method() === 'POST')
  await nativeExpiredPage.getByRole('button', { name: '로그인', exact: true }).click()
  const expiredHtml = await nativeRejection
  assert.equal(expiredHtml.status(), 409)
  assert.ok(expiredHtml.headers()['content-type'].startsWith('text/html'))
  await nativeExpiredPage.getByRole('heading', { name: '화면 갱신이 필요합니다' }).waitFor()
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok')
  console.log('two-image browser compatibility passed: hydrated/native/no-JS/unloaded login/logout, multi-tab cookies, old save/upload/RSC/assets, 50MiB quota race, expiry input/session preservation and no write replay')
} finally {
  clearTimeout(deadline)
  await browser.close()
  db.close()
}
