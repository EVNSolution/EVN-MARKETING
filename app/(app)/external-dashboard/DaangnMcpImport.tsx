'use client'
import { useState } from 'react'
import { apiFetch } from '@/lib/release-client'
import { formatKrw } from '@/lib/ad-spend'
import type { previewDaangnMcp } from '@/lib/daangn-mcp-ad-spend'

export default function DaangnMcpImport({ lastImportedAt, refresh }: { lastImportedAt: string | null; refresh: () => Promise<void> }) {
  const [file, setFile] = useState<File | null>(null), [preview, setPreview] = useState<ReturnType<typeof previewDaangnMcp> | null>(null)
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('')
  const send = async (mode: 'preview' | 'import') => {
    if (!file) return
    setBusy(true); setMessage('')
    try {
      if (!/\.json$/i.test(file.name) || file.size > 2 * 1024 * 1024) throw new Error('2MB 이하의 당근 MCP 원문 JSON을 선택해 주세요.')
      const params = new URLSearchParams({ mode }); if (preview) params.set('hash', preview.hash)
      const response = await apiFetch('/api/external-dashboard/ad-spend/mcp-import?' + params, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: file })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || '당근 조회 결과를 처리하지 못했습니다.')
      if (mode === 'preview') setPreview(body.preview)
      else { setMessage(`MCP 결과 ${body.rows}행을 저장했습니다. 원본에 없는 ${body.missingDays}일은 미수집 상태로 유지합니다.`); setPreview(null); await refresh() }
    } catch (error) { setMessage(error instanceof Error ? error.message : '당근 조회 결과를 처리하지 못했습니다.') }
    finally { setBusy(false) }
  }
  return <section aria-label="당근 MCP 결과 저장" className="my-3 min-w-0 rounded-lg bg-slate-50 p-3 text-xs leading-5">
    <h3 className="font-semibold">당근 공식 조회 결과</h3>
    <p className="my-2">당근 MCP에서 하루씩 조회한 원문 JSON을 선택하세요. 파일에 기록된 날짜만 갱신하며 최대 31일을 한 번에 저장합니다. 마지막 MCP 저장: {lastImportedAt ? new Date(lastImportedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '없음'}</p>
    <label className="block min-w-0">당근 MCP 원문 JSON<input type="file" accept=".json,application/json" disabled={busy} onChange={e => { setFile(e.target.files?.[0] ?? null); setPreview(null); setMessage('') }} className="mt-2 block w-full min-w-0 max-w-full text-xs" /></label>
    <button type="button" disabled={!file || busy} onClick={() => void send('preview')} className="my-3 min-h-11 rounded-lg border bg-white px-4 py-2 font-semibold disabled:opacity-50">MCP 결과 미리보기</button>
    {preview && <div className="space-y-2 rounded-lg border border-slate-200 bg-white p-3">
      <p>{preview.start} ~ {preview.end} · 조회 {preview.days.length}일 · 값이 있는 {preview.rowCount}행</p>
      <p className="break-all">수집된 금액 {formatKrw(preview.amount)} · 부가세 기준 미확인</p>
      <p>기존에 같은 날짜·같은 금액으로 확인된 부가세 기준은 유지합니다. 금액을 환산하지 않습니다.</p>
      {preview.missingDays.length > 0 && <p>원본 미포함 {preview.missingDays.length}일: {preview.missingDays.join(', ')}. 0원으로 채우지 않습니다.</p>}
      <div className="max-h-52 overflow-auto"><table className="w-full text-left"><thead><tr><th>날짜</th><th className="text-right">원문 광고비</th></tr></thead><tbody>{preview.days.map(day => <tr key={day.date}><td>{day.date}</td><td className="text-right">{day.amount === null ? '미수집' : formatKrw(day.amount)}</td></tr>)}</tbody></table></div>
      <button type="button" disabled={busy} onClick={() => void send('import')} className="min-h-11 rounded-lg bg-slate-800 px-4 py-2 text-white disabled:opacity-50">확인한 MCP 결과 저장</button>
    </div>}
    {message && <p role="status" className="mt-2 text-sm leading-6">{message}</p>}
  </section>
}
