import { redirect } from 'next/navigation'
import { auth } from '@/auth'
import ExternalDashboardClient from './ExternalDashboardClient'

export default async function ExternalDashboardPage() {
  if (!(await auth())?.user) redirect('/login')
  return <div className="min-h-screen bg-slate-50">
    <header className="bg-[#111111] px-6 py-4">
      <h1 className="text-lg font-bold text-white">대시보드(외부)</h1>
      <p className="mt-1 text-xs font-medium text-[#C5D42A]">evnsolution.kr · 방문과 광고 유입 현황</p>
    </header>
    <ExternalDashboardClient />
  </div>
}
