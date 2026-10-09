import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '@/app/generated/prisma/client'
import { INQUIRY_SOURCE, INQUIRY_COMPANY_ID, INQUIRY_HOMEPAGE_ID, INQUIRY_SCOPE_ID, SyncError } from './inquiry-sync'
import { dashboardDate, dashboardErrorText, parseDashboard, type DashboardRecord, type ExternalDashboard } from './external-dashboard'
import { dashboardKoreaDate, dashboardTimestamp, mergeDashboardHistory, parseHistoryDays, selectDashboardHistory, type DashboardHistory, type DashboardQuery } from './external-dashboard-history'

type Environment = { [key: string]: string | undefined; UPLOADS_DIR?: string }
const MAX_BYTES = 5 * 1024 * 1024
const MAX_HISTORY_BYTES = 32 * 1024 * 1024
const absent = (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
const invalid = (): never => { throw new Error('dashboard_storage_error') }

async function syncDirectory(folder: string) {
  if (process.platform === 'win32') return
  const fd = await open(folder, 'r')
  try { await fd.sync() } finally { await fd.close() }
}
async function directory(env: Environment, create: boolean, snapshots = false) {
  const root = path.resolve(env.UPLOADS_DIR || path.join(process.cwd(), 'uploads'))
  if (create) await mkdir(root, { recursive: true, mode: 0o700 })
  const directories = [root, path.join(root, '_reports'), path.join(root, '_reports', 'external-dashboard')]
  if (snapshots) directories.push(path.join(directories[2], 'snapshots'))
  for (const [index, current] of directories.entries()) {
    if (create && index > 0) {
      try { await mkdir(current, { mode: 0o700 }); await syncDirectory(path.dirname(current)) } catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error
      }
    }
    const info = await lstat(current)
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(current) !== current) return invalid()
  }
  return directories.at(-1)!
}

function parseRecord(value: unknown): DashboardRecord {
  if (!value || typeof value !== 'object') return invalid()
  const record = value as DashboardRecord
  const timestamp = dashboardTimestamp
  if (record.format !== 1 || record.source !== INQUIRY_SOURCE || record.companyScopeId !== INQUIRY_COMPANY_ID
    || record.homepageScopeId !== INQUIRY_HOMEPAGE_ID || !timestamp(record.lastAttemptAt)
    || (record.lastSuccessfulAt !== null && !timestamp(record.lastSuccessfulAt))
    || (record.error !== null && !Object.hasOwn(dashboardErrorText, record.error))
    || (record.data === null) !== (record.lastSuccessfulAt === null)) return invalid()
  const parsed: DashboardRecord = { format: 1, source: INQUIRY_SOURCE, companyScopeId: INQUIRY_COMPANY_ID, homepageScopeId: INQUIRY_HOMEPAGE_ID,
    lastAttemptAt: record.lastAttemptAt, lastSuccessfulAt: record.lastSuccessfulAt, error: record.error,
    data: record.data === null ? null : parseDashboard(record.data, record.data) }
  if (Buffer.byteLength(JSON.stringify(parsed)) > MAX_BYTES) return invalid()
  return parsed
}

async function readJson(file: string, maximum = MAX_BYTES): Promise<unknown | null> {
  try {
    const info = await lstat(file)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maximum) return invalid()
    const fd = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    try {
      const opened = await fd.stat()
      if (!opened.isFile() || opened.nlink !== 1 || opened.size > maximum || opened.ino !== info.ino || opened.dev !== info.dev) return invalid()
      const bytes = await fd.readFile()
      if (bytes.length > maximum) return invalid()
      const result: unknown = JSON.parse(bytes.toString('utf8'))
      if (result === null) return invalid()
      return result
    } finally { await fd.close() }
  } catch (error) {
    if (absent(error)) return null
    return invalid()
  }
}

async function storedJson(env: Environment, name: 'current.json' | 'history.json' | 'preserved-20261009.json') {
  let folder: string
  try { folder = await directory(env, false) } catch (error) { if (absent(error)) return null; throw error }
  return readJson(path.join(folder, name), name === 'history.json' ? MAX_HISTORY_BYTES : MAX_BYTES)
}
async function readPreserved(env: Environment) {
  // Explicit operator handoff file; never discover/import arbitrary upload paths.
  const value = await storedJson(env, 'preserved-20261009.json')
  return value === null ? null : parseRecord(value)
}
export async function readDashboardRecord(env: Environment = process.env): Promise<DashboardRecord | null> {
  const value = await storedJson(env, 'current.json')
  return value === null ? null : parseRecord(value)
}
async function readHistory(env: Environment): Promise<DashboardHistory | null> {
  const value = await storedJson(env, 'history.json') as DashboardHistory | null
  if (value === null) return null
  if (value.format !== 1) return invalid()
  const latest = parseRecord(value.latest)
  if (!latest.data || !latest.lastSuccessfulAt || latest.error || latest.lastAttemptAt !== latest.lastSuccessfulAt) return invalid()
  const days = parseHistoryDays(value.days)
  if (days.some(day => (day.view && day.view.collectedAt > latest.lastSuccessfulAt!) || day.media.some(row => row.collectedAt > latest.lastSuccessfulAt!))) return invalid()
  return { format: 1, days, latest }
}
async function snapshotDays(env: Environment) {
  let folder: string
  try { folder = await directory(env, false, true) } catch (error) { if (absent(error)) return []; throw error }
  const files = await readdir(folder, { withFileTypes: true })
  if (files.length > 50_000) return invalid()
  return files.flatMap(file => {
    // Interrupted, unpublished temp files carry no authority and are never read.
    if (/^[0-9a-f-]{36}\.tmp$/.test(file.name) && file.isFile()) return []
    if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(file.name) || !file.isFile() || file.isSymbolicLink()) return invalid()
    return [dashboardDate(file.name.slice(0, 10))]
  }).sort()
}
async function readSnapshot(env: Environment, day: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return invalid()
  let folder: string
  try { folder = await directory(env, false, true) } catch (error) { if (absent(error)) return null; throw error }
  const value = await readJson(path.join(folder, day + '.json'))
  if (value === null) return null
  const record = parseRecord(value)
  if (!record.data || !record.lastSuccessfulAt || record.error || record.lastAttemptAt !== record.lastSuccessfulAt
    || dashboardKoreaDate(new Date(record.lastSuccessfulAt)) !== day) return invalid()
  return record
}

export async function readDashboardHistory(query: DashboardQuery, env: Environment = process.env, now = new Date()) {
  // Authenticated GETs remain read-only. The durable old current is merged in memory;
  // the sole fenced worker archives it before any replacement (including errors).
  const [record, preserved, stored, archivedDays] = await Promise.all([readDashboardRecord(env), readPreserved(env), readHistory(env), snapshotDays(env)])
  if (!stored && archivedDays.length) return invalid()
  const baseline = preserved ? mergeDashboardHistory(stored, preserved) : stored
  const history = record ? mergeDashboardHistory(baseline, record) : baseline
  const latest = history?.latest ?? null
  const latestDay = latest?.lastSuccessfulAt ? dashboardKoreaDate(new Date(latest.lastSuccessfulAt)) : null
  const candidates = [preserved, record, latest].filter((item): item is DashboardRecord => Boolean(item?.data && item.lastSuccessfulAt))
  const days = [...new Set([...archivedDays, ...candidates.map(item => dashboardKoreaDate(new Date(item.lastSuccessfulAt!)))])].sort().reverse()
  let snapshot = latest
  if (query.snapshot && query.snapshot !== latestDay) {
    snapshot = [await readSnapshot(env, query.snapshot), ...candidates.filter(item => dashboardKoreaDate(new Date(item.lastSuccessfulAt!)) === query.snapshot)]
      .filter((item): item is DashboardRecord => Boolean(item)).sort((a, b) => b.lastSuccessfulAt!.localeCompare(a.lastSuccessfulAt!))[0] ?? null
    if (!snapshot) throw new Error('dashboard_snapshot_missing')
  }
  return { record, history: selectDashboardHistory(history, record, query, snapshot, days, Boolean(stored), now) }
}

async function publish(env: Environment, file: string, value: unknown, maximum: number, fence: () => Promise<void>) {
  const contents = JSON.stringify(value)
  if (Buffer.byteLength(contents) > maximum) return invalid()
  const folder = await directory(env, true, path.basename(path.dirname(file)) === 'snapshots')
  if (path.dirname(file) !== folder) return invalid()
  // Never silently repair/replace a link, corrupt file, or unrecognized object.
  await readJson(file, maximum)
  const temporary = path.join(folder, `${randomUUID()}.tmp`)
  try {
    const fd = await open(temporary, 'wx', 0o600)
    try { await fd.writeFile(contents); await fd.sync() } finally { await fd.close() }
    if (await directory(env, false, path.basename(folder) === 'snapshots') !== folder) return invalid()
    await fence()
    await rename(temporary, file)
    await syncDirectory(folder)
  } finally { await unlink(temporary).catch(error => { if (!absent(error)) throw error }) }
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
    let history = await readHistory(env)
    if (!history && (await snapshotDays(env)).length) return invalid()
    const folder = await directory(env, true)
    const fence = async () => {
      const stillOwned = await tx.inquirySyncState.findFirst({
        where: { id: INQUIRY_SCOPE_ID, workerOwner: owner, workerLeaseExpiresAt: { gt: new Date() } }, select: { id: true },
      })
      if (!stillOwned) throw new SyncError('lost_worker_lease')
    }
    const archive = async (record: DashboardRecord) => {
      const day = dashboardKoreaDate(new Date(record.lastSuccessfulAt!))
      const old = await readSnapshot(env, day)
      if (old?.lastSuccessfulAt && (old.lastSuccessfulAt > record.lastSuccessfulAt!
        || (old.lastSuccessfulAt === record.lastSuccessfulAt && JSON.stringify(old) === JSON.stringify(record)))) return
      const snapshots = await directory(env, true, true)
      await publish(env, path.join(snapshots, day + '.json'), record, MAX_BYTES, fence)
    }
    const preserve = async (record: DashboardRecord | null) => {
      if (!record?.data || !record.lastSuccessfulAt) return
      const merged = mergeDashboardHistory(history, record)!
      // The durable journal must itself satisfy the next reader's limits.
      parseHistoryDays(merged.days)
      await publish(env, path.join(folder, 'history.json'), merged, MAX_HISTORY_BYTES, fence)
      history = merged
      await archive({ ...record, lastAttemptAt: record.lastSuccessfulAt, error: null })
    }
    // history.latest is the durable journal: finish its daily archive after a crash
    // before publishing any newer history. No deletion or multi-file atomicity claim.
    if (history) await archive(history.latest)
    await preserve(await readPreserved(env))
    await preserve(previous)
    const record = parseRecord({
      format: 1, source: INQUIRY_SOURCE, companyScopeId: INQUIRY_COMPANY_ID, homepageScopeId: INQUIRY_HOMEPAGE_ID,
      lastAttemptAt: now.toISOString(), lastSuccessfulAt: result.data ? now.toISOString() : previous?.lastSuccessfulAt ?? null,
      data: result.data ? parseDashboard(result.data, result.data) : previous?.data ?? null,
      error: result.error ?? null,
    })
    if (result.data) await preserve(record)
    await publish(env, path.join(folder, 'current.json'), record, MAX_BYTES, fence)
    return record
  }, { maxWait: 5_000, timeout: 10_000 })
}
