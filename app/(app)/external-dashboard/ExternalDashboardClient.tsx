'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { SectionCard } from '@/components/SectionCard'
import { FIELD_CLS } from '@/lib/ui'
import { apiFetch } from '@/lib/release-client'
import { dashboardErrorText, dashboardPercentages, dashboardTotals, mediaLabel, type DashboardRecord, type ExternalDashboard } from '@/lib/external-dashboard'
import { dashboardKoreaDate, type DashboardDay, type DashboardHistoryView } from '@/lib/external-dashboard-history'

type Payload = { record: DashboardRecord | null; history?: DashboardHistoryView; workerOnline: boolean; sourceReady: boolean; nextRunAt: string | null }
const number = (value: number | null) => value === null ? '—' : value.toLocaleString('ko-KR')
const time = (value: string | null | undefined) => value
  ? new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false }) : '아직 없음'
const button = 'min-h-11 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50'
const mediaColors: Record<string, string> = { 구글: '#2563eb', 네이버: '#16a34a', 당근: '#ea580c', 카카오: '#ca8a04', 메타: '#7c3aed', 모비온: '#db2777', 타불라: '#0891b2', 토스: '#475569' }

export default function ExternalDashboardClient() {
  const [payload, setPayload] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [checkedAt, setCheckedAt] = useState(0)
  const [filter, setFilter] = useState('')
  const [draftStart, setDraftStart] = useState<string | null>(null)
  const [draftEnd, setDraftEnd] = useState<string | null>(null)
  const inFlight = useRef<AbortController | null>(null)
  const refresh = useCallback(async () => {
    inFlight.current?.abort()
    const controller = new AbortController()
    inFlight.current = controller
    setLoading(true)
    try {
      const response = await apiFetch('/api/external-dashboard' + (filter ? '?' + filter : ''), { cache: 'no-store', signal: controller.signal })
      if (!response.ok) throw new Error(response.status === 401 ? '로그인이 만료되었습니다. 다시 로그인해 주세요.' : response.status === 400
        ? '날짜를 확인해 주세요. 오늘까지 최대 366일을 조회할 수 있습니다. 기존 조회 결과를 유지합니다.'
        : response.status === 404 ? '선택한 수집일의 보관본이 없습니다. 기존 조회 결과를 유지합니다.' : '저장된 대시보드를 불러오지 못했습니다. 표시 중인 마지막 성공 데이터는 유지됩니다.')
      const result: Payload = await response.json()
      if (!controller.signal.aborted) { setPayload(result); setCheckedAt(Date.now()); setError('') }
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '연결을 확인해 주세요.')
    } finally { if (!controller.signal.aborted) setLoading(false) }
  }, [filter])
  useEffect(() => {
    const initial = setTimeout(() => { void refresh() }, 0)
    const timer = setInterval(() => { void refresh() }, 60_000)
    return () => { clearTimeout(initial); clearInterval(timer); inFlight.current?.abort() }
  }, [refresh])
  const record = payload?.record
  const history = payload?.history
  const data = history?.data ?? record?.data
  const rankingRecord = history?.snapshot ?? record
  const rankingData = rankingRecord?.data
  const rankingDates = rankingData?.aggregationDates ?? []
  const today = history?.today ?? dashboardKoreaDate()
  const start = draftStart ?? history?.start ?? today, end = draftEnd ?? history?.end ?? today
  const applyRange = (from: string, to: string) => {
    const params = new URLSearchParams(filter)
    params.set('start', from); params.set('end', to)
    setFilter(params.toString())
  }
  const totals = data ? dashboardTotals(data) : { visitors: null, pageviews: null }
  const dates = data?.aggregationDates ?? []
  const stale = Boolean(record?.lastSuccessfulAt && checkedAt - Date.parse(record.lastSuccessfulAt) > 2 * 3_600_000)
  return <div className="mx-auto max-w-7xl space-y-5 p-3 sm:p-6">
    <section className="rounded-xl border border-slate-200 bg-white p-4 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold text-slate-900">원본: mleverage · evnsolution.kr</p>
          <p className="mt-1 text-xs leading-5 text-slate-500">기존 문의 수집 일정에 맞춰 약 1시간마다 갱신합니다. 화면 새로고침은 저장된 결과를 다시 표시합니다.</p>
        </div>
        <button className={button} onClick={() => void refresh()} disabled={loading}>{loading ? '불러오는 중…' : '화면 새로고침'}</button>
      </div>
      <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-3">
        <div><dt className="text-slate-500">마지막 수집 성공 (한국 시간)</dt><dd className="mt-1 font-medium text-slate-900">{time(record?.lastSuccessfulAt)}</dd></div>
        <div><dt className="text-slate-500">마지막 수집 시도 (한국 시간)</dt><dd className="mt-1 font-medium text-slate-900">{time(record?.lastAttemptAt)}</dd></div>
        <div><dt className="text-slate-500">다음 수집 예정 (한국 시간)</dt><dd className="mt-1 font-medium text-slate-900">{time(payload?.nextRunAt)}</dd></div>
      </dl>
    </section>
    <div aria-live="polite" className="space-y-2 text-sm">
      {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-red-800">{error}</p>}
      {record?.error && <p role="status" className="rounded-lg bg-amber-50 p-3 text-amber-900">{dashboardErrorText[record.error] ?? '원본 수집을 완료하지 못했습니다.'} {data ? '마지막 성공 데이터를 표시합니다.' : '첫 수집이 완료되면 수치가 표시됩니다.'}</p>}
      {payload && !payload.workerOnline && <p className="rounded-lg bg-amber-50 p-3 text-amber-900">자동 수집 연결을 확인하지 못했습니다. 마지막 성공 시각을 확인해 주세요.</p>}
      {payload?.workerOnline && !payload.sourceReady && <p className="rounded-lg bg-amber-50 p-3 text-amber-900">수집기는 실행 중이며 원본 서비스 연결을 기다리고 있습니다. 자세한 연결 상태는 문의 내역에서 확인할 수 있습니다.</p>}
      {stale && <p className="rounded-lg bg-amber-50 p-3 text-amber-900">마지막 수집 성공 후 2시간이 지났습니다. 현재 표시된 수치는 최신이 아닐 수 있습니다.</p>}
      {!record?.data && !history?.availableStart && !loading && !error && <p className="rounded-lg border border-dashed border-slate-300 bg-white p-5 text-slate-600">아직 성공적으로 수집된 대시보드가 없습니다. 데이터가 확인되기 전에는 수치를 표시하지 않습니다.</p>}
    </div>
    {history && <section aria-label="날짜별 성과 조회" className="space-y-4 rounded-xl border border-slate-200 bg-white p-4">
      <div><h2 className="font-semibold text-slate-900">성과 날짜로 조회</h2><p className="mt-1 text-xs leading-5 text-slate-500">한국 시간 기준 · 최대 366일. 보관 범위: {history.availableStart ?? '아직 없음'}{history.availableEnd ? ` ~ ${history.availableEnd}` : ''}</p></div>
      <form onSubmit={event => { event.preventDefault(); applyRange(start, end) }} className="grid min-w-0 gap-3 sm:grid-cols-2">
        <label className="min-w-0 text-xs text-slate-600">성과 시작일<input type="date" required max={today} className={`${FIELD_CLS} mt-2 min-w-0 max-w-full`} value={start} onChange={event => setDraftStart(event.target.value)} /></label>
        <label className="min-w-0 text-xs text-slate-600">성과 종료일<input type="date" required max={today} className={`${FIELD_CLS} mt-2 min-w-0 max-w-full`} value={end} onChange={event => setDraftEnd(event.target.value)} /></label>
        <div className="flex flex-wrap gap-2 sm:col-span-2">
          <button className={button} type="submit" disabled={loading}>기간 조회</button>
          <button className={button} type="button" disabled={loading || !start} onClick={() => { setDraftEnd(start); applyRange(start, start) }}>시작일 하루 조회</button>
          <button className={button} type="button" disabled={loading} onClick={() => { setDraftStart(today); setDraftEnd(today); applyRange(today, today) }}>오늘</button>
          <button className={button} type="button" disabled={loading} onClick={() => { setDraftStart(null); setDraftEnd(null); setFilter('') }}>기존 집계 보기</button>
        </div>
      </form>
      {history.missingDays.length > 0 && <p role="status" className="rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-900">
        {history.missingDays.includes(today) ? `${today} 원본 공개 대기 · 오늘의 날짜별 수치를 아직 받지 못했습니다. 원본에 제공되면 기존 자동 수집 일정에 따라 보관합니다. ` : ''}
        방문·페이지뷰 미수집 {history.missingDays.length}일. 미수집일은 0으로 계산하지 않습니다.
      </p>}
      {history.missingMediaDays.length > 0 && <p className="text-xs text-slate-600">매체별 원본 값이 없는 날짜 {history.missingMediaDays.length}일은 수집 대기입니다. 제공된 매체 값만 표시하며 누락을 0으로 바꾸지 않습니다.</p>}
    </section>}
    <div className="grid gap-3 sm:grid-cols-3">
      <Metric title={history?.filtered ? '선택한 성과 기간' : '원본 집계 기간'} value={history?.start ? `${history.start} ~ ${history.end}` : dates.length ? `${dates[0]} ~ ${dates.at(-1)}` : '—'} detail={history ? `${dates.length}/${history.days.length}일 수집됨` : dates.length ? `${dates.length}일 집계` : '집계 없음'} small />
      <Metric title="전체 방문자" value={number(totals.visitors)} detail={history?.missingDays.length ? `수집된 ${dates.length}일의 방문자 합계 · 미수집일 제외` : '일별 방문자 합계'} />
      <Metric title="전체 페이지뷰" value={number(totals.pageviews)} detail={history?.missingDays.length ? `수집된 ${dates.length}일의 페이지뷰 합계 · 미수집일 제외` : '집계 기간 페이지 조회 수'} />
    </div>
    <p className="text-xs leading-5 text-slate-500">방문자는 일별 합계이며, 같은 방문자는 날짜마다 포함될 수 있습니다.</p>
    {data && <>
      <SectionCard color="slate" title="일별 방문자 · 페이지뷰"><VisitorChart data={data} days={history?.days} today={today} /></SectionCard>
      <SectionCard color="slate" title="매체별 일별 광고 유입"><MediaChart data={data} days={history?.days} /></SectionCard>
    </>}
    {rankingData && <>
      <section aria-label="원본 전체 기간 집계" className="rounded-xl border border-slate-200 bg-white p-4 text-sm">
        <h2 className="font-semibold text-slate-900">원본 전체 기간 집계</h2>
        <p className="mt-2 leading-6 text-slate-600">네트워크·키워드는 일별 수치가 제공되지 않습니다. 위에서 선택한 성과 날짜의 수치가 아니라, 아래 보관본의 원본 전체 기간 집계입니다.</p>
        <p className="mt-2 text-xs text-slate-600">실제 원본 집계 기간: {rankingDates[0] ?? '집계 없음'}{rankingDates.length ? ` ~ ${rankingDates.at(-1)} (${rankingDates.length}일)` : ''} · 수집시각: {time(rankingRecord?.lastSuccessfulAt)}</p>
        {history && <label className="mt-3 block text-xs text-slate-600">원본 보관본 수집일 (한국 시간)<select aria-label="원본 보관본 수집일 (한국 시간)" className={`${FIELD_CLS} mt-2`} value={new URLSearchParams(filter).get('snapshot') ?? ''} onChange={event => {
          const params = new URLSearchParams(filter)
          if (event.target.value) params.set('snapshot', event.target.value); else params.delete('snapshot')
          setFilter(params.toString())
        }}><option value="">최신 성공 보관본</option>{history.snapshotDays.map(day => <option key={day} value={day}>{day} 마지막 성공 보관본</option>)}</select></label>}
      </section>
      <div className="grid min-w-0 gap-5 xl:grid-cols-2">
        <Ranking title="유입 네트워크" period={rankingDates} collectedAt={rankingRecord?.lastSuccessfulAt} rows={rankingData.monthlyInflows.map(row => ({ label: row.source, count: row.count }))} />
        <Ranking title="유입 키워드" period={rankingDates} collectedAt={rankingRecord?.lastSuccessfulAt} rows={rankingData.monthlyKeywords.map(row => ({ label: row.keyword, count: row.count }))} />
      </div>
      <p className="text-xs leading-5 text-slate-500">광고 유입·유입 네트워크·유입 키워드는 원본의 서로 다른 집계입니다. 비율은 각 목록 전체의 합계를 기준으로 표시합니다.</p>
    </>}
  </div>
}

function Metric({ title, value, detail, small = false }: { title: string; value: string; detail: string; small?: boolean }) {
  return <section className="rounded-xl border border-slate-200 bg-white p-5">
    <h2 className="text-sm font-medium text-slate-600">{title}</h2>
    <p className={`mt-3 font-bold tracking-tight text-slate-900 ${small ? 'text-base' : 'text-3xl'}`}>{value}</p>
    <p className="mt-2 text-xs text-slate-500">{detail}</p>
  </section>
}

const xAt = (index: number, size: number) => 65 + index * 700 / Math.max(1, size - 1)
const yAt = (value: number, maximum: number) => 190 - value / Math.max(1, maximum) * 160
function ChartGrid({ maximum, dates }: { maximum: number; dates: string[] }) {
  return <>
    {[0, 0.5, 1].map(fraction => <g key={fraction}>
      <line x1="65" x2="765" y1={yAt(maximum * fraction, maximum)} y2={yAt(maximum * fraction, maximum)} stroke="#e2e8f0" />
      <text x="55" y={yAt(maximum * fraction, maximum) + 4} textAnchor="end" fontSize="11" fill="#64748b">{number(Math.round(maximum * fraction))}</text>
    </g>)}
    {dates.map((date, i) => (i === 0 || i === dates.length - 1 || i % Math.max(1, Math.ceil(dates.length / 5)) === 0) && <text key={date} x={xAt(i, dates.length)} y="218" textAnchor="middle" fontSize="11" fill="#64748b">{date.slice(5)}</text>)}
  </>
}
function VisitorChart({ data, days, today }: { data: ExternalDashboard; days?: DashboardDay[]; today: string }) {
  const rows = days ? days.map(day => ({ date: day.date, visitorCount: day.view?.visitorCount ?? null,
    pageViewCount: day.view?.pageViewCount ?? null, collectedAt: day.view?.collectedAt ?? null }))
    : [...data.monthlyViews].sort((a, b) => a.date.localeCompare(b.date)).map(row => ({ ...row, collectedAt: null }))
  if (!rows.length) return <p className="text-sm text-slate-500">원본에 일별 방문 집계가 없습니다.</p>
  const maximum = Math.max(1, ...rows.flatMap(row => [row.visitorCount ?? 0, row.pageViewCount ?? 0]))
  return <>
    <div className="flex flex-wrap gap-4 text-xs"><span className="text-blue-700">● 방문자</span><span className="text-emerald-700">● 페이지뷰</span></div>
    <div className="overflow-x-auto">
      <svg className="w-full min-w-[560px]" viewBox="0 0 820 235" role="img" aria-label="일별 방문자와 페이지뷰 추이. 정확한 수치는 아래 일별 수치 펼치기에서 확인할 수 있습니다.">
        <ChartGrid maximum={maximum} dates={rows.map(row => row.date)} />
        {(['visitorCount', 'pageViewCount'] as const).map((key, k) => <g key={key}>
          <path fill="none" stroke={k ? '#059669' : '#2563eb'} strokeWidth="2.5" d={rows.map((row, i) => row[key] === null ? '' : `${i && rows[i - 1][key] !== null ? 'L' : 'M'}${xAt(i, rows.length)},${yAt(row[key], maximum)}`).join(' ')} />
          {rows.map((row, i) => row[key] !== null && <circle key={row.date} cx={xAt(i, rows.length)} cy={yAt(row[key], maximum)} r="3" fill={k ? '#059669' : '#2563eb'}><title>{row.date} {k ? '페이지뷰' : '방문자'} {number(row[key])}</title></circle>)}
        </g>)}
      </svg>
    </div>
    <details className="mt-3 text-sm"><summary className="cursor-pointer py-2 font-medium">일별 수치 펼치기 ({rows.length}일)</summary>
      <div className="max-h-80 overflow-auto"><table className="w-full min-w-[520px] text-left text-xs"><thead><tr><th className="py-2">성과 날짜</th><th className="py-2 text-right">방문자</th><th className="py-2 text-right">페이지뷰</th><th className="px-3 py-2">수집시각 (한국 시간) / 상태</th></tr></thead><tbody>{rows.map(row => <tr key={row.date} className="border-t border-slate-100"><td className="py-2">{row.date}</td><td className="text-right">{number(row.visitorCount)}</td><td className="text-right">{number(row.pageViewCount)}</td><td className="px-3 py-2">{row.visitorCount === null ? row.date === today ? '원본 공개 대기' : '미수집 · 수집 대기' : time(row.collectedAt)}</td></tr>)}</tbody></table></div>
    </details>
  </>
}

function MediaChart({ data, days: observations }: { data: ExternalDashboard; days?: DashboardDay[] }) {
  const observedAt = new Map(observations?.flatMap(day => day.media.map(row => [JSON.stringify([row.date, row.media]), row.collectedAt] as const)) ?? [])
  const days = [...new Set(data.monthlyAdViews.map(row => row.date))].sort()
  const grouped = new Map(days.map(day => [day, new Map<string, number>()]))
  for (const row of data.monthlyAdViews) {
    const label = mediaLabel(row.media)
    if (Object.hasOwn(mediaColors, label)) grouped.get(row.date)!.set(label, (grouped.get(row.date)!.get(label) ?? 0) + row.count)
  }
  const media = Object.keys(mediaColors).filter(label => days.some(day => (grouped.get(day)!.get(label) ?? 0) > 0))
  const maximum = Math.max(1, ...days.map(day => media.reduce((total, label) => total + (grouped.get(day)!.get(label) ?? 0), 0)))
  const barWidth = Math.min(32, 500 / Math.max(1, days.length))
  return <>
    <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs">{media.map(label => <span key={label} style={{ color: mediaColors[label] }}>● {label}</span>)}</div>
    {media.length ? <div className="overflow-x-auto"><svg className="w-full min-w-[560px]" viewBox="0 0 820 235" role="img" aria-label="매체별 일별 광고 유입. 정확한 수치는 아래 매체별 원본 수치 펼치기에서 확인할 수 있습니다.">
      <ChartGrid maximum={maximum} dates={days} />
      {days.map((day, i) => {
        let total = 0
        return <g key={day}>{media.map(label => {
          const count = grouped.get(day)!.get(label) ?? 0
          total += count
          return <rect key={label} x={xAt(i, days.length) - barWidth / 2} y={yAt(total, maximum)} width={barWidth} height={count / maximum * 160} fill={mediaColors[label]}><title>{day} {label} {number(count)}</title></rect>
        })}</g>
      })}
    </svg></div> : <p className="py-5 text-sm text-slate-500">원본 차트에 표시할 광고 유입이 없습니다.</p>}
    <details className="mt-3 text-sm"><summary className="cursor-pointer py-2 font-medium">매체별 원본 수치 펼치기 ({data.monthlyAdViews.length}건)</summary>
      <div className="max-h-80 overflow-auto"><table className="w-full min-w-[520px] text-left text-xs"><thead><tr><th className="py-2">성과 날짜</th><th className="py-2">매체</th><th className="py-2 text-right">유입</th><th className="px-3 py-2">수집시각 (한국 시간)</th></tr></thead><tbody>{data.monthlyAdViews.map((row, index) => <tr key={index} className="border-t border-slate-100"><td className="whitespace-nowrap py-2 pr-2">{row.date}</td><td className="break-all py-2">{row.media}</td><td className="text-right">{number(row.count)}</td><td className="px-3 py-2">{time(observedAt.get(JSON.stringify([row.date, row.media])))}</td></tr>)}</tbody></table></div>
    </details>
  </>
}

function Ranking({ title, rows, period, collectedAt }: { title: string; rows: { label: string; count: number }[]; period: string[]; collectedAt?: string | null }) {
  const [query, setQuery] = useState('')
  const shares = dashboardPercentages(rows.map(row => row.count))
  const visible = rows.map((row, index) => ({ ...row, index, share: shares[index] })).filter(row => row.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
  return <SectionCard color="slate" title={title}>
    <p className="mb-3 text-xs leading-5 text-slate-500">원본 전체 기간 집계 · 일별 미제공<br />{period[0] ?? '집계 없음'}{period.length ? ` ~ ${period.at(-1)}` : ''}<br />보관본 수집: {time(collectedAt)}</p>
    <label className="mb-4 block text-xs text-slate-600">{title} 검색<input className={`${FIELD_CLS} mt-2`} value={query} onChange={event => setQuery(event.target.value)} placeholder="이름으로 검색" /></label>
    <div className="mb-3 flex flex-wrap justify-between gap-2 text-xs text-slate-500"><span>전체 {number(rows.length)}개 · 표시 {number(visible.length)}개</span><span>전체 합계 {number(rows.reduce((sum, row) => sum + row.count, 0))}</span></div>
    <div role="region" aria-label={`${title} 전체 목록`} tabIndex={0} className="max-h-[420px] overflow-y-auto rounded-lg border border-slate-200 focus:outline-2 focus:outline-blue-500">
      <table className="w-full table-fixed text-left text-xs"><thead className="sticky top-0 bg-slate-100 text-slate-600"><tr><th className="w-10 px-2 py-3">순위</th><th className="px-2 py-3">{title === '유입 키워드' ? '키워드' : '네트워크'}</th><th className="w-16 px-2 py-3 text-right">비율</th><th className="w-16 px-2 py-3 text-right">유입</th></tr></thead>
        <tbody>{visible.map(row => <tr key={row.index} className="border-t border-slate-100"><td className="px-2 py-3 text-slate-500">{row.index + 1}</td><td className="break-all px-2 py-3 font-medium text-slate-900">{row.label}</td><td className="px-2 py-3 text-right text-slate-600">{row.share.toFixed(1)}%</td><td className="px-2 py-3 text-right font-semibold text-slate-900">{number(row.count)}</td></tr>)}</tbody>
      </table>
      {!visible.length && <p className="p-5 text-center text-slate-500">{rows.length ? '검색 결과가 없습니다.' : '원본에 집계된 항목이 없습니다.'}</p>}
    </div>
  </SectionCard>
}
