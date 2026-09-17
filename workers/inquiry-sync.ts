import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { createPrisma } from '@/lib/db'
import {
  INQUIRY_SCOPE_ID,
  INQUIRY_START_DATE,
  SyncError,
  claimNextRun,
  claimWorker,
  enqueueSync,
  ensureSyncState,
  finishRun,
  heartbeatWorker,
  koreaDate,
  reconcile,
  recoverStaleRuns,
  releaseWorker,
} from '@/lib/inquiry-sync'
import { automaticLogin, launchSourceBrowser, openLogin, prepareProtectedPage, readSourcePage } from './mleverage-source'
import { readSourceCredentials } from './source-credentials'
import { dispatchPendingWarp } from '@/lib/warp-delivery'

const POLL_MS = 15_000

async function main() {
  // Reject missing Linux credentials before opening the database or browser.
  if (process.platform !== 'darwin') await readSourceCredentials()
  const prisma = createPrisma()
  await ensureSyncState(prisma)
  await recoverStaleRuns(prisma)
  const workerOwner = randomUUID()
  if (!(await claimWorker(prisma, workerOwner))) {
    await prisma.$disconnect()
    throw new SyncError('worker_already_running')
  }
  const { browser, page } = await launchSourceBrowser().catch(async (error) => {
    await releaseWorker(prisma, workerOwner)
    await prisma.$disconnect()
    throw error
  })
  process.once('SIGINT', () => void browser.close())
  process.once('SIGTERM', () => void browser.close())
  await openLogin(page).catch(async (error) => {
    await browser.close()
    await releaseWorker(prisma, workerOwner)
    await prisma.$disconnect()
    throw error
  })
  await prisma.inquirySyncState.updateMany({
    where: { id: INQUIRY_SCOPE_ID, workerOwner },
    data: { status: 'login_required', nextRunAt: null },
  })
  let automaticLoginAttempted = false

  while (browser.isConnected()) {
    try {
      await heartbeatWorker(prisma, workerOwner)
      await recoverStaleRuns(prisma)
      await dispatchPendingWarp(prisma, workerOwner)
      const state = await prisma.inquirySyncState.findUniqueOrThrow({ where: { id: INQUIRY_SCOPE_ID } })
      if (state.status === 'login_required') {
        if (!automaticLoginAttempted) {
          automaticLoginAttempted = true
          const credentials = await readSourceCredentials().catch(() => null)
          if (credentials) await automaticLogin(page, credentials)
        }
        if (!(await prepareProtectedPage(page, INQUIRY_START_DATE, koreaDate()))) {
          await wait(POLL_MS)
          continue
        }
        automaticLoginAttempted = false
        await prisma.inquirySyncState.updateMany({
          where: { id: INQUIRY_SCOPE_ID, workerOwner },
          data: { status: 'offline', nextRunAt: new Date(0) },
        })
      }

      const refreshed = await prisma.inquirySyncState.findUniqueOrThrow({ where: { id: INQUIRY_SCOPE_ID } })
      if (!refreshed.nextRunAt || refreshed.nextRunAt <= new Date()) await enqueueSync(prisma, 'hourly')
      const claimed = await claimNextRun(prisma, new Date(), workerOwner, koreaDate())
      if (!claimed) {
        await wait(POLL_MS)
        continue
      }
      const result = await reconcile(
        prisma,
        claimed.id,
        claimed.owner,
        claimed.rangeStart,
        claimed.rangeEnd,
        (pageNumber, previousFirstPageIds) => readSourcePage(page, claimed.rangeStart, claimed.rangeEnd, pageNumber, previousFirstPageIds),
      )
      await finishRun(prisma, claimed.id, claimed.owner, result)
    } catch (error) {
      // Keep errors code-only: browser and database payloads may contain customer data.
      console.error(error instanceof SyncError ? error.type : 'worker_error')
      if (error instanceof SyncError && (error.type === 'lost_worker_lease' || error.type === 'lost_lease')) {
        if (await claimWorker(prisma, workerOwner)) {
          await recoverStaleRuns(prisma)
          continue
        }
        await browser.close()
        break
      }
      await wait(POLL_MS)
    }
  }
  await releaseWorker(prisma, workerOwner).catch(() => {})
  await prisma.$disconnect()
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

main().catch((error) => {
  console.error(error instanceof SyncError ? error.type : 'worker_error')
  process.exitCode = 1
})
