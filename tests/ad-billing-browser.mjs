import assert from 'node:assert/strict'
import { readFile, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import bcrypt from 'bcryptjs'

// Disposable synthetic DB/uploads only. No live transactions, credentials or outbound collection.
const csv = '\uFEFF거래 일시,거래 유형,거래 내용,금액\r\n2026.09.03. 12:30:05,유상캐시 충전,합성카드(0000),10000\r\n2026.09.03. 12:30:05,유상캐시 충전,합성카드(0000),10000\r\n2026.09.30. 23:59:59,광고캐시 사용,광고 집행,300\r\n'
async function checkBalanceNotice(page, lastDay) {
  const balance = page.getByRole('region', { name: '월말 잔액', exact: true })
  await balance.getByText('월말 잔액 확인 필요', { exact: true }).waitFor()
  await balance.getByText(`기준일: ${lastDay} (한국시간, 마지막 날 소진 후)`, { exact: true }).waitFor()
  assert.match(await balance.innerText(), /원본에 월말 잔액을 확인할 자료가 없어 미확인 상태입니다/)
  assert.match(await balance.innerText(), /현재 잔액은 월말 잔액으로 사용하지 않습니다/)
  assert.doesNotMatch(await balance.innerText(), /[\d,]+원|준비 완료/)
}
export async function checkAdBillingUi({ page, context, db, base, uploads, output }) {
  const file = path.join(uploads, '_reports/ad-billing/2026-09.json'), prior = await readFile(file).catch(e => { if (e.code !== 'ENOENT') throw e; return null })
  const params = new URLSearchParams({ start: '2026-09-01', end: '2026-09-30', scope: 'both', capturedAt: '2026-10-01T00:00:00.000Z', confirmed: 'true' })
  const endpoint = `/api/ad-billing/import?${params}&mode=preview`
  const post = (url, data = csv) => context.request.post(base + url, { data, headers: { Origin: base, 'Content-Type': 'text/csv' } })
  try {
    const anonymous = await context.browser().newContext()
    try {
      for (const url of ['/ad-billing', '/api/ad-billing?month=2026-09', '/api/ad-billing/export?month=2026-09&kind=spend', '/api/uploads/_reports/ad-billing/2026-09.json']) assert.equal((await anonymous.request.get(base + url, { maxRedirects: 0 })).status(), 307)
      assert.equal((await anonymous.request.post(base + endpoint, { data: csv, maxRedirects: 0, headers: { Origin: base, 'Content-Type': 'text/csv' } })).status(), 307)
    } finally { await anonymous.close() }
    for (const origin of [undefined, 'https://foreign.example.invalid']) {
      assert.equal((await context.request.post(base + endpoint, { data: csv, headers: { 'Content-Type': 'text/csv', ...(origin ? { Origin: origin } : {}) } })).status(), 400)
    }
    assert.equal((await context.request.post(base + endpoint, { data: csv, headers: { Origin: 'https://foreign.example.invalid', 'X-Forwarded-Host': 'foreign.example.invalid', 'X-Forwarded-Proto': 'https', 'Content-Type': 'text/csv' } })).status(), 400)
    assert.equal((await post(endpoint.replace('mode=preview', 'mode=import') + '&key=' + '0'.repeat(64) + '&revision=' + '0'.repeat(64))).status(), 409)
    assert.equal((await post(endpoint + '&scope=topup')).status(), 400)
    assert.equal((await post(endpoint, csv.replace('유상캐시 충전', '유상캐시 환불'))).status(), 400)
    const evidence = [], storageState = await context.storageState()
    for (const width of [1440, 390, 320]) {
      await rm(file, { force: true })
      const mobile = width < 600 ? await context.browser().newContext({ storageState, viewport: { width, height: 1000 }, isMobile: true, hasTouch: true }) : null
      if (mobile) await mobile.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort())
      const view = mobile ? await mobile.newPage() : page
      view.setDefaultTimeout(15000); await view.setViewportSize({ width, height: 1000 })
      try {
        await view.goto(base + '/ad-billing')
        await view.getByRole('heading', { name: '광고비 정산', exact: true }).waitFor()
        assert.equal(await view.getByRole('navigation').getByRole('link', { name: '광고비 정산', exact: true }).count(), 1)
        const kst = new Date(Date.now() + 9 * 3600000), previous = new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth() - 1, 1)).toISOString().slice(0, 7)
        assert.equal(await view.getByLabel('정산 월', { exact: true }).inputValue(), previous)
        await view.getByLabel('정산 월', { exact: true }).fill('2026-09')
        const topup = view.getByRole('article', { name: '충전내역', exact: true }), spend = view.getByRole('article', { name: '집행내역', exact: true })
        await topup.getByText('미수집', { exact: true }).waitFor()
        await checkBalanceNotice(view, '2026-09-30')
        assert.equal(await view.getByRole('button', { name: '충전내역 엑셀', exact: true }).isDisabled(), true)
        assert.match(await spend.innerText(), /0원이 아닙니다/)
        await view.getByLabel('원본 CSV', { exact: true }).setInputFiles({ name: 'synthetic-ledger.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) })
        await view.getByLabel('파일 수집 기준시각 (한국시간)', { exact: true }).fill('2026-10-01T09:00')
        await view.getByRole('checkbox').check()
        await view.getByRole('button', { name: '변경 내용 미리보기', exact: true }).click()
        const preview = view.getByRole('region', { name: '저장 전 미리보기', exact: true })
        await preview.waitFor()
        assert.match(await preview.innerText(), /원본 3건 · 저장 후 충전·집행내역 준비 완료/)
        assert.match(await preview.innerText(), /월말 잔액은 별도 확인이 필요합니다/)
        assert.match(await preview.innerText(), /20,000원 \(2건\)/)
        assert.equal(await readFile(file).catch(() => null), null, 'preview is read-only')
        assert.equal(await view.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
        if (output) await view.screenshot({ path: path.join(output, `ad-billing-${width}-preview.png`), fullPage: true })
        await view.getByRole('button', { name: '확인하고 저장', exact: true }).click()
        await view.getByRole('status').filter({ hasText: '교체해 저장했습니다' }).waitFor()
        await view.getByRole('region', { name: '충전·집행내역 상태' }).getByText('충전·집행내역 준비 완료', { exact: true }).waitFor()
        await checkBalanceNotice(view, '2026-09-30')
        assert.match(await topup.innerText(), /20,000원[\s\S]*2건[\s\S]*30\/30일/)
        assert.match(await spend.innerText(), /300원[\s\S]*1건/)
        const response = await context.request.get(base + '/api/ad-billing?month=2026-09'), body = await response.json()
        assert.equal(response.status(), 200); assert.match(response.headers()['cache-control'], /private.*no-store/)
        assert.doesNotMatch(JSON.stringify(body), /합성카드|description/)
        assert.equal(body.ready, true)
        for (const [kind, label] of [['topup', '충전내역'], ['spend', '집행내역']]) {
          const attachment = await context.request.get(base + `/api/ad-billing/export?month=2026-09&kind=${kind}&revision=${body.revision}`)
          assert.equal(attachment.status(), 200)
          assert.equal(attachment.headers()['content-type'], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
          const disposition = attachment.headers()['content-disposition']
          assert.match(disposition, /^attachment; filename="daangn-2026-09-(topup|spend)\.xlsx";/)
          assert.equal(decodeURIComponent(disposition.match(/filename\*=UTF-8''([^;]+)/)?.[1] ?? ''), `당근_2026-09_${label}.xlsx`, 'server filename must match the real browser download')
          const pending = view.waitForEvent('download')
          await view.getByRole('button', { name: `${label} 엑셀`, exact: true }).click()
          const download = await pending
          assert.equal(download.suggestedFilename(), `당근_2026-09_${label}.xlsx`)
          assert.equal((await readFile(await download.path())).subarray(0, 2).toString(), 'PK')
          if (output && width === 1440) await download.saveAs(path.join(output, `synthetic-${kind}.xlsx`))
        }
        const before = await readFile(file)
        await view.getByRole('button', { name: '변경 내용 미리보기', exact: true }).click(); await preview.waitFor()
        assert.match(await preview.innerText(), /이미 저장한 동일 자료/)
        await view.getByRole('button', { name: '확인하고 저장', exact: true }).click()
        await view.getByRole('status').filter({ hasText: '중복 저장하지 않았습니다' }).waitFor()
        assert.deepEqual(await readFile(file), before)
        assert.equal((await context.request.get(base + '/api/ad-billing/export?month=2026-09&kind=spend&revision=' + '0'.repeat(64))).status(), 409)
        assert.equal((await context.request.get(base + '/api/uploads/_reports/ad-billing/2026-09.json')).status(), 404)
        await view.getByLabel('정산 월', { exact: true }).fill('2026-08')
        await topup.getByText('미수집', { exact: true }).waitFor()
        await checkBalanceNotice(view, '2026-08-31')
        for (const [month, lastDay] of [['2024-02', '2024-02-29'], ['2025-02', '2025-02-28'], ['2025-12', '2025-12-31'], ['2026-10', '2026-10-31']]) {
          await view.getByLabel('정산 월', { exact: true }).fill(month)
          await checkBalanceNotice(view, lastDay)
        }
        await view.getByLabel('정산 월', { exact: true }).fill('2026-09')
        await topup.getByText('20,000원', { exact: true }).waitFor()
        await view.locator('main').evaluate(el => el.scrollTo(0, 0))
        if (output) await view.screenshot({ path: path.join(output, `ad-billing-${width}-ready.png`), fullPage: true })
        assert.equal(await view.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
        evidence.push({ width, importPreviewSave: true, ready: true, bothDownloads: true, duplicateRetry: true, monthSwitch: true, balanceUnconfirmed: true, monthEndLeapAndYear: true, noOverflow: true })
      } finally { if (mobile) await mobile.close() }
    }
    await rm(file, { force: true })
    const partialParams = new URLSearchParams(params); partialParams.set('capturedAt', '2026-09-30T08:43:52.000Z')
    const partialPreview = await (await post(`/api/ad-billing/import?${partialParams}&mode=preview`)).json()
    assert.equal(partialPreview.after.ready, false)
    assert.deepEqual(partialPreview.after.summaries[1].partialDays, ['2026-09-30'])
    assert.equal((await post(`/api/ad-billing/import?${partialParams}&mode=import&key=${partialPreview.source.key}&revision=${partialPreview.revision}`)).status(), 200)
    await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto(base + '/ad-billing')
    await page.getByLabel('정산 월', { exact: true }).fill('2026-09')
    await page.getByRole('region', { name: '충전·집행내역 상태' }).getByText('충전·집행내역 중간집계', { exact: true }).waitFor()
    await checkBalanceNotice(page, '2026-09-30')
    for (const label of ['충전내역', '집행내역']) {
      const pending = page.waitForEvent('download'); await page.getByRole('button', { name: `${label} 엑셀`, exact: true }).click()
      assert.equal((await pending).suggestedFilename(), `당근_2026-09_${label}_중간집계.xlsx`)
    }
    if (output) await page.screenshot({ path: path.join(output, 'ad-billing-1440-partial.png'), fullPage: true })
    const viewerId = 'synthetic-billing-viewer', password = 'synthetic-billing-password'
    db.prepare('INSERT INTO User(id,name,email,password,role,updatedAt) VALUES(?,?,?,?,?,?)').run(viewerId, '합성 조회자', 'billing-viewer@example.invalid', bcrypt.hashSync(password, 4), 'user', new Date().toISOString())
    const viewer = await context.browser().newContext()
    try {
      const view = await viewer.newPage(); await view.goto(base + '/login')
      await view.locator('input[name=email]').fill('billing-viewer@example.invalid'); await view.locator('input[name=password]').fill(password)
      await view.getByRole('button', { name: '로그인', exact: true }).click(); await view.waitForURL('**/inquiries')
      for (const url of ['/api/ad-billing?month=2026-09', '/api/ad-billing/export?month=2026-09&kind=topup']) assert.equal((await viewer.request.get(base + url)).status(), 403)
      assert.equal((await viewer.request.post(base + endpoint, { data: csv, headers: { Origin: base, 'Content-Type': 'text/csv' } })).status(), 403)
      await view.goto(base + '/ad-billing'); await view.waitForURL('**/inquiries')
      assert.equal(await view.getByRole('link', { name: '광고비 정산', exact: true }).count(), 0)
    } finally { await viewer.close(); db.prepare('DELETE FROM User WHERE id=?').run(viewerId) }
    if (output) await writeFile(path.join(output, 'browser-qa.json'), JSON.stringify(evidence, null, 2) + '\n')
    console.log('Ad billing browser passed: admin/ordinary/anonymous and Origin guards, read-only preview, sparse month coverage, duplicate rows/retry, typed XLSX downloads, month switching, separate unconfirmed month-end balance and leap/year dates, PC1440 + real mobile390/320, private storage')
  } finally { if (prior === null) await rm(file, { force: true }); else await writeFile(file, prior) }
}
