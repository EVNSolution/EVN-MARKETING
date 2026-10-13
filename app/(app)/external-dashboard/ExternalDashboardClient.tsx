'use client'

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { SectionCard } from '@/components/SectionCard'
import { FIELD_CLS } from '@/lib/ui'
import { apiFetch } from '@/lib/release-client'
import { dashboardErrorText, dashboardPercentages, dashboardTotals, mediaLabel, type DashboardRecord, type ExternalDashboard } from '@/lib/external-dashboard'
import { dashboardKoreaDate, type DashboardDay, type DashboardHistoryView } from '@/lib/external-dashboard-history'
import type { RegisteredInflow } from '@/lib/registered-inflow'
import { adProviders, adProviderLabels, formatKrw, spendStatusLabels, vatLabels, type AdSpendView, type SpendSummary } from '@/lib/ad-spend'

type Payload = { record: DashboardRecord | null; history?: DashboardHistoryView; registeredInflow?: RegisteredInflow; adSpend?: AdSpendView; workerOnline: boolean; sourceReady: boolean; nextRunAt: string | null }
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
  const inflow = payload?.registeredInflow
  const data = history?.data ?? record?.data
  const rankingRecord = history?.snapshot ?? record
  const rankingData = rankingRecord?.data
  const rankingDates = rankingData?.aggregationDates ?? []
  const today = history?.today ?? dashboardKoreaDate()
  const start = draftStart ?? history?.start ?? inflow?.start ?? today, end = draftEnd ?? history?.end ?? inflow?.end ?? today
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
      {record?.error && <p role="status" className="rounded-lg bg-amber-50 p-3 text-amber-900">{dashboardErrorText[record.error] ?? '원본 수집을 완료하지 못했습니다.'} {record.data || history?.availableStart ? '마지막 성공 데이터를 표시합니다.' : '첫 수집이 완료되면 수치가 표시됩니다.'}</p>}
      {payload && !payload.workerOnline && <p className="rounded-lg bg-amber-50 p-3 text-amber-900">자동 수집 연결을 확인하지 못했습니다. 마지막 성공 시각을 확인해 주세요.</p>}
      {payload?.workerOnline && !payload.sourceReady && <p className="rounded-lg bg-amber-50 p-3 text-amber-900">수집기는 실행 중이며 원본 서비스 연결을 기다리고 있습니다. 자세한 연결 상태는 문의 내역에서 확인할 수 있습니다.</p>}
      {stale && <p className="rounded-lg bg-amber-50 p-3 text-amber-900">마지막 수집 성공 후 2시간이 지났습니다. 현재 표시된 수치는 최신이 아닐 수 있습니다.</p>}
      {!record?.data && !history?.availableStart && !loading && !error && <p className="rounded-lg border border-dashed border-slate-300 bg-white p-5 text-slate-600">아직 성공적으로 수집된 대시보드가 없습니다. 외부 방문·광고 수치는 수집 후 표시하며, 등록완료 DB 유입은 현재 보관 문의로 집계합니다.</p>}
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
        {history.missingDays.includes(today) ? `${today} 원본 공개 대기 · 오늘의 방문·페이지뷰 수치를 아직 받지 못했습니다. 원본에 제공되면 기존 자동 수집 일정에 따라 보관합니다. ` : ''}
        방문·페이지뷰 미수집 {history.missingDays.length}일. 미수집일은 0으로 계산하지 않습니다.
      </p>}
      {history.missingMediaDays.length > 0 && <p className="text-xs text-slate-600">매체별 원본 값이 없는 날짜 {history.missingMediaDays.length}일은 수집 대기입니다. 제공된 매체 값만 표시하며 누락을 0으로 바꾸지 않습니다.</p>}
    </section>}
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Metric title={history?.filtered ? '선택한 성과 기간' : '원본 집계 기간'} value={history?.start ? `${history.start} ~ ${history.end}` : dates.length ? `${dates[0]} ~ ${dates.at(-1)}` : '—'} detail={history ? `${dates.length}/${history.days.length}일 수집됨` : dates.length ? `${dates.length}일 집계` : '집계 없음'} small />
      <Metric title="전체 방문자" value={number(totals.visitors)} detail={history?.missingDays.length ? `수집된 ${dates.length}일의 방문자 합계 · 미수집일 제외` : '일별 방문자 합계'} />
      <Metric title="전체 페이지뷰" value={number(totals.pageviews)} detail={history?.missingDays.length ? `수집된 ${dates.length}일의 페이지뷰 합계 · 미수집일 제외` : '집계 기간 페이지 조회 수'} />
      <Metric title="등록완료 DB 유입" value={inflow ? `${number(inflow.total)}건` : '—'} detail="기존 수집 문의 · 새 홈페이지 문의 모두 포함" />
    </div>
    <p className="text-xs leading-5 text-slate-500">방문자는 일별 합계이며, 같은 방문자는 날짜마다 포함될 수 있습니다.</p>
    {inflow && <SectionCard color="slate" title="일별 DB 유입">
      <p className="mb-2 text-xs leading-5 text-slate-600">현재 보관된 등록완료 문의 기준, 휴대폰 중복 제외, 유입일 기준 · 기존 수집 문의와 새 홈페이지 문의 모두 포함</p>
      <p className="mb-3 text-xs leading-5 text-slate-500">{inflow.start} ~ {inflow.end} · 해당 날짜에 보관된 완료 문의가 없으면 0건입니다. 개인정보 삭제 시 집계에서도 제외됩니다.{!history?.start && ' 외부 집계 기간이 없으면 보관 문의의 첫 유입일부터 오늘까지 최대 366일을 표시합니다.'}</p>
      <RegisteredInflowChart key={filter} data={inflow} />
    </SectionCard>}
    {payload?.adSpend && <AdSpendSection key={filter} data={payload.adSpend} />}
    {data && <>
      <SectionCard color="slate" title="일별 방문자 · 페이지뷰"><VisitorChart key={filter} data={data} days={history?.days} today={today} /></SectionCard>
      <SectionCard color="slate" title="매체별 일별 광고 유입"><MediaChart key={filter} data={data} days={history?.days} /></SectionCard>
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

const chartRight = (width: number) => width - (width < 560 ? 5 : 55)
const xSpacing = (size: number, width: number) => {
  const span = chartRight(width) - 65 - 2 * (width < 560 ? 16 : 35)
  // Reserve space for six readable dates while progressively expanding short ranges.
  return Math.min(100, Math.max(36, span / 5), span / Math.max(1, size - 1))
}
const xAt = (index: number, size: number, width: number) =>
  (65 + chartRight(width)) / 2 + (index - (size - 1) / 2) * xSpacing(size, width)
const yAt = (value: number, maximum: number) => 190 - value / Math.max(1, maximum) * 160
type ChartDay = { date: string; values: { label: string; color: string; value: number | null; formatted?: string }[] }
function ChartFrame({ days, label, children }: { days: ChartDay[]; label: string; children: (width: number) => ReactNode }) {
  const size = days.length
  const container = useRef<HTMLDivElement>(null)
  const card = useRef<HTMLDivElement>(null)
  const targets = useRef<(SVGRectElement | null)[]>([])
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const tooltipId = useId()
  const [width, setWidth] = useState(820)
  const [focused, setFocused] = useState(0)
  const [active, setActive] = useState<{ index: number; mode: 'hover' | 'focus' | 'pinned' } | null>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const keepOpen = () => clearTimeout(closeTimer.current)
  const dismiss = () => { keepOpen(); setActive(null) }
  const leave = () => {
    keepOpen()
    if (active?.mode === 'hover') closeTimer.current = setTimeout(() => setActive(null), 220)
  }
  const show = (index: number, mode: 'hover' | 'focus') => {
    keepOpen()
    setActive(current => current?.index === index && current.mode === 'pinned' ? current : { index, mode })
  }
  const toggle = (index: number) => {
    keepOpen()
    setActive(current => current?.index === index && current.mode === 'pinned' ? null : { index, mode: 'pinned' })
  }
  useEffect(() => () => clearTimeout(closeTimer.current), [])
  const minimum = size > 6 ? 560 : 240
  useLayoutEffect(() => {
    if (!container.current) return
    const observer = new ResizeObserver(([entry]) => {
      setWidth(Math.min(820, Math.max(minimum, entry.contentRect.width)))
    })
    observer.observe(container.current)
    return () => observer.disconnect()
  }, [minimum])
  useLayoutEffect(() => {
    if (!active) return
    const place = () => {
      const target = targets.current[active.index], popup = card.current, viewport = container.current
      if (!target || !popup || !viewport) return
      const anchor = target.getBoundingClientRect(), clip = viewport.getBoundingClientRect()
      const center = anchor.left + anchor.width / 2
      if (center < Math.max(0, clip.left) || center > Math.min(innerWidth, clip.right) || anchor.bottom < 0 || anchor.top > innerHeight) {
        setActive(null)
        return
      }
      const box = popup.getBoundingClientRect()
      const left = Math.max(8, Math.min(center - box.width / 2, innerWidth - box.width - 8))
      const above = anchor.top - box.height - 8
      const top = Math.max(8, Math.min(above >= 8 ? above : anchor.bottom + 8, innerHeight - box.height - 8))
      setPosition({ left, top })
    }
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target) && !card.current?.contains(event.target)) setActive(null)
    }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setActive(null) }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [active, width, days])
  const selected = active ? days[active.index] : undefined
  return <><p className="sr-only">날짜에 마우스를 올리거나 터치하면 상세 수치가 표시됩니다. 방향키로 날짜 이동, Enter로 고정, Escape로 닫기.</p>
  <div ref={container} className="overflow-x-auto">
    <svg className={`w-full ${size > 6 ? 'min-w-[560px]' : ''}`} viewBox={`0 0 ${width} 235`} role="group" aria-label={label}>
      {children(width)}
      {days.map((day, index) => <rect key={day.date} ref={element => { targets.current[index] = element }}
        data-chart-date={day.date} role="button" tabIndex={focused === index ? 0 : -1}
        aria-label={`${day.date} · ${day.values.map(value => `${value.label} ${value.value === null ? '미수집' : number(value.value)}`).join(' · ')}`}
        aria-describedby={active?.index === index ? tooltipId : undefined}
        aria-pressed={active?.index === index && active.mode === 'pinned'}
        x={xAt(index, size, width) - Math.min(44, xSpacing(size, width)) / 2} y="22"
        width={Math.min(44, xSpacing(size, width))} height="176" rx="4"
        fill={active?.index === index ? '#64748b' : 'transparent'} fillOpacity="0.08"
        className="cursor-pointer outline-none focus-visible:stroke-blue-600 focus-visible:stroke-2"
        onPointerEnter={event => { if (event.pointerType !== 'touch') show(index, 'hover') }} onPointerLeave={leave}
        onFocus={() => { setFocused(index); show(index, 'focus') }}
        onBlur={event => { if (active?.mode !== 'pinned' && (!(event.relatedTarget instanceof Node) || !container.current?.contains(event.relatedTarget))) dismiss() }}
        onClick={() => toggle(index)}
        onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); dismiss(); return }
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(index); return }
          const next = event.key === 'ArrowRight' ? Math.min(size - 1, index + 1) : event.key === 'ArrowLeft' ? Math.max(0, index - 1)
            : event.key === 'Home' ? 0 : event.key === 'End' ? size - 1 : null
          if (next !== null) {
            event.preventDefault()
            targets.current[next]?.focus({ preventScroll: true })
            targets.current[next]?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
          }
        }} />)}
    </svg>
  </div>
  {selected && createPortal(<div ref={card} id={tooltipId} role="tooltip" aria-label={`${selected.date} 상세 수치`}
    className="fixed z-[100] max-h-[calc(100dvh-16px)] w-64 max-w-[calc(100vw-16px)] overflow-auto rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-800 shadow-xl"
    style={{ left: position?.left ?? 0, top: position?.top ?? 0, visibility: position ? 'visible' : 'hidden' }}
    onPointerEnter={keepOpen} onPointerLeave={leave}>
    <p className="mb-3 font-semibold text-slate-950">{Number(selected.date.slice(5, 7))}/{Number(selected.date.slice(8, 10))}</p>
    <dl className="space-y-2">{selected.values.map(value => <div key={value.label} className="flex items-center justify-between gap-5">
      <dt className="flex min-w-0 items-center gap-2"><span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: value.color }} />{value.label}</dt>
      <dd className={`font-semibold tabular-nums ${value.formatted ? 'min-w-0 break-all text-right' : 'shrink-0'}`}>{value.formatted ?? (value.value === null ? '미수집' : number(value.value))}</dd>
    </div>)}</dl>
    <p className="mt-3 text-xs text-slate-500">다시 누르거나 바깥을 누르면 닫힙니다.</p>
  </div>, document.body)}</>
}
function ChartGrid({ maximum, dates, width, formatTick }: { maximum: number; dates: string[]; width: number; formatTick?: (value: number) => string }) {
  return <>
    {[0, 0.5, 1].map(fraction => <g key={fraction}>
      <line x1="65" x2={chartRight(width)} y1={yAt(maximum * fraction, maximum)} y2={yAt(maximum * fraction, maximum)} stroke="#e2e8f0" />
      <text x="55" y={yAt(maximum * fraction, maximum) + 4} textAnchor="end" fontSize="11" fill="#64748b">{formatTick ? formatTick(maximum * fraction) : number(Math.round(maximum * fraction))}</text>
    </g>)}
    {dates.map((date, i) => (i === 0 || i === dates.length - 1 || (i % Math.max(1, Math.ceil(dates.length / 5)) === 0 && (dates.length - 1 - i) * xSpacing(dates.length, width) >= 36)) && <text key={date} x={xAt(i, dates.length, width)} y="218" textAnchor="middle" fontSize="11" fill="#64748b">{date.slice(5)}</text>)}
  </>
}
function SpendValue({ value }: { value: SpendSummary }) {
  return <><p className="break-all text-xl font-bold tabular-nums text-slate-900">{formatKrw(value.total)}</p>
    <p className="mt-1 text-xs leading-5 text-slate-600">{spendStatusLabels[value.status]}{value.vat ? ` · ${vatLabels[value.vat]}` : ''}</p>
    {value.total === null && value.groups.map(group => <p key={group.vat} className="mt-1 break-all text-xs leading-5 text-amber-900">보관 금액 {formatKrw(group.amount)} · {vatLabels[group.vat]} (확정 합계 아님)</p>)}
    <p className="mt-2 text-xs leading-5 text-slate-500">값이 있는 캠페인·일 {value.observed}/{value.expected}<br />마지막 값 수집 성공: {time(value.lastSuccessfulAt)}<br />마지막 시도: {time(value.lastAttemptAt)}</p></>
}
function AdSpendSection({ data }: { data: AdSpendView }) {
  const colors = { naver: '#16a34a', daangn: '#ea580c' }
  // Only plot fully observed, same-basis amounts. Exact decimal strings remain in cards/table/tooltips.
  const maximum = Math.max(1, ...data.days.flatMap(day => adProviders.map(p => Number(day.providers[p].total ?? 0))))
  const details = (value: SpendSummary) => value.total !== null ? `${formatKrw(value.total)} · ${vatLabels[value.vat!]}`
    : `${spendStatusLabels[value.status]}${value.groups.length ? ' / ' + value.groups.map(g => `${formatKrw(g.amount)} (${vatLabels[g.vat]}, 보관 금액)`).join(' / ') : ''}`
  return <section aria-label="실제 소진 광고비" className="min-w-0">
    <SectionCard color="slate" title="실제 소진 광고비">
      <p className="text-xs leading-5 text-slate-600">EVN 지정 캠페인만 · 기존 evnsolution.kr 및 새 홈페이지 · KRW · {data.availableFrom}부터 보관</p>
      <p className="mt-1 text-xs leading-5 text-slate-500">조회 {data.start} ~ {data.end} · 위 성과 날짜 필터를 사용합니다. 외부 집계 기간이 없으면 광고비는 보관 시작일부터 오늘까지 조회합니다.</p>
      <p className="mt-1 text-xs leading-5 text-slate-500">일별 보고서 합계이며 매체 화면의 기간 합계와 반올림 차이가 있을 수 있습니다.</p>
      <p className="my-3 rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-900">미연결·미수집·오류는 0원이 아닙니다. 누락 또는 세금 기준 차이·미확인이 있으면 전체 확정 합계를 표시하지 않습니다. 보관 금액은 마지막 성공 값입니다.</p>
      <div className="grid min-w-0 gap-3 lg:grid-cols-3">{(['total', ...adProviders] as const).map(source => {
        const value = source === 'total' ? data.total : data.providers[source]
        return <article key={source} aria-label={source === 'total' ? '전체 광고비' : adProviderLabels[source]} className="min-w-0 rounded-lg border border-slate-200 p-3">
          <h3 className="mb-2 text-sm font-semibold">{source === 'total' ? '전체 광고비' : adProviderLabels[source]}</h3><SpendValue value={value} />
        </article>
      })}</div>
      <div className="mt-5 flex flex-wrap gap-4 text-xs">{adProviders.map(p => <span key={p} style={{ color: colors[p] }}>● {adProviderLabels[p]}</span>)}</div>
      <p className="mt-2 text-xs leading-5 text-slate-500">그래프는 매체별 확인된 일별 금액입니다. 서로 다른 세금 기준을 쌓거나 합산하지 않습니다. 정확한 금액과 상태는 상세 수치에 표시합니다.</p>
      <ChartFrame days={data.days.map(day => ({ date: day.date, values: adProviders.map(p => ({ label: adProviderLabels[p], color: colors[p], value: day.providers[p].total === null ? null : Number(day.providers[p].total), formatted: details(day.providers[p]) })) }))} label="일별 실제 소진 광고비. 네이버와 당근의 확인된 금액과 수집 상태.">{width => {
        const barWidth = Math.min(13, 230 / data.days.length, xSpacing(data.days.length, width) * 0.3)
        return <><ChartGrid maximum={maximum} dates={data.days.map(day => day.date)} width={width} formatTick={value => value.toLocaleString('ko-KR', { notation: 'compact', maximumSignificantDigits: 3 })} />
          {data.days.flatMap((day, i) => adProviders.map((p, n) => day.providers[p].total !== null && <rect key={`${day.date}-${p}`} data-spend-bar={p} x={xAt(i, data.days.length, width) + (n - 1) * barWidth} y={yAt(Number(day.providers[p].total), maximum)} width={barWidth} height={Number(day.providers[p].total) / maximum * 160} fill={colors[p]}><title>{day.date} {adProviderLabels[p]} {details(day.providers[p])}</title></rect>))}
        </>
      }}</ChartFrame>
      <details className="mt-3 text-sm"><summary className="cursor-pointer py-2 font-medium">광고비 일별 상세 펼치기 ({data.days.length}일)</summary>
        <div className="max-h-96 overflow-auto"><table className="w-full min-w-[680px] text-left text-xs"><thead><tr><th className="p-2">날짜</th><th className="p-2">전체</th><th className="p-2">네이버 파워링크</th><th className="p-2">당근 비즈니스</th></tr></thead>
          <tbody>{data.days.map(day => <tr key={day.date} className="border-t border-slate-100"><td className="whitespace-nowrap p-2">{day.date}</td>{[day.total, day.providers.naver, day.providers.daangn].map((value, i) => <td key={i} className="p-2 align-top"><p>{details(value)}</p><p className="mt-1 text-slate-500">마지막 값 수집 성공: {time(value.lastSuccessfulAt)}</p></td>)}</tr>)}</tbody>
        </table></div>
      </details>
    </SectionCard>
  </section>
}
function RegisteredInflowChart({ data }: { data: RegisteredInflow }) {
  const maximum = Math.max(2, Math.ceil(Math.max(...data.days.map(day => day.count)) / 2) * 2)
  return <>
    {data.total === 0 && <p className="mb-2 text-sm text-slate-500">선택 기간의 등록완료 DB 유입이 없습니다. (0건)</p>}
    <ChartFrame key={data.days.map(day => day.date).join(',')} days={data.days.map(day => ({ date: day.date, values: [
      { label: '등록완료 DB 유입', color: '#7c3aed', value: day.count },
    ] }))} label="일별 DB 유입. 휴대폰 중복을 제외한 등록완료 문의 수.">{width => {
      const barWidth = Math.min(width < 560 ? 28 : 32, 500 / data.days.length, xSpacing(data.days.length, width) * 0.75)
      return <>
        <ChartGrid maximum={maximum} dates={data.days.map(day => day.date)} width={width} />
        {data.days.map((day, i) => <rect key={day.date} x={xAt(i, data.days.length, width) - barWidth / 2}
          y={yAt(day.count, maximum)} width={barWidth} height={day.count / maximum * 160} fill="#7c3aed">
          <title>{day.date} 등록완료 DB 유입 {number(day.count)}건</title>
        </rect>)}
      </>
    }}</ChartFrame>
    <details className="mt-3 text-sm"><summary className="cursor-pointer py-2 font-medium">DB 유입 상세 펼치기 ({data.days.length}일)</summary>
      <div className="max-h-80 overflow-auto"><table className="w-full min-w-[240px] text-left text-xs"><thead><tr><th className="py-2">유입일</th><th className="py-2 text-right">등록완료 DB 유입 (건)</th></tr></thead>
        <tbody>{data.days.map(day => <tr key={day.date} className="border-t border-slate-100"><td className="py-2">{day.date}</td><td className="text-right">{number(day.count)}</td></tr>)}</tbody>
      </table></div>
    </details>
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
    <ChartFrame key={rows.map(row => row.date).join(',')} days={rows.map(row => ({ date: row.date, values: [
      { label: '방문자', color: '#2563eb', value: row.visitorCount },
      { label: '페이지뷰', color: '#059669', value: row.pageViewCount },
    ] }))} label="일별 방문자와 페이지뷰 추이. 정확한 수치는 아래 일별 수치 펼치기에서 확인할 수 있습니다.">{width => <>
        <ChartGrid maximum={maximum} dates={rows.map(row => row.date)} width={width} />
        {(['visitorCount', 'pageViewCount'] as const).map((key, k) => <g key={key}>
          <path fill="none" stroke={k ? '#059669' : '#2563eb'} strokeWidth="2.5" d={rows.map((row, i) => row[key] === null ? '' : `${i && rows[i - 1][key] !== null ? 'L' : 'M'}${xAt(i, rows.length, width)},${yAt(row[key], maximum)}`).join(' ')} />
          {rows.map((row, i) => row[key] !== null && <circle key={row.date} cx={xAt(i, rows.length, width)} cy={yAt(row[key], maximum)} r="3" fill={k ? '#059669' : '#2563eb'}><title>{row.date} {k ? '페이지뷰' : '방문자'} {number(row[key])}</title></circle>)}
        </g>)}
    </>}</ChartFrame>
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
  const tooltipMedia = Object.keys(mediaColors).filter(label => days.some(day => grouped.get(day)!.has(label)))
  const maximum = Math.max(1, ...days.map(day => media.reduce((total, label) => total + (grouped.get(day)!.get(label) ?? 0), 0)))
  return <>
    <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs">{media.map(label => <span key={label} style={{ color: mediaColors[label] }}>● {label}</span>)}</div>
    {media.length ? <ChartFrame key={days.join(',')} days={days.map(date => ({ date, values: tooltipMedia.map(label => ({
      label, color: mediaColors[label], value: grouped.get(date)!.get(label) ?? null,
    })) }))} label="매체별 일별 광고 유입. 정확한 수치는 아래 매체별 원본 수치 펼치기에서 확인할 수 있습니다.">{width => {
      const barWidth = Math.min(width < 560 ? 28 : 32, 500 / Math.max(1, days.length), xSpacing(days.length, width) * 0.75)
      return <>
      <ChartGrid maximum={maximum} dates={days} width={width} />
      {days.map((day, i) => {
        let total = 0
        return <g key={day}>{media.map(label => {
          const count = grouped.get(day)!.get(label) ?? 0
          total += count
          return <rect key={label} x={xAt(i, days.length, width) - barWidth / 2} y={yAt(total, maximum)} width={barWidth} height={count / maximum * 160} fill={mediaColors[label]}><title>{day} {label} {number(count)}</title></rect>
        })}</g>
      })}
    </>}}</ChartFrame> : <p className="py-5 text-sm text-slate-500">원본 차트에 표시할 광고 유입이 없습니다.</p>}
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
