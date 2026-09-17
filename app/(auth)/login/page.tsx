'use client'

import { useActionState, useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { loginAction } from '@/app/actions/auth'

export default function LoginPage() {
  const [state, formAction, isPending] = useActionState(loginAction, undefined)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const router = useRouter()

  useEffect(() => {
    if (state?.success) {
      router.push('/')
      router.refresh()
    }
  }, [state, router])

  return (
    <div className="w-full max-w-sm">
      {/* 로고 */}
      <div className="text-center mb-10">
        <div className="text-3xl font-black text-white tracking-tight mb-1">
          EV<span style={{ color: '#C5D42A' }}>&</span>Marketing
        </div>
        <div className="text-sm" style={{ color: '#888' }}>
          이브이앤솔루션 마케팅 시스템
        </div>
        <div className="text-xs mt-1 italic" style={{ color: '#C5D42A' }}>
          green &amp; reliable
        </div>
      </div>

      {/* 로그인 카드 */}
      <form action={formAction} className="rounded-2xl p-8 space-y-5" style={{ backgroundColor: '#1a1a1a', border: '1px solid rgba(255,255,255,0.08)' }}>
        <h2 className="text-lg font-bold text-white mb-6">로그인</h2>

        <div className="space-y-1">
          <label className="text-xs font-medium" style={{ color: '#aaa' }}>이메일</label>
          <input
            name="email"
            type="email"
            required
            autoComplete="off"
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="example@evnsolution.com"
            className="w-full px-4 py-3 rounded-lg text-sm text-white placeholder:text-slate-600 outline-none transition-all"
            style={{
              backgroundColor: '#2a2a2a',
              border: '1px solid rgba(255,255,255,0.1)',
            }}
            onFocus={e => (e.target.style.borderColor = '#C5D42A')}
            onBlur={e  => (e.target.style.borderColor = 'rgba(255,255,255,0.1)')}
          />
        </div>

        <div className="space-y-1">
          <label className="text-xs font-medium" style={{ color: '#aaa' }}>비밀번호</label>
          <input
            name="password"
            type="password"
            required
            autoComplete="off"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="비밀번호 입력"
            className="w-full px-4 py-3 rounded-lg text-sm text-white placeholder:text-slate-600 outline-none transition-all"
            style={{
              backgroundColor: '#2a2a2a',
              border: '1px solid rgba(255,255,255,0.1)',
            }}
            onFocus={e => (e.target.style.borderColor = '#C5D42A')}
            onBlur={e  => (e.target.style.borderColor = 'rgba(255,255,255,0.1)')}
          />
        </div>

        {state?.error && (
          <p className="text-xs text-red-400 bg-red-950/40 px-3 py-2 rounded-lg">{state.error}</p>
        )}

        <button
          type="submit"
          disabled={isPending || !!state?.success}
          className="w-full py-3 rounded-lg text-sm font-bold text-black transition-opacity disabled:opacity-50"
          style={{ backgroundColor: '#C5D42A' }}
        >
          {isPending || state?.success ? '로그인 중…' : '로그인'}
        </button>
      </form>

      <p className="text-center text-xs mt-6" style={{ color: '#555' }}>
        계정 문의: 시스템 관리자에게 연락하세요
      </p>
    </div>
  )
}
