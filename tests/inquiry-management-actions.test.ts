import assert from 'node:assert/strict'
import { claimNextRun, claimWorker, enqueueSync, finishRun, INQUIRY_SCOPE_ID, reconcile, SyncError } from '@/lib/inquiry-sync'
import { dispatchPendingWarp, MANUAL_CONFIRMATION, MANUAL_REGISTRATION, pilotPendingWarp, requestWarpRegistration, scope, warpActivityId, warpDeliveryState, warpDeliverySummary } from '@/lib/warp-delivery'
import { markSourceManaging, sourceUrl } from '@/workers/mleverage-source'
import { withWorkerDatabase } from './worker-runtime-helper'

const key = { WARP_MARKETING_API_KEY: 'synthetic-key-never-used-in-production', WARP_DELIVERY_ENABLED: 'false' }
const owner = 'synthetic-action-worker'
const row = { sourceId: '00000000-0000-4000-8000-000000000001', inquiryDate: '2026-09-29', inquiryTime: '09:00', name: '합성 문의', phone: '010-0000-0001', sourceStatus: '접수' }

async function main() {
  await withWorkerDatabase(async db => {
    const now = new Date('2026-09-30T00:00:00Z')
    const confirmed = await db.inquiry.create({ data: { ...scope, ...row, lastSeenAt: now, warpError: MANUAL_CONFIRMATION } })
    const delivered = await db.inquiry.create({ data: { ...scope, ...row, sourceId: row.sourceId.replace(/1$/, '2'), lastSeenAt: now,
      warpCustomerId: 'authentic-customer', warpActivityId: warpActivityId(row.sourceId.replace(/1$/, '2')), warpDeliveredAt: now, warpAttemptedAt: now } })
    const confirmedBefore = await db.inquiry.findUniqueOrThrow({ where: { id: confirmed.id } })
    const deliveredBefore = await db.inquiry.findUniqueOrThrow({ where: { id: delivered.id } })
    assert.deepEqual(warpDeliveryState(confirmed), { status: 'delivered', label: '등록 완료', reason: '사용자가 WARP에 직접 등록했음을 확인했습니다.' })
    assert.deepEqual(await warpDeliverySummary(db, key), { configured: false, delivered: 2, pending: 0, failed: 0 })
    assert.equal(await requestWarpRegistration(db, confirmed.id), 'delivered')
    await claimWorker(db, owner, now)
    await db.inquirySyncState.update({ where: { id: INQUIRY_SCOPE_ID }, data: { status: 'ready' } })
    let calls = 0
    const sent: string[] = []
    const send: typeof fetch = async (_url, init) => {
      calls++
      const payload = JSON.parse(String(init?.body))
      sent.push(payload.sourceId)
      return Response.json({ ok: true, customerId: 'synthetic-customer', activityId: warpActivityId(payload.sourceId), created: calls % 2 === 1, duplicate: calls % 2 === 0 })
    }
    assert.equal(await pilotPendingWarp(db, owner, send, key, () => now), 'warp_no_pending_inquiry')
    assert.equal(calls, 0, 'manual confirmation is not sent by the pilot')

    const pilotRow = await db.inquiry.create({ data: { ...scope, ...row, sourceId: row.sourceId.replace(/1$/, '3'), phone: '010-0000-0003', lastSeenAt: now } })
    assert.equal(await pilotPendingWarp(db, owner, send, key, () => now), 'ok')
    assert.deepEqual(sent, [pilotRow.sourceId, pilotRow.sourceId], 'nullable pending rows remain eligible for the pilot')

    const automatic = await db.inquiry.create({ data: { ...scope, ...row, sourceId: row.sourceId.replace(/1$/, '4'), phone: '010-0000-0004', lastSeenAt: now } })
    assert.deepEqual(await dispatchPendingWarp(db, owner, send, { ...key, WARP_DELIVERY_ENABLED: 'true' }, () => now), { configured: true, delivered: 1, failed: 0 })
    assert.equal(sent.at(-1), automatic.sourceId, 'new pending rows remain eligible for automatic delivery')

    const requested = await db.inquiry.create({ data: { ...scope, ...row, sourceId: row.sourceId.replace(/1$/, '5'), phone: '010-0000-0005', warpPhoneStatus: 'clear', warpPhoneCheckedAt: now, lastSeenAt: now } })
    assert.equal(await requestWarpRegistration(db, requested.id, now), 'queued')
    assert.deepEqual(await dispatchPendingWarp(db, owner, send, key, () => now), { configured: false, delivered: 1, failed: 0 })
    assert.equal(sent.at(-1), requested.sourceId, 'manual requests remain eligible while automatic delivery is disabled')
    assert.deepEqual(await db.inquiry.findUniqueOrThrow({ where: { id: confirmed.id } }), confirmedBefore, 'manual confirmation keeps receipt fields null and is never sent')
    assert.deepEqual(await db.inquiry.findUniqueOrThrow({ where: { id: delivered.id } }), deliveredBefore, 'authentic delivery receipts remain unchanged')
  })

  await withWorkerDatabase(async (db, inspect) => {
    const now = new Date()
    const named = await db.inquiry.create({ data: { ...scope, ...row, warpPhoneStatus: 'clear', warpPhoneCheckedAt: now, lastSeenAt: now } })
    const unnamed = await db.inquiry.create({ data: { ...scope, ...row, sourceId: row.sourceId.replace(/1$/, '2'), phone: '010-0000-0002', name: null, warpPhoneStatus: 'clear', warpPhoneCheckedAt: now, lastSeenAt: now } })
    const foreign = await db.inquiry.create({ data: { ...scope, ...row, companyScopeId: 'other-company', lastSeenAt: now } })
    assert.equal(await requestWarpRegistration(db, foreign.id), 'not_found')
    assert.equal(await requestWarpRegistration(db, named.id), 'worker_offline')
    await claimWorker(db, owner)
    await db.inquirySyncState.update({ where: { id: INQUIRY_SCOPE_ID }, data: { status: 'ready' } })
    assert.equal(await requestWarpRegistration(db, named.id), 'queued')
    assert.equal(await requestWarpRegistration(inspect, named.id), 'queued')
    assert.equal((await warpDeliverySummary(db, key)).failed, 0, 'a request is not a delivery failure')
    assert.equal((await db.inquiry.findUniqueOrThrow({ where: { id: named.id } })).warpError, MANUAL_REGISTRATION)
    let calls = 0
    const send: typeof fetch = async (_url, init) => {
      calls++
      const payload = JSON.parse(String(init?.body))
      assert.equal(payload.sourceId, calls === 1 ? named.sourceId : unnamed.sourceId, 'only the requested row is sent')
      assert.equal(payload.name, calls === 1 ? row.name : '미상(📞 0002)', 'legacy blank names use the WARP naming rule before transmission')
      return Response.json({ ok: true, customerId: 'synthetic-customer', activityId: warpActivityId(payload.sourceId), created: true, duplicate: false })
    }
    assert.deepEqual(await dispatchPendingWarp(db, owner, send, key), { configured: false, delivered: 1, failed: 0 })
    assert.equal(await requestWarpRegistration(db, named.id), 'delivered')
    await dispatchPendingWarp(db, owner, send, key)
    assert.equal(calls, 1, 'repeat requests do not resend delivered rows or send the backlog')
    assert.equal((await db.inquiry.findUniqueOrThrow({ where: { id: unnamed.id } })).warpDeliveredAt, null)
    await db.inquiry.update({ where: { id: unnamed.id }, data: { warpError: 'warp_unavailable', warpAttemptedAt: new Date() } })
    assert.equal(await requestWarpRegistration(db, unnamed.id), 'connection_backoff')
    await db.inquiry.update({ where: { id: unnamed.id }, data: { warpError: null, warpAttemptedAt: null } })
    assert.equal(await requestWarpRegistration(db, unnamed.id), 'queued')
    assert.equal((await dispatchPendingWarp(db, owner, send, key)).delivered, 1)
    assert.equal(await requestWarpRegistration(db, unnamed.id), 'delivered')
    await dispatchPendingWarp(db, owner, send, key)
    assert.equal(calls, 2, 'an unnamed inquiry is sent once and repeat requests remain idempotent')
  })

  await withWorkerDatabase(async (db, inspect) => {
    const unnamedRow = { ...row, name: null }
    await claimWorker(db, owner)
    await enqueueSync(db, 'manual', '2026-09-29')
    const run = await claimNextRun(db, new Date(), owner, '2026-09-29')
    assert.ok(run)
    let called = 0
    const result = await reconcile(db, run.id, owner, '2000-01-01', '2026-09-29', async () => ({ page: 1, total: 1, rows: [unnamedRow] }), undefined, undefined, async (saved) => {
      called++
      assert.equal((await inspect.inquiry.findFirstOrThrow({ where: { sourceId: saved.sourceId } })).name, '미상(📞 0001)', 'generated name is committed before external changes')
      throw new SyncError('source_status_update_failed')
    })
    assert.equal(called, 1)
    assert.equal(result.status, 'partial')
    await finishRun(db, run.id, owner, result)
    assert.equal((await db.inquirySyncState.findUniqueOrThrow({ where: { id: INQUIRY_SCOPE_ID } })).lastSuccessfulAt, null, 'failed remote marking does not advance the collection cutoff')
    await enqueueSync(db, 'manual', '2026-09-29')
    const retry = await claimNextRun(db, new Date(), owner, '2026-09-29')
    assert.ok(retry)
    const retried = await reconcile(db, retry.id, owner, '2000-01-01', '2026-09-29', async () => ({ page: 1, total: 1, rows: [unnamedRow] }), undefined, undefined, async () => { called++ })
    assert.equal(retried.status, 'success')
    assert.equal(called, 2, 'a committed row is still marked when recovering a failed marking')
    assert.equal(await db.inquiry.count(), 1)
    assert.equal((await db.inquiry.findFirstOrThrow()).sourceStatus, '접수', 'preserve the original inquiry snapshot')
  })

  const makePage = (initial: string, wrongScope = false, persist = true) => {
    let status = initial, writes = 0, reloads = 0
    const choice = { waitFor: async () => {}, click: async () => { writes++; status = '관리중' } }
    const cell = { count: async () => 1, innerText: async () => status,
      locator: () => ({ getAttribute: async () => 'dropdown-synthetic' }),
      getByRole: (_role: string, opts?: { name: string }) => opts
        ? { waitFor: async () => { assert.equal(status, opts.name) } } : { click: async () => {} } }
    return {
      page: {
        url: () => wrongScope ? 'https://example.invalid/inquiry-history' : sourceUrl('2000-01-01', '2026-09-29', 1),
        locator: (selector: string) => selector.includes('phoneNumber') ? { innerText: async () => row.phone }
          : selector.includes('role="menu"') ? { getByRole: () => choice } : cell,
        waitForLoadState: async () => {},
        reload: async () => { reloads++; if (!persist) status = initial },
      }, writes: () => writes, reloads: () => reloads,
    }
  }
  const received = makePage('접수')
  await markSourceManaging(received.page as never, row)
  assert.equal(received.writes(), 1); assert.equal(received.reloads(), 1)
  await markSourceManaging(received.page as never, row)
  assert.equal(received.writes(), 1, 'already managed rows are untouched')
  const finished = makePage('계약완료')
  await markSourceManaging(finished.page as never, row)
  assert.equal(finished.writes(), 0)
  const wrong = makePage('접수', true)
  await assert.rejects(markSourceManaging(wrong.page as never, row), /source_status_scope/)
  assert.equal(wrong.writes(), 0)
  const aborted = new AbortController(); aborted.abort()
  await assert.rejects(markSourceManaging(received.page as never, row, aborted.signal), /interrupted/)
  await assert.rejects(markSourceManaging(makePage('접수', false, false).page as never, row), /source_status_update_failed/)
  console.log('inquiry management actions checks passed')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
