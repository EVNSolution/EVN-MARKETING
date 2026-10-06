import { dispatchPendingWarp, pilotPendingWarp } from './warp-phone-check-helper'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createClient } from '@libsql/client'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import { PrismaClient } from '@/app/generated/prisma/client'
import { claimWorker, releaseWorker, INQUIRY_SOURCE, INQUIRY_COMPANY_ID, INQUIRY_HOMEPAGE_ID } from '@/lib/inquiry-sync'
import { checkWarpConnection, deliver, duplicateInquiryIds, requestWarpRegistration, WARP_EXISTING_CUSTOMER, WARP_RECEIPT_UNVERIFIED, warpActivityId, warpConfigured, warpDeliveryState, warpDeliverySummary } from '@/lib/warp-delivery'
import { withWorkerDatabase } from './worker-runtime-helper'

const keyOnly = { WARP_MARKETING_API_KEY: 'synthetic-test-key-never-used-in-production' }
const env = { ...keyOnly, WARP_DELIVERY_ENABLED: 'true' }
const owner = 'synthetic-delivery-worker'
const scope = { source: INQUIRY_SOURCE, companyScopeId: INQUIRY_COMPANY_ID, homepageScopeId: INQUIRY_HOMEPAGE_ID }
const sourceId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

async function main() {
  await testStopDuringHeartbeat()
  await testLocalDuplicates()
  const temp = await mkdtemp(path.join(tmpdir(), 'evn-warp-delivery-test-'))
  const url = `file:${path.join(temp, 'test.db')}`
  const sql = createClient({ url })
  for (const migration of ['20260915000100_baseline', '20260915000200_inquiry_sync', '20260915000300_warp_delivery']) {
    await sql.executeMultiple(await readFile(path.join(process.cwd(), 'prisma/migrations', migration, 'migration.sql'), 'utf8'))
  }
  sql.close()
  const db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url, timeout: 5000 }, { timestampFormat: 'iso8601' }) })
  let time = new Date('2026-09-15T00:00:00Z')
  const now = () => time
  const add = (n: number, overrides = {}) => db.inquiry.create({ data: {
    ...scope, sourceId: sourceId(n), inquiryDate: '2026-09-15', inquiryTime: '09:07',
    name: null, sourceStatus: null, phone: `010-0000-${String(n).padStart(4, '0')}`, lastSeenAt: now(), ...overrides,
  } })
  let calls = 0
  const receipts = new Set<string>()
  const send: typeof fetch = async (url, init) => {
    calls++
    assert.equal(url, 'https://warp.cleversystem.ai/api/external/marketing-inquiries')
    assert.equal(init?.redirect, 'error')
    assert.equal(new Headers(init?.headers).get('x-api-key'), env.WARP_MARKETING_API_KEY)
    const body = JSON.parse(String(init?.body))
    assert.deepEqual(Object.keys(body).sort(), ['source', 'companyScopeId', 'homepageScopeId', 'sourceId', 'inquiryDate', 'inquiryTime', 'sourceStatus', 'name', 'phone', 'rejectExistingCustomer'].sort())
    assert.equal(body.rejectExistingCustomer, true)
    assert(Object.entries(body).filter(([key]) => key !== 'rejectExistingCustomer').every(([, field]) => typeof field === 'string'), 'all nine inquiry fields are strings')
    assert.equal(body.name, `미상(📞 ${body.phone.slice(-4)})`)
    assert.equal(body.sourceStatus, '')
    assert.equal(body.companyScopeId, scope.companyScopeId)
    assert.equal(body.sourceId, body.sourceId.toLowerCase())
    const duplicate = receipts.has(body.sourceId)
    receipts.add(body.sourceId)
    return Response.json({ ok: true, customerId: 'synthetic-customer', activityId: warpActivityId(body.sourceId), created: !duplicate, duplicate })
  }
  try {
    assert.equal(warpConfigured(keyOnly), false)
    assert.equal(warpConfigured({ WARP_DELIVERY_ENABLED: 'true' }), false)
    assert.equal(warpConfigured({ ...env, WARP_MARKETING_API_KEY: ` ${env.WARP_MARKETING_API_KEY}` }), false)
    assert.deepEqual(warpDeliveryState({ warpDeliveredAt: now(), warpError: 'ignored' }), { status: 'delivered', label: '등록 완료', reason: null })
    assert.equal(warpDeliveryState({ warpDeliveredAt: now(), warpError: null }, true).status, 'delivered', 'local duplicate does not rewrite historical delivery evidence')
    assert.equal(warpDeliveryState({ warpDeliveredAt: null, warpError: 'warp_manual_confirmed' }, true).status, 'delivered', 'local duplicate does not rewrite manual confirmation')
    assert.equal(warpDeliveryState({ warpDeliveredAt: now(), warpError: WARP_EXISTING_CUSTOMER }).status, 'duplicate', 'existing-customer marker wins before delivered timestamp')
    assert.equal(warpDeliveryState({ warpDeliveredAt: now(), warpError: WARP_RECEIPT_UNVERIFIED }).label, '등록 확인 필요')
    assert.deepEqual(warpDeliveryState({ warpDeliveredAt: null, warpError: null }), { status: 'pending', label: '등록 대기', reason: null })
    assert.equal(warpDeliveryState({ warpDeliveredAt: null, warpError: 'warp_customer_conflict' }).status, 'duplicate')
    assert.equal(warpDeliveryState({ warpDeliveredAt: null, warpError: 'warp_registration_guard_unavailable' }).label, '등록 보류')
    const retryState = warpDeliveryState({ warpDeliveredAt: null, warpError: 'private upstream body' })
    assert.equal(retryState.status, 'retrying')
    assert.doesNotMatch(retryState.reason!, /private|upstream/)
    assert.equal(warpActivityId('AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'), warpActivityId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'))
    const first = await add(1, { sourceId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', inquiryTime: '09:06' })
    await add(2, { companyScopeId: 'other-company' })
    await add(3)
    assert.equal((await warpDeliverySummary(db, { WARP_DELIVERY_ENABLED: 'true' })).configured, true, 'web summary needs only nonsecret enabled intent')
    assert.equal((await warpDeliverySummary(db, { WARP_DELIVERY_ENABLED: 'false' })).configured, false)
    await claimWorker(db, owner, now())
    assert.deepEqual(await dispatchPendingWarp(db, owner, send, { WARP_DELIVERY_ENABLED: 'true' }, now), { configured: false, delivered: 0, failed: 0 })
    assert.equal(calls, 0, 'enabled intent without the worker key never sends backlog')
    assert.deepEqual(await dispatchPendingWarp(db, owner, send, keyOnly, now), { configured: false, delivered: 0, failed: 0 })
    assert.equal(calls, 0, 'key alone never sends backlog')
    const beforeCheck = await db.inquiry.count()
    assert.equal(await checkWarpConnection(async (_url, init) => {
      assert.equal(init?.body, '{}')
      return Response.json({ error: 'bad_payload' }, { status: 400 })
    }, keyOnly), 'ok')
    assert.equal(await checkWarpConnection(async () => Response.json({ error: 'unauthorized' }, { status: 401 }), keyOnly), 'warp_auth_required')
    assert.equal(await db.inquiry.count(), beforeCheck, 'connectivity check does not touch inquiry DB')
    const guardedPayload = { ...scope, sourceId: sourceId(99), inquiryDate: '2026-09-15', inquiryTime: '09:07', sourceStatus: '', name: '합성', phone: '010-9999-9999' }
    assert.equal((await deliver(guardedPayload, async (_url, init) => {
      assert.equal(JSON.parse(String(init?.body)).rejectExistingCustomer, true)
      return Response.json({ error: 'bad_payload' }, { status: 400 })
    }, keyOnly)).error, 'warp_registration_guard_unavailable', 'old provider rejects guarded payload without a write')
    assert.equal((await deliver(guardedPayload, async () => Response.json({ error: 'invalid_phone' }, { status: 400 }), keyOnly)).error, 'warp_invalid_inquiry')
    assert.equal((await deliver(guardedPayload, async () => Response.json({ error: 'phone_exists' }, { status: 409 }), keyOnly)).error, 'warp_phone_duplicate')
    assert.equal((await deliver(guardedPayload, async () => Response.json({ error: 'ambiguous_phone' }, { status: 409 }), keyOnly)).error, 'warp_customer_conflict')

    assert.equal(await pilotPendingWarp(db, owner, send, keyOnly, now), 'ok')
    assert.equal(calls, 2, 'pilot sends one row and its replay only')
    assert.equal((await db.inquiry.findUniqueOrThrow({ where: { id: first.id } })).warpActivityId, warpActivityId(first.sourceId))
    assert.equal((await db.inquiry.findFirstOrThrow({ where: { ...scope, sourceId: sourceId(3) } })).warpDeliveredAt, null)
    assert.equal((await dispatchPendingWarp(db, owner, send, env, now)).delivered, 1)
    assert.equal(calls, 3, 'other scope and delivered row are excluded')

    // A remote commit can precede a lost local acknowledgment.
    const pending = await add(4)
    receipts.add(sourceId(4))
    let failedCalls = 0
    const unavailable: typeof fetch = async () => { failedCalls++; throw new Error('synthetic transport failure') }
    assert.equal((await dispatchPendingWarp(db, owner, unavailable, env, now)).failed, 1)
    await add(5)
    await dispatchPendingWarp(db, owner, unavailable, env, now)
    assert.equal(failedCalls, 1, 'connection failure pauses delivery for an hour')
    assert.equal((await db.inquiry.findUniqueOrThrow({ where: { id: pending.id } })).warpDeliveredAt, null)
    time = new Date(time.getTime() + 60 * 60_000)
    await claimWorker(db, owner, now())
    assert.equal((await dispatchPendingWarp(db, owner, send, env, now)).delivered, 2)
    assert.equal(receipts.size, 4, 'retry does not create a second remote activity')

    const invalid = await add(6)
    const badReceipt: typeof fetch = async () => Response.json({ ok: true, customerId: 'synthetic-customer', activityId: warpActivityId(sourceId(6)), created: true, duplicate: true })
    assert.equal((await dispatchPendingWarp(db, owner, badReceipt, env, now)).failed, 1)
    assert.equal((await db.inquiry.findUniqueOrThrow({ where: { id: invalid.id } })).warpError, 'warp_invalid_receipt')
    time = new Date(time.getTime() + 60 * 60_000)
    await claimWorker(db, owner, now())
    await dispatchPendingWarp(db, owner, async () => Response.json({ error: 'temporarily_unavailable' }, { status: 503 }), env, now)
    assert.equal((await db.inquiry.findUniqueOrThrow({ where: { id: invalid.id } })).warpError, 'warp_unavailable')
    time = new Date(time.getTime() + 60 * 60_000)
    await claimWorker(db, owner, now())
    await add(7)
    let conflictCalls = 0
    const conflictThenSuccess: typeof fetch = async (url, init) => {
      if (++conflictCalls === 1) return Response.json({ error: 'ambiguous_phone' }, { status: 409 })
      return send(url, init)
    }
    assert.deepEqual(await dispatchPendingWarp(db, owner, conflictThenSuccess, env, now), { configured: true, delivered: 1, failed: 1 })
    assert.equal((await db.inquiry.findUniqueOrThrow({ where: { id: invalid.id } })).warpError, 'warp_customer_conflict')
    time = new Date(time.getTime() + 60 * 60_000)
    await claimWorker(db, owner, now())
    await add(11)
    assert.equal((await dispatchPendingWarp(db, owner, conflictThenSuccess, env, now)).delivered, 1)
    assert.equal(conflictCalls, 3, '409 ambiguous phone stays held while later inquiries proceed')
    assert.equal((await db.inquiry.findUniqueOrThrow({ where: { id: invalid.id } })).warpError, 'warp_customer_conflict')

    await releaseWorker(db, owner, now())
    const before = calls
    await assert.rejects(pilotPendingWarp(db, owner, send, keyOnly, now), /lost_worker_lease/)
    assert.equal(calls, before, 'a worker without a lease cannot send')
    if (process.env.WARP_TEST_RECEIVER) {
      const { handleMarketingInquiryRequest } = createRequire(import.meta.url)(path.resolve(process.env.WARP_TEST_RECEIVER))
      await claimWorker(db, owner, now())
      await add(8)
      await add(9)
      const connected: typeof fetch = async (url, init) => handleMarketingInquiryRequest(new Request(String(url), init), db, env)
      assert.deepEqual(await dispatchPendingWarp(db, owner, connected, env, now), { configured: true, delivered: 0, failed: 1 })
      assert.equal(await db.customer.count(), 0, 'old receiver fails closed on the guarded payload')
      assert.equal(await db.customerActivity.count(), 0)
      assert.equal((await db.inquiry.findFirstOrThrow({ where: { ...scope, sourceId: sourceId(8) } })).warpError, 'warp_registration_guard_unavailable')
    } else await claimWorker(db, owner, now())

    const lost = await add(12)
    const held = await add(13)
    let lostCalls = 0
    const lostFirstResponse: typeof fetch = async (url, init) => {
      const response = await send(url, init)
      if (++lostCalls === 1) throw new Error('synthetic lost response after remote commit')
      return response
    }
    assert.equal(await pilotPendingWarp(db, owner, lostFirstResponse, keyOnly, now), 'warp_unavailable')
    assert.equal(lostCalls, 1)
    assert.equal((await db.inquiry.findUniqueOrThrow({ where: { id: lost.id } })).warpAttemptedAt?.getTime(), now().getTime())
    assert.equal((await db.inquiry.findUniqueOrThrow({ where: { id: held.id } })).warpAttemptedAt, null)
    const beforeRecovery = calls
    assert.equal(await pilotPendingWarp(db, owner, send, keyOnly, now), 'ok_recovered_receipt_unverified')
    assert.equal(calls, beforeRecovery + 2, 'retry uses the same oldest inquiry despite the one-hour backoff')
    assert.equal((await db.inquiry.findUniqueOrThrow({ where: { id: lost.id } })).warpActivityId, warpActivityId(sourceId(12)))
    assert.equal((await db.inquiry.findUniqueOrThrow({ where: { id: lost.id } })).warpError, WARP_RECEIPT_UNVERIFIED)
    assert.equal((await db.inquiry.findUniqueOrThrow({ where: { id: held.id } })).warpDeliveredAt, null)

    assert.equal(await pilotPendingWarp(db, owner, async () => Response.json({ error: 'ambiguous_phone' }, { status: 409 }), keyOnly, now), 'warp_customer_conflict')
    const conflict = await db.inquiry.findUniqueOrThrow({ where: { id: held.id } })
    assert.equal(conflict.warpError, 'warp_customer_conflict')
    assert.equal(conflict.warpAttemptedAt?.getTime(), now().getTime())
    await add(14)
    const pilotSources: string[] = []
    const nextPilot: typeof fetch = async (url, init) => {
      pilotSources.push(JSON.parse(String(init?.body)).sourceId)
      return send(url, init)
    }
    assert.equal(await pilotPendingWarp(db, owner, nextPilot, keyOnly, now), 'ok')
    assert.deepEqual(pilotSources, [sourceId(14), sourceId(14)], 'pilot skips held 409 without retrying it')

    const replayFailure = await add(10)
    let replayCalls = 0
    const mismatch: typeof fetch = async () => {
      replayCalls++
      return Response.json({ ok: true, customerId: replayCalls === 1 ? 'first' : 'other', activityId: warpActivityId(sourceId(10)), created: replayCalls === 1, duplicate: replayCalls === 2 })
    }
    assert.equal(await pilotPendingWarp(db, owner, mismatch, keyOnly, now), 'warp_pilot_replay_mismatch')
    assert.equal(replayCalls, 2)
    assert.equal((await db.inquiry.findUniqueOrThrow({ where: { id: replayFailure.id } })).warpDeliveredAt, null, 'unverified pilot is never acknowledged')
    assert.equal((await db.inquiry.findUniqueOrThrow({ where: { id: replayFailure.id } })).warpError, 'warp_pilot_replay_mismatch')
    console.log('warp delivery checks passed: gate, connectivity, pilot recovery, UUID case, replay, retry, invalid receipt, held conflict, lease')
  } finally {
    await db.$disconnect()
    await rm(temp, { recursive: true, force: true })
  }
}

async function testLocalDuplicates() {
  await withWorkerDatabase(async db => {
    const at = new Date('2026-09-15T00:00:00Z')
    const base = { ...scope, inquiryDate: '2026-09-15', inquiryTime: '09:00', sourceStatus: null, name: null, lastSeenAt: at }
    const first = await db.inquiry.create({ data: { ...base, sourceId: sourceId(91), phone: '010-1234-5678', firstSeenAt: at } })
    const later = await db.inquiry.create({ data: { ...base, sourceId: sourceId(92), phone: '+82 10-1234-5678', firstSeenAt: new Date(at.getTime() + 1) } })
    await db.inquiry.create({ data: { ...base, companyScopeId: 'other-company', sourceId: sourceId(93), phone: '010-1234-5678', firstSeenAt: new Date(at.getTime() + 2) } })
    assert.deepEqual([...await duplicateInquiryIds(db)], [later.id], 'normalization and scope mark only the later local duplicate')
    await claimWorker(db, owner, at)
    await db.inquirySyncState.update({ where: { id: `${scope.source}:${scope.companyScopeId}:${scope.homepageScopeId}` }, data: { status: 'ready' } })
    assert.equal(await requestWarpRegistration(db, later.id, at), 'duplicate')
    let calls = 0
    const send: typeof fetch = async (_url, init) => {
      calls++
      const payload = JSON.parse(String(init?.body))
      assert.equal(payload.sourceId, first.sourceId)
      return Response.json({ ok: true, customerId: 'new-customer', activityId: warpActivityId(payload.sourceId), created: true, duplicate: false })
    }
    assert.deepEqual(await dispatchPendingWarp(db, owner, send, env, () => at), { configured: true, delivered: 1, failed: 0 })
    assert.equal(await pilotPendingWarp(db, owner, send, keyOnly, () => at), 'warp_no_pending_inquiry')
    assert.equal(calls, 1, 'dispatch and pilot never send the later local duplicate')
  })
}

async function testStopDuringHeartbeat() {
  await withWorkerDatabase(async (db, inspect) => {
    for (const index of [1, 2]) await db.inquiry.create({ data: {
      ...scope, sourceId: sourceId(index), inquiryDate: '2026-09-22', inquiryTime: '09:00',
      phone: `010-0000-${String(index).padStart(4, '0')}`, lastSeenAt: new Date(),
    } })
    await claimWorker(db, owner)
    const controller = new AbortController()
    let heartbeats = 0
    let release!: () => void
    let entered!: () => void
    const reached = new Promise<void>((resolve) => { entered = resolve })
    const pause = new Promise<void>((resolve) => { release = resolve })
    const delayed = db.$extends({ query: { inquirySyncState: {
      async updateMany({ args, query }) {
        const result = await query(args)
        // First row: heartbeat, send, acknowledgment heartbeat. Pause before the next send.
        if (++heartbeats === 3) { entered(); await pause }
        return result
      },
    } } })
    let calls = 0
    const sending = dispatchPendingWarp(delayed as PrismaClient, owner, async (_url, init) => {
      calls++
      const body = JSON.parse(String(init?.body))
      return Response.json({ ok: true, customerId: 'synthetic-customer', activityId: warpActivityId(body.sourceId), created: true, duplicate: false })
    }, env, undefined, controller.signal)
    await reached
    controller.abort()
    release()
    assert.deepEqual(await sending, { configured: true, delivered: 1, failed: 0 })
    assert.equal(calls, 1, 'stop during an asynchronous heartbeat prevents the next transmission')
    const rows = await inspect.inquiry.findMany({ orderBy: { sourceId: 'asc' } })
    assert.ok(rows[0].warpDeliveredAt)
    assert.equal(rows[1].warpAttemptedAt, null)
    await releaseWorker(db, owner)
  })
}

const timeout = setTimeout(() => { throw new Error('warp-delivery tests timed out') }, 60_000)
main().catch((error) => { console.error(error); process.exitCode = 1 }).finally(() => clearTimeout(timeout))
