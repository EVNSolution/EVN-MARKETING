import assert from 'node:assert/strict'
import path from 'node:path'

// Called by the existing MVP smoke; all rows and worker state belong to its synthetic DB.
export async function checkLandingWarpUi({ page, context, db, base, output }) {
  const at = new Date().toISOString()
  const landingScope = ['evn-landing', 'evnsolution', 'pv5']
  for (const [id, name, phone] of [
    ['landing-new', '홈페이지 정상 합성', '010-9898-0001'],
    ['landing-duplicate', '홈페이지 중복 합성', '010-9898-0002'],
  ]) {
    db.prepare('INSERT INTO Inquiry(id,source,companyScopeId,homepageScopeId,sourceId,inquiryDate,inquiryTime,sourceStatus,name,phone,lastSeenAt) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, ...landingScope, `00000000-0000-4000-8000-${id === 'landing-new' ? '000000009001' : '000000009002'}`, '2026-10-08', '09:01:23', '상담 대기', name, phone, at)
    db.prepare('INSERT INTO LandingReceipt(id,inquiryId,fingerprint,kind,region,consentVersion,consentedAt) VALUES(?,?,?,?,?,?,?)')
      .run(id, id, 'synthetic-fingerprint', 'subsidy', '경기', '2026-10-07-v1', at)
  }
  db.prepare('INSERT INTO Inquiry(id,source,companyScopeId,homepageScopeId,sourceId,inquiryDate,inquiryTime,name,phone,lastSeenAt) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run('collected-duplicate', 'mleverage-admin', '55f9a8bb-73f9-4316-bcd7-7dcdce0bdcc3', '5c7a6115-a0a9-4e8d-bf65-efce52195fa4', '00000000-0000-4000-8000-000000009003', '2026-10-08', '09:01', '수집 중복 합성', '+82 10 9898 0002', at)
  db.prepare('INSERT INTO Inquiry(id,source,companyScopeId,homepageScopeId,sourceId,inquiryDate,inquiryTime,name,phone,lastSeenAt) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run('collected-new', 'mleverage-admin', '55f9a8bb-73f9-4316-bcd7-7dcdce0bdcc3', '5c7a6115-a0a9-4e8d-bf65-efce52195fa4', '00000000-0000-4000-8000-000000009004', '2026-10-08', '09:01', '수집 정상 합성', '01098980004', at)
  db.prepare("UPDATE InquirySyncState SET status='ready',workerOwner='synthetic-ui-worker',workerHeartbeatAt=?,workerLeaseExpiresAt=?")
    .run(at, new Date(Date.now() + 300_000).toISOString())
  for (const width of [1440, 390, 320]) {
    db.prepare("UPDATE Inquiry SET warpError=NULL WHERE id IN ('landing-new','landing-duplicate')").run()
    await page.setViewportSize({ width, height: 1000 })
    await page.goto(base + '/inquiries?source=landing')
    const row = page.locator(width >= 768 ? 'tbody tr' : 'article').filter({ hasText: '홈페이지 정상 합성' })
    const duplicate = page.locator(width >= 768 ? 'tbody tr' : 'article').filter({ hasText: '홈페이지 중복 합성' })
    await row.getByRole('button', { name: '등록하기', exact: true }).waitFor()
    assert.match(await row.innerText(), /보조금 상담 · 경기/)
    assert.match(await row.innerText(), /개인정보 동의.*2026-10-07-v1/)
    assert.equal(await duplicate.getByRole('button', { name: '등록하기' }).count(), 0)
    if (width < 768) assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    if (output) {
      await row.scrollIntoViewIfNeeded()
      await page.screenshot({ path: path.join(output, `landing-crm-${width}.png`), fullPage: true })
    }
    const queued = page.waitForResponse(response => response.url().endsWith('/landing-new/warp-registration') && response.request().method() === 'POST')
    await row.getByRole('button', { name: '등록하기', exact: true }).click()
    assert.equal((await queued).status(), 202)
    await row.getByRole('button', { name: '등록중', exact: true }).waitFor()
    assert.equal(await row.getByRole('button', { name: '등록중', exact: true }).isDisabled(), true)
    assert.equal(db.prepare("SELECT warpError FROM Inquiry WHERE id='landing-new'").get().warpError, 'warp_manual_requested')
    await duplicate.getByRole('button', { name: '검토하기', exact: true }).click()
    const review = page.getByRole('dialog', { name: '중복 문의 검토' })
    await review.getByText('수집 중복 합성', { exact: true }).waitFor()
    assert.match(await review.innerText(), /기존 수집 문의/)
    assert.equal(await review.evaluate(el => el.scrollWidth <= el.clientWidth), true)
    if (output) await page.screenshot({ path: path.join(output, `landing-crm-review-${width}.png`) })
    await review.getByRole('checkbox').check()
    await review.getByRole('button', { name: '검토완료 · 전송 보류', exact: true }).click()
    await review.getByText('중복으로 검토 완료했습니다. 이 문의는 전송하지 않습니다.', { exact: true }).waitFor()
    await review.getByRole('button', { name: '검토창 닫기' }).click()
    const reviewed = await (await context.request.get(base + '/api/inquiries?source=landing&review=reviewed')).json()
    assert.deepEqual(reviewed.rows.map(row => row.id), ['landing-duplicate'])
    assert.equal(reviewed.warp.reviewed, 1)
    for (const [source, id, name] of [['landing', 'landing-new', '홈페이지 정상 합성'], ['collected', 'collected-new', '수집 정상 합성']]) {
      for (const [state, deliveredAt, label] of [
        ['warp_customer_lead_complete', at, '고객·리드 등록완료'],
        ['warp_customer_only', null, '고객 등록 확인 · 리드 미완료'],
        ['warp_lead_mapping_unavailable', null, '담당자 또는 활성 모델을 확인하지 못해'],
      ]) {
        db.prepare('UPDATE Inquiry SET warpError=?,warpDeliveredAt=? WHERE id=?').run(state, deliveredAt, id)
        await page.goto(base + '/inquiries?source=' + source)
        const target = page.locator(width >= 768 ? 'tbody tr' : 'article').filter({ hasText: name })
        await target.getByText(label, { exact: state !== 'warp_lead_mapping_unavailable' }).waitFor()
        assert.equal(await target.getByRole('button', { name: '등록하기', exact: true }).count(), state === 'warp_lead_mapping_unavailable' ? 1 : 0)
        if (width < 768) assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
        if (output) {
          await target.scrollIntoViewIfNeeded()
          await page.screenshot({ path: path.join(output, `customer-lead-${width}-${source}-${state}.png`) })
        }
      }
      db.prepare('UPDATE Inquiry SET warpError=NULL,warpDeliveredAt=NULL WHERE id=?').run(id)
    }
  }
  db.prepare("UPDATE Inquiry SET warpError='warp_landing_sending' WHERE id='landing-new'").run()
  await page.goto(base + '/inquiries?source=landing')
  const row = page.locator('article').filter({ hasText: '홈페이지 정상 합성' })
  await row.getByRole('button', { name: '등록중', exact: true }).waitFor()
  assert.equal(await row.getByRole('button', { name: '상담 종료·개인정보 삭제' }).isDisabled(), true)
  assert.equal((await context.request.post(base + '/api/inquiries/landing-new/close-landing', { headers: { Origin: base } })).status(), 409)
  db.prepare("UPDATE Inquiry SET warpError=NULL,warpDeliveredAt=? WHERE id='landing-new'").run(at)
  await page.goto(base + '/inquiries?source=landing')
  await row.getByText('등록완료', { exact: true }).waitFor()
  await row.getByRole('button', { name: '상담 종료·개인정보 삭제' }).click()
  const closing = page.getByRole('dialog', { name: '상담을 종료하고 개인정보를 삭제할까요?' })
  assert.match(await closing.innerText(), /WARP에 이미 전달된 고객과 상담 이력은 삭제되지 않으며/)
  await closing.getByRole('button', { name: '상담 종료 및 삭제', exact: true }).click()
  await closing.waitFor({ state: 'hidden' })
  assert.equal(db.prepare("SELECT count(*) AS n FROM Inquiry WHERE id='landing-new'").get().n, 0)
  assert.equal(db.prepare("SELECT consentedAt FROM LandingReceipt WHERE id='landing-new'").get().consentedAt, null)
  console.log('Landing CRM UI passed: desktop/mobile, manual queue, cross-source review/filter, metadata and close/send guard')
}
