import 'dotenv/config'
import { collectorEnabled, runInquiryWorker, type WorkerDependencies } from './worker-runtime'

async function main() {
  const enabled = collectorEnabled()
  if (!enabled) {
    console.error('collector_disabled')
    return 0
  }

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
      dispatchPendingWarp: (db, owner, signal) => warp.dispatchPendingWarp(db, owner, undefined, undefined, undefined, signal),
      launchSourceBrowser: source.launchSourceBrowser,
      openLogin: source.openLogin,
      prepareProtectedPage: source.prepareProtectedPage,
      automaticLogin: source.automaticLogin,
      readSourceCredentials: credentials.readSourceCredentials,
      readSourcePage: source.readSourcePage,
      koreaDate: sync.koreaDate,
    }
    return await runInquiryWorker({ enabled, signal: controller.signal, dependencies })
  } finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
  }
}

main().then((code) => { process.exitCode = code }).catch(() => {
  console.error('worker_error')
  process.exitCode = 1
})
