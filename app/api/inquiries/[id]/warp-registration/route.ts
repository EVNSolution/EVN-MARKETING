import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/db'
import { manualSyncError } from '@/lib/inquiry-sync'
import { requestWarpRegistration } from '@/lib/warp-delivery'

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await auth()
  const error = manualSyncError(session?.user.role, request.url, request.headers.get('origin'),
    request.headers.get('x-forwarded-host') ?? request.headers.get('host'), request.headers.get('x-forwarded-proto'))
  if (error) return NextResponse.json({ error: error === 401 ? '로그인이 필요합니다.' : error === 403 ? '관리자만 등록할 수 있습니다.' : '잘못된 요청입니다.' }, { status: error })
  const { id } = await context.params
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(id)) return NextResponse.json({ error: '문의를 확인해 주세요.' }, { status: 400 })
  try {
    const result = await requestWarpRegistration(prisma, id)
    if (result === 'queued') return NextResponse.json({ queued: true }, { status: 202 })
    if (result === 'delivered') return NextResponse.json({ delivered: true })
    const messages = {
      duplicate: '연락처가 중복된 문의입니다. 목록의 중복 사유를 확인해 주세요.',
      invalid_phone: '연락처 형식을 확인해 주세요.',
      duplicate_check_pending: 'WARP 고객 중복 여부를 확인 중입니다. 잠시 후 다시 확인해 주세요.',
      not_found: '문의를 찾을 수 없습니다.',
      worker_offline: '수집 연결을 확인한 뒤 다시 등록해 주세요.',
      connection_backoff: 'WARP 연결 오류로 등록을 잠시 대기 중입니다. 최근 오류 발생 후 1시간 뒤 다시 시도해 주세요.',
    }
    return NextResponse.json({ error: messages[result] }, { status: result === 'not_found' ? 404 : result === 'duplicate' ? 409 : result === 'invalid_phone' ? 400 : 503 })
  } catch {
    return NextResponse.json({ error: '등록 요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.' }, { status: 500 })
  }
}
