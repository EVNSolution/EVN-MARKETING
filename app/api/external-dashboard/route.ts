import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/db'
import { INQUIRY_SCOPE_ID, WORKER_LEASE_MS } from '@/lib/inquiry-sync'
import { readDashboardHistory } from '@/lib/external-dashboard-store'
import { parseDashboardQuery } from '@/lib/external-dashboard-history'
import { readRegisteredInflow } from '@/lib/registered-inflow'
import { AD_SPEND_START } from '@/lib/ad-spend'
import { readAdSpendView } from '@/lib/ad-spend-store'

export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' }

export async function GET(request: Request) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: '로그인이 필요합니다.' }, { status: 401, headers })
  let query
  try { query = parseDashboardQuery(new URL(request.url).searchParams) } catch {
    return NextResponse.json({ error: '날짜를 확인해 주세요. 오늘까지 최대 366일을 조회할 수 있습니다.' }, { status: 400, headers })
  }
  try {
    const [dashboard, state] = await Promise.all([
      readDashboardHistory(query),
      prisma.inquirySyncState.findUnique({ where: { id: INQUIRY_SCOPE_ID }, select: {
        workerOwner: true, workerHeartbeatAt: true, workerLeaseExpiresAt: true, nextRunAt: true, status: true,
      } }),
    ])
    const now = Date.now()
    const workerOnline = Boolean(state?.workerOwner && state.workerHeartbeatAt && state.workerLeaseExpiresAt
      && state.workerHeartbeatAt.getTime() > now - WORKER_LEASE_MS && state.workerHeartbeatAt.getTime() <= now + 5_000
      && state.workerLeaseExpiresAt.getTime() > now)
    const sourceReady = workerOnline && ['ready', 'running', 'success'].includes(state?.status ?? '')
    const registeredInflow = await readRegisteredInflow(prisma, dashboard.history)
    const adSpend = await readAdSpendView(dashboard.history.start ?? AD_SPEND_START, dashboard.history.end ?? dashboard.history.today)
    return NextResponse.json({ ...dashboard, registeredInflow, adSpend, canImportAdSpend: session.user.role === 'admin', workerOnline, sourceReady, nextRunAt: state?.nextRunAt?.toISOString() ?? null }, { headers })
  } catch (error) {
    if (error instanceof Error && error.message === 'dashboard_snapshot_missing') return NextResponse.json({ error: '선택한 수집일의 보관본이 없습니다.' }, { status: 404, headers })
    return NextResponse.json({ error: '저장된 대시보드를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.' }, { status: 503, headers })
  }
}
