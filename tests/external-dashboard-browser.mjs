import assert from 'node:assert/strict'
import { mkdir, writeFile, rm, rmdir } from 'node:fs/promises'
import path from 'node:path'

// Uses only the caller's disposable synthetic database and upload directory.
export async function checkExternalDashboardUi({ page, context, db, base, uploads, output }) {
  const before = db.prepare('SELECT count(*) AS n FROM InquirySyncRun').get().n
  const inquiries = db.prepare('SELECT count(*) AS n FROM Inquiry').get().n
  const file = path.join(uploads, '_reports/external-dashboard/current.json')
  await mkdir(path.dirname(file), { recursive: true })
  const dates = Array.from({ length: 27 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`)
  const record = {
    format: 1, source: 'mleverage-admin', companyScopeId: '55f9a8bb-73f9-4316-bcd7-7dcdce0bdcc3', homepageScopeId: '5c7a6115-a0a9-4e8d-bf65-efce52195fa4',
    lastAttemptAt: new Date().toISOString(), lastSuccessfulAt: new Date().toISOString(), error: null,
    data: {
      aggregationDates: dates,
      monthlyViews: dates.map((date, i) => ({ date, visitorCount: 10 + i, pageViewCount: 20 + 2 * i })),
      monthlyAdViews: dates.flatMap((date, i) => ['구글', '네이버', '당근', '카카오', 'Bing', '기타', '메타'].map((media, index) => ({ date, media, count: index === 6 ? 0 : 1 + i + index }))),
      monthlyInflows: Array.from({ length: 10 }, (_, i) => ({ source: `합성 네트워크 ${i + 1}`, count: i + 1 })),
      monthlyKeywords: Array.from({ length: 712 }, (_, i) => ({ keyword: `합성 키워드 ${i + 1}`, count: 1 })),
    },
  }
  const save = () => writeFile(file, JSON.stringify(record))
  const visitors = page.getByRole('heading', { name: '전체 방문자', exact: true }).locator('..').locator('p').first()
  await save()
  const refresh = async () => {
    const response = page.waitForResponse(r => r.url().endsWith('/api/external-dashboard'))
    await page.getByRole('button', { name: '화면 새로고침', exact: true }).click()
    await response
    await page.getByRole('button', { name: '화면 새로고침', exact: true }).waitFor()
  }
  const anonymous = await context.browser().newContext()
  try {
    for (const [endpoint, expected] of [['/external-dashboard', 307], ['/api/external-dashboard', 401], ['/api/uploads/_reports/external-dashboard/current.json', 307]]) {
      const response = await anonymous.request.get(base + endpoint, { maxRedirects: 0 })
      assert.equal(response.status(), expected)
      if (expected === 307) assert.match(response.headers().location, /\/login/)
    }
  } finally { await anonymous.close() }
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 })
    await page.goto(base + '/external-dashboard')
    await page.getByRole('button', { name: '화면 새로고침', exact: true }).waitFor()
    assert.equal(await page.getByRole('navigation').getByRole('link', { name: '대시보드(외부)', exact: true }).count(), 1)
    assert.equal(await page.getByRole('heading', { name: '대시보드(외부)', exact: true }).count(), 1)
    assert.equal(await visitors.innerText(), '621')
    assert.equal(await page.getByText('1,242', { exact: true }).count(), 1)
    const keywordList = page.getByRole('region', { name: '유입 키워드 전체 목록' })
    assert.equal(await keywordList.locator('tbody tr').count(), 712)
    const last = keywordList.getByText('합성 키워드 712', { exact: true })
    await last.scrollIntoViewIfNeeded()
    assert.equal(await last.isVisible(), true)
    const share = await last.locator('..').locator('td').nth(2).innerText()
    await page.getByLabel('유입 키워드 검색').fill('합성 키워드 712')
    assert.equal(await keywordList.locator('tbody tr').count(), 1)
    assert.equal(await keywordList.locator('tbody tr td').nth(2).innerText(), share, 'filter retains full-list denominator')
    await page.getByLabel('유입 키워드 검색').fill('')
    await page.getByText('매체별 원본 수치 펼치기 (189건)', { exact: true }).click()
    const raw = page.locator('details').filter({ hasText: '매체별 원본 수치 펼치기' })
    assert.equal(await raw.locator('tbody tr').count(), 189, 'all original media rows are accessible, including hidden original-chart series')
    assert.equal(await raw.getByText('Bing', { exact: true }).count(), 27)
    assert.equal(await page.getByText('● Bing', { exact: true }).count(), 0)
    assert.equal(await page.getByText('● 메타', { exact: true }).count(), 0, 'zero-only series follow original chart hiding')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await page.getByText('매체별 원본 수치 펼치기 (189건)', { exact: true }).click()
    await page.locator('main').evaluate(element => element.scrollTo(0, 0))
    if (output) await page.screenshot({ path: path.join(output, `external-dashboard-${width}.png`), fullPage: true })
  }
  await checkChartSpacing({ page, base, record, save, output })
  await checkChartTooltips({ page, context, base, record, save, output })
  const historical = { date: '2026-08-31', view: { date: '2026-08-31', visitorCount: 77, pageViewCount: 88, collectedAt: '2026-09-28T00:00:00.000Z' },
    media: [{ date: '2026-08-31', media: '구글', count: 55, collectedAt: '2026-09-28T00:00:00.000Z' }] }
  const history = { format: 1, latest: record, days: [historical, ...dates.map(date => ({ date,
    view: { ...record.data.monthlyViews.find(row => row.date === date), collectedAt: record.lastSuccessfulAt },
    media: record.data.monthlyAdViews.filter(row => row.date === date).map(row => ({ ...row, collectedAt: record.lastSuccessfulAt })),
  }))] }
  const older = { ...record, lastAttemptAt: historical.view.collectedAt, lastSuccessfulAt: historical.view.collectedAt,
    data: { aggregationDates: ['2026-08-31'], monthlyViews: [historical.view], monthlyAdViews: historical.media,
      monthlyInflows: [{ source: '과거 전체 기간 네트워크', count: 44 }], monthlyKeywords: [{ keyword: '과거 전체 기간 키워드', count: 22 }] } }
  const historyFile = path.join(path.dirname(file), 'history.json'), snapshots = path.join(path.dirname(file), 'snapshots')
  await writeFile(historyFile, JSON.stringify(history)); await mkdir(snapshots, { recursive: true })
  await writeFile(path.join(snapshots, '2026-09-28.json'), JSON.stringify(older))
  const change = async action => {
    const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/external-dashboard')
    void response.catch(() => {})
    await action(); await response
    await page.getByRole('button', { name: '화면 새로고침', exact: true }).waitFor()
  }
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 })
    await page.goto(base + '/external-dashboard')
    await page.getByRole('button', { name: '화면 새로고침', exact: true }).waitFor()
    await page.getByLabel('성과 시작일', { exact: true }).fill('2026-08-31')
    await change(() => page.getByRole('button', { name: '시작일 하루 조회', exact: true }).click())
    assert.equal(await visitors.innerText(), '77', 'archived day outside the current rolling source remains selectable')
    const rankingScope = page.getByRole('region', { name: '원본 전체 기간 집계', exact: true })
    assert.match(await rankingScope.innerText(), /네트워크·키워드는 일별 수치가 제공되지 않습니다/)
    assert.match(await rankingScope.innerText(), /2026-09-01 ~ 2026-09-27/, 'ranking keeps the actual original period, not selected Aug31')
    await change(() => page.getByLabel('원본 보관본 수집일 (한국 시간)', { exact: true }).selectOption('2026-09-28'))
    assert.equal(await page.getByText('과거 전체 기간 키워드', { exact: true }).count(), 1)
    assert.match(await rankingScope.innerText(), /2026-08-31 ~ 2026-08-31/)
    assert.equal(await visitors.innerText(), '77', 'ranking snapshot selection does not change performance dates')
    await page.getByLabel('성과 종료일', { exact: true }).fill('2026-09-02')
    await change(() => page.getByRole('button', { name: '기간 조회', exact: true }).click())
    assert.equal(await visitors.innerText(), '98')
    await change(() => page.getByRole('button', { name: '오늘', exact: true }).click())
    assert.equal(await visitors.innerText(), '—')
    await page.getByRole('status').filter({ hasText: '원본 공개 대기' }).waitFor()
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    if (output) await page.screenshot({ path: path.join(output, `external-dashboard-history-${width}.png`), fullPage: true })
    await change(() => page.getByRole('button', { name: '기존 집계 보기', exact: true }).click())
    assert.equal(await visitors.innerText(), '621')
  }
  for (const suffix of ['?start=2026-02-30&end=2026-03-01', '?snapshot=..%2Fcurrent', '?start=2026-09-01', '?start=2026-09-01&end=2026-09-01&end=2026-09-02']) {
    const invalid = await context.request.get(base + '/api/external-dashboard' + suffix)
    assert.equal(invalid.status(), 400)
    assert.match(invalid.headers()['cache-control'], /private.*no-store/)
  }
  for (const privatePath of ['history.json', 'snapshots/2026-09-28.json']) assert.equal((await context.request.get(base + '/api/uploads/_reports/external-dashboard/' + privatePath)).status(), 404)
  await rm(historyFile); await rm(path.join(snapshots, '2026-09-28.json')); await rmdir(snapshots)
  const api = await context.request.get(base + '/api/external-dashboard')
  assert.equal(api.status(), 200)
  assert.match(api.headers()['cache-control'], /private.*no-store/)
  assert.equal((await api.json()).record.data.monthlyKeywords.length, 712)
  assert.equal((await context.request.get(base + '/api/uploads/_reports/external-dashboard/current.json')).status(), 404)
  assert.equal((await context.request.post(base + '/api/external-dashboard', { headers: { Origin: base } })).status(), 405)
  record.error = 'dashboard_timeout'
  record.lastAttemptAt = new Date().toISOString()
  record.lastSuccessfulAt = new Date(Date.now() - 3 * 3_600_000).toISOString()
  await save()
  await refresh()
  await page.getByText(/마지막 성공 데이터를 표시합니다/).waitFor()
  assert.equal(await visitors.innerText(), '621')
  assert.equal(await page.getByText(/마지막 수집 성공 후 2시간/).count(), 1)
  await writeFile(file, '{broken')
  await refresh()
  await page.getByRole('alert').filter({ hasText: '표시 중인 마지막 성공 데이터는 유지됩니다' }).waitFor()
  assert.equal(await visitors.innerText(), '621', 'storage error preserves already displayed successful data')
  await save()
  db.prepare("UPDATE InquirySyncState SET status='login_required',workerOwner='synthetic-dashboard-ui',workerHeartbeatAt=?,workerLeaseExpiresAt=?")
    .run(new Date().toISOString(), new Date(Date.now() + 180_000).toISOString())
  await refresh()
  await page.getByText(/원본 서비스 연결을 기다리고 있습니다/).waitFor()
  record.data.monthlyViews = dates.map(date => ({ date, visitorCount: 0, pageViewCount: 0 }))
  record.error = null
  await save()
  await refresh()
  assert.equal(await page.getByRole('heading', { name: '전체 방문자', exact: true }).locator('..').locator('p').first().innerText(), '0', 'real zero is displayed as zero')
  await rm(file)
  await page.reload()
  await page.getByText(/아직 성공적으로 수집된 대시보드가 없습니다/).waitFor()
  assert.equal(await page.getByRole('heading', { name: '전체 방문자', exact: true }).locator('..').locator('p').first().innerText(), '—', 'missing snapshot is never a fabricated zero')
  await writeFile(file, JSON.stringify({ ...record, data: null, lastSuccessfulAt: null, error: 'dashboard_timeout' }))
  await refresh()
  await page.getByText(/첫 수집이 완료되면 수치가 표시됩니다/).waitFor()
  assert.equal(await page.getByText(/마지막 성공 데이터를 표시합니다/).count(), 0, 'first failure does not claim a previous success exists')
  assert.equal(db.prepare('SELECT count(*) AS n FROM InquirySyncRun').get().n, before, 'dashboard views and refresh never enqueue source collection')
  assert.equal(db.prepare('SELECT count(*) AS n FROM Inquiry').get().n, inquiries)
  console.log('External dashboard browser passed: 1440/390/320, all rankings/media, original denominator, auth/private storage, last-good/stale/zero/empty behavior, no collection writes')
}

async function checkChartSpacing({ page, base, record, save, output }) {
  const original = record.data
  const results = []
  try {
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 })
      let previousSpan = -1
      for (const count of [1, 2, 3, 6, 30]) {
        const dates = Array.from({ length: count }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`)
        record.data = { ...original, aggregationDates: dates,
          monthlyViews: dates.map((date, i) => ({ date, visitorCount: 10 + i, pageViewCount: 20 + i * 2 })),
          monthlyAdViews: dates.flatMap((date, i) => ['구글', '네이버'].map(media => ({ date, media, count: 5 + i }))),
        }
        await save()
        await page.goto(base + '/external-dashboard')
        await page.getByRole('button', { name: '화면 새로고침', exact: true }).waitFor()
        await page.evaluate(() => document.fonts.ready)
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        const charts = [page.getByRole('group', { name: /^일별 방문자와 페이지뷰 추이/ }),
          page.getByRole('group', { name: /^매체별 일별 광고 유입/ })]
        const positions = [], readability = []
        for (const [index, chart] of charts.entries()) {
          const geometry = await chart.evaluate(svg => {
            const marks = [...svg.querySelectorAll('circle, rect:not([data-chart-date])')]
            const x = element => element.tagName === 'circle' ? Number(element.getAttribute('cx'))
              : Number(element.getAttribute('x')) + Number(element.getAttribute('width')) / 2
            const grid = svg.querySelector('line')
            const ticks = [...svg.querySelectorAll('text[text-anchor="end"]')]
            const dateLabels = [...svg.querySelectorAll('text[text-anchor="middle"]')]
            const scale = svg.getScreenCTM().a
            return {
              centers: [...new Set(marks.map(x))],
              markDates: marks.map(mark => ({ date: mark.querySelector('title').textContent.slice(5, 10), x: x(mark) })),
              labels: dateLabels.map(label => ({ date: label.textContent, x: Number(label.getAttribute('x')) })),
              labelBounds: dateLabels.map(label => ({ left: label.getBoundingClientRect().left, right: label.getBoundingClientRect().right })),
              smallestFont: Math.min(...[...ticks, ...dateLabels].map(label => parseFloat(getComputedStyle(label).fontSize) * scale)),
              height: svg.getBoundingClientRect().height,
              paths: [...svg.querySelectorAll('path')].map(line => [...line.getAttribute('d').matchAll(/[ML]([\d.]+),/g)].map(match => Number(match[1]))),
              left: Number(grid.getAttribute('x1')), right: Number(grid.getAttribute('x2')),
              marksLeft: Math.min(...marks.map(mark => mark.getBBox().x)),
              marksRight: Math.max(...marks.map(mark => mark.getBBox().x + mark.getBBox().width)),
              ticksRight: Math.max(...ticks.map(tick => tick.getBBox().x + tick.getBBox().width)),
              svgWidth: svg.getBoundingClientRect().width, containerWidth: svg.parentElement.clientWidth,
            }
          })
          const xs = geometry.centers, first = xs[0], last = xs.at(-1)
          assert.equal(xs.length, count, 'every date keeps its mark')
          assert.ok(Math.abs((first + last) / 2 - (geometry.left + geometry.right) / 2) < 0.01, 'range is symmetric about plot center')
          assert.ok(geometry.marksLeft > geometry.left && geometry.marksRight < geometry.right, 'marks keep both plot margins')
          assert.ok(geometry.marksLeft > geometry.ticksRight + 10, 'bars never overlap y-axis numbers')
          assert.ok(geometry.smallestFont >= 10, 'date and value labels retain at least 10 CSS pixels')
          assert.ok(geometry.height >= 200, 'chart retains enough vertical space on small screens')
          for (let i = 1; i < geometry.labelBounds.length; i++) assert.ok(geometry.labelBounds[i].left >= geometry.labelBounds[i - 1].right + 4, `date labels retain readable separation (${width}px/${count} days: ${JSON.stringify(geometry.labelBounds)})`)
          for (let i = 1; i < xs.length; i++) {
            assert.ok(xs[i] > xs[i - 1], 'dates remain chronological')
            assert.ok(xs[i] - xs[i - 1] <= 100.01, 'short ranges do not stretch to opposite edges')
          }
          for (const label of geometry.labels) assert.ok(geometry.markDates.some(mark => mark.date === label.date && Math.abs(mark.x - label.x) < 0.01), 'date labels align with their marks')
          for (const path of geometry.paths) assert.deepEqual(path, xs, 'line vertices align with circles')
          if (count <= 6) assert.ok(geometry.svgWidth <= geometry.containerWidth + 1, 'short mobile ranges fit the visible chart')
          else assert.ok(last - first > (geometry.right - geometry.left) * 0.8, 'long ranges use the available width')
          positions.push(xs)
          readability.push({ smallestFont: geometry.smallestFont, height: geometry.height, labelBounds: geometry.labelBounds })
          const viewport = chart.locator('..')
          if (output && count !== 3) await viewport.screenshot({ path: path.join(output, `dashboard-spacing-${width}-${count}d-${index ? 'media' : 'visitors'}.png`) })
          if (geometry.svgWidth > geometry.containerWidth + 1) {
            await viewport.evaluate(element => { element.scrollLeft = element.scrollWidth })
            const lastMark = await chart.locator('circle, rect:not([data-chart-date])').last().boundingBox()
            const bounds = await viewport.boundingBox()
            assert.ok(lastMark.x >= bounds.x && lastMark.x + lastMark.width <= bounds.x + bounds.width, 'last date remains reachable by horizontal scrolling')
            if (output) await viewport.screenshot({ path: path.join(output, `dashboard-spacing-${width}-${count}d-${index ? 'media' : 'visitors'}-right.png`) })
            await viewport.evaluate(element => { element.scrollLeft = 0 })
          }
        }
        assert.ok(positions[0].every((x, i) => Math.abs(x - positions[1][i]) < 0.01), 'visitor and media charts share date positions')
        const span = positions[0].at(-1) - positions[0][0]
        assert.ok(span > previousSpan, 'adding dates gradually expands the range')
        previousSpan = span
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
        results.push({ viewport: width, days: count, centers: positions[0], readability })
      }
    }
    if (output) await writeFile(path.join(output, 'dashboard-spacing-qa.json'), JSON.stringify(results, null, 2) + '\n')
    console.log('Chart spacing passed: 1440/390/320px, 1/2/3/6/30 days, centered spacing, readable labels, sufficient height, no overlaps, line/point/bar/date alignment')
  } finally { record.data = original; await save() }
}

async function checkChartTooltips({ page, context, base, record, save, output }) {
  const original = record.data
  const evidence = []
  const chartNames = [/^일별 방문자와 페이지뷰 추이/, /^매체별 일별 광고 유입/]
  const storageState = await context.storageState()
  const load = async view => {
    await view.goto(base + '/external-dashboard')
    await view.getByRole('button', { name: '화면 새로고침', exact: true }).waitFor()
  }
  async function checkCard(view, date, expected) {
    const card = view.getByRole('tooltip', { name: `${date} 상세 수치`, exact: true })
    await card.waitFor({ state: 'visible' })
    assert.equal(await card.locator('p').first().innerText(), `${Number(date.slice(5, 7))}/${Number(date.slice(8))}`)
    const values = await card.locator('dl > div').evaluateAll(rows => rows.map(row => ({
      label: row.querySelector('dt').textContent.trim(), value: row.querySelector('dd').textContent.trim(),
      color: row.querySelector('dt span').style.backgroundColor,
    })))
    assert.deepEqual(values.map(({ label, value }) => [label, value]), expected)
    assert.ok(values.every(value => value.color), 'each series has its colored marker')
    const bounds = await card.boundingBox(), viewport = view.viewportSize()
    assert.ok(bounds.x >= 7 && bounds.y >= 7 && bounds.x + bounds.width <= viewport.width - 7
      && bounds.y + bounds.height <= viewport.height - 7, 'tooltip stays inside the visible viewport')
    return { card, bounds, values }
  }
  try {
    for (const width of [1440, 390, 320]) {
      const touch = width < 1000
      const mobile = touch ? await context.browser().newContext({ storageState, viewport: { width, height: 1000 }, hasTouch: true, isMobile: true }) : null
      if (mobile) await mobile.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort())
      const view = mobile ? await mobile.newPage() : page
      view.setDefaultTimeout(15000)
      await view.setViewportSize({ width, height: 1000 })
      try {
        for (const count of [1, 2, 30]) {
          const dates = Array.from({ length: count }, (_, i) => `2026-09-${String((count === 30 ? 1 : 23) + i).padStart(2, '0')}`)
          record.data = { ...original, aggregationDates: dates,
            monthlyViews: dates.map((date, i) => ({ date, visitorCount: 1359 + i, pageViewCount: 1489 + i })),
            monthlyAdViews: dates.flatMap((date, i) => [
              { date, media: '구글', count: 400 + i }, { date, media: '네이버', count: 500 + i },
              ...(i === 0 ? [{ date, media: '메타', count: 0 }] : []),
            ]),
          }
          await save(); await load(view)
          if (touch) await view.evaluate(() => { window.tooltipPointers = []; document.addEventListener('pointerdown', event => window.tooltipPointers.push(event.pointerType)) })
          for (const [kind, name] of chartNames.entries()) {
            const chart = view.getByRole('group', { name })
            for (const index of [...new Set([0, count - 1])]) {
              const date = dates[index], target = chart.locator(`[data-chart-date="${date}"]`)
              const expected = kind === 0 ? [['방문자', (1359 + index).toLocaleString('ko-KR')], ['페이지뷰', (1489 + index).toLocaleString('ko-KR')]]
                : [['구글', String(400 + index)], ['네이버', String(500 + index)], ['메타', index === 0 ? '0' : '미수집']]
              if (touch) await target.tap(); else await target.hover()
              const { card, bounds, values } = await checkCard(view, date, expected)
              if (output) await view.screenshot({ path: path.join(output, `tooltip-${width}-${count}d-${kind ? 'media' : 'visitors'}-${index ? 'last' : 'first'}.png`) })
              evidence.push({ viewport: width, input: touch ? 'touch' : 'mouse', days: count, date, kind, bounds, values })
              if (touch) {
                await card.tap()
                assert.equal(await card.isVisible(), true, 'touching the card does not dismiss it unexpectedly')
                await target.tap()
                await card.waitFor({ state: 'hidden' })
              } else {
                await card.hover()
                // Outlast the hover close delay to detect flicker when crossing into the card.
                await view.waitForTimeout(300)
                assert.equal(await card.isVisible(), true, 'moving onto the tooltip keeps it open')
                await view.keyboard.press('Escape')
                await card.waitFor({ state: 'hidden' })
              }
            }
            if (!touch) {
              const first = chart.locator('[data-chart-date]').first()
              await first.focus()
              await view.getByRole('tooltip', { name: `${dates[0]} 상세 수치`, exact: true }).waitFor()
              if (count > 1) {
                await view.keyboard.press('ArrowRight')
                await view.getByRole('tooltip', { name: `${dates[1]} 상세 수치`, exact: true }).waitFor()
                await view.keyboard.press('End')
                await view.getByRole('tooltip', { name: `${dates.at(-1)} 상세 수치`, exact: true }).waitFor()
              }
              await view.keyboard.press('Escape')
              await view.getByRole('tooltip').waitFor({ state: 'hidden' })
              await view.keyboard.press('Enter')
              await view.getByRole('tooltip').waitFor()
              await view.keyboard.press('Enter')
              await view.getByRole('tooltip').waitFor({ state: 'hidden' })
              await first.evaluate(element => element.blur())
            }
          }
          if (touch) assert.ok((await view.evaluate(() => window.tooltipPointers)).every(type => type === 'touch'), 'mobile cases use real touch input')
          if (count === 30) {
            const chart = view.getByRole('group', { name: chartNames[0] })
            const first = chart.locator('[data-chart-date]').first()
            if (touch) {
              await first.tap()
              await view.getByRole('tooltip').waitFor()
              await chart.locator('..').evaluate(element => { element.scrollLeft = element.scrollWidth })
              await view.getByRole('tooltip').waitFor({ state: 'hidden' })
              await chart.locator('[data-chart-date]').last().tap()
            } else await first.click()
            const changed = view.waitForResponse(response => response.url().includes('/api/external-dashboard?'))
            await view.getByLabel('성과 시작일', { exact: true }).fill(dates.at(-1))
            await view.getByLabel('성과 종료일', { exact: true }).fill(dates.at(-1))
            await view.getByRole('button', { name: '기간 조회', exact: true }).click()
            await changed
            await view.getByRole('button', { name: '화면 새로고침', exact: true }).waitFor()
            assert.equal(await view.getByRole('tooltip').count(), 0, 'changing the period clears the old tooltip')
            assert.equal(await chart.locator('[data-chart-date]').count(), 1)
          }
        }
      } finally { if (mobile) await mobile.close() }
    }
    // A real zero and an absent observation remain distinguishable, including keyboard access to missing days.
    record.data = { ...original, aggregationDates: ['2026-09-23', '2026-09-25'],
      monthlyViews: [{ date: '2026-09-23', visitorCount: 0, pageViewCount: 0 }, { date: '2026-09-25', visitorCount: 7, pageViewCount: 9 }],
      monthlyAdViews: [{ date: '2026-09-23', media: '구글', count: 1 }],
    }
    await save(); await page.setViewportSize({ width: 1440, height: 1000 }); await load(page)
    const chart = page.getByRole('group', { name: chartNames[0] })
    await chart.locator('[data-chart-date="2026-09-23"]').focus()
    await checkCard(page, '2026-09-23', [['방문자', '0'], ['페이지뷰', '0']])
    await page.keyboard.press('ArrowRight')
    await checkCard(page, '2026-09-24', [['방문자', '미수집'], ['페이지뷰', '미수집']])
    if (output) await page.screenshot({ path: path.join(output, 'tooltip-missing-keyboard.png') })
    await page.keyboard.press('Escape')
    if (output) await writeFile(path.join(output, 'tooltip-qa.json'), JSON.stringify(evidence, null, 2) + '\n')
    console.log('Chart tooltips passed: PC hover/card handoff, real 390/320 touch, keyboard/arrows/Enter/Escape, 1/2/30-day edges, scroll dismissal, range reset, zero versus missing, viewport bounds')
  } finally { record.data = original; await save() }
}
