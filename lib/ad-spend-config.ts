import { AD_SPEND_START, type AdCampaign } from './ad-spend'
// Explicit, operator-verified EVN scope. These are public identifiers, never credentials.
export const NAVER_CUSTOMER_ID = '4429374'
export const naverCampaigns: AdCampaign[] = ['cmp-a001-01-000000010954800', 'cmp-a001-01-000000010942737', 'cmp-a001-01-000000010851499'].map((campaignId, i) => ({
  provider: 'naver', accountId: NAVER_CUSTOMER_ID, campaignId, start: AD_SPEND_START, end: null, lifecycle: i === 2 ? 'paused' : 'active',
}))
export const daangnCampaign: AdCampaign = { provider: 'daangn', accountId: '4541556', campaignId: '1786077964797444000', start: AD_SPEND_START, end: null, lifecycle: 'active' }
