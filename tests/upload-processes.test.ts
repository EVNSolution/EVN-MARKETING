import assert from 'node:assert/strict'
import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, open, readdir, stat, truncate, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { PrismaClient } from '@/app/generated/prisma/client'
import { MAX_CUSTOMER_BYTES } from '@/lib/upload-security'
import { withWorkerDatabase } from './worker-runtime-helper'

type Reply = { event: string; error?: string; filename?: string; url?: string }
const children = new Set<ChildProcess>()
const exits = new Map<ChildProcess, Promise<[number | null, NodeJS.Signals | null]>>()
const customerId = 'upload-customer'
const baselineBytes = 46 * 1024 * 1024

async function spawn(url: string, root: string, kind = 'image', mode = 'normal') {
  const child = fork(path.resolve('tests/upload-processes-child.ts'), [url, root, kind, mode], {
    execArgv: ['--import', 'tsx'], env: { PATH: process.env.PATH, NODE_ENV: 'test' },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  })
  children.add(child)
  exits.set(child, new Promise((resolve) => child.once('exit', (code, signal) => resolve([code, signal]))))
  const [ready] = await once(child, 'message')
  assert.equal(ready.event, 'ready')
  return child
}

async function command(child: ChildProcess): Promise<Reply> {
  const reply = once(child, 'message')
  child.send('continue')
  return (await reply)[0]
}

async function acquire(child: ChildProcess) {
  assert.equal((await command(child)).event, 'attempt')
  assert.equal((await command(child)).event, 'locked')
}

async function files(directory: string): Promise<string[]> {
  const result: string[] = []
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, item.name)
    result.push(...(item.isDirectory() ? await files(filename) : [filename]))
  }
  return result
}

async function fixture(test: (db: PrismaClient, url: string, root: string, directory: string) => Promise<void>) {
  await withWorkerDatabase(async (db) => {
    await db.$queryRaw`PRAGMA journal_mode = WAL`
    const [{ file }] = await db.$queryRaw<Array<{ file: string }>>`PRAGMA database_list`
    const root = path.join(path.dirname(file), 'uploads')
    const directory = path.join(root, 'customers', customerId)
    await mkdir(directory, { recursive: true })
    const existing = path.join(directory, 'existing.pdf')
    await writeFile(existing, '%PDF-synthetic-preserve')
    await truncate(existing, baselineBytes)
    const customer = await db.customer.create({ data: {
      id: customerId, name: 'Synthetic upload customer',
      documentsJson: JSON.stringify([{ type: '계좌정보', name: 'existing.pdf', path: `/api/uploads/customers/${customerId}/existing.pdf`, size: baselineBytes, uploadedAt: new Date().toISOString() }]),
    } })
    try {
      await test(db, `file:${file}`, root, directory)
      assert.deepEqual(await db.customer.findUniqueOrThrow({ where: { id: customerId } }), customer, 'quota gate never changes existing metadata')
      assert.equal((await stat(existing)).size, baselineBytes)
      const handle = await open(existing, 'r')
      try {
        const header = Buffer.alloc(Buffer.byteLength('%PDF-synthetic-preserve'))
        await handle.read(header)
        assert.equal(header.toString(), '%PDF-synthetic-preserve')
      } finally { await handle.close() }
    } finally {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await Promise.all([...children].map((child) => exits.get(child)))
      children.clear()
      exits.clear()
    }
  })
}

async function testQuotaContention() {
  await fixture(async (_db, url, root, directory) => {
    const [first, second] = await Promise.all([spawn(url, root), spawn(url, root, 'document')])
    assert.notEqual(first.pid, second.pid)
    const attempts = await Promise.all([command(first), command(second)])
    assert.ok(attempts.every((reply) => reply.event === 'attempt'))
    assert.equal((await command(first)).event, 'locked')
    const waiting = command(second)
    const accepted = await command(first)
    assert.equal(accepted.event, 'result')
    assert.equal(accepted.error, undefined)
    assert.ok(accepted.filename)
    assert.equal((await waiting).event, 'locked')
    assert.deepEqual(await command(second), { event: 'result', error: 'customer_upload_quota_exceeded' })
    assert.deepEqual(await exits.get(first), [0, null])
    assert.deepEqual(await exits.get(second), [0, null])
    const stored = await files(directory)
    assert.equal(stored.length, 2, 'only one competing upload was written')
    assert.equal((await Promise.all(stored.map((filename) => stat(filename)))).reduce((sum, info) => sum + info.size, 0), MAX_CUSTOMER_BYTES)
    assert.equal((await stat(accepted.filename)).mode & 0o777, 0o600)
  })
}

async function testFailedWriteReleasesLock() {
  await fixture(async (_db, url, root, directory) => {
    const failed = await spawn(url, root, 'image', 'fail-write')
    await acquire(failed)
    assert.deepEqual(await command(failed), { event: 'result', error: 'upload_write_failed' })
    assert.deepEqual(await exits.get(failed), [0, null])
    assert.deepEqual(await files(directory), [path.join(directory, 'existing.pdf')], 'partial file was removed')
    const retry = await spawn(url, root)
    await acquire(retry)
    assert.ok((await command(retry)).filename, 'failed write released the SQLite lock')
  })
}

async function testDeathAndOrphanAccounting() {
  await fixture(async (_db, url, root, directory) => {
    const killed = await spawn(url, root)
    await acquire(killed)
    killed.kill('SIGKILL')
    assert.deepEqual(await exits.get(killed), [null, 'SIGKILL'])
    assert.deepEqual(await files(directory), [path.join(directory, 'existing.pdf')])
    const replacement = await spawn(url, root, 'image', 'orphan')
    await acquire(replacement)
    const orphan = await command(replacement)
    assert.equal(orphan.event, 'written', 'process death released the writer lock without stale lock cleanup')
    assert.ok(orphan.filename)
    replacement.kill('SIGKILL')
    assert.deepEqual(await exits.get(replacement), [null, 'SIGKILL'])
    const retry = await spawn(url, root, 'document')
    await acquire(retry)
    assert.deepEqual(await command(retry), { event: 'result', error: 'customer_upload_quota_exceeded' }, 'file written before metadata commit remains counted after death')
    assert.equal((await stat(orphan.filename)).size, 4 * 1024 * 1024)
    assert.equal((await files(directory)).length, 2)
  })
}

async function testExpiredTransactionCannotWrite() {
  await fixture(async (db, url, root, directory) => {
    const expired = await spawn(url, root, 'image', 'expire')
    await acquire(expired)
    // This independent writer can finish only after the paused child's timeout releases its lock.
    await db.$executeRaw`UPDATE "Customer" SET "id" = "id" WHERE "id" = ${customerId}`
    assert.deepEqual(await command(expired), { event: 'result', error: 'P2028', opens: 0 }, 'expired callback must fail before opening a file')
    assert.deepEqual(await files(directory), [path.join(directory, 'existing.pdf')])
    const replacement = await spawn(url, root)
    await acquire(replacement)
    const accepted = await command(replacement)
    assert.ok(accepted.filename)
    assert.equal((await files(directory)).length, 2, 'expired callback cannot write after a replacement fills the quota')
  })
}

async function main() {
  await testQuotaContention()
  await testFailedWriteReleasesLock()
  await testDeathAndOrphanAccounting()
  await testExpiredTransactionCannotWrite()
  console.log('upload process tests passed: shared WAL quota, partial write cleanup, death releases lock, orphan accounting, expired transaction fencing')
}

const timeout = setTimeout(() => {
  for (const child of children) child.kill('SIGKILL')
  throw new Error('upload process tests timed out')
}, 60_000)
main().catch((error) => { console.error(error); process.exitCode = 1 }).finally(() => clearTimeout(timeout))
