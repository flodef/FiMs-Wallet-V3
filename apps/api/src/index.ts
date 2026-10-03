import { HttpApiBuilder, HttpServer } from '@effect/platform'
import { Layer } from 'effect'
import { ApiLive } from './http.js'

// Best-effort per-IP rate limiting. Isolate/instance memory is not shared
// globally, so this mainly stops naive bursts hitting the same instance —
// real enforcement should live at the edge/proxy level. Mutations get a
// separate, stricter bucket: every signed write is an attack surface.
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 240 // requests per window per IP
const RATE_LIMIT_MUTATION_MAX = 120 // requests per window per IP on mutations

const buckets = new Map<string, { count: number; resetAt: number }>()

function isRateLimited(request: Request): boolean {
  // Prefer headers the edge sets and the client cannot forge:
  // cf-connecting-ip on Cloudflare, x-vercel-forwarded-for / x-real-ip on
  // Vercel. Plain x-forwarded-for is the last resort — it is client-spoofable
  // when no edge stamps it, but it only shifts a fake identity into its own
  // rate-limit bucket.
  const ip =
    request.headers.get('cf-connecting-ip') ??
    request.headers.get('x-vercel-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(request.method)
  const key = `${mutation ? 'mut' : 'read'}:${ip}`
  const max = mutation ? RATE_LIMIT_MUTATION_MAX : RATE_LIMIT_MAX
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
export function handleRequest(request: Request, env: Record<string, string | undefined>) {
  if (isRateLimited(request)) {
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
