import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { normalizeInquiryPhone } from '@/lib/format'
import { claimWorker, INQUIRY_SCOPE_ID, releaseWorker } from '@/lib/inquiry-sync'
import { deliver, dispatchPendingWarp, duplicateInquiryIds, MANUAL_CONFIRMATION, MANUAL_REGISTRATION, refreshWarpPhoneChecks, requestWarpRegistration, scope, warpActivityId, warpDeliveryState } from '@/lib/warp-delivery'
import { withWorkerDatabase } from './worker-runtime-helper'

const env = { WARP_MARKETING_API_KEY: 'synthetic-duplicate-check-key-not-production', WARP_DELIVERY_ENABLED: 'false' }
const owner = 'synthetic-duplicate-worker'
const at = new Date('2026-09-30T00:00:00Z')
const sourceId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const input = (n: number) => ({ ...scope, sourceId: sourceId(n), inquiryDate: '2026-09-30', inquiryTime: '09:00',
  phone: `010-0000-${String(n).padStart(4, '0')}`, name: '합성 문의', firstSeenAt: new Date(at.getTime() + n), lastSeenAt: at })
const clear = { warpPhoneStatus: 'clear', warpPhoneCheckedAt: at }

async function main() {
  assert.equal(normalizeInquiryPhone('+82 10 1234 5678'), normalizeInquiryPhone('010-1234-5678'))
  assert.equal(normalizeInquiryPhone('   '), '')
  assert.notEqual(normalizeInquiryPhone('010-1111-5678'), normalizeInquiryPhone('010-2222-5678'))
  await withWorkerDatabase(async db => {
    await claimWorker(db, owner, at)
    await db.inquirySyncState.update({ where: { id: INQUIRY_SCOPE_ID }, data: { status: 'ready' } })
    const first = await db.inquiry.create({ data: { ...input(1), ...clear, warpError: MANUAL_CONFIRMATION } })
    const later = await db.inquiry.create({ data: { ...input(2), ...clear, name: '다른 이름', phone: '+82 10 0000 0001' } })
    const existing = await db.inquiry.create({ data: { ...input(3), warpPhoneStatus: 'duplicate', warpPhoneCheckedAt: at } })
    const unique = await db.inquiry.create({ data: { ...input(4), ...clear } })
    const unknown = await db.inquiry.create({ data: input(5) })
    const foreign = await db.inquiry.create({ data: { ...input(6), ...clear, companyScopeId: 'other-company', phone: unique.phone } })
    const duplicates = await duplicateInquiryIds(db)
    assert.deepEqual([...duplicates], [later.id], 'scan sees other pages and ignores foreign scopes, names, separators and country prefix')
    assert.equal(warpDeliveryState(first, true, at).status, 'delivered')
    assert.equal(warpDeliveryState(later, true, at).reason, '수집된 문의와 연락처 중복')
    assert.equal(warpDeliveryState(existing, false, at).reason, 'WARP 고객과 연락처 중복')
    assert.equal(warpDeliveryState(existing, true, at).reason, '수집된 문의 및 WARP 고객과 연락처 중복')
    assert.equal(await requestWarpRegistration(db, later.id, at), 'duplicate')
    assert.equal(await requestWarpRegistration(db, existing.id, at), 'duplicate')
    assert.equal(await requestWarpRegistration(db, unknown.id, at), 'duplicate_check_pending')
    assert.equal(await requestWarpRegistration(db, foreign.id, at), 'not_found')
    assert.equal(await requestWarpRegistration(db, unique.id, at), 'queued')
    assert.equal(warpDeliveryState({ ...unique, warpPhoneCheckedAt: new Date(at.getTime() - 11 * 60_000) }, false, at).status, 'checking')
    // Even a stale screen/direct API or a previously queued duplicate must not send.
    await db.inquiry.update({ where: { id: later.id }, data: { warpError: MANUAL_REGISTRATION } })
    const sent: string[] = []
    const result = await dispatchPendingWarp(db, owner, async (_url, init) => {
      const body = JSON.parse(String(init?.body)); sent.push(body.sourceId)
      assert.equal(body.rejectExistingCustomer, true, 'WARP rechecks inside its write transaction')
      return Response.json({ error: 'phone_exists' }, { status: 409 })
    }, env, () => at)
    assert.deepEqual(sent, [unique.sourceId])
    assert.equal(result.failed, 1)
    assert.equal(warpDeliveryState(await db.inquiry.findUniqueOrThrow({ where: { id: unique.id } }), false, at).status, 'duplicate')
    assert.equal(await db.inquiry.count(), 6, 'duplicates are preserved')
  })

  await withWorkerDatabase(async db => {
    await claimWorker(db, owner, at)
    const rows = await Promise.all([1, 2, 3].map(n => db.inquiry.create({ data: input(n) })))
    const invalidPhone = await db.inquiry.create({ data: { ...input(4), phone: '-' } })
    let calls = 0
    const send: typeof fetch = async (url, init) => {
      calls++
      assert.equal(url, 'https://warp.cleversystem.ai/api/external/marketing-inquiries/check')
      assert.equal(init?.method, 'POST'); assert.equal(init?.redirect, 'error')
      const body = JSON.parse(String(init?.body))
      assert.equal(body.companyScopeId, scope.companyScopeId)
      assert.equal(body.items.length, 3)
      return Response.json({ ok: true, results: body.items.map((item: { sourceId: string }) => ({ sourceId: item.sourceId,
        exists: item.sourceId !== sourceId(1),
        ...(item.sourceId === sourceId(3) ? { receipt: { ok: true, customerId: 'synthetic-existing', activityId: warpActivityId(item.sourceId), created: false, duplicate: true } } : {}),
      })) })
    }
    await refreshWarpPhoneChecks(db, owner, send, {}, () => at)
    assert.equal(calls, 0, 'web/config without key never queries WARP')
    await refreshWarpPhoneChecks(db, owner, send, env, () => at)
    const checked = await db.inquiry.findMany({ orderBy: { sourceId: 'asc' } })
    assert.equal(checked[0].warpPhoneStatus, 'clear')
    assert.equal(checked[1].warpPhoneStatus, 'duplicate')
    assert.equal(checked[3].warpPhoneStatus, 'invalid', 'one invalid legacy phone cannot poison the rest of a batch')
    assert.equal(warpDeliveryState(checked[2], true, at).status, 'delivered', 'our own receipt is restored, not classified as a different customer')
    assert.equal(checked[2].warpActivityId, warpActivityId(sourceId(3)))
    assert.equal(await db.customer.count(), 0, 'lookup does not create local CRM data')
    await refreshWarpPhoneChecks(db, owner, send, env, () => at)
    assert.equal(calls, 1, 'fresh checks are not polled on every worker tick')

    const later = new Date(at.getTime() + 6 * 60_000)
    await claimWorker(db, owner, later)
    const invalid: typeof fetch = async () => Response.json({ ok: true, results: [
      { sourceId: sourceId(1), exists: false }, { sourceId: sourceId(1), exists: false },
    ] })
    await refreshWarpPhoneChecks(db, owner, invalid, env, () => later)
    for (const row of await db.inquiry.findMany({ where: { warpDeliveredAt: null, id: { not: invalidPhone.id } } })) {
      assert.equal(row.warpPhoneStatus, 'unavailable', 'invalid partial batch cannot clear any row')
      assert.equal(warpDeliveryState(row, false, later).status, 'checking')
    }
    await refreshWarpPhoneChecks(db, owner, async () => { assert.fail('must back off after failed lookup') }, env, () => later)
    await releaseWorker(db, owner, later)
    await assert.rejects(refreshWarpPhoneChecks(db, owner, send, env, () => new Date(later.getTime() + 60_000)), /lost_worker_lease/)
    assert.equal(calls, 1)
    assert.equal(await requestWarpRegistration(db, rows[2].id, later), 'delivered')
  })

  await withWorkerDatabase(async db => {
    await claimWorker(db, owner, at)
    for (let n = 1; n <= 55; n++) await db.inquiry.create({ data: { ...input(n), phone: n < 55 ? input(1).phone : input(n).phone } })
    const sent: string[] = []
    await dispatchPendingWarp(db, owner, async (_url, init) => {
      const body = JSON.parse(String(init?.body)); sent.push(body.sourceId)
      return Response.json({ ok: true, customerId: 'synthetic-customer', activityId: warpActivityId(body.sourceId), created: true, duplicate: false })
    }, { ...env, WARP_DELIVERY_ENABLED: 'true' }, () => at)
    assert.deepEqual(sent, [sourceId(1), sourceId(55)], 'duplicate-filled batches do not starve later unique inquiries')
  })
  const receipt = await deliver({ ...scope, sourceId: sourceId(1), inquiryDate: '2026-09-30', inquiryTime: '09:00', sourceStatus: '', name: '', phone: input(1).phone },
    async () => Response.json({ error: 'phone_exists' }, { status: 409 }), env)
  assert.equal(receipt.error, 'warp_phone_duplicate')
  if (process.env.WARP_TEST_RECEIVER) await withWorkerDatabase(async db => {
    const receiver = createRequire(import.meta.url)(path.resolve(process.env.WARP_TEST_RECEIVER!))
    const send: typeof fetch = async (url, init) => String(url).endsWith('/check')
      ? receiver.handleMarketingInquiryCheckRequest(new Request(String(url), init), db, env)
      : receiver.handleMarketingInquiryRequest(new Request(String(url), init), db, env)
    await db.customer.create({ data: { id: 'existing-customer', name: '기존 이름 유지', phone: '+82 10 0000 0002' } })
    for (const n of [1, 2, 3]) await db.inquiry.create({ data: { ...input(n), phone: n === 3 ? input(1).phone : input(n).phone } })
    await claimWorker(db, owner, at)
    await refreshWarpPhoneChecks(db, owner, send, env, () => at)
    const checked = await db.inquiry.findMany({ orderBy: { sourceId: 'asc' } })
    assert.deepEqual(checked.map(row => row.warpPhoneStatus), ['clear', 'duplicate', 'clear'])
    assert.deepEqual(await dispatchPendingWarp(db, owner, send, { ...env, WARP_DELIVERY_ENABLED: 'true' }, () => at), { configured: true, delivered: 1, failed: 0 })
    assert.equal(await db.customer.count(), 2)
    assert.equal(await db.customerActivity.count(), 1, 'neither a local nor WARP duplicate creates an activity')
    const existing = await db.customer.findUniqueOrThrow({ where: { id: 'existing-customer' } })
    assert.equal(existing.name, '기존 이름 유지')
    await db.inquiry.update({ where: { id: checked[0].id }, data: { warpDeliveredAt: null, warpPhoneCheckedAt: null } })
    await refreshWarpPhoneChecks(db, owner, send, env, () => at)
    assert.ok((await db.inquiry.findUniqueOrThrow({ where: { id: checked[0].id } })).warpDeliveredAt, 'real check recovers original receipt')
    assert.equal(await db.customerActivity.count(), 1)
    console.log('paired real Marketing/WARP check, guarded delivery, duplicate hold and receipt recovery passed')
  })
  console.log('inquiry duplicate checks passed: local/global scope, normalization, cache, lookup failure, replay, request/worker guards, batch progress')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
