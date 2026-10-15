import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { claimWorker, INQUIRY_SCOPE_ID, WORKER_LEASE_MS } from '@/lib/inquiry-sync'
import { inquiryReview, reviewInquiry } from '@/lib/inquiry-review'
import { landingScope } from '@/lib/landing-inquiries'
import { DUPLICATE_OF, DUPLICATE_REVIEWED, MANUAL_CONFIRMATION, CUSTOMER_LEAD_COMPLETE, dispatchPendingWarp,
  duplicateInquiryIds, inquiryDuplicateContext, requestWarpRegistration, scope, warpActivityId, warpDeliverySummary } from '@/lib/warp-delivery'
import { completedLead } from './customer-lead-helper'
import { withWorkerDatabase } from './worker-runtime-helper'

const at = new Date('2026-10-15T00:00:00.000Z')
const env = { WARP_MARKETING_API_KEY: 'synthetic-representative-test-key-only', WARP_DELIVERY_ENABLED: 'false' }
const owner = 'synthetic-representative-worker'
type Db = Parameters<Parameters<typeof withWorkerDatabase>[0]>[0]
const database = (run: Parameters<typeof withWorkerDatabase>[0]) => withWorkerDatabase(run, ['20261007000100_landing_inquiries'])
async function add(db: Db, source = scope, phone = '01011112222') {
  return db.inquiry.create({ data: { ...source, sourceId: randomUUID(), name: '합성 고객', phone,
    inquiryDate: '2026-10-15', inquiryTime: '09:00', firstSeenAt: at, lastSeenAt: at } })
}
async function worker(db: Db) {
  await claimWorker(db, owner, at)
  await db.inquirySyncState.update({ where: { id: INQUIRY_SCOPE_ID }, data: { status: 'ready' } })
}
async function select(db: Db, id: string) {
  const review = await inquiryReview(db, id)
  assert.ok(review?.canRegisterRepresentative)
  return reviewInquiry(db, id, 'register-representative', review.reviewToken, at)
}

async function main() {
  for (const source of [scope, landingScope]) await database(async db => {
    await worker(db)
    const representative = await add(db, source)
    const sibling = await add(db, source === scope ? landingScope : scope, '+82 10-1111-2222')
    await db.inquiry.update({ where: { id: sibling.id }, data: { warpError: DUPLICATE_REVIEWED } })
    const stale = await inquiryReview(db, sibling.id); assert.ok(stale)
    assert.equal(await select(db, representative.id), 'queued')
    assert.equal(await reviewInquiry(db, sibling.id, 'register-representative', stale.reviewToken, at), 'stale')
    assert.equal((await inquiryReview(db, sibling.id))?.canRegisterRepresentative, false)
    assert.equal(await requestWarpRegistration(db, sibling.id, at), 'duplicate')
    assert.deepEqual([...await duplicateInquiryIds(db)], [sibling.id])
    let writes = 0, checks = 0
    const send: typeof fetch = async (url, init) => {
      const input = JSON.parse(String(init?.body))
      if (String(url).endsWith('/check')) {
        checks++
        return Response.json({ ok: true, results: input.items.map((item: { sourceId: string }) => ({ sourceId: item.sourceId, exists: false })) })
      }
      writes++
      assert.equal(input.sourceId, representative.sourceId)
      assert.equal(input.rejectExistingCustomer, true)
      const activityId = warpActivityId(input.sourceId, source)
      return Response.json({ ok: true, customerId: 'synthetic-customer', activityId, created: true, duplicate: false, ...completedLead(input, activityId) })
    }
    assert.equal((await dispatchPendingWarp(db, owner, send, env, () => at)).delivered, 1)
    await dispatchPendingWarp(db, owner, send, { ...env, WARP_DELIVERY_ENABLED: 'true' }, () => at)
    assert.equal(checks, 1); assert.equal(writes, 1)
    const saved = await db.inquiry.findUniqueOrThrow({ where: { id: representative.id } })
    assert.equal(saved.warpError, CUSTOMER_LEAD_COMPLETE)
    const linked = await inquiryReview(db, sibling.id); assert.ok(linked)
    assert.equal(linked.state.status, 'duplicate_linked')
    assert.equal(linked.representative?.id, representative.id)
    assert.equal(linked.canConfirm, false); assert.equal(linked.canRecheck, false)
    assert.equal((await warpDeliverySummary(db, env)).delivered, 1)
    assert.equal((await warpDeliverySummary(db, env)).reviewed, 1)
    const retained = await db.inquiry.findUniqueOrThrow({ where: { id: sibling.id } })
    assert.deepEqual(retained, { ...sibling, warpError: `${DUPLICATE_OF}${representative.id}` })
    assert.equal(await db.inquiry.count(), 2)
  })

  for (const mode of ['existing', 'unavailable', 'new-peer', 'remote-race', 'lost-response'] as const) await database(async db => {
    await worker(db)
    const row = await add(db), peer = await add(db)
    assert.equal(await select(db, row.id), 'queued')
    let writes = 0, recover = false
    const activityId = warpActivityId(row.sourceId)
    const send: typeof fetch = async (url, init) => {
      const input = JSON.parse(String(init?.body))
      if (String(url).endsWith('/check')) {
        if (mode === 'unavailable') return Response.json({}, { status: 503 })
        if (mode === 'new-peer') await add(db)
        return Response.json({ ok: true, results: input.items.map((item: { sourceId: string }) => ({ sourceId: item.sourceId,
          exists: mode === 'existing' || recover,
          ...(recover ? { receipt: { ok: true, customerId: 'synthetic-customer', activityId, created: false, duplicate: true, ...completedLead(input, activityId) } } : {}) })) })
      }
      writes++
      if (mode === 'remote-race') return Response.json({ error: 'phone_exists' }, { status: 409 })
      if (mode === 'lost-response') throw Error('synthetic lost response')
      throw Error('unexpected customer write')
    }
    await dispatchPendingWarp(db, owner, send, env, () => at)
    assert.equal(writes, ['remote-race', 'lost-response'].includes(mode) ? 1 : 0)
    assert.equal((await db.inquiry.findUniqueOrThrow({ where: { id: row.id } })).warpDeliveredAt, null)
    assert.notEqual((await inquiryReview(db, peer.id))?.state.status, 'duplicate_linked')
    assert.equal((await inquiryReview(db, peer.id))?.canRegisterRepresentative, false)
    if (mode === 'new-peer') assert.equal((await inquiryReview(db, row.id))?.canRegisterRepresentative, true, 'new peers require explicit refreshed representative review')
    if (mode === 'lost-response') {
      recover = true
      assert.equal(await requestWarpRegistration(db, row.id, at), 'connection_backoff')
      const retryAt = new Date(at.getTime() + 3_600_001)
      await db.inquirySyncState.update({ where: { id: INQUIRY_SCOPE_ID }, data: { workerHeartbeatAt: retryAt, workerLeaseExpiresAt: new Date(retryAt.getTime() + WORKER_LEASE_MS) } })
      assert.equal(await requestWarpRegistration(db, row.id, retryAt), 'queued')
      await dispatchPendingWarp(db, owner, send, env, () => retryAt)
      assert.equal(writes, 1, 'a lost receipt is recovered without a second customer/lead write')
      assert.equal((await inquiryReview(db, peer.id))?.state.status, 'duplicate_linked')
    }
  })

  for (const evidence of [{ warpError: MANUAL_CONFIRMATION }, { warpCustomerId: 'retained-customer' },
    { warpActivityId: 'retained-activity' }, { warpDeliveredAt: at }, { warpError: 'warp_phone_duplicate' }]) await database(async db => {
    await worker(db)
    const row = await add(db), peer = await add(db)
    await db.inquiry.update({ where: { id: peer.id }, data: evidence })
    const review = await inquiryReview(db, row.id); assert.ok(review)
    assert.equal(review.canRegisterRepresentative, false)
    assert.equal(await reviewInquiry(db, row.id, 'register-representative', review.reviewToken, at), 'not_duplicate')
  })

  await database(async db => {
    const row = await add(db); await add(db)
    assert.equal(await select(db, row.id), 'worker_offline')
    await worker(db)
    const previous = await inquiryReview(db, row.id); assert.ok(previous)
    await add(db)
    assert.equal(await reviewInquiry(db, row.id, 'register-representative', previous.reviewToken, at), 'stale')
    assert.equal(await select(db, row.id), 'queued')
    await db.inquiry.delete({ where: { id: row.id } })
    const context = await inquiryDuplicateContext(db)
    assert.equal(context.duplicates.size, 2, 'orphan peers remain blocked')
    let calls = 0
    await dispatchPendingWarp(db, owner, async () => { calls++; throw Error('unexpected call') }, { ...env, WARP_DELIVERY_ENABLED: 'true' }, () => at)
    assert.equal(calls, 0)
  })
  for (const changeRepresentative of [true, false]) await database(async db => {
    await worker(db)
    const row = await add(db), peer = await add(db)
    assert.equal(await select(db, row.id), 'queued')
    await db.inquiry.update({ where: { id: changeRepresentative ? row.id : peer.id }, data: { phone: '01022223333' } })
    assert.ok((await duplicateInquiryIds(db)).has(row.id), 'a changed phone cannot carry the previous representative authorization')
    let calls = 0
    await dispatchPendingWarp(db, owner, async () => { calls++; throw Error('unexpected call') }, env, () => at)
    assert.equal(calls, 0)
  })
  console.log('Representative inquiry passed: both sources, normalized phone, held peers, single receipt, stale selection, WARP duplicate/failure/race, lost response, preserved history and orphan blocking')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
