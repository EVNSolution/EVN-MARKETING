import { Suspense } from 'react'
import { redirect } from 'next/navigation'
import { auth } from '@/auth'
import InquiryListClient from './InquiryListClient'

export default async function InquiriesPage() {
  const session = await auth()
  if (!session?.user) redirect('/login')

  return (
    <div className="flex min-h-screen flex-col bg-slate-50">
      <div className="shrink-0 bg-[#111111] px-6 py-4">
        <h1 className="text-lg font-bold leading-tight text-white">문의 내역</h1>
        <p className="mt-0.5 text-[11px] font-medium text-[#C5D42A]">원본 문의 조회 · 동기화 상태</p>
      </div>
      <Suspense fallback={<div className="p-6 text-sm text-slate-400">문의 내역을 불러오는 중입니다.</div>}>
        <InquiryListClient isAdmin={session.user.role === 'admin'} />
      </Suspense>
    </div>
  )
}
