import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { fetchNaverDailyStats, parseNaverDailyStats } from '@/lib/naver-ad-spend'
import type { AdCampaign } from '@/lib/ad-spend'
const now = new Date('2026-09-13T00:00:00.000Z')
const campaign: AdCampaign = { provider: 'naver', accountId: '1234567', campaignId: 'cmp-synthetic-evn', start: '2026-09-11', end: null, lifecycle: 'active' }
const scope = { customerId: campaign.accountId, campaignId: campaign.campaignId, start: '2026-09-11', end: '2026-09-12', allowlist: [campaign] }
const response = { summary: { dateStart: scope.start, dateEnd: scope.end }, cycleBaseTm: '202609130900', data: [
  { dateStart: scope.start, dateEnd: scope.start, salesAmt: 1234, impCnt: 2, clkCnt: 1 },
  { dateStart: scope.end, dateEnd: scope.end, salesAmt: 0, impCnt: 0, clkCnt: 0 },
] }
const text = JSON.stringify(response)
assert.equal(parseNaverDailyStats(text, scope, now).provider, 'naver')
const huge = parseNaverDailyStats(text.replace('1234', '9007199254740993'), scope, now)
assert.equal(huge.rows[0].amount, '9007199254740993')
for (const bad of [text.replace('1234', '-1'), text.replace('1234', '1.5'), text.replace('1234', '1e3'), text.replace('1234', '9223372036854775808'),
  text.replace('2026-09-11', '2026-09-10'), JSON.stringify({ dailyStatResponse: response }), '{bad',
  JSON.stringify({ ...response, data: Array(2).fill(response.data[0]) }),
]) assert.throws(() => parseNaverDailyStats(bad, scope, now), /invalid_response/)
assert.throws(() => parseNaverDailyStats(text, { ...scope, customerId: '9876543' }, now), /invalid_scope/)
assert.throws(() => parseNaverDailyStats(text, { ...scope, end: '2026-12-12' }, new Date('2026-12-13')), /invalid_scope/)
async function main() {
  const credentials = { apiKey: 'synthetic-key', secretKey: 'synthetic-secret' }
  let calls = 0
  const mock: typeof fetch = async (input, init) => {
    calls++
    const url = new URL(String(input)), headers = new Headers(init?.headers)
    assert.equal(url.origin, 'https://api.searchad.naver.com'); assert.equal(url.pathname, '/stats')
    assert.equal(url.searchParams.get('id'), scope.campaignId); assert.equal(url.searchParams.has('ids'), false)
    assert.equal(url.searchParams.get('timeIncrement'), '1'); assert.equal(init?.method, 'GET'); assert.equal(init?.redirect, 'error')
    assert.equal(headers.get('X-Customer'), campaign.accountId, 'API customer ID is the explicit account scope')
    assert.equal(headers.get('X-Signature'), createHmac('sha256', credentials.secretKey).update(`${now.getTime()}.GET./stats`).digest('base64'))
    return new Response(text)
  }
  assert.equal((await fetchNaverDailyStats(scope, credentials, mock, now)).provider, 'naver')
  assert.equal(calls, 1)
  for (const status of [302, 401, 403, 500]) await assert.rejects(fetchNaverDailyStats(scope, credentials, async () => new Response('private raw error', { status }), now), /naver_ads_(fetch_failed|authentication_required)/)
  await assert.rejects(fetchNaverDailyStats(scope, credentials, async () => { throw new Error('private-secret-and-response') }, now), error => String(error) === 'Error: naver_ads_fetch_failed')
  await assert.rejects(fetchNaverDailyStats(scope, credentials, async () => new Response('x'.repeat(1024 * 1024 + 1)), now), /invalid_response/)
  console.log('Naver ads mock passed: fixed GET host, explicit campaign/customer scope, HMAC path, bounded response, int64 precision, date/envelope validation and sanitized errors; no live calls')
}
void main()
