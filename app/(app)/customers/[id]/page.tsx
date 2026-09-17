import { notFound } from 'next/navigation'
import { prisma } from '@/lib/db'
import CustomerDetailClient from './CustomerDetailClient'

export default async function CustomerDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ returnTo?: string }>
}) {
  const { id } = await params
  const { returnTo } = await searchParams
  const customer = await prisma.customer.findUnique({
    where: { id },
    include: {
      activities: { orderBy: { date: 'desc' } },
    },
  })
  if (!customer) notFound()
  return <CustomerDetailClient customer={JSON.parse(JSON.stringify(customer))} returnTo={returnTo} />
}
