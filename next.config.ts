import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  output: 'standalone',
  logging: {
    serverFunctions: false,
    incomingRequests: {
      ignore: [/^\/(?:api\/)?inquiries(?:[/?]|$)/],
    },
  },
}

export default nextConfig
