'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch } from '@/lib/release-client'
import type { inquiryReview } from '@/lib/inquiry-review'

type Review = NonNullable<Awaited<ReturnType<typeof inquiryReview>>>

export default function DuplicateReviewPanel({ id, isAdmin, onClose, onChanged }: {
  id: string; isAdmin: boolean; onClose: () => void; onChanged: () => Promise<void>
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const token = useRef('')
  const [review, setReview] = useState<Review | null>(null)
  const [holdConfirmed, setHoldConfirmed] = useState(false)
  const [representativeConfirmed, setRepresentativeConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await apiFetch(`/api/inquiries/${id}/duplicate-review`, { cache: 'no-store', signal })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error)
      if (signal?.aborted) return
      if (token.current !== body.reviewToken) {
        setHoldConfirmed(false)
        setRepresentativeConfirmed(false)
      }
      token.current = body.reviewToken
      setReview(body)
      setError('')
    } catch (failure) {
      if (!signal?.aborted) setError(failure instanceof Error ? failure.message : '검토 정보를 불러오지 못했습니다.')
    }
  }, [id])

  useEffect(() => {
    dialog.current?.showModal()
    const controller = new AbortController()
    const initial = window.setTimeout(() => void load(controller.signal), 0)
    return () => { controller.abort(); window.clearTimeout(initial) }
  }, [load])
  useEffect(() => {
    if (!review?.queued && !review?.registrationQueued) return
    const controller = new AbortController()
    const timer = window.setInterval(() => void load(controller.signal), 5_000)
    return () => { controller.abort(); window.clearInterval(timer) }
  }, [review?.queued, review?.registrationQueued, load])

  const decide = async (action: 'hold' | 'recheck' | 'register-representative') => {
    if (!review || busy || (action === 'hold' && !holdConfirmed)
      || (action === 'register-representative' && (!review.canRegisterRepresentative || !representativeConfirmed))) return
    setBusy(true)
    setMessage('')
    try {
      const response = await apiFetch(`/api/inquiries/${id}/duplicate-review`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, reviewToken: review.reviewToken }) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error)
      setMessage(action === 'register-representative'
        ? '대표 문의 등록을 요청했습니다. WARP 확인 후 고객과 리드 등록 결과가 자동으로 표시됩니다.'
        : result.queued ? '재확인을 요청했습니다. 확인 결과가 자동으로 표시됩니다.' : '중복으로 검토 완료했습니다. 이 문의는 전송하지 않습니다.')
    } catch (failure) {
      setMessage(failure instanceof Error ? failure.message : '검토 요청을 처리하지 못했습니다.')
    } finally {
      await load()
      await onChanged()
      setBusy(false)
    }
  }

  return (
    <dialog ref={dialog} aria-labelledby="duplicate-review-title" onCancel={onClose}
      className="fixed inset-0 m-auto max-h-[90dvh] w-[calc(100%-2rem)] max-w-xl overflow-y-auto rounded-2xl bg-white p-0 text-slate-700 shadow-xl backdrop:bg-slate-950/40">
      <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
        <h2 id="duplicate-review-title" className="text-base font-bold text-slate-900">중복 문의 검토</h2>
        <button type="button" aria-label="검토창 닫기" onClick={onClose} className="min-h-11 min-w-11 rounded-lg text-xl hover:bg-slate-100">×</button>
      </div>
      <div className="space-y-4 p-5 text-sm">
        {error && <p role="alert" className="text-red-600">{error} <button type="button" onClick={() => void load()} className="min-h-11 underline">다시 불러오기</button></p>}
        {!review ? <p>검토 정보를 불러오는 중입니다.</p> : <>
          <div className="rounded-xl bg-slate-50 p-4">
            <p className="font-semibold">{review.row.name}</p>
            <p className="mt-1 break-all tabular-nums">{review.row.phone}</p>
            <p className="mt-1 text-xs text-slate-500">{review.row.source === 'evn-landing' ? '새 홈페이지' : '기존 수집 문의'} · {review.row.inquiryDate} {review.row.inquiryTime}</p>
          </div>
          <p><span className={`inline-block rounded-full px-2.5 py-1 text-xs font-bold ${['delivered', 'duplicate_linked'].includes(review.state.status) ? 'bg-lime-100 text-lime-800' : 'bg-amber-50 text-amber-800'}`}>{review.state.label}</span></p>
          <p className="leading-relaxed">{review.state.reason ?? '중복이 없어 등록을 검토할 수 있습니다.'}</p>
          {review.peerCount > 0 && <section aria-label="같은 연락처의 문의">
            <h3 className="font-semibold">같은 연락처의 문의 {review.peerCount}건</h3>
            <ul className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200">
              {review.peers.map(peer => <li key={peer.id} className="flex flex-wrap justify-between gap-2 px-3 py-2 text-xs">
                <span className="break-all font-medium">{peer.name}</span><span>{peer.source === 'evn-landing' ? '새 홈페이지' : '기존 수집 문의'} · {peer.inquiryDate} {peer.inquiryTime} · {peer.state.label}</span>
              </li>)}
            </ul>
            {review.peerCount > review.peers.length && <p className="mt-1 text-xs text-slate-500">먼저 수집된 20건을 표시합니다.</p>}
          </section>}
          {review.representative && <section aria-label="등록 대표 문의" className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-xs font-semibold text-slate-700">등록 대표 문의</p>
            <p className="mt-2 break-all font-semibold text-slate-900">{review.representative.name}</p>
            <p className="mt-1 break-all tabular-nums text-slate-700">{review.row.phone}</p>
            <p className="mt-2"><span className={`inline-block rounded-full px-2.5 py-1 text-xs font-bold ${review.representative.state.status === 'delivered' ? 'bg-lime-100 text-lime-800' : ['blocked', 'failed'].includes(review.representative.state.status) ? 'bg-red-100 text-red-700' : 'bg-sky-100 text-sky-800'}`}>{review.representative.state.label}</span></p>
            {review.representative.state.reason && <p className="mt-2 text-xs leading-relaxed text-slate-600">{review.representative.state.reason}</p>}
            <p className="mt-2 text-xs leading-relaxed text-slate-500">나머지 같은 연락처 문의는 이 대표 건에 연결된 중복 문의로 보존됩니다.</p>
          </section>}
          <p className="text-xs leading-relaxed text-slate-500">EV&amp;Marketing에 같은 연락처 문의가 반복되어도 WARP에 고객이나 리드가 있다는 뜻은 아닙니다. 원격 WARP 조회에 실패하면 안전을 위해 등록 요청을 전송하지 않습니다. 고객 통합이나 연락처 정정 후 재확인할 수 있으며, 원본 문의의 번호가 잘못됐다면 담당자에게 정정을 요청해 주세요.</p>
          <a href="https://warp.cleversystem.ai/customers" target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center font-semibold underline underline-offset-4">WARP 고객관리 열기 ↗</a>
          {review.hasReceipt && <p className="text-xs text-slate-500">이 문의에는 기존 전송 이력이 있습니다. 기록을 보존하며 다시 전송하지 않습니다.</p>}
          {review.queued && <p role="status" className="rounded-lg bg-sky-50 p-3 text-xs text-sky-800">중복 여부를 확인 중입니다. 이 작업은 WARP 고객을 등록하거나 수정하지 않습니다.</p>}
          {review.registrationQueued && <p role="status" className="rounded-lg bg-sky-50 p-3 text-xs text-sky-800">대표 문의의 WARP 등록을 확인 중입니다. 완료되면 결과가 표시됩니다.</p>}
          {isAdmin && review.canRegisterRepresentative && <section aria-label="대표 문의 선택" className="rounded-xl border border-sky-200 bg-sky-50 p-4">
            <p className="text-xs font-semibold text-sky-800">대표로 등록할 문의</p>
            <p className="mt-2 break-all font-semibold text-slate-900">{review.row.name}</p>
            <p className="mt-1 break-all tabular-nums text-slate-700">{review.row.phone}</p>
            <label className="mt-3 flex min-h-11 items-start gap-3 rounded-lg border border-sky-200 bg-white p-3 text-xs leading-relaxed">
              <input type="checkbox" checked={representativeConfirmed} onChange={event => setRepresentativeConfirmed(event.target.checked)} className="mt-0.5 h-5 w-5 shrink-0" />
              이 문의를 같은 연락처 문의의 대표로 선택하고, WARP 확인 후 고객과 리드로 등록하는 것에 동의합니다.
            </label>
          </section>}
          {isAdmin && review.canConfirm && <label className="flex min-h-11 items-start gap-3 rounded-lg border border-slate-200 p-3 text-xs leading-relaxed">
            <input type="checkbox" checked={holdConfirmed} onChange={event => setHoldConfirmed(event.target.checked)} className="mt-0.5 h-5 w-5 shrink-0" />
            이 문의가 중복임을 확인했으며, 전송하지 않고 보류하는 것에 동의합니다.
          </label>}
          {message && <p role="status" className="text-xs leading-relaxed text-slate-600">{message}</p>}
          {isAdmin && <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            {review.canRegisterRepresentative && <button type="button" disabled={busy || !representativeConfirmed || Boolean(error)} onClick={() => void decide('register-representative')}
              className="min-h-11 rounded-lg bg-sky-700 px-4 py-2 text-xs font-bold text-white disabled:opacity-40">이 문의를 대표로 등록</button>}
            {review.canConfirm && <button type="button" disabled={busy || !holdConfirmed || Boolean(error)} onClick={() => void decide('hold')}
              className="min-h-11 rounded-lg bg-slate-900 px-4 py-2 text-xs font-bold text-white disabled:opacity-40">검토완료 · 전송 보류</button>}
            {review.canRecheck && <button type="button" disabled={busy || Boolean(error)} onClick={() => void decide('recheck')}
              className="min-h-11 rounded-lg border border-slate-200 px-4 py-2 text-xs font-bold disabled:opacity-40">중복 재확인</button>}
          </div>}
          <p className="text-xs leading-relaxed text-slate-400">보류와 재확인만으로는 등록되지 않습니다. 대표 등록을 요청하거나, 중복 해소 후 문의 목록의 등록하기를 눌러 주세요.</p>
        </>}
      </div>
    </dialog>
  )
}
