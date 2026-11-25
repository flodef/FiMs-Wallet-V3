// Railway/Node entrypoint: serves the built web app (apps/web/dist) and
// forwards /api/* to the FiMs API (apps/api) — same contract as the Vercel
// catch-all in api/[...path].ts, minus the `...path` rewrite: the real path
// is already in req.url. Host header and raw body are forwarded untouched:
// the wallet signature covers both (see verifyWalletRequest).
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

import { neonConfig } from '@neondatabase/serverless'

import { handleRequest } from './apps/api/src/index.ts'

// Long-running process: bound every neon() HTTP query so a silently-dead
// socket degrades to the rate-limiter's memory fallback instead of hanging
// the request. Pool (WebSocket) transactions are not covered by this.
neonConfig.fetchFunction = (url: string | URL | Request, init?: RequestInit) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(20_000) })

const DIST = fileURLToPath(new URL('./apps/web/dist/', import.meta.url))

// Same baseline headers as vercel.json — applied to static assets; API
// responses keep their own (set afterwards, they win on conflict).
const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self' https: wss:; font-src 'self' data:; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests",
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy':
    'accelerometer=(), camera=(self), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
}

const MIME: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

async function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return chunks.length ? Buffer.concat(chunks) : undefined
}

async function serveApi(req: IncomingMessage, res: ServerResponse, pathname: string) {
  const proto = headerValue(req.headers['x-forwarded-proto']) ?? 'https'
  const host = headerValue(req.headers['x-forwarded-host']) ?? headerValue(req.headers.host) ?? 'localhost'
  // strip the /api mount prefix — app routes live at /fims/*, /auth/*, …
  const url = new URL(
    `${proto}://${host}${pathname.replace(/^\/api/, '') || '/'}${new URL(req.url ?? '/', 'http://x').search}`,
  )

  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    headers.set(name, Array.isArray(value) ? value.join(', ') : value)
  }

  const request = new Request(url, {
    body: await readBody(req),
    headers,
    method: req.method,
  })
  const response = await handleRequest(request, process.env)

  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value)
  res.statusCode = response.status
  response.headers.forEach((value, name) => {
    res.setHeader(name, value)
  })
  res.end(Buffer.from(await response.arrayBuffer()))
}

async function serveStatic(pathname: string, method: string, res: ServerResponse) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value)
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '')
  const file = join(DIST, rel)
  if (!file.startsWith(DIST)) {
    res.statusCode = 403
    res.end()
    return
  }
  try {
    const data = await readFile(file)
    res.setHeader('content-type', MIME[extname(file)] ?? 'application/octet-stream')
    res.setHeader('cache-control', file.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache')
    res.end(data)
  } catch {
    // SPA fallback: client-side routes get index.html
    if (method === 'GET' && !extname(pathname)) {
      try {
        const html = await readFile(join(DIST, 'index.html'))
        res.setHeader('content-type', 'text/html; charset=utf-8')
        res.setHeader('cache-control', 'no-cache')
        res.end(html)
        return
      } catch {
        /* dist missing */
      }
    }
    res.statusCode = 404
    res.end('not found')
  }
}

const port = Number(process.env['PORT']) || 3000
createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (url.pathname.startsWith('/api/'))
    return void serveApi(req, res, url.pathname).catch((e) => {
      console.error('[api] failed:', e)
      if (!res.headersSent) {
        res.statusCode = 500
        res.end(JSON.stringify({ error: 'internal error' }))
      } else res.end()
    })
  void serveStatic(url.pathname, req.method ?? 'GET', res)
}).listen(port, '0.0.0.0', () => {
  console.log(
    `fims-wallet-v3 listening on :${port} (dist: ${existsSync(DIST) ? 'ok' : 'MISSING — run apps/web build'})`,
  )
})
