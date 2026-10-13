import { saveAdSpend } from '@/lib/ad-spend-store'
import { dashboardTimestamp } from '@/lib/external-dashboard-history'
import type { AdSpendAction } from '@/lib/ad-spend'

// One normalized, non-secret action on stdin; never accept credentials or print input/error bodies.
async function main() {
  if (process.argv.slice(2).join(' ') !== '--stdin') throw new Error('ad_spend_invalid_input')
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk); size += bytes.length
    if (size > 32 * 1024 * 1024) throw new Error('ad_spend_invalid_input')
    chunks.push(bytes)
  }
  const input: { action: AdSpendAction; attemptedAt?: string } = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!input || typeof input !== 'object' || Object.keys(input).some(k => !['action', 'attemptedAt'].includes(k))
    || (input.attemptedAt !== undefined && (!dashboardTimestamp(input.attemptedAt) || Date.parse(input.attemptedAt) > Date.now()))) throw new Error('ad_spend_invalid_input')
  const record = await saveAdSpend(input.action, process.env, input.attemptedAt ? new Date(input.attemptedAt) : new Date())
  console.log(JSON.stringify({ status: 'saved', campaigns: record.campaigns.length, observations: record.rows.length }))
}
main().catch(error => {
  const codes = ['ad_spend_invalid_input', 'ad_spend_invalid_data', 'ad_spend_storage_error', 'ad_spend_writer_busy', 'ad_spend_stale_attempt', 'ad_spend_conflicting_attempt']
  console.error(error instanceof Error && codes.includes(error.message) ? error.message : 'ad_spend_invalid_input')
  process.exitCode = 1
})
