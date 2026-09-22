'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { checkRelease, RELEASE_NOTICE } from '@/lib/release-client'
import { releaseId } from '@/lib/release'

export default function ReleaseNotice() {
  const [message, setMessage] = useState('')
  const router = useRouter()
  useEffect(() => {
    let edited = false
    const dirty = (event: Event) => {
      if (event.target instanceof Element && event.target.closest('main')) edited = true
    }
    // The mapping can expire after preflight. Native reload fallback must not silently lose drafts.
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (edited) { event.preventDefault(); event.returnValue = '' }
    }
    const notice = (event: Event) => setMessage((event as CustomEvent<string>).detail)
    // Check before Next navigation can fall back to a full reload and discard an edited form.
    const navigate = (event: MouseEvent) => {
      if (!releaseId || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
      const anchor = event.target instanceof Element ? event.target.closest('a') : null
      if (!anchor || anchor.target || anchor.hasAttribute('download')) return
      const url = new URL(anchor.href, window.location.href)
      if (url.origin !== window.location.origin || url.pathname.startsWith('/api/') || anchor.getAttribute('href')?.startsWith('#')) return
      event.preventDefault()
      void checkRelease().then(ok => { if (ok) router.push(url.pathname + url.search + url.hash) })
    }
    window.addEventListener(RELEASE_NOTICE, notice)
    document.addEventListener('input', dirty, true)
    document.addEventListener('change', dirty, true)
    window.addEventListener('beforeunload', beforeUnload)
    document.addEventListener('click', navigate, true)
    return () => {
      window.removeEventListener(RELEASE_NOTICE, notice)
      document.removeEventListener('input', dirty, true)
      document.removeEventListener('change', dirty, true)
      window.removeEventListener('beforeunload', beforeUnload)
      document.removeEventListener('click', navigate, true)
    }
  }, [router])
  if (!message) return null
  return <aside role="alert" className="fixed bottom-4 left-4 right-4 z-50 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-slate-900 shadow-lg">
    <p>{message}</p>
    <button className="mt-2 underline font-semibold" onClick={() => {
      if (window.confirm('아직 저장하지 않은 입력 내용이 사라질 수 있습니다. 새로고침할까요?')) window.location.reload()
    }}>새로고침</button>
  </aside>
}
