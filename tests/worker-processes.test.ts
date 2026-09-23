import assert from 'node:assert/strict'
import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import path from 'node:path'
import type { PrismaClient } from '@/app/generated/prisma/client'
import { enqueueSync, ensureSyncState, INQUIRY_COMPANY_ID, INQUIRY_HOMEPAGE_ID, INQUIRY_SCOPE_ID, INQUIRY_SOURCE } from '@/lib/inquiry-sync'
import { warpActivityId } from '@/lib/warp-delivery'
import { withWorkerDatabase } from './worker-runtime-helper'
import type { Command, Reply } from './worker-process-child'

const children = new Set<ChildProcess>()
const exits = new Map<ChildProcess, Promise<[number | null, NodeJS.Signals | null]>>()
const sourceId = '00000000-0000-4000-8000-000000000001'
const stateWhere = { id: INQUIRY_SCOPE_ID }

async function spawn(url: string, owner: string) {
  const child = fork(path.resolve('tests/worker-process-child.ts'), [url, owner], {
    execArgv: ['--import', 'tsx'],
    env: { PATH: process.env.PATH, NODE_ENV: 'test', DATABASE_URL: url },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  })
  children.add(child)
  exits.set(child, new Promise((resolve) => child.once('exit', (code, signal) => resolve([code, signal]))))
  const [ready] = await once(child, 'message')
  assert.equal(ready.event, 'ready')
  assert.notEqual(child.pid, process.pid)
  return child
}

async function command(child: ChildProcess, value: Command): Promise<Reply> {
  const received = once(child, 'message')
  child.send(value)
  const [reply] = await received
  assert.notEqual(reply.event, 'error', reply.error)
  return reply
}

async function stopChildren() {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  await Promise.all([...children].map((child) => exits.get(child)))
  children.clear()
  exits.clear()
}

async function fixture(test: (db: PrismaClient, url: string, at: number) => Promise<void>) {
  await withWorkerDatabase(async (db) => {
    await db.$queryRaw`PRAGMA journal_mode = WAL`
    const databases = await db.$queryRaw<Array<{ name: string; file: string }>>`PRAGMA database_list`
    const file = databases.find((entry) => entry.name === 'main')?.file
    assert.ok(file)
    await ensureSyncState(db)
    try { await test(db, `file:${file}`, Date.now()) } finally { await stopChildren() }
  })
}

async function contend(first: ChildProcess, second: ChildProcess, at: number) {
  const barriers = await Promise.all([first, second].map((child) => command(child, { action: 'claim', at, pause: true })))
  assert.ok(barriers.every((reply) => reply.event === 'barrier'))
  const results = await Promise.all([first, second].map((child) => command(child, { action: 'continue', at })))
  assert.deepEqual(results.map((reply) => reply.claimed).sort(), [false, true], 'exactly one OS process acquires the lease')
  return results[0].claimed ? [first, second] : [second, first]
}

async function testDistinctOwners() {
  await fixture(async (db, url, at) => {
    assert.ok(await enqueueSync(db, 'manual', '2026-09-22'))
    const [first, second] = await Promise.all([spawn(url, 'worker-a'), spawn(url, 'worker-b')])
    assert.notEqual(first.pid, second.pid)
    const [winner, loser] = await contend(first, second, at)
    const state = await db.inquirySyncState.findUniqueOrThrow({ where: stateWhere })
    assert.equal(state.workerOwner, winner === first ? 'worker-a' : 'worker-b')
    assert.equal(state.status, 'starting')
    assert.equal((await command(loser, { action: 'collect', at })).pages, 0, 'loser does not call the source')
    const collected = await command(winner, { action: 'collect', at })
    assert.equal(collected.status, 'success')
    assert.equal(collected.pages, 1)
    assert.deepEqual(await command(loser, { action: 'dispatch', at }), { event: 'result', error: 'lost_worker_lease', calls: 0 })
    assert.deepEqual(await command(winner, { action: 'dispatch', at }), { event: 'result', delivered: 1, calls: 1 })
    const receipt = await db.inquiry.findFirstOrThrow()
    assert.equal(receipt.warpActivityId, warpActivityId(sourceId))
    assert.ok(receipt.warpDeliveredAt)

    await command(winner, { action: 'release', at })
    await command(winner, { action: 'close', at })
    assert.deepEqual(await exits.get(winner), [0, null])
    assert.equal((await db.inquirySyncState.findUniqueOrThrow({ where: stateWhere })).workerOwner, null)
    assert.equal((await command(loser, { action: 'claim', at })).claimed, true)
    assert.ok(await enqueueSync(db, 'manual', '2026-09-22'))
    const replay = await command(loser, { action: 'collect', at })
    assert.equal(replay.status, 'success')
    assert.equal(replay.unchangedCount, 1)
    assert.deepEqual(await command(loser, { action: 'dispatch', at }), { event: 'result', delivered: 0, calls: 0 })
    assert.deepEqual(await db.inquiry.findFirstOrThrow(), receipt, 'source replay and replacement preserve the saved receipt')
  })
}

async function testSameOwner() {
  await fixture(async (db, url, at) => {
    const [first, second] = await Promise.all([spawn(url, 'duplicate-owner'), spawn(url, 'duplicate-owner')])
    const [winner, loser] = await contend(first, second, at)
    assert.equal((await db.inquirySyncState.findUniqueOrThrow({ where: stateWhere })).status, 'starting')
    await command(winner, { action: 'release', at })
    assert.equal((await command(loser, { action: 'claim', at })).claimed, true, 'same owner can acquire after explicit release')
  })
}

async function testAbruptDeathAndReplay() {
  await fixture(async (db, url, at) => {
    assert.ok(await enqueueSync(db, 'manual', '2026-09-22'))
    const [original, replacement] = await Promise.all([spawn(url, 'original'), spawn(url, 'replacement')])
    assert.equal((await command(original, { action: 'claim', at })).claimed, true)
    assert.equal((await command(original, { action: 'collect', at })).status, 'success')
    const committed = await command(original, { action: 'dispatch', at, pause: true })
    assert.equal(committed.event, 'barrier')
    assert.equal(committed.activityId, warpActivityId(sourceId))
    const before = await db.inquirySyncState.findUniqueOrThrow({ where: stateWhere })
    original.kill('SIGKILL')
    assert.deepEqual(await exits.get(original), [null, 'SIGKILL'])
    const expiresAt = before.workerLeaseExpiresAt!.getTime()
    assert.equal((await command(replacement, { action: 'claim', at: expiresAt - 1 })).claimed, false, 'process death does not waive the lease')
    assert.deepEqual(await db.inquirySyncState.findUniqueOrThrow({ where: stateWhere }), before)
    assert.equal((await db.inquiry.findFirstOrThrow()).warpDeliveredAt, null, 'killed sender did not acknowledge')

    const afterExpiry = expiresAt + 1
    assert.equal((await command(replacement, { action: 'claim', at: afterExpiry })).claimed, true)
    const replay = await command(replacement, { action: 'dispatch', at: afterExpiry, duplicate: true })
    assert.equal(replay.delivered, 1)
    assert.equal(committed.calls! + replay.calls!, 2, 'one original send and one duplicate replay across processes')
    const receipt = await db.inquiry.findFirstOrThrow()
    assert.equal(receipt.warpActivityId, committed.activityId)
    assert.equal(receipt.warpCustomerId, 'synthetic-customer')
    assert.ok(receipt.warpDeliveredAt)
    assert.deepEqual(await command(replacement, { action: 'dispatch', at: afterExpiry }), { event: 'result', delivered: 0, calls: 0 })
    assert.deepEqual(await db.inquiry.findFirstOrThrow(), receipt)
  })
}

async function testStaleOwnerFences() {
  await fixture(async (db, url, at) => {
    const pending = await enqueueSync(db, 'manual', '2026-09-22')
    assert.ok(pending)
    const nextRunAt = new Date(at + 3_600_000)
    const lastSuccessfulAt = new Date(at - 3_600_000)
    await db.inquirySyncState.update({ where: stateWhere, data: { nextRunAt, lastSuccessfulAt } })
    const row = await db.inquiry.create({ data: {
      source: INQUIRY_SOURCE, companyScopeId: INQUIRY_COMPANY_ID, homepageScopeId: INQUIRY_HOMEPAGE_ID,
      sourceId: '00000000-0000-4000-8000-000000000002', inquiryDate: '2026-09-22', inquiryTime: '10:00', phone: '010-0000-0000', lastSeenAt: new Date(at),
    } })
    const [stale, current] = await Promise.all([spawn(url, 'stale'), spawn(url, 'current')])
    assert.equal((await command(stale, { action: 'claim', at })).claimed, true)
    const paused = await command(stale, { action: 'collect', at, pause: true })
    assert.equal(paused.event, 'barrier')
    assert.equal(paused.runId, pending.id)
    const runBefore = await db.inquirySyncRun.findUniqueOrThrow({ where: { id: pending.id } })
    const afterExpiry = at + 180_001
    assert.equal((await command(current, { action: 'claim', at: afterExpiry })).claimed, true)
    const stateBefore = await db.inquirySyncState.findUniqueOrThrow({ where: stateWhere })
    const resumed = await command(stale, { action: 'continue', at })
    assert.equal(resumed.error, 'lost_lease', 'page persistence is fenced even with the former owner clock still before expiry')
    assert.equal(resumed.finishError, 'lost_lease')
    assert.equal((await command(stale, { action: 'heartbeat', at: afterExpiry })).error, 'lost_worker_lease')
    assert.deepEqual(await command(stale, { action: 'dispatch', at: afterExpiry }), { event: 'result', error: 'lost_worker_lease', calls: 0 })
    await command(stale, { action: 'release', at: afterExpiry })
    assert.deepEqual(await db.inquirySyncState.findUniqueOrThrow({ where: stateWhere }), stateBefore, 'stale heartbeat, finalization and release cannot alter the current owner or schedule')
    assert.equal(stateBefore.nextRunAt?.getTime(), nextRunAt.getTime())
    assert.equal(stateBefore.lastSuccessfulAt?.getTime(), lastSuccessfulAt.getTime())
    assert.deepEqual(await db.inquirySyncRun.findUniqueOrThrow({ where: { id: pending.id } }), runBefore)
    assert.deepEqual(await db.inquiry.findMany(), [row], 'stale source page and sender make no writes')
  })
}

async function main() {
  await testDistinctOwners()
  await testSameOwner()
  await testAbruptDeathAndReplay()
  await testStaleOwnerFences()
  console.log('worker process tests passed: distinct/same-owner contention, release, death/expiry, stale fences, receipt replay')
}

const timeout = setTimeout(() => {
  for (const child of children) child.kill('SIGKILL')
  throw new Error('worker process tests timed out')
}, 60_000)
main().catch((error) => { console.error(error); process.exitCode = 1 }).finally(() => clearTimeout(timeout))
