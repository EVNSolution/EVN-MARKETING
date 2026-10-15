import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export async function checkCustomerNameUi({ page, context, ordinary, db, base, uploads, output }) {
  if (output) mkdirSync(output, { recursive: true })
  const scope = ['mleverage-admin', '55f9a8bb-73f9-4316-bcd7-7dcdce0bdcc3', '5c7a6115-a0a9-4e8d-bf65-efce52195fa4']
  for (const width of [1440, 390, 320]) {
    const at = new Date().toISOString(), id = `name-unknown-${width}`, named = `name-known-${width}`, another = `name-alternate-${width}`
    for (const [index, key] of [id, named, another].entries()) {
      db.prepare('INSERT INTO Inquiry(id,source,companyScopeId,homepageScopeId,sourceId,inquiryDate,inquiryTime,name,phone,lastSeenAt,warpError,warpDeliveredAt,warpCustomerId,warpActivityId) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(key, ...scope, `00000000-0000-4000-8000-${String(width * 100 + index).padStart(12, '0')}`,
          '2026-10-15', '13:00', index === 0 ? `미상(📞 ${width})` : index === 1 ? `합성 김고객 ${width}` : `합성 다른이름 ${width}`,
          `0102222${String(width).padStart(4, '0')}`, at, index === 1 ? 'warp_customer_lead_complete' : 'warp_duplicate_reviewed',
          index === 1 ? at : null, index === 1 ? 'retained-customer' : null, index === 1 ? 'retained-activity' : null)
    }
    db.prepare("UPDATE InquirySyncState SET status='ready',workerOwner='synthetic-name-worker',workerHeartbeatAt=?,workerLeaseExpiresAt=?")
      .run(at, new Date(Date.now() + 300_000).toISOString())
    let before = db.prepare('SELECT * FROM Inquiry WHERE id IN (?,?,?) ORDER BY id').all(id, named, another)
    await page.setViewportSize({ width, height: 1000 })
    await page.goto(base + `/inquiries?q=${encodeURIComponent(`미상(📞 ${width})`)}&review=reviewed`)
    const row = page.locator(width >= 768 ? 'tbody tr' : 'article').filter({ hasText: `미상(📞 ${width})` })
    await row.getByRole('button', { name: '검토하기', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '중복 문의 검토' })
    const region = dialog.getByRole('region', { name: 'WARP 이름 보완' })
    await region.getByText(/같은 번호에 서로 다른 이름/).waitFor()
    assert.equal(await region.getByRole('button', { name: 'WARP 이름 확인', exact: true }).isDisabled(), true)
    await region.getByLabel('반영할 이름이 있는 문의').selectOption(named)
    const review = await (await context.request.get(base + `/api/inquiries/${id}/duplicate-review`)).json()
    const url = base + `/api/inquiries/${id}/customer-name`
    const data = { action: 'preview', candidateId: named, reviewToken: review.reviewToken }
    assert.equal((await ordinary.context.request.post(url, { headers: { Origin: base }, data })).status(), 403)
    assert.equal((await context.request.post(url, { headers: { Origin: 'https://wrong.example.invalid' }, data })).status(), 400)
    assert.equal((await context.request.post(url, { headers: { Origin: base }, data: { ...data, name: 'injected-name' } })).status(), 400)
    const queued = page.waitForResponse(response => response.url() === url && response.request().method() === 'POST')
    await region.getByRole('button', { name: 'WARP 이름 확인', exact: true }).click()
    const response = await queued; assert.equal(response.status(), 202)
    let job = await response.json()
    assert.equal((await ordinary.context.request.get(url + `?job=${job.id}`)).status(), 403)
    const file = path.join(uploads, '_reports/warp-customer-name/pending.json')
    // Synthetic worker result only. Unit tests exercise the real dispatcher/remote contract and fencing.
    const setResult = (phase, result) => {
      const store = JSON.parse(readFileSync(file, 'utf8'))
      const entry = store.jobs.find(item => item.id === job.id)
      entry.phase = phase; entry.result = result
      writeFileSync(file, JSON.stringify(store), { mode: 0o600 })
    }
    const preview = { ok: true, status: 'ready', proposedName: `합성 김고객 ${width}`, previewToken: 'synthetic-review-only',
      customer: { id: 'synthetic-customer', name: `미상(📞 ${width})`, phone: `0102222${String(width).padStart(4, '0')}` } }
    setResult('ready', preview)
    const confirm = region.getByRole('button', { name: '확인한 이름으로 보완', exact: true })
    await confirm.waitFor(); assert.equal(await confirm.isDisabled(), true)
    assert.equal(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth), true)
    await confirm.scrollIntoViewIfNeeded()
    if (output) await page.screenshot({ path: path.join(output, `customer-name-${width}.png`) })
    await region.getByRole('checkbox', { name: /같은 고객임을 확인했으며/ }).check()
    if (width === 1440) {
      db.prepare('UPDATE Inquiry SET name=? WHERE id=?').run('수정된 다른 실명', another)
      before = db.prepare('SELECT * FROM Inquiry WHERE id IN (?,?,?) ORDER BY id').all(id, named, another)
      const rejected = page.waitForResponse(response => response.url() === url && response.request().method() === 'POST')
      await confirm.click(); assert.equal((await rejected).status(), 409)
      await region.getByRole('alert').filter({ hasText: '문의 내용이 변경됐습니다' }).waitFor()
      await page.waitForTimeout(1800)
      assert.match(await region.getByRole('alert').innerText(), /문의 내용이 변경됐습니다/, 'definitive rejection is not erased by recovery polling')
      assert.equal(await region.getByRole('button', { name: '확인한 이름으로 보완', exact: true }).count(), 0)
      await region.getByRole('button', { name: '검토 내용 새로고침', exact: true }).click()
      await region.getByLabel('반영할 이름이 있는 문의').selectOption(named)
      const refreshed = page.waitForResponse(response => response.url() === url && response.request().method() === 'POST')
      await region.getByRole('button', { name: 'WARP 이름 확인', exact: true }).click()
      const refreshedResponse = await refreshed; assert.equal(refreshedResponse.status(), 202)
      job = await refreshedResponse.json(); setResult('ready', preview)
      await confirm.waitFor(); assert.equal(await confirm.isDisabled(), true)
      await region.getByRole('checkbox', { name: /같은 고객임을 확인했으며/ }).check()
    }
    const submitted = page.waitForResponse(response => response.url() === url && response.request().method() === 'POST')
    await confirm.click(); assert.equal((await submitted).status(), 202)
    await region.getByText(/기존 고객 이름을 보완하고 있습니다/).waitFor()
    setResult('done', { ...preview, previewToken: undefined, status: 'updated', customer: { ...preview.customer, name: preview.proposedName }, auditId: 'synthetic-audit' })
    await region.getByText(/기존 WARP 고객 이름을 보완했습니다/).waitFor()
    assert.deepEqual(db.prepare('SELECT * FROM Inquiry WHERE id IN (?,?,?) ORDER BY id').all(id, named, another), before)
    assert.ok(!JSON.stringify(await (await context.request.get(url + `?job=${job.id}`)).json()).includes('synthetic-review-only'))
    await dialog.getByRole('button', { name: '검토창 닫기' }).click()
    db.prepare('DELETE FROM Inquiry WHERE id IN (?,?,?)').run(id, named, another)
  }
  console.log('Name enrichment UI passed: desktop/390/320px, historical named peer, explicit choice and confirmation, role/origin/DTO guards, private token, pending/result and preserved inquiry evidence')
}
