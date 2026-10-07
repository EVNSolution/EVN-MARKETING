import assert from 'node:assert/strict'
import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { cp, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createClient } from '@libsql/client'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import { PrismaClient } from '@/app/generated/prisma/client'
import { ensureSyncState, INQUIRY_COMPANY_ID, INQUIRY_HOMEPAGE_ID, INQUIRY_SCOPE_ID, INQUIRY_SOURCE, WORKER_LEASE_MS } from '@/lib/inquiry-sync'
import { warpActivityId } from '@/lib/warp-delivery'
import { recordSyntheticMigrations } from './schema-fixture.mjs'

type Reply = { event: string; claimed?: boolean; delivered?: number; failed?: number; error?: string; activityId?: string }
const scope = { source: INQUIRY_SOURCE, companyScopeId: INQUIRY_COMPANY_ID, homepageScopeId: INQUIRY_HOMEPAGE_ID }
const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, NODE_ENV: 'test' }
const Database = createRequire(import.meta.url)('better-sqlite3')
const children = new Set<ChildProcess>()
const exits = new Map<ChildProcess, Promise<[number | null, NodeJS.Signals | null]>>()

function open(url: string) {
  return new PrismaClient({ adapter: new PrismaBetterSqlite3({ url, timeout: 5000 }, { timestampFormat: 'iso8601' }) })
}

async function migrate(url: string) {
  const sql = createClient({ url })
  try {
    for (const migration of ['20260915000100_baseline', '20260915000200_inquiry_sync', '20260915000300_warp_delivery', '20261007000100_landing_inquiries']) {
      await sql.executeMultiple(await readFile(path.join('prisma/migrations', migration, 'migration.sql'), 'utf8'))
    }
  } finally { sql.close() }
  const ledger = new Database(url.slice('file:'.length))
  try { recordSyntheticMigrations(ledger, process.cwd()) } finally { ledger.close() }
}

async function spawn(marketingUrl: string, warpUrl: string, owner: string) {
  const child = fork(path.resolve('tests/data-recovery-child.ts'), [marketingUrl, warpUrl, owner], {
    execArgv: ['--import', 'tsx'], env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  })
  children.add(child)
  exits.set(child, new Promise((resolve) => child.once('exit', (code, signal) => resolve([code, signal]))))
  const [ready] = await once(child, 'message') as [Reply]
  assert.equal(ready.event, 'ready')
  return child
}

async function command(child: ChildProcess, value: object) {
  const received = once(child, 'message') as Promise<[Reply]>
  child.send(value)
  const [reply] = await received
  assert.notEqual(reply.event, 'error', reply.error)
  return reply
}

async function stop(child: ChildProcess) {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  await exits.get(child)
  children.delete(child)
}

async function checkpoint(url: string) {
  const sql = createClient({ url })
  try { await sql.execute('PRAGMA wal_checkpoint(TRUNCATE)') } finally { sql.close() }
}

async function restore(database: string, snapshot: string, url: string) {
  await checkpoint(url)
  await Promise.all([rm(`${database}-wal`, { force: true }), rm(`${database}-shm`, { force: true })])
  await copyFile(snapshot, database)
}

async function databaseState(db: PrismaClient) {
  return {
    teams: await db.team.findMany({ orderBy: { id: 'asc' } }),
    users: await db.user.findMany({ orderBy: { id: 'asc' } }),
    customers: await db.customer.findMany({ orderBy: { id: 'asc' } }),
    activities: await db.customerActivity.findMany({ orderBy: { id: 'asc' } }),
    inquiries: await db.inquiry.findMany({ orderBy: { id: 'asc' } }),
    runs: await db.inquirySyncRun.findMany({ orderBy: { id: 'asc' } }),
    states: await db.inquirySyncState.findMany({ orderBy: { id: 'asc' } }),
    migrationLedger: await db.$queryRawUnsafe<Array<Record<string, unknown>>>('SELECT * FROM _prisma_migrations ORDER BY migration_name'),
  }
}

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), 'evn-data-recovery-'))
  const marketingFile = path.join(root, 'marketing.db')
  const marketingUrl = `file:${marketingFile}`
  const warpFile = path.join(root, 'warp.db')
  const warpUrl = `file:${warpFile}`
  const uploads = path.join(root, 'uploads')
  const backup = path.join(root, 'offline-backup')
  globalThis.fetch = async () => { throw new Error('real network access is forbidden') }

  try {
    await migrate(marketingUrl)
    const warp = createClient({ url: warpUrl })
    await warp.executeMultiple('CREATE TABLE activity (source_id TEXT PRIMARY KEY, activity_id TEXT NOT NULL UNIQUE, customer_id TEXT NOT NULL); PRAGMA journal_mode = WAL;')
    warp.close()
    await mkdir(path.join(uploads, 'customers', 'customer-1'), { recursive: true })
    await writeFile(path.join(uploads, 'customers', 'customer-1', 'receipt.pdf'), '%PDF synthetic receipt')

    let db = open(marketingUrl)
    await db.team.create({ data: { id: 'team-1', name: 'Synthetic marketing' } })
    await db.user.create({ data: { id: 'user-1', name: 'Recovery admin', email: 'recovery@example.invalid', password: 'synthetic-hash', role: 'admin', teamId: 'team-1' } })
    await db.customer.create({ data: {
      id: 'customer-1', name: 'Synthetic customer', phone: '010-0000-0001',
      documentsJson: JSON.stringify([{ type: 'receipt', path: '/api/uploads/customers/customer-1/receipt.pdf' }]),
    } })
    await db.customerActivity.create({ data: { id: 'activity-1', customerId: 'customer-1', type: '전화', date: new Date('2026-09-20T01:00:00Z'), content: 'Synthetic follow-up' } })
    await ensureSyncState(db)
    await db.inquirySyncState.update({ where: { id: INQUIRY_SCOPE_ID }, data: { status: 'ready', nextRunAt: new Date('2026-09-22T03:00:00Z') } })
    const deliveredSource = '00000000-0000-4000-8000-000000000001'
    await db.inquiry.create({ data: {
      id: 'inquiry-delivered', ...scope, sourceId: deliveredSource, inquiryDate: '2026-09-20', inquiryTime: '09:00', phone: '010-0000-0001',
      lastSeenAt: new Date('2026-09-20T00:00:00Z'), warpCustomerId: 'synthetic-warp-customer', warpActivityId: warpActivityId(deliveredSource),
      warpDeliveredAt: new Date('2026-09-20T00:01:00Z'), warpAttemptedAt: new Date('2026-09-20T00:01:00Z'),
    } })
    await db.inquirySyncRun.create({ data: { id: 'run-1', ...scope, trigger: 'hourly', status: 'success', rangeStart: '2000-01-01', rangeEnd: '2026-09-20', completedAt: new Date('2026-09-20T00:02:00Z') } })
    const expected = await databaseState(db)
    await db.$disconnect()
    await checkpoint(marketingUrl)
    await mkdir(backup)
    await copyFile(marketingFile, path.join(backup, 'marketing.db'))
    await cp(uploads, path.join(backup, 'uploads'), { recursive: true })

    db = open(marketingUrl)
    await db.user.update({ where: { id: 'user-1' }, data: { role: 'user' } })
    await db.customer.delete({ where: { id: 'customer-1' } })
    await db.inquiry.deleteMany()
    await db.inquirySyncState.update({ where: { id: INQUIRY_SCOPE_ID }, data: { nextRunAt: null } })
    await db.$disconnect()
    await rm(uploads, { recursive: true })
    await restore(marketingFile, path.join(backup, 'marketing.db'), marketingUrl)
    await cp(path.join(backup, 'uploads'), uploads, { recursive: true })

    db = open(marketingUrl)
    assert.deepEqual(await databaseState(db), expected, 'offline DB snapshot restores customer, auth, inquiry, schedule and receipt state together')
    assert.equal(await readFile(path.join(uploads, 'customers', 'customer-1', 'receipt.pdf'), 'utf8'), '%PDF synthetic receipt')
    await db.customer.create({ data: { id: 'customer-after-code', name: 'Created after code-only deploy' } })
    await writeFile(path.join(uploads, 'code-only.txt'), 'newer upload')
    await db.$disconnect()
    db = open(marketingUrl)
    assert.equal((await db.customer.findUniqueOrThrow({ where: { id: 'customer-after-code' } })).name, 'Created after code-only deploy')
    assert.equal(await readFile(path.join(uploads, 'code-only.txt'), 'utf8'), 'newer upload', 'code-only reopen preserves newer DB and upload writes')

    const crashSource = '00000000-0000-4000-8000-000000000002'
    await db.inquiry.create({ data: { id: 'inquiry-crash', ...scope, sourceId: crashSource, inquiryDate: '2026-09-21', inquiryTime: '09:00', phone: '010-0000-0002', lastSeenAt: new Date('2026-09-21T00:00:00Z') } })
    await db.$disconnect()
    const started = Date.parse('2026-09-22T00:00:00Z')
    const crashed = await spawn(marketingUrl, warpUrl, 'crashed-worker')
    assert.equal((await command(crashed, { action: 'claim', at: started })).claimed, true)
    const committed = await command(crashed, { action: 'dispatch', at: started, pause: true })
    assert.equal(committed.event, 'remote-committed')
    crashed.kill('SIGKILL')
    assert.deepEqual(await exits.get(crashed), [null, 'SIGKILL'])
    children.delete(crashed)
    db = open(marketingUrl)
    assert.equal((await db.inquiry.findUniqueOrThrow({ where: { id: 'inquiry-crash' } })).warpDeliveredAt, null)
    await db.$disconnect()
    const replacement = await spawn(marketingUrl, warpUrl, 'replacement-worker')
    assert.equal((await command(replacement, { action: 'claim', at: started + WORKER_LEASE_MS - 1 })).claimed, false)
    assert.equal((await command(replacement, { action: 'claim', at: started + WORKER_LEASE_MS + 1 })).claimed, true)
    assert.equal((await command(replacement, { action: 'dispatch', at: started + WORKER_LEASE_MS + 1 })).delivered, 1)
    db = open(marketingUrl)
    const recovered = await db.inquiry.findUniqueOrThrow({ where: { id: 'inquiry-crash' } })
    assert.equal(recovered.warpActivityId, committed.activityId)
    assert.ok(recovered.warpDeliveredAt)
    const warpInspect = createClient({ url: warpUrl })
    assert.equal((await warpInspect.execute('SELECT count(*) AS count FROM activity')).rows[0].count, 1, 'lost response replay keeps one remote activity')
    warpInspect.close()
    await db.$disconnect()
    await command(replacement, { action: 'release', at: started + WORKER_LEASE_MS + 2 })
    await command(replacement, { action: 'close', at: started + WORKER_LEASE_MS + 2 })
    await exits.get(replacement)
    children.delete(replacement)

    db = open(marketingUrl)
    const marketingOlderSource = '00000000-0000-4000-8000-000000000003'
    await db.inquiry.create({ data: { id: 'inquiry-marketing-older', ...scope, sourceId: marketingOlderSource, inquiryDate: '2026-09-21', inquiryTime: '10:00', phone: '010-0000-0003', lastSeenAt: new Date('2026-09-21T01:00:00Z') } })
    await db.$disconnect()
    await checkpoint(marketingUrl)
    const marketingOlder = path.join(root, 'marketing-older.db')
    await copyFile(marketingFile, marketingOlder)
    const newerWorker = await spawn(marketingUrl, warpUrl, 'marketing-newer-worker')
    assert.equal((await command(newerWorker, { action: 'claim', at: started + 2 * WORKER_LEASE_MS })).claimed, true)
    assert.equal((await command(newerWorker, { action: 'dispatch', at: started + 2 * WORKER_LEASE_MS })).delivered, 1)
    db = open(marketingUrl)
    const newerReceipt = await db.inquiry.findUniqueOrThrow({ where: { id: 'inquiry-marketing-older' } })
    assert.ok(newerReceipt.warpDeliveredAt, 'newer Marketing DB acknowledged before restoring its older backup')
    await db.$disconnect()
    await command(newerWorker, { action: 'release', at: started + 2 * WORKER_LEASE_MS + 1 })
    await command(newerWorker, { action: 'close', at: started + 2 * WORKER_LEASE_MS + 1 })
    await exits.get(newerWorker)
    children.delete(newerWorker)
    await restore(marketingFile, marketingOlder, marketingUrl)
    const duplicateRecovery = await spawn(marketingUrl, warpUrl, 'marketing-restore-worker')
    assert.equal((await command(duplicateRecovery, { action: 'claim', at: started + 3 * WORKER_LEASE_MS })).claimed, true)
    assert.equal((await command(duplicateRecovery, { action: 'dispatch', at: started + 3 * WORKER_LEASE_MS })).delivered, 1)
    db = open(marketingUrl)
    const replayReceipt = await db.inquiry.findUniqueOrThrow({ where: { id: 'inquiry-marketing-older' } })
    assert.ok(replayReceipt.warpDeliveredAt, 'older Marketing backup recovers WARP duplicate receipt')
    assert.equal(replayReceipt.warpCustomerId, newerReceipt.warpCustomerId)
    assert.equal(replayReceipt.warpActivityId, newerReceipt.warpActivityId)
    const warpAfterReplay = createClient({ url: warpUrl })
    assert.equal((await warpAfterReplay.execute('SELECT count(*) AS count FROM activity')).rows[0].count, 2, 'older Marketing restore creates no additional remote activity')
    warpAfterReplay.close()
    await db.$disconnect()
    await command(duplicateRecovery, { action: 'release', at: started + 3 * WORKER_LEASE_MS + 1 })
    await command(duplicateRecovery, { action: 'close', at: started + 3 * WORKER_LEASE_MS + 1 })
    await exits.get(duplicateRecovery)
    children.delete(duplicateRecovery)

    await checkpoint(warpUrl)
    const warpOlder = path.join(root, 'warp-older.db')
    await copyFile(warpFile, warpOlder)
    db = open(marketingUrl)
    const warpOlderSource = '00000000-0000-4000-8000-000000000004'
    await db.inquiry.create({ data: { id: 'inquiry-warp-older', ...scope, sourceId: warpOlderSource, inquiryDate: '2026-09-21', inquiryTime: '11:00', phone: '010-0000-0004', lastSeenAt: new Date('2026-09-21T02:00:00Z') } })
    await db.$disconnect()
    const deliveredWorker = await spawn(marketingUrl, warpUrl, 'warp-restore-worker')
    assert.equal((await command(deliveredWorker, { action: 'claim', at: started + 4 * WORKER_LEASE_MS })).claimed, true)
    assert.equal((await command(deliveredWorker, { action: 'dispatch', at: started + 4 * WORKER_LEASE_MS })).delivered, 1)
    await restore(warpFile, warpOlder, warpUrl)
    assert.equal((await command(deliveredWorker, { action: 'dispatch', at: started + 4 * WORKER_LEASE_MS + 1 })).delivered, 0)
    db = open(marketingUrl)
    const stillDelivered = await db.inquiry.findUniqueOrThrow({ where: { id: 'inquiry-warp-older' } })
    assert.ok(stillDelivered.warpDeliveredAt, 'automatic dispatcher preserves the newer Marketing delivered flag')
    const restoredWarp = createClient({ url: warpUrl })
    const missing = await restoredWarp.execute({ sql: 'SELECT count(*) AS count FROM activity WHERE source_id = ?', args: [warpOlderSource] })
    assert.equal(missing.rows[0].count, 0, 'asymmetric WARP restore remains detectable and requires explicit operational reconciliation')
    restoredWarp.close()
    await db.$disconnect()
    await command(deliveredWorker, { action: 'release', at: started + 4 * WORKER_LEASE_MS + 2 })
    await command(deliveredWorker, { action: 'close', at: started + 4 * WORKER_LEASE_MS + 2 })
    await exits.get(deliveredWorker)
    children.delete(deliveredWorker)

    console.log('data recovery checks passed: offline snapshot, code-only reopen, killed receipt replay, asymmetric restore boundaries')
  } finally {
    for (const child of children) await stop(child)
    await rm(root, { recursive: true, force: true })
  }
}

const timeout = setTimeout(() => {
  for (const child of children) child.kill('SIGKILL')
  throw new Error('data recovery tests timed out')
}, 60_000)
main().catch((error) => { console.error(error); process.exitCode = 1 }).finally(() => clearTimeout(timeout))
