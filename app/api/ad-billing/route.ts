import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { previousBillingMonth } from '@/lib/ad-billing'
import { billingView, readBilling } from '@/lib/ad-billing-store'
import { billingDenied, billingHttpError, billingParams, billingResponseHeaders } from '@/lib/ad-billing-http'
export const dynamic = 'force-dynamic'
export async function GET(request: Request) {
  const denied = billingDenied((await auth())?.user.role); if (denied) return denied
  try {
    const params = billingParams(request, ['month'])
    return NextResponse.json(billingView(await readBilling(params.get('month') ?? previousBillingMonth())), { headers: billingResponseHeaders })
  } catch (error) { return billingHttpError(error) }
}
