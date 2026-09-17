'use client'

import { useState, useEffect } from 'react'

interface User { id: string; name: string }

interface Props {
  value: string
  onChange: (name: string) => void
  className?: string
}

export default function AssigneePicker({ value, onChange, className }: Props) {
  const [users, setUsers] = useState<User[]>([])

  useEffect(() => {
    fetch('/api/users')
      .then(r => r.json())
      .then((data: User[]) => setUsers(data))
      .catch(() => {})
  }, [])

  return (
    <select value={value} onChange={e => onChange(e.target.value)} className={className}>
      <option value="">미배정</option>
      {users.map(u => (
        <option key={u.id} value={u.name}>{u.name}</option>
      ))}
    </select>
  )
}
