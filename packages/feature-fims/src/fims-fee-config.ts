// FiMs community fee policy — code-level configuration. There is no DB or
// on-chain config yet: changing a rate means editing this file and redeploying.
// The setters exist so a future admin surface can apply a new rate without
// touching call sites, and so the policy bounds are enforced in one place.
// apps/api/src/fee-config.ts mirrors this module — both must be updated when
// the operating fee is revised (the API is a separate deployable).

// Community rule: members give back a share of their gains to the tontine or
// a charity. The 10% floor is validated policy and cannot be lowered.
export const FIMS_TONTINE_MIN_RATE = 0.1

// Sanity ceiling for the operating fee — a rate above 20% would be a mistake.
export const FIMS_FEE_MAX_RATE = 0.2

// Current values. The operating fee (0.1%) is the standing choice but NOT a
// final decision — it must stay easy to revise.
const config = {
  fimsFeeRate: 0.001,
  tontineRate: FIMS_TONTINE_MIN_RATE,
}

// Operating fee deducted from the credited side of conversions/withdrawals
// and charged as platformFeeBps on Jupiter swaps and trigger orders.
export function getFimsFeeRate(): number {
  return config.fimsFeeRate
}

// The same operating fee expressed in basis points for the Jupiter APIs
// (platformFeeBps on /swap, params.feeBps on /trigger).
export function getFimsPlatformFeeBps(): number {
  return Math.round(config.fimsFeeRate * 10_000)
}

// Share of a member's gains owed to the tontine (or a charity of their
// choice). Always >= FIMS_TONTINE_MIN_RATE.
export function getFimsTontineRate(): number {
  return config.tontineRate
}

export function setFimsTontineRate(rate: number): void {
  if (!Number.isFinite(rate) || rate < FIMS_TONTINE_MIN_RATE || rate > 1) {
    throw new RangeError(`tontine rate must be between ${FIMS_TONTINE_MIN_RATE} and 1, got ${rate}`)
  }
  config.tontineRate = rate
}

export function setFimsFeeRate(rate: number): void {
  if (!Number.isFinite(rate) || rate < 0 || rate > FIMS_FEE_MAX_RATE) {
    throw new RangeError(`FiMs fee rate must be between 0 and ${FIMS_FEE_MAX_RATE}, got ${rate}`)
  }
  config.fimsFeeRate = rate
}
