import { prisma } from '@/lib/db'
import { handleLandingRequest } from '@/lib/landing-inquiries'

export async function POST(request: Request) {
  return handleLandingRequest(request, prisma)
}
