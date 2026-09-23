'use client'

import { apiFetch, checkRelease } from '@/lib/release-client'

import { useState, useMemo, useEffect, useRef } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Phone, Truck } from 'lucide-react'

/**
 * "미상(...)" 이름에 박아둔 이모지 아이콘(📞/🚚)을 전화/차량번호 바로 앞에
 * 실제 아이콘 컴포넌트로 보여주기 위한 파싱. 아이콘이 없으면 before만 채워진다.
 */
function splitUnknownName(name: string): { before: string; Icon: typeof Phone | null; after: string } {
  const m = name.match(/^(.*?)(📞|🚚)\s?(.*)$/)
  if (!m) return { before: name, Icon: null, after: '' }
  return { before: m[1], Icon: m[2] === '📞' ? Phone : Truck, after: m[3] }
}

type Activity = { id: string; date: string; type: string }
type Customer = {
  id: string
  name: string
  phone: string | null
  email: string | null
  customerSegment: string | null
  contactTitle: string | null
  status: string
  grade: string | null
  source: string | null
  collectedAt: string | null
  assignee: string | null
  isAgent: boolean | null
  companyName: string | null
  cargoType: string | null
  vehiclePlateNo: string | null
  contactsJson: string | null
  activities: Activity[]
  createdAt: string
}

type Seg = 'all' | 'B2C' | 'B2B'

/* ── 컬럼 설정 ── */
type W = 'sm' | 'md' | 'lg'
const W_PX: Record<W, number> = { sm: 72, md: 120, lg: 196 }
interface ColCfg { key: string; visible: boolean; width: W }
interface ColDef { key: string; label: string; dw: W }

const COL_DEFS: ColDef[] = [
  { key: 'name',         label: '이름',     dw: 'md' },
  { key: 'phone',        label: '연락처',   dw: 'md' },
  { key: 'segment',      label: '세그먼트', dw: 'sm' },
  { key: 'companyName',  label: '회사명',   dw: 'md' },
  { key: 'contactTitle', label: '직위',     dw: 'sm' },
  { key: 'source',       label: '유입경로', dw: 'sm' },
  { key: 'collectedAt',  label: '수집일',   dw: 'sm' },
  { key: 'assignee',     label: '담당자',   dw: 'sm' },
  { key: 'isAgent',      label: '소개인',   dw: 'sm' },
  { key: 'lastActivity', label: '최근활동', dw: 'md' },
  { key: 'detail',       label: '상세',     dw: 'sm' },
]

const LS_KEY = 'evn-marketing-customer-list-cols-v1'

function mkCfg(defs: ColDef[]): ColCfg[] {
  return defs.map(d => ({ key: d.key, visible: true, width: d.dw }))
}

function parseCfg(raw: string | null): ColCfg[] {
  if (!raw) return mkCfg(COL_DEFS)
  try {
    const saved: ColCfg[] = JSON.parse(raw)
    const defSet   = new Set(COL_DEFS.map(d => d.key))
    const savedSet = new Set(saved.map(c => c.key))
    return [
      ...saved.filter(c => defSet.has(c.key)),
      ...COL_DEFS.filter(d => !savedSet.has(d.key)).map(d => ({ key: d.key, visible: true, width: d.dw })),
    ]
  } catch { return mkCfg(COL_DEFS) }
}

/* ── 컬럼 설정 패널 ── */
function ColSettingsPanel({
  cols, onChange, onClose,
}: {
  cols: ColCfg[]
  onChange: (cfg: ColCfg[]) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<string | null>(null)

  useEffect(() => {
    const fn = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', fn)
    return () => document.removeEventListener('mousedown', fn)
  }, [onClose])

  const getLabel = (key: string) => COL_DEFS.find(d => d.key === key)?.label ?? key

  const upd = (key: string, patch: Partial<ColCfg>) =>
    onChange(cols.map(c => c.key === key ? { ...c, ...patch } : c))

  const move = (from: string, to: string) => {
    if (from === to) return
    const arr = [...cols]
    const fi = arr.findIndex(c => c.key === from)
    const ti = arr.findIndex(c => c.key === to)
    const [item] = arr.splice(fi, 1)
    arr.splice(ti, 0, item)
    onChange(arr)
  }

  return (
    <div ref={ref}
      className="absolute right-0 top-full mt-1.5 z-50 bg-white rounded-xl border border-slate-200 shadow-2xl overflow-hidden"
      style={{ width: 296 }}>
      <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-100 flex items-center justify-between">
        <span className="text-xs font-bold text-slate-700">컬럼 설정</span>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-700 transition text-base leading-none">✕</button>
      </div>
      <p className="px-4 py-1.5 text-[10px] text-slate-400 bg-slate-50 border-b border-slate-100">
        드래그 순서 변경 · ● 표시/숨김 · S/M/L 넓이 조정
      </p>
      <div className="py-1 max-h-72 overflow-y-auto">
        {cols.map(c => (
          <div key={c.key}
            draggable
            onDragStart={e => { e.dataTransfer.effectAllowed = 'move'; setDrag(c.key) }}
            onDragOver={e => e.preventDefault()}
            onDrop={() => { if (drag) move(drag, c.key); setDrag(null) }}
            onDragEnd={() => setDrag(null)}
            className={`flex items-center gap-2 px-3 py-2 hover:bg-slate-50 transition-colors select-none
              ${drag === c.key ? 'opacity-30' : ''}`}>
            <span className="text-slate-300 cursor-grab text-sm">⠿</span>
            <button onClick={() => upd(c.key, { visible: !c.visible })}
              className={`text-sm transition font-bold ${c.visible ? 'text-blue-500' : 'text-slate-300'}`}>
              {c.visible ? '●' : '○'}
            </button>
            <span className={`flex-1 text-xs ${c.visible ? 'text-slate-700 font-medium' : 'text-slate-300 line-through'}`}>
              {getLabel(c.key)}
            </span>
            <div className="flex gap-0.5">
              {(['sm', 'md', 'lg'] as W[]).map(w => (
                <button key={w} onClick={() => upd(c.key, { width: w })}
                  className={`w-6 h-5 rounded text-[9px] font-bold transition
                    ${c.width === w ? 'bg-slate-800 text-white' : 'text-slate-400 hover:bg-slate-100'}`}>
                  {w === 'sm' ? 'S' : w === 'md' ? 'M' : 'L'}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="px-4 py-2 border-t border-slate-100 flex items-center justify-between">
        <button onClick={() => onChange(mkCfg(COL_DEFS))}
          className="text-[11px] text-slate-400 hover:text-red-500 transition">
          기본값 초기화
        </button>
        <span className="text-[10px] text-slate-300">
          {cols.filter(c => c.visible).length}/{cols.length} 표시 중
        </span>
      </div>
    </div>
  )
}

function fmtDate(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('ko-KR', { month: '2-digit', day: '2-digit' }).replace('. ', '/').replace('.', '')
}

export interface CustomerListProps { customers: Customer[] }

export default function CustomerListClient({ customers: initial }: CustomerListProps) {
  const router = useRouter()
  const [customers] = useState<Customer[]>(initial)
  const [seg,          setSeg]          = useState<Seg>('all')
  const [search,       setSearch]       = useState('')
  const [cols,         setCols]         = useState<ColCfg[]>(() => mkCfg(COL_DEFS))
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [creating,     setCreating]     = useState(false)

  /* 모달 없이 바로 고객상세 페이지로 이동 — 이름은 비워둔 채 생성 후 상세페이지에서 채움 */
  const handleQuickAdd = async () => {
    if (creating) return
    setCreating(true)
    try {
      const res = await apiFetch('/api/customers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          allowBlankName: true,
          customerSegment: 'B2C',
          collectedAt: new Date().toISOString(),
        }),
      })
      if (!res.ok) return
      const c = await res.json()
      router.push(`/customers/${c.id}`)
    } finally {
      setCreating(false)
    }
  }

  /* localStorage는 서버에 없으므로 SSR 결과와 다를 수 있어, hydration 직후 한 번만 동기화한다 */
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCols(parseCfg(localStorage.getItem(LS_KEY)))
  }, [])

  /* 변경 시 저장 */
  const updateCols = (next: ColCfg[]) => {
    setCols(next)
    localStorage.setItem(LS_KEY, JSON.stringify(next))
  }

  const visCols = cols.filter(c => c.visible)

  const b2cCount = useMemo(() => customers.filter(c => (c.customerSegment ?? 'B2C') === 'B2C').length, [customers])
  const b2bCount = useMemo(() => customers.filter(c => c.customerSegment === 'B2B').length, [customers])

  const filtered = useMemo(() => {
    return customers.filter(c => {
      if (seg !== 'all' && (c.customerSegment ?? 'B2C') !== seg) return false
      if (search) {
        const q = search.toLowerCase()
        if (!c.name.toLowerCase().includes(q) &&
            !(c.phone ?? '').includes(q) &&
            !(c.companyName ?? '').toLowerCase().includes(q) &&
            !(c.contactsJson ?? '').toLowerCase().includes(q) &&
            !(c.vehiclePlateNo ?? '').toLowerCase().includes(q)) return false
      }
      return true
    })
  }, [customers, seg, search])

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-white">
      {/* 고객 수량 요약 */}
      <div className="flex items-center gap-4 px-5 py-2.5 border-b border-slate-100 bg-white shrink-0">
        <div className="flex items-baseline gap-1.5">
          <span className="text-2xl font-black text-slate-800 tabular-nums">{customers.length}</span>
          <span className="text-xs text-slate-400 font-medium">총 고객</span>
        </div>
        <div className="w-px h-6 bg-slate-200" />
        <div className="flex items-baseline gap-1.5">
          <span className="text-xl font-bold text-sky-600 tabular-nums">{b2cCount}</span>
          <span className="text-xs text-sky-500 font-medium">B2C 개인</span>
        </div>
        <div className="w-px h-6 bg-slate-200" />
        <div className="flex items-baseline gap-1.5">
          <span className="text-xl font-bold text-violet-600 tabular-nums">{b2bCount}</span>
          <span className="text-xs text-violet-500 font-medium">B2B 법인</span>
        </div>
        {filtered.length !== customers.length && (
          <>
            <div className="w-px h-6 bg-slate-200" />
            <div className="flex items-baseline gap-1.5">
              <span className="text-sm font-semibold text-slate-500 tabular-nums">{filtered.length}</span>
              <span className="text-xs text-slate-400">필터 결과</span>
            </div>
          </>
        )}
      </div>

      {/* 툴바 */}
      <div className="flex items-center gap-3 px-5 py-2.5 border-b border-slate-200 bg-slate-50 shrink-0 flex-wrap">
        {/* B2C/B2B 필터 */}
        <div className="flex gap-1">
          {(['all', 'B2C', 'B2B'] as Seg[]).map(s => (
            <button key={s} onClick={() => setSeg(s)}
              className={`px-3 py-1 rounded-full text-[11px] font-semibold transition
                ${seg === s
                  ? s === 'B2B' ? 'bg-violet-700 text-white' : s === 'B2C' ? 'bg-sky-600 text-white' : 'bg-slate-600 text-white'
                  : 'text-slate-400 hover:bg-slate-100'}`}>
              {s === 'all' ? '전체' : s === 'B2C' ? 'B2C 개인' : 'B2B 법인'}
            </button>
          ))}
        </div>

        {/* 검색 */}
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="이름·연락처·회사명·차량번호 검색"
          className="ml-auto text-xs border border-slate-200 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-slate-300 w-52"
        />

        {/* 컬럼 설정 버튼 */}
        <div className="relative">
          <button
            onClick={() => setSettingsOpen(v => !v)}
            title="컬럼 설정"
            className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-[11px] font-semibold border transition
              ${settingsOpen
                ? 'bg-slate-800 text-white border-slate-800'
                : 'border-slate-200 text-slate-500 hover:bg-slate-50'}`}>
            ⚙ 컬럼
          </button>
          {settingsOpen && (
            <ColSettingsPanel
              cols={cols}
              onChange={updateCols}
              onClose={() => setSettingsOpen(false)}
            />
          )}
        </div>

        {/* 신규 고객 추가 */}
        <button onClick={handleQuickAdd} disabled={creating}
          className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-slate-800 text-white hover:bg-slate-700 transition disabled:opacity-50">
          {creating ? '생성 중...' : '+ 고객 추가'}
        </button>
      </div>

      {/* 테이블 */}
      <div className="flex-1 overflow-auto">
        {filtered.length === 0 ? (
          <div className="flex items-center justify-center h-full text-slate-400 text-sm">
            고객이 없습니다
          </div>
        ) : (
          <table className="w-full text-xs" style={{ tableLayout: 'fixed' }}>
            <colgroup>
              {visCols.map(c => (
                <col key={c.key} style={{ width: W_PX[c.width] }} />
              ))}
            </colgroup>
            <thead className="sticky top-0 z-10">
              <tr className="bg-slate-100 border-b border-slate-200 text-[10px] font-bold text-slate-500 uppercase tracking-widest">
                {visCols.map(c => (
                  <th key={c.key}
                    className={`px-3 py-2.5 text-left truncate ${c.key === 'isAgent' || c.key === 'detail' ? 'text-center' : ''}`}>
                    {COL_DEFS.find(d => d.key === c.key)?.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {filtered.map(c => {
                const lastAct = c.activities[0]
                return (
                  <tr key={c.id} className="hover:bg-slate-50 transition-colors cursor-pointer"
                    onClick={async () => { if (await checkRelease()) router.push(`/customers/${c.id}`) }}>
                    {visCols.map(vc => {
                      switch (vc.key) {
                        case 'name': {
                          const { before, Icon, after } = splitUnknownName(c.name)
                          return (
                            <td key="name" className="px-3 py-2.5 truncate">
                              <div className="flex items-center gap-1.5 min-w-0">
                                <span className="font-semibold text-slate-800 truncate inline-flex items-center gap-0.5">
                                  {before}
                                  {Icon && <Icon size={11} className="text-slate-400 shrink-0" />}
                                  {after}
                                </span>
                                {(c.customerSegment ?? 'B2C') === 'B2B'
                                  ? <span className="shrink-0 px-1.5 py-0.5 rounded text-[9px] font-bold bg-violet-100 text-violet-700">법인</span>
                                  : <span className="shrink-0 px-1.5 py-0.5 rounded text-[9px] font-bold bg-sky-50 text-sky-600">개인</span>}
                              </div>
                            </td>
                          )
                        }
                        case 'phone':
                          return <td key="phone" className="px-3 py-2.5 text-slate-500 truncate">{c.phone ?? '—'}</td>
                        case 'segment':
                          return <td key="segment" className="px-3 py-2.5 text-slate-400 truncate">{c.customerSegment ?? 'B2C'}</td>
                        case 'companyName':
                          return <td key="companyName" className="px-3 py-2.5 text-slate-500 truncate">{c.companyName ?? '—'}</td>
                        case 'contactTitle':
                          return <td key="contactTitle" className="px-3 py-2.5 text-slate-500 truncate">{c.contactTitle ?? '—'}</td>
                        case 'source':
                          return <td key="source" className="px-3 py-2.5 text-slate-400 truncate">{c.source ?? '—'}</td>
                        case 'collectedAt':
                          return <td key="collectedAt" className="px-3 py-2.5 text-slate-400">{fmtDate(c.collectedAt)}</td>
                        case 'assignee':
                          return <td key="assignee" className="px-3 py-2.5 text-slate-500 truncate">{c.assignee ?? '—'}</td>
                        case 'isAgent':
                          return (
                            <td key="isAgent" className="px-3 py-2.5 text-center">
                              {c.isAgent
                                ? <span className="inline-block px-2 py-0.5 rounded-full text-[9px] font-bold bg-indigo-100 text-indigo-700">소개인</span>
                                : <span className="text-slate-200">—</span>}
                            </td>
                          )
                        case 'lastActivity':
                          return (
                            <td key="lastActivity" className="px-3 py-2.5 text-slate-400 truncate">
                              {lastAct
                                ? <span>{fmtDate(lastAct.date)} <span className="text-slate-300">{lastAct.type}</span></span>
                                : <span className="text-slate-200">—</span>}
                            </td>
                          )
                        case 'detail':
                          return (
                            <td key="detail" className="px-3 py-2.5 text-center" onClick={e => e.stopPropagation()}>
                              <Link href={`/customers/${c.id}`}
                                className="inline-block px-2.5 py-1 rounded text-[10px] font-semibold bg-slate-100 text-slate-600 hover:bg-slate-200 transition">
                                상세 →
                              </Link>
                            </td>
                          )
                        default:
                          return <td key={vc.key} />
                      }
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
