import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/db'
import { enqueueSync, manualSyncError } from '@/lib/inquiry-sync'

export async function POST(request: Request) {
  const session = await auth()
  const authError = manualSyncError(
    session?.user.role,
    request.url,
    request.headers.get('origin'),
    request.headers.get('x-forwarded-host') ?? request.headers.get('host'),
    request.headers.get('x-forwarded-proto'),
  )
  if (authError) {
    const message = authError === 401 ? '로그인이 필요합니다.' : authError === 403 ? '관리자만 실행할 수 있습니다.' : '잘못된 요청입니다.'
    return NextResponse.json({ error: message }, { status: authError })
  }

  try {
    const run = await enqueueSync(prisma, 'manual')
    return NextResponse.json(
      run ? { queued: true, runId: run.id } : { queued: false },
      { status: run ? 202 : 200 },
    )
  } catch {
    return NextResponse.json({ error: '동기화 요청을 처리하지 못했습니다.' }, { status: 500 })
  }
}
