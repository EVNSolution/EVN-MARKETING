import type { Metadata } from 'next'
import localFont from 'next/font/local'
import './globals.css'
import ReleaseNotice from '@/components/ReleaseNotice'

const notoSansKR = localFont({
  src: './fonts/NotoSansKR-variable.woff2',
  weight: '100 900',
  style: 'normal',
  display: 'swap',
  variable: '--font-korean',
})

const jost = localFont({
  src: './fonts/Jost-variable.woff2',
  weight: '100 900',
  style: 'normal',
  display: 'swap',
  variable: '--font-latin',
})

export const metadata: Metadata = {
  title: 'EV& Marketing',
  description: '이브이앤솔루션 마케팅 시스템',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko" className="h-full">
      <body className={`${notoSansKR.variable} ${jost.variable} h-full bg-gray-50`}>{children}<ReleaseNotice /></body>
    </html>
  )
}
