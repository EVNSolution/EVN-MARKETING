import assert from 'node:assert/strict'
import type { PrismaClient } from '@/app/generated/prisma/client'
import {
  INQUIRY_SCOPE_ID,
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
import { runInquiryWorker, type WorkerDependencies } from '@/workers/worker-runtime'
import { withWorkerDatabase } from './worker-runtime-helper'

type Controls = {
  connected?: boolean
  prepare?: () => Promise<boolean>
  login?: () => Promise<boolean>
  read?: WorkerDependencies['readSourcePage']
  open?: () => Promise<void>
  dispatch?: () => Promise<void>
  waits?: number[]
  closed?: () => void
}

async function main() {
  await testDisabledGate()
  await testRetryThenSuccessPreservesSchedule()
  await testExhaustionCooldownRecovery()
  await testCredentialStop()
  await testManualLoginRecovery()
  await testSessionExpiry()
  await testDisconnectedBrowser()
  await testUnavailableStartup()
  await testSignalDuringStartup()
  console.log('worker runtime tests passed')
}

async function testExhaustionCooldownRecovery() {
  await withWorkerDatabase(async (worker, inspect) => {
    await ensureSyncState(inspect)
    const scheduled = new Date(Date.now() + 60 * 60_000)
    await inspect.inquirySyncState.update({ where: { id: INQUIRY_SCOPE_ID }, data: { nextRunAt: scheduled } })
    const controller = new AbortController()
    let attempts = 0
    let credentialReads = 0
    let cooldownTicks = 0
    let heartbeats = 0
    let deliveries = 0
    const deps = dependencies(worker, {
      login: async () => {
        attempts++
        if (attempts <= 4) throw new SyncError('page_error')
        controller.abort()
        return true
      },
      dispatch: async () => { deliveries++ },
    })
    const readCredentials = deps.readSourceCredentials
    deps.readSourceCredentials = async () => {
      credentialReads++
      return readCredentials()
    }
    const renewHeartbeat = deps.heartbeatWorker
    deps.heartbeatWorker = async (...args) => {
      heartbeats++
      return renewHeartbeat(...args)
    }
    const wait = async (ms: number) => {
      if (attempts === 4) {
        assert.equal(ms, 15_000)
        assert.equal(credentialReads, 4, 'cooldown does not resubmit credentials')
        cooldownTicks++
      }
    }

    assert.equal(await runInquiryWorker({ enabled: true, signal: controller.signal, dependencies: deps, owner: 'cooldown-worker', wait, log: () => {} }), 0)
    const state = await inspect.inquirySyncState.findUniqueOrThrow({ where: { id: INQUIRY_SCOPE_ID } })
    assert.equal(cooldownTicks, 20, 'five-minute cooldown advances in 15-second synthetic ticks')
    assert.equal(attempts, 5, 'login retries after cooldown without a process restart')
    assert.equal(credentialReads, 5)
    assert.ok(heartbeats >= 25, 'heartbeat continues through cooldown')
    assert.ok(deliveries >= 25, 'queued WARP delivery continues through cooldown')
    assert.equal(state.status, 'offline')
    assert.equal(state.nextRunAt?.toISOString(), scheduled.toISOString())
    assert.equal(state.workerOwner, null)
    assert.equal(await inspect.inquirySyncRun.count(), 0)
  })
}

async function testDisabledGate() {
  let touched = false
  const code = await runInquiryWorker({
    enabled: false,
    signal: new AbortController().signal,
    dependencies: new Proxy({}, { get: () => { touched = true; throw new Error('unexpected_io') } }) as WorkerDependencies,
    log: () => {},
  })
  assert.equal(code, 0)
  assert.equal(touched, false, 'disabled collector performs no dependency access')
}

async function testRetryThenSuccessPreservesSchedule() {
  await withWorkerDatabase(async (worker, inspect) => {
    await ensureSyncState(inspect)
    const scheduled = new Date(Date.now() + 60 * 60_000)
    await inspect.inquirySyncState.update({ where: { id: INQUIRY_SCOPE_ID }, data: { nextRunAt: scheduled } })
    const controller = new AbortController()
    const waits: number[] = []
    let attempts = 0
    let ready = false
    const deps = dependencies(worker, {
      prepare: async () => ready,
      login: async () => {
        attempts++
        if (attempts === 1) throw new SyncError('page_error')
        ready = true
        controller.abort()
        return true
      },
      waits,
    })
    assert.equal(await runInquiryWorker({ enabled: true, signal: controller.signal, dependencies: deps, owner: 'retry-worker', wait: immediateWait(waits), log: () => {} }), 0)
    const state = await inspect.inquirySyncState.findUniqueOrThrow({ where: { id: INQUIRY_SCOPE_ID } })
    assert.equal(attempts, 2, 'submitted timeout retries in the same process')
    assert.deepEqual(waits, [1_000])
    assert.equal(state.nextRunAt?.toISOString(), scheduled.toISOString(), 'startup and login recovery preserve the schedule')
    assert.equal(state.workerOwner, null)
    assert.equal(await inspect.inquirySyncRun.count(), 0, 'stop after login does not claim new work')
  })
}

async function testManualLoginRecovery() {
  await withWorkerDatabase(async (worker, inspect) => {
    await ensureSyncState(inspect)
    const scheduled = new Date(Date.now() + 60 * 60_000)
    await inspect.inquirySyncState.update({ where: { id: INQUIRY_SCOPE_ID }, data: { nextRunAt: scheduled } })
    const controller = new AbortController()
    let ready = false
    let waits = 0
    let deliveries = 0
    const deps = dependencies(worker, {
      prepare: async () => ready,
      login: async () => false,
      dispatch: async () => { deliveries++ },
    })
    const wait = async () => {
      waits++
      if (waits === 1) ready = true
      else controller.abort()
    }
    assert.equal(await runInquiryWorker({ enabled: true, signal: controller.signal, dependencies: deps, owner: 'manual-worker', wait, log: () => {} }), 0)
    const state = await inspect.inquirySyncState.findUniqueOrThrow({ where: { id: INQUIRY_SCOPE_ID } })
    assert.ok(deliveries >= 2, 'blocked source login does not stop queued WARP delivery')
    assert.equal(state.status, 'offline')
    assert.equal(state.nextRunAt?.toISOString(), scheduled.toISOString())
    assert.equal(await inspect.inquirySyncRun.count(), 0)
  })
}

async function testCredentialStop() {
  await withWorkerDatabase(async (worker, inspect) => {
    const controller = new AbortController()
    let attempts = 0
    const deps = dependencies(worker, { login: async () => { attempts++; return false } })
    const stopBlocked = async () => { controller.abort() }
    assert.equal(await runInquiryWorker({ enabled: true, signal: controller.signal, dependencies: deps, owner: 'credential-worker', wait: stopBlocked, log: () => {} }), 0)
    const state = await inspect.inquirySyncState.findUniqueOrThrow({ where: { id: INQUIRY_SCOPE_ID } })
    assert.equal(attempts, 1)
    assert.equal(state.status, 'credentials_invalid')
    assert.equal(state.workerOwner, null)
    assert.equal(await enqueueSync(inspect, 'manual'), null, 'blocked credentials do not accumulate work')
  })
}

async function testSessionExpiry() {
  await withWorkerDatabase(async (worker, inspect) => {
    const controller = new AbortController()
    let ready = false
    let logins = 0
    let reads = 0
    const deps = dependencies(worker, {
      prepare: async () => ready,
      login: async () => {
        ready = true
        logins++
        if (logins === 2) controller.abort()
        return true
      },
      read: async () => {
        reads++
        ready = false
        throw new SyncError('login_required')
      },
    })
    assert.equal(await runInquiryWorker({ enabled: true, signal: controller.signal, dependencies: deps, owner: 'expiry-worker', wait: immediateWait([]), log: () => {} }), 0)
    const run = await inspect.inquirySyncRun.findFirstOrThrow()
    const state = await inspect.inquirySyncState.findUniqueOrThrow({ where: { id: INQUIRY_SCOPE_ID } })
    assert.equal(reads, 1)
    assert.equal(logins, 2, 'expired session resets login recovery')
    assert.equal(run.status, 'login_required')
    assert.ok(state.nextRunAt, 'run completion schedule survives relogin')
    assert.equal(state.workerOwner, null)
  })
}

async function testDisconnectedBrowser() {
  await withWorkerDatabase(async (worker, inspect) => {
    const deps = dependencies(worker, { connected: false })
    assert.equal(await runInquiryWorker({ enabled: true, signal: new AbortController().signal, dependencies: deps, owner: 'crash-worker', wait: immediateWait([]), log: () => {} }), 1)
    const state = await inspect.inquirySyncState.findUniqueOrThrow({ where: { id: INQUIRY_SCOPE_ID } })
    assert.equal(state.status, 'browser_disconnected')
    assert.equal(state.workerOwner, null)
  })
}

async function testUnavailableStartup() {
  await withWorkerDatabase(async (worker, inspect) => {
    const logs: string[] = []
    const deps = dependencies(worker, { open: async () => { throw new SyncError('offline_ERR_CONNECTION_REFUSED') } })
    assert.equal(await runInquiryWorker({ enabled: true, signal: new AbortController().signal, dependencies: deps, owner: 'offline-worker', wait: immediateWait([]), log: (code) => logs.push(code) }), 1)
    const state = await inspect.inquirySyncState.findUniqueOrThrow({ where: { id: INQUIRY_SCOPE_ID } })
    assert.deepEqual(logs, ['offline_ERR_CONNECTION_REFUSED'])
    assert.equal(state.status, 'offline_ERR_CONNECTION_REFUSED')
    assert.equal(state.workerOwner, null)
  })
}

async function testSignalDuringStartup() {
  await withWorkerDatabase(async (worker, inspect) => {
    const controller = new AbortController()
    let finishOpen: (() => void) | undefined
    let closed = false
    const deps = dependencies(worker, {
      open: () => new Promise<void>((resolve) => { finishOpen = resolve; setTimeout(() => controller.abort(), 0) }),
      closed: () => { closed = true; finishOpen?.() },
    })
    assert.equal(await runInquiryWorker({ enabled: true, signal: controller.signal, dependencies: deps, owner: 'signal-worker', wait: immediateWait([]), log: () => {} }), 0)
    const state = await inspect.inquirySyncState.findUniqueOrThrow({ where: { id: INQUIRY_SCOPE_ID } })
    assert.equal(closed, true)
    assert.equal(state.workerOwner, null)
  })
}

function dependencies(prisma: PrismaClient, controls: Controls = {}): WorkerDependencies {
  let connected = controls.connected ?? true
  const browser = {
    isConnected: () => connected,
    close: async () => { connected = false; controls.closed?.() },
  }
  return {
    createPrisma: () => prisma,
    ensureSyncState,
    recoverStaleRuns,
    claimWorker,
    heartbeatWorker,
    releaseWorker,
    enqueueSync,
    claimNextRun,
    reconcile,
    finishRun,
    dispatchPendingWarp: controls.dispatch ?? (async () => {}),
    launchSourceBrowser: async () => ({ browser: browser as never, page: {} as never }),
    openLogin: async () => controls.open?.(),
    prepareProtectedPage: controls.prepare ?? (async () => false),
    automaticLogin: controls.login ?? (async () => true),
    readSourceCredentials: async () => ({ username: 'synthetic-user', password: 'synthetic-password' }),
    readSourcePage: controls.read ?? (async (_page, _startDate, _endDate, pageNumber) => ({ page: pageNumber, total: 0, rows: [] })),
    koreaDate: () => koreaDate(new Date('2026-09-22T00:00:00Z')),
  }
}

function immediateWait(waits: number[]) {
  return async (ms: number) => { waits.push(ms) }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error)
  process.exitCode = 1
})
