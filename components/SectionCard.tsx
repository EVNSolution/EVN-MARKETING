import type { ReactNode } from 'react'

/* 상세 페이지 공용 — 색상 배너 헤더 + 흰 배경 카드로 섹션을 명확히 구분한다 */
export const SECTION_BG: Record<string, string> = {
  blue: 'bg-blue-600', indigo: 'bg-indigo-600', amber: 'bg-amber-600',
  emerald: 'bg-emerald-600', violet: 'bg-violet-600', sky: 'bg-sky-600',
  slate: 'bg-slate-600', teal: 'bg-teal-600',
}

export function SectionHeader({ color, title, action }: { color: string; title: string; action?: ReactNode }) {
  return (
    <div className={`px-5 py-3 flex items-center justify-between gap-2 ${SECTION_BG[color]}`}>
      <h3 className="text-white font-bold text-sm">{title}</h3>
      {action}
    </div>
  )
}

export function SectionCard({ color, title, action, children }: { color: string; title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <SectionHeader color={color} title={title} action={action} />
      <div className="p-5">{children}</div>
    </div>
  )
}
