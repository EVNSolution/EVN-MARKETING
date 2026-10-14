import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { manualSyncError } from '@/lib/inquiry-sync'
import { BillingError, type BillingScope } from '@/lib/ad-billing'
import { parseBillingCsv, readBillingCsvBody } from '@/lib/ad-billing-csv'
import { previewBilling, readBilling, saveBilling } from '@/lib/ad-billing-store'
import { billingHttpError, billingParams, billingResponseHeaders } from '@/lib/ad-billing-http'
export const dynamic = 'force-dynamic'
export async function POST(request: Request) {
  const session = await auth()
  const denied = manualSyncError(session?.user.role, request.url, request.headers.get('origin'), request.headers.get('x-forwarded-host') ?? request.headers.get('host'), request.headers.get('x-forwarded-proto'))
  if (denied) return NextResponse.json({ error: '관리자 로그인과 요청 출처를 확인해 주세요.' }, { status: denied, headers: billingResponseHeaders })
  try {
    if (process.env.AUTH_URL && new URL(request.headers.get('origin')!).origin !== new URL(process.env.AUTH_URL).origin) throw new BillingError('origin', '잘못된 요청 출처입니다.')
    const params = billingParams(request, ['mode', 'start', 'end', 'scope', 'capturedAt', 'confirmed', 'key', 'revision'])
    if (!['preview', 'import'].includes(params.get('mode') ?? '')) throw new BillingError('invalid', '미리보기 또는 저장을 선택해 주세요.')
    const now = new Date(), input = parseBillingCsv(await readBillingCsvBody(request), { start: params.get('start') ?? '', end: params.get('end') ?? '', scope: params.get('scope') as BillingScope, capturedAt: params.get('capturedAt') ?? '', confirmed: params.get('confirmed') === 'true' }, now)
    if (params.get('mode') === 'preview') return NextResponse.json(previewBilling(await readBilling(input.source.start.slice(0, 7)), input, now), { headers: billingResponseHeaders })
    if (params.get('key') !== input.source.key || !/^[a-f0-9]{64}$/.test(params.get('revision') ?? '')) throw new BillingError('changed', '파일 또는 입력 내용이 바뀌었습니다. 다시 미리보기 해주세요.', 409)
    return NextResponse.json(await saveBilling(input, params.get('revision')!, process.env, now), { headers: billingResponseHeaders })
  } catch (error) { return billingHttpError(error) }
}
