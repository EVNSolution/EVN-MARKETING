import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { claimWorker, INQUIRY_SCOPE_ID } from '@/lib/inquiry-sync'
import { landingScope, saveLandingInquiry } from '@/lib/landing-inquiries'
import { checkedDeliver, CUSTOMER_LEAD_COMPLETE, CUSTOMER_LEAD_POLICY, CUSTOMER_ONLY, dispatchPendingWarp,
  requestWarpRegistration, scope, warpActivityId, warpDeliveryState } from '@/lib/warp-delivery'
import { withWorkerDatabase } from './worker-runtime-helper'

const env = { WARP_MARKETING_API_KEY: 'synthetic-key-for-isolated-test-only', WARP_DELIVERY_ENABLED: 'false' }
const owner = 'synthetic-registration-worker'
const at = new Date('2026-10-12T14:59:59.000Z')

async function main() {
  for (const sourceScope of [scope, landingScope]) await withWorkerDatabase(async db => {
    let time = at
    const sourceId = randomUUID()
    if (sourceScope === landingScope) await saveLandingInquiry(db, { submissionId: sourceId, phone: '01077770001', name: '합성', kind: 'consultation', region: null }, env.WARP_MARKETING_API_KEY, time)
    else await db.inquiry.create({ data: { ...scope, sourceId, name: '합성', phone: '01077770001', inquiryDate: '2026-10-01', inquiryTime: '10:00', lastSeenAt: time } })
    const row = await db.inquiry.findFirstOrThrow({ where: { sourceId } })
    const historical = await db.inquiry.create({ data: { ...scope, sourceId: randomUUID(), name: '과거 합성', phone: '01077770002',
      inquiryDate: '2026-09-01', inquiryTime: '10:00', lastSeenAt: time, warpDeliveredAt: time, warpCustomerId: 'historical-customer' } })
    await claimWorker(db, owner, time)
    await db.inquirySyncState.update({ where: { id: INQUIRY_SCOPE_ID }, data: { status: 'ready' } })
    let writes = 0
    let receipt: Record<string, unknown> | null = null
    const send: typeof fetch = async (url, init) => {
      const input = JSON.parse(String(init?.body))
      assert.equal(input.registrationPolicy, CUSTOMER_LEAD_POLICY)
      assert.equal(input.source, sourceScope.source)
      if (String(url).endsWith('/check')) return Response.json({ ok: true, results: input.items.map((item: { sourceId: string }) => ({
        sourceId: item.sourceId, exists: Boolean(receipt), ...(receipt ? { receipt: { ...receipt, created: false, duplicate: true } } : {}),
      })) })
      writes++
      assert.equal(input.rejectExistingCustomer, true)
      const activityId = warpActivityId(input.sourceId, sourceScope)
      receipt = { ok: true, customerId: 'new-synthetic-customer', activityId, created: true, duplicate: false,
        registration: { policy: CUSTOMER_LEAD_POLICY, state: 'complete', leadId: `lead_${activityId}`, registeredAt: time.toISOString() } }
      throw new Error('synthetic response lost after atomic commit')
    }
    assert.equal(await requestWarpRegistration(db, row.id, time), 'queued')
    assert.equal(await requestWarpRegistration(db, row.id, time), 'queued')
    assert.equal((await dispatchPendingWarp(db, owner, send, env, () => time)).failed, 1)
    assert.equal((await db.inquiry.findUniqueOrThrow({ where: { id: row.id } })).warpDeliveredAt, null)
    time = new Date(at.getTime() + 3_600_001)
    await claimWorker(db, owner, time)
    await db.inquirySyncState.update({ where: { id: INQUIRY_SCOPE_ID }, data: { status: 'ready' } })
    assert.equal(await requestWarpRegistration(db, row.id, time), 'queued')
    assert.equal((await dispatchPendingWarp(db, owner, send, env, () => time)).delivered, 1)
    assert.equal(writes, 1, 'response loss recovers the retained receipt without a second write')
    const stored = await db.inquiry.findUniqueOrThrow({ where: { id: row.id } })
    assert.equal(stored.warpError, CUSTOMER_LEAD_COMPLETE)
    assert.equal(warpDeliveryState(stored).label, '고객·리드 등록완료')
    assert.equal(await requestWarpRegistration(db, row.id, time), 'delivered')
    assert.deepEqual(await db.inquiry.findUniqueOrThrow({ where: { id: historical.id } }), historical)
  }, ['20261007000100_landing_inquiries'])

  const input = { ...scope, sourceId: randomUUID(), name: '합성', phone: '01099990001', inquiryDate: '2026-10-01', inquiryTime: '10:00', sourceStatus: '', registrationPolicy: CUSTOMER_LEAD_POLICY } as const
  const activityId = warpActivityId(input.sourceId)
  const base = { ok: true, customerId: 'synthetic-customer', activityId, created: true, duplicate: false }
  const registration = { policy: CUSTOMER_LEAD_POLICY, state: 'complete', leadId: `lead_${activityId}`, registeredAt: at.toISOString() }
  for (const [reply, expected] of [
    [base, CUSTOMER_ONLY],
    [{ ...base, registration: { ...registration, state: 'customer_only', leadId: null } }, CUSTOMER_ONLY],
    [{ ...base, registration: { ...registration, policy: 'older' } }, 'warp_invalid_receipt'],
    [{ ...base, registration: { ...registration, leadId: 'unrelated-lead' } }, 'warp_invalid_receipt'],
    [{ ...base, registration: { ...registration, registeredAt: 'not-a-date' } }, 'warp_invalid_receipt'],
    [{ ...base, registration }, ''],
  ] as const) {
    const result = await checkedDeliver(input, async url => String(url).endsWith('/check')
      ? Response.json({ ok: true, results: [{ sourceId: input.sourceId, exists: false }] }) : Response.json(reply), env)
    assert.equal(result.error, expected)
    assert.equal(Boolean(result.receipt), expected === '')
  }
  let writes = 0
  const held = await checkedDeliver(input, async url => {
    if (!String(url).endsWith('/check')) { writes++; throw Error('unexpected write') }
    return Response.json({ ok: true, results: [{ sourceId: input.sourceId, exists: true, receipt: { ...base, created: false, duplicate: true } }] })
  }, env)
  assert.equal(held.error, CUSTOMER_ONLY); assert.equal(writes, 0)
  assert.equal(warpDeliveryState({ warpDeliveredAt: null, warpError: held.error }).status, 'blocked')
  assert.equal((await checkedDeliver(input, async () => Response.json({ error: 'bad_payload' }, { status: 400 }), env)).error,
    'warp_duplicate_check_unavailable', 'old check endpoint rejects the opt-in policy without a write')
  const unavailable = await checkedDeliver(input, async url => String(url).endsWith('/check')
    ? Response.json({ ok: true, results: [{ sourceId: input.sourceId, exists: false }] })
    : Response.json({ error: 'lead_mapping_unavailable' }, { status: 503 }), env)
  assert.equal(unavailable.error, 'warp_lead_mapping_unavailable')
  assert.equal(warpDeliveryState({ warpDeliveredAt: null, warpError: unavailable.error }).status, 'retrying')
  console.log('Customer/lead registration passed: both sources, repeated request, lost response recovery, no backfill, strict v1 receipt, customer-only hold, safe mapping retry')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
