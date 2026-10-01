export function formatTokenUnits(units: bigint, decimals: number, maxDigits = 6): string {
  const divisor = 10n ** BigInt(decimals)
  const whole = units / divisor
  const frac = units % divisor
  const fracStr = frac.toString().padStart(decimals, '0').slice(0, maxDigits).replace(/0+$/, '')
  return fracStr ? `${whole}.${fracStr}` : `${whole}`
}

export function parseTokenUnits(value: string, decimals: number): bigint {
  const [whole = '0', frac = ''] = value.replace(',', '.').split('.')
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals)
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(padded || '0')
}
