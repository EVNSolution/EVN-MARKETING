import { dispatchPendingWarp as dispatch, pilotPendingWarp as pilot } from '@/lib/warp-delivery'
import { applyWarpRecovery as recover } from '@/lib/warp-recovery'

// Existing delivery fixtures model the write endpoint. Give them an explicit,
// read-only negative lookup; duplicate/failed lookups use real mocks in inquiry-review.test.ts.
function clearPhones(send?: typeof fetch): typeof fetch {
  return async (url, init) => {
    if (String(url).endsWith('/marketing-inquiries/check')) {
      const body = JSON.parse(String(init?.body))
      return Response.json({ ok: true, results: body.items.map((item: { sourceId: string }) => ({ sourceId: item.sourceId, exists: false })) })
    }
    if (!send) throw new Error('write mock required')
    return send(url, init)
  }
}

export const dispatchPendingWarp: typeof dispatch = (db, owner, send, env, now, signal) => dispatch(db, owner, clearPhones(send), env, now, signal)
export const pilotPendingWarp: typeof pilot = (db, owner, send, env, now) => pilot(db, owner, clearPhones(send), env, now)
export const applyWarpRecovery: typeof recover = (db, bytes, hash, options) => recover(db, bytes, hash, { ...options, send: clearPhones(options.send) })
