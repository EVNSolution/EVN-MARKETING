import assert from 'node:assert/strict'
import { readFile, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'

export async function checkDaangnMcpUi({ page, context, base, uploads, output }) {
  const file = path.join(uploads, '_reports/ad-spend/current.json')
  const prior = await readFile(file, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return null })
  const report = (date, amount) => ({
    request: { advertiser_id: '4541556', advertiser_request: '합성 일별 조회', start_date: date, end_date: date, metrics: ['COST'], structure: [{ type: 'campaign', filter: ['1786077964797444000'], grouping: true }], page: 1, page_size: 1 },
    response: { totals: { COST: amount }, rows: [{ analysis_items: { CAMPAIGN: { id: '1786077964797444000', name: '합성 EVN' } }, metrics: { COST: amount } }], has_more: false, applied: { start_date: date, end_date: date, duration: 'ALL', page: 1, page_size: 1, sort: null } },
  })
  const body = { version: 1, source: 'daangn_mcp', fetchedAt: new Date().toISOString(), reports: [report('2026-09-11', '1234'), report('2026-09-12', '0')] }
  body.reports[1].response.rows = []
  const json = JSON.stringify(body), endpoint = '/api/external-dashboard/ad-spend/mcp-import'
  try {
    const anonymous = await context.browser().newContext()
    try { assert.equal((await anonymous.request.post(base + endpoint + '?mode=preview', { data: json, headers: { Origin: base, 'Content-Type': 'application/json' }, maxRedirects: 0 })).status(), 401) }
    finally { await anonymous.close() }
    for (const origin of [undefined, 'https://foreign.example.invalid']) {
      assert.equal((await context.request.post(base + endpoint + '?mode=preview', { data: json, headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) } })).status(), 400)
    }
    assert.equal((await context.request.post(base + endpoint + '?mode=import&hash=' + '0'.repeat(64), { data: json, headers: { Origin: base, 'Content-Type': 'application/json' } })).status(), 409)
    for (const width of [1440, 390, 320]) {
      await rm(file, { force: true }); await page.setViewportSize({ width, height: 1000 }); await page.goto(base + '/external-dashboard')
      await page.getByRole('button', { name: '화면 새로고침', exact: true }).waitFor()
      const recovery = page.locator('details').filter({ hasText: '관리자 복구 도구 · 당근 보고서' })
      await recovery.locator('summary').click()
      const importer = page.getByRole('region', { name: '당근 MCP 결과 저장', exact: true })
      await page.getByLabel('당근 MCP 원문 JSON', { exact: true }).setInputFiles({ name: 'synthetic-mcp.json', mimeType: 'application/json', buffer: Buffer.from(json) })
      await page.getByRole('button', { name: 'MCP 결과 미리보기', exact: true }).click()
      await importer.getByText('수집된 금액 1,234원 · 부가세 기준 미확인', { exact: true }).waitFor()
      assert.match(await importer.innerText(), /원본 미포함 1일: 2026-09-12/)
      assert.equal(await readFile(file, 'utf8').catch(() => null), null, 'MCP preview is read-only')
      if (output) await page.screenshot({ path: path.join(output, `mcp-${width}-preview.png`) })
      await page.getByRole('button', { name: '확인한 MCP 결과 저장', exact: true }).click()
      await importer.getByRole('status').filter({ hasText: 'MCP 결과 1행을 저장했습니다' }).waitFor()
      const saved = JSON.parse(await readFile(file, 'utf8'))
      assert.equal(saved.rows[0].provenance.kind, 'daangn_mcp'); assert.equal(saved.lastDaangnImport, null)
      const check = await (await context.request.get(base + '/api/external-dashboard?start=2026-09-11&end=2026-09-12')).json()
      assert.equal(check.adSpend.lastDaangnMcpImport.rows, 1)
      assert.equal(check.adSpend.days[1].providers.daangn.total, null)
      assert.doesNotMatch(JSON.stringify(check.adSpend), /provenance|hash|4541556|1786077964797444000/)
      await page.getByLabel('성과 시작일', { exact: true }).fill('2026-09-11')
      await page.getByLabel('성과 종료일', { exact: true }).fill('2026-09-12')
      const pending = page.waitForResponse(r => new URL(r.url()).pathname === '/api/external-dashboard')
      await page.getByRole('button', { name: '기간 조회', exact: true }).click(); await pending
      await page.getByRole('button', { name: '화면 새로고침', exact: true }).waitFor()
      const spend = page.getByRole('region', { name: '실제 소진 광고비', exact: true })
      const card = spend.getByRole('article', { name: '당근 비즈니스', exact: true })
      assert.equal(await card.locator('p').first().innerText(), '1,234원')
      assert.match(await card.innerText(), /일부 누락[\s\S]*부가세 미확인/)
      assert.equal(await spend.getByRole('article', { name: '전체 광고비', exact: true }).locator('p').first().innerText(), '—')
      assert.equal(await spend.locator('[data-spend-bar=daangn]').count(), 1, 'unknown VAT remains visible, missing day has no zero bar')
      await spend.scrollIntoViewIfNeeded()
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
      if (output) await page.screenshot({ path: path.join(output, `mcp-${width}-saved.png`) })
    }
    console.log('Daangn MCP UI passed: admin/Origin, preview+import, distinct provenance, partial/unknown amount visible, missing not zero, total withheld, 1440/390/320')
  } finally { if (prior === null) await rm(file, { force: true }); else await writeFile(file, prior) }
}
