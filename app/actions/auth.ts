'use server'

import { signIn, signOut } from '@/auth'
import { AuthError } from 'next-auth'
import { redirect } from 'next/navigation'

export async function loginAction(
  prevState: { error?: string; success?: boolean } | undefined,
  formData: FormData
) {
  try {
    await signIn('credentials', {
      email:    formData.get('email')    as string,
      password: formData.get('password') as string,
      redirect: false,
    })
  } catch (error) {
    if (error instanceof AuthError) {
      return { error: '이메일 또는 비밀번호가 올바르지 않습니다.' }
    }
    throw error
  }
  redirect('/inquiries')
}

export async function logoutAction() {
  await signOut({ redirect: false })
  redirect('/login')
}
