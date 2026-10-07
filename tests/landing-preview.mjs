import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const root = fileURLToPath(new URL('../', import.meta.url))
const executablePath = process.env.BROWSER_EXECUTABLE || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(existsSync)
const output = process.env.LANDING_SCREENSHOT_DIR
const server = spawn(process.execPath, [path.join(root, 'scripts/preview-landing.mjs')], {
  env: { ...process.env, LANDING_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
})
let browser
const errors = [], external = [], failed = [], results = []
try {
  const ready = await new Promise((resolve, reject) => {
    server.stdout.once('data', data => resolve(data.toString()))
    server.once('error', reject)
    server.once('exit', code => reject(new Error(`Preview exited: ${code}`)))
  })
  const url = ready.match(/http:\/\/127\.0\.0\.1:\d+\/landing\//)[0]
  const origin = new URL(url).origin
  const response = await fetch(url)
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-security-policy'), /connect-src 'none'; form-action 'none'/)
  assert.equal((await fetch(url, { method: 'POST', body: 'synthetic-test' })).status, 405)
  browser = await chromium.launch({ executablePath, headless: true })
  const page = await browser.newPage({ reducedMotion: 'reduce' })
  page.setDefaultTimeout(10000)
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  page.on('response', res => { if (res.status() >= 400) failed.push(res.url()) })
  page.on('request', request => {
    if (!request.url().startsWith(origin + '/') && !request.url().startsWith('data:')) external.push(request.url())
    if (!['GET', 'HEAD'].includes(request.method())) errors.push(`Unexpected browser ${request.method()}`)
  })
  if (output) await fs.mkdir(output, { recursive: true })
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 })
    await page.goto(url, { waitUntil: 'networkidle' })
    const measure = await page.evaluate(() => ({
      viewport: innerWidth, pageWidth: document.documentElement.scrollWidth,
      brokenImages: [...document.images].filter(img => !img.complete || !img.naturalWidth).map(img => img.src),
    }))
    assert.equal(measure.pageWidth, width, `Horizontal overflow at ${width}px`)
    assert.deepEqual(measure.brokenImages, [])
    if (output) {
      await page.screenshot({ path: path.join(output, `local-${width}.png`), fullPage: true })
      await page.screenshot({ path: path.join(output, `local-${width}-top.png`) })
    }
    const form = page.locator('#contact form:visible').first()
    const submit = form.locator('button[type="submit"]')
    const status = form.locator('[role="status"]')
    await submit.click()
    assert.match(await status.innerText(), /이름을 입력/)
    await form.locator('[name="name"]').fill('로컬 시연')
    await form.locator('[name="phoneMiddle"]').fill('12')
    await submit.click()
    assert.match(await status.innerText(), /연락처를 확인/)
    await form.locator('[name="phoneMiddle"]').fill('0000')
    await form.locator('[name="phoneLast"]').fill('0000')
    await form.locator('[name="privacy"]').uncheck()
    await submit.click()
    assert.match(await status.innerText(), /동의를 확인/)
    await form.locator('[name="privacy"]').check()
    await submit.click()
    assert.match(await status.innerText(), /저장·전송되지 않았습니다/)
    await page.getByRole('button', { name: '보조금 계산', exact: true }).filter({ visible: true }).click()
    const subsidy = page.getByRole('dialog', { name: '실구매가 & 보조금 조회하기' })
    await subsidy.waitFor()
    await subsidy.locator('select').selectOption('경기')
    const modalForm = subsidy.locator('form')
    await modalForm.locator('button[type="submit"]').click()
    assert.match(await modalForm.locator('[role="status"]').innerText(), /이름을 입력/)
    await modalForm.locator('[name="name"]').fill('로컬 시연')
    await modalForm.locator('[name="phoneMiddle"]').fill('0000')
    await modalForm.locator('[name="phoneLast"]').fill('0000')
    await modalForm.locator('button[type="submit"]').click()
    assert.match(await modalForm.locator('[role="status"]').innerText(), /저장·전송되지 않았습니다/)
    if (output) await page.screenshot({ path: path.join(output, `local-${width}-subsidy.png`) })
    await subsidy.getByRole('button', { name: '내용보기', exact: true }).click()
    const privacy = page.getByRole('dialog', { name: '개인정보 수집·이용 안내' })
    await privacy.waitFor()
    if (output) await page.screenshot({ path: path.join(output, `local-${width}-privacy.png`) })
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => document.querySelectorAll('dialog').length === 1)
    await subsidy.getByRole('button', { name: '닫기', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('dialog').length === 0 && document.body.style.overflow === '')
    const checkbox = form.locator('[name="privacy"]')
    await checkbox.focus(); const before = await checkbox.isChecked(); await page.keyboard.press('Space')
    assert.equal(await checkbox.isChecked(), !before)
    if (width === 1440) {
      for (const [label, id] of [['회사소개', 'company'], ['차량소개', 'car'], ['맞춤 설계', 'custom'], ['상담 신청', 'contact']]) {
        await page.getByRole('button', { name: label, exact: true }).click()
        const top = await page.locator('#' + id).evaluate(el => el.getBoundingClientRect().top)
        assert.ok(Math.abs(top - 80) <= 2, `${label} scroll target: ${top}`)
      }
      const slider = page.locator('.preview-slider:visible').first()
      await slider.focus(); await page.keyboard.press('ArrowRight')
      await page.waitForFunction(() => [...document.querySelectorAll('.preview-slider')].some(el => el.scrollLeft > 100))
    } else {
      await page.getByRole('button', { name: '전화상담 시연' }).click()
      const phone = page.getByRole('dialog', { name: '전화상담 시연' })
      assert.match(await phone.innerText(), /실제 전화 연결은 실행하지 않습니다/)
      await phone.getByRole('button', { name: '확인', exact: true }).click()
      await page.waitForFunction(() => document.querySelectorAll('dialog').length === 0)
    }
    results.push({ ...measure, forms: 'pass', dialogsClosed: true })
  }
  assert.deepEqual(errors, [], 'Browser errors')
  assert.deepEqual(failed, [], 'Failed local assets')
  assert.deepEqual(external, [], 'External requests')
  const report = { results, errors, failed, external }
  if (output) await fs.writeFile(path.join(output, 'verification.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally {
  await browser?.close()
  server.kill()
}
