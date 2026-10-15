import 'dotenv/config'
import { collectorEnabled, runInquiryWorker, type WorkerDependencies } from './worker-runtime'
import { configuredWorkerOwner } from '@/lib/worker-health'
import { workerActivationAllowed } from './worker-activation'
import { collectExternalDashboard } from './external-dashboard-sync'
import { readDashboardRecord } from '@/lib/external-dashboard-store'
import { collectNaverAdSpend } from './ad-spend-sync'
import { dispatchNameJobs } from '@/lib/warp-customer-name'

async function main() {
  const enabled = collectorEnabled()
  if (!enabled) {
    console.error('collector_disabled')
    return 0
  }
  const owner = configuredWorkerOwner()

  const controller = new AbortController()
  const stop = () => controller.abort()
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)

  try {
    const [db, sync, source, credentials, warp] = await Promise.all([
      import('@/lib/db'),
      import('@/lib/inquiry-sync'),
      import('./mleverage-source'),
      import('./source-credentials'),
      import('@/lib/warp-delivery'),
    ])
    const dependencies: WorkerDependencies = {
      createPrisma: db.createPrisma,
      ensureSyncState: sync.ensureSyncState,
      recoverStaleRuns: sync.recoverStaleRuns,
      claimWorker: sync.claimWorker,
      heartbeatWorker: sync.heartbeatWorker,
      releaseWorker: sync.releaseWorker,
      enqueueSync: sync.enqueueSync,
      claimNextRun: sync.claimNextRun,
      reconcile: sync.reconcile,
      finishRun: sync.finishRun,
      dispatchPendingWarp: async (db, owner, signal) => {
        try { await dispatchNameJobs(db, owner, signal) } catch (error) {
          if (error instanceof sync.SyncError && error.type === 'lost_worker_lease') throw error
          if (!signal?.aborted) console.error('customer_name_review_failed')
        }
        if (!signal?.aborted) return warp.dispatchPendingWarp(db, owner, undefined, undefined, undefined, signal)
      },
      collectAdSpend: collectNaverAdSpend,
      launchSourceBrowser: source.launchSourceBrowser,
      openLogin: source.openLogin,
      prepareProtectedPage: source.prepareProtectedPage,
      automaticLogin: source.automaticLogin,
      readSourceCredentials: credentials.readSourceCredentials,
      readSourcePage: source.readSourcePage,
      markSourceManaging: source.markSourceManaging,
      collectDashboard: collectExternalDashboard,
      needsInitialDashboard: async () => !(await readDashboardRecord())?.data,
      koreaDate: sync.koreaDate,
    }
    return await runInquiryWorker({ enabled, signal: controller.signal, dependencies, owner, workAllowed: workerActivationAllowed })
  } finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
  }
}

main().then((code) => { process.exitCode = code }).catch((error) => {
  console.error(error instanceof Error && error.message === 'invalid_worker_owner' ? 'invalid_worker_owner' : 'worker_error')
  process.exitCode = 1
})
