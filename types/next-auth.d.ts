import type { DefaultSession } from 'next-auth'

declare module 'next-auth' {
  interface Session {
    user: {
      id: string
      role: string
      teamName: string | null
    } & DefaultSession['user']
  }

  interface User {
    role: string
    teamName: string | null
  }
}

declare module '@auth/core/jwt' {
  interface JWT {
    id: string
    role: string
    teamName: string | null
  }
}
