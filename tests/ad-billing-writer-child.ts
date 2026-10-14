import { BillingError, emptyBilling } from '@/lib/ad-billing'
import { parseBillingCsv } from '@/lib/ad-billing-csv'
import { billingRevision, saveBilling } from '@/lib/ad-billing-store'
const now = new Date('2026-10-14T00:00:00.000Z')
async function main() {
  const input = parseBillingCsv(Buffer.from(`거래 일시,거래 유형,거래 내용,금액\n2026.09.01. 23:59:59,광고캐시 사용,합성 집행,${process.argv[3]}\n`),
    { start: '2026-09-01', end: '2026-09-30', scope: 'both', capturedAt: '2026-10-01T00:00:00.000Z', confirmed: true }, now)
  try { await saveBilling(input, billingRevision(emptyBilling('2026-09')), { UPLOADS_DIR: process.argv[2] }, now); console.log('saved') }
  catch (error) { if (error instanceof BillingError && error.status === 409) console.log('conflict'); else throw error }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
