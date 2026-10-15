import { createHash } from 'node:crypto'
import type { PrismaClient } from '@/app/generated/prisma/client'
import { inquiryCustomerName, normalizeInquiryPhone } from '@/lib/format'
import { INQUIRY_SCOPE_ID, WORKER_LEASE_MS } from '@/lib/inquiry-sync'
import { landingScope } from '@/lib/landing-inquiries'
import { DUPLICATE_OF, DUPLICATE_RECHECK, DUPLICATE_RECHECK_FAILED, DUPLICATE_REVIEWED, EXISTING_CUSTOMER_REVIEWED, MANUAL_REGISTRATION, WARP_EXISTING_CUSTOMER,
  duplicateRepresentativeId, hasWarpEvidence, inquiryDuplicateContext, deliveryScopes, warpDeliveryState } from '@/lib/warp-delivery'

type Db = Pick<PrismaClient, 'inquiry'>
export const reviewSelect = { id: true, source: true, inquiryDate: true, inquiryTime: true, name: true, phone: true,
  warpDeliveredAt: true, warpAttemptedAt: true, warpError: true, warpCustomerId: true, warpActivityId: true } as const

export async function inquiryReview(db: Db, id: string) {
  const row = await db.inquiry.findFirst({ where: { ...deliveryScopes, id }, select: reviewSelect })
  if (!row) return null
  const [context, all] = await Promise.all([
    inquiryDuplicateContext(db),
    db.inquiry.findMany({ where: deliveryScopes, select: reviewSelect, orderBy: [{ firstSeenAt: 'asc' }, { sourceId: 'asc' }, { id: 'asc' }] }),
  ])
  const phone = normalizeInquiryPhone(row.phone)
  const peers = phone ? all.filter(peer => peer.id !== id && normalizeInquiryPhone(peer.phone) === phone) : []
  const representative = context.representatives.get(id)
  const stateFor = (item: typeof row) => {
    const rep = context.representatives.get(item.id)
    return warpDeliveryState(item, context.duplicates.has(item.id), rep?.id !== item.id ? rep : undefined)
  }
  const state = stateFor(row)
  const linked = row.warpError?.startsWith(DUPLICATE_OF)
  const selectable = [null, DUPLICATE_REVIEWED, 'warp_local_duplicate', DUPLICATE_RECHECK_FAILED, 'warp_duplicate_check_unavailable']
  const canRegisterRepresentative = Boolean(phone && peers.length && !linked && (!representative || representative.id === id)
    && [row, ...peers].every(item => !hasWarpEvidence(item) && (selectable.includes(item.warpError) || duplicateRepresentativeId(item.warpError) === id)))
  const reviewToken = createHash('sha256').update(JSON.stringify({ row, peers })).digest('hex')
  return {
    row: { id: row.id, source: row.source, name: inquiryCustomerName(row.name, row.phone), phone: row.phone, inquiryDate: row.inquiryDate, inquiryTime: row.inquiryTime },
    state, reviewToken, peerCount: peers.length,
    representative: representative ? { id: representative.id, name: inquiryCustomerName(representative.name, representative.phone), state: warpDeliveryState(representative) } : null,
    registrationQueued: Boolean(representative && ['queued', 'sending'].includes(warpDeliveryState(representative).status)),
    canRegisterRepresentative,
    peers: peers.slice(0, 20).map(peer => ({ id: peer.id, source: peer.source, name: inquiryCustomerName(peer.name, peer.phone), inquiryDate: peer.inquiryDate, inquiryTime: peer.inquiryTime, state: stateFor(peer) })),
    // A historical receipt is never silently changed back into an unsent inquiry.
    hasReceipt: Boolean(row.warpDeliveredAt || row.warpActivityId),
    queued: row.warpError === DUPLICATE_RECHECK,
    canConfirm: state.status === 'duplicate' && !linked && row.warpError !== DUPLICATE_RECHECK,
    canRecheck: ['duplicate', 'duplicate_reviewed'].includes(state.status) && !linked && !row.warpDeliveredAt && !row.warpActivityId && row.warpError !== DUPLICATE_RECHECK,
  }
}

export async function reviewInquiry(db: PrismaClient, id: string, action: 'hold' | 'recheck' | 'register-representative', token: string, now = new Date()) {
  return db.$transaction(async tx => {
    await tx.$executeRaw`UPDATE "Inquiry" SET "id" = "id" WHERE "id" = ${id}`
    const review = await inquiryReview(tx, id)
    if (!review) return 'not_found' as const
    if (review.reviewToken !== token) return 'stale' as const
    if (action === 'hold' && !review.canConfirm) return 'not_duplicate' as const
    if (action === 'recheck' && !review.canRecheck) return 'not_duplicate' as const
    if (action === 'register-representative' && !review.canRegisterRepresentative) return 'not_duplicate' as const
    if (action === 'recheck' || action === 'register-representative') {
      const worker = await tx.inquirySyncState.findUnique({ where: { id: INQUIRY_SCOPE_ID } })
      if (!worker?.workerOwner || (review.row.source !== landingScope.source && !['ready', 'running', 'success'].includes(worker.status)) || !worker.workerHeartbeatAt || !worker.workerLeaseExpiresAt
        || now.getTime() - worker.workerHeartbeatAt.getTime() >= WORKER_LEASE_MS || worker.workerHeartbeatAt.getTime() > now.getTime() + 5_000
        || worker.workerLeaseExpiresAt <= now) return 'worker_offline' as const
    }
    if (action === 'register-representative') {
      const phone = normalizeInquiryPhone(review.row.phone)
      const peers = (await tx.inquiry.findMany({ where: deliveryScopes, select: { id: true, phone: true } }))
        .filter(peer => peer.id !== id && normalizeInquiryPhone(peer.phone) === phone)
      await tx.inquiry.updateMany({ where: { id: { in: peers.map(peer => peer.id) } }, data: { warpError: `${DUPLICATE_OF}${id}` } })
      await tx.inquiry.update({ where: { id }, data: { warpError: MANUAL_REGISTRATION } })
      // Selection authorizes only this inquiry; the worker still checks WARP before writing.
      return 'queued' as const
    }
    const row = await tx.inquiry.findFirstOrThrow({ where: { ...deliveryScopes, id }, select: reviewSelect })
    await tx.inquiry.update({ where: { id }, data: {
      warpError: action === 'recheck' ? DUPLICATE_RECHECK : row.warpError === WARP_EXISTING_CUSTOMER ? EXISTING_CUSTOMER_REVIEWED : DUPLICATE_REVIEWED,
    } })
    // Preserve raw inquiry and receipt/attempt timestamps; a review is not a delivery.
    return action === 'recheck' ? 'queued' as const : 'reviewed' as const
  })
}
