import assert from 'node:assert/strict'
import type { PrismaClient } from '@/app/generated/prisma/client'
import {
  INQUIRY_SOURCE,
  INQUIRY_COMPANY_ID,
  INQUIRY_HOMEPAGE_ID,
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
  type SourcePage,
} from '@/lib/inquiry-sync'
import { dispatchPendingWarp, warpActivityId } from '@/lib/warp-delivery'
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
  await testDrainDuringPage()
  await testDrainAfterClaim()
  await testFinishDuringDrain()
  await testDrainDuringSend()
  await testStopAfterEnqueue()
  await testLeaseFailureDuringDrain()
  await testCleanupFailures()
  await testHealthTransitionsAndLeaseLoss()
  await testLoginRedirectIsNotReadiness()
  console.log('worker runtime tests passed')
}

async function testLoginRedirectIsNotReadiness() {
  await withWorkerDatabase(async (worker, inspect) => {
    const controller = new AbortController()
    let logins = 0
    const waits: number[] = []
    const deps = dependencies(worker, { prepare: async () => false, login: async () => {
      if (++logins === 5) controller.abort()
      return true
    } })
    const result = await runInquiryWorker({
      enabled: true, signal: controller.signal, dependencies: deps, owner: 'redirect-only', log: () => {},
      wait: async (ms) => {
        waits.push(ms)
        assert.equal((await inspect.inquirySyncState.findUniqueOrThrow({ where: { id: INQUIRY_SCOPE_ID } })).status, logins < 4 ? 'login_required' : 'login_retry_exhausted')
        assert.equal(await inspect.inquirySyncRun.count(), 0, 'unverified login does not claim a collection')
      },
    })
    assert.equal(result, 0)
    assert.equal(logins, 5)
    assert.deepEqual(waits, [1_000, 5_000, 15_000, ...Array(20).fill(15_000)], 'verification failures use bounded retries and five-minute cooldown')
  })
}

async function testHealthTransitionsAndLeaseLoss() {
  await withWorkerDatabase(async (worker, inspect) => {
    await ensureSyncState(inspect)
    const nextRunAt = new Date(Date.now() + 3_600_000)
    await inspect.inquirySyncState.update({ where: { id: INQUIRY_SCOPE_ID }, data: { status: 'success', nextRunAt } })
    const state = () => inspect.inquirySyncState.findUniqueOrThrow({ where: { id: INQUIRY_SCOPE_ID } })
    let prepares = 0
    let claims = 0
    let waits = 0
    const logs: string[] = []
    const deps = dependencies(worker, {
      open: async () => { assert.equal((await state()).status, 'starting', 'new owner must not inherit old readiness') },
      prepare: async () => {
        if (++prepares === 1) throw new SyncError('page_error')
        return true
      },
      read: async () => { throw new Error('scheduled collection must not run yet') },
    })
    deps.claimWorker = async (...args) => { claims++; return claimWorker(...args) }
    const result = await runInquiryWorker({
      enabled: true, signal: new AbortController().signal, dependencies: deps, owner: 'health-transitions', log: code => logs.push(code),
      wait: async () => {
        if (++waits === 1) assert.equal((await state()).status, 'source_error', 'source error invalidates prior readiness')
        else {
          assert.equal((await state()).status, 'ready', 'protected page recovery restores readiness')
          await inspect.inquirySyncState.update({ where: { id: INQUIRY_SCOPE_ID }, data: { workerOwner: 'replacement', status: 'starting' } })
        }
      },
    })
    assert.equal(result, 1)
    assert.equal(claims, 1, 'a fenced worker exits instead of trying to acquire again')
    assert.equal((await state()).workerOwner, 'replacement', 'former owner cannot release the replacement')
    assert.equal((await state()).nextRunAt?.getTime(), nextRunAt.getTime())
    assert.deepEqual(logs, ['page_error', 'lost_worker_lease'])
  })
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function syntheticInquiry(index: number) {
  return {
    sourceId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    inquiryDate: '2026-09-22', inquiryTime: '09:00', name: 'synthetic', phone: '010-0000-0000', sourceStatus: null,
  }
}

async function testDrainDuringPage() {
  await withWorkerDatabase(async (worker, inspect) => {
    const pending = await enqueueSync(inspect, 'manual', '2026-09-22')
    assert.ok(pending)
    const nextRunAt = new Date(Date.now() + 60 * 60_000)
    const lastSuccessfulAt = new Date(Date.now() - 60 * 60_000)
    await inspect.inquirySyncState.update({ where: { id: INQUIRY_SCOPE_ID }, data: { nextRunAt, lastSuccessfulAt } })
    const entered = deferred()
    const page = deferred<SourcePage>()
    const controller = new AbortController()
    let reads = 0
    let closed = false
    const deps = dependencies(worker, {
      prepare: async () => true,
      read: async () => { reads++; entered.resolve(); return page.promise },
      closed: () => { closed = true },
    })
    const running = runInquiryWorker({ enabled: true, signal: controller.signal, dependencies: deps, owner: 'page-drain', log: () => {} })
    await entered.promise
    controller.abort()
    assert.equal(closed, false, 'stop must not close an active collection browser')
    assert.equal(await claimWorker(inspect, 'competitor'), false, 'owner is retained while the page is in flight')
    page.resolve({ page: 1, total: 201, rows: Array.from({ length: 200 }, (_, i) => syntheticInquiry(i)) })
    assert.equal(await running, 0)
    const state = await inspect.inquirySyncState.findUniqueOrThrow({ where: { id: INQUIRY_SCOPE_ID } })
    const run = await inspect.inquirySyncRun.findUniqueOrThrow({ where: { id: pending.id } })
    assert.equal(reads, 1, 'stop prevents the next source page')
    assert.equal(await inspect.inquiry.count(), 200, 'in-flight page is fully persisted')
    assert.equal(run.status, 'partial')
    assert.equal(run.errorType, 'interrupted')
    assert.equal(run.readCount, 200)
    assert.equal(run.expectedCount, 201)
    assert.equal(state.nextRunAt?.getTime(), nextRunAt.getTime())
    assert.equal(state.lastSuccessfulAt?.getTime(), lastSuccessfulAt.getTime())
    assert.equal(state.lockOwner, null)
    assert.equal(state.lockExpiresAt, null)
    assert.equal(state.workerOwner, null)
    assert.equal(closed, true)
  })
}

async function testDrainAfterClaim() {
  await withWorkerDatabase(async (worker, inspect) => {
    const pending = await enqueueSync(inspect, 'manual', '2026-09-22')
    assert.ok(pending)
    const nextRunAt = new Date(Date.now() + 60 * 60_000)
    await inspect.inquirySyncState.update({ where: { id: INQUIRY_SCOPE_ID }, data: { nextRunAt } })
    const entered = deferred()
    const finishClaim = deferred()
    const controller = new AbortController()
    let reads = 0
    const deps = dependencies(worker, { prepare: async () => true, read: async () => { reads++; throw new Error('unexpected_read') } })
    deps.claimNextRun = async (...args) => {
      const result = await claimNextRun(...args)
      entered.resolve()
      await finishClaim.promise
      return result
    }
    const running = runInquiryWorker({ enabled: true, signal: controller.signal, dependencies: deps, owner: 'claim-drain', log: () => {} })
    await entered.promise
    controller.abort()
    finishClaim.resolve()
    assert.equal(await running, 0)
    const state = await inspect.inquirySyncState.findUniqueOrThrow({ where: { id: INQUIRY_SCOPE_ID } })
    const run = await inspect.inquirySyncRun.findUniqueOrThrow({ where: { id: pending.id } })
    assert.equal(reads, 0, 'a claim returned after stop cannot start a source page')
    assert.equal(run.status, 'partial')
    assert.equal(run.errorType, 'interrupted')
    assert.equal(run.expectedCount, null, 'interrupted acquisition is not an empty source')
    assert.equal(state.nextRunAt?.getTime(), nextRunAt.getTime())
    assert.equal(state.lastSuccessfulAt, null)
    assert.equal(state.lockOwner, null)
    assert.equal(state.workerOwner, null)
  })
}

async function testDrainDuringSend() {
  await withWorkerDatabase(async (worker, inspect) => {
    for (const index of [1, 2]) await inspect.inquiry.create({ data: {
      ...syntheticInquiry(index), source: INQUIRY_SOURCE, companyScopeId: INQUIRY_COMPANY_ID,
      homepageScopeId: INQUIRY_HOMEPAGE_ID, lastSeenAt: new Date(),
    } })
    const pending = await enqueueSync(inspect, 'manual', '2026-09-22')
    const nextRunAt = new Date(Date.now() + 60 * 60_000)
    const lastSuccessfulAt = new Date(Date.now() - 60 * 60_000)
    await inspect.inquirySyncState.update({ where: { id: INQUIRY_SCOPE_ID }, data: { nextRunAt, lastSuccessfulAt } })
    const entered = deferred()
    const response = deferred<Response>()
    const controller = new AbortController()
    let sends = 0
    const deps = dependencies(worker)
    deps.dispatchPendingWarp = (db, owner, signal) => dispatchPendingWarp(db, owner, async () => {
      sends++
      entered.resolve()
      return response.promise
    }, { WARP_DELIVERY_ENABLED: 'true', WARP_MARKETING_API_KEY: 'synthetic-test-key-never-used-in-production' }, undefined, signal)
    const running = runInquiryWorker({ enabled: true, signal: controller.signal, dependencies: deps, owner: 'send-drain', log: () => {} })
    await entered.promise
    controller.abort()
    assert.equal(await claimWorker(inspect, 'competitor'), false, 'stop retains the lease until response acknowledgment')
    const activityId = warpActivityId(syntheticInquiry(1).sourceId)
    response.resolve(Response.json({ ok: true, customerId: 'synthetic-customer', activityId, created: true, duplicate: false }))
    assert.equal(await running, 0)
    const rows = await inspect.inquiry.findMany({ orderBy: { sourceId: 'asc' } })
    assert.equal(sends, 1)
    assert.equal(rows[0].warpActivityId, activityId)
    assert.equal(rows[0].warpCustomerId, 'synthetic-customer')
    assert.ok(rows[0].warpDeliveredAt)
    assert.equal(rows[1].warpAttemptedAt, null)
    assert.deepEqual(await inspect.inquirySyncRun.findMany(), [pending], 'queued source run stays pending')
    const state = await inspect.inquirySyncState.findUniqueOrThrow({ where: { id: INQUIRY_SCOPE_ID } })
    assert.equal(state.nextRunAt?.getTime(), nextRunAt.getTime())
    assert.equal(state.lastSuccessfulAt?.getTime(), lastSuccessfulAt.getTime())
    assert.equal(state.workerOwner, null)
  })
}

async function testFinishDuringDrain() {
  for (const fail of [false, true]) await withWorkerDatabase(async (worker, inspect) => {
    const pending = await enqueueSync(inspect, 'manual', '2026-09-22')
    assert.ok(pending)
    const nextRunAt = new Date(Date.now() + 60 * 60_000)
    const lastSuccessfulAt = new Date(Date.now() - 60 * 60_000)
    await inspect.inquirySyncState.update({ where: { id: INQUIRY_SCOPE_ID }, data: { nextRunAt, lastSuccessfulAt } })
    const entered = deferred()
    const finish = deferred()
    const controller = new AbortController()
    const logs: string[] = []
    const deps = dependencies(worker, {
      prepare: async () => true,
      read: async () => ({ page: 1, total: 1, rows: [syntheticInquiry(1)] }),
    })
    deps.finishRun = async (...args) => {
      if (!fail) await finishRun(...args)
      entered.resolve()
      await finish.promise
      if (fail) throw new Error('synthetic_private_detail')
    }
    const running = runInquiryWorker({ enabled: true, signal: controller.signal, dependencies: deps, owner: 'finish-drain', log: (code) => logs.push(code) })
    await entered.promise
    controller.abort()
    finish.resolve()
    assert.equal(await running, fail ? 1 : 0, 'stop cannot mask a failed finalization')
    const state = await inspect.inquirySyncState.findUniqueOrThrow({ where: { id: INQUIRY_SCOPE_ID } })
    const run = await inspect.inquirySyncRun.findUniqueOrThrow({ where: { id: pending.id } })
    assert.equal(await inspect.inquiry.count(), 1, 'page persistence survives either finalization outcome')
    assert.equal(state.workerOwner, null)
    if (fail) {
      assert.deepEqual(logs, ['worker_error'])
      assert.equal(state.nextRunAt?.getTime(), nextRunAt.getTime())
      assert.equal(state.lastSuccessfulAt?.getTime(), lastSuccessfulAt.getTime())
      assert.equal(run.status, 'running', 'failed settlement stays recoverable, never falsely successful')
    } else {
      assert.equal(run.status, 'success', 'already committed success is not overwritten by stop')
      assert.equal(state.lastSuccessfulAt?.getTime(), run.completedAt?.getTime())
      assert.equal(state.nextRunAt?.getTime(), run.completedAt!.getTime() + 60 * 60_000)
      assert.equal(state.lockOwner, null)
    }
  })
}

async function testStopAfterEnqueue() {
  await withWorkerDatabase(async (worker, inspect) => {
    const controller = new AbortController()
    const deps = dependencies(worker, { prepare: async () => true })
    deps.enqueueSync = async (...args) => {
      const pending = await enqueueSync(...args)
      controller.abort()
      return pending
    }
    let claims = 0
    deps.claimNextRun = async () => { claims++; return null }
    assert.equal(await runInquiryWorker({ enabled: true, signal: controller.signal, dependencies: deps, owner: 'enqueue-drain', log: () => {} }), 0)
    assert.equal(claims, 0)
    assert.equal((await inspect.inquirySyncRun.findFirstOrThrow()).status, 'pending')
  })
}

async function testLeaseFailureDuringDrain() {
  for (const blocked of [false, true]) await withWorkerDatabase(async (worker, inspect) => {
    const controller = new AbortController()
    const deps = dependencies(worker, { login: async () => false })
    const logs: string[] = []
    let claims = 0
    let dispatches = 0
    deps.claimWorker = async (...args) => { claims++; return claimWorker(...args) }
    deps.dispatchPendingWarp = async () => {
      if (blocked && ++dispatches === 1) return
      await inspect.inquirySyncState.update({ where: { id: INQUIRY_SCOPE_ID }, data: { workerOwner: 'new-owner' } })
      controller.abort()
      await heartbeatWorker(worker, 'fenced-drain')
    }
    assert.equal(await runInquiryWorker({ enabled: true, signal: controller.signal, dependencies: deps, owner: 'fenced-drain', log: (code) => logs.push(code) }), 1)
    assert.equal(claims, 1, 'drain never reclaims a lost lease')
    assert.ok(logs.includes('lost_worker_lease'))
    assert.equal((await inspect.inquirySyncState.findUniqueOrThrow({ where: { id: INQUIRY_SCOPE_ID } })).workerOwner, 'new-owner')
  })
}

async function testCleanupFailures() {
  for (const step of ['browser', 'release', 'disconnect']) await withWorkerDatabase(async (worker) => {
    const controller = new AbortController()
    const deps = dependencies(worker, {
      open: async () => { controller.abort() },
      closed: () => { if (step === 'browser') throw new Error('synthetic_private_detail') },
    })
    if (step === 'release') deps.releaseWorker = async () => { throw new Error('synthetic_private_detail') }
    if (step === 'disconnect') {
      const disconnect = worker.$disconnect.bind(worker)
      worker.$disconnect = async () => { await disconnect(); throw new Error('synthetic_private_detail') }
    }
    const logs: string[] = []
    assert.equal(await runInquiryWorker({ enabled: true, signal: controller.signal, dependencies: deps, owner: 'cleanup-drain', log: (code) => logs.push(code) }), 1)
    assert.deepEqual(logs, [step === 'browser' ? 'browser_close_failed' : `worker_${step}_failed`])
  })
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

const timeout = setTimeout(() => { throw new Error('worker-runtime tests timed out') }, 60_000)
main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error)
  process.exitCode = 1
}).finally(() => clearTimeout(timeout))
