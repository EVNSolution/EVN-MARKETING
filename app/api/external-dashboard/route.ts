import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/db'
import { INQUIRY_SCOPE_ID, WORKER_LEASE_MS } from '@/lib/inquiry-sync'
import { readDashboardRecord } from '@/lib/external-dashboard-store'

export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' }

export async function GET() {
  if (!(await auth())?.user) return NextResponse.json({ error: '로그인이 필요합니다.' }, { status: 401, headers })
  try {
    const [record, state] = await Promise.all([
      readDashboardRecord(),
      prisma.inquirySyncState.findUnique({ where: { id: INQUIRY_SCOPE_ID }, select: {
        workerOwner: true, workerHeartbeatAt: true, workerLeaseExpiresAt: true, nextRunAt: true, status: true,
      } }),
    ])
    const now = Date.now()
    const workerOnline = Boolean(state?.workerOwner && state.workerHeartbeatAt && state.workerLeaseExpiresAt
      && state.workerHeartbeatAt.getTime() > now - WORKER_LEASE_MS && state.workerHeartbeatAt.getTime() <= now + 5_000
      && state.workerLeaseExpiresAt.getTime() > now)
    const sourceReady = workerOnline && ['ready', 'running', 'success'].includes(state?.status ?? '')
    return NextResponse.json({ record, workerOnline, sourceReady, nextRunAt: state?.nextRunAt?.toISOString() ?? null }, { headers })
  } catch {
    return NextResponse.json({ error: '저장된 대시보드를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.' }, { status: 503, headers })
  }
}
