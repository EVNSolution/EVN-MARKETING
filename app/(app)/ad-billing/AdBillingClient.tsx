'use client'
import { useEffect, useState } from 'react'
import { billingKinds, billingLabels, monthDays, type BillingKind, type BillingScope, type BillingView } from '@/lib/ad-billing'
import type { BillingPreview } from '@/lib/ad-billing-store'

const inputStyle = 'min-h-11 w-full min-w-0 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900'
const buttonStyle = 'min-h-11 rounded-lg bg-[#111111] px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40'
const won = (amount: number | null) => amount === null ? '미수집' : `${amount.toLocaleString('ko-KR')}원`
const stamp = (value: string | null) => value ? new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'medium' }).format(new Date(value)) : '없음'
const ranges = (values: { start: string; end: string }[]) => values.length ? values.map(v => v.start === v.end ? v.start : `${v.start} ~ ${v.end}`).join(', ') : '없음'
async function jsonResponse(response: Response) {
  if (response.redirected) throw new Error('로그인이 만료되었습니다. 다시 로그인해 주세요.')
  const value = await response.json()
  if (!response.ok) throw new Error(value.error || '요청을 처리하지 못했습니다.')
  return value
}
export default function AdBillingClient({ initialMonth }: { initialMonth: string }) {
  const [month, setMonth] = useState(initialMonth), [refresh, setRefresh] = useState(0)
  const [view, setView] = useState<BillingView | null>(null), [error, setError] = useState(''), [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false), [file, setFile] = useState<File | null>(null), [scope, setScope] = useState<BillingScope>('both')
  const [start, setStart] = useState(`${initialMonth}-01`), [end, setEnd] = useState(monthDays(initialMonth).at(-1)!)
  const [captured, setCaptured] = useState(''), [confirmed, setConfirmed] = useState(false), [preview, setPreview] = useState<BillingPreview | null>(null)
  useEffect(() => {
    const abort = new AbortController()
    fetch(`/api/ad-billing?${new URLSearchParams({ month })}`, { cache: 'no-store', signal: abort.signal }).then(jsonResponse).then(value => {
      if (!abort.signal.aborted) setView(value)
    }).catch(err => { if (!abort.signal.aborted) { setView(null); setError(err instanceof Error ? err.message : '조회하지 못했습니다.') } })
    return () => abort.abort()
  }, [month, refresh])
  function resetPreview() { setPreview(null); setError(''); setMessage('') }
  function changeMonth(value: string) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value) || value < '2000-01') return
    resetPreview(); setMonth(value); setView(null); setStart(`${value}-01`); setEnd(monthDays(value).at(-1)!); setConfirmed(false)
  }
  async function importFile(save: boolean) {
    setError(''); setMessage(''); setBusy(true)
    try {
      if (!file || file.size > 2 * 1024 * 1024 || !captured || !confirmed) throw new Error('2MB 이하의 원본 CSV, 수집 기준시각, 전체 거래 확인을 입력해 주세요.')
      if (start.slice(0, 7) !== month || end.slice(0, 7) !== month) throw new Error('선택한 정산 월 안의 조회 기간을 입력해 주세요.')
      if (save && !preview) throw new Error('먼저 미리보기로 변경 내용을 확인해 주세요.')
      const capturedAt = new Date(`${captured.length === 16 ? captured + ':00' : captured}+09:00`).toISOString()
      const params = new URLSearchParams({ mode: save ? 'import' : 'preview', start, end, scope, capturedAt, confirmed: 'true' })
      if (save) { params.set('key', preview!.source.key); params.set('revision', preview!.revision) }
      const result = await jsonResponse(await fetch(`/api/ad-billing/import?${params}`, { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: file }))
      if (save) { setView(result.view); setPreview(null); setMessage(result.unchanged ? '이미 저장한 동일 자료입니다. 중복 저장하지 않았습니다.' : '선택한 기간과 거래 유형의 자료를 교체해 저장했습니다.') }
      else setPreview(result)
    } catch (err) { setPreview(null); setError(err instanceof Error ? err.message : '가져오지 못했습니다.') }
    finally { setBusy(false) }
  }
  async function download(kind: BillingKind) {
    if (!view) return
    setBusy(true); setError('')
    try {
      const response = await fetch(`/api/ad-billing/export?${new URLSearchParams({ month: view.month, kind, revision: view.revision })}`, { cache: 'no-store' })
      if (!response.ok || response.redirected) { await jsonResponse(response); throw new Error('엑셀을 내려받지 못했습니다.') }
      const blob = await response.blob(), url = URL.createObjectURL(blob), a = document.createElement('a')
      a.href = url
      a.download = decodeURIComponent(response.headers.get('Content-Disposition')?.match(/filename\*=UTF-8''([^;]+)/)?.[1] ?? `당근_${month}_${billingLabels[kind]}.xlsx`)
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (err) { setError(err instanceof Error ? err.message : '엑셀을 내려받지 못했습니다.') }
    finally { setBusy(false) }
  }
  return <div className="mx-auto max-w-6xl space-y-6 px-4 py-6 sm:px-8">
    <section className="flex flex-wrap items-end justify-between gap-4" aria-label="정산 월 선택">
      <label className="w-full max-w-56 text-sm font-semibold text-slate-700">정산 월 (한국시간)
        <input aria-label="정산 월" type="month" min="2000-01" value={month} disabled={busy} onChange={e => changeMonth(e.target.value)} className={`mt-2 ${inputStyle}`} />
      </label>
      <button className={buttonStyle} disabled={busy} onClick={() => { resetPreview(); setView(null); setRefresh(v => v + 1) }}>화면 새로고침</button>
    </section>
    {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}</p>}
    {message && <p role="status" className="rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-800">{message}</p>}
    {view ? <>
      <section aria-label="충전·집행내역 상태" className={`rounded-xl border p-4 ${view.ready ? 'border-green-200 bg-green-50' : 'border-amber-200 bg-amber-50'}`}>
        <p className="font-bold text-slate-900">{view.ready ? '충전·집행내역 준비 완료' : '충전·집행내역 중간집계'}</p>
        <p className="mt-1 text-sm text-slate-700">{view.ready ? '충전과 집행 모두 월 전체 조회 범위가 확인되었습니다.' : '충전·집행의 월 전체 자료가 확인된 지난달까지 내역 준비 완료로 표시합니다. 수집 당일은 부분일로 남습니다.'}</p>
      </section>
      <section aria-label="월말 잔액" className="rounded-xl border border-amber-200 bg-amber-50 p-4">
        <p className="font-bold text-slate-900">월말 잔액 확인 필요</p>
        <p className="mt-1 text-sm text-slate-700">기준일: {monthDays(view.month).at(-1)} (한국시간, 마지막 날 소진 후)</p>
        <p className="mt-2 text-sm leading-6 text-slate-700">원본에 월말 잔액을 확인할 자료가 없어 미확인 상태입니다. 현재 잔액은 월말 잔액으로 사용하지 않습니다.</p>
      </section>
      <div className="grid gap-4 lg:grid-cols-2">
        {view.summaries.map(summary => <article key={summary.kind} aria-label={billingLabels[summary.kind]} className="min-w-0 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="font-bold text-slate-800">{billingLabels[summary.kind]}</h2>
          <p className="mt-3 break-words text-2xl font-bold tracking-tight text-slate-950">{won(summary.total)}</p>
          <p className="mt-1 text-sm text-slate-600">{summary.count === null ? '아직 자료 없음 · 0원이 아닙니다' : `${summary.count.toLocaleString('ko-KR')}건 · 하루 전체 확인 ${summary.completeDays}/${view.dayCount}일`}</p>
          <dl className="mt-5 space-y-2 break-words text-xs leading-5 text-slate-600">
            <div><dt className="font-semibold">원본 조회 범위</dt><dd>{ranges(summary.ranges)}</dd></div>
            <div><dt className="font-semibold">부분일 / 미수집</dt><dd>{summary.partialDays.length}일 / {summary.missingDays.length}일</dd></div>
            <div><dt className="font-semibold">최신 수집 기준 (한국시간)</dt><dd>{stamp(summary.capturedAt)}</dd></div>
            <div><dt className="font-semibold">마지막 저장 (한국시간)</dt><dd>{stamp(summary.importedAt)}</dd></div>
          </dl>
          <button disabled={busy || summary.total === null} onClick={() => download(summary.kind)} className={`mt-5 w-full ${buttonStyle}`}>{billingLabels[summary.kind]} 엑셀</button>
        </article>)}
      </div>
      <p className="text-sm text-slate-600">충전은 결제한 금액, 집행은 사용한 금액입니다. 두 금액을 합쳐 광고비로 계산하지 않습니다. 충전·집행내역이 미완료인 자료는 엑셀 파일명에도 ‘중간집계’로 표시됩니다.</p>
    </> : !error && <p role="status" className="text-sm text-slate-500">정산 자료를 불러오고 있습니다.</p>}

    <section aria-label="당근 원본 CSV 가져오기" className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6">
      <h2 className="text-lg font-bold text-slate-900">당근 원본 CSV 가져오기</h2>
      <p className="mt-2 text-sm leading-6 text-slate-600">거래내역 화면에서 내려받은 UTF-8 CSV를 사용하세요. 원본의 4개 열과 카드명·끝 4자리를 그대로 보존합니다. 조회한 기간과 파일 수집 기준시각을 직접 확인해 주세요.</p>
      <fieldset disabled={busy} className="mt-5 grid min-w-0 gap-4 sm:grid-cols-2">
        <label className="min-w-0 text-sm font-semibold text-slate-700 sm:col-span-2">원본 CSV (최대 2MB)
          <input aria-label="원본 CSV" type="file" accept=".csv,text/csv" onChange={e => { resetPreview(); setFile(e.target.files?.[0] ?? null) }} className={`mt-2 ${inputStyle}`} />
        </label>
        <label className="text-sm font-semibold text-slate-700">파일의 거래 유형
          <select value={scope} onChange={e => { resetPreview(); setScope(e.target.value as BillingScope); setConfirmed(false) }} className={`mt-2 ${inputStyle}`}>
            <option value="both">전체 (유상캐시 충전 + 광고캐시 사용)</option><option value="topup">유상캐시 충전</option><option value="spend">광고캐시 사용</option>
          </select>
        </label>
        <label className="text-sm font-semibold text-slate-700">파일 수집 기준시각 (한국시간)
          <input type="datetime-local" step="1" value={captured} onChange={e => { resetPreview(); setCaptured(e.target.value) }} className={`mt-2 ${inputStyle}`} />
        </label>
        <label className="text-sm font-semibold text-slate-700">원본 조회 시작일<input type="date" value={start} onChange={e => { resetPreview(); setStart(e.target.value); setConfirmed(false) }} className={`mt-2 ${inputStyle}`} /></label>
        <label className="text-sm font-semibold text-slate-700">원본 조회 종료일<input type="date" value={end} onChange={e => { resetPreview(); setEnd(e.target.value); setConfirmed(false) }} className={`mt-2 ${inputStyle}`} /></label>
        <label className="flex items-start gap-3 text-sm leading-6 text-slate-700 sm:col-span-2"><input type="checkbox" checked={confirmed} onChange={e => { resetPreview(); setConfirmed(e.target.checked) }} className="mt-1 size-4 shrink-0" />이 파일이 선택한 거래 유형·조회 기간의 전체 거래내역임을 확인했습니다.</label>
        <p className="text-xs leading-5 text-slate-500 sm:col-span-2">기간 안에 거래가 없는 날도 있을 수 있습니다. 건수로 누락 여부를 판단하지 않습니다. 재수입하면 선택한 기간·유형만 교체하며, 다른 자료는 유지합니다. 환불 등 다른 유형은 지원하지 않습니다.</p>
        <button type="button" disabled={busy || !file || !captured || !confirmed} onClick={() => importFile(false)} className={buttonStyle}>{busy ? '처리 중…' : '변경 내용 미리보기'}</button>
      </fieldset>
      {preview && <section aria-label="저장 전 미리보기" className="mt-6 min-w-0 rounded-lg border border-[#C5D42A] bg-[#FAFBEF] p-4">
        <h3 className="font-bold text-slate-900">저장 전 미리보기</h3>
        <p className="mt-2 text-sm text-slate-700">{preview.source.start} ~ {preview.source.end} · 원본 {preview.rowCount}건 · 저장 후 {preview.after.ready ? '충전·집행내역 준비 완료' : '충전·집행내역 중간집계'}</p>
        <p className="mt-1 text-xs text-slate-600">월말 잔액은 별도 확인이 필요합니다.</p>
        <p className="mt-1 text-xs text-slate-600">수집 기준시각: {stamp(preview.source.capturedAt)} (한국시간)</p>
        <div className="mt-3 space-y-2 text-sm text-slate-800">{billingKinds.map(kind => {
          const before = preview.before.summaries.find(v => v.kind === kind)!, after = preview.after.summaries.find(v => v.kind === kind)!
          return <p key={kind} className="break-words">{billingLabels[kind]}: {won(before.total)} ({before.count ?? '미수집'}건) → {won(after.total)} ({after.count ?? '미수집'}건)</p>
        })}</div>
        {preview.sample.length > 0 && <div className="mt-4 max-w-full overflow-x-auto"><table className="w-full text-left text-xs text-slate-700"><caption className="mb-2 text-left">최신 거래 최대 8건 · 전체 행은 엑셀에서 확인</caption><thead><tr>{['거래 일시 (한국시간)', '거래 유형', '거래 내용', '금액'].map(label => <th key={label} className="whitespace-nowrap border-b p-2">{label}</th>)}</tr></thead><tbody>{preview.sample.map((row, index) => <tr key={index}><td className="whitespace-nowrap p-2">{row.at.replace('T', ' ')}</td><td className="whitespace-nowrap p-2">{row.type}</td><td className="min-w-32 break-words p-2">{row.description}</td><td className="whitespace-nowrap p-2 text-right">{won(row.amount)}</td></tr>)}</tbody></table></div>}
        <p className="mt-4 text-xs leading-5 text-slate-600">{preview.unchanged ? '이미 저장한 동일 자료입니다. 다시 저장해도 중복되지 않습니다.' : '저장을 누르면 이 조회 기간·유형의 기존 자료가 교체됩니다. 동일한 거래 행이 여러 건이면 모두 보존합니다.'}</p>
        <button type="button" disabled={busy} onClick={() => importFile(true)} className={`mt-4 ${buttonStyle}`}>확인하고 저장</button>
      </section>}
    </section>
  </div>
}
