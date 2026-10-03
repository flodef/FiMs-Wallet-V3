// Expands scientific notation ("1e-8", "2.5E6") into a plain decimal string.
// String-only: no float, so precision is never lost.
function expandScientificNotation(input: string): string {
  const match = /^(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(input)
  if (!match) {
    return input
  }
  // The regex guarantees the captured groups; defaults only satisfy
  // noUncheckedIndexedAccess.
  const [, intPart = '', fracPart = '', expText = '0'] = match
  const exponent = Number.parseInt(expText, 10)
  const digits = intPart + fracPart
  const point = intPart.length + exponent
  if (point <= 0) {
    return `0.${'0'.repeat(-point)}${digits}`
  }
  if (point >= digits.length) {
    return digits + '0'.repeat(point - digits.length)
  }
  return `${digits.slice(0, point)}.${digits.slice(point)}`
}

export function uiAmountToBigInt(amount: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error(`Decimals must be a non-negative integer: ${decimals}`)
  }
  const parsedAmount = parseFloat(amount)
  if (Number.isNaN(parsedAmount)) {
    throw new Error(`Could not parse amount: ${String(amount)}`)
  }
  if (parsedAmount < 0) {
    throw new Error(`Amount cannot be negative: ${String(amount)}`)
  }
  // `Number#toString` emits scientific notation for small and huge amounts
  // ("0.00000001" → "1e-8"), which the previous `Intl.NumberFormat` trick
  // could not digest. Expand it before scaling to integer units.
  const expanded = expandScientificNotation(amount.trim())
  if (!/^\d+(\.\d+)?$/.test(expanded)) {
    throw new Error(`Could not parse amount: ${String(amount)}`)
  }
  const [whole = '0', fraction = ''] = expanded.split('.')
  // Sub-unit precision is truncated, matching the previous behavior: the
  // smallest representable unit of the token is the smallest sendable unit.
  const scaledFraction = fraction.slice(0, decimals).padEnd(decimals, '0')
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(scaledFraction || '0')
}
