import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'

// Synthetic disposable upload root only; no live account, credentials or requests.
export async function checkAdSpendUi({ page, context, base, uploads, output }) {
  const file = path.join(uploads, '_reports/ad-spend/current.json')
  const previous = await readFile(file, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return null })
  await mkdir(path.dirname(file), { recursive: true })
  const providers = ['naver', 'daangn'], stamp = '2026-10-11T00:00:00.000Z'
  const dates = Array.from({ length: 30 }, (_, i) => new Date(Date.UTC(2026, 8, 11 + i)).toISOString().slice(0, 10))
  const campaigns = providers.map(provider => ({ provider, accountId: 'synthetic-account', campaignId: provider === 'naver' ? 'synthetic-evn' : '9007199254740993001', start: dates[0], end: null, lifecycle: 'active' }))
  const seed = () => ({ format: 1, campaigns, accounts: campaigns.map(c => ({ provider: c.provider, accountId: c.accountId, connected: true })),
    rows: dates.flatMap(date => campaigns.map(c => ({ provider: c.provider, accountId: c.accountId, campaignId: c.campaignId, date, amount: c.provider === 'naver' ? '100.10' : '200.20', vat: 'included', observedAt: stamp, attemptedAt: stamp, issue: null }))) })
  const save = record => writeFile(file, JSON.stringify(record))
  const storageState = await context.storageState(), evidence = []
  try {
    for (const width of [1440, 390, 320]) {
      const mobile = width < 600 ? await context.browser().newContext({ storageState, viewport: { width, height: 1000 }, hasTouch: true, isMobile: true }) : null
      if (mobile) await mobile.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort())
      const view = mobile ? await mobile.newPage() : page
      view.setDefaultTimeout(15000); await view.setViewportSize({ width, height: 1000 })
      try {
        await rm(file, { force: true }); await view.goto(base + '/external-dashboard')
        await view.getByRole('button', { name: '화면 새로고침', exact: true }).waitFor()
        const section = view.getByRole('region', { name: '실제 소진 광고비', exact: true })
        const total = section.getByRole('article', { name: '전체 광고비', exact: true })
        assert.equal(await total.locator('p').first().innerText(), '—')
        assert.match(await total.innerText(), /미연결/)
        await section.scrollIntoViewIfNeeded()
        if (output) await view.screenshot({ path: path.join(output, `ad-spend-${width}-disconnected.png`) })
        for (const mode of ['one', 'two', 'month', 'zero', 'missing', 'failure', 'mixed', 'unknown', 'precision']) {
          const record = seed(), count = mode === 'month' ? 30 : mode === 'two' ? 2 : 1
          if (mode === 'zero') record.rows.forEach(r => { r.amount = '0' })
          if (mode === 'missing') record.rows = record.rows.filter(r => r.provider === 'naver')
          if (mode === 'failure') record.rows.filter(r => r.provider === 'naver').forEach(r => { r.issue = 'fetch_failed'; r.attemptedAt = '2026-10-12T00:00:00.000Z' })
          if (mode === 'mixed' || mode === 'unknown') record.rows.filter(r => r.provider === 'daangn').forEach(r => { r.vat = mode === 'mixed' ? 'excluded' : 'unknown' })
          if (mode === 'precision') record.rows.filter(r => r.provider === 'naver').forEach(r => { r.amount = '9007199254740993.123456789012' })
          await save(record)
          await view.getByLabel('성과 시작일', { exact: true }).fill(dates[0])
          await view.getByLabel('성과 종료일', { exact: true }).fill(dates[count - 1])
          const pending = view.waitForResponse(r => new URL(r.url()).pathname === '/api/external-dashboard')
          // Repeated same range uses refresh; different ranges use the existing date filter.
          const currentStart = await section.innerText()
          if (currentStart.includes(`조회 ${dates[0]} ~ ${dates[count - 1]}`)) await view.getByRole('button', { name: '화면 새로고침', exact: true }).click()
          else await view.getByRole('button', { name: '기간 조회', exact: true }).click()
          const response = await pending, body = await response.json()
          await view.getByRole('button', { name: '화면 새로고침', exact: true }).waitFor()
          assert.match(response.headers()['cache-control'], /private.*no-store/)
          assert.doesNotMatch(JSON.stringify(body.adSpend), /synthetic-account|synthetic-evn|9007199254740993001|accountId|campaignId/)
          const incomplete = ['missing', 'failure', 'mixed', 'unknown'].includes(mode)
          assert.equal(body.adSpend.total.total === null, incomplete)
          if (incomplete) assert.equal(await total.locator('p').first().innerText(), '—')
          else if (mode === 'zero') assert.equal(await total.locator('p').first().innerText(), '0원')
          else if (mode === 'precision') assert.equal(await total.locator('p').first().innerText(), '9,007,199,254,741,193.323456789012원')
          else assert.equal(body.adSpend.total.total, count === 30 ? '9009.00' : count === 2 ? '600.60' : '300.30')
          if (mode === 'failure') assert.match(await total.innerText(), /수집 오류[\s\S]*보관 금액/)
          if (mode === 'mixed' || mode === 'unknown') assert.match(await total.innerText(), /세금 기준 확인 필요/)
          const chart = section.getByRole('group', { name: '일별 실제 소진 광고비. 네이버와 당근의 확인된 금액과 수집 상태.', exact: true })
          await chart.scrollIntoViewIfNeeded()
          const target = chart.locator('[data-chart-date]').first()
          if (mobile) await target.tap(); else await target.hover()
          const tooltip = view.getByRole('tooltip', { name: `${dates[0]} 상세 수치`, exact: true })
          await tooltip.waitFor()
          const bounds = await tooltip.boundingBox()
          assert.ok(bounds.x >= 7 && bounds.x + bounds.width <= width - 7)
          if (mode === 'precision') assert.match(await tooltip.innerText(), /9,007,199,254,740,993\.123456789012원/)
          if (output && ['one', 'month', 'missing', 'mixed', 'precision'].includes(mode)) await view.screenshot({ path: path.join(output, `ad-spend-${width}-${mode}.png`) })
          await view.keyboard.press('Escape'); await tooltip.waitFor({ state: 'hidden' })
          await target.focus(); await view.keyboard.press('Enter')
          assert.equal(await target.getAttribute('aria-pressed'), 'true')
          await view.keyboard.press('Escape'); await tooltip.waitFor({ state: 'hidden' })
          const detail = section.locator('details').filter({ hasText: '광고비 일별 상세 펼치기' })
          await detail.locator('summary').click()
          assert.equal(await detail.locator('tbody tr').count(), count)
          await detail.locator('summary').click()
          assert.equal(await view.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
          evidence.push({ width, mode, days: count, status: body.adSpend.total.status, total: body.adSpend.total.total, input: mobile ? 'touch+keyboard' : 'pointer+keyboard' })
        }
      } finally { if (mobile) await mobile.close() }
    }
    assert.equal((await context.request.get(base + '/api/uploads/_reports/ad-spend/current.json')).status(), 404)
    if (output) await writeFile(path.join(output, 'ad-spend-ui.json'), JSON.stringify(evidence, null, 2) + '\n')
    console.log('Ad spend browser passed: PC1440/mobile390/320, disconnected, 1/2/30 days, zero/missing/failure/mixed/unknown VAT, exact precision, table, pointer/touch/keyboard and private no-store API')
  } finally { if (previous === null) await rm(file, { force: true }); else await writeFile(file, previous) }
}
