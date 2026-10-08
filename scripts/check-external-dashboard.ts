import { launchSourceBrowser, openLogin, automaticLogin } from '@/workers/mleverage-source'
import { readSourceCredentials } from '@/workers/source-credentials'
import { readExternalDashboard } from '@/workers/mleverage-dashboard'
import { dashboardTotals, dashboardPercentages, mediaLabel } from '@/lib/external-dashboard'

async function main() {
  process.env.INQUIRY_BROWSER_HEADLESS = 'true'
  const credentials = await readSourceCredentials()
  if (!credentials) throw new Error('source_credentials_missing')
  const { browser, page } = await launchSourceBrowser()
  try {
    await openLogin(page)
    if (!(await automaticLogin(page, credentials))) throw new Error('source_credentials_invalid')
    const data = await readExternalDashboard(page)
    const mediaTotals: Record<string, number> = Object.create(null)
    for (const row of data.monthlyAdViews) mediaTotals[mediaLabel(row.media)] = (mediaTotals[mediaLabel(row.media)] ?? 0) + row.count
    console.log(JSON.stringify({
      ok: true, readOnly: true, totals: dashboardTotals(data), dates: data.aggregationDates,
      dailyViews: data.monthlyViews, dailyMedia: data.monthlyAdViews, mediaTotals,
      networks: { rows: data.monthlyInflows.length, total: data.monthlyInflows.reduce((sum, row) => sum + row.count, 0), percentages: dashboardPercentages(data.monthlyInflows.map(row => row.count)) },
      keywords: { rows: data.monthlyKeywords.length, total: data.monthlyKeywords.reduce((sum, row) => sum + row.count, 0), percentagesTotal: dashboardPercentages(data.monthlyKeywords.map(row => row.count)).reduce((sum, value) => sum + Math.round(value * 10), 0) / 10 },
    }))
  } finally { await browser.close() }
}
void main().catch(error => {
  const code = error instanceof Error && /^(dashboard_|source_credentials_)[a-z_]+$/.test(error.message) ? error.message : 'dashboard_check_failed'
  console.error(code)
  process.exitCode = 1
})
