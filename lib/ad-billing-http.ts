import { NextResponse } from 'next/server'
import { BillingError } from './ad-billing'
export const billingResponseHeaders = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Cookie' }
export function billingHttpError(error: unknown) {
  return NextResponse.json({ error: error instanceof BillingError ? error.message : '정산 자료를 처리하지 못했습니다. 기존 자료는 유지됩니다. 잠시 후 다시 확인해 주세요.' }, { status: error instanceof BillingError ? error.status : 503, headers: billingResponseHeaders })
}
export function billingParams(request: Request, allowed: string[]) {
  const params = new URL(request.url).searchParams
  for (const key of params.keys()) if (!allowed.includes(key) || params.getAll(key).length !== 1) throw new BillingError('invalid', '요청 항목을 확인해 주세요.')
  return params
}
export function billingDenied(role?: string) {
  return role === 'admin' ? null : NextResponse.json({ error: '관리자 로그인이 필요합니다.' }, { status: role ? 403 : 401, headers: billingResponseHeaders })
}
