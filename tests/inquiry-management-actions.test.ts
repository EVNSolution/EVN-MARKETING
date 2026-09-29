import assert from 'node:assert/strict'
import { claimNextRun, claimWorker, enqueueSync, finishRun, INQUIRY_SCOPE_ID, reconcile, SyncError } from '@/lib/inquiry-sync'
import { dispatchPendingWarp, MANUAL_REGISTRATION, requestWarpRegistration, scope, warpActivityId, warpDeliverySummary } from '@/lib/warp-delivery'
import { markSourceManaging, sourceUrl } from '@/workers/mleverage-source'
import { withWorkerDatabase } from './worker-runtime-helper'

const key = { WARP_MARKETING_API_KEY: 'synthetic-key-never-used-in-production', WARP_DELIVERY_ENABLED: 'false' }
const owner = 'synthetic-action-worker'
const row = { sourceId: '00000000-0000-4000-8000-000000000001', inquiryDate: '2026-09-29', inquiryTime: '09:00', name: '합성 문의', phone: '010-0000-0001', sourceStatus: '접수' }

async function main() {
  await withWorkerDatabase(async (db, inspect) => {
    const now = new Date()
    const named = await db.inquiry.create({ data: { ...scope, ...row, lastSeenAt: now } })
    const unnamed = await db.inquiry.create({ data: { ...scope, ...row, sourceId: row.sourceId.replace(/1$/, '2'), name: null, lastSeenAt: now } })
    const foreign = await db.inquiry.create({ data: { ...scope, ...row, companyScopeId: 'other-company', lastSeenAt: now } })
    assert.equal(await requestWarpRegistration(db, foreign.id, key), 'not_found')
    assert.equal(await requestWarpRegistration(db, named.id, key), 'worker_offline')
    await claimWorker(db, owner)
    await db.inquirySyncState.update({ where: { id: INQUIRY_SCOPE_ID }, data: { status: 'ready' } })
    assert.equal(await requestWarpRegistration(db, unnamed.id, key), 'name_required')
    assert.equal(await requestWarpRegistration(db, named.id, key), 'queued')
    assert.equal(await requestWarpRegistration(inspect, named.id, key), 'queued')
    assert.equal((await warpDeliverySummary(db, key)).failed, 0, 'a request is not a delivery failure')
    assert.equal((await db.inquiry.findUniqueOrThrow({ where: { id: named.id } })).warpError, MANUAL_REGISTRATION)
    let calls = 0
    const send: typeof fetch = async (_url, init) => {
      calls++
      assert.equal(JSON.parse(String(init?.body)).sourceId, row.sourceId, 'only the requested row is sent')
      return Response.json({ ok: true, customerId: 'synthetic-customer', activityId: warpActivityId(row.sourceId), created: true, duplicate: false })
    }
    assert.deepEqual(await dispatchPendingWarp(db, owner, send, key), { configured: false, delivered: 1, failed: 0 })
    assert.equal(await requestWarpRegistration(db, named.id, key), 'delivered')
    await dispatchPendingWarp(db, owner, send, key)
    assert.equal(calls, 1, 'repeat requests do not resend delivered rows or send the backlog')
    assert.equal((await db.inquiry.findUniqueOrThrow({ where: { id: unnamed.id } })).warpDeliveredAt, null)
    await db.inquiry.update({ where: { id: unnamed.id }, data: { warpError: MANUAL_REGISTRATION } })
    assert.equal((await dispatchPendingWarp(db, owner, send, key)).failed, 1)
    assert.equal(calls, 1, 'the worker independently enforces the unknown-name gate')
    await db.inquiry.update({ where: { id: unnamed.id }, data: { name: '합성 이름', warpError: 'warp_unavailable', warpAttemptedAt: new Date() } })
    assert.equal(await requestWarpRegistration(db, unnamed.id, key), 'connection_backoff')
  })

  await withWorkerDatabase(async (db, inspect) => {
    await claimWorker(db, owner)
    await enqueueSync(db, 'manual', '2026-09-29')
    const run = await claimNextRun(db, new Date(), owner, '2026-09-29')
    assert.ok(run)
    let called = 0
    const result = await reconcile(db, run.id, owner, '2000-01-01', '2026-09-29', async () => ({ page: 1, total: 1, rows: [row] }), undefined, undefined, async (saved) => {
      called++
      assert.ok(await inspect.inquiry.findFirst({ where: { sourceId: saved.sourceId } }), 'external changes happen only after a committed save')
      throw new SyncError('source_status_update_failed')
    })
    assert.equal(called, 1)
    assert.equal(result.status, 'partial')
    await finishRun(db, run.id, owner, result)
    assert.equal((await db.inquirySyncState.findUniqueOrThrow({ where: { id: INQUIRY_SCOPE_ID } })).lastSuccessfulAt, null, 'failed remote marking does not advance the collection cutoff')
    await enqueueSync(db, 'manual', '2026-09-29')
    const retry = await claimNextRun(db, new Date(), owner, '2026-09-29')
    assert.ok(retry)
    const retried = await reconcile(db, retry.id, owner, '2000-01-01', '2026-09-29', async () => ({ page: 1, total: 1, rows: [row] }), undefined, undefined, async () => { called++ })
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
