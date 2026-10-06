import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/db'
import { inquiryReview, reviewInquiry } from '@/lib/inquiry-review'
import { manualSyncError } from '@/lib/inquiry-sync'

type Context = { params: Promise<{ id: string }> }
const validId = (id: string) => /^[A-Za-z0-9_-]{1,160}$/.test(id)

export async function GET(_request: Request, context: Context) {
  if (!(await auth())?.user) return NextResponse.json({ error: '로그인이 필요합니다.' }, { status: 401 })
  const { id } = await context.params
  if (!validId(id)) return NextResponse.json({ error: '문의를 확인해 주세요.' }, { status: 400 })
  try {
    const review = await inquiryReview(prisma, id)
    return review ? NextResponse.json(review, { headers: { 'Cache-Control': 'no-store' } })
      : NextResponse.json({ error: '문의를 찾을 수 없습니다.' }, { status: 404 })
  } catch {
    return NextResponse.json({ error: '검토 정보를 불러오지 못했습니다.' }, { status: 500 })
  }
}

export async function POST(request: Request, context: Context) {
  const session = await auth()
  const error = manualSyncError(session?.user.role, request.url, request.headers.get('origin'),
    request.headers.get('x-forwarded-host') ?? request.headers.get('host'), request.headers.get('x-forwarded-proto'))
  if (error) return NextResponse.json({ error: error === 401 ? '로그인이 필요합니다.' : error === 403 ? '관리자만 검토할 수 있습니다.' : '잘못된 요청입니다.' }, { status: error })
  const { id } = await context.params
  if (!validId(id)) return NextResponse.json({ error: '문의를 확인해 주세요.' }, { status: 400 })
  let input: unknown
  try {
    // Bound streamed input too; Content-Length alone can be omitted or incorrect.
    const reader = request.body?.getReader()
    if (!reader) throw new Error()
    const chunks: Uint8Array[] = []
    let length = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.length
      if (length > 1024) { await reader.cancel(); throw new Error() }
      chunks.push(value)
    }
    input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return NextResponse.json({ error: '검토 요청을 확인해 주세요.' }, { status: 400 })
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return NextResponse.json({ error: '검토 요청을 확인해 주세요.' }, { status: 400 })
  const body = input as Record<string, unknown>
  if (Object.keys(body).length !== 2 || !['hold', 'recheck'].includes(String(body.action)) || typeof body.reviewToken !== 'string' || !/^[a-f0-9]{64}$/.test(body.reviewToken)) {
    return NextResponse.json({ error: '검토 요청을 확인해 주세요.' }, { status: 400 })
  }
  try {
    const result = await reviewInquiry(prisma, id, body.action as 'hold' | 'recheck', body.reviewToken)
    if (result === 'queued') return NextResponse.json({ queued: true }, { status: 202 })
    if (result === 'reviewed') return NextResponse.json({ reviewed: true })
    const messages = { not_found: '문의를 찾을 수 없습니다.', stale: '검토 중 문의 정보가 바뀌었습니다. 새로고침 후 다시 확인해 주세요.',
      not_duplicate: '이미 상태가 변경됐습니다. 현재 문의 상태를 다시 확인해 주세요.', worker_offline: '수집 연결이 끊겨 재확인할 수 없습니다. 연결 복구 후 다시 요청해 주세요.' }
    return NextResponse.json({ error: messages[result] }, { status: result === 'not_found' ? 404 : result === 'worker_offline' ? 503 : 409 })
  } catch {
    return NextResponse.json({ error: '검토 요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.' }, { status: 500 })
  }
}
