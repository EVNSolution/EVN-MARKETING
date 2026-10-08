import type { Page } from 'playwright-core'
import type { PrismaClient } from '@/app/generated/prisma/client'
import { heartbeatWorker } from '@/lib/inquiry-sync'
import { dashboardErrorText } from '@/lib/external-dashboard'
import { saveDashboardRecord } from '@/lib/external-dashboard-store'
import { readExternalDashboard } from './mleverage-dashboard'

export async function collectExternalDashboard(db: PrismaClient, owner: string, page: Page, signal: AbortSignal) {
  await heartbeatWorker(db, owner)
  let result: Parameters<typeof saveDashboardRecord>[2]
  try { result = { data: await readExternalDashboard(page, signal) } } catch (error) {
    const code = error instanceof Error && Object.hasOwn(dashboardErrorText, error.message) ? error.message : 'dashboard_source_error'
    result = { error: code }
  }
  await heartbeatWorker(db, owner)
  await saveDashboardRecord(db, owner, result)
}
