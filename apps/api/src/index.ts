import { HttpApiBuilder, HttpServer } from '@effect/platform'
import { neon } from '@neondatabase/serverless'
import { Layer } from 'effect'
import { ApiLive } from './http.js'

// Per-IP rate limiting, two tiers:
//   - reads  : per-instance memory only — cheap, stops naive bursts hitting
//              the same isolate. No shared state is worth paying a DB
//              roundtrip on every GET.
//   - writes : Postgres-backed fixed-window counter (rate_limits table),
//              shared across every serverless isolate — a per-IP attacker
//              cannot dodge it by landing on fresh instances. Falls back to
//              the memory bucket when the database is unreachable: rate
//              limiting fails open, the API stays up.
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 240 // requests per window per IP
const RATE_LIMIT_MUTATION_MAX = 120 // requests per window per IP on mutations

const buckets = new Map<string, { count: number; resetAt: number }>()

// Prefer headers the edge sets and the client cannot forge:
// cf-connecting-ip on Cloudflare, x-vercel-forwarded-for / x-real-ip on
// Vercel. Plain x-forwarded-for is the last resort — it is client-spoofable
// when no edge stamps it, but it only shifts a fake identity into its own
// rate-limit bucket.
function clientIp(request: Request): string {
  return (
    request.headers.get('cf-connecting-ip') ??
    request.headers.get('x-vercel-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  )
}

function isRateLimitedMemory(key: string, max: number): boolean {
  const now = Date.now()
  const bucket = buckets.get(key)

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    if (buckets.size > 10_000) {
      for (const [key2, value] of buckets) {
        if (value.resetAt <= now) buckets.delete(key2)
      }
    }
    return false
  }

  bucket.count += 1
  return bucket.count > max
}

// null = shared limiter unavailable (no DATABASE_URL or query failed) —
// the caller falls back to the in-memory bucket.
async function isRateLimitedShared(key: string, max: number, databaseUrl: string | undefined): Promise<boolean | null> {
  if (!databaseUrl) return null
  try {
    const sql = neon(databaseUrl)
    const windowStart = new Date(Math.floor(Date.now() / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_WINDOW_MS)
    const rows = await sql`
      INSERT INTO rate_limits (bucket, window_start, count)
      VALUES (${key}, ${windowStart.toISOString()}, 1)
      ON CONFLICT (bucket, window_start)
      DO UPDATE SET count = rate_limits.count + 1
      RETURNING count
    `
    // Opportunistic purge: rows are only meaningful for the current window.
    if (Math.random() < 0.02) {
      void sql`DELETE FROM rate_limits WHERE window_start < NOW() - INTERVAL '10 minutes'`.catch(() => {})
    }
    return Number(rows[0]?.['count'] ?? 0) > max
  } catch {
    return null
  }
}

// JSON API responses still deserve the baseline headers: no-store keeps
// member data out of shared caches, nosniff/frame-ancestors cost nothing.
function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.set('Cache-Control', 'no-store')
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('X-Frame-Options', 'DENY')
  return new Response(response.body, { headers, status: response.status, statusText: response.statusText })
}

// Runtime-agnostic handler: Cloudflare Workers and Vercel Functions share it —
// only the env carrier differs (worker bindings vs process.env).
export async function handleRequest(request: Request, env: Record<string, string | undefined>) {
  const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(request.method)
  const key = `${mutation ? 'mut' : 'read'}:${clientIp(request)}`
  const max = mutation ? RATE_LIMIT_MUTATION_MAX : RATE_LIMIT_MAX
  const limited = mutation
    ? ((await isRateLimitedShared(key, max, env['DATABASE_URL'] ?? process.env['DATABASE_URL'])) ??
      isRateLimitedMemory(key, max))
    : isRateLimitedMemory(key, max)
  if (limited) {
    return Response.json({ error: 'rate limited' }, { status: 429 })
  }

  const HttpApiLive = Layer.mergeAll(
    ApiLive,
    Layer.provide(HttpApiBuilder.middlewareOpenApi(), ApiLive),
    HttpApiBuilder.middlewareCors({
      allowedOrigins: env['CORS_ORIGINS']?.split(',').map((origin) => origin.trim()) ?? [],
    }),
    HttpServer.layerContext,
  )

  const { handler } = HttpApiBuilder.toWebHandler(HttpApiLive)
  return Promise.resolve(handler(request)).then(withSecurityHeaders)
}

export default {
  fetch: handleRequest,
}
