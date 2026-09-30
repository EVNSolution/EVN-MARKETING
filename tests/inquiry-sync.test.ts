import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createClient } from '@libsql/client'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import { PrismaClient } from '@/app/generated/prisma/client'
import {
  INQUIRY_SCOPE_ID,
  SyncError,
  claimNextRun,
  claimWorker,
  enqueueSync,
  finishRun,
  heartbeatWorker,
  inquirySyncStatus,
  manualSyncError,
  normalizeInquiry,
  reconcile,
  recoverStaleRuns,
  releaseWorker,
  type RawInquiry,
  type SourcePage,
} from '@/lib/inquiry-sync'
import { safeNetworkErrorType } from '@/workers/mleverage-source'

const TEST_OWNER = 'synthetic-worker'
const root = process.cwd()
const baseline = path.join(root, 'prisma/migrations/20260915000100_baseline/migration.sql')
const additive = path.join(root, 'prisma/migrations/20260915000200_inquiry_sync/migration.sql')
const warpDelivery = path.join(root, 'prisma/migrations/20260915000300_warp_delivery/migration.sql')

async function main() {
  const temp = await mkdtemp(path.join(tmpdir(), 'evn-inquiry-test-'))
  const databaseUrl = `file:${path.join(temp, 'test.db')}`
  const sql = createClient({ url: databaseUrl })
  await sql.executeMultiple(await readFile(baseline, 'utf8'))
  await sql.execute({
    sql: 'INSERT INTO User (id, name, email, password, role, updatedAt) VALUES (?, ?, ?, ?, ?, ?)',
    args: ['synthetic-admin', '합성 관리자', 'admin@example.invalid', 'synthetic-hash', 'admin', new Date()],
  })
  await sql.executeMultiple(await readFile(additive, 'utf8'))
  await sql.executeMultiple(await readFile(warpDelivery, 'utf8'))
  await sql.close()

  const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: databaseUrl, timeout: 5000 }, { timestampFormat: 'iso8601' }) })
  try {
    assert.equal(await prisma.user.count(), 1, 'additive migration preserves the baseline user')
    testValidation()
    await testSync(prisma)
    await testCutoffProbeChange(prisma)
    await testChangingCount(prisma)
    await testProbeChange(prisma)
    await testRangeAndLease(prisma)
    await testStaleRecovery(prisma)
    await testLoginRequired(prisma)
    await testWorkerLease(prisma)
    await testInterruptedClaim(prisma)
    console.log('inquiry sync tests passed')
  } finally {
    await prisma.$disconnect()
    await rm(temp, { recursive: true, force: true })
  }
}

async function testInterruptedClaim(prisma: PrismaClient) {
  for (const stage of ['lock', 'start']) {
    const pending = await enqueueSync(prisma, 'manual', '2026-09-22')
    assert.ok(pending)
    const before = await prisma.inquirySyncState.findUniqueOrThrow({ where: { id: INQUIRY_SCOPE_ID } })
    const controller = new AbortController()
    const interrupted = prisma.$extends({ query: {
      inquirySyncState: { async updateMany({ args, query }) {
        const result = await query(args)
        if (stage === 'lock') controller.abort()
        return result
      } },
      inquirySyncRun: { async updateMany({ args, query }) {
        const result = await query(args)
        if (stage === 'start') controller.abort()
        return result
      } },
    } })
    assert.equal(await claimNextRun(interrupted as PrismaClient, new Date(), 'interrupted-claim', '2026-09-23', controller.signal), null)
    assert.equal(controller.signal.aborted, true)
    assert.deepEqual(await prisma.inquirySyncRun.findUniqueOrThrow({ where: { id: pending.id } }), pending, 'canceled transaction preserves pending status and original range')
    assert.deepEqual(await prisma.inquirySyncState.findUniqueOrThrow({ where: { id: INQUIRY_SCOPE_ID } }), before, 'canceled transaction preserves schedule, cutoff and ownership')
    await prisma.inquirySyncRun.delete({ where: { id: pending.id } })
  }
}

function testValidation() {
  const now = new Date('2026-09-16T04:00:00Z')
  const waitingForLogin = { status: 'login_required', workerHeartbeatAt: now }
  assert.equal(inquirySyncStatus(waitingForLogin, 'pending', now), 'login_required', 'a queued request must not hide the login instruction')
  assert.equal(inquirySyncStatus(waitingForLogin, 'pending', new Date(now.getTime() + 180_001)), 'offline')
  assert.equal(inquirySyncStatus(null, 'pending', now), 'offline')
  assert.equal(inquirySyncStatus({ ...waitingForLogin, status: 'success' }, 'pending', now), 'pending')
  assert.equal(inquirySyncStatus({ ...waitingForLogin, status: 'success' }, undefined, now), 'success')
  const row = normalizeInquiry(makeRow(1, { name: '-', sourceStatus: '상태 선택', inquiryDate: '2026-09-15 (화)' }))
  assert.equal(row.name, '미상(📞 0001)')
  for (const name of [null, '', '   ', ' - ']) {
    assert.equal(normalizeInquiry(makeRow(1, { name, phone: '010-1234-5678' })).name, '미상(📞 5678)')
  }
  assert.equal(normalizeInquiry(makeRow(1, { name: ' 실제 성함 ' })).name, '실제 성함')
  assert.equal(row.sourceStatus, null)
  assert.equal(row.inquiryDate, '2026-09-15')
  assert.throws(() => normalizeInquiry(makeRow(1, { inquiryDate: '2026-02-30' })), /invalid_date/)
  assert.throws(() => normalizeInquiry(makeRow(1, { inquiryTime: '24:00' })), /invalid_time/)
  assert.equal(manualSyncError(undefined, 'http://localhost:3000/api/inquiries/sync', 'http://localhost:3000'), 401)
  assert.equal(manualSyncError('user', 'http://localhost:3000/api/inquiries/sync', 'http://localhost:3000'), 403)
  assert.equal(manualSyncError('admin', 'http://localhost:3000/api/inquiries/sync', 'https://other.invalid'), 400)
  assert.equal(manualSyncError('admin', 'http://localhost:3000/api/inquiries/sync', 'http://localhost:3000'), null)
  assert.equal(safeNetworkErrorType(new Error('net::ERR_NAME_NOT_RESOLVED at https://private.invalid/path')), 'offline_ERR_NAME_NOT_RESOLVED')
  assert.equal(safeNetworkErrorType(new Error('request failed at https://private.invalid/path')), null)
  assert.equal(manualSyncError('admin', 'http://localhost:3100/api/inquiries/sync', 'http://127.0.0.1:3100', '127.0.0.1:3100'), null)
  assert.equal(manualSyncError('admin', 'http://localhost:3100/api/inquiries/sync', 'https://other.invalid', '127.0.0.1:3100'), 400)
  assert.equal(manualSyncError('admin', 'http://localhost:3100/api/inquiries/sync', 'http://127.0.0.1:3100', '127.0.0.1:3100', 'file'), 400)
}

async function testSync(prisma: PrismaClient) {
  const [first, second] = await Promise.all([enqueueSync(prisma, 'manual', '2026-09-14'), enqueueSync(prisma, 'manual', '2026-09-14')])
  assert.equal([first, second].filter(Boolean).length, 1, 'manual requests coalesce')
  const claimed = await claimNextRun(prisma, new Date(), TEST_OWNER, '2026-09-15')
  assert.ok(claimed)
  assert.equal(claimed.rangeEnd, '2026-09-15', 'worker refreshes a queued run to its execution day')
  assert.equal(await claimNextRun(prisma, new Date(), 'other-worker'), null, 'overlapping worker cannot claim')

  const baselineRows = makeRows(205, 0, '2026-09-14')
  baselineRows[1] = { ...baselineRows[1], phone: baselineRows[0].phone }
  baselineRows[2] = { ...baselineRows[2], name: '-' }
  const bootstrapAt = new Date('2026-09-15T00:00:00Z')
  const firstResult = await reconcile(prisma, claimed.id, claimed.owner, claimed.rangeStart, claimed.rangeEnd, paged(baselineRows), () => bootstrapAt)
  assert.equal(firstResult.status, 'success')
  assert.equal(firstResult.createdCount, 205)
  assert.equal(firstResult.readCount, 205)
  assert.equal(firstResult.updatedCount, 0)
  await finishRun(prisma, claimed.id, claimed.owner, firstResult, new Date('2026-09-15T00:01:00Z'))
  assert.equal(await prisma.inquiry.count(), 205)
  assert.equal((await prisma.inquiry.findUniqueOrThrow({ where: { source_companyScopeId_homepageScopeId_sourceId: scopeKey(baselineRows[2].sourceId) } })).name, '미상(📞 0002)')
  assert.equal(await prisma.inquiry.count({ where: { phone: baselineRows[0].phone } }), 2, 'same phone remains two distinct source inquiries')

  const repeat = await enqueueSync(prisma, 'manual', '2026-09-15')
  assert.ok(repeat)
  const repeatClaim = await claimNextRun(prisma, new Date('2026-09-15T00:02:00Z'), TEST_OWNER)
  assert.ok(repeatClaim)
  const newRows = [
    makeRow(9001, { inquiryTime: '23:59' }),
    makeRow(9000, { inquiryTime: '23:58' }),
  ]
  const changedBaseline = baselineRows.map((row, index) => index === 0 ? { ...row, sourceStatus: '관리중', name: '바뀐 이름', phone: '010-9999-9999' } : row)
  let repeatCalls = 0
  const repeatResult = await reconcile(prisma, repeatClaim.id, repeatClaim.owner, repeatClaim.rangeStart, repeatClaim.rangeEnd, async (page) => {
    repeatCalls++
    return paged([...newRows, ...changedBaseline])(page)
  }, () => new Date('2026-09-15T00:02:30Z'))
  assert.equal(repeatResult.expectedCount, 207)
  assert.equal(repeatResult.pagesRead, 1, 'known successful row stops the incremental scan')
  assert.equal(repeatResult.readCount, 200)
  assert.equal(repeatResult.createdCount, 2)
  assert.equal(repeatResult.updatedCount, 0)
  assert.equal(repeatCalls, 1, 'one-page incremental run does not refetch the head')
  await finishRun(prisma, repeatClaim.id, repeatClaim.owner, repeatResult, new Date('2026-09-15T00:03:00Z'))
  const unchanged = await prisma.inquiry.findUniqueOrThrow({ where: { source_companyScopeId_homepageScopeId_sourceId: scopeKey(baselineRows[0].sourceId) } })
  assert.equal(unchanged.sourceStatus, baselineRows[0].sourceStatus)
  assert.equal(unchanged.name, baselineRows[0].name)
  assert.equal(unchanged.phone, baselineRows[0].phone)
  assert.equal(unchanged.lastSeenAt.getTime(), bootstrapAt.getTime(), 'incremental sync never rewrites historical fields')

  const manyNew = makeRows(250, 1000, '2026-09-16')
  const priorSource = [...newRows, ...baselineRows]
  const many = await enqueueSync(prisma, 'manual', '2026-09-16')
  assert.ok(many)
  const manyClaim = await claimNextRun(prisma, new Date('2026-09-16T00:04:00Z'), TEST_OWNER, '2026-09-16')
  assert.ok(manyClaim)
  let manyCalls = 0
  const manyResult = await reconcile(prisma, manyClaim.id, manyClaim.owner, manyClaim.rangeStart, manyClaim.rangeEnd, async (page) => {
    manyCalls++
    return paged([...manyNew, ...priorSource])(page)
  }, () => new Date('2026-09-16T00:04:30Z'))
  assert.equal(manyResult.status, 'success')
  assert.equal(manyResult.expectedCount, 457)
  assert.equal(manyResult.pagesRead, 2)
  assert.equal(manyResult.createdCount, 250, 'more than one full page of new rows is imported')
  assert.equal(manyResult.updatedCount, 0)
  assert.equal(manyCalls, 3, 'multi-page cutoff run verifies the head once')
  await finishRun(prisma, manyClaim.id, manyClaim.owner, manyResult, new Date('2026-09-16T00:05:00Z'))

  const partialNew = makeRows(250, 2000, '2026-09-17')
  const fullSource = [...partialNew, ...manyNew, ...priorSource]
  const partial = await enqueueSync(prisma, 'manual', '2026-09-17')
  assert.ok(partial)
  const partialClaim = await claimNextRun(prisma, new Date('2026-09-17T00:00:00Z'), TEST_OWNER, '2026-09-17')
  assert.ok(partialClaim)
  const partialResult = await reconcile(prisma, partialClaim.id, partialClaim.owner, partialClaim.rangeStart, partialClaim.rangeEnd, async (page) => {
    if (page === 2) throw new SyncError('page_error')
    return paged(fullSource)(page)
  }, () => new Date('2026-09-17T00:00:30Z'))
  assert.equal(partialResult.status, 'partial')
  assert.equal(partialResult.readCount, 200)
  assert.equal(partialResult.createdCount, 200)
  await finishRun(prisma, partialClaim.id, partialClaim.owner, partialResult, new Date('2026-09-17T00:01:00Z'))

  const recovered = await enqueueSync(prisma, 'manual', '2026-09-17')
  assert.ok(recovered)
  const recoveredClaim = await claimNextRun(prisma, new Date('2026-09-17T00:02:00Z'), TEST_OWNER, '2026-09-17')
  assert.ok(recoveredClaim)
  const recoveredResult = await reconcile(prisma, recoveredClaim.id, recoveredClaim.owner, recoveredClaim.rangeStart, recoveredClaim.rangeEnd, paged(fullSource), () => new Date('2026-09-17T00:02:30Z'))
  assert.equal(recoveredResult.status, 'success')
  assert.equal(recoveredResult.pagesRead, 2)
  assert.equal(recoveredResult.createdCount, 50, 'partial inserts do not become a successful-cutoff boundary')
  assert.equal(recoveredResult.readCount, 400)
  await finishRun(prisma, recoveredClaim.id, recoveredClaim.owner, recoveredResult, new Date('2026-09-17T00:03:00Z'))

  const empty = await enqueueSync(prisma, 'manual', '2026-09-17')
  assert.ok(empty)
  const emptyClaim = await claimNextRun(prisma, new Date('2026-09-17T00:04:00Z'), TEST_OWNER, '2026-09-17')
  assert.ok(emptyClaim)
  let emptyCalls = 0
  const emptyResult = await reconcile(prisma, emptyClaim.id, emptyClaim.owner, emptyClaim.rangeStart, emptyClaim.rangeEnd, async (page) => {
    emptyCalls++
    return { page, total: 0, rows: [] }
  }, () => new Date('2026-09-17T00:04:30Z'))
  assert.equal(emptyResult.status, 'success')
  assert.equal(emptyResult.expectedCount, 0)
  assert.equal(emptyResult.readCount, 0)
  assert.equal(emptyCalls, 1)
  await finishRun(prisma, emptyClaim.id, emptyClaim.owner, emptyResult, new Date('2026-09-17T00:05:00Z'))
}

async function testCutoffProbeChange(prisma: PrismaClient) {
  const pending = await enqueueSync(prisma, 'manual', '2026-09-18')
  assert.ok(pending)
  const claimed = await claimNextRun(prisma, new Date('2026-09-18T00:00:00Z'), TEST_OWNER, '2026-09-18')
  assert.ok(claimed)
  const newRows = makeRows(201, 6000, '2026-09-18')
  const known = makeRow(0, { inquiryDate: '2026-09-14', inquiryTime: '03:24' })
  const original = [...newRows, known]
  const replacement = makeRow(6999, { inquiryDate: '2026-09-18', inquiryTime: '23:59' })
  const shifted = [replacement, ...newRows.slice(0, 200), known]
  let calls = 0
  const changingHead = async (page: number): Promise<SourcePage> => {
    calls++
    const rows = calls <= 2 ? original : shifted
    return { page, total: rows.length, rows: rows.slice((page - 1) * 200, page * 200) }
  }
  const result = await reconcile(prisma, claimed.id, claimed.owner, claimed.rangeStart, claimed.rangeEnd, changingHead, () => new Date('2026-09-18T00:00:30Z'))
  assert.equal(result.status, 'success')
  assert.equal(result.pagesRead, 4, 'changed head at cutoff retries the two-page scan once')
  assert.equal(calls, 6, 'each multi-page attempt performs one head probe')
  assert.equal(await prisma.inquiry.count({ where: { sourceId: replacement.sourceId } }), 1)
  await finishRun(prisma, claimed.id, claimed.owner, result, new Date('2026-09-18T00:01:00Z'))
}

async function testChangingCount(prisma: PrismaClient) {
  const pending = await enqueueSync(prisma, 'manual', '2026-09-18')
  assert.ok(pending)
  const claimed = await claimNextRun(prisma, new Date('2026-09-18T01:00:00Z'), TEST_OWNER, '2026-09-18')
  assert.ok(claimed)
  const rows = makeRows(202, 3000, '2026-09-18')
  let calls = 0
  const changing = async (page: number): Promise<SourcePage> => {
    calls++
    if (calls === 1) return { page: 1, total: 201, rows: rows.slice(0, 200) }
    if (calls === 2) return { page: 2, total: 202, rows: rows.slice(200) }
    return { page, total: 202, rows: page === 1 ? rows.slice(0, 200) : rows.slice(200) }
  }
  const result = await reconcile(prisma, claimed.id, claimed.owner, claimed.rangeStart, claimed.rangeEnd, changing, () => new Date('2026-09-18T01:00:30Z'))
  assert.equal(result.status, 'success', 'mid-scan count shift retries once')
  assert.equal(calls, 5)
  await finishRun(prisma, claimed.id, claimed.owner, result, new Date('2026-09-18T01:01:00Z'))
}

async function testProbeChange(prisma: PrismaClient) {
  const pending = await enqueueSync(prisma, 'manual', '2026-09-19')
  assert.ok(pending)
  const claimed = await claimNextRun(prisma, new Date('2026-09-19T00:00:00Z'), TEST_OWNER, '2026-09-19')
  assert.ok(claimed)
  const original = makeRows(201, 4000, '2026-09-19')
  const shifted = [makeRow(5000, { inquiryDate: '2026-09-19', inquiryTime: '23:59' }), ...original]
  let calls = 0
  const probeShift = async (page: number): Promise<SourcePage> => {
    calls++
    if (calls <= 2) return { page, total: 201, rows: original.slice((page - 1) * 200, page * 200) }
    return { page, total: 202, rows: shifted.slice((page - 1) * 200, page * 200) }
  }
  const result = await reconcile(prisma, claimed.id, claimed.owner, claimed.rangeStart, claimed.rangeEnd, probeShift, () => new Date('2026-09-19T00:00:30Z'))
  assert.equal(result.status, 'success', 'changed first-page probe triggers one full retry')
  assert.equal(calls, 6)
  await finishRun(prisma, claimed.id, claimed.owner, result, new Date('2026-09-19T00:01:00Z'))
}

async function testRangeAndLease(prisma: PrismaClient) {
  const reversed = await enqueueSync(prisma, 'manual', '2026-09-19')
  assert.ok(reversed)
  const reversedClaim = await claimNextRun(prisma, new Date('2026-09-19T00:02:00Z'), TEST_OWNER, '2026-09-19')
  assert.ok(reversedClaim)
  const reversedResult = await reconcile(prisma, reversedClaim.id, reversedClaim.owner, reversedClaim.rangeStart, reversedClaim.rangeEnd, paged([
    makeRow(8100, { inquiryDate: '2026-09-19', inquiryTime: '10:00' }),
    makeRow(8101, { inquiryDate: '2026-09-19', inquiryTime: '10:01' }),
  ]), () => new Date('2026-09-19T00:02:30Z'))
  assert.equal(reversedResult.errorType, 'unexpected_order')
  assert.equal(await prisma.inquiry.count({ where: { sourceId: { in: [makeRow(8100).sourceId, makeRow(8101).sourceId] } } }), 0)
  await finishRun(prisma, reversedClaim.id, reversedClaim.owner, reversedResult, new Date('2026-09-19T00:03:00Z'))

  const outOfRange = await enqueueSync(prisma, 'manual', '2026-09-15')
  assert.ok(outOfRange)
  const rangeClaim = await claimNextRun(prisma, new Date(), TEST_OWNER)
  assert.ok(rangeClaim)
  const rangeResult = await reconcile(prisma, rangeClaim.id, rangeClaim.owner, rangeClaim.rangeStart, rangeClaim.rangeEnd, paged([makeRow(3000, { inquiryDate: '2026-09-16' })]))
  assert.equal(rangeResult.errorType, 'date_out_of_range')
  await finishRun(prisma, rangeClaim.id, rangeClaim.owner, rangeResult)

  const fenced = await enqueueSync(prisma, 'manual', '2026-09-15')
  assert.ok(fenced)
  const oldClaim = await claimNextRun(prisma, new Date(), TEST_OWNER)
  assert.ok(oldClaim)
  await prisma.inquirySyncState.update({ where: { id: INQUIRY_SCOPE_ID }, data: { lockOwner: 'new-worker' } })
  const fencedRow = makeRow(8000)
  const fencedResult = await reconcile(prisma, oldClaim.id, oldClaim.owner, oldClaim.rangeStart, oldClaim.rangeEnd, paged([fencedRow]))
  assert.equal(fencedResult.errorType, 'lost_lease')
  await assert.rejects(() => finishRun(prisma, oldClaim.id, oldClaim.owner, fencedResult), /lost_lease/)
  assert.equal(await prisma.inquiry.count({ where: { sourceId: fencedRow.sourceId } }), 0)
  await prisma.inquirySyncRun.update({ where: { id: oldClaim.id }, data: { status: 'partial' } })
  await prisma.inquirySyncState.update({ where: { id: INQUIRY_SCOPE_ID }, data: { lockOwner: null, lockExpiresAt: null, status: 'partial' } })
}

async function testStaleRecovery(prisma: PrismaClient) {
  const pending = await enqueueSync(prisma, 'manual', '2026-09-15')
  assert.ok(pending)
  const claimed = await claimNextRun(prisma, new Date('2026-09-15T00:00:00Z'), TEST_OWNER)
  assert.ok(claimed)
  await recoverStaleRuns(prisma, new Date('2026-09-15T00:04:00Z'))
  assert.equal((await prisma.inquirySyncRun.findUniqueOrThrow({ where: { id: claimed.id } })).status, 'partial')
  assert.equal((await prisma.inquirySyncState.findUniqueOrThrow({ where: { id: INQUIRY_SCOPE_ID } })).lockOwner, null)
}

async function testLoginRequired(prisma: PrismaClient) {
  const pending = await enqueueSync(prisma, 'manual', '2026-09-15')
  assert.ok(pending)
  const claimed = await claimNextRun(prisma, new Date(), TEST_OWNER)
  assert.ok(claimed)
  const result = await reconcile(prisma, claimed.id, claimed.owner, claimed.rangeStart, claimed.rangeEnd, async () => {
    throw new SyncError('login_required')
  })
  assert.equal(result.status, 'login_required')
  await finishRun(prisma, claimed.id, claimed.owner, result)
  assert.equal(await enqueueSync(prisma, 'manual', '2026-09-15'), null, 'login-required state does not accumulate pending jobs')
  await prisma.inquirySyncState.update({ where: { id: INQUIRY_SCOPE_ID }, data: { status: 'offline' } })

  const offline = await enqueueSync(prisma, 'manual', '2026-09-15')
  assert.ok(offline)
  const offlineClaim = await claimNextRun(prisma, new Date(), TEST_OWNER)
  assert.ok(offlineClaim)
  const offlineResult = await reconcile(prisma, offlineClaim.id, offlineClaim.owner, offlineClaim.rangeStart, offlineClaim.rangeEnd, async () => {
    throw new SyncError('offline_ERR_INTERNET_DISCONNECTED')
  })
  assert.equal(offlineResult.status, 'offline')
  await finishRun(prisma, offlineClaim.id, offlineClaim.owner, offlineResult)
}

async function testWorkerLease(prisma: PrismaClient) {
  await releaseWorker(prisma, TEST_OWNER)
  const start = new Date('2026-09-15T01:00:00Z')
  assert.equal(await claimWorker(prisma, 'sleeping-worker', start), true)
  assert.equal(await claimWorker(prisma, 'second-worker', new Date(start.getTime() + 60_000)), false)
  assert.equal(await claimWorker(prisma, 'sleeping-worker', new Date(start.getTime() + 181_000)), true, 'same worker resumes after sleep')
  assert.equal(await claimWorker(prisma, 'second-worker', new Date(start.getTime() + 362_000)), true, 'new worker takes an expired lease')
  await assert.rejects(() => heartbeatWorker(prisma, 'sleeping-worker', new Date(start.getTime() + 363_000)), /lost_worker_lease/)
  await releaseWorker(prisma, 'sleeping-worker', new Date(start.getTime() + 364_000))
  assert.equal((await prisma.inquirySyncState.findUniqueOrThrow({ where: { id: INQUIRY_SCOPE_ID } })).workerOwner, 'second-worker', 'old shutdown cannot clear new owner')
  await releaseWorker(prisma, 'second-worker', new Date(start.getTime() + 365_000))
}

function paged(rows: RawInquiry[]) {
  return async (page: number): Promise<SourcePage> => ({
    page,
    total: rows.length,
    rows: rows.slice((page - 1) * 200, page * 200),
  })
}

function makeRows(count: number, offset = 0, inquiryDate = '2026-09-15') {
  return Array.from({ length: count }, (_, index) => {
    const rank = count - index - 1
    return makeRow(index + offset, {
      inquiryDate,
      inquiryTime: `${String(Math.floor(rank / 60) % 24).padStart(2, '0')}:${String(rank % 60).padStart(2, '0')}`,
    })
  })
}

function makeRow(index: number, patch: Partial<RawInquiry> = {}): RawInquiry {
  return {
    sourceId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    inquiryDate: '2026-09-15',
    inquiryTime: `${String(Math.floor(index / 60) % 24).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}`,
    sourceStatus: '접수',
    name: `합성 문의 ${index}`,
    phone: `010-0000-${String(index % 10_000).padStart(4, '0')}`,
    ...patch,
  }
}

function scopeKey(sourceId: string) {
  return {
    source: 'mleverage-admin',
    companyScopeId: '55f9a8bb-73f9-4316-bcd7-7dcdce0bdcc3',
    homepageScopeId: '5c7a6115-a0a9-4e8d-bf65-efce52195fa4',
    sourceId,
  }
}

main().catch((error) => {
  const location = error instanceof Error ? error.stack?.split('\n').find((line) => line.includes('/tests/inquiry-sync.test.ts:')) : undefined
  console.error('test_failed', location?.trim() ?? 'unknown_location')
  process.exitCode = 1
})
