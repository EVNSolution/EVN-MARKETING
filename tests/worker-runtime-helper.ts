import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import { PrismaClient } from '@/app/generated/prisma/client'

export async function withWorkerDatabase(run: (worker: PrismaClient, inspect: PrismaClient) => Promise<void>, extraMigrations: string[] = []) {
  const temp = await mkdtemp(path.join(tmpdir(), 'evn-worker-test-'))
  const url = `file:${path.join(temp, 'test.db')}`
  const setup = await adapter(url).connect()
  try {
    for (const migration of ['20260915000100_baseline', '20260915000200_inquiry_sync', '20260915000300_warp_delivery', ...extraMigrations]) {
      await setup.executeScript(await readFile(path.join('prisma/migrations', migration, 'migration.sql'), 'utf8'))
    }
  } finally {
    await setup.dispose()
  }

  const worker = new PrismaClient({ adapter: adapter(url) })
  const inspect = new PrismaClient({ adapter: adapter(url) })
  try {
    await run(worker, inspect)
  } finally {
    await Promise.allSettled([worker.$disconnect(), inspect.$disconnect()])
    await rm(temp, { recursive: true, force: true })
  }
}

function adapter(url: string) {
  return new PrismaBetterSqlite3({ url, timeout: 5000 }, { timestampFormat: 'iso8601' })
}
