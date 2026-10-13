import assert from 'node:assert/strict'
import { completedLead } from './customer-lead-helper'
import { claimWorker, INQUIRY_SCOPE_ID } from '@/lib/inquiry-sync'
import { inquiryReview, reviewInquiry } from '@/lib/inquiry-review'
import { planWarpRecovery } from '@/lib/warp-recovery'
import { normalizeInquiryPhone } from '@/lib/format'
import { checkedDeliver, dispatchPendingWarp, DUPLICATE_RECHECK, DUPLICATE_RECHECK_FAILED, DUPLICATE_REVIEWED, MANUAL_CONFIRMATION, REVIEW_CLEARED,
  requestWarpRegistration, scope, WARP_EXISTING_CUSTOMER, CUSTOMER_ONLY, warpActivityId, warpDeliveryState, warpDeliverySummary } from '@/lib/warp-delivery'
import { withWorkerDatabase } from './worker-runtime-helper'

const env = { WARP_MARKETING_API_KEY: 'synthetic-review-key-never-used-in-production', WARP_DELIVERY_ENABLED: 'true' }
const owner = 'synthetic-review-worker'
const at = new Date('2026-10-06T01:00:00Z')
const sourceId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const base = { ...scope, inquiryDate: '2026-10-06', inquiryTime: '10:00', name: '합성 문의', sourceStatus: null, lastSeenAt: at }
const payload = { ...scope, inquiryDate: base.inquiryDate, inquiryTime: base.inquiryTime, sourceId: sourceId(50), phone: '010-1111-0050', name: base.name, sourceStatus: '' }

async function worker(db: Parameters<typeof claimWorker>[0]) {
  await claimWorker(db, owner, at)
  await db.inquirySyncState.update({ where: { id: INQUIRY_SCOPE_ID }, data: { status: 'ready' } })
}

async function main() {
  for (const phone of ['010-1234-5678', '+82 10 1234 5678', '0082-10-1234-5678', '+82 (0)10-1234-5678']) assert.equal(normalizeInquiryPhone(phone), '01012345678')
  assert.equal(normalizeInquiryPhone('+82 11 555 9999'), '0115559999')
  assert.equal(normalizeInquiryPhone('1012345678'), '1012345678', 'legacy numeric fallback matches WARP without inventing a leading zero')
  assert.equal(normalizeInquiryPhone('115559999'), '115559999')
  assert.equal(normalizeInquiryPhone('02-3443-6235'), '0234436235', 'existing fixed-line inquiries remain supported')

  await withWorkerDatabase(async db => {
    await worker(db)
    const invalid = await db.inquiry.create({ data: { ...base, sourceId: sourceId(80), phone: '번호 없음' } })
    await db.inquiry.create({ data: { ...base, sourceId: sourceId(81), phone: '010-1111-0081' } })
    let writes = 0
    const provider: typeof fetch = async (url, init) => {
      const input = JSON.parse(String(init?.body))
      if (String(url).endsWith('/check')) return Response.json({ ok: true, results: input.items.map((item: { sourceId: string }) => ({ sourceId: item.sourceId, exists: false })) })
      writes++
      return Response.json({ ok: true, customerId: 'synthetic-valid-customer', activityId: warpActivityId(input.sourceId), created: true, duplicate: false, ...completedLead(input, warpActivityId(input.sourceId)) })
    }
    assert.equal((await dispatchPendingWarp(db, owner, provider, env, () => at)).delivered, 1)
    assert.equal(writes, 1)
    assert.equal((await db.inquiry.findUniqueOrThrow({ where: { id: invalid.id } })).warpError, 'warp_invalid_inquiry', 'one invalid contact does not pause other valid registrations')
  })

  await withWorkerDatabase(async db => {
    await worker(db)
    const row = await db.inquiry.create({ data: { ...base, sourceId: sourceId(1), phone: '010-1111-0001' } })
    let writes = 0, lookups = 0
    const duplicate: typeof fetch = async (url, init) => {
      if (String(url).endsWith('/check')) {
        lookups++
        const input = JSON.parse(String(init?.body))
        assert.deepEqual(Object.keys(input).sort(), ['source', 'companyScopeId', 'homepageScopeId', 'items', ...(input.registrationPolicy ? ['registrationPolicy'] : [])].sort())
        assert.equal(new Headers(init?.headers).get('x-api-key'), env.WARP_MARKETING_API_KEY)
        return Response.json({ ok: true, results: input.items.map((item: { sourceId: string }) => ({ sourceId: item.sourceId, exists: true })) })
      }
      writes++
      throw new Error('a duplicate must never reach the registration endpoint')
    }
    await dispatchPendingWarp(db, owner, duplicate, env, () => at)
    const held = await db.inquiry.findUniqueOrThrow({ where: { id: row.id } })
    assert.equal(held.warpError, 'warp_phone_duplicate')
    assert.equal(held.warpDeliveredAt, null)
    assert.equal(warpDeliveryState(held).label, '중복확인')
    assert.equal(await requestWarpRegistration(db, row.id, at), 'duplicate')
    await dispatchPendingWarp(db, owner, duplicate, env, () => at)
    assert.equal(writes, 0); assert.equal(lookups, 1, 'held duplicates are not retried automatically')
    const review = await inquiryReview(db, row.id)
    assert.ok(review)
    assert.equal(await reviewInquiry(db, row.id, 'hold', review.reviewToken, at), 'reviewed')
    const reviewed = await db.inquiry.findUniqueOrThrow({ where: { id: row.id } })
    assert.equal(reviewed.warpError, DUPLICATE_REVIEWED)
    assert.equal(reviewed.warpAttemptedAt?.getTime(), held.warpAttemptedAt?.getTime())
    assert.equal(reviewed.warpDeliveredAt, null)
    assert.equal(warpDeliveryState(reviewed).status, 'duplicate_reviewed')
    assert.equal((await warpDeliverySummary(db, env)).reviewed, 1)
    await assert.rejects(planWarpRecovery(db, [row.sourceId]), /warp_recovery_duplicate_review/)
    await dispatchPendingWarp(db, owner, duplicate, env, () => at)
    assert.equal(writes, 0)

    const current = await inquiryReview(db, row.id); assert.ok(current)
    assert.equal(await reviewInquiry(db, row.id, 'recheck', current.reviewToken, at), 'queued')
    assert.equal(await reviewInquiry(db, row.id, 'hold', current.reviewToken, at), 'stale', 'old preview cannot overwrite a queued review')
    const clear: typeof fetch = async (url, init) => {
      const input = JSON.parse(String(init?.body))
      if (String(url).endsWith('/check')) return Response.json({ ok: true, results: input.items.map((item: { sourceId: string }) => ({ sourceId: item.sourceId, exists: false })) })
      writes++
      return Response.json({ ok: true, customerId: 'new-synthetic-customer', activityId: warpActivityId(input.sourceId), created: true, duplicate: false, ...completedLead(input, warpActivityId(input.sourceId)) })
    }
    await dispatchPendingWarp(db, owner, clear, env, () => at)
    assert.equal((await db.inquiry.findUniqueOrThrow({ where: { id: row.id } })).warpError, REVIEW_CLEARED)
    await dispatchPendingWarp(db, owner, clear, env, () => at)
    assert.equal(writes, 0, 'cleared review requires a separate explicit registration even with auto delivery enabled')
    assert.equal(await requestWarpRegistration(db, row.id, at), 'queued')
    assert.equal((await dispatchPendingWarp(db, owner, clear, env, () => at)).delivered, 1)
    assert.equal(writes, 1)
  })

  await withWorkerDatabase(async db => {
    await worker(db)
    const first = await db.inquiry.create({ data: { ...base, sourceId: sourceId(2), phone: '010-2222-0002', firstSeenAt: at, warpError: MANUAL_CONFIRMATION } })
    const later = await db.inquiry.create({ data: { ...base, sourceId: sourceId(3), phone: '+82 10 2222 0002', firstSeenAt: new Date(at.getTime() + 1) } })
    await db.inquiry.create({ data: { ...base, sourceId: sourceId(4), companyScopeId: 'other-company', phone: first.phone } })
    const review = await inquiryReview(db, later.id); assert.ok(review)
    assert.equal(review.peerCount, 1)
    assert.equal(review.peers[0].id, first.id)
    assert.equal(review.state.status, 'duplicate')
    const third = await db.inquiry.create({ data: { ...base, sourceId: sourceId(30), phone: '0082 (0)10-2222-0002', firstSeenAt: new Date(at.getTime() + 2) } })
    const withThird = await inquiryReview(db, later.id); assert.ok(withThird)
    assert.equal(withThird.peerCount, 2)
    assert.equal(withThird.peers.find(peer => peer.id === third.id)?.state.status, 'duplicate')
    assert.equal(await reviewInquiry(db, later.id, 'recheck', review.reviewToken, at), 'stale', 'new same-phone inquiry invalidates the previous review')
    assert.equal(await reviewInquiry(db, later.id, 'recheck', withThird.reviewToken, at), 'queued')
    let writes = 0
    const clear: typeof fetch = async (url, init) => {
      if (!String(url).endsWith('/check')) { writes++; throw new Error('local duplicate must not be sent') }
      const p = JSON.parse(String(init?.body))
      return Response.json({ ok: true, results: p.items.map((item: { sourceId: string }) => ({ sourceId: item.sourceId, exists: false })) })
    }
    await dispatchPendingWarp(db, owner, clear, env, () => at)
    assert.equal((await db.inquiry.findUniqueOrThrow({ where: { id: later.id } })).warpError, 'warp_local_duplicate')
    assert.equal(writes, 0)
    assert.equal(await requestWarpRegistration(db, later.id, at), 'duplicate')
    const stale = await inquiryReview(db, later.id); assert.ok(stale)
    await db.inquiry.update({ where: { id: later.id }, data: { name: '수정된 합성 문의' } })
    assert.equal(await reviewInquiry(db, later.id, 'hold', stale.reviewToken, at), 'stale')
    assert.equal((await db.inquiry.findUniqueOrThrow({ where: { id: first.id } })).warpError, MANUAL_CONFIRMATION)
  })

  for (const response of [Response.json({ ok: true, results: [] }), Response.json({ error: 'unauthorized' }, { status: 401 }), Response.json({ ok: true, results: [{ sourceId: sourceId(50), exists: 'false' }] })]) {
    let calls = 0
    const result = await checkedDeliver(payload, async () => { calls++; return response }, env)
    assert.equal(result.error, 'warp_duplicate_check_unavailable'); assert.equal(calls, 1)
  }
  let registrations = 0
  const raced = await checkedDeliver(payload, async (url, init) => {
    if (String(url).endsWith('/check')) return Response.json({ ok: true, results: [{ sourceId: payload.sourceId, exists: false }] })
    registrations++
    assert.equal(JSON.parse(String(init?.body)).rejectExistingCustomer, true)
    return Response.json({ error: 'phone_exists' }, { status: 409 })
  }, env)
  assert.equal(raced.error, 'warp_phone_duplicate'); assert.equal(registrations, 1)

  await withWorkerDatabase(async db => {
    await worker(db)
    const row = await db.inquiry.create({ data: { ...base, sourceId: sourceId(5), phone: '010-1111-0005', warpError: DUPLICATE_RECHECK } })
    await dispatchPendingWarp(db, owner, async () => { throw new Error('synthetic network failure') }, { ...env, WARP_DELIVERY_ENABLED: 'false' }, () => at)
    assert.equal((await db.inquiry.findUniqueOrThrow({ where: { id: row.id } })).warpError, DUPLICATE_RECHECK_FAILED)
    const view = await inquiryReview(db, row.id); assert.ok(view)
    assert.equal(view.state.status, 'duplicate'); assert.equal(view.canRecheck, true)
    const receiptRow = await db.inquiry.create({ data: { ...base, sourceId: sourceId(6), phone: '010-1111-0006' } })
    let writes = 0
    const receipt: typeof fetch = async (url, init) => {
      if (!String(url).endsWith('/check')) { writes++; throw new Error('receipt lookup must not resend') }
      const p = JSON.parse(String(init?.body))
      return Response.json({ ok: true, results: p.items.map((item: { sourceId: string }) => ({ sourceId: item.sourceId, exists: true,
        receipt: { ok: true, customerId: 'canonical-synthetic-customer', activityId: warpActivityId(item.sourceId), created: false, duplicate: true } })) })
    }
    await dispatchPendingWarp(db, owner, receipt, env, () => at)
    assert.equal(writes, 0)
    assert.equal((await db.inquiry.findUniqueOrThrow({ where: { id: receiptRow.id } })).warpError, CUSTOMER_ONLY)
    assert.equal(warpDeliveryState(await db.inquiry.findUniqueOrThrow({ where: { id: receiptRow.id } })).label, '고객 등록 확인 · 리드 미완료')
    const historical = await db.inquiry.create({ data: { ...base, sourceId: sourceId(7), phone: '010-1111-0007', warpDeliveredAt: at,
      warpCustomerId: 'existing-synthetic-customer', warpActivityId: warpActivityId(sourceId(7)), warpError: WARP_EXISTING_CUSTOMER } })
    const history = await inquiryReview(db, historical.id); assert.ok(history)
    assert.equal(history.canRecheck, false)
    assert.equal(await reviewInquiry(db, historical.id, 'hold', history.reviewToken, at), 'reviewed')
    assert.equal((await db.inquiry.findUniqueOrThrow({ where: { id: historical.id } })).warpDeliveredAt?.getTime(), at.getTime())
  })
  console.log('duplicate review: read-only preflight, local/WARP hold, explicit review/recheck, stale protection, clear without auto-send, receipt recovery and scope passed')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
