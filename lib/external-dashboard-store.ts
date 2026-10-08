import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '@/app/generated/prisma/client'
import { INQUIRY_SOURCE, INQUIRY_COMPANY_ID, INQUIRY_HOMEPAGE_ID, INQUIRY_SCOPE_ID, SyncError } from './inquiry-sync'
import { dashboardErrorText, parseDashboard, type DashboardRecord, type ExternalDashboard } from './external-dashboard'

type Environment = { [key: string]: string | undefined; UPLOADS_DIR?: string }
const MAX_BYTES = 5 * 1024 * 1024
const absent = (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
const invalid = (): never => { throw new Error('dashboard_storage_error') }

async function directory(env: Environment, create: boolean) {
  const root = path.resolve(env.UPLOADS_DIR || path.join(process.cwd(), 'uploads'))
  if (create) await mkdir(root, { recursive: true, mode: 0o700 })
  const directories = [root, path.join(root, '_reports'), path.join(root, '_reports', 'external-dashboard')]
  for (const [index, current] of directories.entries()) {
    if (create && index > 0) {
      try { await mkdir(current, { mode: 0o700 }) } catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error
      }
    }
    const info = await lstat(current)
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(current) !== current) return invalid()
  }
  return directories[2]
}

function parseRecord(value: unknown): DashboardRecord {
  if (!value || typeof value !== 'object') return invalid()
  const record = value as DashboardRecord
  const timestamp = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
  if (record.format !== 1 || record.source !== INQUIRY_SOURCE || record.companyScopeId !== INQUIRY_COMPANY_ID
    || record.homepageScopeId !== INQUIRY_HOMEPAGE_ID || !timestamp(record.lastAttemptAt)
    || (record.lastSuccessfulAt !== null && !timestamp(record.lastSuccessfulAt))
    || (record.error !== null && !Object.hasOwn(dashboardErrorText, record.error))
    || (record.data === null) !== (record.lastSuccessfulAt === null)) return invalid()
  return { format: 1, source: INQUIRY_SOURCE, companyScopeId: INQUIRY_COMPANY_ID, homepageScopeId: INQUIRY_HOMEPAGE_ID,
    lastAttemptAt: record.lastAttemptAt, lastSuccessfulAt: record.lastSuccessfulAt, error: record.error,
    data: record.data === null ? null : parseDashboard(record.data, record.data) }
}

export async function readDashboardRecord(env: Environment = process.env): Promise<DashboardRecord | null> {
  let file: string
  try { file = path.join(await directory(env, false), 'current.json') } catch (error) {
    if (absent(error)) return null
    throw error
  }
  try {
    const info = await lstat(file)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_BYTES) return invalid()
    const fd = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    try {
      const opened = await fd.stat()
      if (!opened.isFile() || opened.nlink !== 1 || opened.size > MAX_BYTES || opened.ino !== info.ino) return invalid()
      const bytes = await fd.readFile()
      if (bytes.length > MAX_BYTES) return invalid()
      return parseRecord(JSON.parse(bytes.toString('utf8')))
    } finally { await fd.close() }
  } catch (error) {
    if (absent(error)) return null
    return invalid()
  }
}

export async function saveDashboardRecord(
  db: PrismaClient, owner: string, result: { data: ExternalDashboard; error?: never } | { data?: never; error: string },
  env: Environment = process.env, now = new Date(),
) {
  if (result.error && !Object.hasOwn(dashboardErrorText, result.error)) return invalid()
  return db.$transaction(async tx => {
    // The existing worker lease and SQLite writer lock also fence atomic file publication.
    const lease = await tx.inquirySyncState.updateMany({
      where: { id: INQUIRY_SCOPE_ID, workerOwner: owner, workerLeaseExpiresAt: { gt: now } },
      data: { updatedAt: now },
    })
    if (lease.count !== 1) throw new SyncError('lost_worker_lease')
    const previous = await readDashboardRecord(env)
    const record: DashboardRecord = {
      format: 1, source: INQUIRY_SOURCE, companyScopeId: INQUIRY_COMPANY_ID, homepageScopeId: INQUIRY_HOMEPAGE_ID,
      lastAttemptAt: now.toISOString(), lastSuccessfulAt: result.data ? now.toISOString() : previous?.lastSuccessfulAt ?? null,
      data: result.data ? parseDashboard(result.data, result.data) : previous?.data ?? null,
      error: result.error ?? null,
    }
    const contents = JSON.stringify(record)
    if (Buffer.byteLength(contents) > MAX_BYTES) return invalid()
    const folder = await directory(env, true)
    const temporary = path.join(folder, `${randomUUID()}.tmp`)
    try {
      const fd = await open(temporary, 'wx', 0o600)
      try { await fd.writeFile(contents); await fd.sync() } finally { await fd.close() }
      const stillOwned = await tx.inquirySyncState.findFirst({
        where: { id: INQUIRY_SCOPE_ID, workerOwner: owner, workerLeaseExpiresAt: { gt: new Date() } }, select: { id: true },
      })
      if (!stillOwned) throw new SyncError('lost_worker_lease')
      await rename(temporary, path.join(folder, 'current.json'))
      if (process.platform !== 'win32') {
        const dir = await open(folder, 'r')
        try { await dir.sync() } finally { await dir.close() }
      }
    } finally { await unlink(temporary).catch(error => { if (!absent(error)) throw error }) }
    return record
  }, { maxWait: 5_000, timeout: 10_000 })
}
