import assert from 'node:assert/strict'
import { readFile, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import bcrypt from 'bcryptjs'
const header = '기간,캠페인 이름,캠페인 ID,비용 (VAT 포함),노출 수,도달 수,클릭 수,클릭률,클릭당 비용(CPC),노출당 비용(CPM)'
const csv = '\uFEFF' + header + '\r\n2026.09.11.,evn 솔루션,1786077964797444000,100.10,10,9,2,20%,50,1000\r\n2026.09.13.,evn 솔루션,1786077964797444000,200.20,10,9,2,20%,100,2000\r\n'
export async function checkDaangnImportUi({ page, context, db, base, uploads, output }) {
  const file = path.join(uploads, '_reports/ad-spend/current.json'), prior = await readFile(file, 'utf8').catch(e => { if (e.code !== 'ENOENT') throw e; return null })
  const endpoint = '/api/external-dashboard/ad-spend/import?mode=preview&start=2026-09-11&end=2026-09-13'
  try {
    const anonymous = await context.browser().newContext()
    try { assert.equal((await anonymous.request.post(base + endpoint, { data: csv, headers: { Origin: base, 'Content-Type': 'text/csv' }, maxRedirects: 0 })).status(), 401) }
    finally { await anonymous.close() }
    for (const origin of [undefined, 'https://foreign.example.invalid']) {
      const headers = { 'Content-Type': 'text/csv', ...(origin ? { Origin: origin } : {}) }
      assert.equal((await context.request.post(base + endpoint, { data: csv, headers })).status(), 400)
    }
    assert.equal((await context.request.post(base + endpoint, { data: csv, headers: { Origin: 'https://foreign.example.invalid', 'X-Forwarded-Host': 'foreign.example.invalid', 'X-Forwarded-Proto': 'https', 'Content-Type': 'text/csv' } })).status(), 400)
    const rejected = await context.request.post(base + endpoint.replace('preview', 'import') + '&hash=' + '0'.repeat(64), { data: csv, headers: { Origin: base, 'Content-Type': 'text/csv' } })
    assert.equal(rejected.status(), 409)
    for (const width of [1440, 390, 320]) {
      await rm(file, { force: true }); await page.setViewportSize({ width, height: 1000 }); await page.goto(base + '/external-dashboard')
      await page.getByRole('button', { name: '화면 새로고침', exact: true }).waitFor()
      const upload = page.locator('details').filter({ hasText: '관리자 복구 도구 · 당근 보고서' })
      assert.equal(await upload.getAttribute('open'), null, 'recovery tool is collapsed by default')
      assert.equal(await page.getByRole('region', { name: '실제 소진 광고비', exact: true }).locator('input[type=file]').count(), 0)
      assert.ok(await upload.evaluate(el => Boolean(el.previousElementSibling?.textContent)), 'recovery tool follows dashboard content')
      const bounds = await upload.boundingBox(), spendBounds = await page.getByRole('region', { name: '실제 소진 광고비', exact: true }).boundingBox()
      assert.ok(bounds.y >= spendBounds.y + spendBounds.height, 'recovery is below spend cards and charts')
      await upload.locator('summary').click()
      assert.match(await upload.innerText(), /4541556[\s\S]*1786077964797444000/)
      await page.getByLabel('보고서 시작일', { exact: true }).fill('2026-09-11')
      await page.getByLabel('보고서 종료일', { exact: true }).fill('2026-09-13')
      await page.getByLabel('당근 원본 CSV', { exact: true }).setInputFiles({ name: 'synthetic-report.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) })
      await page.getByRole('button', { name: '보고서 미리보기', exact: true }).click()
      await upload.getByText(/파일 내 금액 합계 300.30원/).waitFor()
      assert.match(await upload.innerText(), /원본 미포함 1일: 2026-09-12/)
      assert.equal(await readFile(file, 'utf8').catch(() => null), null, 'preview is read-only')
      await upload.scrollIntoViewIfNeeded()
      if (output) await page.screenshot({ path: path.join(output, `daangn-import-${width}-preview.png`) })
      await page.getByRole('button', { name: '확인한 보고서 가져오기', exact: true }).click()
      await upload.getByRole('status').filter({ hasText: '2행을 가져왔습니다' }).waitFor()
      const response = await context.request.get(base + '/api/external-dashboard?start=2026-09-11&end=2026-09-13')
      const body = await response.json()
      assert.equal(body.adSpend.providers.daangn.total, null)
      assert.equal(body.adSpend.providers.daangn.groups[0].amount, '300.30')
      assert.equal(body.adSpend.days[1].providers.daangn.status, 'missing')
      assert.equal(body.adSpend.lastDaangnImport.rows, 2)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
      if (output) await page.screenshot({ path: path.join(output, `daangn-import-${width}-done.png`) })
    }
    const today = (await (await context.request.get(base + '/api/external-dashboard')).json()).history.today
    const todayCsv = header + '\n' + today.replaceAll('-', '.') + '.,evn 솔루션,1786077964797444000,5,1,1,1,100%,5,5\n'
    const query = `/api/external-dashboard/ad-spend/import?start=${today}&end=${today}`
    const preview = await (await context.request.post(base + query + '&mode=preview', { data: todayCsv, headers: { Origin: base, 'Content-Type': 'text/csv' } })).json()
    assert.equal((await context.request.post(base + query + '&mode=import&hash=' + preview.preview.hash, { data: todayCsv, headers: { Origin: base, 'Content-Type': 'text/csv' } })).status(), 200)
    const current = await (await context.request.get(base + `/api/external-dashboard?start=${today}&end=${today}`)).json()
    assert.equal(current.adSpend.providers.daangn.status, 'provisional')
    const viewerId = 'synthetic-ad-viewer'
    db.prepare('INSERT INTO User(id,name,email,password,role,updatedAt) VALUES(?,?,?,?,?,?)').run(viewerId, '합성 조회자', 'ad-viewer@example.invalid', bcrypt.hashSync('synthetic-viewer-password', 4), 'user', new Date().toISOString())
    const viewer = await context.browser().newContext()
    try {
      const view = await viewer.newPage(); await view.goto(base + '/login')
      await view.locator('input[name=email]').fill('ad-viewer@example.invalid'); await view.locator('input[name=password]').fill('synthetic-viewer-password')
      await view.getByRole('button', { name: '로그인', exact: true }).click(); await view.waitForURL('**/inquiries')
      assert.equal((await viewer.request.post(base + endpoint, { data: csv, headers: { Origin: base, 'Content-Type': 'text/csv' } })).status(), 403)
      assert.equal((await viewer.request.post(base + '/api/external-dashboard/ad-spend/mcp-import?mode=preview', { data: '{}', headers: { Origin: base, 'Content-Type': 'application/json' } })).status(), 403)
      await view.goto(base + '/external-dashboard'); await view.getByRole('button', { name: '화면 새로고침', exact: true }).waitFor()
      assert.equal(await view.getByText('관리자 복구 도구 · 당근 보고서', { exact: true }).count(), 0)
    } finally { await viewer.close(); db.prepare('DELETE FROM User WHERE id=?').run(viewerId) }
    console.log('Daangn import browser passed: admin-only + Origin, exact target, read-only preview, sparse CSV commit/receipt, today provisional, PC1440/mobile390/320')
  } finally { if (prior === null) await rm(file, { force: true }); else await writeFile(file, prior) }
}
