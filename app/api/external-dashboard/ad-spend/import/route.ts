import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { manualSyncError } from '@/lib/inquiry-sync'
import { importDaangnCsv, previewDaangnCsv, readDaangnCsvBody } from '@/lib/daangn-ad-spend'
export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' }
export async function POST(request: Request) {
  const session = await auth()
  const denied = manualSyncError(session?.user.role, request.url, request.headers.get('origin'), request.headers.get('x-forwarded-host') ?? request.headers.get('host'), request.headers.get('x-forwarded-proto'))
  if (denied) return NextResponse.json({ error: '관리자 로그인과 요청 출처를 확인해 주세요.' }, { status: denied, headers })
  try {
    if (process.env.AUTH_URL && new URL(request.headers.get('origin')!).origin !== new URL(process.env.AUTH_URL).origin) return NextResponse.json({ error: '잘못된 요청 출처입니다.' }, { status: 400, headers })
    const params = new URL(request.url).searchParams
    for (const key of params.keys()) if (!['mode', 'start', 'end', 'hash'].includes(key) || params.getAll(key).length !== 1) throw new Error()
    const mode = params.get('mode')
    if (!['preview', 'import'].includes(mode ?? '')) throw new Error()
    const preview = previewDaangnCsv(await readDaangnCsvBody(request), params.get('start') ?? '', params.get('end') ?? '')
    if (mode === 'preview') return NextResponse.json({ preview }, { headers })
    if (params.get('hash') !== preview.hash) return NextResponse.json({ error: '파일 또는 기간이 바뀌었습니다. 다시 미리보기 해주세요.' }, { status: 409, headers })
    return NextResponse.json(await importDaangnCsv(preview), { headers })
  } catch (error) {
    const busy = error instanceof Error && error.message === 'ad_spend_writer_busy'
    if (error instanceof Error && error.message === 'ad_spend_storage_error') return NextResponse.json({ error: '저장된 광고비를 확인하지 못했습니다. 기존 자료를 유지하며 관리자 확인이 필요합니다.' }, { status: 503, headers })
    return NextResponse.json({ error: busy ? '광고비를 갱신 중입니다. 잠시 후 다시 가져와 주세요.' : '당근 원본 CSV의 기간·필수 열·EVN 캠페인·금액·중복 행을 확인해 주세요. 파일은 2MB까지 가능합니다.' }, { status: busy ? 409 : 400, headers })
  }
}
