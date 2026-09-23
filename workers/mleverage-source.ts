import { existsSync } from 'node:fs'
import { chromium, type Browser, type Page } from 'playwright-core'
import {
  INQUIRY_COMPANY_ID,
  INQUIRY_HOMEPAGE_ID,
  INQUIRY_PAGE_SIZE,
  SyncError,
  type SourcePage,
} from '@/lib/inquiry-sync'

const SOURCE_HOST = 'https://app.mleverage-admin.co.kr'
const SOURCE_LOGIN_URL = `${SOURCE_HOST}/login`
const NETWORK_ERRORS = new Set([
  'ERR_ADDRESS_UNREACHABLE',
  'ERR_CONNECTION_REFUSED',
  'ERR_CONNECTION_TIMED_OUT',
  'ERR_INTERNET_DISCONNECTED',
  'ERR_NAME_NOT_RESOLVED',
  'ERR_NETWORK_CHANGED',
])

export async function launchSourceBrowser(): Promise<{ browser: Browser, page: Page }> {
  const executablePath = browserExecutable()
  if (!executablePath) throw new SyncError('browser_not_found')
  const browser = await chromium.launch({ headless: browserHeadless(), executablePath })
  const context = await browser.newContext()
  return { browser, page: await context.newPage() }
}

export function browserHeadless(value = process.env.INQUIRY_BROWSER_HEADLESS, platform = process.platform) {
  if (value === undefined || value === '') return platform === 'linux'
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error('invalid_INQUIRY_BROWSER_HEADLESS')
}

export function sourceUrl(startDate: string, endDate: string, page: number) {
  const url = new URL('/inquiry-history', SOURCE_HOST)
  for (const [key, value] of Object.entries({
    companyUuid: INQUIRY_COMPANY_ID,
    homepageUuid: INQUIRY_HOMEPAGE_ID,
    page: String(page),
    size: String(INQUIRY_PAGE_SIZE),
    startDate,
    endDate,
    inquiryType: '',
    isDeleted: 'false',
    phoneNumber: '',
    consultationStatus: 'ALL',
  })) url.searchParams.set(key, value)
  return url.toString()
}

export async function openLogin(page: Page) {
  try {
    await page.goto(SOURCE_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 })
  } catch (error) {
    throw sourceError(error)
  }
}

export async function automaticLogin(page: Page, credentials: { username: string, password: string }) {
  let submitted = false
  try {
    if (!credentials.username || !credentials.password) throw new SyncError('source_credentials_incomplete')
    if (!isExactLoginUrl(page.url())) throw new SyncError('page_error')
    const username = page.getByRole('textbox', { name: '아이디', exact: true })
      .and(page.getByPlaceholder('아이디(이메일 또는 5자 이상)', { exact: true }))
    const password = page.locator('input[type="password"][placeholder="비밀번호(8~32자, 공백 불가)"]')
    const submit = page.getByRole('button', { name: '로그인', exact: true })
    await Promise.all([
      username.waitFor({ state: 'visible', timeout: 10_000 }),
      password.waitFor({ state: 'visible', timeout: 10_000 }),
      submit.waitFor({ state: 'visible', timeout: 10_000 }),
    ])
    if (await username.count() !== 1 || await password.count() !== 1 || await submit.count() !== 1) throw new SyncError('page_error')
    if (!isExactLoginUrl(page.url())) throw new SyncError('page_error')
    await username.fill(credentials.username)
    if (!isExactLoginUrl(page.url())) throw new SyncError('page_error')
    await password.fill(credentials.password)
    if (!isExactLoginUrl(page.url())) throw new SyncError('page_error')
    await submit.click()
    submitted = true
    await page.waitForURL((url) => url.origin === SOURCE_HOST && url.pathname !== '/login', { timeout: 30_000 })
    return true
  } catch (error) {
    if (error instanceof SyncError) throw error
    const networkError = safeNetworkErrorType(error)
    if (networkError) throw new SyncError(networkError)
    if (submitted && isExactLoginUrl(page.url()) && await hasExplicitLoginRejection(page)) return false
    throw new SyncError('page_error')
  }
}

async function hasExplicitLoginRejection(page: Page) {
  try {
    const messages = await page.locator('[role="alert"], [data-sonner-toast]').allTextContents()
    return messages.some((message) => /아이디|비밀번호/.test(message) && /일치|확인|잘못|실패|없/.test(message))
  } catch {
    return false
  }
}

export async function prepareProtectedPage(page: Page, startDate: string, endDate: string) {
  if (await sourceReady(page)) return true
  if (isLoginUrl(page.url()) || await page.locator('input[type="password"]').isVisible().catch(() => false)) return false
  try {
    await page.goto(sourceUrl(startDate, endDate, 1), { waitUntil: 'domcontentloaded', timeout: 45_000 })
    await Promise.race([
      page.getByRole('button', { name: /^총 [\d,]+개$/ }).waitFor({ state: 'visible', timeout: 30_000 }),
      page.locator('input[type="password"]').waitFor({ state: 'visible', timeout: 30_000 }),
    ])
    return sourceReady(page)
  } catch (error) {
    const networkError = safeNetworkErrorType(error)
    if (networkError) throw new SyncError(networkError)
    if (isLoginUrl(page.url()) || await page.locator('input[type="password"]').isVisible().catch(() => false)) return false
    if (new URL(page.url()).origin === SOURCE_HOST) return false
    throw sourceError(error)
  }
}

export async function readSourcePage(
  page: Page,
  startDate: string,
  endDate: string,
  pageNumber: number,
  previousFirstPageIds?: string[],
): Promise<SourcePage> {
  try {
    await page.goto(sourceUrl(startDate, endDate, pageNumber), { waitUntil: 'networkidle', timeout: 45_000 })
    if (isLoginUrl(page.url())) throw new SyncError('login_required')

    const totalButton = page.getByRole('button', { name: /^총 [\d,]+개$/ })
    await Promise.race([
      totalButton.waitFor({ state: 'visible', timeout: 30_000 }),
      page.locator('input[type="password"]').waitFor({ state: 'visible', timeout: 30_000 }).then(() => { throw new SyncError('login_required') }),
    ])
    if (await totalButton.count() !== 1) throw new SyncError('invalid_total')
    if (!(await page.getByRole('button', { name: '200개씩', exact: true }).isVisible())) throw new SyncError('invalid_page_size')

    const nameCells = page.locator('[data-airtable-body-cell="true"][data-col-key="name"]')
    const emptyMessage = page.getByText('조건에 맞는 문의가 없습니다.', { exact: true })
    await Promise.race([
      nameCells.first().waitFor({ state: 'visible', timeout: 30_000 }),
      emptyMessage.waitFor({ state: 'visible', timeout: 30_000 }),
    ])

    const totalMatch = ((await totalButton.textContent())?.trim() ?? '').match(/^총 ([\d,]+)개$/)
    if (!totalMatch) throw new SyncError('invalid_total')
    const total = Number(totalMatch[1].replaceAll(',', ''))
    if (!Number.isSafeInteger(total)) throw new SyncError('invalid_total')

    if (total === 0) {
      if (!(await emptyMessage.isVisible()) || await nameCells.count() !== 0) {
        throw new SyncError('empty_loading')
      }
      return { page: pageNumber, total, rows: [] }
    }

    const expectedRows = Math.min(INQUIRY_PAGE_SIZE, total - (pageNumber - 1) * INQUIRY_PAGE_SIZE)
    await page.waitForFunction(
      ({ expectedRows, pageNumber, previousFirstPageIds }) => {
        const cells = [...document.querySelectorAll<HTMLElement>('[data-airtable-body-cell="true"][data-col-key="name"]')]
        if (cells.length !== expectedRows) return false
        const ids = cells.map((cell) => cell.id.match(/^__cell_([0-9a-f-]+)_name$/i)?.[1] ?? '')
        const ready = cells.every((cell) => {
          const row = cell.parentElement
          return row?.querySelector<HTMLElement>('[data-col-key="문의일자"]')?.innerText.trim()
            && row.querySelector<HTMLElement>('[data-col-key="문의시간"]')?.innerText.trim()
            && row.querySelector<HTMLElement>('[data-col-key="phoneNumber"]')?.innerText.trim()
        })
        if (!ready || !ids.every(Boolean) || !previousFirstPageIds) return Boolean(ready && ids.every(Boolean))
        return pageNumber === 1 || ids.join() !== previousFirstPageIds.join()
      },
      { expectedRows, pageNumber, previousFirstPageIds },
      { timeout: 30_000 },
    )

    const currentPage = page.getByRole('button', { name: String(pageNumber), exact: true }).and(page.locator(':disabled'))
    if (await currentPage.count() !== 1) throw new SyncError('stale_page')

    const rows = await nameCells.evaluateAll((cells) => cells.map((nameCell) => {
      const row = nameCell.parentElement
      const [inquiryDate, inquiryTime, sourceStatus, phone] = ['문의일자', '문의시간', '상담상태', 'phoneNumber']
        .map((key) => row?.querySelector<HTMLElement>(`[data-airtable-body-cell="true"][data-col-key="${key}"]`)?.innerText.trim() ?? '')
      return {
        sourceId: nameCell.id.match(/^__cell_([0-9a-f-]+)_name$/i)?.[1] ?? '',
        inquiryDate,
        inquiryTime,
        sourceStatus,
        name: nameCell.textContent?.trim() ?? '',
        phone,
      }
    }))
    return { page: pageNumber, total, rows }
  } catch (error) {
    if (error instanceof SyncError) throw error
    if (isLoginUrl(page.url()) || await page.locator('input[type="password"]').isVisible().catch(() => false)) throw new SyncError('login_required')
    throw sourceError(error)
  }
}

export async function sourceReady(page: Page) {
  const url = new URL(page.url())
  return url.origin === SOURCE_HOST
    && url.pathname === '/inquiry-history'
    && !(await page.locator('input[type="password"]').isVisible().catch(() => false))
    && await page.getByRole('button', { name: /^총 [\d,]+개$/ }).isVisible().catch(() => false)
}

export function safeNetworkErrorType(error: unknown) {
  const token = error instanceof Error ? error.message.match(/net::(ERR_[A-Z0-9_]+)/)?.[1] : undefined
  return token && NETWORK_ERRORS.has(token) ? `offline_${token}` : null
}

function sourceError(error: unknown) {
  return new SyncError(safeNetworkErrorType(error) ?? 'page_error')
}

function browserExecutable() {
  const configured = process.env.INQUIRY_BROWSER_EXECUTABLE?.trim()
  let downloaded: string | undefined
  try { downloaded = chromium.executablePath() } catch {}
  return [
    configured,
    downloaded,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ].find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)))
}

function isLoginUrl(value: string) {
  const url = new URL(value)
  return url.origin !== SOURCE_HOST || /login|sign-in/i.test(url.pathname)
}

function isExactLoginUrl(value: string) {
  const url = new URL(value)
  return url.origin === SOURCE_HOST && url.pathname === '/login'
}
