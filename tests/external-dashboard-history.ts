import assert from 'node:assert/strict'
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { PrismaClient } from '@/app/generated/prisma/client'
import { dashboardTotals, parseDashboard, type DashboardRecord } from '@/lib/external-dashboard'
import { dashboardKoreaDate, parseDashboardQuery } from '@/lib/external-dashboard-history'
import { readDashboardHistory, readDashboardRecord, saveDashboardRecord } from '@/lib/external-dashboard-store'
import { claimWorker, INQUIRY_COMPANY_ID, INQUIRY_HOMEPAGE_ID, INQUIRY_SCOPE_ID } from '@/lib/inquiry-sync'
import { uploadResponse } from '@/lib/upload-security'
import { withWorkerDatabase } from './worker-runtime-helper'

const fixedNow = new Date('2026-10-12T00:00:00.000Z')
const sample = (date: string, count: number, media = true) => parseDashboard({
  aggregationDates: [date], monthlyViews: [{ date, visitorCount: count, pageViewCount: count * 2 }],
}, { monthlyAdViews: media ? [{ date, media: '구글', count }] : [], monthlyInflows: [{ source: '기간 집계', count: 999 }], monthlyKeywords: [{ keyword: '기간 키워드', count: 333 }] })

export async function testDashboardHistory() {
  assert.equal(dashboardKoreaDate(new Date('2026-10-08T14:59:59Z')), '2026-10-08')
  assert.equal(dashboardKoreaDate(new Date('2026-10-08T15:00:00Z')), '2026-10-09')
  for (const query of ['start=2026-02-30&end=2026-03-01', 'start=2026-10-09', 'start=2026-10-10&end=2026-10-09', 'start=2020-01-01&end=2026-10-09', 'snapshot=../../current', 'start=2026-10-13&end=2026-10-13', 'snapshot=2026-10-09&snapshot=2026-10-08', 'file=current.json']) {
    assert.throws(() => parseDashboardQuery(new URLSearchParams(query), fixedNow), /dashboard_invalid_range/)
  }
  assert.deepEqual(parseDashboardQuery(new URLSearchParams('start=2026-10-09&end=2026-10-09'), fixedNow), { start: '2026-10-09', end: '2026-10-09' })
  await withWorkerDatabase(async db => {
    const root = await mkdtemp(path.join(tmpdir(), 'dashboard-history-'))
    const env = { UPLOADS_DIR: root }, owner = 'history-test'
    const folder = path.join(root, '_reports/external-dashboard'), current = path.join(folder, 'current.json'), ledger = path.join(folder, 'history.json')
    const query = (start = '2026-10-08', end = '2026-10-10', snapshot?: string) => readDashboardHistory({ start, end, snapshot }, env, fixedNow)
    try {
      await mkdir(folder, { recursive: true })
      const legacy: DashboardRecord = { format: 1, source: 'mleverage-admin', companyScopeId: INQUIRY_COMPANY_ID, homepageScopeId: INQUIRY_HOMEPAGE_ID,
        lastAttemptAt: '2026-10-09T00:00:00.000Z', lastSuccessfulAt: '2026-10-08T01:00:00.000Z', error: 'dashboard_timeout', data: sample('2026-10-08', 4) }
      await writeFile(current, JSON.stringify(legacy))
      await writeFile(path.join(folder, 'preserved-20261009.json'), JSON.stringify({ ...legacy,
        lastAttemptAt: '2026-10-07T01:00:00.000Z', lastSuccessfulAt: '2026-10-07T01:00:00.000Z', error: null, data: sample('2026-09-11', 2) }))
      assert.equal((await query()).history.days[0].view?.visitorCount, 4, 'format1 is immediately readable without a writer')
      assert.deepEqual((await readdir(folder)).sort(), ['current.json', 'preserved-20261009.json'], 'GET bootstrap is read-only')
      assert.equal((await query('2026-09-11', '2026-09-11')).history.days[0].view?.visitorCount, 2, 'operator-preserved format1 can predate the rolling current')
      await claimWorker(db, owner)
      await db.inquirySyncState.update({ where: { id: INQUIRY_SCOPE_ID }, data: { workerLeaseExpiresAt: new Date('2099-01-01') } })
      await saveDashboardRecord(db, owner, { data: sample('2026-10-09', 10) }, env, new Date('2026-10-09T01:00:00.000Z'))
      assert.equal((await readDashboardRecord(env))?.format, 1, 'rollback reader remains compatible')
      assert.equal((await readDashboardRecord(env))?.data?.monthlyViews.length, 1)
      let result = await query()
      assert.deepEqual(dashboardTotals(result.history.data), { visitors: 14, pageviews: 28 }, 'rolling current no longer contains Oct8, but stored day survives')
      assert.deepEqual(result.history.missingDays, ['2026-10-10'])
      assert.equal(result.history.data.monthlyInflows.length, 0, 'period rankings are never assigned to the selected days')
      assert.equal(result.history.snapshot?.data?.monthlyInflows[0].count, 999)
      assert.deepEqual(result.history.snapshotDays, ['2026-10-09', '2026-10-08', '2026-10-07'], 'legacy success uses success KST day, not failure attempt day')
      assert.deepEqual((await query('2026-10-08', '2026-10-08', '2026-10-08')).history.snapshot?.data?.aggregationDates, ['2026-10-08'])
      await saveDashboardRecord(db, owner, { data: sample('2026-10-09', 3) }, env, new Date('2026-10-09T02:00:00.000Z'))
      await saveDashboardRecord(db, owner, { data: sample('2026-10-09', 3, false) }, env, new Date('2026-10-09T03:00:00.000Z'))
      result = await query()
      assert.deepEqual(dashboardTotals(result.history.data), { visitors: 7, pageviews: 14 }, 'corrections replace rather than add')
      assert.equal(result.history.days[1].media[0].count, 3, 'missing media does not erase observed data')
      assert.equal(result.history.days[1].media[0].collectedAt, '2026-10-09T02:00:00.000Z')
      await saveDashboardRecord(db, owner, { error: 'dashboard_timeout' }, env, new Date('2026-10-09T04:00:00.000Z'))
      assert.deepEqual((await query()).history.days, result.history.days, 'source errors preserve all historical values')
      const before = await readFile(ledger)
      const oversized = { ...sample('2026-10-10', 9), monthlyKeywords: Array.from({ length: 3000 }, (_, i) => ({ keyword: 'x'.repeat(1800) + i, count: 1 })) }
      await assert.rejects(saveDashboardRecord(db, owner, { data: oversized }, env, new Date('2026-10-10T00:00:00.000Z')), /dashboard_storage_error/)
      assert.deepEqual(await readFile(ledger), before, 'oversized success cannot poison the durable recovery journal')
      await assert.rejects(saveDashboardRecord(db, 'foreign', { data: sample('2026-10-10', 9) }, env), /lost_worker_lease/)
      assert.deepEqual(await readFile(ledger), before)

      // Interrupt after durable history commit but before the new collection-day archive.
      const interrupted = { $transaction: (run: (tx: unknown) => unknown, options: unknown) => db.$transaction(tx => run(new Proxy(tx, {
        get(target, key) {
          if (key !== 'inquirySyncState') return Reflect.get(target, key)
          return { ...target.inquirySyncState, findFirst: async (...args: Parameters<typeof target.inquirySyncState.findFirst>) => {
            if (JSON.parse(await readFile(ledger, 'utf8')).latest.lastSuccessfulAt === '2026-10-10T01:00:00.000Z') throw new Error('synthetic_interruption')
            return target.inquirySyncState.findFirst(...args)
          } }
        },
      })) as Promise<unknown>, options as never) } as unknown as PrismaClient
      await assert.rejects(saveDashboardRecord(interrupted, owner, { data: sample('2026-10-10', 0) }, env, new Date('2026-10-10T01:00:00.000Z')), /synthetic_interruption/)
      assert.equal((await readDashboardRecord(env))?.data?.aggregationDates[0], '2026-10-09', 'old current remains whole after interruption')
      result = await query()
      assert.equal(result.history.days[2].view?.visitorCount, 0, 'durable journal serves committed real zero before snapshot publication')
      assert.equal(result.history.snapshot?.lastSuccessfulAt, '2026-10-10T01:00:00.000Z')
      assert.ok(!(await readdir(path.join(folder, 'snapshots'))).includes('2026-10-10.json'))
      await saveDashboardRecord(db, owner, { error: 'dashboard_interrupted' }, env, new Date('2026-10-10T02:00:00.000Z'))
      assert.ok((await readdir(path.join(folder, 'snapshots'))).includes('2026-10-10.json'), 'next fenced save repairs pending daily archive')
      const concurrent = await Promise.all([saveDashboardRecord(db, owner, { data: sample('2026-10-11', 5) }, env, new Date('2026-10-11T01:00:00.000Z')),
        ...Array.from({ length: 10 }, () => query())])
      assert.equal(concurrent.length, 11)
      assert.equal((await query('2026-10-10', '2026-10-10')).history.days[0].view?.visitorCount, 0)
      assert.equal((await query('2026-10-12', '2026-10-12')).history.days[0].view, null, 'unpublished current KST day is not zero')
      await assert.rejects(query('2026-10-08', '2026-10-08', '../../current'), /dashboard_storage_error/)
      for (const file of ['history.json', 'snapshots/2026-10-09.json']) {
        assert.equal((await uploadResponse(root, ['_reports', 'external-dashboard', ...file.split('/')], true)).status, 404)
      }
      // Links, oversized files and damaged JSON fail closed and never replace good history.
      const intact = await readFile(ledger)
      await writeFile(ledger, '{broken')
      await assert.rejects(query(), /dashboard_storage_error/)
      await assert.rejects(saveDashboardRecord(db, owner, { data: sample('2026-10-11', 8) }, env), /dashboard_storage_error/)
      assert.equal(await readFile(ledger, 'utf8'), '{broken')
      await writeFile(ledger, intact)
      const hard = path.join(root, 'hard-history')
      await link(ledger, hard)
      await assert.rejects(query(), /dashboard_storage_error/)
      await rm(hard)
      await truncate(ledger, 32 * 1024 * 1024 + 1)
      await assert.rejects(query(), /dashboard_storage_error/)
      await writeFile(ledger, intact)
      if (process.platform !== 'win32') {
        await rm(ledger)
        await writeFile(hard, intact)
        await symlink(hard, ledger)
        await assert.rejects(query(), /dashboard_storage_error/)
        await rm(ledger); await writeFile(ledger, intact)
      }
      assert.equal((await query()).history.days[0].view?.visitorCount, 4)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  console.log('Dashboard history passed: legacy bootstrap, rolling retention, corrections, failure/lease/crash recovery, concurrent reads, KST/query bounds, zero/missing, ranking scope and private file guards')
}
