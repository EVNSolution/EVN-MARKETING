'use client'

import { Component, useActionState, type ReactNode } from 'react'
import { logoutAction } from '@/app/actions/auth'
import { releaseUrl } from '@/lib/release'
import VersionedForm from './VersionedForm'

export default function LogoutForm() {
  return <LogoutBoundary><LogoutActionForm /></LogoutBoundary>
}

// A rejected action during the preflight/expiry race must not unmount the customer's editor.
class LogoutBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() {
    return this.state.failed ? <p role="alert" className="text-xs text-amber-200">로그아웃을 완료하지 못했습니다. 입력 내용을 확인한 뒤 새로고침해 주세요.</p> : this.props.children
  }
}

function LogoutActionForm() {
  const [, action, pending] = useActionState(logoutAction, undefined, releaseUrl('/customers'))
  return <VersionedForm action={action}>
    <button type="submit" disabled={pending} className="w-full text-left px-3 py-2 rounded-lg text-xs font-semibold text-slate-300 hover:bg-white/10 transition">
      로그아웃
    </button>
  </VersionedForm>
}
