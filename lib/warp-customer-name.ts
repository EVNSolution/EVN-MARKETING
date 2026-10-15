import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '@/app/generated/prisma/client'
import { inquiryReview } from './inquiry-review'
import { inquiryRealName, normalizeInquiryPhone } from './format'
import { deliveryScopes, keyConfigured, type Env } from './warp-delivery'
import { heartbeatWorker, INQUIRY_SCOPE_ID, WORKER_LEASE_MS } from './inquiry-sync'
import { withNameJobs } from './warp-customer-name-store'

const ENDPOINT = 'https://warp.cleversystem.ai/api/external/marketing-inquiries/customer-name'
export type NameResult = { ok: true; status: 'ready' | 'already_named' | 'same_name' | 'not_found' | 'ambiguous' | 'updated' | 'unchanged';
  customer?: { id: string; name: string; phone: string }; proposedName: string; previewToken?: string; auditId?: string }
export type NameJob = { id: string; inquiryId: string; candidateId: string; reviewToken: string; actor: { id: string; name: string };
  createdAt: number; updatedAt: number; phase: 'preview' | 'ready' | 'confirm' | 'done' | 'failed'; attempts: number; result?: NameResult; error?: string }
export type NameJobView = ReturnType<typeof nameJobView>
export class NameReviewError extends Error {
  constructor(message: string, public status = 409) { super(message) }
}
export function nameJobView(job: NameJob) {
  // The signed confirmation token remains between the worker and WARP.
  const customer = job.result?.customer
  const result = job.result && { status: job.result.status,
    customer: customer ? { id: customer.id, name: customer.name, phone: customer.phone } : undefined, proposedName: job.result.proposedName }
  return { id: job.id, phase: job.phase, candidateId: job.candidateId, result, error: job.error }
}

async function candidate(db: Pick<PrismaClient, 'inquiry'>, inquiryId: string, candidateId: string, reviewToken: string) {
  const review = await inquiryReview(db, inquiryId)
  if (!review || review.reviewToken !== reviewToken) throw new NameReviewError('문의 내용이 변경됐습니다. 검토창을 다시 열어 확인해 주세요.')
  if (!review.nameCandidates.some(item => item.id === candidateId)) throw new NameReviewError('같은 휴대폰 번호로 접수된 실명 문의를 선택해 주세요.', 400)
  const row = await db.inquiry.findFirst({ where: { ...deliveryScopes, id: candidateId } })
  if (!row || normalizeInquiryPhone(row.phone) !== normalizeInquiryPhone(review.row.phone) || !inquiryRealName(row.name, row.phone)) {
    throw new NameReviewError('이름 또는 연락처가 변경됐습니다. 다시 확인해 주세요.')
  }
  return { source: row.source, companyScopeId: row.companyScopeId, homepageScopeId: row.homepageScopeId,
    sourceId: row.sourceId, phone: normalizeInquiryPhone(row.phone), name: row.name!.trim() }
}

export async function requestNameJob(db: PrismaClient, inquiryId: string,
  input: { action: 'preview' | 'confirm'; candidateId: string; reviewToken: string; jobId?: string }, actor: NameJob['actor'],
  env: Env = process.env, now = new Date()) {
  if (!actor.id || !actor.name || actor.id !== actor.id.trim() || actor.name !== actor.name.trim()
    || actor.id.length > 128 || actor.name.length > 100 || /[\p{Cc}\p{Cf}]/u.test(actor.id + actor.name)) throw new NameReviewError('로그인 정보를 다시 확인해 주세요.', 401)
  return withNameJobs(db, env, async (jobs, tx) => {
    await candidate(tx, inquiryId, input.candidateId, input.reviewToken)
    const lease = await tx.inquirySyncState.findUnique({ where: { id: INQUIRY_SCOPE_ID } })
    if (!lease?.workerOwner || !lease.workerHeartbeatAt || !lease.workerLeaseExpiresAt || lease.workerLeaseExpiresAt <= now
      || now.getTime() - lease.workerHeartbeatAt.getTime() >= WORKER_LEASE_MS
      || lease.workerHeartbeatAt.getTime() > now.getTime() + 5000) {
      throw new NameReviewError('수집 연결이 끊겨 WARP를 확인할 수 없습니다. 연결 복구 후 다시 시도해 주세요.', 503)
    }
    const matches = (job: NameJob) => job.inquiryId === inquiryId && job.candidateId === input.candidateId
      && job.reviewToken === input.reviewToken && job.actor.id === actor.id
    if (input.action === 'confirm') {
      const job = jobs.find(item => item.id === input.jobId && matches(item))
      if (!job) throw new NameReviewError('이름 확인이 만료됐습니다. WARP 이름을 다시 확인해 주세요.')
      if (job.phase === 'confirm' || job.phase === 'done') return nameJobView(job)
      if (job.phase !== 'ready' || !job.result?.previewToken || job.result.status !== 'ready') throw new NameReviewError('변경 가능한 이름을 먼저 확인해 주세요.')
      job.phase = 'confirm'; job.attempts = 0; job.updatedAt = now.getTime()
      return nameJobView(job)
    }
    const existing = jobs.find(item => matches(item) && ['preview', 'confirm'].includes(item.phase))
    if (existing) return nameJobView(existing)
    if (jobs.length >= 100) throw new NameReviewError('이름 확인 요청이 많습니다. 잠시 후 다시 시도해 주세요.', 429)
    const job: NameJob = { id: randomUUID(), inquiryId, candidateId: input.candidateId, reviewToken: input.reviewToken,
      actor, createdAt: now.getTime(), updatedAt: now.getTime(), phase: 'preview', attempts: 0 }
    jobs.push(job)
    return nameJobView(job)
  }, now)
}

export async function readNameJob(db: PrismaClient, inquiryId: string, jobId: string, actorId: string, env: Env = process.env, now = new Date()) {
  return withNameJobs(db, env, async jobs => {
    const job = jobs.find(item => item.id === jobId && item.inquiryId === inquiryId && item.actor.id === actorId)
    if (!job) throw new NameReviewError('이름 확인이 만료됐습니다. WARP 이름을 다시 확인해 주세요.', 404)
    return nameJobView(job)
  }, now)
}

const unavailable = 'WARP 확인에 실패했습니다. 변경 결과가 불확실하면 WARP 고객관리에서 확인한 뒤 다시 조회해 주세요.'
async function sendNameRequest(payload: Awaited<ReturnType<typeof candidate>>, job: NameJob, send: typeof fetch, env: Env, signal?: AbortSignal) {
  if (!keyConfigured(env)) throw new NameReviewError('WARP 이름 보완 연결 설정이 필요합니다.', 503)
  const response = await send(ENDPOINT, { method: 'POST', redirect: 'error', cache: 'no-store',
    headers: { 'Content-Type': 'application/json', 'x-api-key': env.WARP_MARKETING_API_KEY! },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
    body: JSON.stringify({ ...payload, action: job.phase === 'confirm' ? 'confirm' : 'preview', actor: job.actor,
      ...(job.phase === 'confirm' ? { previewToken: job.result?.previewToken } : {}) }) })
  const reader = response.body?.getReader()
  if (!reader) throw new Error('invalid_response')
  const chunks: Uint8Array[] = []; let size = 0
  while (true) {
    const { done, value } = await reader.read(); if (done) break
    size += value.length
    if (size > 16_384) { await reader.cancel(); throw new Error('invalid_response') }
    chunks.push(value)
  }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as NameResult & { error?: string }
  if (!response.ok) {
    if (response.status === 409 || ['invalid_preview', 'stale_preview'].includes(body.error ?? '')) throw new NameReviewError('WARP 고객 정보가 바뀌었거나 확인이 만료됐습니다. WARP 이름을 다시 확인해 주세요.')
    if ([400, 401, 403, 404].includes(response.status) || body.error === 'not_configured') throw new NameReviewError('WARP 이름 보완 연결을 확인해 주세요. 고객 정보는 자동으로 덮어쓰지 않습니다.', 503)
    throw new Error('remote_unavailable')
  }
  const statuses = job.phase === 'confirm' ? ['updated', 'unchanged'] : ['ready', 'already_named', 'same_name', 'not_found', 'ambiguous']
  if (body.ok !== true || !statuses.includes(body.status) || body.proposedName !== payload.name) throw new Error('invalid_response')
  if (!['not_found', 'ambiguous'].includes(body.status)) {
    if (!body.customer || typeof body.customer.id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(body.customer.id)
      || typeof body.customer.name !== 'string' || body.customer.name.length > 200 || body.customer.phone !== payload.phone) throw new Error('invalid_response')
  }
  if (body.status === 'ready' && (typeof body.previewToken !== 'string' || body.previewToken.length > 2048
    || !body.previewToken || inquiryRealName(body.customer?.name, payload.phone))) throw new Error('invalid_response')
  if (job.phase === 'confirm' && (body.customer?.name !== payload.name || typeof body.auditId !== 'string' || !body.auditId)) throw new Error('invalid_response')
  return body
}

/** Uses the existing worker key and lease; the web process never receives WARP credentials. */
export async function dispatchNameJobs(db: PrismaClient, owner: string, signal?: AbortSignal, send: typeof fetch = fetch, env: Env = process.env, clock = () => new Date()) {
  const pending = await withNameJobs(db, env, async jobs => jobs.filter(job => ['preview', 'confirm'].includes(job.phase)).slice(0, 4), clock(), owner)
  for (const job of pending) {
    if (signal?.aborted) return
    await heartbeatWorker(db, owner, clock())
    let result: NameResult | undefined, error: string | undefined
    let failed = false
    try {
      const payload = await candidate(db, job.inquiryId, job.candidateId, job.reviewToken)
      result = await sendNameRequest(payload, job, send, env, signal)
    } catch (failure) {
      if (signal?.aborted) return // Retain the same confirmation for an idempotent retry after restart.
      failed = failure instanceof NameReviewError || job.attempts >= 2
      error = failure instanceof NameReviewError ? failure.message : unavailable
    }
    await withNameJobs(db, env, async jobs => {
      const current = jobs.find(item => item.id === job.id && item.phase === job.phase)
      if (!current) return
      current.updatedAt = clock().getTime(); current.attempts++
      if (result) { current.result = result; current.phase = result.status === 'ready' ? 'ready' : 'done'; delete current.error }
      else if (failed) { current.phase = 'failed'; current.error = error; if (current.result) delete current.result.previewToken }
    }, clock(), owner)
  }
}
