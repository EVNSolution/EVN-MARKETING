import { randomUUID } from 'node:crypto'
import type { Browser, Page } from 'playwright-core'
import type { PrismaClient } from '@/app/generated/prisma/client'
import {
  INQUIRY_SCOPE_ID,
  INQUIRY_START_DATE,
  SyncError,
  type ReconcileResult,
  type SourcePage,
} from '@/lib/inquiry-sync'

const POLL_MS = 15_000
const LOGIN_BACKOFF_MS = [1_000, 5_000, 15_000, 60_000]
const LOGIN_COOLDOWN_MS = 5 * 60_000
const SOURCE_BLOCKED_STATUSES = ['login_required', 'credentials_invalid', 'credentials_missing', 'source_credentials_incomplete', 'source_credentials_missing', 'login_retry_exhausted']

type Credentials = { username: string, password: string }

export type WorkerDependencies = {
  createPrisma: () => PrismaClient
  ensureSyncState: (db: PrismaClient) => Promise<unknown>
  recoverStaleRuns: (db: PrismaClient) => Promise<unknown>
  claimWorker: (db: PrismaClient, owner: string) => Promise<boolean>
  heartbeatWorker: (db: PrismaClient, owner: string) => Promise<unknown>
  releaseWorker: (db: PrismaClient, owner: string, now?: Date, status?: string) => Promise<unknown>
  enqueueSync: (db: PrismaClient, trigger: 'hourly') => Promise<unknown>
  claimNextRun: (db: PrismaClient, now: Date, owner: string, endDate: string, signal?: AbortSignal) => Promise<{
    id: string
    owner: string
    rangeStart: string
    rangeEnd: string
  } | null>
  reconcile: (
    db: PrismaClient,
    runId: string,
    owner: string,
    rangeStart: string,
    rangeEnd: string,
    fetchPage: (page: number, previousFirstPageIds?: string[]) => Promise<SourcePage>,
    now?: () => Date,
    signal?: AbortSignal,
  ) => Promise<ReconcileResult>
  finishRun: (db: PrismaClient, runId: string, owner: string, result: ReconcileResult) => Promise<unknown>
  dispatchPendingWarp: (db: PrismaClient, owner: string, signal?: AbortSignal) => Promise<unknown>
  launchSourceBrowser: () => Promise<{ browser: Browser, page: Page }>
  openLogin: (page: Page) => Promise<unknown>
  prepareProtectedPage: (page: Page, startDate: string, endDate: string) => Promise<boolean>
  automaticLogin: (page: Page, credentials: Credentials) => Promise<boolean>
  readSourceCredentials: () => Promise<Credentials | null>
  readSourcePage: (page: Page, startDate: string, endDate: string, pageNumber: number, previousFirstPageIds?: string[]) => Promise<SourcePage>
  koreaDate: () => string
}

type WorkerOptions = {
  enabled: boolean
  signal: AbortSignal
  dependencies: WorkerDependencies
  owner?: string
  wait?: (ms: number, signal: AbortSignal) => Promise<void>
  log?: (code: string) => void
}

export function collectorEnabled(value = process.env.INQUIRY_COLLECTOR_ENABLED) {
  return value === 'true'
}

export async function runInquiryWorker({
  enabled,
  signal,
  dependencies: deps,
  owner = randomUUID(),
  wait = abortableWait,
  log = (code) => console.error(code),
}: WorkerOptions) {
  if (!enabled) {
    log('collector_disabled')
    return 0
  }
  if (signal.aborted) return 0

  let prisma: PrismaClient | undefined
  let browser: Browser | undefined
  let claimed = false
  let terminalStatus = 'offline'
  let loginFailures = 0
  let collecting = false
  let exitCode = 0
  let browserClosing: Promise<void> | undefined
  const closeBrowser = () => (browserClosing ??= browser?.close())
  const stopBrowser = () => {
    // A collection owns its browser until the active page and run result are saved.
    if (!collecting) void closeBrowser()?.catch(() => {})
  }
  signal.addEventListener('abort', stopBrowser, { once: true })

  try {
    prisma = deps.createPrisma()
    await deps.ensureSyncState(prisma)
    if (signal.aborted) throw new SyncError('interrupted')
    await deps.recoverStaleRuns(prisma)
    if (signal.aborted) throw new SyncError('interrupted')
    if (!(await deps.claimWorker(prisma, owner))) throw new SyncError('worker_already_running')
    claimed = true
    if (signal.aborted) throw new SyncError('interrupted')

    const launched = await deps.launchSourceBrowser()
    browser = launched.browser
    if (signal.aborted) throw new SyncError('interrupted')
    await deps.openLogin(launched.page)

    while (!signal.aborted) {
      if (!browser.isConnected()) throw new SyncError('browser_disconnected')
      try {
        await deps.heartbeatWorker(prisma, owner)
        if (signal.aborted) break
        await deps.recoverStaleRuns(prisma)
        if (signal.aborted) break
        await deps.dispatchPendingWarp(prisma, owner, signal)
        if (signal.aborted) break

        if (!(await deps.prepareProtectedPage(launched.page, INQUIRY_START_DATE, deps.koreaDate()))) {
          if (signal.aborted) break
          await setStatus(prisma, owner, 'login_required')
          if (signal.aborted) break
          let credentials: Credentials | null
          try {
            credentials = await deps.readSourceCredentials()
          } catch (error) {
            terminalStatus = errorCode(error, 'credentials_missing')
            await setStatus(prisma, owner, terminalStatus)
            const blocked = await holdBlocked(prisma, owner, browser, launched.page, signal, deps, wait, log)
            if (blocked === 'stopped') break
            terminalStatus = 'offline'
            loginFailures = 0
            await setStatus(prisma, owner, 'offline')
            continue
          }
          if (signal.aborted) break
          if (!credentials) {
            terminalStatus = 'credentials_missing'
            await setStatus(prisma, owner, terminalStatus)
            const blocked = await holdBlocked(prisma, owner, browser, launched.page, signal, deps, wait, log)
            if (blocked === 'stopped') break
            terminalStatus = 'offline'
            loginFailures = 0
            await setStatus(prisma, owner, 'offline')
            continue
          }

          let loggedIn: boolean
          try {
            loggedIn = await deps.automaticLogin(launched.page, credentials)
          } catch (error) {
            if (isLeaseError(error)) throw error
            if (signal.aborted) break
            log(errorCode(error))
            loginFailures++
            if (loginFailures >= LOGIN_BACKOFF_MS.length) {
              terminalStatus = 'login_retry_exhausted'
              await setStatus(prisma, owner, terminalStatus)
              const cooldownResult = await cooldown(prisma, owner, browser, launched.page, signal, deps, wait, log)
              if (cooldownResult === 'stopped') break
              loginFailures = 0
              terminalStatus = 'offline'
              await setStatus(prisma, owner, cooldownResult === 'recovered' ? 'offline' : 'login_required')
              continue
            }
            await wait(LOGIN_BACKOFF_MS[loginFailures - 1], signal)
            continue
          }
          if (!loggedIn) {
            terminalStatus = 'credentials_invalid'
            await setStatus(prisma, owner, terminalStatus)
            const blocked = await holdBlocked(prisma, owner, browser, launched.page, signal, deps, wait, log)
            if (blocked === 'stopped') break
            terminalStatus = 'offline'
            loginFailures = 0
            await setStatus(prisma, owner, 'offline')
            continue
          }
          loginFailures = 0
          await setStatus(prisma, owner, 'offline')
          if (signal.aborted) break
        } else {
          await prisma.inquirySyncState.updateMany({
            where: { id: INQUIRY_SCOPE_ID, workerOwner: owner, status: { in: SOURCE_BLOCKED_STATUSES } },
            data: { status: 'offline' },
          })
        }

        if (signal.aborted) break
        const state = await prisma.inquirySyncState.findUniqueOrThrow({ where: { id: INQUIRY_SCOPE_ID } })
        if (signal.aborted) break
        if (!state.nextRunAt || state.nextRunAt <= new Date()) await deps.enqueueSync(prisma, 'hourly')
        if (signal.aborted) break
        const claimedRun = await deps.claimNextRun(prisma, new Date(), owner, deps.koreaDate(), signal)
        if (!claimedRun) {
          await wait(POLL_MS, signal)
          continue
        }
        collecting = true
        const result = await deps.reconcile(
          prisma,
          claimedRun.id,
          claimedRun.owner,
          claimedRun.rangeStart,
          claimedRun.rangeEnd,
          (pageNumber, previousFirstPageIds) => deps.readSourcePage(
            launched.page,
            claimedRun.rangeStart,
            claimedRun.rangeEnd,
            pageNumber,
            previousFirstPageIds,
          ),
          undefined,
          signal,
        )
        if (result.errorType === 'lost_lease' || result.errorType === 'lost_worker_lease') throw new SyncError(result.errorType)
        if (signal.aborted) {
          result.status = 'partial'
          result.errorType = 'interrupted'
        }
        await deps.finishRun(prisma, claimedRun.id, claimedRun.owner, result)
        collecting = false
      } catch (error) {
        if (collecting || (signal.aborted && isLeaseError(error))) throw error
        if (signal.aborted) {
          if (errorCode(error) === 'page_error' || errorCode(error) === 'browser_disconnected') break
          throw error
        }
        if (!browser.isConnected()) throw new SyncError('browser_disconnected')
        const code = errorCode(error)
        log(code)
        if (code === 'lost_worker_lease' || code === 'lost_lease') {
          if (await deps.claimWorker(prisma, owner)) {
            await deps.recoverStaleRuns(prisma)
            continue
          }
          throw new SyncError(code)
        }
        await wait(POLL_MS, signal)
      }
    }
  } catch (error) {
    const code = errorCode(error)
    if (!(signal.aborted && !collecting && ['interrupted', 'page_error', 'browser_disconnected'].includes(code))) {
      if (terminalStatus === 'offline' || code === 'browser_disconnected' || isLeaseError(error)) terminalStatus = code
      log(terminalStatus)
      exitCode = 1
    }
  } finally {
    signal.removeEventListener('abort', stopBrowser)
    await closeBrowser()?.catch(() => { log('browser_close_failed'); exitCode = 1 })
    if (prisma) {
      if (claimed) await deps.releaseWorker(prisma, owner, new Date(), terminalStatus).catch(() => { log('worker_release_failed'); exitCode = 1 })
      await prisma.$disconnect().catch(() => { log('worker_disconnect_failed'); exitCode = 1 })
    }
  }
  return exitCode
}

function isLeaseError(error: unknown) {
  return error instanceof SyncError && (error.type === 'lost_lease' || error.type === 'lost_worker_lease')
}

async function setStatus(prisma: PrismaClient, owner: string, status: string) {
  await prisma.inquirySyncState.updateMany({
    where: { id: INQUIRY_SCOPE_ID, workerOwner: owner },
    data: { status },
  })
}

function errorCode(error: unknown, fallback = 'worker_error') {
  if (error instanceof SyncError && (/^[a-z][a-z0-9_]*$/.test(error.type) || /^offline_ERR_[A-Z0-9_]+$/.test(error.type))) return error.type
  if (error instanceof Error && (error.message === 'source_credentials_incomplete' || error.message === 'source_credentials_missing')) return error.message
  return fallback
}

async function holdBlocked(
  prisma: PrismaClient,
  owner: string,
  browser: Browser,
  page: Page,
  signal: AbortSignal,
  deps: WorkerDependencies,
  wait: (ms: number, signal: AbortSignal) => Promise<void>,
  log: (code: string) => void,
) {
  while (!signal.aborted) {
    if (!browser.isConnected()) throw new SyncError('browser_disconnected')
    await deps.dispatchPendingWarp(prisma, owner, signal).catch((error) => {
      if (signal.aborted || isLeaseError(error)) throw error
      log(errorCode(error))
    })
    if (signal.aborted) break
    if (await protectedPageReady(page, deps, log)) return signal.aborted ? 'stopped' as const : 'recovered' as const
    await wait(POLL_MS, signal)
    if (!signal.aborted) await deps.heartbeatWorker(prisma, owner)
  }
  return 'stopped' as const
}

async function cooldown(
  prisma: PrismaClient,
  owner: string,
  browser: Browser,
  page: Page,
  signal: AbortSignal,
  deps: WorkerDependencies,
  wait: (ms: number, signal: AbortSignal) => Promise<void>,
  log: (code: string) => void,
) {
  for (let elapsed = 0; elapsed < LOGIN_COOLDOWN_MS && !signal.aborted; elapsed += POLL_MS) {
    if (!browser.isConnected()) throw new SyncError('browser_disconnected')
    await deps.dispatchPendingWarp(prisma, owner, signal).catch((error) => {
      if (signal.aborted || isLeaseError(error)) throw error
      log(errorCode(error))
    })
    if (signal.aborted) break
    if (await protectedPageReady(page, deps, log)) return signal.aborted ? 'stopped' as const : 'recovered' as const
    await wait(POLL_MS, signal)
    if (!signal.aborted) await deps.heartbeatWorker(prisma, owner)
  }
  return signal.aborted ? 'stopped' as const : 'expired' as const
}

async function protectedPageReady(page: Page, deps: WorkerDependencies, log: (code: string) => void) {
  try {
    return await deps.prepareProtectedPage(page, INQUIRY_START_DATE, deps.koreaDate())
  } catch (error) {
    if (isLeaseError(error)) throw error
    log(errorCode(error))
    return false
  }
}

function abortableWait(ms: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
  })
}
