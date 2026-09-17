import { auth } from '@/auth'
import Link from 'next/link'
import { logoutAction } from '@/app/actions/auth'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await auth()
  const user = session?.user

  return (
    <div className="flex h-full min-h-screen">
      <aside className="w-56 shrink-0 flex flex-col" style={{ backgroundColor: '#111111' }}>
        <div className="px-5 py-5">
          <div className="text-xl font-black text-white tracking-tight">
            EV<span style={{ color: '#C5D42A' }}>&</span>Marketing
          </div>
        </div>
        <nav className="flex-1 px-3 space-y-1">
          <Link href="/customers"
            className="block px-3 py-2 rounded-lg text-sm font-semibold text-white hover:bg-white/10 transition">
            고객 관리
          </Link>
          <Link href="/inquiries"
            className="block px-3 py-2 rounded-lg text-sm font-semibold text-white hover:bg-white/10 transition">
            문의 내역
          </Link>
        </nav>
        <div className="px-3 py-4 border-t border-white/10">
          <div className="px-3 text-xs text-slate-400 truncate mb-2">{user?.name} · {user?.email}</div>
          <form action={logoutAction}>
            <button type="submit"
              className="w-full text-left px-3 py-2 rounded-lg text-xs font-semibold text-slate-300 hover:bg-white/10 transition">
              로그아웃
            </button>
          </form>
        </div>
      </aside>
      <main className="flex-1 overflow-auto" style={{ backgroundColor: '#f8f9fa' }}>{children}</main>
    </div>
  )
}
