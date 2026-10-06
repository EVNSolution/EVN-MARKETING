import { createHash, randomUUID } from 'node:crypto'
import type { PrismaClient } from '@/app/generated/prisma/client'
import { claimWorker, heartbeatWorker, INQUIRY_SCOPE_ID, releaseWorker, SyncError } from '@/lib/inquiry-sync'
import { acknowledge, checkedDeliver, duplicateInquiryIds, keyConfigured, MANUAL_CONFIRMATION, REVIEW_CLEARED, payloadFor, rowSelect, scope, warpActivityId, warpDeliveryState, type Env } from '@/lib/warp-delivery'

export const MAX_RECOVERY_ROWS = 20
export const MAX_PLAN_BYTES = 32_768
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const sha256 = /^[0-9a-f]{64}$/
const select = { ...rowSelect, warpCustomerId: true, warpActivityId: true, warpDeliveredAt: true, warpAttemptedAt: true, warpError: true } as const
type Db = Pick<PrismaClient, 'inquiry'>
type Row = Awaited<ReturnType<typeof selectedRows>>[number]
type PlanRow = { sourceId: string; payloadSha256: string; receiptSha256: string }
export type RecoveryPlan = {
  version: 1
  comparison: 'local-only'
  scope: typeof scope
  createdAt: string
  rows: PlanRow[]
}
export type RecoveryResult = { status: string; selected: number; attempted: number; confirmed: number; created: number; duplicate: number }
export type RecoveryEvent =
  | { event: 'start'; planSha256: string; selected: number }
  | { event: 'attempt'; row: PlanRow }
  | { event: 'receipt'; sourceId: string; receiptSha256: string; created: boolean; duplicate: boolean }
  | { event: 'finish'; result: RecoveryResult }

class RecoveryError extends Error {}
function fail(code: string): never { throw new RecoveryError(code) }

export function recoveryErrorCode(error: unknown) {
  if (error instanceof RecoveryError) return error.message
  if (error instanceof SyncError && error.type === 'lost_worker_lease') return error.type
  return 'warp_recovery_failed'
}

export function recoverySha256(bytes: string) {
  return createHash('sha256').update(bytes).digest('hex')
}

export function validateRecoveryIds(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_RECOVERY_ROWS
    || value.some(id => typeof id !== 'string' || !uuid.test(id))
    || new Set(value.map(id => id.toLowerCase())).size !== value.length) fail('warp_recovery_invalid_selection')
}

function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(','))
}

async function selectedRows(db: Db, ids: string[]) {
  // Exact stored spelling is retained in the manifest; only the shared sender normalizes UUID case.
  const rows = await db.inquiry.findMany({ where: { ...scope, sourceId: { in: ids } }, select, take: MAX_RECOVERY_ROWS })
  const duplicates = await duplicateInquiryIds(db)
  if (rows.some(row => !row.warpDeliveredAt && duplicates.has(row.id))) fail('warp_recovery_duplicate_review')
  return rows
}

function fingerprint(row: Row): PlanRow {
  const { warpCustomerId, warpActivityId: activityId, warpDeliveredAt, warpAttemptedAt, warpError } = row
  return {
    sourceId: row.sourceId,
    payloadSha256: recoverySha256(JSON.stringify(payloadFor(row))),
    receiptSha256: recoverySha256(JSON.stringify({ warpCustomerId, warpActivityId: activityId, warpDeliveredAt, warpAttemptedAt, warpError })),
  }
}

function matchRows(rows: Row[], expected: PlanRow[]) {
  if (rows.length !== expected.length) fail('warp_recovery_row_changed')
  return expected.map(entry => {
    const row = rows.find(row => row.sourceId === entry.sourceId)
    if (!row) fail('warp_recovery_row_changed')
    if (row.warpError === MANUAL_CONFIRMATION) fail('warp_recovery_manual_confirmation')
    if (['duplicate', 'duplicate_reviewed'].includes(warpDeliveryState(row).status) || row.warpError === REVIEW_CLEARED) fail('warp_recovery_duplicate_review')
    if (JSON.stringify(fingerprint(row)) !== JSON.stringify(entry)) fail('warp_recovery_row_changed')
    if ((row.warpActivityId && row.warpActivityId !== warpActivityId(row.sourceId))
      || (row.warpDeliveredAt && (!row.warpActivityId || !row.warpCustomerId))) fail('warp_recovery_invalid_local_receipt')
    return row
  })
}

// No remote read API exists: planning reads only explicitly selected local rows and never sends.
export async function planWarpRecovery(db: PrismaClient, sourceIds: unknown, now = new Date()): Promise<RecoveryPlan> {
  validateRecoveryIds(sourceIds)
  const rows = await selectedRows(db, sourceIds)
  if (rows.length !== sourceIds.length) fail('warp_recovery_selection_missing')
  const entries = sourceIds.map(id => {
    const row = rows.find(row => row.sourceId === id)
    if (!row) fail('warp_recovery_selection_missing')
    return fingerprint(row)
  })
  matchRows(rows, entries)
  return { version: 1, comparison: 'local-only', scope: { ...scope }, createdAt: now.toISOString(), rows: entries }
}

// Approval covers the exact file bytes, including whitespace. Reject extra fields without echoing them.
export function parseRecoveryPlan(bytes: string, approvedSha256: string): RecoveryPlan {
  if (Buffer.byteLength(bytes) > MAX_PLAN_BYTES || !sha256.test(approvedSha256)
    || recoverySha256(bytes) !== approvedSha256) fail('warp_recovery_approval_mismatch')
  let value: unknown
  try { value = JSON.parse(bytes) } catch { fail('warp_recovery_invalid_plan') }
  if (!exactKeys(value, ['version', 'comparison', 'scope', 'createdAt', 'rows'])
    || value.version !== 1 || value.comparison !== 'local-only'
    || !exactKeys(value.scope, Object.keys(scope))
    || Object.entries(scope).some(([key, expected]) => (value.scope as Record<string, unknown>)[key] !== expected)
    || typeof value.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.createdAt)
    || !Number.isFinite(Date.parse(value.createdAt))
    || !Array.isArray(value.rows)) fail('warp_recovery_invalid_plan')
  const rows = value.rows.map(row => {
    if (!exactKeys(row, ['sourceId', 'payloadSha256', 'receiptSha256']) || typeof row.sourceId !== 'string'
      || typeof row.payloadSha256 !== 'string' || !sha256.test(row.payloadSha256)
      || typeof row.receiptSha256 !== 'string' || !sha256.test(row.receiptSha256)) fail('warp_recovery_invalid_plan')
    return { sourceId: row.sourceId, payloadSha256: row.payloadSha256, receiptSha256: row.receiptSha256 }
  })
  validateRecoveryIds(rows.map(row => row.sourceId))
  return { version: 1, comparison: 'local-only', scope: { ...scope }, createdAt: value.createdAt, rows }
}

export async function applyWarpRecovery(
  db: PrismaClient, bytes: string, approvedSha256: string,
  options: {
    // The caller must durably write private audit state before resolving; audit failure stops sending.
    audit: (event: RecoveryEvent) => Promise<void>
    send?: typeof fetch
    env?: Env
    now?: () => Date
    signal?: AbortSignal
  },
): Promise<RecoveryResult> {
  const env = { ...(options.env ?? process.env) }
  const now = options.now ?? (() => new Date())
  const owner = randomUUID()
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(300_000)])
  const checkStop = () => { if (signal.aborted) fail('warp_recovery_interrupted') }
  const result: RecoveryResult = { status: 'ok', selected: 0, attempted: 0, confirmed: 0, created: 0, duplicate: 0 }
  let claimed = false
  try {
    if (!keyConfigured(env)) fail('warp_key_required')
    const plan = parseRecoveryPlan(bytes, approvedSha256)
    result.selected = plan.rows.length
    checkStop()
    claimed = await claimWorker(db, owner, now())
    if (!claimed) fail('worker_already_running')
    checkStop()
    // Validate the ENTIRE plan before the first POST, including already-delivered rows.
    matchRows(await selectedRows(db, plan.rows.map(row => row.sourceId)), plan.rows)
    await options.audit({ event: 'start', planSha256: approvedSha256, selected: result.selected })
    for (const entry of plan.rows) {
      checkStop()
      await options.audit({ event: 'attempt', row: entry })
      const [row] = matchRows(await selectedRows(db, [entry.sourceId]), [entry])
      await heartbeatWorker(db, owner, now())
      checkStop()
      result.attempted++
      const delivery = await checkedDeliver(payloadFor(row), options.send ?? fetch, env, signal)
      checkStop()
      if (!delivery.receipt) fail(delivery.error)
      const receipt = delivery.receipt
      if (row.warpCustomerId && row.warpCustomerId !== receipt.customerId) fail('warp_recovery_customer_mismatch')
      await heartbeatWorker(db, owner, now())
      await options.audit({ event: 'receipt', sourceId: entry.sourceId,
        receiptSha256: recoverySha256(JSON.stringify({ customerId: receipt.customerId, activityId: receipt.activityId })),
        created: receipt.created, duplicate: receipt.duplicate })
      checkStop()
      await db.$transaction(async tx => {
        const lease = await tx.inquirySyncState.findFirst({ where: {
          id: INQUIRY_SCOPE_ID, workerOwner: owner, workerLeaseExpiresAt: { gt: now() },
        }, select: { id: true } })
        if (!lease) fail('lost_worker_lease')
        const [current] = matchRows(await selectedRows(tx, [entry.sourceId]), [entry])
        checkStop()
        // A delivered receipt is historical evidence. Confirm it separately without rewriting it.
        if (!current.warpDeliveredAt) await acknowledge(tx, current.id, receipt, now())
      })
      result.confirmed++
      if (receipt.created) result.created++
      else result.duplicate++
    }
  } catch (error) {
    result.status = recoveryErrorCode(error)
  } finally {
    if (claimed) {
      try { await releaseWorker(db, owner, now()) } catch { result.status = 'warp_recovery_release_failed' }
    }
  }
  try { await options.audit({ event: 'finish', result: { ...result } }) } catch { result.status = 'warp_recovery_audit_failed' }
  return result
}
