import { NextRequest, NextResponse } from 'next/server'
import { releaseId } from '@/lib/release'

export function GET(request: NextRequest) {
  const requested = request.headers.get('x-deployment-id')
  if (releaseId && requested !== releaseId) return NextResponse.json({ code: 'release_expired' }, {
    status: 409, headers: { 'Cache-Control': 'no-store', 'X-Marketing-Release-Error': 'expired' },
  })
  return NextResponse.json({ deploymentId: releaseId }, { headers: { 'Cache-Control': 'no-store' } })
}
