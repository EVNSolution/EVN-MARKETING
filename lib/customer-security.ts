export function safeReturnTo(value?: string) {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return undefined
  try {
    const url = new URL(value, 'http://internal')
    return url.origin === 'http://internal' && url.pathname === '/inquiries' ? `${url.pathname}${url.search}` : undefined
  } catch { return undefined }
}
