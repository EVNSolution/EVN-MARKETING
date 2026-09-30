import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/db'
import { warpDeliveryState, warpDeliverySummary } from '@/lib/warp-delivery'
import { inquiryCustomerName } from '@/lib/format'
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
  const skip = page && limit ? (page - 1) * limit : NaN

  if (!page || !limit || limit > 200 || (from && !validDate(from)) || (to && !validDate(to)) ||
      (from && to && from > to) || status.length > 100 || query.length > 100 || !Number.isSafeInteger(skip)) {
    return NextResponse.json({ error: '조회 조건을 확인해 주세요.' }, { status: 400 })
  }

  const where = {
    ...scope,
    ...(from || to ? { inquiryDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
    ...(status ? { sourceStatus: status === '__empty__' ? null : status } : {}),
    ...(query ? { OR: [{ name: { contains: query } }, { phone: { contains: query } }] } : {}),
  }

  try {
    const now = new Date()
    const [total, rows, state, latestRun, statusRows, emptyStatusCount, activeRun, warp] = await Promise.all([
      prisma.inquiry.count({ where }),
      prisma.inquiry.findMany({
        where,
        orderBy: [{ inquiryDate: 'desc' }, { inquiryTime: 'desc' }, { sourceId: 'desc' }],
        skip,
        take: limit,
        select: {
          id: true, inquiryDate: true, inquiryTime: true, sourceStatus: true, name: true, phone: true,
          warpDeliveredAt: true, warpError: true,
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
      prisma.inquiry.findMany({ where: scope, distinct: ['sourceStatus'], select: { sourceStatus: true }, orderBy: { sourceStatus: 'asc' } }),
      prisma.inquiry.count({ where: { ...scope, sourceStatus: null } }),
      prisma.inquirySyncRun.findFirst({
        where: { ...scope, status: { in: ['pending', 'running'] } },
        orderBy: { createdAt: 'asc' },
        select: { status: true, createdAt: true, heartbeatAt: true },
      }),
      warpDeliverySummary(prisma),
    ])

    const currentStatus = inquirySyncStatus(state, activeRun?.status, now)

    return NextResponse.json({
      rows: rows.map(({ warpDeliveredAt, warpError, ...row }) => ({
        ...row,
        name: inquiryCustomerName(row.name, row.phone),
        warpDelivery: warpDeliveryState({ warpDeliveredAt, warpError }),
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
    })
  } catch {
    return NextResponse.json({ error: '문의 내역을 불러오지 못했습니다.' }, { status: 500 })
  }
}
