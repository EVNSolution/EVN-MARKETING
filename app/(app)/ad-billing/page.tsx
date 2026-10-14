import { redirect } from 'next/navigation'
import { auth } from '@/auth'
import { previousBillingMonth } from '@/lib/ad-billing'
import AdBillingClient from './AdBillingClient'

export default async function AdBillingPage() {
  const session = await auth()
  if (!session?.user) redirect('/login')
  if (session.user.role !== 'admin') redirect('/inquiries')
  return <div className="min-h-screen bg-slate-50">
    <header className="bg-[#111111] px-5 py-5 text-white sm:px-8">
      <p className="text-xs font-semibold text-[#C5D42A]">당근 광고 · 월별 거래내역</p>
      <h1 className="mt-1 text-xl font-bold">광고비 정산</h1>
      <p className="mt-2 text-sm text-slate-300">충전내역과 집행내역을 각각 확인하고 엑셀로 내려받습니다.</p>
    </header>
    <AdBillingClient initialMonth={previousBillingMonth()} />
  </div>
}
