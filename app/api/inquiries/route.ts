import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/db'
import { duplicateInquiryIds, warpDeliveryState, warpDeliverySummary } from '@/lib/warp-delivery'
import { inquiryCustomerName } from '@/lib/format'
import { landingScope } from '@/lib/landing-inquiries'
import {
  INQUIRY_COMPANY_ID,
  INQUIRY_HOMEPAGE_ID,
  INQUIRY_SCOPE_ID,
  INQUIRY_SOURCE,
  inquirySyncStatus,
} from '@/lib/inquiry-sync'

const scope = {
  source: INQUIRY_SOURCE,
  companyScopeId: INQUIRY_COMPANY_ID,
  homepageScopeId: INQUIRY_HOMEPAGE_ID,
}

function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function positiveInteger(value: string | null, fallback: number) {
  if (value === null) return fallback
  return /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null
}

export async function GET(request: Request) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: '로그인이 필요합니다.' }, { status: 401 })

  const params = new URL(request.url).searchParams
  const page = positiveInteger(params.get('page'), 1)
  const limit = positiveInteger(params.get('limit'), 20)
  const from = params.get('from')?.trim() ?? ''
  const to = params.get('to')?.trim() ?? ''
  const status = params.get('status')?.trim() ?? ''
  const query = params.get('q')?.trim() ?? ''
  const review = params.get('review') ?? ''
  const source = params.get('source') ?? ''
  const visibleScope = source === 'landing' ? landingScope : source === 'collected' ? scope : { OR: [scope, landingScope] }
  const skip = page && limit ? (page - 1) * limit : NaN

  if (!page || !limit || limit > 200 || (from && !validDate(from)) || (to && !validDate(to)) ||
      (from && to && from > to) || status.length > 100 || query.length > 100 || !['', 'pending', 'reviewed'].includes(review) || !['', 'landing', 'collected'].includes(source) || !Number.isSafeInteger(skip)) {
    return NextResponse.json({ error: '조회 조건을 확인해 주세요.' }, { status: 400 })
  }

  try {
    const duplicates = await duplicateInquiryIds(prisma)
    const reviewRows = review ? await prisma.inquiry.findMany({ where: visibleScope, select: { id: true, warpDeliveredAt: true, warpError: true } }) : []
    const reviewIds = reviewRows.filter(row => warpDeliveryState(row, duplicates.has(row.id)).status === (review === 'pending' ? 'duplicate' : 'duplicate_reviewed')).map(row => row.id)
    const where = {
      AND: [visibleScope, ...(query ? [{ OR: [{ name: { contains: query } }, { phone: { contains: query } }] }] : [])],
      ...(review ? { id: { in: reviewIds } } : {}),
      ...(from || to ? { inquiryDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      ...(status ? { sourceStatus: status === '__empty__' ? null : status } : {}),
    }

    const now = new Date()
    const [total, rows, state, latestRun, statusRows, emptyStatusCount, activeRun, warp] = await Promise.all([
      prisma.inquiry.count({ where }),
      prisma.inquiry.findMany({
        where,
        orderBy: [{ inquiryDate: 'desc' }, { inquiryTime: 'desc' }, { sourceId: 'desc' }],
        skip,
        take: limit,
        select: {
          id: true, source: true, inquiryDate: true, inquiryTime: true, sourceStatus: true, name: true, phone: true,
          warpDeliveredAt: true, warpError: true,
          landingReceipt: { select: { kind: true, region: true, consentVersion: true, consentedAt: true } },
        },
      }),
      prisma.inquirySyncState.findUnique({
        where: { id: INQUIRY_SCOPE_ID },
        select: { status: true, workerHeartbeatAt: true, lastSuccessfulAt: true, nextRunAt: true },
      }),
      prisma.inquirySyncRun.findFirst({
        where: scope,
        orderBy: { createdAt: 'desc' },
        select: {
          status: true, trigger: true, readCount: true, createdCount: true, updatedCount: true,
          unchangedCount: true, pagesRead: true, createdAt: true, startedAt: true, heartbeatAt: true, completedAt: true,
        },
      }),
      prisma.inquiry.findMany({ where: visibleScope, distinct: ['sourceStatus'], select: { sourceStatus: true }, orderBy: { sourceStatus: 'asc' } }),
      prisma.inquiry.count({ where: { ...visibleScope, sourceStatus: null } }),
      prisma.inquirySyncRun.findFirst({
        where: { ...scope, status: { in: ['pending', 'running'] } },
        orderBy: { createdAt: 'asc' },
        select: { status: true, createdAt: true, heartbeatAt: true },
      }),
      warpDeliverySummary(prisma, process.env, visibleScope),
    ])

    const currentStatus = inquirySyncStatus(state, activeRun?.status, now)

    return NextResponse.json({
      rows: rows.map(({ warpDeliveredAt, warpError, ...row }) => ({
        ...row,
        name: inquiryCustomerName(row.name, row.phone),
        warpDelivery: warpDeliveryState({ warpDeliveredAt, warpError }, duplicates.has(row.id)),
      })),
      warp,
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
      filters: {
        statuses: statusRows.flatMap((row) => row.sourceStatus ? [row.sourceStatus] : []),
        hasEmptyStatus: emptyStatusCount > 0,
      },
      sync: {
        currentStatus,
        lastSuccessfulAt: state?.lastSuccessfulAt ?? null,
        nextRunAt: state?.nextRunAt ?? null,
        latestRun,
      },
    }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch {
    return NextResponse.json({ error: '문의 내역을 불러오지 못했습니다.' }, { status: 500 })
  }
}
