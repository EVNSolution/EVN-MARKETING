import { auth } from '@/auth'
import { prisma } from '@/lib/db'
import { closeLandingInquiry } from '@/lib/landing-inquiries'

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user) return Response.json({ error: '로그인이 필요합니다.' }, { status: 401 })
  if (session.user.role !== 'admin') return Response.json({ error: '관리자만 상담을 종료할 수 있습니다.' }, { status: 403 })
  if (!process.env.AUTH_URL || !process.env.AUTH_SECRET) return Response.json({ error: '운영 설정을 확인해 주세요.' }, { status: 503 })
  if (request.headers.get('origin') !== new URL(process.env.AUTH_URL).origin) return Response.json({ error: '잘못된 요청입니다.' }, { status: 403 })
  try {
    const { id } = await context.params
    const closed = await closeLandingInquiry(prisma, id, process.env.AUTH_SECRET)
    return Response.json(closed ? { ok: true } : { error: '홈페이지 문의를 찾지 못했습니다.' }, { status: closed ? 200 : 404, headers: { 'Cache-Control': 'no-store' } })
  } catch { return Response.json({ error: '상담을 종료하지 못했습니다.' }, { status: 503 }) }
}
