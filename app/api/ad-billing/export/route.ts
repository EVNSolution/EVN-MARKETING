import { auth } from '@/auth'
import { BillingError, billingKinds, type BillingKind } from '@/lib/ad-billing'
import { billingRevision, readBilling } from '@/lib/ad-billing-store'
import { billingWorkbook } from '@/lib/ad-billing-xlsx'
import { billingDenied, billingHttpError, billingParams, billingResponseHeaders } from '@/lib/ad-billing-http'
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export async function GET(request: Request) {
  const denied = billingDenied((await auth())?.user.role); if (denied) return denied
  try {
    const params = billingParams(request, ['month', 'kind', 'revision']), kind = params.get('kind') as BillingKind
    if (!billingKinds.includes(kind)) throw new BillingError('invalid', '충전 또는 집행 유형을 선택해 주세요.')
    const record = await readBilling(params.get('month') ?? '')
    if (params.get('revision') !== billingRevision(record)) throw new BillingError('changed', '조회 이후 자료가 바뀌었습니다. 화면을 새로고침한 뒤 내려받아 주세요.', 409)
    const { buffer, filename } = await billingWorkbook(record, kind)
    return new Response(Uint8Array.from(buffer), { headers: { ...billingResponseHeaders,
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="daangn-${record.month}-${kind}.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Content-Length': String(buffer.length) } })
  } catch (error) { return billingHttpError(error) }
}
