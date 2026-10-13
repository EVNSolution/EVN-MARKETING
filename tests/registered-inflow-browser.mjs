import assert from 'node:assert/strict'
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

// Runs only with the parent browser test's disposable database/report directory.
export async function checkRegisteredInflowUi({ page, context, db, base, file, save, output }) {
  const collected = ['mleverage-admin', '55f9a8bb-73f9-4316-bcd7-7dcdce0bdcc3', '5c7a6115-a0a9-4e8d-bf65-efce52195fa4']
  const landing = ['evn-landing', 'evnsolution', 'pv5']
  const at = new Date().toISOString(), today = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10)
  const ids = [], evidence = []
  const insert = (date, phone, source = collected, error = null, delivered = at) => {
    const id = `registered-inflow-ui-${ids.length}`
    ids.push(id)
    db.prepare('INSERT INTO Inquiry(id,source,companyScopeId,homepageScopeId,sourceId,inquiryDate,inquiryTime,name,phone,lastSeenAt,warpDeliveredAt,warpError) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, ...source, id, date, '09:00', 'private-inflow-ui-name', phone, at, delivered, error)
  }
  const days = Array.from({ length: 30 }, (_, i) => `2026-08-${String(i + 1).padStart(2, '0')}`)
  const phone = index => `0109798${String(index).padStart(4, '0')}`
  const expected = date => date === '2026-08-04' || date === '2026-08-10' || !days.includes(date) ? 0 : 1
  for (let i = 0; i < days.length; i++) if (i !== 3) insert(days[i], phone(i), i % 2 ? landing : collected,
    i === 1 ? 'warp_manual_confirmed' : i === 2 ? 'warp_customer_lead_complete' : null, i === 1 ? null : at)
  insert('2026-08-02', '+82 10 9798 0000', landing)
  insert('2026-07-31', phone(9))
  insert(today, '01097989999', landing, 'warp_customer_lead_complete')
  insert(today, '01097989998', landing, 'warp_customer_only')
  const state = await context.storageState()
  try {
    for (const width of [1440, 390, 320]) {
      const touch = width < 1000
      const mobile = touch ? await context.browser().newContext({ storageState: state, viewport: { width, height: 1000 }, hasTouch: true, isMobile: true }) : null
      if (mobile) await mobile.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort())
      const view = mobile ? await mobile.newPage() : page
      view.setDefaultTimeout(30000)
      await view.setViewportSize({ width, height: 1000 })
      try {
        await view.goto(base + '/external-dashboard')
        await view.getByRole('button', { name: '화면 새로고침', exact: true }).waitFor()
        const metric = view.getByRole('heading', { name: '등록완료 DB 유입', exact: true }).locator('..')
        assert.match(await metric.innerText(), /기존 수집 문의 · 새 홈페이지 문의 모두 포함/)
        for (const [start, end, count] of [[days[0], days[0], 1], [days[0], days[1], 2], [days[0], days.at(-1), 30], ['2026-07-30', '2026-07-30', 0]]) {
          await view.getByLabel('성과 시작일', { exact: true }).fill(start)
          await view.getByLabel('성과 종료일', { exact: true }).fill(end)
          const response = view.waitForResponse(r => new URL(r.url()).pathname === '/api/external-dashboard')
          await view.getByRole('button', { name: '기간 조회', exact: true }).click()
          const api = await response, body = await api.json()
          await view.getByRole('button', { name: '화면 새로고침', exact: true }).waitFor()
          assert.equal(api.status(), 200)
          assert.match(api.headers()['cache-control'], /private.*no-store/)
          assert.deepEqual(Object.keys(body.registeredInflow).sort(), ['days', 'end', 'start', 'total'])
          assert.doesNotMatch(JSON.stringify(body), /private-inflow-ui-name|0109798|registered-inflow-ui-/)
          assert.deepEqual(body.registeredInflow.days.map(day => day.count), body.registeredInflow.days.map(day => expected(day.date)))
          const total = body.registeredInflow.days.reduce((sum, day) => sum + day.count, 0)
          assert.equal(body.registeredInflow.total, total)
          assert.equal(await metric.locator('p').first().innerText(), `${total}건`)
          const chart = view.getByRole('group', { name: /^일별 DB 유입\./ })
          assert.equal(await chart.locator('[data-chart-date]').count(), Math.max(1, count))
          const geometry = await chart.evaluate(svg => {
            const grid = svg.querySelector('line')
            const bars = [...svg.querySelectorAll('rect:not([data-chart-date])')]
            return { centers: bars.map(bar => Number(bar.getAttribute('x')) + Number(bar.getAttribute('width')) / 2),
              plotCenter: (Number(grid.getAttribute('x1')) + Number(grid.getAttribute('x2'))) / 2,
              ticks: [...svg.querySelectorAll('text[text-anchor="end"]')].map(t => Number(t.textContent.replaceAll(',', ''))) }
          })
          assert.ok(geometry.ticks.every(Number.isInteger))
          assert.equal(new Set(geometry.ticks).size, geometry.ticks.length, 'integer axis has no repeated rounded ticks')
          assert.ok(Math.abs((geometry.centers[0] + geometry.centers.at(-1)) / 2 - geometry.plotCenter) < 0.1, 'short ranges remain centered')
          const details = view.locator('details').filter({ hasText: 'DB 유입 상세 펼치기' })
          await details.locator('summary').click()
          assert.equal(await details.locator('tbody tr').count(), Math.max(1, count))
          await details.locator('summary').click()
          for (const index of [...new Set([0, body.registeredInflow.days.length - 1])]) {
            const day = body.registeredInflow.days[index], target = chart.locator(`[data-chart-date="${day.date}"]`)
            if (touch) await target.tap(); else await target.hover()
            const tooltip = view.getByRole('tooltip', { name: `${day.date} 상세 수치`, exact: true })
            await tooltip.waitFor()
            assert.equal(await tooltip.locator('dd').innerText(), String(day.count))
            const bounds = await tooltip.boundingBox()
            assert.ok(bounds.x >= 7 && bounds.x + bounds.width <= width - 7)
            if (output && index === 0) await view.screenshot({ path: path.join(output, `registered-inflow-${width}-${count}d.png`) })
            await view.keyboard.press('Escape')
            await tooltip.waitFor({ state: 'hidden' })
          }
          const first = chart.locator('[data-chart-date]').first()
          await first.focus()
          await view.keyboard.press('Enter')
          assert.equal(await first.getAttribute('aria-pressed'), 'true')
          if (count > 1) {
            await view.keyboard.press('ArrowRight')
            const second = body.registeredInflow.days[1]
            await view.getByRole('tooltip', { name: `${second.date} 상세 수치`, exact: true }).waitFor()
          }
          await view.keyboard.press('Escape')
          await view.getByRole('tooltip').waitFor({ state: 'hidden' })
          assert.equal(await view.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
          evidence.push({ width, input: touch ? 'touch+keyboard' : 'pointer+keyboard', start, end, total, geometry })
        }
        const response = view.waitForResponse(r => new URL(r.url()).pathname === '/api/external-dashboard')
        await view.getByRole('button', { name: '오늘', exact: true }).click()
        const current = await (await response).json()
        await view.getByRole('button', { name: '화면 새로고침', exact: true }).waitFor()
        assert.equal(current.registeredInflow.total, 1)
        assert.equal(current.history.days[0].view, null)
        assert.equal(await metric.locator('p').first().innerText(), '1건')
        assert.equal(await view.getByRole('heading', { name: '전체 방문자', exact: true }).locator('..').locator('p').first().innerText(), '—')
      } finally { if (mobile) await mobile.close() }
    }
    await rm(file)
    const emptySource = await (await context.request.get(base + '/api/external-dashboard')).json()
    assert.equal(emptySource.record, null)
    assert.equal(emptySource.history.start, null)
    assert.equal(emptySource.registeredInflow.end, today)
    assert.ok(emptySource.registeredInflow.days.length <= 366)
    await page.goto(base + '/external-dashboard')
    await page.getByRole('button', { name: '화면 새로고침', exact: true }).waitFor()
    assert.equal(await page.getByRole('heading', { name: '등록완료 DB 유입', exact: true }).locator('..').locator('p').first().innerText(), `${emptySource.registeredInflow.total}건`)
    assert.equal(await page.getByLabel('성과 시작일', { exact: true }).inputValue(), emptySource.registeredInflow.start)
    const zero = await (await context.request.get(base + '/api/external-dashboard?start=2026-07-30&end=2026-07-30')).json()
    assert.deepEqual(zero.registeredInflow.days, [{ date: '2026-07-30', count: 0 }])
    if (output) await writeFile(path.join(output, 'registered-inflow-ui.json'), JSON.stringify(evidence, null, 2) + '\n')
    console.log('Registered inflow UI passed: 1440/390/320, 1/2/30/zero days, centered integer bars, pointer/touch/keyboard, details, PII-free API and missing-external-data fallback')
  } finally {
    for (const id of ids) db.prepare('DELETE FROM Inquiry WHERE id=?').run(id)
    await save()
  }
}
