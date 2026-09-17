import type { Metadata } from 'next'
import { Noto_Sans_KR, Jost } from 'next/font/google'
import './globals.css'

const notoSansKR = Noto_Sans_KR({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '900'],
  variable: '--font-korean',
})

const jost = Jost({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-latin',
})

export const metadata: Metadata = {
  title: 'EV& Marketing',
  description: '이브이앤솔루션 마케팅 시스템',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko" className="h-full">
      <body className={`${notoSansKR.variable} ${jost.variable} h-full bg-gray-50`}>{children}</body>
    </html>
  )
}
