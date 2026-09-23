import type { NextConfig } from 'next'

const release = process.env.MARKETING_BUILD_REVISION ?? ''
if (release && !/^[0-9a-f]{40}$/.test(release)) throw new Error('MARKETING_BUILD_REVISION must be a source SHA')

const nextConfig: NextConfig = {
  output: 'standalone',
  deploymentId: release || undefined,
  env: { NEXT_PUBLIC_MARKETING_RELEASE: release },
  experimental: { proxyClientMaxBodySize: '11mb' },
  async headers() {
    return release ? [{ source: '/:path*', headers: [{ key: 'X-Marketing-Release', value: release }] }] : []
  },
  logging: {
    serverFunctions: false,
    incomingRequests: {
      ignore: [/^\/(?:api\/)?inquiries(?:[/?]|$)/],
    },
  },
}

export default nextConfig
