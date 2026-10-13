'use client'
import { useState } from 'react'
import { apiFetch } from '@/lib/release-client'
import { AD_SPEND_START, formatKrw } from '@/lib/ad-spend'
import type { previewDaangnCsv } from '@/lib/daangn-ad-spend'
import { FIELD_CLS } from '@/lib/ui'
import DaangnMcpImport from './DaangnMcpImport'
export default function DaangnAdSpendImport({ today, lastImportedAt, lastMcpImportedAt, refresh }: { today: string; lastImportedAt: string | null; lastMcpImportedAt: string | null; refresh: () => Promise<void> }) {
  const [file, setFile] = useState<File | null>(null), [start, setStart] = useState(AD_SPEND_START), [end, setEnd] = useState(today)
  const [preview, setPreview] = useState<ReturnType<typeof previewDaangnCsv> | null>(null), [busy, setBusy] = useState(false), [message, setMessage] = useState('')
  const send = async (mode: 'preview' | 'import') => {
    if (!file) return
    setBusy(true); setMessage('')
    try {
      if (!/\.csv$/i.test(file.name) || file.size > 2 * 1024 * 1024) throw new Error('당근에서 내려받은 2MB 이하 CSV 파일을 선택해 주세요.')
      const params = new URLSearchParams({ mode, start, end }); if (preview) params.set('hash', preview.hash)
      const response = await apiFetch('/api/external-dashboard/ad-spend/import?' + params, { method: 'POST', headers: { 'Content-Type': 'text/csv;charset=utf-8' }, body: file })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || '보고서를 처리하지 못했습니다.')
      if (mode === 'preview') setPreview(body.preview)
      else { setMessage(`${body.rows}행을 가져왔습니다. 원본에 없는 ${body.missingDays}일은 미수집 상태로 유지합니다.`); setPreview(null); await refresh() }
    } catch (error) { setMessage(error instanceof Error ? error.message : '보고서를 처리하지 못했습니다.') }
    finally { setBusy(false) }
  }
  return <details className="min-w-0 border-t border-slate-200 pt-2 text-sm"><summary className="cursor-pointer py-3 text-xs font-medium text-slate-500">관리자 복구 도구 · 당근 보고서</summary>
    <DaangnMcpImport lastImportedAt={lastMcpImportedAt} refresh={refresh} />
    <p className="mt-2 text-xs leading-5 text-slate-600">누락된 날짜를 원본 보고서로 보완할 때만 사용하세요. 마지막 파일 가져오기: {lastImportedAt ? new Date(lastImportedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '없음'}</p>
    <p className="mt-3 break-all text-xs leading-5">대상: 당근 광고계정 4541556 · EVN 디스플레이 캠페인 1786077964797444000</p>
    <p className="my-3 text-xs leading-5 text-slate-600">당근 전문가모드에서 EVN 캠페인의 일별 성과를 ‘엑셀로 다운로드’한 원본 CSV를 선택하세요. 다운로드한 기간을 지정하면 파일에 없는 날짜를 구분합니다. 원본 CSV는 보관하지 않습니다.</p>
    <div className="grid min-w-0 gap-3 sm:grid-cols-2">
      <label className="min-w-0 text-xs">보고서 시작일<input type="date" min={AD_SPEND_START} max={today} value={start} onChange={e => { setStart(e.target.value); setPreview(null) }} className={`${FIELD_CLS} mt-1 min-w-0 max-w-full`} /></label>
      <label className="min-w-0 text-xs">보고서 종료일<input type="date" min={start} max={today} value={end} onChange={e => { setEnd(e.target.value); setPreview(null) }} className={`${FIELD_CLS} mt-1 min-w-0 max-w-full`} /></label>
      <label className="min-w-0 text-xs sm:col-span-2">당근 원본 CSV<input type="file" accept=".csv,text/csv" disabled={busy} onChange={e => { setFile(e.target.files?.[0] ?? null); setPreview(null); setMessage('') }} className="mt-2 block w-full min-w-0 max-w-full text-xs" /></label>
    </div>
    <button type="button" disabled={!file || busy} onClick={() => void send('preview')} className="my-3 min-h-11 rounded-lg border px-4 py-2 font-semibold disabled:opacity-50">보고서 미리보기</button>
    {preview && <div className="space-y-2 rounded-lg bg-slate-50 p-3 text-xs leading-5">
      <p>{preview.campaign} · {preview.start} ~ {preview.end} · {preview.rowCount}행</p>
      <p className="break-all">파일 내 금액 합계 {formatKrw(preview.amount)} · 부가세 포함{preview.missingDays.length ? ' · 일부 날짜 미포함' : ''}</p>
      {preview.missingDays.length > 0 && <p>원본 미포함 {preview.missingDays.length}일: {preview.missingDays.join(', ')}. 0원으로 채우지 않습니다.</p>}
      <div className="max-h-52 overflow-auto"><table className="w-full text-left"><thead><tr><th>날짜</th><th className="text-right">광고비</th></tr></thead><tbody>{preview.rows.map(row => <tr key={row.date}><td>{row.date}</td><td className="text-right">{formatKrw(row.amount)}</td></tr>)}</tbody></table></div>
      <button type="button" disabled={busy} onClick={() => void send('import')} className="min-h-11 rounded-lg bg-slate-800 px-4 py-2 text-white disabled:opacity-50">확인한 보고서 가져오기</button>
    </div>}
    {message && <p role="status" className="mt-2 text-sm leading-6">{message}</p>}
  </details>
}
