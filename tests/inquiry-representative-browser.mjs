import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

export async function checkRepresentativeUi({ page, context, ordinary, db, base, output }) {
  if (output) mkdirSync(output, { recursive: true })
  const scope = ['mleverage-admin', '55f9a8bb-73f9-4316-bcd7-7dcdce0bdcc3', '5c7a6115-a0a9-4e8d-bf65-efce52195fa4']
  for (const width of [1440, 390, 320]) {
    const at = new Date().toISOString()
    const id = `representative-${width}`, sibling = `representative-peer-${width}`
    for (const key of [id, sibling]) {
      db.prepare('INSERT INTO Inquiry(id,source,companyScopeId,homepageScopeId,sourceId,inquiryDate,inquiryTime,name,phone,lastSeenAt,warpError) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(key, ...scope, `00000000-0000-4000-8000-${String(width * 10 + (key === id ? 1 : 2)).padStart(12, '0')}`,
          '2026-10-15', '09:00', key === id ? `대표 합성 ${width}` : `추가 합성 ${width}`, `0101111${String(width).padStart(4, '0')}`, at, 'warp_duplicate_reviewed')
    }
    db.prepare("UPDATE InquirySyncState SET status='ready',workerOwner='synthetic-ui-worker',workerHeartbeatAt=?,workerLeaseExpiresAt=?")
      .run(at, new Date(Date.now() + 300_000).toISOString())
    await page.setViewportSize({ width, height: 1000 })
    await page.goto(base + `/inquiries?q=${encodeURIComponent(`대표 합성 ${width}`)}`)
    const row = page.locator(width >= 768 ? 'tbody tr' : 'article').filter({ hasText: `대표 합성 ${width}` })
    await row.getByRole('button', { name: '검토하기', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '중복 문의 검토' })
    const register = dialog.getByRole('button', { name: '이 문의를 대표로 등록', exact: true })
    await register.waitFor()
    assert.equal(await register.isDisabled(), true)
    assert.equal(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth), true)
    const url = base + `/api/inquiries/${id}/duplicate-review`
    const review = await (await context.request.get(url)).json()
    const data = { action: 'register-representative', reviewToken: review.reviewToken }
    assert.equal((await ordinary.context.request.post(url, { headers: { Origin: base }, data })).status(), 403)
    assert.equal((await context.request.post(url, { headers: { Origin: 'https://wrong.example.invalid' }, data })).status(), 400)
    if (output) await page.screenshot({ path: path.join(output, `representative-${width}.png`) })
    await dialog.getByRole('checkbox', { name: /이 문의를 같은 연락처 문의의 대표로 선택/ }).check()
    const queued = page.waitForResponse(response => response.url() === url && response.request().method() === 'POST')
    await register.click()
    assert.equal((await queued).status(), 202)
    await dialog.getByText('대표 문의의 WARP 등록을 확인 중입니다. 완료되면 결과가 표시됩니다.', { exact: true }).waitFor()
    assert.equal(db.prepare('SELECT warpError FROM Inquiry WHERE id=?').get(id).warpError, 'warp_manual_requested')
    assert.equal(db.prepare('SELECT warpError FROM Inquiry WHERE id=?').get(sibling).warpError, `warp_duplicate_of:${id}`)
    // Only this synthetic fixture supplies completion; unit tests verify the actual worker receipt.
    db.prepare("UPDATE Inquiry SET warpError='warp_customer_lead_complete',warpDeliveredAt=?,warpActivityId=?,warpCustomerId=? WHERE id=?")
      .run(at, `synthetic-activity-${width}`, `synthetic-customer-${width}`, id)
    await dialog.getByRole('region', { name: '등록 대표 문의' }).getByText('고객·리드 등록완료', { exact: true }).waitFor()
    await dialog.getByRole('button', { name: '검토창 닫기' }).click()
    await page.goto(base + `/inquiries?q=${encodeURIComponent(`추가 합성 ${width}`)}&review=reviewed`)
    const peer = page.locator(width >= 768 ? 'tbody tr' : 'article').filter({ hasText: `추가 합성 ${width}` })
    await peer.getByText('중복 문의 · 대표 건 등록완료', { exact: true }).waitFor()
    assert.equal(await peer.getByRole('button', { name: '등록하기', exact: true }).count(), 0)
    assert.equal(await peer.getByText('중복 문의 · 대표 건 등록완료', { exact: true }).evaluate(el => el.tagName), 'SPAN')
    if (width < 768) assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    db.prepare('DELETE FROM Inquiry WHERE id IN (?,?)').run(id, sibling)
  }
  console.log('Representative UI passed: 1440/390/320px, explicit confirmation, admin/origin guards, queue polling, linked sibling status and no duplicate register button')
}
