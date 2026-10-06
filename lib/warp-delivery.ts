import { createHash } from 'node:crypto'
import { inquiryCustomerName, normalizeInquiryPhone } from '@/lib/format'
import type { PrismaClient } from '@/app/generated/prisma/client'
import { heartbeatWorker, INQUIRY_COMPANY_ID, INQUIRY_HOMEPAGE_ID, INQUIRY_SCOPE_ID, INQUIRY_SOURCE, WORKER_LEASE_MS } from '@/lib/inquiry-sync'

const WARP_ENDPOINT = 'https://warp.cleversystem.ai/api/external/marketing-inquiries'
const WARP_CHECK_ENDPOINT = 'https://warp.cleversystem.ai/api/external/marketing-inquiries/check'
const RETRY_MS = 60 * 60_000
// A durable command in the existing delivery state; only the lease-owning worker sends it.
export const MANUAL_REGISTRATION = 'warp_manual_requested'
export const MANUAL_CONFIRMATION = 'warp_manual_confirmed'
export const WARP_EXISTING_CUSTOMER = 'warp_existing_customer'
export const WARP_RECEIPT_UNVERIFIED = 'warp_receipt_unverified'
export const DUPLICATE_RECHECK = 'warp_duplicate_recheck_requested'
export const DUPLICATE_RECHECK_FAILED = 'warp_duplicate_recheck_failed'
export const DUPLICATE_REVIEWED = 'warp_duplicate_reviewed'
export const EXISTING_CUSTOMER_REVIEWED = 'warp_existing_customer_reviewed'
export const REVIEW_CLEARED = 'warp_duplicate_review_cleared'
export const scope = { source: INQUIRY_SOURCE, companyScopeId: INQUIRY_COMPANY_ID, homepageScopeId: INQUIRY_HOMEPAGE_ID }
const connectionErrors = ['warp_auth_required', 'warp_not_configured', 'warp_endpoint_missing', 'warp_unavailable', 'warp_invalid_receipt', 'warp_registration_guard_unavailable', 'warp_duplicate_check_unavailable']
const duplicateErrors = ['warp_customer_conflict', 'warp_phone_duplicate', 'warp_local_duplicate', WARP_EXISTING_CUSTOMER, DUPLICATE_RECHECK, DUPLICATE_RECHECK_FAILED, DUPLICATE_REVIEWED, EXISTING_CUSTOMER_REVIEWED]
const duplicateRemedy = 'WARP에서 해당 연락처로 기존 고객을 확인해 주세요. 연락처가 잘못됐다면 원본 문의를 수정해 주세요.'
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

export function warpDeliveryState(row: { warpDeliveredAt: Date | null; warpError: string | null }, localDuplicate = false) {
  if ([DUPLICATE_REVIEWED, EXISTING_CUSTOMER_REVIEWED].includes(row.warpError ?? '')) return {
    status: 'duplicate_reviewed', label: '검토완료',
    reason: row.warpError === EXISTING_CUSTOMER_REVIEWED ? '기존 고객에 연결된 문의 이력을 확인했습니다. 새 고객은 생성되지 않았으며 전송 기록을 보존합니다.' : '중복 문의로 검토를 마쳤습니다. WARP에 전송하지 않습니다.',
  }
  if (row.warpError === WARP_EXISTING_CUSTOMER) return {
    status: 'duplicate', label: '중복확인',
    reason: `기존 고객의 문의 이력에 연결됐으며 새 고객은 생성되지 않았습니다. ${duplicateRemedy}`,
  }
  if (row.warpError === WARP_RECEIPT_UNVERIFIED) return {
    status: 'blocked', label: '등록 확인 필요', reason: '재전송 기록만 확인되어 새 고객 생성 여부를 확인할 수 없습니다. WARP 고객관리에서 연락처로 검색해 실제 등록 여부를 확인해 주세요.',
  }
  if (row.warpDeliveredAt) return { status: 'delivered', label: '등록 완료', reason: null }
  if (row.warpError === MANUAL_CONFIRMATION) return {
    status: 'delivered', label: '등록 완료', reason: '사용자가 WARP에 직접 등록했음을 확인했습니다.',
  }
  if (row.warpError === DUPLICATE_RECHECK) return { status: 'duplicate', label: '중복확인', reason: '중복 재확인을 요청했습니다. 확인하는 동안 전송하지 않습니다.' }
  if (row.warpError === DUPLICATE_RECHECK_FAILED) return { status: 'duplicate', label: '중복확인', reason: '중복 재확인에 실패해 전송을 보류했습니다. 연결을 확인한 뒤 다시 재확인해 주세요.' }
  if (localDuplicate || duplicateErrors.includes(row.warpError ?? '')) return {
    status: 'duplicate', label: '중복확인',
    reason: `${localDuplicate || row.warpError === 'warp_local_duplicate' ? '수집된 문의와 연락처가 중복됩니다.' : 'WARP 고객과 연락처가 중복됩니다.'} ${duplicateRemedy}`,
  }
  if (row.warpError === REVIEW_CLEARED) return { status: 'pending', label: '등록 검토', reason: '재확인 결과 중복이 없습니다. 내용을 확인한 뒤 등록하기를 눌러 주세요. 자동으로 전송하지 않습니다.' }
  if (row.warpError === 'warp_duplicate_check_unavailable') return { status: 'retrying', label: '중복 조회 실패', reason: 'WARP 중복 조회에 실패해 전송하지 않았습니다. 연결을 확인한 뒤 다시 요청해 주세요.' }
  if (row.warpError === 'warp_registration_guard_unavailable') return {
    status: 'blocked', label: '등록 보류', reason: '중복 방지 연동 업데이트가 필요해 등록을 보류했습니다. 담당자에게 WARP 연동 업데이트를 요청해 주세요.',
  }
  if (row.warpError === MANUAL_REGISTRATION) return { status: 'queued', label: '등록 요청됨', reason: null }
  if (row.warpError) return { status: 'retrying', label: '재시도 대기', reason: '등록에 실패했습니다. 자동 등록이 꺼져 있으면 등록하기로 다시 요청해 주세요.' }
  return { status: 'pending', label: '등록 대기', reason: null }
}

/** Scope-wide matching; the oldest collected inquiry keeps the registration opportunity. */
export async function duplicateInquiryIds(db: Pick<PrismaClient, 'inquiry'>) {
  // ponytail: one O(n) scan is enough for this small inbox; add a normalized index only if volume proves it necessary.
  const rows = await db.inquiry.findMany({ where: scope, select: { id: true, phone: true },
    orderBy: [{ firstSeenAt: 'asc' }, { inquiryDate: 'asc' }, { inquiryTime: 'asc' }, { sourceId: 'asc' }, { id: 'asc' }] })
  const seen = new Set<string>(), duplicates = new Set<string>()
  for (const row of rows) {
    const phone = normalizeInquiryPhone(row.phone)
    if (!phone) continue
    if (seen.has(phone)) duplicates.add(row.id)
    else seen.add(phone)
  }
  return duplicates
}

export function warpActivityId(sourceId: string) {
  return `mleverage_${createHash('sha256').update([INQUIRY_SOURCE, INQUIRY_COMPANY_ID, INQUIRY_HOMEPAGE_ID, sourceId.toLowerCase()].join(':')).digest('hex')}`
}

export async function requestWarpRegistration(db: PrismaClient, id: string, now = new Date()) {
  return db.$transaction(async (tx) => {
    const row = await tx.inquiry.findFirst({ where: { ...scope, id }, select: { warpDeliveredAt: true, warpError: true } })
    if (!row) return 'not_found' as const
    const status = warpDeliveryState(row, (await duplicateInquiryIds(tx)).has(id)).status
    if (['duplicate', 'duplicate_reviewed'].includes(status)) return 'duplicate' as const
    if (status === 'blocked') return 'blocked' as const
    if (status === 'delivered') return 'delivered' as const
    if (status === 'queued') return 'queued' as const
    const state = await tx.inquirySyncState.findUnique({ where: { id: INQUIRY_SCOPE_ID } })
    if (!state?.workerOwner || !['ready', 'running', 'success'].includes(state.status) || !state.workerHeartbeatAt || !state.workerLeaseExpiresAt
      || now.getTime() - state.workerHeartbeatAt.getTime() >= WORKER_LEASE_MS
      || state.workerHeartbeatAt.getTime() > now.getTime() + 5_000 || state.workerLeaseExpiresAt <= now) return 'worker_offline' as const
    const blocked = await tx.inquiry.findFirst({ where: { ...scope, warpDeliveredAt: null,
      warpError: { in: connectionErrors }, warpAttemptedAt: { gt: new Date(now.getTime() - RETRY_MS) } }, select: { id: true } })
    if (blocked) return 'connection_backoff' as const
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
    if (response.status === 400) {
      const body: unknown = await response.json().catch(() => null)
      return { error: body && typeof body === 'object' && 'error' in body && body.error === 'bad_payload'
        ? 'warp_registration_guard_unavailable' : 'warp_invalid_inquiry' }
    }
    if (response.status === 413) return { error: 'warp_invalid_inquiry' }
    if (response.status === 503 || response.status === 409) {
      const body: unknown = await response.json().catch(() => null)
      const code = body && typeof body === 'object' && 'error' in body ? body.error : null
      if (response.status === 409) return { error: code === 'phone_exists' ? 'warp_phone_duplicate'
        : code === 'ambiguous_phone' ? 'warp_customer_conflict' : 'warp_invalid_receipt' }
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
    db.inquiry.findMany({ where: scope, select: { id: true, warpDeliveredAt: true, warpError: true } }),
    duplicateInquiryIds(db),
  ])
  const counts = { delivered: 0, pending: 0, failed: 0, duplicates: 0, reviewPending: 0, reviewed: 0 }
  for (const row of rows) {
    const status = warpDeliveryState(row, localDuplicates.has(row.id)).status
    if (status === 'delivered') counts.delivered++
    else if (status === 'duplicate' || status === 'duplicate_reviewed') {
      counts.duplicates++
      if (status === 'duplicate_reviewed') counts.reviewed++
      else counts.reviewPending++
    }
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
      { OR: [{ warpError: null }, { warpError: { notIn: [...duplicateErrors, REVIEW_CLEARED, WARP_RECEIPT_UNVERIFIED, 'warp_registration_guard_unavailable', MANUAL_CONFIRMATION] } }] },
      ...(respectRetry ? [{ OR: [{ warpError: MANUAL_REGISTRATION }, { warpAttemptedAt: null }, { warpAttemptedAt: { lte: retryBefore } }] }] : []),
    ] },
    orderBy: [{ inquiryDate: 'asc' }, { inquiryTime: 'asc' }, { sourceId: 'asc' }],
    take, select: rowSelect,
  })
}

export function payloadFor(row: Awaited<ReturnType<typeof pendingRows>>[number]): InquiryPayload {
  return { ...scope, sourceId: row.sourceId.toLowerCase(), inquiryDate: row.inquiryDate,
    inquiryTime: row.inquiryTime, sourceStatus: row.sourceStatus ?? '', name: inquiryCustomerName(row.name, row.phone), phone: row.phone }
}

type PhoneResult = { sourceId: string; exists: boolean; receipt?: { ok: true } & Receipt }

/** Read-only lookup. Missing, partial and failed results never authorize registration. */
export async function lookupWarpPhones(rows: { sourceId: string; phone: string }[], send: typeof fetch, env: Env, signal?: AbortSignal): Promise<PhoneResult[] | null> {
  if (!rows.length) return []
  if (!keyConfigured(env) || rows.length > 50 || signal?.aborted) return null
  try {
    const response = await send(WARP_CHECK_ENDPOINT, {
      method: 'POST', redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
      headers: { 'Content-Type': 'application/json', 'x-api-key': env.WARP_MARKETING_API_KEY! },
      body: JSON.stringify({ ...scope, items: rows.map(row => ({ sourceId: row.sourceId.toLowerCase(), phone: row.phone })) }),
    })
    if (!response.ok) return null
    const body = await response.json()
    const ids = new Set(rows.map(row => row.sourceId.toLowerCase()))
    if (body?.ok !== true || !Array.isArray(body.results) || body.results.length !== rows.length || ids.size !== rows.length) return null
    for (const item of body.results) {
      if (!item || !ids.delete(item.sourceId) || typeof item.exists !== 'boolean'
        || (item.receipt !== undefined && (!item.exists || !validReceipt(item.receipt, item.sourceId)
          || item.receipt.created !== false || item.receipt.duplicate !== true))) return null
    }
    return body.results
  } catch {
    return null
  }
}

export async function checkedDeliver(payload: InquiryPayload, send: typeof fetch, env: Env, signal?: AbortSignal): Promise<Delivery> {
  const [match] = await lookupWarpPhones([payload], send, env, signal) ?? []
  if (!match) return { error: 'warp_duplicate_check_unavailable' }
  if (match.receipt) return { receipt: match.receipt, error: '' }
  if (match.exists) return { error: 'warp_phone_duplicate' }
  if (signal?.aborted) return { error: 'warp_unavailable' }
  // The receiver still rejects a customer added after lookup, inside its write transaction.
  return deliver(payload, send, env, signal)
}

async function recheckDuplicateReviews(db: PrismaClient, workerOwner: string, send: typeof fetch, env: Env, now: () => Date, signal?: AbortSignal) {
  const rows = await db.inquiry.findMany({ where: { ...scope, warpDeliveredAt: null, warpError: DUPLICATE_RECHECK }, take: 50, select: rowSelect })
  if (!rows.length || signal?.aborted) return
  await heartbeatWorker(db, workerOwner, now())
  const results = await lookupWarpPhones(rows, send, env, signal)
  if (signal?.aborted) return
  await heartbeatWorker(db, workerOwner, now())
  await db.$transaction(async tx => {
    const localDuplicates = await duplicateInquiryIds(tx)
    for (const row of rows) {
      const match = results?.find(item => item.sourceId === row.sourceId.toLowerCase())
      // A receipt is historical evidence, never a reason to claim a fresh registration.
      await tx.inquiry.updateMany({ where: { ...scope, id: row.id, phone: row.phone, warpDeliveredAt: null, warpError: DUPLICATE_RECHECK }, data: {
        warpError: !match ? DUPLICATE_RECHECK_FAILED : match.receipt ? WARP_RECEIPT_UNVERIFIED
          : match.exists ? 'warp_phone_duplicate' : localDuplicates.has(row.id) ? 'warp_local_duplicate' : REVIEW_CLEARED,
        ...(match?.receipt ? { warpCustomerId: match.receipt.customerId, warpActivityId: match.receipt.activityId, warpDeliveredAt: now(), warpAttemptedAt: now() } : {}),
      } })
    }
  })
}

export async function acknowledge(db: Pick<PrismaClient, 'inquiry'>, id: string, receipt: Receipt, at: Date, error: string | null = receipt.created ? null : WARP_RECEIPT_UNVERIFIED) {
  await db.inquiry.update({ where: { id }, data: {
    warpCustomerId: receipt.customerId, warpActivityId: receipt.activityId,
    warpDeliveredAt: at, warpAttemptedAt: at, warpError: error,
  } })
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
  const first = await checkedDeliver(payload, send, env)
  if (!first.receipt) return fail(first.error)
  await heartbeatWorker(db, workerOwner, now())
  const replay = await deliver(payload, send, env)
  if (!replay.receipt) return fail(replay.error)
  if (replay.receipt.created || !replay.receipt.duplicate
    || replay.receipt.customerId !== first.receipt.customerId || replay.receipt.activityId !== first.receipt.activityId) return fail('warp_pilot_replay_mismatch')
  await heartbeatWorker(db, workerOwner, now())
  await acknowledge(db, row.id, replay.receipt, now(), first.receipt.created ? null : WARP_RECEIPT_UNVERIFIED)
  return first.receipt.duplicate ? 'ok_recovered_receipt_unverified' : 'ok'
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
  await recheckDuplicateReviews(db, workerOwner, send, env, now, signal)
  if (signal?.aborted) return result
  const retryBefore = new Date(now().getTime() - RETRY_MS)
  const connectionBlocked = await db.inquiry.findFirst({
    where: { ...scope, warpDeliveredAt: null, warpError: { in: connectionErrors }, warpAttemptedAt: { gt: retryBefore } },
    select: { id: true },
  })
  if (connectionBlocked || signal?.aborted) return result
  const localDuplicates = await duplicateInquiryIds(db)
  const rows = result.configured ? await pendingRows(db, now(), 50, true, localDuplicates) : await db.inquiry.findMany({
    where: { ...scope, id: { notIn: [...localDuplicates] }, warpDeliveredAt: null, warpError: MANUAL_REGISTRATION },
    orderBy: [{ inquiryDate: 'asc' }, { inquiryTime: 'asc' }, { sourceId: 'asc' }], take: 50, select: rowSelect,
  })
  for (const row of rows) {
    if (signal?.aborted) break
    await heartbeatWorker(db, workerOwner, now())
    if (signal?.aborted) break
    // Re-read after asynchronous work: an operator may have held the row meanwhile.
    const current = await db.inquiry.findFirst({ where: { ...scope, id: row.id }, select: { ...rowSelect, warpDeliveredAt: true, warpError: true } })
    if (!current || !['pending', 'retrying', 'queued'].includes(warpDeliveryState(current, (await duplicateInquiryIds(db)).has(row.id)).status)
      || current.warpError === REVIEW_CLEARED) continue
    const delivery = await checkedDeliver(payloadFor(current), send, env, signal)
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
