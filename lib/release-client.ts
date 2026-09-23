'use client'

import { releaseId } from './release'

export const RELEASE_NOTICE = 'marketing-release-notice'
const expired = '새 버전이 준비되었습니다. 입력 내용을 확인한 뒤 새로고침해 주세요. 입력한 내용은 자동으로 저장되지 않습니다.'
const notify = (message: string) => window.dispatchEvent(new CustomEvent(RELEASE_NOTICE, { detail: message }))

export async function checkRelease() {
  if (!releaseId) return true
  try {
    const response = await fetch('/api/release', { headers: { 'x-deployment-id': releaseId }, cache: 'no-store' })
    if (response.ok && (await response.json()).deploymentId === releaseId) return true
    notify(response.status === 409 ? expired : '연결을 확인하지 못했습니다. 입력 내용은 유지됩니다. 잠시 후 다시 시도해 주세요.')
  } catch {
    notify('연결을 확인하지 못했습니다. 입력 내용은 유지됩니다. 잠시 후 다시 시도해 주세요.')
  }
  return false
}

export async function apiFetch(url: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  if (releaseId) headers.set('x-deployment-id', releaseId)
  const response = await fetch(url, { ...init, headers })
  if (response.headers.get('x-marketing-release-error') === 'expired') notify(expired)
  return response
}
