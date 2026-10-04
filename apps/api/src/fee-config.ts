// FiMs operating fee — code-level configuration, mirrored in
// packages/feature-fims/src/fims-fee-config.ts (both must be updated
// together: the API is a separate deployable). The current 0.2% is the
// standing choice, not a final decision, so the rate stays behind a setter
// rather than an inline literal.

const FIMS_FEE_MAX_RATE = 0.2

const config = {
  fimsFeeRate: 0.002,
}

// Share of a conversion's credited side that stays in the treasury.
export function getFimsFeeRate(): number {
  return config.fimsFeeRate
}

export function setFimsFeeRate(rate: number): void {
  if (!Number.isFinite(rate) || rate < 0 || rate > FIMS_FEE_MAX_RATE) {
    throw new RangeError(`FiMs fee rate must be between 0 and ${FIMS_FEE_MAX_RATE}, got ${rate}`)
  }
  config.fimsFeeRate = rate
}
