import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { PrismaClient, Prisma } from '@/app/generated/prisma/client'
import { INQUIRY_SCOPE_ID, SyncError } from './inquiry-sync'
import type { Env } from './warp-delivery'
import type { NameJob } from './warp-customer-name'

const MAX = 1024 * 1024
const absent = (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
const invalid = (): never => { throw new Error('name_review_storage_unavailable') }
async function folder(env: Env) {
  const root = path.resolve(env.UPLOADS_DIR || path.join(process.cwd(), 'uploads'))
  await mkdir(root, { recursive: true, mode: 0o700 })
  const directories = [root, path.join(root, '_reports'), path.join(root, '_reports/warp-customer-name')]
  for (const [index, directory] of directories.entries()) {
    if (index) await mkdir(directory, { mode: 0o700 }).catch(error => { if (error?.code !== 'EEXIST') throw error })
    const stat = await lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== directory) return invalid()
  }
  return directories[2]
}
async function read(file: string): Promise<NameJob[]> {
  try {
    const stat = await lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX) return invalid()
    const fd = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    try {
      const opened = await fd.stat()
      if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.nlink !== 1 || opened.size > MAX) return invalid()
      const bytes = await fd.readFile()
      if (bytes.length > MAX) return invalid()
      const value = JSON.parse(bytes.toString('utf8'))
      if (value.version !== 1 || !Array.isArray(value.jobs) || value.jobs.length > 100) return invalid()
      for (const job of value.jobs) {
        if (!job || !/^[0-9a-f-]{36}$/.test(job.id) || !/^[A-Za-z0-9_-]{1,160}$/.test(job.inquiryId)
          || !/^[A-Za-z0-9_-]{1,160}$/.test(job.candidateId) || !/^[a-f0-9]{64}$/.test(job.reviewToken)
          || !job.actor || typeof job.actor.id !== 'string' || typeof job.actor.name !== 'string'
          || !Number.isSafeInteger(job.createdAt) || !Number.isSafeInteger(job.updatedAt)
          || !['preview', 'ready', 'confirm', 'done', 'failed'].includes(job.phase)
          || !Number.isInteger(job.attempts) || job.attempts < 0 || job.attempts > 3) return invalid()
      }
      return value.jobs
    } finally { await fd.close() }
  } catch (error) { if (absent(error)) return []; return invalid() }
}

/** SQLite's existing writer lock serializes web commands and fenced worker publication. */
export async function withNameJobs<T>(db: PrismaClient, env: Env,
  change: (jobs: NameJob[], tx: Prisma.TransactionClient) => Promise<T>, now: Date, owner?: string): Promise<T> {
  const directory = await folder(env), file = path.join(directory, 'pending.json')
  return db.$transaction(async tx => {
    await tx.$executeRaw`UPDATE "InquirySyncState" SET "updatedAt" = "updatedAt" WHERE "id" = ${INQUIRY_SCOPE_ID}`
    const fence = async () => {
      if (!owner) return
      const lease = await tx.inquirySyncState.findUnique({ where: { id: INQUIRY_SCOPE_ID } })
      if (lease?.workerOwner !== owner || !lease.workerLeaseExpiresAt || lease.workerLeaseExpiresAt <= now) throw new SyncError('lost_worker_lease')
    }
    await fence()
    const before = await read(file)
    // Short-lived review data only. Permanent change evidence lives in WARP's customer activity.
    const jobs = before.filter(job => job.createdAt > now.getTime() - 20 * 60_000)
    const original = JSON.stringify(before)
    const result = await change(jobs, tx)
    if (JSON.stringify(jobs) === original) return result
    const contents = JSON.stringify({ version: 1, jobs })
    if (Buffer.byteLength(contents) > MAX) return invalid()
    const temporary = path.join(directory, `${randomUUID()}.tmp`)
    try {
      const fd = await open(temporary, 'wx', 0o600)
      try { await fd.writeFile(contents); await fd.sync() } finally { await fd.close() }
      await fence()
      await rename(temporary, file)
      if (process.platform !== 'win32') {
        const dir = await open(directory, 'r'); try { await dir.sync() } finally { await dir.close() }
      }
    } finally { await unlink(temporary).catch(error => { if (!absent(error)) throw error }) }
    return result
  }, { timeout: 10_000 })
}
