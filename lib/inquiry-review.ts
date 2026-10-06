import { createHash } from 'node:crypto'
import type { PrismaClient } from '@/app/generated/prisma/client'
import { inquiryCustomerName, normalizeInquiryPhone } from '@/lib/format'
import { INQUIRY_SCOPE_ID, WORKER_LEASE_MS } from '@/lib/inquiry-sync'
import { DUPLICATE_RECHECK, DUPLICATE_REVIEWED, EXISTING_CUSTOMER_REVIEWED, WARP_EXISTING_CUSTOMER, duplicateInquiryIds, scope, warpDeliveryState } from '@/lib/warp-delivery'

type Db = Pick<PrismaClient, 'inquiry'>
export const reviewSelect = { id: true, inquiryDate: true, inquiryTime: true, name: true, phone: true,
  warpDeliveredAt: true, warpAttemptedAt: true, warpError: true, warpCustomerId: true, warpActivityId: true } as const

export async function inquiryReview(db: Db, id: string) {
  const row = await db.inquiry.findFirst({ where: { ...scope, id }, select: reviewSelect })
  if (!row) return null
  const [duplicates, all] = await Promise.all([
    duplicateInquiryIds(db),
    db.inquiry.findMany({ where: scope, select: reviewSelect, orderBy: [{ firstSeenAt: 'asc' }, { sourceId: 'asc' }] }),
  ])
  const phone = normalizeInquiryPhone(row.phone)
  const peers = phone ? all.filter(peer => peer.id !== id && normalizeInquiryPhone(peer.phone) === phone) : []
  const state = warpDeliveryState(row, duplicates.has(id))
  const reviewToken = createHash('sha256').update(JSON.stringify({ row, peers })).digest('hex')
  return {
    row: { id: row.id, name: inquiryCustomerName(row.name, row.phone), phone: row.phone, inquiryDate: row.inquiryDate, inquiryTime: row.inquiryTime },
    state, reviewToken, peerCount: peers.length,
    peers: peers.slice(0, 20).map(peer => ({ id: peer.id, name: inquiryCustomerName(peer.name, peer.phone), inquiryDate: peer.inquiryDate, inquiryTime: peer.inquiryTime, state: warpDeliveryState(peer, duplicates.has(peer.id)) })),
    // A historical receipt is never silently changed back into an unsent inquiry.
    hasReceipt: Boolean(row.warpDeliveredAt || row.warpActivityId),
    queued: row.warpError === DUPLICATE_RECHECK,
    canConfirm: state.status === 'duplicate' && row.warpError !== DUPLICATE_RECHECK,
    canRecheck: ['duplicate', 'duplicate_reviewed'].includes(state.status) && !row.warpDeliveredAt && !row.warpActivityId && row.warpError !== DUPLICATE_RECHECK,
  }
}

export async function reviewInquiry(db: PrismaClient, id: string, action: 'hold' | 'recheck', token: string, now = new Date()) {
  return db.$transaction(async tx => {
    const review = await inquiryReview(tx, id)
    if (!review) return 'not_found' as const
    if (review.reviewToken !== token) return 'stale' as const
    if (action === 'hold' && !review.canConfirm) return 'not_duplicate' as const
    if (action === 'recheck' && !review.canRecheck) return 'not_duplicate' as const
    if (action === 'recheck') {
      const worker = await tx.inquirySyncState.findUnique({ where: { id: INQUIRY_SCOPE_ID } })
      if (!worker?.workerOwner || !['ready', 'running', 'success'].includes(worker.status) || !worker.workerHeartbeatAt || !worker.workerLeaseExpiresAt
        || now.getTime() - worker.workerHeartbeatAt.getTime() >= WORKER_LEASE_MS || worker.workerHeartbeatAt.getTime() > now.getTime() + 5_000
        || worker.workerLeaseExpiresAt <= now) return 'worker_offline' as const
    }
    const row = await tx.inquiry.findFirstOrThrow({ where: { ...scope, id }, select: reviewSelect })
    await tx.inquiry.update({ where: { id }, data: {
      warpError: action === 'recheck' ? DUPLICATE_RECHECK : row.warpError === WARP_EXISTING_CUSTOMER ? EXISTING_CUSTOMER_REVIEWED : DUPLICATE_REVIEWED,
    } })
    // Preserve raw inquiry and receipt/attempt timestamps; a review is not a delivery.
    return action === 'recheck' ? 'queued' as const : 'reviewed' as const
  })
}
