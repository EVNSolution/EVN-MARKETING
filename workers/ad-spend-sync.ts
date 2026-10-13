import type { PrismaClient } from '@/app/generated/prisma/client'
import { AD_SPEND_START, type AdSpendAction, type AdSpendRecord } from '@/lib/ad-spend'
import { NAVER_CUSTOMER_ID, naverCampaigns } from '@/lib/ad-spend-config'
import { readAdSpend, saveAdSpendActions } from '@/lib/ad-spend-store'
import { dashboardKoreaDate } from '@/lib/external-dashboard-history'
import { fetchNaverDailyStats } from '@/lib/naver-ad-spend'
import { heartbeatWorker, INQUIRY_SCOPE_ID, SyncError } from '@/lib/inquiry-sync'
import { workerActivationAllowed } from './worker-activation'
const dayOffset = (day: string, days: number) => new Date(Date.parse(day) + days * 86_400_000).toISOString().slice(0, 10)
export function naverSpendRanges(record: AdSpendRecord, today: string) {
  const found = new Set(record.rows.filter(r => r.provider === 'naver' && r.accountId === NAVER_CUSTOMER_ID && r.amount !== null && !r.issue).map(r => `${r.date}/${r.campaignId}`))
  const recent = { start: [AD_SPEND_START, dayOffset(today, -30)].sort().at(-1)!, end: today }
  let missing: string | null = null
  for (let day = AD_SPEND_START; day <= today; day = dayOffset(day, 1)) {
    if (naverCampaigns.some(c => !found.has(`${day}/${c.campaignId}`))) { missing = day; break }
  }
  if (!missing) return [recent]
  const repair = { start: missing, end: [dayOffset(missing, 91), today].sort()[0] }
  const combinedStart = [repair.start, recent.start].sort()[0]
  if (Date.parse(today) - Date.parse(combinedStart) < 92 * 86_400_000) return [{ start: combinedStart, end: today }]
  return [{ start: repair.start, end: [repair.end, dayOffset(recent.start, -1)].sort()[0] }, recent]
}
export async function collectNaverAdSpend(db: PrismaClient, owner: string, signal: AbortSignal,
  env: Record<string, string | undefined> = process.env, fetchStats = fetchNaverDailyStats, now = new Date(), allowed = () => workerActivationAllowed(env)) {
  if (env.NAVER_AD_SPEND_ENABLED !== 'true' || signal.aborted || !await allowed()) return
  const record = await readAdSpend(env)
  const latest = record.rows.filter(r => r.provider === 'naver' && r.accountId === NAVER_CUSTOMER_ID).map(r => r.attemptedAt).sort().at(-1)
  if (latest && now.getTime() - Date.parse(latest) < 3_600_000) return
  const active = AbortSignal.any([signal, AbortSignal.timeout(45_000)])
  const fence = async (tx: Pick<PrismaClient, 'inquirySyncState'>) => {
    if (signal.aborted || !await allowed()) throw new SyncError('interrupted')
    const lease = await tx.inquirySyncState.findFirst({ where: { id: INQUIRY_SCOPE_ID, workerOwner: owner, workerLeaseExpiresAt: { gt: new Date() } }, select: { id: true } })
    if (!lease) throw new SyncError('lost_worker_lease')
  }
  const publish = (actions: AdSpendAction[]) => db.$transaction(async tx => {
    const lease = await tx.inquirySyncState.updateMany({ where: { id: INQUIRY_SCOPE_ID, workerOwner: owner, workerLeaseExpiresAt: { gt: new Date() } }, data: { updatedAt: new Date() } })
    if (lease.count !== 1) throw new SyncError('lost_worker_lease')
    await fence(tx)
    return saveAdSpendActions(actions, env, now, () => fence(tx))
  }, { maxWait: 5000, timeout: 10000 })
  const configuration: AdSpendAction = { type: 'configure', campaigns: naverCampaigns }
  if (!env.NAVER_AD_API_KEY || !env.NAVER_AD_SECRET_KEY) {
    if (naverCampaigns.every(c => record.campaigns.some(old => old.provider === c.provider && old.accountId === c.accountId && old.campaignId === c.campaignId))
      && record.accounts.some(a => a.provider === 'naver' && a.accountId === NAVER_CUSTOMER_ID && !a.connected)) return
    await publish([configuration, { type: 'connection', provider: 'naver', accountId: NAVER_CUSTOMER_ID, connected: false }])
    return
  }
  for (const range of naverSpendRanges(record, dashboardKoreaDate(now))) {
    await heartbeatWorker(db, owner); await fence(db)
    const rows: { date: string; campaignId: string; amount: string; vat: 'included' }[] = []
    let failed: 'fetch_failed' | 'authentication_required' | undefined
    for (const campaign of naverCampaigns) {
      try {
        if (active.aborted) { failed = 'fetch_failed'; break }
        await fence(db)
        const result = await fetchStats({ customerId: NAVER_CUSTOMER_ID, campaignId: campaign.campaignId, ...range, allowlist: naverCampaigns },
          { apiKey: env.NAVER_AD_API_KEY, secretKey: env.NAVER_AD_SECRET_KEY }, fetch, now, active)
        rows.push(...result.rows)
      } catch (error) {
        if (error instanceof SyncError || signal.aborted) throw error
        failed = error instanceof Error && error.message === 'naver_ads_authentication_required' ? 'authentication_required' : 'fetch_failed'
        break
      }
    }
    await heartbeatWorker(db, owner)
    const collect: AdSpendAction = { type: 'collect', provider: 'naver', accountId: NAVER_CUSTOMER_ID, ...range, result: failed ? { error: failed } : { rows } }
    await publish([configuration, { type: 'connection', provider: 'naver', accountId: NAVER_CUSTOMER_ID, connected: true }, collect])
    if (failed) break
  }
}
