import type { PrismaClient } from '@/app/generated/prisma/client'
import { normalizeInquiryPhone } from './format'
import { dashboardDate } from './external-dashboard'
import { dashboardDates, type DashboardHistoryView } from './external-dashboard-history'
import { deliveryScopes, warpDeliveryState } from './warp-delivery'

export type RegisteredInflow = { start: string; end: string; total: number; days: { date: string; count: number }[] }

export async function readRegisteredInflow(db: PrismaClient, range: Pick<DashboardHistoryView, 'start' | 'end' | 'today'>): Promise<RegisteredInflow> {
  // Select before applying the display range: a later inquiry must not recount an older completed phone.
  // This is a read of retained inquiries, not a durable identity/history store.
  const rows = await db.inquiry.findMany({ where: deliveryScopes, select: {
    id: true, phone: true, inquiryDate: true, inquiryTime: true, warpDeliveredAt: true, warpError: true,
  } })
  const first = new Map<string, { date: string; order: string }>()
  for (const row of rows) {
    if (warpDeliveryState(row, false).status !== 'delivered') continue
    const phone = normalizeInquiryPhone(row.phone)
    if (!phone) continue
    try { dashboardDate(row.inquiryDate) } catch { continue }
    if (row.inquiryDate > range.today) continue
    const time = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(row.inquiryTime)
      ? row.inquiryTime.length === 5 ? row.inquiryTime + ':00' : row.inquiryTime : '99:99:99'
    const order = `${row.inquiryDate}T${time}/${row.id}`
    if (!first.has(phone) || order < first.get(phone)!.order) first.set(phone, { date: row.inquiryDate, order })
  }
  const dates = [...first.values()].map(row => row.date).sort()
  const cutoff = new Date(Date.parse(range.today) - 365 * 86_400_000).toISOString().slice(0, 10)
  const start = range.start ?? (dates[0] && dates[0] > cutoff ? dates[0] : dates.length ? cutoff : range.today)
  const end = range.end ?? range.today
  const counts = new Map(dashboardDates(start, end).map(date => [date, 0]))
  for (const { date } of first.values()) if (counts.has(date)) counts.set(date, counts.get(date)! + 1)
  const days = [...counts].map(([date, count]) => ({ date, count }))
  return { start, end, total: days.reduce((total, day) => total + day.count, 0), days }
}
