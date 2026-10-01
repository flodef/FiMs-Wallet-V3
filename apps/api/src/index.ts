import { HttpApiBuilder, HttpServer } from '@effect/platform'
import { Layer } from 'effect'
import { ApiLive } from './http.ts'

// Best-effort per-IP rate limiting. A Worker's isolate memory is not shared
// globally, so this mainly stops naive bursts hitting the same isolate —
// real enforcement should live at the Cloudflare zone level.
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 240 // requests per window per IP

const buckets = new Map<string, { count: number; resetAt: number }>()

function isRateLimited(request: Request): boolean {
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'
  const now = Date.now()
  const bucket = buckets.get(ip)

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    if (buckets.size > 10_000) {
      for (const [key, value] of buckets) {
        if (value.resetAt <= now) buckets.delete(key)
      }
    }
    return false
  }

  bucket.count += 1
  return bucket.count > RATE_LIMIT_MAX
}

export default {
  fetch: (request: Request, env: Cloudflare.Env) => {
    if (request.method === 'GET' && isRateLimited(request)) {
      return Response.json({ error: 'rate limited' }, { status: 429 })
    }

    const HttpApiLive = Layer.mergeAll(
      ApiLive,
      Layer.provide(HttpApiBuilder.middlewareOpenApi(), ApiLive),
      HttpApiBuilder.middlewareCors({
        allowedOrigins: env.CORS_ORIGINS?.split(',').map((origin) => origin.trim()) ?? [],
      }),
      HttpServer.layerContext,
    )

    const { handler } = HttpApiBuilder.toWebHandler(HttpApiLive)
    return handler(request)
  },
}
