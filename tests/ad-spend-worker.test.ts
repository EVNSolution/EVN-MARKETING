import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { collectNaverAdSpend, naverSpendRanges } from '@/workers/ad-spend-sync'
import { emptyAdSpend } from '@/lib/ad-spend'
import { readAdSpend } from '@/lib/ad-spend-store'
import { claimWorker, ensureSyncState, INQUIRY_SCOPE_ID } from '@/lib/inquiry-sync'
import { withWorkerDatabase } from './worker-runtime-helper'
import { NAVER_CUSTOMER_ID } from '@/lib/ad-spend-config'
import { dashboardDates } from '@/lib/external-dashboard-history'
import type { fetchNaverDailyStats } from '@/lib/naver-ad-spend'
const ranges = naverSpendRanges(emptyAdSpend(), '2027-02-01')
assert.equal(ranges.length, 2)
assert.ok(ranges.every(r => dashboardDates(r.start, r.end).length <= 92))
assert.ok(ranges[0].end < ranges[1].start, 'repair and recent ranges never overlap')
assert.deepEqual(naverSpendRanges(emptyAdSpend(), '2026-10-13'), [{ start: '2026-09-11', end: '2026-10-13' }])
async function main() {
  for (const mode of ['success', 'failure', 'drain', 'gate', 'lost', 'disabled'] as const) await withWorkerDatabase(async (db, inspect) => {
    const root = await mkdtemp(path.join(tmpdir(), 'ads-worker-synthetic-'))
    const env = { UPLOADS_DIR: root, NAVER_AD_SPEND_ENABLED: mode === 'disabled' ? 'false' : 'true', NAVER_AD_API_KEY: 'synthetic', NAVER_AD_SECRET_KEY: 'synthetic' }
    try {
      await ensureSyncState(db); await claimWorker(db, 'ads-owner')
      const controller = new AbortController(); let calls = 0, allowed = true
      const request: typeof fetchNaverDailyStats = async scope => {
        calls++; assert.equal(scope.customerId, NAVER_CUSTOMER_ID)
        if (mode === 'failure') throw new Error('private-response')
        if (mode === 'drain') controller.abort()
        if (mode === 'gate') allowed = false
        if (mode === 'lost') await inspect.inquirySyncState.update({ where: { id: INQUIRY_SCOPE_ID }, data: { workerOwner: 'new-owner' } })
        return { provider: 'naver', accountId: scope.customerId, campaignId: scope.campaignId, start: scope.start, end: scope.end,
          rows: dashboardDates(scope.start, scope.end).map(date => ({ date, campaignId: scope.campaignId, amount: '10', vat: 'included' })) }
      }
      const now = new Date('2026-10-13T00:00:00.000Z')
      const run = () => collectNaverAdSpend(db, 'ads-owner', controller.signal, env, request, now, async () => allowed)
      if (['drain', 'gate', 'lost'].includes(mode)) { await assert.rejects(run()); assert.equal((await readAdSpend(env)).rows.length, 0) }
      else {
        await run()
        const record = await readAdSpend(env)
        if (mode === 'disabled') assert.equal(calls, 0)
        else {
          assert.equal(record.rows.length, 99)
          assert.equal(record.rows[0].amount, mode === 'failure' ? null : '10')
          const before = calls; await run(); assert.equal(calls, before, 'hourly cadence survives persisted last attempt')
          if (mode === 'success') {
            await collectNaverAdSpend(db, 'ads-owner', controller.signal, env, request, new Date(now.getTime() + 3_600_000), async () => allowed)
            assert.equal(calls, 6); assert.equal((await readAdSpend(env)).rows.length, 99)
          }
        }
      }
      assert.equal(await inspect.inquirySyncRun.count(), 0, 'ad collection never creates or changes inquiry runs')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  console.log('Ad worker passed: opt-in, three explicit campaigns, first backfill/recent repair/92-day bounds, hourly retries, failure retention, lease/gate/drain fencing, inquiry isolation')
}
void main()
