import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { manualSyncError } from '@/lib/inquiry-sync'
import { importDaangnMcp, previewDaangnMcp, readDaangnMcpBody } from '@/lib/daangn-mcp-ad-spend'
export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' }
export async function POST(request: Request) {
  const session = await auth()
  const denied = manualSyncError(session?.user.role, request.url, request.headers.get('origin'), request.headers.get('x-forwarded-host') ?? request.headers.get('host'), request.headers.get('x-forwarded-proto'))
  if (denied) return NextResponse.json({ error: '관리자 로그인과 요청 출처를 확인해 주세요.' }, { status: denied, headers })
  try {
    if (process.env.AUTH_URL && new URL(request.headers.get('origin')!).origin !== new URL(process.env.AUTH_URL).origin) return NextResponse.json({ error: '잘못된 요청 출처입니다.' }, { status: 400, headers })
    const params = new URL(request.url).searchParams
    for (const key of params.keys()) if (!['mode', 'hash'].includes(key) || params.getAll(key).length !== 1) throw new Error()
    const mode = params.get('mode')
    if (!['preview', 'import'].includes(mode ?? '')) throw new Error()
    const bytes = await readDaangnMcpBody(request)
    if (mode === 'preview') return NextResponse.json({ preview: previewDaangnMcp(bytes) }, { headers })
    return NextResponse.json(await importDaangnMcp(bytes, params.get('hash') ?? ''), { headers })
  } catch (error) {
    const code = error instanceof Error ? error.message : ''
    if (code === 'ad_spend_storage_error') return NextResponse.json({ error: '저장된 광고비를 확인하지 못했습니다. 기존 자료를 유지합니다.' }, { status: 503, headers })
    const messages: Record<string, string> = {
      ad_spend_writer_busy: '광고비를 갱신 중입니다. 잠시 후 다시 저장해 주세요.',
      ad_spend_stale_attempt: '더 최근에 확인한 값이 있습니다. 당근에서 다시 조회해 주세요.',
      ad_spend_conflicting_attempt: '같은 조회 시각의 다른 결과가 있습니다. 당근에서 다시 조회해 주세요.',
      daangn_mcp_changed: '파일이 바뀌었습니다. 다시 미리보기 해주세요.',
    }
    return NextResponse.json({ error: messages[code] ?? '당근 MCP JSON의 계정·캠페인·하루 조회·금액·완료 응답을 확인해 주세요. 어제까지 최근 13개월 중 최대 31일, 2MB까지 가능합니다.' }, { status: messages[code] ? 409 : 400, headers })
  }
}
