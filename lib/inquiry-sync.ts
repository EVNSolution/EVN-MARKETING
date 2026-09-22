import { randomUUID } from 'node:crypto'
import type { Prisma, PrismaClient } from '@/app/generated/prisma/client'

export const INQUIRY_SOURCE = 'mleverage-admin'
export const INQUIRY_COMPANY_ID = '55f9a8bb-73f9-4316-bcd7-7dcdce0bdcc3'
export const INQUIRY_HOMEPAGE_ID = '5c7a6115-a0a9-4e8d-bf65-efce52195fa4'
export const INQUIRY_SCOPE_ID = `${INQUIRY_SOURCE}:${INQUIRY_COMPANY_ID}:${INQUIRY_HOMEPAGE_ID}`
export const INQUIRY_START_DATE = '2000-01-01'
export const INQUIRY_PAGE_SIZE = 200
const BLOCKING_STATUSES = ['login_required', 'credentials_invalid', 'credentials_missing', 'source_credentials_incomplete', 'source_credentials_missing', 'login_retry_exhausted']

type Db = PrismaClient | Prisma.TransactionClient

export type RawInquiry = {
  sourceId: string
  inquiryDate: string
  inquiryTime: string
  sourceStatus: string | null
  name: string | null
  phone: string
}

export type SourcePage = {
  page: number
  total: number
  rows: RawInquiry[]
}

export type ReconcileResult = {
  status: string
  errorType?: string
  expectedCount: number | null
  pagesRead: number
  readCount: number
  createdCount: number
  updatedCount: number
  unchangedCount: number
}

export class SyncError extends Error {
  constructor(public readonly type: string) {
    super(type)
  }
}

export function normalizeInquiry(raw: RawInquiry): RawInquiry {
  const sourceId = raw.sourceId.trim().toLowerCase()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(sourceId)) {
    throw new SyncError('invalid_source_id')
  }

  const dateMatch = raw.inquiryDate.trim().match(/^(\d{4}-\d{2}-\d{2})(?: \([^)]+\))?$/)
  if (!dateMatch || !isCalendarDate(dateMatch[1])) throw new SyncError('invalid_date')

  const inquiryTime = raw.inquiryTime.trim()
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(inquiryTime)) throw new SyncError('invalid_time')

  const phone = raw.phone.trim()
  if (!phone || phone === '-') throw new SyncError('invalid_phone')

  const name = raw.name?.trim()
  const sourceStatus = raw.sourceStatus?.trim()
  return {
    sourceId,
    inquiryDate: dateMatch[1],
    inquiryTime,
    sourceStatus: !sourceStatus || sourceStatus === '상태 선택' ? null : sourceStatus,
    name: !name || name === '-' ? null : name,
    phone,
  }
}

function isCalendarDate(value: string) {
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

export function koreaDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now)
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value
  return `${get('year')}-${get('month')}-${get('day')}`
}

export function manualSyncError(
  role: string | undefined,
  requestUrl: string,
  origin: string | null,
  host?: string | null,
  protocol?: string | null,
) {
  if (!role) return 401
  if (role !== 'admin') return 403
  if (!origin) return 400
  try {
    const expected = new URL(requestUrl)
    if (host) expected.host = host.split(',')[0].trim()
    const forwardedProtocol = protocol?.split(',')[0].trim().replace(/:$/, '')
    if (forwardedProtocol && forwardedProtocol !== 'http' && forwardedProtocol !== 'https') return 400
    if (forwardedProtocol) expected.protocol = `${forwardedProtocol}:`
    return new URL(origin).origin === expected.origin ? null : 400
  } catch {
    return 400
  }
}

export function inquirySyncStatus(
  state: { status: string; workerHeartbeatAt: Date | null } | null,
  activeStatus?: string,
  now = new Date(),
) {
  if (!state?.workerHeartbeatAt || now.getTime() - state.workerHeartbeatAt.getTime() > 180_000) return 'offline'
  if (BLOCKING_STATUSES.includes(state.status)) return state.status
  return activeStatus ?? state.status
}

export async function ensureSyncState(db: Db) {
  return db.inquirySyncState.upsert({
    where: { id: INQUIRY_SCOPE_ID },
    update: {},
    create: {
      id: INQUIRY_SCOPE_ID,
      source: INQUIRY_SOURCE,
      companyScopeId: INQUIRY_COMPANY_ID,
      homepageScopeId: INQUIRY_HOMEPAGE_ID,
      status: 'offline',
    },
  })
}

export async function enqueueSync(db: PrismaClient, trigger: 'manual' | 'hourly', endDate = koreaDate()) {
  return db.$transaction(async (tx) => {
    await ensureSyncState(tx)
    const state = await tx.inquirySyncState.update({ where: { id: INQUIRY_SCOPE_ID }, data: { updatedAt: new Date() } })
    if (BLOCKING_STATUSES.includes(state.status)) return null
    const active = await tx.inquirySyncRun.findFirst({
      where: { source: INQUIRY_SOURCE, companyScopeId: INQUIRY_COMPANY_ID, homepageScopeId: INQUIRY_HOMEPAGE_ID, status: { in: ['pending', 'running'] } },
      select: { id: true },
    })
    if (active) return null
    return tx.inquirySyncRun.create({
      data: {
        source: INQUIRY_SOURCE,
        companyScopeId: INQUIRY_COMPANY_ID,
        homepageScopeId: INQUIRY_HOMEPAGE_ID,
        trigger,
        rangeStart: INQUIRY_START_DATE,
        rangeEnd: endDate,
      },
    })
  })
}

export async function claimWorker(db: PrismaClient, owner: string, now = new Date()) {
  await ensureSyncState(db)
  const claimed = await db.inquirySyncState.updateMany({
    where: { id: INQUIRY_SCOPE_ID, OR: [{ workerOwner: null }, { workerOwner: owner }, { workerLeaseExpiresAt: { lt: now } }] },
    data: { workerOwner: owner, workerHeartbeatAt: now, workerLeaseExpiresAt: new Date(now.getTime() + 180_000) },
  })
  return claimed.count === 1
}

export async function heartbeatWorker(db: PrismaClient, owner: string, now = new Date()) {
  const renewed = await db.inquirySyncState.updateMany({
    where: { id: INQUIRY_SCOPE_ID, workerOwner: owner, workerLeaseExpiresAt: { gt: now } },
    data: { workerHeartbeatAt: now, workerLeaseExpiresAt: new Date(now.getTime() + 180_000) },
  })
  if (renewed.count !== 1) throw new SyncError('lost_worker_lease')
}

export async function releaseWorker(db: PrismaClient, owner: string, now = new Date(), status = 'offline') {
  await db.inquirySyncState.updateMany({
    where: { id: INQUIRY_SCOPE_ID, workerOwner: owner },
    data: { status, workerHeartbeatAt: now, workerOwner: null, workerLeaseExpiresAt: null },
  })
}

export async function claimNextRun(db: PrismaClient, now = new Date(), owner: string = randomUUID(), executionEndDate?: string) {
  await ensureSyncState(db)
  const run = await db.inquirySyncRun.findFirst({
    where: { source: INQUIRY_SOURCE, companyScopeId: INQUIRY_COMPANY_ID, homepageScopeId: INQUIRY_HOMEPAGE_ID, status: 'pending' },
    orderBy: { createdAt: 'asc' },
  })
  if (!run) return null

  const rangeEnd = executionEndDate ?? run.rangeEnd
  if (!isCalendarDate(rangeEnd) || rangeEnd < run.rangeStart) throw new SyncError('invalid_range')
  const lockExpiresAt = new Date(now.getTime() + 3 * 60_000)
  const locked = await db.inquirySyncState.updateMany({
    where: {
      id: INQUIRY_SCOPE_ID,
      status: { notIn: BLOCKING_STATUSES },
      AND: [
        { OR: [{ workerOwner: null }, { workerOwner: owner }, { workerLeaseExpiresAt: { lt: now } }] },
        { OR: [{ lockExpiresAt: null }, { lockExpiresAt: { lt: now } }] },
      ],
    },
    data: {
      workerOwner: owner,
      workerHeartbeatAt: now,
      workerLeaseExpiresAt: new Date(now.getTime() + 180_000),
      lockOwner: owner,
      lockExpiresAt,
      status: 'running',
      lastRunId: run.id,
    },
  })
  if (locked.count !== 1) return null

  const started = await db.inquirySyncRun.updateMany({
    where: { id: run.id, status: 'pending' },
    data: { status: 'running', rangeEnd, startedAt: now, heartbeatAt: now },
  })
  if (started.count !== 1) {
    await db.inquirySyncState.updateMany({ where: { id: INQUIRY_SCOPE_ID, lockOwner: owner }, data: { lockOwner: null, lockExpiresAt: null } })
    return null
  }
  return { ...run, rangeEnd, owner }
}

export async function recoverStaleRuns(db: PrismaClient, now = new Date()) {
  const staleBefore = new Date(now.getTime() - 3 * 60_000)
  await db.inquirySyncRun.updateMany({
    where: {
      source: INQUIRY_SOURCE,
      companyScopeId: INQUIRY_COMPANY_ID,
      homepageScopeId: INQUIRY_HOMEPAGE_ID,
      status: 'running',
      OR: [{ heartbeatAt: null }, { heartbeatAt: { lt: staleBefore } }],
    },
    data: { status: 'partial', completedAt: now, errorType: 'stale_worker' },
  })
  await db.inquirySyncState.updateMany({
    where: { id: INQUIRY_SCOPE_ID, lockExpiresAt: { lt: now } },
    data: { status: 'partial', lockOwner: null, lockExpiresAt: null },
  })
  await db.inquirySyncState.updateMany({
    where: { id: INQUIRY_SCOPE_ID, workerLeaseExpiresAt: { lt: now } },
    data: { status: 'offline', workerOwner: null, workerLeaseExpiresAt: null },
  })
}

type Outcome = 'created' | 'unchanged'

export async function reconcile(
  db: PrismaClient,
  runId: string,
  owner: string,
  rangeStart: string,
  rangeEnd: string,
  fetchPage: (page: number, previousFirstPageIds?: string[]) => Promise<SourcePage>,
  now = () => new Date(),
): Promise<ReconcileResult> {
  const outcomes = new Map<string, Outcome>()
  let pagesRead = 0
  let expectedCount: number | null = null

  try {
    const cutoff = (await db.inquirySyncState.findUniqueOrThrow({
      where: { id: INQUIRY_SCOPE_ID },
      select: { lastSuccessfulAt: true },
    })).lastSuccessfulAt

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const seen = new Set<string>()
        let firstPageIds: string[] = []
        let attemptTotal: number | null = null
        let previousSortKey: string | null = null
        let stoppedAtCutoff = false
        let attemptPages = 0
        let page = 1

        while (true) {
          await heartbeat(db, runId, owner, now())
          const sourcePage = validatePage(await fetchPage(page, page === 1 ? undefined : firstPageIds), page)
          attemptTotal ??= sourcePage.total
          if (sourcePage.total !== attemptTotal) throw new SyncError('shifting_count')
          expectedCount = sourcePage.total

          const rows = sourcePage.rows.map(normalizeInquiry)
          const pageIds = new Set<string>()
          for (const row of rows) {
            if (row.inquiryDate < rangeStart || row.inquiryDate > rangeEnd) throw new SyncError('date_out_of_range')
            const sortKey = `${row.inquiryDate} ${row.inquiryTime}`
            if (previousSortKey && sortKey > previousSortKey) throw new SyncError('unexpected_order')
            previousSortKey = sortKey
            if (pageIds.has(row.sourceId)) throw new SyncError('duplicate_source_id')
            if (seen.has(row.sourceId)) throw new SyncError('shifting_count')
            pageIds.add(row.sourceId)
            seen.add(row.sourceId)
          }
          if (page === 1) firstPageIds = rows.map((row) => row.sourceId)

          const saved = await savePage(db, runId, owner, rows, cutoff, now())
          for (const [id, outcome] of saved.outcomes) {
            const prior = outcomes.get(id)
            if (!prior || prior === 'unchanged') outcomes.set(id, outcome)
          }
          pagesRead++
          attemptPages++
          await updateRunCounts(db, runId, owner, expectedCount, pagesRead, outcomes, now())

          if (saved.reachedCutoff) {
            stoppedAtCutoff = true
            break
          }
          if (seen.size === sourcePage.total) break
          if (rows.length === 0 || page >= Math.ceil(sourcePage.total / INQUIRY_PAGE_SIZE)) throw new SyncError('count_mismatch')
          page++
        }

        if (!stoppedAtCutoff && seen.size !== attemptTotal) throw new SyncError('count_mismatch')
        if (attemptPages > 1) {
          const probe = validatePage(await fetchPage(1, firstPageIds), 1)
          const probeRows = probe.rows.map(normalizeInquiry)
          let probeSortKey: string | null = null
          for (const row of probeRows) {
            if (row.inquiryDate < rangeStart || row.inquiryDate > rangeEnd) throw new SyncError('date_out_of_range')
            const sortKey = `${row.inquiryDate} ${row.inquiryTime}`
            if (probeSortKey && sortKey > probeSortKey) throw new SyncError('unexpected_order')
            probeSortKey = sortKey
          }
          const probeIds = probeRows.map((row) => row.sourceId)
          if (probe.total !== attemptTotal || probeIds.join() !== firstPageIds.join()) throw new SyncError('shifting_count')
        }
        return { status: 'success' as const, expectedCount, pagesRead, ...countOutcomes(outcomes) }
      } catch (error) {
        if (attempt === 0 && error instanceof SyncError && error.type === 'shifting_count') continue
        throw error
      }
    }
    throw new SyncError('shifting_count')
  } catch (error) {
    const errorType = error instanceof SyncError ? error.type : 'page_error'
    const readCount = outcomes.size
    const status = errorType === 'login_required' ? 'login_required' : errorType.startsWith('offline_') ? 'offline' : readCount ? 'partial' : 'failed'
    return { status, errorType, expectedCount, pagesRead, ...countOutcomes(outcomes) }
  }
}

function validatePage(sourcePage: SourcePage, expectedPage: number) {
  if (sourcePage.page !== expectedPage || !Number.isSafeInteger(sourcePage.total) || sourcePage.total < 0) throw new SyncError('invalid_total')
  const expectedRows = Math.min(INQUIRY_PAGE_SIZE, Math.max(0, sourcePage.total - (expectedPage - 1) * INQUIRY_PAGE_SIZE))
  if (sourcePage.rows.length !== expectedRows) throw new SyncError('count_mismatch')
  return sourcePage
}

type StoredInquiry = {
  sourceId: string
  firstSeenAt: Date
}

async function savePage(db: PrismaClient, runId: string, owner: string, rows: RawInquiry[], cutoff: Date | null, seenAt: Date) {
  if (!rows.length) return { outcomes: new Map<string, Outcome>(), reachedCutoff: false }
  return db.$transaction(async (tx) => {
    await assertLease(tx, runId, owner, seenAt)
    const existing: StoredInquiry[] = await tx.inquiry.findMany({
      where: { source: INQUIRY_SOURCE, companyScopeId: INQUIRY_COMPANY_ID, homepageScopeId: INQUIRY_HOMEPAGE_ID, sourceId: { in: rows.map((row) => row.sourceId) } },
      select: { sourceId: true, firstSeenAt: true },
    })
    const bySourceId = new Map(existing.map((row) => [row.sourceId, row]))
    const saved = new Map<string, Outcome>()
    for (const row of rows) {
      const current = bySourceId.get(row.sourceId)
      if (!current) {
        await tx.inquiry.create({ data: { ...row, source: INQUIRY_SOURCE, companyScopeId: INQUIRY_COMPANY_ID, homepageScopeId: INQUIRY_HOMEPAGE_ID, firstSeenAt: seenAt, lastSeenAt: seenAt } })
        saved.set(row.sourceId, 'created')
        continue
      }
      saved.set(row.sourceId, 'unchanged')
    }
    return { outcomes: saved, reachedCutoff: Boolean(cutoff && existing.some((row) => row.firstSeenAt <= cutoff)) }
  })
}

function countOutcomes(outcomes: Map<string, Outcome>) {
  const counts = { readCount: outcomes.size, createdCount: 0, updatedCount: 0, unchangedCount: 0 }
  for (const outcome of outcomes.values()) counts[`${outcome}Count`]++
  return counts
}

async function heartbeat(db: PrismaClient, runId: string, owner: string, at: Date) {
  await db.$transaction(async (tx) => {
    await assertLease(tx, runId, owner, at)
    await tx.inquirySyncRun.update({ where: { id: runId }, data: { heartbeatAt: at } })
    await tx.inquirySyncState.update({
      where: { id: INQUIRY_SCOPE_ID },
      data: {
        lockExpiresAt: new Date(at.getTime() + 3 * 60_000),
        workerHeartbeatAt: at,
        workerLeaseExpiresAt: new Date(at.getTime() + 180_000),
      },
    })
  })
}

async function updateRunCounts(db: PrismaClient, runId: string, owner: string, expectedCount: number, pagesRead: number, outcomes: Map<string, Outcome>, at: Date) {
  await db.$transaction(async (tx) => {
    await assertLease(tx, runId, owner, at)
    await tx.inquirySyncRun.update({ where: { id: runId }, data: { expectedCount, pagesRead, heartbeatAt: at, ...countOutcomes(outcomes) } })
  })
}

export async function finishRun(db: PrismaClient, runId: string, owner: string, result: ReconcileResult, at = new Date()) {
  await db.$transaction(async (tx) => {
    await assertLease(tx, runId, owner, at)
    await tx.inquirySyncRun.update({
      where: { id: runId },
      data: { ...result, completedAt: at, heartbeatAt: at },
    })
    await tx.inquirySyncState.update({
      where: { id: INQUIRY_SCOPE_ID },
      data: {
        status: result.status,
        lastRunId: runId,
        lastSuccessfulAt: result.status === 'success' ? at : undefined,
        nextRunAt: new Date(at.getTime() + 60 * 60_000),
        lockOwner: null,
        lockExpiresAt: null,
      },
    })
  })
}

async function assertLease(tx: Prisma.TransactionClient, runId: string, owner: string, at: Date) {
  const [state, run] = await Promise.all([
    tx.inquirySyncState.findFirst({
      where: {
        id: INQUIRY_SCOPE_ID,
        lastRunId: runId,
        lockOwner: owner,
        lockExpiresAt: { gt: at },
        workerOwner: owner,
        workerLeaseExpiresAt: { gt: at },
      },
      select: { id: true },
    }),
    tx.inquirySyncRun.findFirst({ where: { id: runId, status: 'running' }, select: { id: true } }),
  ])
  if (!state || !run) throw new SyncError('lost_lease')
}
