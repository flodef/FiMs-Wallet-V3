// Strict parsing for security-relevant env configuration. A malformed value
// must fail loudly at call time — a silently NaN'd circuit breaker is worse
// than no breaker, because nobody notices it is gone (audit H-2).

export function envFloat(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  // Strict Number(), not parseFloat — '0.1junk' must throw, not truncate.
  const trimmed = raw.trim()
  const value = trimmed === '' ? Number.NaN : Number(trimmed)
  if (!Number.isFinite(value)) {
    throw new Error(`env ${name}: expected a number, got ${JSON.stringify(raw)}`)
  }
  return value
}

export function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const value = raw.trim() === '' ? Number.NaN : Number(raw)
  if (!Number.isInteger(value)) {
    throw new Error(`env ${name}: expected an integer, got ${JSON.stringify(raw)}`)
  }
  return value
}

export function envBigint(name: string, fallback: bigint): bigint {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  if (raw.trim() === '') {
    throw new Error(`env ${name}: expected an integer, got ${JSON.stringify(raw)}`)
  }
  try {
    return BigInt(raw)
  } catch {
    throw new Error(`env ${name}: expected an integer, got ${JSON.stringify(raw)}`)
  }
}

// Comma-separated address/program list. `validate` is applied to each entry
// so a typo'd program id fails closed instead of widening an allowlist with
// garbage (or silently dropping it and blocking legitimate flows).
export function envList(name: string, validate: (entry: string) => void = () => {}): string[] {
  const raw = process.env[name]
  if (raw === undefined) return []
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  for (const entry of entries) validate(entry)
  return entries
}
