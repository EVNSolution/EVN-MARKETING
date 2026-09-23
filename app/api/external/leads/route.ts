import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { prisma } from '@/lib/db'

/**
 * evnsolution.kr '고객 상담 신청' 폼 제출을 mleverage-admin(광고 매체 연동 툴) 쪽에서
 * webhook으로 전달받는 수신용 엔드포인트. 로그인 세션이 없는 외부 시스템 호출이므로
 * NextAuth 세션 대신 x-api-key 공유키로 인증한다 (proxy.ts에서 이 경로를 인증 미들웨어 제외 처리함).
 */
function isAuthorized(req: NextRequest): boolean {
  const expected = process.env.LEADS_INTAKE_API_KEY
  if (!expected) return false // 키가 설정되지 않았으면 항상 거부 (fail closed)

  const provided = req.headers.get('x-api-key') ?? ''
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: {
    name?: string
    phone?: string
    channel?: string      // 예: "네이버 GFA", "당근비즈니스"
    campaign?: string
    landingUrl?: string
    submittedAt?: string
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const name  = body.name?.trim()
  const phone = body.phone?.trim()
  if (!name || !phone) {
    return NextResponse.json({ error: 'name, phone은 필수입니다.' }, { status: 400 })
  }

  const memoParts = [
    body.campaign   ? `캠페인: ${body.campaign}`   : null,
    body.landingUrl ? `유입 URL: ${body.landingUrl}` : null,
  ].filter(Boolean)

  const existing = await prisma.customer.findFirst({ where: { phone } })

  if (existing) {
    await prisma.customerActivity.create({
      data: {
        customerId: existing.id,
        type:       '이벤트',
        date:       body.submittedAt ? new Date(body.submittedAt) : new Date(),
        content:    ['고객 상담 신청 재접수', body.channel ? `유입경로: ${body.channel}` : null, ...memoParts]
          .filter(Boolean).join(' / '),
      },
    })
    return NextResponse.json({ ok: true, customerId: existing.id, created: false })
  }

  const customer = await prisma.customer.create({
    data: {
      name,
      phone,
      customerSegment: 'B2C',
      status:          '잠재고객',
      source:          body.channel || '고객 상담 신청',
      leadType:        '상담신청',
      collectedAt:     body.submittedAt ? new Date(body.submittedAt) : new Date(),
      memo:            memoParts.length ? memoParts.join(' / ') : null,
    },
  })

  return NextResponse.json({ ok: true, customerId: customer.id, created: true }, { status: 201 })
}
