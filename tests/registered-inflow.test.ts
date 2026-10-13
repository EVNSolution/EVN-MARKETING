import assert from 'node:assert/strict'
import type { Prisma } from '@/app/generated/prisma/client'
import { readRegisteredInflow } from '@/lib/registered-inflow'
import { dashboardDates, parseDashboardQuery, selectDashboardHistory } from '@/lib/external-dashboard-history'
import { CUSTOMER_LEAD_COMPLETE, CUSTOMER_ONLY, deliveryScopes, MANUAL_CONFIRMATION, scope } from '@/lib/warp-delivery'
import { landingScope } from '@/lib/landing-inquiries'
import { withWorkerDatabase } from './worker-runtime-helper'

async function main() {
  await withWorkerDatabase(async db => {
    const today = '2026-10-13', range = { start: '2026-10-01', end: '2026-10-05', today }
    let next = 0
    const add = async (values: Partial<Prisma.InquiryUncheckedCreateInput> = {}) => db.inquiry.create({ data: {
      ...scope, id: `inflow-${++next}`, sourceId: `source-${next}`, name: 'private-name-must-not-leak', phone: `0108888${String(next).padStart(4, '0')}`,
      inquiryDate: '2026-10-04', inquiryTime: '09:00', lastSeenAt: new Date('2026-10-13T01:00:00Z'),
      firstSeenAt: new Date('2026-10-10T00:00:00Z'), warpDeliveredAt: new Date('2026-10-12T00:00:00Z'),
      warpCustomerId: 'private-customer-id', warpActivityId: 'private-activity-id', ...values,
    } })
    const first = await add({ phone: '010-1111-0001', inquiryDate: '2026-10-01' })
    await add({ ...landingScope, phone: '+82 10-1111-0001', inquiryDate: '2026-10-02', inquiryTime: '08:00:01' })
    await add({ phone: '0082-10-1111-0001', inquiryDate: '2026-10-03' })
    await add({ phone: '01011110001', inquiryDate: '2026-09-01', warpDeliveredAt: null, warpError: 'warp_manual_requested' })
    await add({ ...landingScope, inquiryDate: '2026-10-02', warpDeliveredAt: null, warpError: MANUAL_CONFIRMATION })
    await add({ inquiryDate: '2026-10-03', warpError: CUSTOMER_LEAD_COMPLETE })
    await add({ ...landingScope, inquiryDate: '2026-10-03', inquiryTime: '08:00:01', phone: '010-1111-0002' })
    await add({ inquiryDate: '2026-10-03', inquiryTime: '08:00', phone: '01011110002' })
    await add({ inquiryDate: '2026-10-03', inquiryTime: '08:00:00', phone: '+82 (0)10 1111 0002' })
    for (const warpError of [null, 'warp_manual_requested', 'warp_landing_sending', 'warp_landing_interrupted',
      'warp_duplicate_reviewed', 'warp_existing_customer_reviewed', 'warp_existing_customer', 'warp_receipt_unverified',
      'warp_duplicate_recheck_requested', 'warp_duplicate_recheck_failed', 'warp_local_duplicate', 'warp_phone_duplicate',
      'warp_customer_conflict', 'warp_review_cleared', 'warp_registration_guard_unavailable', 'warp_unavailable',
      'warp_lead_mapping_unavailable', CUSTOMER_ONLY]) await add({ warpError, warpDeliveredAt: null })
    for (const warpError of [CUSTOMER_ONLY, 'warp_receipt_unverified', 'warp_existing_customer', 'warp_duplicate_reviewed', 'warp_existing_customer_reviewed']) {
      await add({ warpError }) // A saved delivered timestamp must not make these held statuses count.
    }
    for (const phone of ['', 'no-phone', '123', '1234567890123456']) await add({ phone })
    for (const inquiryDate of ['', '2026-02-30', '2026-10-32', '2026-1-01', '2026-10-14']) await add({ inquiryDate })
    for (const inquiryTime of ['', '24:00', '09:60', '09:00:60']) await add({ inquiryTime })
    for (const foreign of [{ source: 'foreign' }, { companyScopeId: 'foreign' }, { homepageScopeId: 'foreign' }]) await add(foreign)
    await add({ ...landingScope, companyScopeId: 'foreign' })

    const before = await db.inquiry.findMany({ orderBy: { id: 'asc' } })
    const result = await readRegisteredInflow(db, range)
    assert.deepEqual(result, { start: range.start, end: range.end, total: 8, days: [
      { date: '2026-10-01', count: 1 }, { date: '2026-10-02', count: 1 }, { date: '2026-10-03', count: 2 },
      { date: '2026-10-04', count: 4 }, { date: '2026-10-05', count: 0 },
    ] })
    assert.equal(result.days[3].count, 4, 'missing or malformed inquiry time does not discard a valid completed day and phone')
    assert.deepEqual(await db.inquiry.findMany({ orderBy: { id: 'asc' } }), before, 'aggregation is read-only')
    assert.deepEqual(Object.keys(result).sort(), ['days', 'end', 'start', 'total'])
    assert.ok(result.days.every(day => Object.keys(day).sort().join(',') === 'count,date'))
    assert.doesNotMatch(JSON.stringify(result), /private-|010|source-|customerId|activityId|phone|hash/)
    assert.equal((await readRegisteredInflow(db, { ...range, start: '2026-10-02', end: '2026-10-02' })).total, 1,
      'earliest completed phone outside the range prevents a later cross-source recount')
    assert.equal((await readRegisteredInflow(db, { ...range, start: '2026-10-10', end: today })).total, 0,
      'firstSeenAt and delivered time never replace the inquiry date')
    const history = selectDashboardHistory(null, null, parseDashboardQuery(new URLSearchParams(`start=${today}&end=${today}`), new Date(today)), null, [], false, new Date(today))
    assert.equal(history.days[0].view, null)
    assert.deepEqual((await readRegisteredInflow(db, history)).days, [{ date: today, count: 0 }], 'local zero is independent of missing external visits')
    assert.equal((await readRegisteredInflow(db, { start: null, end: null, today })).start, '2026-10-01')
    await db.inquiry.delete({ where: { id: first.id } })
    assert.equal((await readRegisteredInflow(db, { ...range, end: range.start })).total, 0, 'deleted inquiry is not kept in a hidden identity store')
    assert.equal((await readRegisteredInflow(db, { ...range, start: '2026-10-02', end: '2026-10-02' })).total, 2,
      'deduplication is based only on currently retained completed inquiries')
    await db.inquiry.deleteMany({ where: deliveryScopes })
    const empty = await readRegisteredInflow(db, { start: null, end: null, today })
    assert.deepEqual(empty, { start: today, end: today, total: 0, days: [{ date: today, count: 0 }] })
    await add({ inquiryDate: '2024-01-01', phone: '01077770000' })
    await add({ inquiryDate: today, phone: '+821077770000' })
    const bounded = await readRegisteredInflow(db, { start: null, end: null, today })
    assert.equal(bounded.days.length, 366)
    assert.equal(bounded.total, 0, 'default 366-day clamp still deduplicates against older completion')
    assert.deepEqual(bounded.days.map(day => day.date), dashboardDates(bounded.start, today))
    assert.throws(() => parseDashboardQuery(new URLSearchParams('start=2024-01-01&end=2026-10-13'), new Date(today)), /dashboard_invalid_range/)
  })
  console.log('Registered inflow passed: completed states, both exact scopes, global normalized-phone deduplication, inquiry dates, invalid data, zero/missing, bounded defaults, read-only/PII-free and deletion semantics')
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
