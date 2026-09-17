import { auth } from '@/auth'
import { NextResponse } from 'next/server'

export default auth((req) => {
  const isLoggedIn  = !!req.auth
  const pathname    = req.nextUrl.pathname
  const isLoginPage = pathname === '/login'

  if (!isLoggedIn && !isLoginPage) {
    return NextResponse.redirect(new URL('/login', req.url))
  }
  if (isLoggedIn && isLoginPage) {
    return NextResponse.redirect(new URL('/customers', req.url))
  }
})

export const config = {
  // api/external 은 로그인 세션이 아닌 공유키(x-api-key)로 자체 인증하는 외부 연동용 엔드포인트다.
  matcher: ['/((?!api/auth|api/external|_next/static|_next/image|favicon.ico).*)'],
}
