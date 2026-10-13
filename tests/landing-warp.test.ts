import assert from 'node:assert/strict'
import { completedLead } from './customer-lead-helper'
import { randomUUID } from 'node:crypto'
import { withWorkerDatabase } from './worker-runtime-helper'
import { claimWorker, INQUIRY_SCOPE_ID, WORKER_LEASE_MS } from '@/lib/inquiry-sync'
import { closeLandingInquiry, LANDING_WARP_SENDING, landingScope, saveLandingInquiry } from '@/lib/landing-inquiries'
import { dispatchPendingWarp, duplicateInquiryIds, lookupWarpPhones, pilotPendingWarp, requestWarpRegistration,
  REVIEW_CLEARED, scope, warpActivityId, warpDeliveryState, warpDeliverySummary, CUSTOMER_ONLY } from '@/lib/warp-delivery'
import { inquiryReview, reviewInquiry } from '@/lib/inquiry-review'

const at = new Date('2026-10-08T00:01:23.000Z')
const secret = 'synthetic-landing-test-secret-never-production'
const env = { WARP_MARKETING_API_KEY: secret, WARP_DELIVERY_ENABLED: 'false' }
const owner = 'synthetic-landing-worker'
type Db = Parameters<Parameters<typeof withWorkerDatabase>[0]>[0]
const database = (run: Parameters<typeof withWorkerDatabase>[0]) => withWorkerDatabase(run, ['20261007000100_landing_inquiries'])
async function worker(db: Db) {
  assert.equal(await claimWorker(db, owner, at), true)
  await db.inquirySyncState.update({ where: { id: INQUIRY_SCOPE_ID }, data: { status: 'ready' } })
}
async function landing(db: Db, phone = '01000000001', submissionId = randomUUID()) {
  assert.equal((await saveLandingInquiry(db, { submissionId, phone, name: '합성 홈페이지', kind: 'subsidy', region: '경기' }, secret, at)).status, 'saved')
  return db.inquiry.findFirstOrThrow({ where: { ...landingScope, sourceId: submissionId } })
}
function provider(options: { exists?: boolean; lost?: boolean; invalidScope?: boolean; status?: number; receipt?: boolean; onLookup?: () => Promise<void>; onWrite?: () => Promise<void> } = {}) {
  let writes = 0, checks = 0
  const send: typeof fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body))
    assert.equal(body.source, 'evn-landing')
    assert.equal(body.companyScopeId, 'evnsolution'); assert.equal(body.homepageScopeId, 'pv5')
    if (String(url).endsWith('/check')) {
      checks++
      if (options.onLookup) await options.onLookup()
      if (options.status) return Response.json({ error: 'bad_payload' }, { status: options.status })
      return Response.json({ ok: true, results: body.items.map((item: { sourceId: string }) => ({ sourceId: item.sourceId, exists: Boolean(options.exists || options.receipt),
        ...(options.receipt ? { receipt: { ok: true, customerId: 'synthetic-customer', activityId: warpActivityId(item.sourceId, landingScope), created: false, duplicate: true } } : {}) })) })
    }
    writes++
    assert.equal(body.rejectExistingCustomer, true)
    assert.equal(body.inquiryTime, '09:01:23')
    assert.deepEqual(body.landing, { kind: 'subsidy', region: '경기', consentVersion: '2026-10-07-v1', consentedAt: at.toISOString() })
    if (options.onWrite) await options.onWrite()
    if (options.lost) throw new Error('synthetic response loss')
    return Response.json({ ok: true, customerId: 'synthetic-customer', activityId: warpActivityId(body.sourceId, options.invalidScope ? scope : landingScope), created: true, duplicate: false,
      ...completedLead(body, warpActivityId(body.sourceId, landingScope)) })
  }
  return { send, writes: () => writes, checks: () => checks }
}

async function main() {
  await database(async db => {
    await worker(db)
    const row = await landing(db)
    const remote = provider()
    await dispatchPendingWarp(db, owner, remote.send, { ...env, WARP_DELIVERY_ENABLED: 'true' }, () => at)
    assert.equal(await pilotPendingWarp(db, owner, remote.send, env, () => at), 'warp_no_pending_inquiry')
    assert.equal(remote.checks(), 0); assert.equal(remote.writes(), 0, 'automatic enable and pilot cannot send a landing backlog')
    assert.equal(await requestWarpRegistration(db, row.id, at), 'queued')
    assert.equal(await requestWarpRegistration(db, row.id, at), 'queued')
    assert.equal((await dispatchPendingWarp(db, owner, remote.send, env, () => at)).delivered, 1)
    assert.equal(await requestWarpRegistration(db, row.id, at), 'delivered')
    await dispatchPendingWarp(db, owner, remote.send, env, () => at)
    assert.equal(remote.writes(), 1)
    assert.equal((await warpDeliverySummary(db, env)).delivered, 1)
    assert.equal(warpDeliveryState(await db.inquiry.findUniqueOrThrow({ where: { id: row.id } })).status, 'delivered')
    assert.equal(await closeLandingInquiry(db, row.id, secret), true)
    const receipt = await db.landingReceipt.findUniqueOrThrow({ where: { id: row.sourceId } })
    assert.equal(receipt.inquiryId, null); assert.equal(receipt.consentedAt, null); assert.equal(receipt.region, null)
    assert.equal((await saveLandingInquiry(db, { submissionId: row.sourceId, name: '합성', phone: row.phone, kind: 'consultation', region: null }, secret, at)).status, 'closed')
  })

  await database(async db => {
    await worker(db)
    const row = await landing(db)
    const collected = await db.inquiry.create({ data: { ...scope, sourceId: randomUUID(), name: '합성 수집', phone: '+82 10-0000-0001', inquiryDate: '2026-10-08', inquiryTime: '09:01', lastSeenAt: at } })
    assert.deepEqual(new Set(await duplicateInquiryIds(db)), new Set([row.id, collected.id]))
    for (const id of [row.id, collected.id]) assert.equal(await requestWarpRegistration(db, id, at), 'duplicate')
    assert.equal((await warpDeliverySummary(db, env)).reviewPending, 2)
    assert.equal((await warpDeliverySummary(db, env, landingScope)).reviewPending, 1)
    const review = await inquiryReview(db, row.id); assert.ok(review)
    assert.equal(review.peers[0].source, scope.source)
    assert.equal(await reviewInquiry(db, row.id, 'hold', review.reviewToken, at), 'reviewed')
    assert.equal((await warpDeliverySummary(db, env)).reviewed, 1)
    await db.inquiry.delete({ where: { id: collected.id } })
    const held = await inquiryReview(db, row.id); assert.ok(held)
    assert.equal(await reviewInquiry(db, row.id, 'recheck', held.reviewToken, at), 'queued')
    const remote = provider()
    await dispatchPendingWarp(db, owner, remote.send, { ...env, WARP_DELIVERY_ENABLED: 'true' }, () => at)
    assert.equal((await db.inquiry.findUniqueOrThrow({ where: { id: row.id } })).warpError, REVIEW_CLEARED)
    assert.equal(remote.writes(), 0, 'cleared landing review still requires explicit registration')
    assert.equal(await requestWarpRegistration(db, row.id, at), 'queued')
    assert.equal((await dispatchPendingWarp(db, owner, remote.send, env, () => at)).delivered, 1)
  })

  for (const options of [{ exists: true }, { status: 400 }, { status: 503 }, { lost: true }, { invalidScope: true }, { receipt: true }]) await database(async db => {
    await worker(db); const row = await landing(db); const remote = provider(options)
    await requestWarpRegistration(db, row.id, at)
    await dispatchPendingWarp(db, owner, remote.send, env, () => at)
    const stored = await db.inquiry.findUniqueOrThrow({ where: { id: row.id } })
    assert.notEqual(warpDeliveryState(stored).status, 'delivered')
    assert.equal((await warpDeliverySummary(db, env)).delivered, 0)
    if (options.receipt) { assert.equal(stored.warpError, CUSTOMER_ONLY); assert.equal(stored.warpDeliveredAt, null) }
    const attempted = remote.writes()
    const retryAt = new Date(at.getTime() + 3_600_001)
    await db.inquirySyncState.update({ where: { id: INQUIRY_SCOPE_ID }, data: { workerHeartbeatAt: retryAt, workerLeaseExpiresAt: new Date(retryAt.getTime() + WORKER_LEASE_MS) } })
    await dispatchPendingWarp(db, owner, remote.send, { ...env, WARP_DELIVERY_ENABLED: 'true' }, () => retryAt)
    assert.equal(remote.writes(), attempted, 'failed landing sends never retry automatically')
    if (options.lost) {
      assert.equal(await requestWarpRegistration(db, row.id, retryAt), 'queued')
      const recovery = provider({ receipt: true })
      await dispatchPendingWarp(db, owner, recovery.send, env, () => retryAt)
      assert.equal(recovery.writes(), 0)
      assert.equal((await db.inquiry.findUniqueOrThrow({ where: { id: row.id } })).warpError, CUSTOMER_ONLY)
    }
  })

  await database(async (db, inspect) => {
    await worker(db); const row = await landing(db)
    await requestWarpRegistration(db, row.id, at)
    const remote = provider({ onWrite: async () => {
      assert.equal(await closeLandingInquiry(inspect, row.id, secret), 'sending')
      assert.equal(await requestWarpRegistration(inspect, row.id, at), 'queued')
      assert.equal((await inspect.inquiry.findUniqueOrThrow({ where: { id: row.id } })).warpError, LANDING_WARP_SENDING)
    } })
    await dispatchPendingWarp(db, owner, remote.send, env, () => at)
    assert.equal(remote.writes(), 1)
    assert.equal(await closeLandingInquiry(inspect, row.id, secret), true)
    const cancelled = await landing(db, '01000000002')
    await requestWarpRegistration(db, cancelled.id, at)
    assert.equal(await closeLandingInquiry(inspect, cancelled.id, secret), true)
    await dispatchPendingWarp(db, owner, remote.send, env, () => at)
    assert.equal(remote.writes(), 1, 'closing a queued inquiry cancels it before send')
  })

  await database(async (db, inspect) => {
    await worker(db); const row = await landing(db)
    await requestWarpRegistration(db, row.id, at)
    const remote = provider({ onLookup: async () => { await landing(inspect, row.phone) } })
    await dispatchPendingWarp(db, owner, remote.send, env, () => at)
    assert.equal(remote.writes(), 0, 'a duplicate arriving during lookup blocks the write')
    assert.equal(warpDeliveryState(await db.inquiry.findUniqueOrThrow({ where: { id: row.id } })).status, 'duplicate')
  })

  await database(async db => {
    await worker(db); const row = await landing(db)
    await db.inquiry.update({ where: { id: row.id }, data: { warpError: LANDING_WARP_SENDING, warpAttemptedAt: new Date(at.getTime() - WORKER_LEASE_MS - 1) } })
    const remote = provider()
    await dispatchPendingWarp(db, owner, remote.send, { ...env, WARP_DELIVERY_ENABLED: 'true' }, () => at)
    assert.equal((await db.inquiry.findUniqueOrThrow({ where: { id: row.id } })).warpError, 'warp_landing_interrupted')
    assert.equal(remote.writes(), 0)
    assert.equal(await requestWarpRegistration(db, row.id, at), 'queued')
    assert.equal((await dispatchPendingWarp(db, owner, remote.send, env, () => at)).delivered, 1)
  })

  await database(async db => {
    await worker(db); const row = await landing(db)
    const collected = await db.inquiry.create({ data: { ...scope, sourceId: randomUUID(), phone: '01000000003', inquiryDate: '2026-10-08', inquiryTime: '09:01', lastSeenAt: at } })
    await db.inquirySyncState.update({ where: { id: INQUIRY_SCOPE_ID }, data: { status: 'login_required' } })
    assert.equal(await requestWarpRegistration(db, collected.id, at), 'worker_offline', 'legacy source policy remains unchanged')
    assert.equal(await requestWarpRegistration(db, row.id, at), 'queued', 'landing registration does not depend on source login')
    const remote = provider()
    assert.equal((await dispatchPendingWarp(db, owner, remote.send, env, () => at)).delivered, 1)
    const duplicate = await landing(db, '01000000004')
    await db.inquiry.update({ where: { id: duplicate.id }, data: { warpError: 'warp_phone_duplicate' } })
    const review = await inquiryReview(db, duplicate.id); assert.ok(review)
    assert.equal(await reviewInquiry(db, duplicate.id, 'recheck', review.reviewToken, at), 'queued')
    await dispatchPendingWarp(db, owner, remote.send, env, () => at)
    assert.equal((await db.inquiry.findUniqueOrThrow({ where: { id: duplicate.id } })).warpError, REVIEW_CLEARED)
    await db.inquirySyncState.update({ where: { id: INQUIRY_SCOPE_ID }, data: { workerLeaseExpiresAt: new Date(at.getTime() - 1) } })
    assert.equal(await requestWarpRegistration(db, duplicate.id, at), 'worker_offline', 'a live lease remains mandatory')
    await db.inquiry.update({ where: { id: duplicate.id }, data: { warpError: 'warp_phone_duplicate' } })
    const stale = await inquiryReview(db, duplicate.id); assert.ok(stale)
    assert.equal(await reviewInquiry(db, duplicate.id, 'recheck', stale.reviewToken, at), 'worker_offline')
  })

  const sameId = randomUUID()
  const rows = [{ ...scope, sourceId: sameId, phone: '01000000001' }, { ...landingScope, sourceId: sameId, phone: '01000000002' }]
  const lookup: typeof fetch = async (_url, init) => {
    const input = JSON.parse(String(init?.body))
    return Response.json({ ok: true, results: [{ sourceId: sameId, exists: true,
      receipt: { ok: true, customerId: 'synthetic-customer', activityId: warpActivityId(sameId, input), created: false, duplicate: true } }] })
  }
  const matches = await lookupWarpPhones(rows, lookup, env)
  assert.equal(matches?.length, 2)
  assert.notEqual(matches?.[0].receipt?.activityId, matches?.[1].receipt?.activityId)
  console.log('landing WARP checks passed: manual-only, scoped receipts, cross-source duplicates, review, failures, response loss, close/send races and interruption')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
