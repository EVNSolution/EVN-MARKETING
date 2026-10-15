'use client'

import { useEffect, useState } from 'react'
import { apiFetch } from '@/lib/release-client'
import type { inquiryReview } from '@/lib/inquiry-review'
import type { NameJobView } from '@/lib/warp-customer-name'

type Review = NonNullable<Awaited<ReturnType<typeof inquiryReview>>>
const explanations = {
  already_named: 'WARP에 이미 실명이 있습니다. 자동으로 덮어쓰지 않습니다. 다른 이름인 이유를 확인하고 필요한 경우 WARP 고객관리에서 직접 수정해 주세요.',
  same_name: 'WARP에 이미 같은 이름이 저장되어 있습니다. 추가 변경은 필요하지 않습니다.',
  not_found: '이 휴대폰 번호로 등록된 WARP 고객이 없습니다. 이름 보완 대신 대표 문의 등록 여부를 검토해 주세요.',
  ambiguous: 'WARP에 같은 휴대폰 번호의 고객이 여러 명 있습니다. WARP 중복 고객 확인에서 통합한 뒤 다시 조회해 주세요.',
  updated: '기존 WARP 고객 이름을 보완했습니다. 새 고객이나 리드는 추가하지 않았습니다.',
  unchanged: 'WARP에서 동일한 이름 보완의 처리 완료를 확인했습니다. 중복으로 수정하지 않았습니다.',
}

export default function CustomerNameReview({ review, disabled, onBusy, onRefresh }: { review: Review; disabled: boolean; onBusy: (busy: boolean) => void; onRefresh: () => Promise<void> }) {
  const [candidateId, setCandidateId] = useState(review.nameCandidates.length === 1 ? review.nameCandidates[0].id : '')
  const [job, setJob] = useState<NameJobView | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [timedOut, setTimedOut] = useState(false)
  const [needsRefresh, setNeedsRefresh] = useState(false)
  const pending = Boolean(job && ['preview', 'confirm'].includes(job.phase))
  const jobId = job?.id
  const busy = sending || (pending && !timedOut)
  const url = `/api/inquiries/${review.row.id}/customer-name`

  useEffect(() => { onBusy(busy); return () => onBusy(false) }, [busy, onBusy])
  useEffect(() => {
    if (!jobId || !pending || timedOut) return
    const controller = new AbortController()
    let polling = false
    const poll = async () => {
      if (polling) return
      polling = true
      try {
        const response = await apiFetch(`${url}?job=${jobId}`, { cache: 'no-store', signal: controller.signal })
        const body = await response.json()
        if (!response.ok) throw new Error(body.error)
        if (!controller.signal.aborted) { setJob(body); setError('') }
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '처리 결과를 확인하지 못했습니다.')
      } finally { polling = false }
    }
    const timer = window.setInterval(() => void poll(), 1500)
    const limit = window.setTimeout(() => { setTimedOut(true); setError('결과 확인이 지연되고 있습니다. 처리 결과 다시 확인을 눌러 주세요. 결과 확인 전에는 다른 이름으로 변경하지 마세요.') }, 90_000)
    return () => { controller.abort(); window.clearInterval(timer); window.clearTimeout(limit) }
  }, [jobId, pending, timedOut, url]) // Poll only the current operation; never submit on a timer.

  async function submit(action: 'preview' | 'confirm') {
    if (busy || disabled || needsRefresh || !candidateId || (action === 'confirm' && (!confirmed || job?.phase !== 'ready'))) return
    setSending(true); setError(''); setTimedOut(false); setConfirmed(false)
    let uncertain = true
    try {
      const response = await apiFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, candidateId, reviewToken: review.reviewToken, ...(action === 'confirm' ? { jobId: job!.id } : {}) }) })
      const body = await response.json()
      if (!response.ok) {
        if ([400, 401, 403, 404, 409, 429].includes(response.status)) {
          uncertain = false
          if (action === 'confirm') setJob(null)
          if (response.status === 409) setNeedsRefresh(true)
        }
        throw new Error(body.error)
      }
      setJob(body); setConfirmed(false)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '이름 보완 요청에 실패했습니다.')
      // A lost response can follow an accepted confirmation. Read its state before allowing a different proposal.
      if (action === 'confirm' && job && uncertain) setJob({ ...job, phase: 'confirm' })
    }
    finally { setSending(false) }
  }
  if (!review.nameCandidates.length) return <section aria-label="WARP 이름 보완" className="rounded-xl border border-slate-200 p-4">
    <h3 className="font-semibold text-slate-900">WARP 이름 보완</h3>
    <p className="mt-2 text-xs leading-relaxed text-slate-500">같은 휴대폰 번호로 접수된 실명 문의가 있으면, WARP의 미상 이름을 확인하고 보완할 수 있습니다.</p>
  </section>
  const result = job?.result
  return <section aria-label="WARP 이름 보완" className="space-y-3 rounded-xl border border-sky-200 bg-sky-50/50 p-4">
    <div><h3 className="font-semibold text-slate-900">WARP 이름 보완</h3>
      <p className="mt-1 text-xs leading-relaxed text-slate-600">같은 휴대폰 번호의 실명 문의로 기존 고객의 미상 이름만 보완합니다. 원본 문의와 등록 상태는 유지됩니다.</p></div>
    <label className="block text-xs font-medium">반영할 이름이 있는 문의
      <select aria-label="반영할 이름이 있는 문의" value={candidateId} disabled={busy || disabled || pending || needsRefresh} onChange={event => {
        setCandidateId(event.target.value); setJob(null); setConfirmed(false); setError('')
      }} className="mt-2 min-h-11 w-full min-w-0 rounded-lg border border-slate-200 bg-white px-3 text-sm">
        <option value="" disabled>이름을 선택해 주세요</option>
        {review.nameCandidates.map(item => <option key={item.id} value={item.id}>{item.name} · {item.inquiryDate} {item.inquiryTime}</option>)}
      </select>
    </label>
    {review.nameCandidates.length > 1 && <p className="text-xs text-amber-800">같은 번호에 서로 다른 이름이 있습니다. 동일 고객인지 확인한 뒤 선택해 주세요.</p>}
    {!pending && !needsRefresh && <button type="button" disabled={!candidateId || busy || disabled} onClick={() => void submit('preview')}
      className="min-h-11 rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold disabled:opacity-40">WARP 이름 확인</button>}
    {pending && !timedOut && <p role="status" className="text-xs leading-relaxed text-sky-800">{job?.phase === 'confirm' ? '기존 고객 이름을 보완하고 있습니다.' : 'WARP의 현재 고객 이름을 확인하고 있습니다.'} 연결 상태에 따라 잠시 걸릴 수 있습니다.</p>}
    {timedOut && <button type="button" onClick={() => { setTimedOut(false); setError('') }} className="min-h-11 rounded-lg border border-slate-300 bg-white px-4 text-xs font-semibold">처리 결과 다시 확인</button>}
    {result?.customer && <dl className="grid grid-cols-1 gap-3 rounded-lg border border-slate-200 bg-white p-3 text-xs sm:grid-cols-2">
      <div><dt className="text-slate-500">{['updated', 'unchanged'].includes(result.status) ? '저장된 WARP 이름' : '현재 WARP 이름'}</dt><dd className="mt-1 break-all font-semibold text-slate-900">{result.customer.name || '(이름 없음)'}</dd></div>
      <div><dt className="text-slate-500">문의에서 확인한 이름</dt><dd className="mt-1 break-all font-semibold text-sky-800">{result.proposedName}</dd></div>
      <div className="sm:col-span-2"><dt className="text-slate-500">일치하는 휴대폰 번호</dt><dd className="mt-1 tabular-nums">{result.customer.phone}</dd></div>
    </dl>}
    {job?.phase === 'ready' && <>
      <label className="flex min-h-11 items-start gap-3 rounded-lg border border-sky-200 bg-white p-3 text-xs leading-relaxed">
        <input type="checkbox" checked={confirmed} disabled={disabled || busy} onChange={event => setConfirmed(event.target.checked)} className="mt-0.5 h-5 w-5 shrink-0" />
        같은 고객임을 확인했으며, WARP의 미상 이름을 선택한 문의의 이름으로 바꾸는 것에 동의합니다.
      </label>
      <button type="button" disabled={!confirmed || busy || disabled} onClick={() => void submit('confirm')}
        className="min-h-11 w-full rounded-lg bg-sky-700 px-4 py-2 text-xs font-bold text-white disabled:opacity-40 sm:w-auto">확인한 이름으로 보완</button>
    </>}
    {job?.phase === 'done' && result && result.status !== 'ready' && <p role="status" className="text-xs leading-relaxed text-slate-700">{explanations[result.status]}</p>}
    {(error || job?.error) && <p role="alert" className="text-xs leading-relaxed text-red-700">{error || job?.error}</p>}
    {needsRefresh && <button type="button" onClick={() => void onRefresh().then(() => { setNeedsRefresh(false); setError(''); setJob(null); setConfirmed(false) })}
      className="min-h-11 rounded-lg border border-slate-300 bg-white px-4 text-xs font-semibold">검토 내용 새로고침</button>}
  </section>
}
