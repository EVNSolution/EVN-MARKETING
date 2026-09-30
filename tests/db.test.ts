import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import type { PrismaClient } from '@/app/generated/prisma/client'
import { claimNextRun, enqueueSync, ensureSyncState, recoverStaleRuns } from '@/lib/inquiry-sync'

async function main() {
  const temp = await mkdtemp(path.join(tmpdir(), 'evn-db-test-'))
  const url = `file:${path.join(temp, 'test.db')}`
  const previousUrl = process.env.DATABASE_URL
  // Set this before importing db: its exported app singleton must also use synthetic data.
  process.env.DATABASE_URL = url
  const clients: PrismaClient[] = []
  try {
    const sql = await new PrismaBetterSqlite3({ url }).connect()
    try {
      for (const migration of ['20260915000100_baseline', '20260915000200_inquiry_sync', '20260915000300_warp_delivery', '20260930000100_warp_phone_check']) {
        await sql.executeScript(await readFile(path.join(process.cwd(), 'prisma/migrations', migration, 'migration.sql'), 'utf8'))
      }
      await sql.executeScript('PRAGMA journal_mode = DELETE')
    } finally {
      await sql.dispose()
    }

    const { createPrisma, prisma: app } = await import('@/lib/db')
    const worker = createPrisma(url)
    clients.push(app, worker)
    await ensureSyncState(worker)
    await enqueueSync(worker, 'manual', '2026-09-15')
    const run = await claimNextRun(worker, new Date('2026-09-15T00:00:00Z'), 'synthetic-db-worker')
    assert.ok(run)
    const where = { id: run.id }
    // A legacy ISO text timestamp must read as Date, and new writes must stay ISO text.
    const legacyDate = '2026-09-15T00:00:00.123+00:00'
    await worker.$executeRawUnsafe('UPDATE InquirySyncRun SET startedAt = ? WHERE id = ?', legacyDate, run.id)
    assert.equal((await app.inquirySyncRun.findUniqueOrThrow({ where })).startedAt?.toISOString(), new Date(legacyDate).toISOString())

    await app.$transaction(async (reader) => {
      assert.equal((await reader.inquirySyncRun.findUniqueOrThrow({ where })).status, 'running')
      // Keep the app's read snapshot open while the other client commits real recovery writes.
      await recoverStaleRuns(worker, new Date('2026-09-15T00:04:00Z'))
      assert.equal((await worker.inquirySyncRun.findUniqueOrThrow({ where })).status, 'partial')
      assert.equal((await reader.inquirySyncRun.findUniqueOrThrow({ where })).status, 'running', 'the reader retains its snapshot')
    })
    assert.equal((await app.inquirySyncRun.findUniqueOrThrow({ where })).errorType, 'stale_worker')
    const stored = await app.$queryRawUnsafe<{ kind: string; value: string }[]>(
      'SELECT typeof(completedAt) AS kind, completedAt AS value FROM InquirySyncRun WHERE id = ?', run.id,
    )
    assert.equal(stored[0].kind, 'text')
    assert.equal(new Date(stored[0].value).toISOString(), '2026-09-15T00:04:00.000Z')

    for (const client of clients) {
      const mode = await client.$queryRawUnsafe<{ journal_mode: string }[]>('PRAGMA journal_mode')
      assert.equal(mode[0].journal_mode, 'wal')
      for (let i = 0; i < 3; i++) {
        const inside = await client.$transaction((tx) => tx.$queryRawUnsafe<{ timeout: number }[]>('PRAGMA busy_timeout'))
        const after = await client.$queryRawUnsafe<{ timeout: number }[]>('PRAGMA busy_timeout')
        assert.equal(Number(inside[0].timeout), 5000, 'transaction connections inherit the timeout')
        assert.equal(Number(after[0].timeout), 5000, 'replacement connections retain the timeout')
      }
    }

    await assert.rejects(worker.$transaction(async (tx) => {
      await tx.inquirySyncRun.update({ where, data: { status: 'running' } })
      throw new Error('synthetic_rollback')
    }), /synthetic_rollback/)
    assert.equal((await app.inquirySyncRun.findUniqueOrThrow({ where })).status, 'partial', 'rollback preserves the committed state')
    for (let i = 0; i < 3000; i++) {
      await worker.$transaction((tx) => tx.inquirySyncRun.update({ where, data: { readCount: { increment: 1 } } }))
    }
    assert.equal((await app.inquirySyncRun.findUniqueOrThrow({ where })).readCount, 3000)
    await Promise.all(clients.map((client) => client.$disconnect()))
    // Reopen through the factory to prove the writes survived disconnect, then close before unlink.
    const reopened = createPrisma(url)
    clients.push(reopened)
    assert.equal((await reopened.inquirySyncRun.findUniqueOrThrow({ where })).readCount, 3000)
    assert.deepEqual(await reopened.$queryRawUnsafe('PRAGMA integrity_check'), [{ integrity_check: 'ok' }])
  } finally {
    await Promise.all(clients.map((client) => client.$disconnect()))
    if (previousUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previousUrl
    await rm(temp, { recursive: true, force: true })
  }
  console.log('db checks passed: reader/writer, WAL, timeout, ISO dates, rollback, 3000 commits, reopen, integrity, cleanup')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
