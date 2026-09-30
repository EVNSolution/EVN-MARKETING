import { createHash } from 'node:crypto'
import { inquiryCustomerName, normalizeInquiryPhone } from '@/lib/format'
import type { PrismaClient } from '@/app/generated/prisma/client'
import { heartbeatWorker, INQUIRY_COMPANY_ID, INQUIRY_HOMEPAGE_ID, INQUIRY_SCOPE_ID, INQUIRY_SOURCE, WORKER_LEASE_MS } from '@/lib/inquiry-sync'

const WARP_ENDPOINT = 'https://warp.cleversystem.ai/api/external/marketing-inquiries'
const WARP_CHECK_ENDPOINT = 'https://warp.cleversystem.ai/api/external/marketing-inquiries/check'
const RETRY_MS = 60 * 60_000
const PHONE_CHECK_FRESH_MS = 10 * 60_000
const duplicateErrors = ['warp_customer_conflict', 'warp_phone_duplicate']
// A durable command in the existing delivery state; only the lease-owning worker sends it.
export const MANUAL_REGISTRATION = 'warp_manual_requested'
export const MANUAL_CONFIRMATION = 'warp_manual_confirmed'
export const scope = { source: INQUIRY_SOURCE, companyScopeId: INQUIRY_COMPANY_ID, homepageScopeId: INQUIRY_HOMEPAGE_ID }
const connectionErrors = ['warp_auth_required', 'warp_not_configured', 'warp_endpoint_missing', 'warp_unavailable', 'warp_invalid_receipt']
export type Env = Readonly<Record<string, string | undefined>>
type InquiryPayload = typeof scope & { sourceId: string; inquiryDate: string; inquiryTime: string; sourceStatus: string; name: string; phone: string }
type Receipt = { customerId: string; activityId: string; created: boolean; duplicate: boolean }
type Delivery = { receipt?: Receipt; error: string }

export function keyConfigured(env: Env = process.env) {
  const key = env.WARP_MARKETING_API_KEY
  return Boolean(key && key.length >= 32 && !/\s/u.test(key))
}

export function warpConfigured(env: Env = process.env) {
  return env.WARP_DELIVERY_ENABLED === 'true' && keyConfigured(env)
}

type PhoneCheck = { warpPhoneStatus?: string | null; warpPhoneCheckedAt?: Date | null }

function phoneCheckClear(row: PhoneCheck, now: Date) {
  const age = row.warpPhoneCheckedAt ? now.getTime() - row.warpPhoneCheckedAt.getTime() : Infinity
  return row.warpPhoneStatus === 'clear' && age >= -5_000 && age < PHONE_CHECK_FRESH_MS
}

/** Scope-wide matching, independent of the current page/search. The first collected inquiry keeps its action. */
export async function duplicateInquiryIds(db: Pick<PrismaClient, 'inquiry'>) {
  // ponytail: one O(n) scan for this small scoped inbox; persist normalized phones if the inbox grows large.
  const rows = await db.inquiry.findMany({ where: scope,
    select: { id: true, phone: true },
    orderBy: [{ firstSeenAt: 'asc' }, { inquiryDate: 'asc' }, { inquiryTime: 'asc' }, { sourceId: 'asc' }, { id: 'asc' }],
  })
  const seen = new Set<string>(), duplicates = new Set<string>()
  for (const row of rows) {
    const phone = normalizeInquiryPhone(row.phone)
    if (!phone) continue
    if (seen.has(phone)) duplicates.add(row.id)
    else seen.add(phone)
  }
  return duplicates
}

export function warpDeliveryState(row: { warpDeliveredAt: Date | null; warpError: string | null } & PhoneCheck, localDuplicate = false, now = new Date()) {
  if (row.warpDeliveredAt) return { status: 'delivered', label: '등록 완료', reason: null }
  if (row.warpError === MANUAL_CONFIRMATION) return {
    status: 'delivered', label: '등록 완료', reason: '사용자가 WARP에 직접 등록했음을 확인했습니다.',
  }
  const warpDuplicate = row.warpPhoneStatus === 'duplicate' || duplicateErrors.includes(row.warpError ?? '')
  if (localDuplicate || warpDuplicate) return {
    status: 'duplicate', label: '중복',
    reason: localDuplicate && warpDuplicate ? '수집된 문의 및 WARP 고객과 연락처 중복' : localDuplicate ? '수집된 문의와 연락처 중복' : 'WARP 고객과 연락처 중복',
  }
  if (row.warpPhoneStatus === 'invalid') return { status: 'checking', label: '연락처 확인 필요', reason: '연락처 형식을 확인해 주세요.' }
  if (row.warpError === MANUAL_REGISTRATION) return { status: 'queued', label: '등록 요청됨', reason: null }
  if (!phoneCheckClear(row, now)) return { status: 'checking', label: '중복 확인 중', reason: row.warpPhoneStatus === 'unavailable'
    ? 'WARP 조회에 실패해 다시 확인 중입니다.' : 'WARP 고객과 연락처를 비교하고 있습니다.' }
  if (row.warpError) return { status: 'retrying', label: '재시도 대기', reason: '등록에 실패했습니다. 자동 등록이 꺼져 있으면 등록하기로 다시 요청해 주세요.' }
  return { status: 'pending', label: '등록 대기', reason: null }
}

export function warpActivityId(sourceId: string) {
  return `mleverage_${createHash('sha256').update([INQUIRY_SOURCE, INQUIRY_COMPANY_ID, INQUIRY_HOMEPAGE_ID, sourceId.toLowerCase()].join(':')).digest('hex')}`
}

export async function requestWarpRegistration(db: PrismaClient, id: string, now = new Date()) {
  return db.$transaction(async (tx) => {
    const row = await tx.inquiry.findFirst({ where: { ...scope, id }, select: { warpDeliveredAt: true, warpError: true, warpPhoneStatus: true, warpPhoneCheckedAt: true } })
    if (!row) return 'not_found' as const
    if (row.warpDeliveredAt) return 'delivered' as const
    if (row.warpError === MANUAL_CONFIRMATION) return 'delivered' as const
    if (warpDeliveryState(row, (await duplicateInquiryIds(tx)).has(id), now).status === 'duplicate') return 'duplicate' as const
    if (row.warpPhoneStatus === 'invalid') return 'invalid_phone' as const
    if (row.warpError === MANUAL_REGISTRATION) return 'queued' as const
    const state = await tx.inquirySyncState.findUnique({ where: { id: INQUIRY_SCOPE_ID } })
    if (!state?.workerOwner || !['ready', 'running', 'success'].includes(state.status) || !state.workerHeartbeatAt || !state.workerLeaseExpiresAt
      || now.getTime() - state.workerHeartbeatAt.getTime() >= WORKER_LEASE_MS
      || state.workerHeartbeatAt.getTime() > now.getTime() + 5_000 || state.workerLeaseExpiresAt <= now) return 'worker_offline' as const
    const blocked = await tx.inquiry.findFirst({ where: { ...scope, warpDeliveredAt: null,
      warpError: { in: connectionErrors }, warpAttemptedAt: { gt: new Date(now.getTime() - RETRY_MS) } }, select: { id: true } })
    if (blocked) return 'connection_backoff' as const
    if (!phoneCheckClear(row, now)) return 'duplicate_check_pending' as const
    await tx.inquiry.updateMany({ where: { ...scope, id, warpDeliveredAt: null }, data: { warpError: MANUAL_REGISTRATION } })
    return 'queued' as const
  })
}

async function postWarp(payload: object, send: typeof fetch, env: Env, signal?: AbortSignal) {
  return send(WARP_ENDPOINT, {
    method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
    headers: { 'Content-Type': 'application/json', 'x-api-key': env.WARP_MARKETING_API_KEY! },
    body: JSON.stringify(payload),
  })
}

function validReceipt(body: unknown, sourceId: string): body is { ok: true } & Receipt {
  if (!body || typeof body !== 'object') return false
  const value = body as Record<string, unknown>
  return value.ok === true && typeof value.customerId === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value.customerId)
    && value.activityId === warpActivityId(sourceId)
    && ((value.created === true && value.duplicate === false) || (value.created === false && value.duplicate === true))
}

export async function deliver(payload: InquiryPayload, send: typeof fetch, env: Env, signal?: AbortSignal): Promise<Delivery> {
  try {
    const response = await postWarp({ ...payload, rejectExistingCustomer: true }, send, env, signal)
    if (response.status === 200) {
      const body: unknown = await response.json()
      return validReceipt(body, payload.sourceId) ? { receipt: body, error: '' } : { error: 'warp_invalid_receipt' }
    }
    if (response.status === 401 || response.status === 403) return { error: 'warp_auth_required' }
    if (response.status === 404) return { error: 'warp_endpoint_missing' }
    if (response.status === 400 || response.status === 413) return { error: 'warp_invalid_inquiry' }
    if (response.status === 503 || response.status === 409) {
      const body: unknown = await response.json().catch(() => null)
      const code = body && typeof body === 'object' && 'error' in body ? body.error : null
      if (response.status === 409) return { error: code === 'phone_exists' ? 'warp_phone_duplicate' : code === 'ambiguous_phone' ? 'warp_customer_conflict' : 'warp_invalid_receipt' }
      return { error: code === 'not_configured' ? 'warp_not_configured' : 'warp_unavailable' }
    }
    return { error: 'warp_unavailable' }
  } catch {
    // Do not retain response bodies, request data, URLs, or credentials.
    return { error: 'warp_unavailable' }
  }
}

export async function checkWarpConnection(send: typeof fetch = fetch, env: Env = process.env) {
  if (!keyConfigured(env)) return 'warp_key_required'
  try {
    const response = await postWarp({}, send, env)
    const body: unknown = await response.json().catch(() => null)
    if (response.status === 400 && body && typeof body === 'object' && 'error' in body && body.error === 'bad_payload') return 'ok'
    if (response.status === 401 || response.status === 403) return 'warp_auth_required'
    if (response.status === 503 && body && typeof body === 'object' && 'error' in body && body.error === 'not_configured') return 'warp_not_configured'
    return 'warp_connection_check_failed'
  } catch {
    return 'warp_connection_check_failed'
  }
}

export async function warpDeliverySummary(db: PrismaClient, env: Env = process.env) {
  const [rows, localDuplicates] = await Promise.all([
    db.inquiry.findMany({ where: scope, select: { id: true, warpDeliveredAt: true, warpError: true, warpPhoneStatus: true } }),
    duplicateInquiryIds(db),
  ])
  const counts = { delivered: 0, pending: 0, failed: 0, duplicates: 0 }
  for (const row of rows) {
    const status = warpDeliveryState(row, localDuplicates.has(row.id)).status
    if (status === 'delivered') counts.delivered++
    else if (status === 'duplicate') counts.duplicates++
    else {
      counts.pending++
      if (row.warpError && row.warpError !== MANUAL_REGISTRATION) counts.failed++
    }
  }
  return { configured: env.WARP_DELIVERY_ENABLED === 'true', ...counts }
}

export const rowSelect = { id: true, sourceId: true, inquiryDate: true, inquiryTime: true, sourceStatus: true, name: true, phone: true } as const

async function pendingRows(db: PrismaClient, now: Date, take: number, respectRetry = true, duplicates = new Set<string>()) {
  const retryBefore = new Date(now.getTime() - RETRY_MS)
  return db.inquiry.findMany({
    where: { ...scope, id: { notIn: [...duplicates] }, warpDeliveredAt: null, AND: [
      { OR: [{ warpError: null }, { warpError: { notIn: [...duplicateErrors, MANUAL_CONFIRMATION] } }] },
      { OR: [{ warpPhoneStatus: null }, { warpPhoneStatus: { notIn: ['duplicate', 'invalid'] } }] },
      ...(respectRetry ? [{ OR: [{ warpAttemptedAt: null }, { warpAttemptedAt: { lte: retryBefore } }] }] : []),
    ] },
    orderBy: [{ inquiryDate: 'asc' }, { inquiryTime: 'asc' }, { sourceId: 'asc' }],
    take, select: rowSelect,
  })
}

export function payloadFor(row: Awaited<ReturnType<typeof pendingRows>>[number]): InquiryPayload {
  return { ...scope, sourceId: row.sourceId.toLowerCase(), inquiryDate: row.inquiryDate,
    inquiryTime: row.inquiryTime, sourceStatus: row.sourceStatus ?? '', name: inquiryCustomerName(row.name, row.phone), phone: row.phone }
}

export async function acknowledge(db: Pick<PrismaClient, 'inquiry'>, id: string, receipt: Receipt, at: Date) {
  await db.inquiry.update({ where: { id }, data: {
    warpCustomerId: receipt.customerId, warpActivityId: receipt.activityId,
    warpDeliveredAt: at, warpAttemptedAt: at, warpError: null,
  } })
}

/** Only the lease-owning worker has the WARP key. Cache bounded, read-only checks for the web process. */
export async function refreshWarpPhoneChecks(
  db: PrismaClient, workerOwner: string, send: typeof fetch = fetch, env: Env = process.env,
  now: () => Date = () => new Date(), signal?: AbortSignal,
) {
  if (!keyConfigured(env) || signal?.aborted) return
  const at = now()
  const rows = await db.inquiry.findMany({ where: { ...scope, warpDeliveredAt: null, AND: [
    { OR: [{ warpError: null }, { warpError: { not: MANUAL_CONFIRMATION } }] },
    { OR: [
      { warpPhoneCheckedAt: null },
      { warpPhoneCheckedAt: { lte: new Date(at.getTime() - 5 * 60_000) } },
      { warpPhoneStatus: 'unavailable', warpPhoneCheckedAt: { lte: new Date(at.getTime() - 60_000) } },
    ] },
  ] }, orderBy: [{ warpPhoneCheckedAt: 'asc' }, { inquiryDate: 'asc' }, { inquiryTime: 'asc' }, { sourceId: 'asc' }],
  take: 50, select: { ...rowSelect, warpError: true } })
  if (!rows.length) return
  const checkable = rows.filter(row => row.phone.length <= 40 && normalizeInquiryPhone(row.phone))
  await heartbeatWorker(db, workerOwner, now())
  if (signal?.aborted) return
  type Result = { sourceId: string; exists: boolean; receipt?: { ok: true } & Receipt }
  let results: Result[] | null = []
  if (checkable.length) try {
    const response = await send(WARP_CHECK_ENDPOINT, {
      method: 'POST', redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
      headers: { 'Content-Type': 'application/json', 'x-api-key': env.WARP_MARKETING_API_KEY! },
      body: JSON.stringify({ ...scope, items: checkable.map(row => ({ sourceId: row.sourceId.toLowerCase(), phone: row.phone })) }),
    })
    if (!response.ok) throw new Error('lookup_failed')
    const body = await response.json()
    const ids = new Set(checkable.map(row => row.sourceId.toLowerCase()))
    if (body?.ok !== true || !Array.isArray(body.results) || body.results.length !== checkable.length) throw new Error('invalid_lookup')
    for (const item of body.results) {
      if (!item || !ids.delete(item.sourceId) || typeof item.exists !== 'boolean'
        || (item.receipt !== undefined && (!item.exists || !validReceipt(item.receipt, item.sourceId)
          || item.receipt.created !== false || item.receipt.duplicate !== true))) throw new Error('invalid_lookup')
    }
    results = body.results
  } catch {
    // A timeout, old WARP deployment, or malformed response is never a negative match.
    results = null
  }
  if (signal?.aborted) return
  await heartbeatWorker(db, workerOwner, now())
  if (signal?.aborted) return
  const checkedAt = now()
  await db.$transaction(async tx => {
    for (const row of rows) {
      const current = await tx.inquiry.findUnique({ where: { id: row.id }, select: { warpDeliveredAt: true, warpError: true } })
      if (!current || current.warpDeliveredAt || current.warpError === MANUAL_CONFIRMATION) continue
      const result = results?.find(item => item.sourceId === row.sourceId.toLowerCase())
      if (result?.receipt) {
        // Recover our own acknowledged inquiry instead of mislabelling it as another customer.
        await acknowledge(tx, row.id, result.receipt, checkedAt)
      }
      await tx.inquiry.updateMany({ where: { id: row.id, warpDeliveredAt: null,
        OR: [{ warpError: null }, { warpError: { not: MANUAL_CONFIRMATION } }] }, data: {
        warpPhoneStatus: result ? (result.exists ? 'duplicate' : 'clear') : checkable.includes(row) ? 'unavailable' : 'invalid', warpPhoneCheckedAt: checkedAt,
        ...(!result?.exists && result && duplicateErrors.includes(row.warpError ?? '') ? { warpError: null } : {}),
      } })
    }
  })
}

export async function pilotPendingWarp(
  db: PrismaClient, workerOwner: string, send: typeof fetch = fetch,
  env: Env = process.env, now: () => Date = () => new Date(),
) {
  if (!keyConfigured(env)) return 'warp_key_required'
  await heartbeatWorker(db, workerOwner, now())
  const [row] = await pendingRows(db, now(), 1, false, await duplicateInquiryIds(db))
  if (!row) return 'warp_no_pending_inquiry'
  const payload = payloadFor(row)
  const fail = async (error: string) => {
    await heartbeatWorker(db, workerOwner, now())
    await db.inquiry.update({ where: { id: row.id }, data: { warpError: error, warpAttemptedAt: now() } })
    return error
  }
  const first = await deliver(payload, send, env)
  if (!first.receipt) return fail(first.error)
  await heartbeatWorker(db, workerOwner, now())
  const replay = await deliver(payload, send, env)
  if (!replay.receipt) return fail(replay.error)
  if (replay.receipt.created || !replay.receipt.duplicate
    || replay.receipt.customerId !== first.receipt.customerId || replay.receipt.activityId !== first.receipt.activityId) return fail('warp_pilot_replay_mismatch')
  await heartbeatWorker(db, workerOwner, now())
  await acknowledge(db, row.id, replay.receipt, now())
  return first.receipt.duplicate ? 'ok_recovered_duplicate' : 'ok'
}

export async function dispatchPendingWarp(
  db: PrismaClient,
  workerOwner: string,
  send: typeof fetch = fetch,
  env: Env = process.env,
  now: () => Date = () => new Date(),
  signal?: AbortSignal,
) {
  const result = { configured: warpConfigured(env), delivered: 0, failed: 0 }
  if (!keyConfigured(env) || signal?.aborted) return result
  const retryBefore = new Date(now().getTime() - RETRY_MS)
  const connectionBlocked = await db.inquiry.findFirst({
    where: { ...scope, warpDeliveredAt: null, warpError: { in: connectionErrors }, warpAttemptedAt: { gt: retryBefore } },
    select: { id: true },
  })
  if (connectionBlocked || signal?.aborted) return result
  const localDuplicates = await duplicateInquiryIds(db)
  const rows = result.configured ? await pendingRows(db, now(), 50, true, localDuplicates) : await db.inquiry.findMany({
    where: { ...scope, id: { notIn: [...localDuplicates] }, warpDeliveredAt: null, warpError: MANUAL_REGISTRATION,
      OR: [{ warpPhoneStatus: null }, { warpPhoneStatus: { notIn: ['duplicate', 'invalid'] } }] },
    orderBy: [{ inquiryDate: 'asc' }, { inquiryTime: 'asc' }, { sourceId: 'asc' }], take: 50, select: rowSelect,
  })
  for (const row of rows) {
    if (signal?.aborted) break
    await heartbeatWorker(db, workerOwner, now())
    if (signal?.aborted) break
    const delivery = await deliver(payloadFor(row), send, env, signal)
    await heartbeatWorker(db, workerOwner, now())
    const attemptedAt = now()
    if (delivery.receipt) await acknowledge(db, row.id, delivery.receipt, attemptedAt)
    else await db.inquiry.update({ where: { id: row.id }, data: { warpAttemptedAt: attemptedAt, warpError: delivery.error } })
    if (delivery.receipt) result.delivered++
    else result.failed++
    if (!delivery.receipt && connectionErrors.includes(delivery.error)) break
  }
  return result
}
