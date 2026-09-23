import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    const b = await req.json()
    const activity = await prisma.customerActivity.create({
      data: {
        customerId: id,
        type:       b.type       || '기타',
        date:       b.date       ? new Date(b.date) : new Date(),
        content:    b.content    || null,
        result:     b.result     || null,
        nextAction: b.nextAction || null,
        assignee:   b.assignee   || null,
      },
    })
    return NextResponse.json(activity, { status: 201 })
  } catch {
    return NextResponse.json({ error: '생성 실패' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: customerId } = await params
  const { searchParams } = new URL(req.url)
  const activityId = searchParams.get('activityId')
  if (!activityId) return NextResponse.json({ error: 'activityId 필요' }, { status: 400 })
  await prisma.customerActivity.deleteMany({ where: { id: activityId, customerId } })
  return NextResponse.json({ ok: true })
}
