import { CUSTOMER_LEAD_POLICY } from '@/lib/warp-delivery'

/** Explicit v1 provider fixture; legacy requests deliberately retain customer-only receipts. */
export function completedLead(input: { registrationPolicy?: string }, activityId: string) {
  return input.registrationPolicy === CUSTOMER_LEAD_POLICY ? { registration: {
    policy: CUSTOMER_LEAD_POLICY, state: 'complete', leadId: `lead_${activityId}`, registeredAt: '2026-10-13T00:00:00.000Z',
  } } : {}
}
