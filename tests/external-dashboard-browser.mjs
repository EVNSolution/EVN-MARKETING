import assert from 'node:assert/strict'
import { mkdir, writeFile, rm } from 'node:fs/promises'
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
  assert.equal(db.prepare('SELECT count(*) AS n FROM InquirySyncRun').get().n, before, 'dashboard views and refresh never enqueue source collection')
  assert.equal(db.prepare('SELECT count(*) AS n FROM Inquiry').get().n, inquiries)
  console.log('External dashboard browser passed: 1440/390/320, all rankings/media, original denominator, auth/private storage, last-good/stale/zero/empty behavior, no collection writes')
}
