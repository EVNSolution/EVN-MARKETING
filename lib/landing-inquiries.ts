import { createHash, createHmac } from 'node:crypto'
import type { PrismaClient } from '@/app/generated/prisma/client'

export const LANDING_POLICY_VERSION = '2026-10-07-v1'
export const landingScope = { source: 'evn-landing', companyScopeId: 'evnsolution', homepageScopeId: 'pv5' }
export const LANDING_WARP_SENDING = 'warp_landing_sending'
type LandingInput = { submissionId: string; name: string; phone: string; kind: 'consultation' | 'subsidy'; region: string | null }
type Environment = Readonly<Record<string, string | undefined>>
let writesSettled: Promise<unknown> = Promise.resolve()

function serialize<T>(write: () => Promise<T>) {
  const result = writesSettled.then(write)
  writesSettled = result.catch(() => {})
  return result
}

export function landingOrigin(env: Environment) {
  if (env.LANDING_INTAKE_ENABLED !== 'true' || !env.AUTH_SECRET || env.AUTH_SECRET.length < 32) return null
  try {
    const url = new URL(env.AUTH_URL ?? '')
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return null
    const local = env.NODE_ENV !== 'production' && ['127.0.0.1', 'localhost'].includes(url.hostname)
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return null
    return url.origin
  } catch { return null }
}

export function parseLandingInput(body: unknown): LandingInput | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const value = body as Record<string, unknown>
  if (typeof value.submissionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.submissionId)) return null
  if (typeof value.name !== 'string' || typeof value.phone !== 'string' || value.phone.length > 24) return null
  const name = value.name.trim(), phone = value.phone.replace(/[\s()-]/g, '')
  if (!name || name.length > 50 || /[\u0000-\u001f\u007f]/.test(name) || !/^(010\d{8}|01[16789]\d{7,8})$/.test(phone)) return null
  if (value.consent !== true || value.policyVersion !== LANDING_POLICY_VERSION || (value.kind !== 'consultation' && value.kind !== 'subsidy')) return null
  if (value.website !== undefined && value.website !== '') return null
  if (value.kind === 'subsidy' && (typeof value.region !== 'string' || !['서울', '경기', '인천'].includes(value.region))) return null
  return { submissionId: value.submissionId.toLowerCase(), name, phone, kind: value.kind as LandingInput['kind'], region: value.kind === 'subsidy' ? value.region as string : null }
}

export async function saveLandingInquiry(db: PrismaClient, input: LandingInput, secret: string, now = new Date()) {
  const fingerprint = createHash('sha256').update(JSON.stringify([input.name, input.phone, input.kind, input.region, LANDING_POLICY_VERSION])).digest('hex')
  return serialize(() => db.$transaction(async tx => {
    // First acquire SQLite's writer lock, before reading receipts or rate counters.
    // This also serializes the blue/green web processes sharing the database.
    await tx.$executeRaw`INSERT INTO "LandingThrottle" ("id", "windowStart", "count") VALUES ('lock', ${now.toISOString()}, 0) ON CONFLICT("id") DO UPDATE SET "count" = "count"`
    const previous = await tx.landingReceipt.findUnique({ where: { id: input.submissionId } })
    if (previous) {
      if (!previous.inquiryId || previous.closedAt) return { status: 'closed' as const }
      return { status: previous.fingerprint === fingerprint ? 'saved' as const : 'conflict' as const }
    }
    const hour = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000)
    const phoneKey = createHmac('sha256', secret).update(`landing-phone:${input.phone}`).digest('hex')
    const keys = [{ id: 'global', limit: 1000 }, { id: phoneKey, limit: 5 }]
    // No raw IP, phone number, or request body is kept in throttling records.
    await tx.landingThrottle.deleteMany({ where: { id: { not: 'lock' }, windowStart: { lt: new Date(now.getTime() - 2 * 3_600_000) } } })
    for (const { id, limit } of keys) {
      const counter = await tx.landingThrottle.findUnique({ where: { id } })
      if (counter && counter.windowStart.getTime() === hour.getTime() && counter.count >= limit) return { status: 'limited' as const }
    }
    for (const { id } of keys) {
      const counter = await tx.landingThrottle.findUnique({ where: { id } })
      await tx.landingThrottle.upsert({ where: { id }, create: { id, windowStart: hour, count: 1 }, update: { windowStart: hour, count: counter?.windowStart.getTime() === hour.getTime() ? counter.count + 1 : 1 } })
    }
    const kst = new Date(now.getTime() + 9 * 3_600_000).toISOString()
    await tx.landingReceipt.create({ data: {
      id: input.submissionId, fingerprint, kind: input.kind, region: input.region,
      consentVersion: LANDING_POLICY_VERSION, consentedAt: now,
      inquiry: { create: { ...landingScope, sourceId: input.submissionId, name: input.name, phone: input.phone,
        inquiryDate: kst.slice(0, 10), inquiryTime: kst.slice(11, 19), sourceStatus: '상담 대기', firstSeenAt: now, lastSeenAt: now } },
    } })
    return { status: 'saved' as const }
  }))
}

export async function closeLandingInquiry(db: PrismaClient, id: string, secret: string, now = new Date()) {
  return serialize(() => db.$transaction(async tx => {
    await tx.$executeRaw`UPDATE "LandingThrottle" SET "count" = "count" WHERE "id" = 'lock'`
    const inquiry = await tx.inquiry.findFirst({ where: { ...landingScope, id }, include: { landingReceipt: true } })
    if (!inquiry?.landingReceipt) return false
    if (inquiry.warpError === LANDING_WARP_SENDING) return 'sending' as const
    const phoneKey = createHmac('sha256', secret).update(`landing-phone:${inquiry.phone}`).digest('hex')
    await tx.landingThrottle.deleteMany({ where: { id: phoneKey } })
    await tx.landingReceipt.update({ where: { id: inquiry.landingReceipt.id }, data: {
      inquiryId: null, fingerprint: null, kind: null, region: null, consentVersion: null, consentedAt: null, closedAt: now,
    } })
    await tx.inquiry.delete({ where: { id } })
    return true
  }))
}

export async function handleLandingRequest(request: Request, db: PrismaClient, env: Environment = process.env) {
  const json = (status: number, value: object) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } })
  const origin = landingOrigin(env)
  if (!origin) return json(503, { error: '현재 온라인 상담 접수를 준비 중입니다. 잠시 후 다시 이용해 주세요.' })
  if (request.method !== 'POST') return json(405, { error: '지원하지 않는 요청입니다.' })
  if (request.headers.get('origin') !== origin || request.headers.get('sec-fetch-site') === 'cross-site') return json(403, { error: '홈페이지에서 다시 신청해 주세요.' })
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return json(415, { error: '요청 형식을 확인해 주세요.' })
  const reader = request.body?.getReader()
  if (!reader) return json(400, { error: '상담 내용을 입력해 주세요.' })
  let text = '', bytes = 0
  const decoder = new TextDecoder('utf-8', { fatal: true })
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > 4096) { await reader.cancel(); return json(413, { error: '입력 내용을 줄여 주세요.' }) }
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
  } catch { return json(400, { error: '요청 내용을 확인해 주세요.' }) } finally { reader.releaseLock() }
  let input: LandingInput | null
  try { input = parseLandingInput(JSON.parse(text)) } catch { input = null }
  if (!input) return json(400, { error: '이름, 연락처, 지역과 개인정보 동의를 확인해 주세요.' })
  try {
    const result = await saveLandingInquiry(db, input, env.AUTH_SECRET!)
    if (result.status === 'saved') return json(200, { ok: true, receipt: input.submissionId })
    if (result.status === 'limited') return json(429, { error: '현재 접수 요청이 많습니다. 잠시 후 다시 이용해 주세요.' })
    return json(409, { error: '이 신청은 이미 처리되었거나 내용이 변경되었습니다. 페이지를 새로 열어 주세요.' })
  } catch { return json(503, { error: '접수 결과를 확인하지 못했습니다. 입력 내용을 유지한 채 다시 시도해 주세요.' }) }
}
