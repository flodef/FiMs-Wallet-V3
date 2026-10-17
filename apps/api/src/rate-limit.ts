// One trusted edge header for every IP-keyed rate limiter — the global HTTP
// limiter (index.ts) and the Helius chain-proxy limiter (chain.ts) must read
// the SAME source, or an attacker dodges the stricter bucket through the
// other path. Keep the literal in one place so the two never drift.
//
// RATE_LIMIT_IP_HEADER env selects the header the deployed edge guarantees
// (e.g. "cf-connecting-ip" when Cloudflare fronts Vercel). Default is
// x-vercel-forwarded-for, stamped by the Vercel platform itself.
export const RATE_LIMIT_IP_HEADER_ENV = 'RATE_LIMIT_IP_HEADER'
export const RATE_LIMIT_IP_HEADER_DEFAULT = 'x-vercel-forwarded-for'

export function rateLimitIpHeader(env: Record<string, string | undefined>): string {
  return env[RATE_LIMIT_IP_HEADER_ENV] ?? RATE_LIMIT_IP_HEADER_DEFAULT
}

// First hop only — everything past the first comma is client-mergeable and
// attacker-controlled. Absent or empty → 'unknown': every unidentified
// caller shares one bucket, so a misconfigured edge rate-limits itself
// rather than letting attackers roam.
export function firstForwardedIp(value: string | null | undefined): string {
  return value?.split(',')[0]?.trim() || 'unknown'
}
