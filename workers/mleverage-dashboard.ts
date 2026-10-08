import type { Page, Response as BrowserResponse } from 'playwright-core'
import { INQUIRY_COMPANY_ID, INQUIRY_HOMEPAGE_ID } from '@/lib/inquiry-sync'
import { dashboardResponseBody, parseDashboard } from '@/lib/external-dashboard'

const HOST = 'https://app.mleverage-admin.co.kr'
const API_PATH = `/maus/api/homepages/${INQUIRY_HOMEPAGE_ID}/dashboard/`
export const dashboardUrl = `${HOST}/dashboard?companyUuid=${INQUIRY_COMPANY_ID}&homepageUuid=${INQUIRY_HOMEPAGE_ID}`
export function dashboardResponseKind(url: string, method: string): 'overview' | 'acquisition' | null {
  const parsed = new URL(url)
  if (method !== 'GET' || parsed.origin !== HOST || parsed.search || parsed.hash) return null
  return parsed.pathname === `${API_PATH}overview` ? 'overview'
    : parsed.pathname === `${API_PATH}acquisition` ? 'acquisition' : null
}

// Observe the two normal dashboard requests in the existing authenticated browser context.
// This reader never calls inquiry reconciliation, source-status updates or CRM delivery.
export async function readExternalDashboard(authenticatedPage: Page, signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('dashboard_interrupted')
  const page = await authenticatedPage.context().newPage()
  let timer: ReturnType<typeof setTimeout> | undefined
  let fail: (reason: Error) => void = () => {}
  const abort = () => { fail(new Error('dashboard_interrupted')); void page.close().catch(() => {}) }
  const captured = new Map<string, unknown>()
  let onResponse: (response: BrowserResponse) => void = () => {}
  const responses = new Promise<void>((resolve, reject) => {
    fail = reject
    timer = setTimeout(() => reject(new Error('dashboard_timeout')), 50_000)
    onResponse = (response) => {
      const kind = dashboardResponseKind(response.url(), response.request().method())
      if (!kind || captured.has(kind)) return
      void (async () => {
        if ([401, 403].includes(response.status())) throw new Error('dashboard_login_required')
        if (!response.ok()) throw new Error('dashboard_source_error')
        if (Number(response.headers()['content-length'] ?? 0) > 5 * 1024 * 1024) throw new Error('dashboard_invalid_data')
        const bytes = await response.body()
        if (bytes.length > 5 * 1024 * 1024) throw new Error('dashboard_invalid_data')
        captured.set(kind, dashboardResponseBody(JSON.parse(bytes.toString('utf8'))))
        if (captured.size === 2) resolve()
      })().catch(error => reject(error instanceof Error && error.message.startsWith('dashboard_') ? error : new Error('dashboard_invalid_data')))
    }
    page.on('response', onResponse)
  })
  // Navigation may fail before we await the response pair.
  void responses.catch(() => {})
  signal?.addEventListener('abort', abort, { once: true })
  try {
    if (signal?.aborted) throw new Error('dashboard_interrupted')
    await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    const url = new URL(page.url())
    if (/login|sign-in/i.test(url.pathname)) throw new Error('dashboard_login_required')
    if (url.origin !== HOST || url.pathname !== '/dashboard'
      || url.searchParams.get('companyUuid') !== INQUIRY_COMPANY_ID
      || url.searchParams.get('homepageUuid') !== INQUIRY_HOMEPAGE_ID) throw new Error('dashboard_scope')
    await responses
    if (signal?.aborted) throw new Error('dashboard_interrupted')
    return parseDashboard(captured.get('overview'), captured.get('acquisition'))
  } catch (error) {
    if (signal?.aborted) throw new Error('dashboard_interrupted')
    throw error instanceof Error && error.message.startsWith('dashboard_') ? error : new Error('dashboard_source_error')
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    page.off('response', onResponse)
    await page.close().catch(() => {})
  }
}
