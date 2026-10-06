import { auth } from '@/auth'
import Link from 'next/link'
import LogoutForm from '@/components/LogoutForm'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await auth()
  const user = session?.user

  return (
    <div className="flex h-full min-h-screen flex-col md:flex-row">
      <aside className="flex w-full shrink-0 flex-wrap items-center md:w-56 md:flex-col md:items-stretch" style={{ backgroundColor: '#111111' }}>
        <div className="px-4 py-3 md:px-5 md:py-5">
          <div className="text-xl font-black text-white tracking-tight">
            EV<span style={{ color: '#C5D42A' }}>&</span>Marketing
          </div>
        </div>
        <nav className="order-2 flex w-full gap-2 px-3 pb-3 md:order-none md:block md:w-auto md:flex-1 md:space-y-1 md:pb-0">
          <Link href="/inquiries"
            className="flex min-h-11 items-center rounded-lg px-3 py-2 text-sm font-semibold text-white transition hover:bg-white/10">
            문의 내역
          </Link>
          <a href="https://warp.cleversystem.ai/customers" target="_blank" rel="noreferrer"
            className="flex min-h-11 items-center rounded-lg px-3 py-2 text-sm font-semibold text-white transition hover:bg-white/10">
            WARP CRM
          </a>
        </nav>
        <div className="ml-auto px-3 py-2 md:order-last md:ml-0 md:border-t md:border-white/10 md:py-4">
          <div className="mb-2 hidden truncate px-3 text-xs text-slate-400 md:block">{user?.name} · {user?.email}</div>
          <LogoutForm />
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-auto" style={{ backgroundColor: '#f8f9fa' }}>{children}</main>
    </div>
  )
}
