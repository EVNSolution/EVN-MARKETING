'use client'

import { apiFetch } from '@/lib/release-client'

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { AlertCircle, ChevronLeft, ChevronRight, RefreshCw, Search } from 'lucide-react'
import DuplicateReviewPanel from './DuplicateReviewPanel'

type Inquiry = {
  id: string
  inquiryDate: string
  inquiryTime: string
  name: string | null
  phone: string
  landingReceipt?: { kind: string | null; region: string | null; consentVersion: string | null; consentedAt: string | null } | null
  warpDelivery: { status: 'sending' | 'delivered' | 'pending' | 'duplicate' | 'duplicate_reviewed' | 'blocked' | 'retrying' | 'queued'; label: string; reason: string | null }
}

type SyncRun = {
  status: string
  trigger: string
  readCount: number
  createdCount: number
  updatedCount: number
  unchangedCount: number
  pagesRead: number
  createdAt: string
  startedAt: string | null
  heartbeatAt: string | null
  completedAt: string | null
}

type InquiryResponse = {
  rows: Inquiry[]
  warp: { configured: boolean; delivered: number; pending: number; failed: number; duplicates: number; reviewPending: number; reviewed: number }
  pagination: { page: number; limit: number; total: number; totalPages: number }
  sync: {
    currentStatus: string
    lastSuccessfulAt: string | null
    nextRunAt: string | null
    latestRun: SyncRun | null
  }
}

const statusText: Record<string, { label: string; className: string }> = {
  starting: { label: '수집 연결 준비 중', className: 'bg-amber-100 text-amber-800' },
  ready: { label: '정상 대기', className: 'bg-lime-100 text-lime-800' },
  source_error: { label: '원본 연결 재시도 중', className: 'bg-orange-100 text-orange-800' },
  success: { label: '정상 대기', className: 'bg-lime-100 text-lime-800' },
  running: { label: '가져오는 중', className: 'bg-sky-100 text-sky-700' },
  pending: { label: '실행 대기', className: 'bg-amber-100 text-amber-800' },
  offline: { label: '수집 연결 끊김', className: 'bg-slate-200 text-slate-700' },
  partial: { label: '일부 수집', className: 'bg-orange-100 text-orange-800' },
  login_required: { label: '원본 서비스 로그인이 필요해요', className: 'bg-red-100 text-red-700' },
  credentials_invalid: { label: '원본 계정 확인 필요', className: 'bg-red-100 text-red-700' },
  credentials_missing: { label: '원본 계정 설정 필요', className: 'bg-red-100 text-red-700' },
  source_credentials_incomplete: { label: '원본 계정 설정 불완전', className: 'bg-red-100 text-red-700' },
  source_credentials_missing: { label: '원본 계정 설정 필요', className: 'bg-red-100 text-red-700' },
  login_retry_exhausted: { label: '원본 로그인 재시도 대기', className: 'bg-red-100 text-red-700' },
  failed: { label: '조회 실패', className: 'bg-red-100 text-red-700' },
}

const blockedStatusHelp: Record<string, string> = {
  login_required: '원본 서비스 세션이 만료되었습니다. 수집기가 자동 로그인을 다시 시도합니다.',
  credentials_invalid: '원본 계정이 거부되었습니다. 계정 정보를 확인한 뒤 수집기를 재시작해 주세요.',
  credentials_missing: '서버의 원본 계정 정보를 설정한 뒤 수집 서비스를 재시작해 주세요.',
  source_credentials_incomplete: '원본 계정 아이디와 비밀번호를 모두 설정한 뒤 수집기를 재시작해 주세요.',
  source_credentials_missing: '서버의 원본 계정 정보를 설정한 뒤 수집 서비스를 재시작해 주세요.',
  login_retry_exhausted: '일시 오류 재시도 한도를 넘었습니다. 5분 뒤 자동으로 다시 시도합니다.',
}

function kst(value: string | null) {
  if (!value) return '아직 없음'
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(value))
}

export default function InquiryListClient({ isAdmin }: { isAdmin: boolean }) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const queryParams = new URLSearchParams(searchParams.toString())
  queryParams.delete('status')
  const queryString = queryParams.toString()
  const [data, setData] = useState<InquiryResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [reviewId, setReviewId] = useState<string | null>(null)
  const [closingInquiry, setClosingInquiry] = useState<Inquiry | null>(null)
  const [closing, setClosing] = useState(false)
  const [closeError, setCloseError] = useState('')
  const [syncMessage, setSyncMessage] = useState('')
  const [registeringIds, setRegisteringIds] = useState<string[]>([])
  const [registrationMessages, setRegistrationMessages] = useState<Record<string, string>>({})
  const [from, setFrom] = useState(searchParams.get('from') ?? '')
  const [to, setTo] = useState(searchParams.get('to') ?? '')
  const [query, setQuery] = useState(searchParams.get('q') ?? '')
  const registrationRequests = useRef(new Set<string>())
  const request = useRef<{ id: number; controller: AbortController } | null>(null)
  const requestId = useRef(0)
  const closeDialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    if (closingInquiry && closeDialog.current && !closeDialog.current.open) closeDialog.current.showModal()
  }, [closingInquiry])

  const load = useCallback(async () => {
    request.current?.controller.abort()
    const id = ++requestId.current
    const controller = new AbortController()
    request.current = { id, controller }
    setLoading(true)
    try {
      const response = await apiFetch(`/api/inquiries${queryString ? `?${queryString}` : ''}`, { signal: controller.signal, cache: 'no-store' })
      if (!response.ok) throw new Error()
      const next = await response.json() as InquiryResponse
      if (request.current?.id !== id) return
      setData(next)
      setError('')
    } catch (loadError) {
      if (request.current?.id === id && !(loadError instanceof DOMException && loadError.name === 'AbortError')) {
        setError('문의 내역을 새로 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.')
      }
    } finally {
      if (request.current?.id === id) {
        request.current = null
        setLoading(false)
      }
    }
  }, [queryString])

  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0)
    const timer = window.setInterval(() => {
      if (!request.current) void load()
    }, 15_000)
    return () => {
      request.current?.controller.abort()
      window.clearTimeout(initial)
      window.clearInterval(timer)
    }
  }, [load])

  const navigate = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(queryString)
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value)
      else next.delete(key)
    }
    router.replace(`/inquiries${next.size ? `?${next}` : ''}`)
  }

  const submitFilters = (event: FormEvent) => {
    event.preventDefault()
    navigate({ from, to, q: query.trim(), page: '1' })
  }

  const requestSync = async () => {
    if (syncing) return
    setSyncing(true)
    setSyncMessage('')
    try {
      const response = await apiFetch('/api/inquiries/sync', { method: 'POST' })
      const result = await response.json() as { queued?: boolean; error?: string }
      if (!response.ok) throw new Error(result.error)
      setSyncMessage(result.queued ? '가져오기 요청을 등록했습니다.' : '이미 실행 중이거나 원본 로그인이 필요합니다.')
      await load()
    } catch (syncError) {
      setSyncMessage(syncError instanceof Error && syncError.message ? syncError.message : '요청을 처리하지 못했습니다.')
    } finally {
      setSyncing(false)
    }
  }

  const requestWarpRegistration = async (row: Inquiry) => {
    if (registrationRequests.current.has(row.id) || !['pending', 'retrying'].includes(row.warpDelivery.status)) return
    registrationRequests.current.add(row.id)
    setRegisteringIds((ids) => [...ids, row.id])
    setRegistrationMessages((messages) => ({ ...messages, [row.id]: '등록 요청 중입니다.' }))
    try {
      const response = await apiFetch(`/api/inquiries/${row.id}/warp-registration`, { method: 'POST' })
      const result = await response.json() as { queued?: boolean; delivered?: boolean; error?: string }
      if (!response.ok) throw new Error(result.error)
      setRegistrationMessages((messages) => ({ ...messages, [row.id]: result.delivered ? '이미 등록된 문의입니다.' : '등록 요청을 접수했습니다.' }))
      await load()
      setRegistrationMessages((messages) => {
        const next = { ...messages }
        delete next[row.id]
        return next
      })
    } catch (registrationError) {
      setRegistrationMessages((messages) => ({
        ...messages,
        [row.id]: registrationError instanceof Error && registrationError.message ? registrationError.message : '등록 요청을 처리하지 못했습니다.',
      }))
    } finally {
      registrationRequests.current.delete(row.id)
      setRegisteringIds((ids) => ids.filter((id) => id !== row.id))
    }
  }

  const closeConsultation = async () => {
    if (!closingInquiry || closing) return
    setClosing(true)
    setCloseError('')
    try {
      const response = await apiFetch(`/api/inquiries/${closingInquiry.id}/close-landing`, { method: 'POST' })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error)
      setClosingInquiry(null)
      await load()
    } catch (error) { setCloseError(error instanceof Error ? error.message : '처리하지 못했습니다.') }
    finally { setClosing(false) }
  }

  const renderDelivery = (row: Inquiry) => (
    <div className="break-words">
      {row.landingReceipt && <div className="mb-2 space-y-1 text-xs">
      <span className="inline-block rounded-full bg-lime-100 px-2 py-1 font-semibold text-lime-800">새 홈페이지</span>
      <p className="text-slate-600">{row.landingReceipt?.kind === 'subsidy' ? '보조금 상담' : '구매 상담'}{row.landingReceipt?.region ? ` · ${row.landingReceipt.region}` : ''}</p>
      <p className="text-[11px] text-slate-500">개인정보 동의 {kst(row.landingReceipt.consentedAt)} · {row.landingReceipt.consentVersion}</p>
      {isAdmin && <button type="button" disabled={row.warpDelivery.status === 'sending' || registeringIds.includes(row.id)} onClick={() => { setCloseError(''); setClosingInquiry(row) }} className="min-h-11 rounded-lg px-2 font-semibold text-slate-700 underline underline-offset-4 disabled:opacity-45">상담 종료·개인정보 삭제</button>}
      </div>}
                      {row.warpDelivery.status === 'delivered' ? (
                        <span title={row.warpDelivery.reason ?? undefined} className="rounded-full bg-lime-100 px-2 py-1 font-semibold text-lime-800">등록완료</span>
                      ) : row.warpDelivery.status === 'duplicate' ? (
                        <span className="inline-block rounded-full bg-amber-50 px-2 py-1 font-semibold text-amber-800">중복확인</span>
                      ) : row.warpDelivery.status === 'duplicate_reviewed' ? (
                        <span className="inline-block rounded-full bg-slate-100 px-2 py-1 font-semibold text-slate-600">검토완료</span>
                      ) : row.warpDelivery.status === 'blocked' ? (
                        <span className="inline-block rounded-full bg-slate-100 px-2 py-1 font-semibold text-slate-600">{row.warpDelivery.label}</span>
                      ) : isAdmin ? (
                        <button type="button" onClick={() => void requestWarpRegistration(row)}
                          disabled={registeringIds.includes(row.id) || ['queued', 'sending'].includes(row.warpDelivery.status)}
                          className="min-h-11 rounded-lg bg-slate-800 px-3 py-1.5 font-bold text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-45">
                          {['queued', 'sending'].includes(row.warpDelivery.status) ? '등록중' : '등록하기'}
                        </button>
                      ) : (
                        <span className={`rounded-full px-2 py-1 font-semibold ${row.warpDelivery.status === 'pending' || row.warpDelivery.status === 'queued' ? 'bg-slate-100 text-slate-600' : 'bg-amber-100 text-amber-800'}`}>{row.warpDelivery.status === 'queued' ? '등록 요청됨' : row.warpDelivery.label}</span>
                      )}
                      {row.warpDelivery.status !== 'delivered' && (
                        <p className="mt-1 max-w-64 text-[11px] text-slate-500" aria-live="polite">
                          {row.warpDelivery.reason || registrationMessages[row.id] || (isAdmin && row.warpDelivery.status !== 'queued' ? row.warpDelivery.label : '')}
                        </p>
                      )}
                      {['duplicate', 'duplicate_reviewed'].includes(row.warpDelivery.status) && (
                        <button type="button" onClick={() => setReviewId(row.id)} className="mt-1 min-h-11 rounded-lg px-2 text-xs font-semibold text-slate-700 underline underline-offset-4">검토하기</button>
                      )}
    </div>
  )

  const sync = data?.sync
  const state = statusText[sync?.currentStatus ?? 'offline'] ?? statusText.failed
  const run = sync?.latestRun

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 sm:p-6">
      <section className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">현재 상태</div>
          <div className="mt-2 flex items-center gap-2">
            <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${state.className}`}>{state.label}</span>
          </div>
          {sync && blockedStatusHelp[sync.currentStatus] && (
            <p className="mt-2 text-[11px] text-red-600">{blockedStatusHelp[sync.currentStatus]}</p>
          )}
          {sync?.nextRunAt && <p className="mt-2 text-[11px] text-slate-400">다음 예정 {kst(sync.nextRunAt)}</p>}
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">마지막 수집 성공</div>
          <div className="mt-2 text-sm font-bold text-slate-800">{kst(sync?.lastSuccessfulAt ?? null)}</div>
          <p className="mt-2 text-[11px] text-slate-400">한국 시간 기준</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">최근 실행</div>
            {isAdmin && (
              <button type="button" onClick={requestSync} disabled={syncing || sync?.currentStatus === 'running' || sync?.currentStatus === 'pending'}
                className="inline-flex items-center gap-1.5 rounded-lg bg-[#111111] px-3 py-1.5 text-[11px] font-bold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-45">
                <RefreshCw size={13} className={syncing ? 'animate-spin' : ''} />
                지금 가져오기
              </button>
            )}
          </div>
          <div className="mt-2 flex gap-4 text-xs text-slate-500">
            <span>읽음 <b className="text-slate-800">{run?.readCount ?? 0}</b></span>
            <span>신규 <b className="text-lime-700">{run?.createdCount ?? 0}</b></span>
            <span>기존 <b className="text-sky-700">{run?.unchangedCount ?? 0}</b></span>
          </div>
          <p className="mt-2 min-h-4 text-[11px] text-slate-400">{syncMessage || (run ? `${kst(run.completedAt ?? run.startedAt ?? run.createdAt)} · ${run.trigger === 'manual' ? '수동' : '자동'}` : '실행 기록 없음')}</p>
        </div>
      </section>

      {data?.warp && (
        <section className="rounded-xl border border-slate-200 bg-white p-4 text-xs text-slate-600" aria-label="WARP 고객관리 연동">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <b className="text-slate-800">문의 · WARP 고객관리 등록</b>
            <a className="font-semibold underline underline-offset-2" href="https://warp.cleversystem.ai/customers" target="_blank" rel="noreferrer">WARP 고객관리 열기</a>
          </div>
          <p className="mt-2">{!data.warp.configured ? '자동 등록 비활성' : !data.warp.delivered && !data.warp.pending ? '등록할 문의 없음' : data.warp.failed ? '등록 오류 확인 필요' : data.warp.pending ? '등록 대기' : '등록 완료'} · 완료 {data.warp.delivered}건 · 대기 {data.warp.pending}건{data.warp.failed ? ` (오류 ${data.warp.failed}건 포함)` : ''} · 중복확인 {data.warp.reviewPending}건 · 검토완료 {data.warp.reviewed}건</p>
          <p className="mt-2 text-[11px] text-slate-400">{!data.warp.configured ? '자동 등록은 꺼져 있습니다. 문의별 등록하기 버튼으로 요청할 수 있습니다.' : '기존 수집 문의의 자동 등록 설정이 켜져 있습니다. 중복 방지 확인을 통과한 문의만 등록합니다.'} 새 홈페이지 문의는 항상 등록하기를 눌러야 전송됩니다.</p>
          <p className="mt-1 text-[11px] text-slate-400">등록완료에는 기존에 보존된 WARP 전송 확인과 사용자의 직접 등록 확인이 포함됩니다. 중복과 확인 필요 항목은 완료 건수에서 제외합니다.</p>
        </section>
      )}

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          <AlertCircle size={15} /> {error}
        </div>
      )}

      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <form onSubmit={submitFilters} className="flex flex-wrap items-end gap-3 border-b border-slate-200 bg-slate-50 p-3">
          <label className="grid gap-1 text-[11px] font-semibold text-slate-500">문의 경로
            <select aria-label="문의 경로" value={searchParams.get('source') ?? ''} onChange={event => navigate({ source: event.target.value || null, review: null, page: '1' })} className="min-h-11 rounded-lg border border-slate-200 bg-white px-3 text-xs text-slate-700">
              <option value="">전체</option><option value="landing">새 홈페이지</option><option value="collected">기존 수집 문의</option>
            </select>
          </label>
          <label className="grid gap-1 text-[11px] font-semibold text-slate-500">
            시작일
            <input type="date" value={from} onChange={(event) => setFrom(event.target.value)}
              className="h-9 rounded-lg border border-slate-200 bg-white px-2.5 text-xs text-slate-700 outline-none focus:border-slate-400" />
          </label>
          <label className="grid gap-1 text-[11px] font-semibold text-slate-500">
            종료일
            <input type="date" value={to} onChange={(event) => setTo(event.target.value)}
              className="h-9 rounded-lg border border-slate-200 bg-white px-2.5 text-xs text-slate-700 outline-none focus:border-slate-400" />
          </label>
          <label className="grid min-w-52 flex-1 gap-1 text-[11px] font-semibold text-slate-500">
            검색
            <span className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input value={query} onChange={(event) => setQuery(event.target.value)} maxLength={100} placeholder="성함 또는 연락처"
                className="h-9 w-full rounded-lg border border-slate-200 bg-white pl-9 pr-3 text-xs text-slate-700 outline-none focus:border-slate-400" />
            </span>
          </label>
          <label className="space-y-1 text-[10px] font-bold uppercase tracking-wide text-slate-400">
            중복 검토
            <select aria-label="중복 검토 필터" value={searchParams.get('review') ?? ''} onChange={event => navigate({ review: event.target.value || null, page: '1' })}
              className="block min-h-11 w-full rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700">
              <option value="">전체 문의</option><option value="pending">중복확인</option><option value="reviewed">검토완료</option>
            </select>
          </label>
          <button type="submit" className="min-h-11 rounded-lg bg-slate-800 px-4 text-xs font-bold text-white hover:bg-slate-700">조회</button>
        </form>

        <div className="min-h-72 overflow-x-auto">
          {!data ? (
            <div className="flex min-h-72 flex-col items-center justify-center gap-3 text-sm text-slate-400">
              {loading ? '문의 내역을 불러오는 중입니다.' : '문의 내역을 불러오지 못했습니다.'}
              {!loading && (
                <button type="button" onClick={() => void load()}
                  className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50">
                  다시 시도
                </button>
              )}
            </div>
          ) : data?.rows.length ? (
            <>
            <table className="hidden w-full min-w-[900px] text-xs md:table">
              <thead>
                <tr className="border-b border-slate-200 bg-white text-left text-[10px] font-bold uppercase tracking-widest text-slate-400">
                  <th className="px-4 py-3">문의일자</th>
                  <th className="px-4 py-3">문의시간</th>
                  <th className="px-4 py-3">성함</th>
                  <th className="px-4 py-3">연락처</th>
                  <th className="px-4 py-3">처리 상태</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.rows.map((row) => (
                  <tr key={row.id} className="transition-colors hover:bg-slate-50">
                    <td className="whitespace-nowrap px-4 py-3 font-semibold text-slate-800">{row.inquiryDate}</td>
                    <td className="whitespace-nowrap px-4 py-3 tabular-nums text-slate-600">{row.inquiryTime}</td>
                    <td className="px-4 py-3 font-medium text-slate-700">{row.name ?? '—'}</td>
                    <td className="whitespace-nowrap px-4 py-3 tabular-nums text-slate-600">{row.phone}</td>
                    <td className="px-4 py-3">
                      {renderDelivery(row)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="divide-y divide-slate-100 md:hidden">
              {data.rows.map(row => <article key={row.id} className="space-y-3 px-4 py-4" aria-label="문의 카드">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="break-all font-semibold text-slate-800">{row.name ?? '—'}</p>
                  <p className="text-xs tabular-nums text-slate-500">{row.inquiryDate} {row.inquiryTime}</p>
                </div>
                <p className="text-sm tabular-nums text-slate-600">{row.phone}</p>
                <div className="text-xs">{renderDelivery(row)}</div>
              </article>)}
            </div>
            </>
          ) : (
            <div className="flex min-h-72 items-center justify-center text-sm text-slate-400">조건에 맞는 문의가 없습니다.</div>
          )}
        </div>

        {data && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-4 py-3">
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <b className="text-slate-800">{data.pagination.total.toLocaleString()}</b>건
              <select aria-label="페이지당 문의 수" value={data.pagination.limit} onChange={(event) => navigate({ limit: event.target.value, page: '1' })}
                className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs outline-none">
                {[20, 50, 100, 200].map((size) => <option key={size} value={size}>{size}개씩</option>)}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <button type="button" disabled={data.pagination.page <= 1} onClick={() => navigate({ page: String(data.pagination.page - 1) })}
                aria-label="이전 페이지" className="rounded-lg border border-slate-200 p-2 text-slate-500 hover:bg-slate-50 disabled:opacity-30"><ChevronLeft size={15} /></button>
              <span className="min-w-20 text-center text-xs font-semibold text-slate-600">{data.pagination.page} / {data.pagination.totalPages}</span>
              <button type="button" disabled={data.pagination.page >= data.pagination.totalPages} onClick={() => navigate({ page: String(data.pagination.page + 1) })}
                aria-label="다음 페이지" className="rounded-lg border border-slate-200 p-2 text-slate-500 hover:bg-slate-50 disabled:opacity-30"><ChevronRight size={15} /></button>
            </div>
          </div>
        )}
      </section>
      {reviewId && <DuplicateReviewPanel id={reviewId} isAdmin={isAdmin} onClose={() => setReviewId(null)} onChanged={load} />}
      {closingInquiry && <dialog ref={closeDialog} onCancel={event => { if (closing) event.preventDefault(); else setClosingInquiry(null) }} aria-labelledby="close-landing-title" aria-describedby="close-landing-description" className="fixed inset-0 m-auto w-[90vw] max-w-md rounded-xl bg-white p-6 shadow-xl backdrop:bg-black/50">
          <h2 id="close-landing-title" className="font-bold text-slate-900">상담을 종료하고 개인정보를 삭제할까요?</h2>
          <p id="close-landing-description" className="mt-3 text-sm text-slate-600">EV&Marketing에 보관된 이 홈페이지 문의의 이름, 연락처, 지역과 동의 기록이 삭제되고 대기 중인 등록 요청은 취소됩니다. WARP에 이미 전달된 고객과 상담 이력은 삭제되지 않으며 WARP에서 별도로 처리해야 합니다. 되돌릴 수 없습니다. 계약·분쟁 등 별도 법정 보존 대상인 기록은 담당 절차에 따라 분리 보관한 후 진행해 주세요.</p>
          {closeError && <p role="alert" className="mt-3 text-sm text-red-700">{closeError}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" autoFocus disabled={closing} onClick={() => setClosingInquiry(null)} className="min-h-11 rounded-lg border border-slate-300 px-4 text-sm">취소</button>
            <button type="button" disabled={closing} onClick={() => void closeConsultation()} className="min-h-11 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white disabled:opacity-50">{closing ? '처리 중…' : '상담 종료 및 삭제'}</button>
          </div>
      </dialog>}
    </div>
  )
}
