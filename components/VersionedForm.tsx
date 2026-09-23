'use client'

import { startTransition, useRef, type ComponentProps } from 'react'
import { checkRelease } from '@/lib/release-client'

export default function VersionedForm({ action, ...props }: Omit<ComponentProps<'form'>, 'action'> & { action: (data: FormData) => void }) {
  const checking = useRef(false)
  return <form {...props} action={action} onSubmit={async event => {
    event.preventDefault()
    if (checking.current) return
    checking.current = true
    const data = new FormData(event.currentTarget)
    try {
      if (await checkRelease()) startTransition(() => action(data))
    } finally { checking.current = false }
  }} />
}
