// Baked into the image and browser bundle together, never supplied from a request or runtime cookie.
export const releaseId = process.env.NEXT_PUBLIC_MARKETING_RELEASE ?? ''

export const releaseUrl = (pathname: string) => releaseId ? `${pathname}?dpl=${releaseId}` : pathname
