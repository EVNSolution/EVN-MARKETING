import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Page } from 'playwright-core'
import { dashboardPercentages, dashboardResponseBody, dashboardTotals, parseDashboard } from '@/lib/external-dashboard'
import { readDashboardRecord, saveDashboardRecord } from '@/lib/external-dashboard-store'
import { dashboardResponseKind, dashboardUrl, readExternalDashboard } from '@/workers/mleverage-dashboard'
import { INQUIRY_HOMEPAGE_ID, INQUIRY_SCOPE_ID, claimWorker } from '@/lib/inquiry-sync'
import { uploadResponse } from '@/lib/upload-security'
import { withWorkerDatabase } from './worker-runtime-helper'

const overview = {
  aggregationDates: ['2026-09-11', '2026-09-12'],
  monthlyViews: [{ date: '2026-09-11', pageViewCount: 20, visitorCount: 10 }, { date: '2026-09-12', pageViewCount: 30, visitorCount: 15 }],
  todayVisitorCount: 9876, todayClickCount: 8765, todayConversionCount: 7654,
}
const acquisition = {
  monthlyAdViews: [{ date: '2026-09-11', media: '당근', count: 8 }, { date: '2026-09-12', media: '네이버', count: 9 }],
  monthlyInflows: [{ source: '합성 네트워크', count: 123 }, { source: '다른 네트워크', count: 77 }],
  monthlyKeywords: Array.from({ length: 712 }, (_, i) => ({ keyword: `합성 키워드 ${i + 1}`, count: 1 })),
}
const data = parseDashboard(overview, acquisition)
assert.deepEqual(dashboardTotals(data), { visitors: 25, pageviews: 50 })
assert.equal(data.monthlyKeywords.length, 712)
assert.equal(data.monthlyKeywords.at(-1)?.keyword, '합성 키워드 712')
assert.equal('todayConversionCount' in data, false, 'unverified hidden metrics never become display data')
assert.equal(data.monthlyInflows.reduce((sum, row) => sum + row.count, 0), 200, 'ranking denominator stays independent')
assert.deepEqual(dashboardPercentages([1, 1, 1]), [33.4, 33.3, 33.3])
assert.deepEqual(dashboardPercentages([25950, 2599, 1037, 611, 176, 170, 64, 6, 3, 3]), [84.7, 8.5, 3.4, 2, 0.6, 0.6, 0.2, 0, 0, 0])
assert.equal(dashboardPercentages(acquisition.monthlyKeywords.map(row => row.count)).reduce((sum, share) => sum + Math.round(share * 10), 0), 1000)
assert.deepEqual(dashboardTotals(parseDashboard({ monthlyViews: [] }, { monthlyAdViews: [], monthlyInflows: [], monthlyKeywords: [] })), { visitors: null, pageviews: null })
for (const invalid of [null, {}, { ...overview, monthlyViews: [{ date: '2026-09-11', pageViewCount: null, visitorCount: 0 }] }, { ...overview, aggregationDates: ['2026-09-13'] }, { monthlyViews: [{ date: '2026-02-30', pageViewCount: 1, visitorCount: 1 }] }]) assert.throws(() => parseDashboard(invalid, acquisition), /dashboard_invalid_data/)
assert.throws(() => parseDashboard(overview, { ...acquisition, monthlyKeywords: undefined }), /dashboard_invalid_data/)
assert.throws(() => dashboardResponseBody({ result: { success: false, code: 'ERR-AUT001' } }), /dashboard_login_required/)

const api = `https://app.mleverage-admin.co.kr/maus/api/homepages/${INQUIRY_HOMEPAGE_ID}/dashboard/`
assert.equal(dashboardResponseKind(`${api}overview`, 'GET'), 'overview')
for (const url of [`${api}overview?startDate=2026-01-01`, api.replace(INQUIRY_HOMEPAGE_ID, 'foreign') + 'overview', api.replace('app.', 'untrusted.') + 'overview']) assert.equal(dashboardResponseKind(url, 'GET'), null)
assert.equal(dashboardResponseKind(`${api}overview`, 'POST'), null)

async function readerTest(mode: 'success' | 'login' | 'partial' | 'abort') {
  const controller = new AbortController()
  const page = new EventEmitter() as EventEmitter & { goto: () => Promise<void>; url: () => string; close: () => Promise<void> }
  let closed = 0
  page.url = () => mode === 'login' ? 'https://app.mleverage-admin.co.kr/login' : dashboardUrl
  page.close = async () => { closed++ }
  page.goto = async () => {
    if (mode === 'abort') { controller.abort(); return }
    if (mode === 'login') return
    for (const kind of ['overview', 'acquisition']) page.emit('response', {
      url: () => `${api}${kind}`, request: () => ({ method: () => 'GET' }), status: () => 200, ok: () => true, headers: () => ({}),
      body: async () => Buffer.from(JSON.stringify({ result: { success: true }, body: kind === 'overview' ? overview : mode === 'partial' ? {} : acquisition })),
    })
  }
  const authenticated = { context: () => ({ newPage: async () => page }) } as unknown as Page
  if (mode === 'success') assert.deepEqual(await readExternalDashboard(authenticated, controller.signal), data)
  else await assert.rejects(readExternalDashboard(authenticated, controller.signal), new RegExp(mode === 'login' ? 'dashboard_login_required' : mode === 'abort' ? 'dashboard_interrupted' : 'dashboard_invalid_data'))
  assert.ok(closed > 0)
  assert.equal(page.listenerCount('response'), 0)
}

async function main() {
  for (const mode of ['success', 'login', 'partial', 'abort'] as const) await readerTest(mode)
  await withWorkerDatabase(async (db) => {
    const root = await mkdtemp(path.join(tmpdir(), 'dashboard-synthetic-'))
    const env = { UPLOADS_DIR: root }
    try {
      assert.equal(await readDashboardRecord(env), null)
      await claimWorker(db, 'synthetic-dashboard')
      const first = await saveDashboardRecord(db, 'synthetic-dashboard', { data }, env)
      assert.deepEqual((await readDashboardRecord(env))?.data, data)
      const failed = await saveDashboardRecord(db, 'synthetic-dashboard', { error: 'dashboard_invalid_data' }, env)
      assert.deepEqual(failed.data, data)
      assert.equal(failed.lastSuccessfulAt, first.lastSuccessfulAt)
      const file = path.join(root, '_reports/external-dashboard/current.json')
      const before = await readFile(file, 'utf8')
      await assert.rejects(saveDashboardRecord(db, 'foreign-owner', { data }, env), /lost_worker_lease/)
      assert.equal(await readFile(file, 'utf8'), before)
      assert.deepEqual(await readdir(path.dirname(file)), ['current.json'])
      assert.equal((await uploadResponse(root, ['_reports', 'external-dashboard', 'current.json'], false)).status, 401)
      assert.equal((await uploadResponse(root, ['_reports', 'external-dashboard', 'current.json'], true)).status, 404)
      // Readers see either complete record during replacement, never truncated JSON.
      await Promise.all([saveDashboardRecord(db, 'synthetic-dashboard', { data }, env), ...Array.from({ length: 20 }, () => readDashboardRecord(env))])
      assert.equal((await readDashboardRecord(env))?.error, null)
      await db.inquirySyncState.update({ where: { id: INQUIRY_SCOPE_ID }, data: { workerLeaseExpiresAt: new Date(0) } })
      await assert.rejects(saveDashboardRecord(db, 'synthetic-dashboard', { data }, env), /lost_worker_lease/)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  console.log('external dashboard tests passed: full rankings, independent metrics, source scope, read-only reader, failure retention, lease fencing, atomic writes and upload privacy')
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
